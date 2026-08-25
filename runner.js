// ============================================================
// RUNNER — continuous orchestrator for v21 + LAB bots (Railway)
//
// Replaces GitHub Actions cron scheduling (found unreliable — up to
// 79-minute total stalls in the scheduler queue) with a persistent
// Node process that loops on its own timer.
//
// Design choice: this file spawns scan_v21.js and scan_lab.js as
// CHILD PROCESSES, exactly like the old GitHub Actions workflow
// steps did (scan, then monitor, per bot). Neither bot's file is
// imported or refactored — zero risk to trading logic, and their
// existing `process.exit()` guards (e.g. "market closed") only ever
// exit the child, never this runner.
//
// State persistence: after each cycle, any changed state/outcome
// files are committed and pushed to GitHub (same repo the bots
// already read/write), using the same fetch+rebase+"ours" retry
// pattern the GitHub Actions workflows used. At startup, the local
// working copy is hard-reset to origin/main so a fresh Railway
// deploy never runs on stale baked-in state.
// ============================================================
import { spawn, execSync } from "child_process";

const REPO_URL_PLAIN = "https://github.com/tjtoj1/scanner-bot.git"; // public repo — no auth needed to read
const GH_PUSH_TOKEN = process.env.GH_PUSH_TOKEN; // needed only to push

const MARKET_START_UTC = 13 * 60 + 30; // 13:30 UTC
const MARKET_END_UTC   = 21 * 60;      // 21:00 UTC
const CYCLE_INTERVAL_MS = 60 * 1000;      // 60s during market hours
const IDLE_INTERVAL_MS  = 5 * 60 * 1000;  // 5 min outside market hours

const STATE_FILES = [
  "state_v21.json", "outcomes_v21.jsonl",
  "state_lab.json", "strategy_lab.json", "outcomes_lab.jsonl",
];

function utcMin() { const n = new Date(); return n.getUTCHours() * 60 + n.getUTCMinutes(); }
function isWeekday() { const d = new Date().getUTCDay(); return d >= 1 && d <= 5; }
function isMarketHours() { return isWeekday() && utcMin() >= MARKET_START_UTC && utcMin() < MARKET_END_UTC; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function sh(cmd) { return execSync(cmd, { stdio: "ignore" }); }

// ─── GIT SETUP / SYNC ────────────────────────────────────────
function ensureGitRepo() {
  try {
    execSync("git rev-parse --is-inside-work-tree", { stdio: "ignore" });
  } catch {
    console.log("[runner] no git repo present — initializing");
    sh("git init");
    sh(`git remote add origin ${REPO_URL_PLAIN}`);
  }
  try {
    sh("git remote get-url origin");
  } catch {
    sh(`git remote add origin ${REPO_URL_PLAIN}`);
  }
}

// Hard-resets the working copy to the latest origin/main. Run once
// at boot so a fresh/redeployed container never trades on stale state.
function syncStateFromGitHub() {
  try {
    ensureGitRepo();
    sh("git fetch origin main");
    sh("git reset --hard origin/main");
    console.log("[runner] synced working copy to origin/main");
  } catch (e) {
    console.error("[runner] syncStateFromGitHub failed (continuing with local files):", e.message);
  }
}

// Commits + pushes any changed state/outcome files. Safe to call
// every cycle — no-ops when nothing changed. Uses the same
// fetch+rebase+"ours" retry pattern as the old GitHub Actions
// workflows, so it merges safely if those workflows are still
// running concurrently as a fallback.
function syncToGitHub() {
  if (!GH_PUSH_TOKEN) {
    console.warn("[runner] GH_PUSH_TOKEN not set — state changes will NOT persist across redeploys");
    return;
  }
  try {
    ensureGitRepo();
    sh(`git config user.email "railway@scanner-bot.local"`);
    sh(`git config user.name "Railway Runner"`);

    const diff = execSync("git status --porcelain").toString().trim();
    if (!diff) return;

    sh("git add -A");
    sh(`git commit -m "railway state [skip ci]"`);

    const authedUrl = `https://x-access-token:${GH_PUSH_TOKEN}@github.com/tjtoj1/scanner-bot.git`;
    for (let i = 1; i <= 5; i++) {
      try {
        sh(`git push ${authedUrl} HEAD:main`);
        return;
      } catch {
        try { sh("git rebase --abort"); } catch {}
        try { sh("git fetch origin main"); } catch {}
        try {
          sh(`git pull ${authedUrl} main -X ours --no-edit`);
        } catch {
          for (const f of STATE_FILES) {
            try { sh(`git checkout --ours ${f}`); } catch {}
          }
          try { sh("git add -A"); } catch {}
          try { execSync(`git merge --continue`, { stdio: "ignore", env: { ...process.env, GIT_EDITOR: "true" } }); } catch {}
        }
      }
      try { execSync(`sleep ${i * 2}`); } catch {} // simple sync backoff (seconds)
    }
    console.error("[runner] git push failed after 5 retries — state changes NOT persisted this cycle");
  } catch (e) {
    console.error("[runner] syncToGitHub error:", e.message);
  }
}

// ─── BOT INVOCATION ──────────────────────────────────────────
function runNode(script, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn("node", [script], {
      env: { ...process.env, ...extraEnv },
      stdio: "inherit",
    });
    child.on("exit", (code) => resolve(code ?? 0));
    child.on("error", (err) => {
      console.error(`[runner] failed to spawn ${script}:`, err.message);
      resolve(1);
    });
  });
}

async function runBotCycle(name, script) {
  try {
    console.log(`[runner] ${name}: scan`);
    await runNode(script, {});
    console.log(`[runner] ${name}: monitor`);
    await runNode(script, { MODE: "monitor" });
  } catch (e) {
    console.error(`[runner] ${name} cycle threw:`, e.message);
  }
}

// ─── MAIN LOOP ───────────────────────────────────────────────
process.on("uncaughtException", (e) => console.error("[runner] uncaughtException:", e));
process.on("unhandledRejection", (e) => console.error("[runner] unhandledRejection:", e));

async function main() {
  console.log(`=== Runner started ${new Date().toISOString()} ===`);
  syncStateFromGitHub();

  while (true) {
    try {
      if (isMarketHours()) {
        console.log(`[runner] cycle start ${new Date().toISOString()}`);
        await runBotCycle("v21", "scan_v21.js");
        await runBotCycle("lab", "scan_lab.js");
        syncToGitHub();
        await sleep(CYCLE_INTERVAL_MS);
      } else {
        console.log(`[runner] outside market hours, idling (${new Date().toISOString()})`);
        await sleep(IDLE_INTERVAL_MS);
      }
    } catch (e) {
      console.error("[runner] main loop iteration failed (continuing):", e.message);
      await sleep(CYCLE_INTERVAL_MS);
    }
  }
}

main();
