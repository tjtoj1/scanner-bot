# DECISIONS

Binding record of decisions taken on this repository, and of experiments that
were tried, measured and **rejected**. Anything listed under "Do not repeat"
has already been refuted by real trade data — re-running it costs trading days.

Decision history before this file lived in three scattered places:
`strategy_lab.json → changelog`, long code comments, and two standalone
analysis documents. Those remain as evidence; this file is the index.

---

## LAB — statistical criterion for combo sizing

**Status: current. Keep.** Applied 2026-09-16 (`c7cea85`).

Combo tiers are graded against an **absolute zero anchor**, not against LAB's
own mean `pnlPct`.

```
SE = stdev(pnlPct) / sqrt(n)

below_avg  ⟸  n >= 20  and  avg <= -5%  and  avg + 1.28*SE < 0   → x0.5
above_avg  ⟸  n >= 30  and  avg >= +5%  and  avg - 1.28*SE > 0   → x1.5
average    ⟸  otherwise                                          → x1.0
```

Why each part:

- **Zero anchor.** Grading against LAB's own mean is self-referential: while
  that mean is negative, a combo that merely loses less than the rest scores
  "average" and keeps full size. The system could never conclude that anything
  was bad in absolute terms.
- **Significance gate.** `pnlPct` on these options carries a ~30pp standard
  deviation. The only combo ever promoted to x1.5 rested on a single +115%
  trade out of 8; without it the mean was -3.37%.
- **Asymmetric sample gates (20 down / 30 up).** Sizing down is cheap
  insurance against a combo that may be bad; sizing up puts 50% more capital
  on one that may only look good.

**Expected consequence, accepted deliberately:** all six combos sit at x1.0
and the learner stays silent until a combo reaches n>=20 with a statistically
separable mean. Silence here is the criterion working, not a fault.

`overallAvgPnlPct` is still computed, but for display only, and is labelled as
such in the Telegram message. It must not re-enter the tier decision.

---

## LAB — do not repeat: `volumeMultiplier`

**Status: rejected and reverted. Do not touch.**

| | |
|---|---|
| Tried | 1.3 → 1.495 (2026-08-28) → 1.719 (2026-08-31) |
| Reverted to | **1.3** (2026-09-01) |
| Measured effect | `worsened` — hardStopRatio 42% → **62.5%** |

The hypothesis ("weak volume at entry causes hard-stop exits") was refuted by
the per-trade data, not by opinion:

- Of 47 hard-stop losses, only **26%** had volume anywhere near the 1.719x
  threshold. Mean volume of those losses was 11.97x, median 4.65x — far above
  the threshold.
- **Winners had higher volume than losers** (24.34x vs 11.97x), so volume is
  not the discriminator between the two.
- Both raises were applied without measuring the first one's effect, on
  essentially the same evidence.

Raising this parameter again requires new evidence that specifically addresses
those three findings.

---

## LAB — do not repeat: global parameter tuning

**Status: abandoned as an approach.** Reverted 2026-09-02.

`emaSlow` was widened 21 → 24.15 on 2026-09-01. A global parameter affects
every trade at once, and this one **stopped entries entirely** — 0 trades
while the market stayed open and no safety limit had been reached.

The global tuner (`runDailyLearning`) is disabled and remains in the file as a
manual-only option. Sizing is now allocated **per combo**, which scales one
bucket at a time and can never halt trading outright.

---

## WVAD — no `|diff|` strength threshold

**Status: by design. There is no threshold, and none should be added without
new evidence.**

Entry is decided solely by the `Sum` / `Signal` crossover, using Pine's
`ta.crossover` semantics (`<=`, not `<`) — `scan_wvad.js`, `checkSignal()`:

```js
const crossUp   = prevSum <= prevSig && curSum >  curSig;
const crossDown = prevSum >= prevSig && curSum <  curSig;
```

That is the whole decision. No magnitude filter exists, and none has existed
in any revision of the file. Verified against every commit that has ever
touched it.

Two related facts, so the question does not get reopened from a wrong premise:

- **The scale is not normalised.** WVAD is volume-weighted, so `|Sum - Signal|`
  at real crossovers runs from ~32,000 to ~6,400,000 (median ~684,000). A
  threshold below ~32,000 is a mathematical no-op: 100% of crossovers pass it.
- **Signals are not scarce.** Measured on real 15-min RTH bars: 46 crossovers
  across 6 judgeable days on SPY+QQQ, ~7.7/day combined, with no day at zero.
  The binding constraint is the trade cap (2/symbol/day, 4/day), which already
  truncates 54% of signals. Loosening entry would add noise without adding a
  single trade.

If a strength filter is ever wanted, the data-grounded value for a 40-50% pass
rate is around **700,000** (p50 = 683,601, p60 = 804,714) — not a two- or
three-digit number.

---

## WVAD — environment variable naming

**Status: intentional. Do not "normalise" to the `ALPACA_KEY_n` pattern.**

WVAD reads `ABDULLAH_TJ_KEY` / `ABDULLAH_TJ_SECRET`, deliberately breaking the
`ALPACA_KEY_2` / `ALPACA_KEY_3` convention used by v21 and LAB, because it
trades a separate Alpaca paper account owned separately.

Operational consequences:

- The names exist **only** in Railway's environment settings. They appear in no
  workflow, config file, or committed file — by design.
- Restarting the service does **not** load newly added variables. A full
  **redeploy** is required.
- The startup diagnostic prints variable **names and presence/length only**,
  never a value. Keep it that way if the block is edited.

---

## Cooldown (30 min, symbol x direction) — UNRESOLVED CONTRADICTION

**Status: active in all three bots. The decision record disagrees with itself.**

| Document | Conclusion |
|---|---|
| `GAP_ANALYSIS_SUMMARY.md` | The cooldown blocks **profitable** re-entries: 43 trades inside the window totalling **+$579**, of which the 0-5 minute bucket was 40 trades at **+$878** |
| `FINAL_COOLDOWN_ANALYSIS.md` | "KEEP COOLDOWN — +$387 improvement, no further tuning needed" |

Same mechanism, overlapping data, opposite conclusions. Neither document
supersedes the other, and no measurement has resolved it.

**Open item.** Until it is settled, treat the cooldown as unvalidated rather
than as an established win. Resolving it needs one measurement both documents
would accept — a pre-registered definition of "harmful chain" applied to the
current outcomes logs.

---

## Operational: silent failure is the main reliability gap

**Status: addressed 2026-09-25.**

WVAD exited `process.exit(0)` on its environment-check path, so `runner.js`
read success and moved on with nothing sent to Telegram. The bot sat dead for
**five trading days** (2026-09-18, 21, 22, 23, 24) — zero writes to
`state_wvad.json` while `state_v21.json` and `state_lab.json` were written
normally on every one of those days.

Three changes now make that class of failure loud:

1. `scan_wvad.js` alerts Ops and exits **non-zero** on both halt paths
   (`WVAD_ENABLED=0`, missing credentials), throttled to one alert per UTC day.
2. `runner.js` alerts when any child exits non-zero.
3. `runner.js` alerts when a bot's state file goes untouched for 3 consecutive
   cycles during market hours — catching a bot that fails without a bad exit
   code.

**Principle to preserve:** a bot that cannot trade must never be
indistinguishable from a bot that simply found no signal.

---

## Risk limits, as of 2026-09-25

| Control | v21 | LAB | WVAD |
|---|---|---|---|
| Daily loss limit | **-$600** (added 2026-09-25) | -$1,000 | -$600 |
| Daily profit target | +5% of portfolio, halts entries | — | — |
| Max trades | 4/day | 3 open positions | 4/day, 2/symbol/day |
| Trade budget | $500 | $500 x combo multiplier, $1,000 hard cap | $500 |

v21 had no daily loss limit at any point before 2026-09-25. -$600 matches
WVAD, which shares v21's $500 budget and 4-trade cap: four trades stopping out
at -35% is roughly -$700, so the limit trips on a genuinely bad day rather
than a normal one.

---

## Archived files

`archive/` holds scripts no longer on any execution path.

**Not archived, despite looking obsolete:** `scan.js`, `scan2.js`, `scan2`,
`state.json`, `state2.json`, `state_fvg.json`. These are still referenced by
**live** GitHub Actions workflows on cron schedules during market hours
(`scan.yml`, `monitor.yml`, `scan2.yml`, `monitor2.yml`). Moving them breaks
those workflows. Retire the workflows first, then the files.
