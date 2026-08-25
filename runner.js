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
  "report_state.json",
];

const REPORT_WINDOW_START_UTC = 20 * 60 + 35; // 20:35 UTC — after LAB's own 20:00-20:30 learning window

// Build-generated paths that must never enter git history — Nixpacks
// writes secrets (env vars) into .nixpacks/build.sh in plaintext.
// .gitignore keeps them from being staged in the first place; this is
// a defensive second layer in case one was ever committed already.
const SENSITIVE_PATTERNS = [".nixpacks"];

function utcMin() { const n = new Date(); return n.getUTCHours() * 60 + n.getUTCMinutes(); }
function isWeekday() { const d = new Date().getUTCDay(); return d >= 1 && d <= 5; }
function isMarketHours() { return isWeekday() && utcMin() >= MARKET_START_UTC && utcMin() < MARKET_END_UTC; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function sh(cmd) { return execSync(cmd, { stdio: "ignore" }); }

// Runs a command capturing stdout/stderr instead of discarding them,
// for diagnostics. Never throws — returns a result object.
function shCap(cmd) {
  try {
    const out = execSync(cmd, { stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, code: 0, stdout: out.toString(), stderr: "" };
  } catch (e) {
    return {
      ok: false,
      code: typeof e.status === "number" ? e.status : null,
      stdout: e.stdout ? e.stdout.toString() : "",
      stderr: e.stderr ? e.stderr.toString() : "",
      message: e.message,
    };
  }
}

function maskToken(str) {
  if (!str) return str;
  return GH_PUSH_TOKEN ? str.split(GH_PUSH_TOKEN).join("***") : str;
}

function logResult(label, r) {
  console.log(`[runner] ${label}: ${r.ok ? "ok" : `FAILED (exit ${r.code})`}`);
  const out = maskToken(r.stdout && r.stdout.trim());
  const err = maskToken(r.stderr && r.stderr.trim());
  if (out) console.log(`[runner]   stdout: ${out}`);
  if (err) console.log(`[runner]   stderr: ${err}`);
  if (!r.ok && !out && !err && r.message) console.log(`[runner]   message: ${maskToken(r.message)}`);
}

// ─── GIT SETUP / SYNC ────────────────────────────────────────
// Origin URL: token-embedded when GH_PUSH_TOKEN is set (needed for both
// fetch and push against the configured remote), plain otherwise (fetch
// still works — public repo — but push will fail without a token).
function originUrl() {
  return GH_PUSH_TOKEN
    ? `https://x-access-token:${GH_PUSH_TOKEN}@github.com/tjtoj1/scanner-bot.git`
    : REPO_URL_PLAIN;
}

// Idempotent bootstrap: safe to call every cycle. Railway deploys the
// source tree WITHOUT a .git directory (no repo, no remote, no history),
// so this must fully construct one from scratch on first call:
//   1. git init (with initial branch forced to "main")
//   2. git remote add origin <token-embedded URL>
//   3. git config user.email / user.name
//   4. make sure the local branch is literally "main"
// Fetch + reset to origin/main is intentionally NOT done here — that's
// a one-time destructive step, handled separately by
// syncStateFromGitHub() at boot only (see below), so this function can
// be called mid-cycle (from syncToGitHub) without wiping local changes.
function ensureGitRepo() {
  let isRepo = true;
  try { execSync("git rev-parse --is-inside-work-tree", { stdio: "ignore" }); }
  catch { isRepo = false; }

  if (!isRepo) {
    console.log("[runner] no git repo present — initializing");
    logResult("git init -b main", shCap("git init -b main"));
  }

  let hasOrigin = true;
  try { execSync("git remote get-url origin", { stdio: "ignore" }); }
  catch { hasOrigin = false; }

  if (!hasOrigin) {
    logResult("git remote add origin", shCap(`git remote add origin ${originUrl()}`));
  } else if (GH_PUSH_TOKEN) {
    // keep the stored remote URL's token current (idempotent, harmless if unchanged)
    logResult("git remote set-url origin", shCap(`git remote set-url origin ${originUrl()}`));
  }

  sh(`git config user.email "railway@scanner-bot.local"`);
  sh(`git config user.name "Railway Runner"`);

  // Force the local branch to be literally "main" (git init -b main
  // already guarantees this on a fresh repo; this covers any edge case).
  const branch = (shCap("git branch --show-current").stdout || "").trim();
  if (branch && branch !== "main") {
    logResult(`git branch -m ${branch} main`, shCap(`git branch -m ${branch} main`));
  }

  cleanupSensitiveTrackedFiles();
}

// Untracks (but does not delete on disk) any path matching
// SENSITIVE_PATTERNS that somehow ended up tracked by git already —
// e.g. from a commit made before .gitignore existed.
function cleanupSensitiveTrackedFiles() {
  for (const pattern of SENSITIVE_PATTERNS) {
    const tracked = shCap(`git ls-files -- ${pattern}`);
    if (tracked.ok && tracked.stdout.trim()) {
      logResult(`git rm -r --cached ${pattern} (was tracked!)`, shCap(`git rm -r --cached --ignore-unmatch ${pattern}`));
    }
  }
}

// Stages ONLY the known state/outcome files by explicit name — never
// `git add -A`, which would also pick up .nixpacks/build.sh (contains
// plaintext env vars) or any other unexpected file in the working tree.
function addStateFiles() {
  for (const f of STATE_FILES) {
    const r = shCap(`git add ${f}`);
    if (!r.ok) console.warn(`[runner] git add ${f} failed:`, (r.stderr || r.message || "").trim());
  }
}

// Hard-resets the working copy to the latest origin/main. Run once
// at boot so a fresh/redeployed container never trades on stale state.
function syncStateFromGitHub() {
  try {
    ensureGitRepo();
    logResult("git fetch origin main", shCap("git fetch origin main"));
    logResult("git reset --hard origin/main", shCap("git reset --hard origin/main"));
    logResult("git branch --set-upstream-to", shCap("git branch --set-upstream-to=origin/main main"));
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

    const diff = execSync(`git status --porcelain -- ${STATE_FILES.join(" ")}`).toString().trim();
    if (!diff) return;

    addStateFiles();
    sh(`git commit -m "railway state [skip ci]"`);

    // ── Diagnostics: dump repo state right before attempting to push ──
    logResult("git remote -v", shCap("git remote -v"));
    logResult("git branch --show-current", shCap("git branch --show-current"));
    logResult("git rev-parse HEAD", shCap("git rev-parse HEAD"));
    logResult("git status (pre-push)", shCap("git status"));
    logResult("git config user.email", shCap("git config --get user.email"));
    logResult("git config user.name", shCap("git config --get user.name"));

    for (let i = 1; i <= 5; i++) {
      const pushResult = shCap(`git push origin HEAD:main`);
      logResult(`git push attempt ${i}/5`, pushResult);
      if (pushResult.ok) return;

      logResult("  rebase --abort", shCap("git rebase --abort"));
      logResult("  fetch origin main", shCap("git fetch origin main"));
      const pullResult = shCap(`git pull origin main -X ours --no-edit`);
      logResult("  pull -X ours", pullResult);
      if (!pullResult.ok) {
        for (const f of STATE_FILES) {
          logResult(`  checkout --ours ${f}`, shCap(`git checkout --ours ${f}`));
          logResult(`  add ${f}`, shCap(`git add ${f}`));
        }
        logResult("  merge --continue", shCap(`GIT_EDITOR=true git merge --continue`));
      }

      try { execSync(`sleep ${i * 2}`); } catch {} // simple sync backoff (seconds)
    }
    console.error("[runner] git push failed after 5 retries — state changes NOT persisted this cycle. See attempt logs above for the actual error.");
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
        if (utcMin() >= REPORT_WINDOW_START_UTC) {
          console.log("[runner] daily report window — checking");
          await runNode("daily_report.js", {});
        }
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
