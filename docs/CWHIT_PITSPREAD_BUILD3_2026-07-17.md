# BUILD-3 — Pitcher HR9 + BABIP spread scalars: fit, gates, verdict (2026-07-17)

Tool: `tools/fit-pitspread-hrbab.ts` (run: `node tools/fit-pitspread-hrbab.ts`; seeded — reruns
reproduce every number). Run snapshot: `fixtures/pitspread-fit-run-2026-07-17.txt` (catalog cdmx,
model `league-41-42-pareto`). Evidence base: `docs/CWHIT_MMSE_BATTERY_2026-07-16.md` (pit HR9
1.24* [1.14,1.34] and pit BABIP 1.24* [1.11,1.40] pooled, FLAT-ish quartile bands ⇒ scalar
instrument; combined stake ~3.1 mwOBA/card; corroborated by quicks pitcher HR obs/pred 0.84–0.91
and the C-grid HRR-quartile slope 1.22–1.29; **pit BB9 0.99 — BB untouched by design**).
Governance: plan §15.7 (universal corrections ship on-by-default with a global kill-switch;
environment-conditioned corrections are functions of era/park FACTOR VALUES, never named-instance
exceptions). Siblings: BUILD-1 (`docs/CWHIT_KSPREAD_PIT_2026-07-16.md`, K ramp — SHIPPED),
BUILD-2 (`docs/CWHIT_HITTAIL_BUILD2_2026-07-17.md`, hitter tail — SHIPPED).

**VERDICT: HR9 leg WIRED, ON BY DEFAULT (all pre-registered gates pass on the HR-only record).
BABIP leg HELD (bronze G1 CI-clear fail on a fit tier). One flag carried: gold-cap daily HR9
overshoot (quick-vs-daily heterogeneity at the same gap, NOT the era class).**

## 1. Salt recompute + per-tier measurement

Baseline = the SHIPPED scoring line (BUILD-1 K ramp active in both pre and post — the fit
measures production's residual defect, not a stale line's). Pooled recompute: **HR9 1.26**
(battery 1.24 ✓), **BABIP 1.18** (battery 1.24 — slightly shrunk on the K-ramp baseline).

| tier | N | g_hr | g_bab | HR9 slope [CI] | BABIP slope [CI] |
|---|---|---|---|---|---|
| iron | 44 | 47.7 | 50.9 | 1.30 [1.10,1.52] | 1.11 [0.98,1.38] |
| bronze | 52 | 36.3 | 36.1 | 1.23 [1.09,1.34] | 1.48 [1.17,2.00] |
| silver | 22 | 27.6 | 22.3 | 1.25 [0.86,1.54] | 1.06 [0.81,1.30] |
| gold | 15 | 17.5 | 20.2 | 1.31 [1.11,1.46] | 0.97 [0.63,1.39] |

- **HR9 is gap-FLAT** (1.23–1.31 over g 17.5–47.7) — NOT the K ramp's monotone geometry
  (1.90→1.43). The data identify a constant out-of-frame amplification, not a gap slope.
- **BABIP is heterogeneous**: bronze 1.48 vs silver/gold ≈ 1.0 — the pooled battery number was
  bronze-driven; there is no clean flat OR gap-monotone structure.

## 2. Fitted ramps + the BUILD-3 pin rule

`s(g) = 1 + A·(1 − e^(−g/G))`, s(0)=1 hard, per channel, precision-weighted. **The BUILD-1 pin
rule ("most-saturating within 5% of the linear-limit SSE") degenerates on a flat profile to
G ≈ 0** — a step at the league anchor that would hand a nearly-in-frame pool (g = 2) the full
amplification. The BUILD-3 pin keeps the same conservatism principle aimed at where THIS
geometry's unobserved region is (below the observed gap range): **G = g_min/3** (95% saturation
at the lowest observed tier gap ⇒ continuous league anchor; no more amplification below the
first measured point than is measured there), A closed-form at that G.

- **HR9: A = 0.2648 [boot 0.157, 0.355], G = 5.8** ⇒ s ≈ 1.25–1.26 at every tier gap
  (plateau 1.26). Saturating decisively beats the linear limit (SSE 0.71 vs 5.61).
- BABIP: A = 0.1461 [0.032, 0.327], G = 6.7 — weakly identified (G-profile ~flat), NOT wired.

Held-out (fit without bronze, predict bronze): HR9 predicted 1.29 [1.14,1.42] vs measured 1.23
[1.09,1.34] **PASS**; BABIP predicted 1.08 [0.96,1.25] vs measured 1.48 [1.17,2.00] — marginal
overlap only (the bronze cell is the outlier its own channel's fit cannot express).

## 3. Gate record

**Full candidate (HR+BABIP): BABIP G1 FAILS at bronze** — post slope 1.30 [1.02,1.73] CI-clear
above 1 on a FIT tier (under-corrected; the flat ramp cannot reach bronze's 1.48 without breaking
silver/gold ~1.0). Per the pre-registration ("wire only if gates pass", "never tune past a
failed gate") **the BABIP leg is HELD** — no production wiring, constants recorded here only.

**HR-only candidate (the shipping configuration) — gated in its own right, ALL PASS:**

| tier | G1 HR9 slope pre→post [CI] | G2 wOBAA corr pre→post (Δ [CI]) |
|---|---|---|
| iron | 1.30 → **1.03 [0.85,1.18] PASS** | .7439 → .7705 (**+.027 [+.003,+.057] CI-clear IMPROVE**) PASS |
| bronze | 1.23 → **0.97 [0.86,1.07] PASS** | .7115 → .7217 (+.010 [−.017,+.042]) PASS |
| silver | 1.25 → **0.99 [0.69,1.21] PASS** | .8227 → .8142 (−.009 [−.091,+.040]) PASS |
| gold | 1.31 → **1.04 [0.89,1.17] PASS** | .6100 → .6699 (+.060 [−.017,+.166]) PASS |
| POOLED | 1.26 → **1.00** | .7310 → .7453 (+.014 [−.004,+.033]) PASS |

G3 levels: moves ≤ 0.02 HR9 (≈ the algebraic (s−1)·(HR̄_sample−HR̄_pool·era) expectation;
anchor-absorbed per Ruling-1 scope). G4 spread: HR9 ratioDcv 0.72–0.80 → 0.92–1.01, ON the
deconvolved optimum (0.94–1.00). Hitter identity: 499 recs bit-identical. K9 identity:
structural per-card check bit-identical (the K leg is carried unchanged from BUILD-1).

## 4. Weird-env battery + flags

Dailies (deployed per-channel line; pre AND post carry the K ramp; HR-only wOBAA also shown):

| format | g_hr | s_hr | HR9 slope pre→post | BABIP pre→post | wOBAA Δ (HR-only) |
|---|---|---|---|---|---|
| Early Gold (era-1920/park-169) | 17.5 | 1.25 | 0.98 → 0.78 [0.59,1.02] PASS | 1.71 → **1.50 [1.22,1.74] residual** | −.015 [−.044,+.006] ns |
| Bronze Heart (era-1939/park-191) | 44.1 | 1.26 | 1.29 → **1.03 [0.74,1.21] PASS** | 1.49 → 1.26 [0.74,1.82] | +.080 [−.072,+.170] ns |
| Gold Cap (era-2010/park-156) | 17.5 | 1.25 | 0.97 → **0.78 [0.60,0.83] OVERSHOOT** | 0.94 → 0.82 (CI wide) | −.004 [−.036,+.002] ns |

**FLAG 1 — gold-gap quick-vs-daily HR9 heterogeneity (carried, not fit):** gold-quick measures
1.31 [1.11,1.46] while gold-cap daily measures 0.97 [0.75,1.04] at the SAME pool gap (17.5) —
two independent observed datasets disagree, so a gap-conditioned instrument cannot satisfy both;
the shipped ramp (fit on the quicks) overshoots the daily CI-clear at the channel level.
NOT the era class: era_hr(eff) = era_h = 1.000 at gold-cap, and park compression (cp 0.26) caps
the park-HR effect at ~5% — far too small for the 1.31↔0.97 divergence. Candidate axis:
**quick-vs-daily format STRUCTURE** (a legal property-class conditioning per plan §15.7 / the
mission rule, like bracket size/Bo-N/daily-vs-cap). Composite damage at the flagged cell is
nil (wOBAA Δ −.004 ns, corr .94 stays .94), N=14, and the structure mirrors the BUILD-1
gold-quick G2 exception Derek overruled (thin cell, non-replicating at matched gap in the
sibling dataset). Rollback = the kill-switch.

**FLAG 2 — BABIP era/environment residual (factor-conditioned framing):** Early Gold's BABIP
slope stays 1.50 CI-clear post-correction (and pre, 1.71 — the largest BABIP defect measured
anywhere). Unlike the K precedent (era_k 0.35 over-compressing predicted spread), **era_h at
Early Gold is 0.974 ≈ 1**, so the factor-compression mechanism does NOT explain it; candidate
factor axes are the park_avg factor values (park-169 avg 1.04) or daily-format structure —
unresolved. Per plan §15.7 any future fix must be a continuous function of environment FACTOR
VALUES / structural properties, never an early-gold exception. (BABIP is not shipping anyway;
this flag documents the environment behavior of the HELD channel.)

**Era-residual flag status for the shipped HR leg: CLEAN** — Bronze Heart (era_hr_eff 0.584,
the most HR-compressed cell) lands post 1.03; no era-conditioned HR9 stall is observed. The
adverse HR cell is at NEUTRAL era (Flag 1), which is exactly why it is not filed as era-class.

## 5. Implementation (wired, ON BY DEFAULT — plan §15.7 pattern)

- **Constants:** `PIT_SPREAD_HR = { A: 0.2648, G: 5.8 }` + `pitSpreadHrRamp(gap)` in
  `src/model/pool-transform.ts` (full fit provenance in the comment; `s(g ≤ 0) = 1` exactly).
- **Application:** `applyPitSpread(e, kSpread)` (same module) — the ONE copy of the pitcher
  spread order of operations: K about K̄ (BUILD-1, bit-identical for K-only objects), then HR
  about HR̄ (raw pre-era; `era_effective_hr`/park multiply downstream once — the K placement
  precedent), then BABIP pivoted on the ORIGINAL BIP riding `RawPitching.hMul` (the carrier
  `pitchingComponents` honors — nHH is re-derived from the rating there, so a count-only change
  would be silently discarded; the exact defect class found+fixed for BUILD-2's hitter BABIP
  leg). Call sites: `score-card.ts`, `calibrate.ts` augment, `tournament-eval.ts` — all three
  now call `applyPitSpread`; the eval line (`src/eval/cwhit/sample.ts` ourPit) applies the same
  function, so fit and production share one implementation.
- **Path:** own-gap branch of `scoreTournament` — one `buildFrameShift` + one
  `poolPitMeansOwn` (own-gap centering means; `pm.k ≡ poolMeanKOwn().pit`, one collector)
  serve both ramps; `kSpread = { sHit:1, sPit: kRamp(stu-gap), meanPit: pm.k, sPitHr:
  hrRamp(hrr-gap), meanPitHr: pm.hr }`, threaded into calibrate/calibrateBasic (anchor sees the
  corrected events) and mirrored in the `/api/tournament/scorecard` own-gap mode. `sPitBab` is
  NEVER set (held). Requires a trainingMeans-bearing model; absent ⇒ skipped + boot warning.
- **KILL-SWITCH:** `state.pitSpreadHr = "off"` — `POST /api/training/pit-spread?enabled=false`
  (re-enable `?enabled=true`); `GET /api/training/pit-spread` reports
  `{ enabled, hasTrainingMeans, A, G, babHeld: true }`. Independent of the K ramp's
  `kspread-pit` switch (channel-separable rollback).
- **Tests** (`tests/pitspread.test.ts`, 14): constants pinned; ramp values at tier gaps +
  95%-saturation point as regression; s(g≤0)=1 exact; monotone/plateau-bounded; applyPitSpread
  per-leg isolation + K-only bit-identity with the old inline call + all-s=1 exact identity +
  BABIP-carrier arithmetic (pivot on original BIP, re-applied on new BIP, mix-preserving);
  scoreCard in-frame bit-identity, HR-spread pitcher-only isolation, BABIP hMul reaches the
  deployed composite; poolPitMeansOwn ≡ poolMeanKOwn on K + lift responses.

**Expected behavior change (intended):** on next Regenerate, out-of-frame pitcher HR-allowed
re-spaces ~×1.25 about the pool mean — HR-prone arms score worse, HR-suppressing arms better;
in-frame pools bit-identical; hitters untouched; K unchanged from BUILD-1's shipped behavior.

## 6. Residuals carried

1. Flag 1 (gold-gap quick-vs-daily HR heterogeneity) and Flag 2 (Early Gold BABIP residual) —
   §4; both factor/property-conditioned follow-ups, never named-instance fixes.
2. BABIP channel: HELD with constants recorded (§2); its tier structure (bronze-only) needs an
   instrument the flat scalar is not; residual value stake ≤ 1.2 mwOBA.
3. The K era-spread residual (BUILD-1 §5, EG/BH stall ≈ 1.44) is unchanged and remains queued.
4. Fit/judge share the 5-tier cwhit sample (held-out-tier = the honest OOT); λ/A constants are
   frozen; re-fit only as a deliberate cycle.
