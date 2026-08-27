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

// Diagnostic for a specific recurring failure: "Invalid username or token"
// persisting even after rotating to a fresh token — the suspicion being
// that GH_PUSH_TOKEN never actually reaches this process, so every push
// silently uses the unauthenticated REPO_URL_PLAIN. process.env is read
// once at module load and never touched again anywhere in this file (no
// dotenv, no .env file, no dependency that could shadow it), so whatever
// prints here IS what every originUrl() call for the rest of this
// process's life will see — this line is the ground truth.
{
  const len = GH_PUSH_TOKEN ? GH_PUSH_TOKEN.length : 0;
  const trimmedLen = GH_PUSH_TOKEN ? GH_PUSH_TOKEN.trim().length : 0;
  let note = "";
  if (len === 0) note = " — EMPTY/UNSET: Railway is not delivering this variable to this process. Check the variable name/scope in Railway (a plain restart may not reload env vars depending on service config — try a full redeploy). Every push this run will use the unauthenticated URL and fail.";
  else if (len !== trimmedLen) note = ` — WARNING: ${len - trimmedLen} char(s) of leading/trailing whitespace in the value itself`;
  else if (len < 20) note = " — WARNING: unusually short for a real GitHub token (classic PATs are ~40 chars, fine-grained ~93+)";
  console.log(`[runner] GH_PUSH_TOKEN at startup: length=${len}${note}`);
}

// Used only to alert on GitHub push failure — same chat/token scan_v21.js
// and scan_lab.js already send trade messages to, so a failure to persist
// state reaches the same place the trader is already watching.
const TG_TOKEN = process.env.TG_TOKEN;
const PERSONAL_CHAT = "810642442";

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

// Git ops go over the network (fetch/push/pull) and execSync has NO
// default timeout — a stalled connection used to hang this process
// (and therefore the whole runner loop) forever. Every execSync call
// below passes this explicitly.
const GIT_TIMEOUT_MS = 20000;

function utcMin() { const n = new Date(); return n.getUTCHours() * 60 + n.getUTCMinutes(); }
function isWeekday() { const d = new Date().getUTCDay(); return d >= 1 && d <= 5; }
function isMarketHours() { return isWeekday() && utcMin() >= MARKET_START_UTC && utcMin() < MARKET_END_UTC; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function sh(cmd) { return execSync(cmd, { stdio: "ignore", timeout: GIT_TIMEOUT_MS }); }

// Runs a command capturing stdout/stderr instead of discarding them,
// for diagnostics. Never throws — returns a result object.
function shCap(cmd) {
  try {
    const out = execSync(cmd, { stdio: ["ignore", "pipe", "pipe"], timeout: GIT_TIMEOUT_MS });
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

// Fire-and-forget Telegram alert — state persistence failing silently in
// container logs is how open-trade state got lost before (a Railway
// restart hard-resets to origin/main, discarding any commits that never
// made it to GitHub). This makes that failure loud immediately instead
// of only visible to someone reading Deploy Logs.
async function alertTelegram(text) {
  if (!TG_TOKEN) return;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 15000);
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: PERSONAL_CHAT, text, parse_mode: "HTML" }),
      signal: controller.signal,
    });
  } catch (e) {
    console.error("[runner] alertTelegram failed:", e.message);
  } finally {
    clearTimeout(t);
  }
}

// Set once a push-failure alert has been sent, so a persistent failure
// (e.g. every 60s cycle during market hours) doesn't spam Telegram —
// cleared the moment a push succeeds again.
let pushFailureAlerted = false;

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
  try { execSync("git rev-parse --is-inside-work-tree", { stdio: "ignore", timeout: GIT_TIMEOUT_MS }); }
  catch { isRepo = false; }

  if (!isRepo) {
    console.log("[runner] no git repo present — initializing");
    logResult("git init -b main", shCap("git init -b main"));
  }

  let hasOrigin = true;
  try { execSync("git remote get-url origin", { stdio: "ignore", timeout: GIT_TIMEOUT_MS }); }
  catch { hasOrigin = false; }

  if (!hasOrigin) {
    const url = originUrl();
    console.log(`[runner] git remote add origin -> ${maskToken(url)}`);
    logResult("git remote add origin", shCap(`git remote add origin ${url}`));
  } else if (GH_PUSH_TOKEN) {
    // keep the stored remote URL's token current (idempotent, harmless if unchanged)
    const url = originUrl();
    console.log(`[runner] git remote set-url origin -> ${maskToken(url)}`);
    logResult("git remote set-url origin", shCap(`git remote set-url origin ${url}`));
  }

  // Ground truth check: what git actually has stored for origin right
  // now, regardless of which branch above ran (or whether either did,
  // e.g. hasOrigin was true and GH_PUSH_TOKEN was falsy so neither ran).
  // This is the exact URL `git push origin` will resolve and use next.
  const storedUrl = (shCap("git remote get-url origin").stdout || "").trim();
  console.log(`[runner] git remote get-url origin (actual, post-setup) -> ${maskToken(storedUrl)}`);
  if (GH_PUSH_TOKEN && !storedUrl.includes("x-access-token:")) {
    console.error(`[runner] ⚠️ origin has NO embedded token even though GH_PUSH_TOKEN is set (length ${GH_PUSH_TOKEN.length}) — the next push will fail with an auth error. This means the remote URL was never (re)written with the token — see the add/set-url line(s) above.`);
  }

  sh(`git config user.email "railway@scanner-bot.local"`);
  sh(`git config user.name "Railway Runner"`);

  // Force the local branch to be literally "main" (git init -b main
  // already guarantees this on a fresh repo; this covers any edge case).
  const branch = (shCap("git branch --show-current").stdout || "").trim();
  if (branch && branch !== "main") {
    logResult(`git branch -m ${branch} main`, shCap(`git branch -m ${branch} main`));
  }

  return cleanupSensitiveTrackedFiles();
}

// Untracks (but does not delete on disk) any path matching
// SENSITIVE_PATTERNS — e.g. .nixpacks/build.sh, which Nixpacks writes with
// the live env vars (including GH_PUSH_TOKEN) in plaintext on every build.
// GH013 (GitHub secret-scanning push protection) rejects any push whose
// commits track that file, and .gitignore only stops NEW staging — it does
// nothing once a path is already tracked. This used to run only when a
// preceding `git ls-files` check found something; that gate is the exact
// kind of thing that can silently stop matching (path form, timing, a
// rebuilt .nixpacks not yet reflected) and leave the file tracked forever.
// Unconditional now: runs `git rm --cached` every single call, every
// cycle, with no pre-check — `--ignore-unmatch` makes it a safe no-op when
// there is truly nothing tracked, so there is no cost to calling it always.
function cleanupSensitiveTrackedFiles() {
  let removedAny = false;
  for (const pattern of SENSITIVE_PATTERNS) {
    const r = shCap(`git rm -r --cached --ignore-unmatch -- ${pattern}`);
    if (r.stdout && r.stdout.trim()) {
      logResult(`git rm -r --cached --ignore-unmatch ${pattern} (was tracked!)`, r);
      removedAny = true;
    }
  }
  return removedAny;
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
    if (!pushFailureAlerted) {
      pushFailureAlerted = true;
      alertTelegram("⚠️ Railway: GH_PUSH_TOKEN غير معرّف في البيئة — حالة الصفقات (state_v21/state_lab) لن تُحفظ في GitHub، وأي إعادة تشغيل ستفقدها.");
    }
    return;
  }
  try {
    // ensureGitRepo() always ends with an unconditional
    // cleanupSensitiveTrackedFiles() call — .nixpacks/build.sh (holds the
    // live GH_PUSH_TOKEN in plaintext) gets untracked from the index right
    // here, before anything below stages or commits. Its return value
    // tells us whether that untracking itself needs to reach GitHub.
    const nixpacksUntracked = ensureGitRepo();

    const diff = execSync(`git status --porcelain -- ${STATE_FILES.join(" ")}`, { timeout: GIT_TIMEOUT_MS }).toString().trim();
    // Log exactly which state files actually changed this cycle (or that
    // none did) — this used to be silent, which is exactly why "did the
    // state files change but the commit missed them, or did they just not
    // change" was unanswerable from the logs alone.
    console.log(diff ? `[runner] state files changed this cycle:\n${diff}` : "[runner] no state file changes this cycle");
    // Commit even with no state-file changes when cleanup just untracked a
    // sensitive file — that removal must reach GitHub on its own and as
    // fast as possible (it's the fix for GH013 blocking every push), not
    // wait for the next trade to happen to also change a state file.
    if (!diff && !nixpacksUntracked) return;

    addStateFiles();
    sh(`git commit -m "railway state [skip ci]"`);

    // ── Diagnostics: dump repo state right before attempting to push ──
    logResult("git remote -v", shCap("git remote -v"));
    logResult("git branch --show-current", shCap("git branch --show-current"));
    logResult("git rev-parse HEAD", shCap("git rev-parse HEAD"));
    logResult("git status (pre-push)", shCap("git status"));
    logResult("git config user.email", shCap("git config --get user.email"));
    logResult("git config user.name", shCap("git config --get user.name"));

    // Diagnostic text from the most recent failed (or unconfirmed) push
    // attempt, carried past the loop so the final Telegram alert can
    // include the actual error instead of a generic message — no more
    // needing to open Railway Deploy Logs just to see why.
    let lastPushError = "";

    for (let i = 1; i <= 5; i++) {
      const pushResult = shCap(`git push origin HEAD:main`);
      logResult(`git push attempt ${i}/5`, pushResult);

      if (pushResult.ok) {
        // Exit code 0 alone is NOT proof anything reached GitHub — `git
        // push` also exits 0 for "Everything up-to-date" (nothing new to
        // send). Confirm origin/main on GitHub's side actually now equals
        // what we just committed locally before trusting "ok"; if it
        // doesn't, treat this exactly like a failed attempt and fall
        // through into the same recovery/retry path below instead of
        // returning early on a false positive.
        const localHead = (shCap("git rev-parse HEAD").stdout || "").trim();
        const remoteHead = ((shCap("git ls-remote origin main").stdout || "").split(/\s+/)[0] || "").trim();
        if (localHead && remoteHead === localHead) {
          console.log(`[runner] push CONFIRMED — origin/main on GitHub now at ${localHead}`);
          pushFailureAlerted = false;
          return;
        }
        lastPushError = `push exited 0 but origin/main is at ${remoteHead || "unknown"}, not the expected ${localHead || "unknown"} — not confirmed`;
        console.error(`[runner] git push reported ok but origin/main on GitHub (${remoteHead || "unknown"}) does not match local HEAD (${localHead || "unknown"}) — NOT confirmed, retrying`);
      } else {
        lastPushError = (pushResult.stderr || pushResult.stdout || pushResult.message || "").trim();
      }

      // GH013: GitHub's secret-scanning push protection rejects the whole
      // push because SOME commit being pushed still carries a tracked
      // secret file (.nixpacks/build.sh, holding GH_PUSH_TOKEN in
      // plaintext). cleanupSensitiveTrackedFiles() only stops it from
      // being in the commit made THIS cycle — it cannot fix a commit that
      // already exists further back in local (unpushed) history, from
      // before that cleanup ran. The only real fix for that is to drop
      // the tainted commits from history entirely: `reset --soft` onto
      // origin/main collapses ALL unpushed local commits into one, while
      // leaving the working tree (today's actual state file contents)
      // completely untouched — so no trade data is lost, only the
      // throwaway intermediate "railway state" commit history, which was
      // never meaningful on its own.
      const stderrText = pushResult.stderr || "";
      if (/GH013|push protection|Personal Access Token/i.test(stderrText)) {
        console.error("[runner] push blocked by GitHub secret scanning (GH013) — squashing unpushed local history onto origin/main to drop the tracked secret file for good");
        logResult("  fetch origin main", shCap("git fetch origin main"));
        logResult("  reset --soft origin/main", shCap("git reset --soft origin/main"));
        cleanupSensitiveTrackedFiles();
        addStateFiles();
        logResult("  commit (squashed)", shCap(`git commit -m "railway state [skip ci]"`));
      } else if (/\[rejected\]|non-fast-forward|failed to push some refs|fetch first|Updates were rejected/i.test(stderrText)) {
        // Expected, routine case: origin/main moved ahead of Railway's local
        // branch (e.g. a commit landed from outside this process — Claude
        // Code, a manual push, another tool). Recover explicitly instead of
        // relying on `git pull`, whose merge-vs-rebase behavior depends on
        // the container's (uncontrolled) pull.rebase default: fetch, then
        // merge origin/main in with -X ours so any file-level conflict
        // resolves in favor of Railway's just-committed state — never a
        // stale value from GitHub overwriting live trading state.
        console.log("[runner] push rejected as non-fast-forward — auto-recovering (fetch + merge -X ours)");
        shCap("git merge --abort"); // clears any stale merge state from a previous crashed attempt
        logResult("  fetch origin main", shCap("git fetch origin main"));
        const mergeResult = shCap("git merge -X ours origin/main --no-edit");
        logResult("  merge -X ours origin/main", mergeResult);
        if (!mergeResult.ok) {
          // A conflict -X ours couldn't auto-resolve (e.g. a delete/modify
          // conflict) — force Railway's own copy of every state file and
          // finish the merge by hand rather than leaving the repo mid-merge.
          console.error("[runner] merge -X ours could not auto-resolve — forcing Railway's copy of every state file");
          for (const f of STATE_FILES) {
            logResult(`  checkout --ours ${f}`, shCap(`git checkout --ours ${f}`));
            logResult(`  add ${f}`, shCap(`git add ${f}`));
          }
          logResult("  commit (merge resolution)", shCap("git commit --no-edit"));
        }
      }
      // Anything else (auth failure, network error, GitHub outage) isn't
      // something more git commands can fix — just back off and retry the
      // push as-is below; if it's still failing after 5 attempts it's a
      // real, non-self-healing problem worth the Telegram alert below.

      try { execSync(`sleep ${i * 2}`, { timeout: GIT_TIMEOUT_MS }); } catch {} // simple sync backoff (seconds)
    }
    console.error("[runner] git push failed after 5 retries — state changes NOT persisted this cycle. See attempt logs above for the actual error.");
    if (!pushFailureAlerted) {
      pushFailureAlerted = true;
      // Mask BEFORE truncating — truncating first could cut the token in
      // half, leaving a partial (still-identifying) fragment that no
      // longer matches maskToken's exact string search.
      const reason = maskToken(lastPushError || "سبب غير معروف — لا رسالة خطأ من آخر محاولة").slice(0, 200);
      alertTelegram(`⚠️ Railway: git push فشل\nالسبب: ${reason}`);
    }
  } catch (e) {
    console.error("[runner] syncToGitHub error:", e.message);
  }
}

// ─── BOT INVOCATION ──────────────────────────────────────────
// Final safety net: no matter what hangs inside a child process (an
// un-timed-out fetch we missed, a stuck native call, anything) this
// guarantees runNode() always resolves within CHILD_TIMEOUT_MS, so
// the main loop can never freeze on a child that never exits.
const CHILD_TIMEOUT_MS = 90 * 1000;

function runNode(script, extraEnv = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const child = spawn("node", [script], {
      env: { ...process.env, ...extraEnv },
      stdio: "inherit",
    });

    const watchdog = setTimeout(() => {
      if (settled) return;
      settled = true;
      console.error(`[runner] WATCHDOG: ${script} exceeded ${CHILD_TIMEOUT_MS / 1000}s — killing and continuing to next cycle`);
      try { child.kill("SIGKILL"); } catch (e) { console.error(`[runner] failed to kill ${script}:`, e.message); }
      resolve(1);
    }, CHILD_TIMEOUT_MS);

    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      resolve(code ?? 0);
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
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
