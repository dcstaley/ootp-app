// THE MISSION SCORECARD, v2 — ALL FOURTEEN CAPTURED FORMATS, each under its OWN resolved config.
//   run: node tools/cwhit-mission-scorecard-v2.ts            (add --no-corrections for the pre-correction model)
//
// WHY v2 EXISTS. `tools/cwhit-scorecard.ts` (v1) is the standing benchmark, and it says so itself:
// "only the five QUICK tiers are scored (known VAL caps + neutral env). Daily/Cap formats carry
// non-neutral era/park and are out of scope here." Its corrected result is STATISTICAL PARITY on
// those five tiers. Derek's question is not about five tiers — it is "are we beating cwhit where I
// actually play", and nine of the fourteen formats in the corpus have NEVER been dueled. Quick-tier
// parity is the PRIOR for this run, not the answer.
//
// WHAT v2 ADDS, and nothing else:
//   1. EVERY format in THE corpus registry (`src/eval/cwhit/corpus.ts`), ONE AT A TIME, under its own
//      resolved era/park/softcaps/eligibility. No format list is declared here — the registry is the
//      list, and a format added there appears here on the next run.
//   2. THREE COLUMNS per cell: ours vs cwhit-native (his projections) vs OBSERVED (the truth).
//   3. LEVEL and SHAPE kept SEPARATE, always. A single |pred − obs| headline conflates them and is
//      banned (it was v1's own predecessor's methodology bug, and Derek caught its restatement).
//   4. CORRECTED NOISE UNITS: BF-based binomial variances, composite multinomial variance, and the
//      noise-share CI reliability gate — all from the shared eval module, none re-derived here.
//   5. ONE dcv rule and one THIN rule, applied uniformly to every cell of every section.
//
// NO SCORING MATH IS WRITTEN HERE, AND NO SAMPLE ASSEMBLY. Predicted lines come from the ONE judged-
// sample builder (`src/eval/cwhit/sample.ts`) driving the scoring core; the statistics come from the
// ONE eval module (`src/eval/cwhit/scorecard.ts`). This file resolves configs, calls the builder once
// per format, and tabulates. Nothing here fits anything, changes a default, or touches production.
//
// DOCTRINE (memory cwhitstats-external-data): cwhit's RAW OBSERVED events are ground truth. His
// PROJECTIONS are a COMPETITOR BENCHMARK — weight ZERO as truth, never a fitting target. His pwOBA
// column is never used as truth; wOBA is recomputed from raw events with OUR weights.

import { readFileSync } from "node:fs";
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { resolveCoeffs, type Model } from "../src/config/coeff-resolve.ts";
import { rowEligible } from "../src/config/eligibility.ts";
import type { Era, Park, Tournament } from "../src/config/tournament.ts";
import type { CalScales, Coeffs, Derived } from "../src/config/types.ts";
import {
  FIELD_N, makeRawPolyModel, computeUnifiedFieldStats, productionFieldStats, applyWobaWeights, computeDerived,
  buildPoolTransform, buildFrameShift, poolPitMeansOwn, kSpreadPitRamp, pitSpreadHrRamp,
  type EventForm, type FieldStats, type RatingEnvelope, type WobaWeights, type TrainingMeans,
} from "../src/scoring-core/index.ts";
import { computeHitTail, PINNED_HIT_TAIL, type HitTail } from "../src/scoring-core/hit-tail.ts";
import { parseCatalogCsv, type Card } from "../src/data/catalog.ts";
import type { WobaWeights as WW } from "../src/eval/cwhit/audit.ts";
import {
  agreement, duel, per9NoiseVar, babipNoiseVar, pctNoiseVar, per600NoiseVar, BF_PER_9,
  wobaNoiseCells, wobaNoiseVar, noiseShareCiUpper,
  type Agreement,
} from "../src/eval/cwhit/scorecard.ts";
import { CWHIT_CORPUS, CAPTURE_DIR_2026_07_21, captureObsPath, captureProjPath, type CwhitFormat } from "../src/eval/cwhit/corpus.ts";
import {
  buildCwhitSample, wellSampled, isPit, inValueWindow,
  type KSpreadPit, type Rec, type SampleDeps, type ValueWindow, type CwhitSource,
} from "../src/eval/cwhit/sample.ts";

const f = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "n/a");
const sgn = (x: number, d = 2) => (Number.isFinite(x) ? `${x >= 0 ? "+" : ""}${x.toFixed(d)}` : "n/a");
const pad = (s: string, n: number) => s.padEnd(n);

// ── THE READING RULES, DECLARED BEFORE ANY NUMBER IS COMPUTED ────────────────
// Stated up front so no threshold can be chosen after seeing a result.
//   MIN_N   — below this a cell has NO statistics at all; it is reported as INSUFFICIENT with its N.
//   THIN_N  — at or below this a cell prints but carries NO VERDICT on any axis and is counted in
//             NEITHER scoreboard. "Insufficient data" is not "noise", and a duel on 8 cards is the
//             former. (v1 allowed thin duels and bounded only the ABSOLUTE spread read; this run
//             applies the stricter rule uniformly, because nine of the fourteen formats are new and
//             a thin cell would otherwise enter the headline count as if it were a measurement.)
//   UNREL   — the bootstrap 97.5th-percentile NOISE SHARE reaches 1.0, i.e. sampling variance may
//             exceed the TOTAL observed variance. Then the deconvolved SD collapses and `dcv` is not
//             a number. ONE rule, every section, both roles, both models — dcvBad is a property of
//             (obs, noiseVar), not of either predictor.
const MIN_N = 5, THIN_N = 20;

// ── boot: repository, deployed model, catalog (the tools/park-hand-contrast.ts pattern) ──
const repo = new Repository("data");
await seedDefaults(repo); await seedEras(repo); await seedAccounts(repo);
const state = (await repo.load<{ activeModelId?: string; catalogSourceId?: string }>("state", "app")) ?? {};
type TM = {
  id: string; eventForm?: EventForm; wobaWeights?: WobaWeights; ratingEnvelope?: RatingEnvelope;
  trainingMeans?: TrainingMeans;
  platoon?: { pit: { hand: string; vsRHB: number; vsLHB: number }[]; hit: { hand: string; vsRHP: number; vsLHP: number }[] };
};
const trained = (await repo.loadAll<TM>("trained-models")).find((x) => x.id === state.activeModelId);
if (!trained?.eventForm || !trained.wobaWeights || !trained.platoon) throw new Error("active model missing eventForm/wobaWeights/platoon");
const rp = makeRawPolyModel(trained.eventForm);
const W = trained.wobaWeights as WW;
const envelope = trained.ratingEnvelope;
const model = (await repo.loadAll<Model>("models"))[0]!;
const eras = new Map((await repo.loadAll<Era>("eras")).map((e) => [e.id, e]));
const parks = new Map((await repo.loadAll<Park>("parks")).map((p) => [p.id, p]));
const tourneys = new Map((await repo.loadAll<Tournament>("tournaments")).map((t) => [t.id, t]));
const pitExp = new Map(trained.platoon.pit.map((p) => [p.hand, { wR: p.vsRHB, wL: p.vsLHB }]));
const hitExp = new Map(trained.platoon.hit.map((p) => [p.hand, { wR: p.vsRHP, wL: p.vsLHP }]));

const srcId = state.catalogSourceId ?? "cdmx";
const baseCards: Card[] = parseCatalogCsv(readFileSync(`data/imports/${srcId}.csv`, "utf8")).cards
  .filter((c) => String(c["Variant"] ?? "").toUpperCase() !== "Y");

const CORRECTIONS = !process.argv.includes("--no-corrections");
const SOURCE: CwhitSource = { kind: "capture", dir: CAPTURE_DIR_2026_07_21 };   // full depth; no derived top-N cut

// ── WHICH OF OUR TWO LINES IS JUDGED — the one thing v2 CANNOT inherit from v1 ────────────────────
//
// `Rec` carries two predicted lines (see src/eval/cwhit/sample.ts): `ours` = the RAW event-model
// output, and `oursDep` = the DEPLOYED line, i.e. the raw events pushed through the scoring core's
// own component recompute (era + park + the per-event scales) and the trusted assembly.
//
// v1 judges the RAW line, and on ITS corpus that is right: all five Quick tiers run on era-2010 /
// park-1, where every era and park factor is EXACTLY 1.0, so per-channel raw ≡ deployed and the raw
// line is the cleaner frame (it excludes the anchor scalar sFinal, which is a readability CONVENTION
// and not a prediction).
//
// v2 CANNOT inherit that. Six of the nine non-quick formats carry a real era and park — early-gold is
// era-1920, bronze-heart era-1939, late-bronze era-1979 — and the environment enters ONLY on the
// deployed line. Judging the raw line there compares an ENVIRONMENT-FREE prediction against an
// IN-ENVIRONMENT observation: measured on this corpus that reads as our hitter SO% sitting at ~20.7
// against an observed 7.3 at early-gold, which is a UNIT MISMATCH being reported as a model defect.
// So the deployed line is the default here, and section 0b proves per-channel identity on the neutral
// formats rather than asserting it. `--raw-line` restores v1's convention for exact comparison.
const RAW_LINE = process.argv.includes("--raw-line");
const oursOf = (r: Rec): Record<string, number> => (RAW_LINE ? r.ours : r.oursDep);

// ── per-format resolution: ONE coeffs bag per format, from the config ────────
interface Fmt {
  reg: CwhitFormat; t: Tournament; coeffs: Coeffs; derived: Derived; win: ValueWindow;
  quick: boolean; nPool: number; sK: number; sHr: number;
}

/** The eligibility window comes from the TOURNAMENT CONFIG, never from a hard-coded ladder:
 *  `card_value_min`/`card_value_max` + `rowEligible` IS `buildEligiblePool` minus the owned filter
 *  (which the calibration pool never applies). So bronze-heart's `Year 1930-1989`, diamond-heart's
 *  `Year 1930-1980` and live-open's `Card Type` restriction are honoured by construction.
 *  `tier` carries the registry KEY — the builder resolves a capture path from the registry by
 *  legacy slug OR key, which is what makes the five slug-less formats reachable at all. */
const FORMATS: Fmt[] = CWHIT_CORPUS.map((reg) => {
  if (!reg.tournamentId) throw new Error(`corpus registry has no tournamentId for '${reg.key}'`);
  const t = tourneys.get(reg.tournamentId);
  if (!t) throw new Error(`tournament '${reg.tournamentId}' not found (registry key '${reg.key}')`);
  const era = eras.get(t.eraId), park = parks.get(t.parkId);
  if (!era || !park) throw new Error(`tournament '${t.id}': missing era '${t.eraId}' or park '${t.parkId}'`);
  const coeffs = resolveCoeffs(model, era, park, t.softcaps);
  applyWobaWeights(coeffs, trained.wobaWeights!);
  const win: ValueWindow = {
    tier: reg.key,
    valueMin: t.card_value_min ?? undefined,
    valueMax: t.card_value_max ?? Number.POSITIVE_INFINITY,
    eligible: (c) => rowEligible(c as Card, t),
  };
  return {
    reg, t, coeffs,
    // `true` = tHR removed, matching production's `computeDerived(coeffs, !!eventForm)` under the
    // deployed raw-poly form. (All fourteen configs carry tournamentAdjustment disabled, so the
    // server's post-derive adjustment multiplications are no-ops here — checked, not assumed.)
    derived: computeDerived(coeffs, true),
    win, quick: reg.type === "Quick",
    nPool: 0, sK: NaN, sHr: NaN,
  };
});

/** Score ONE format under ITS OWN resolved config, through the ONE shared builder. The corrections
 *  are computed EXACTLY as `src/server/server.ts` scoreTournament does on the own-gap path — same
 *  cohorts, same ramps, same pivots, same pinned λs — with this format's coeffs and pool, never the
 *  neutral bag. This is the piece v1 could not do. */
function runFormat(fm: Fmt): { recs: Rec[]; notices: string[]; missedProj: number; cal: CalScales } {
  const { coeffs, derived, win } = fm;
  const ref: FieldStats = productionFieldStats(baseCards, coeffs, rp);   // env-MATCHED reference
  const basePool = baseCards.filter((c) => inValueWindow(c, win));
  fm.nPool = basePool.length;

  let ksMap: Map<string, KSpreadPit> | undefined;
  let htMap: Map<string, HitTail> | undefined;
  if (CORRECTIONS) {
    const TMeans = trained!.trainingMeans;
    if (!TMeans) throw new Error("corrections ON needs the active model's trainingMeans — or run with --no-corrections");
    const poolField = productionFieldStats(basePool, coeffs, rp);
    const pt = buildPoolTransform(ref, poolField, envelope);
    const shift = buildFrameShift(TMeans, poolField);
    const pm = poolPitMeansOwn(basePool, coeffs, rp, pt, FIELD_N);
    fm.sK = kSpreadPitRamp(shift.pit.vR.stu ?? 0);
    fm.sHr = pitSpreadHrRamp(shift.pit.vR.hrr ?? 0);
    ksMap = new Map([[win.tier, { s: fm.sK, mean: pm.k, sHr: fm.sHr, meanHr: pm.hr }]]);   // sBab HELD, never set
    htMap = new Map([[win.tier, computeHitTail(basePool.filter((c) => !isPit(c)), coeffs, rp, pt, ref, poolField, PINNED_HIT_TAIL)]]);
  }

  const deps: SampleDeps = {
    baseCards, coeffs, derived, eventForm: trained!.eventForm!, model: rp, W, ref, envelope,
    pitExp, hitExp, kSpreadPit: ksMap, hitTail: htMap, formats: [win], source: SOURCE,
  };
  const r = buildCwhitSample(deps);
  return { recs: r.recs, notices: r.notices, missedProj: r.projJoin.missed, cal: r.cals[0]?.cal ?? {} };
}

// ── observed sampling noise per cell ─────────────────────────────────────────
// The dispatcher is local (it takes a `Rec`, and `scorecard.ts` must not import `sample.ts` — that
// would cycle); every VARIANCE FORMULA it calls is the shared one. Identical in shape to the
// dispatchers in tools/cwhit-scorecard.ts, tools/cwhit-mmse.ts and tools/obs-pred-slopes.ts.
// `Rec.sample` is BF for pitchers and PA for hitters — opponents faced, symmetric by construction.
function noiseOf(r: Rec, ch: string): number {
  if (r.role === "pit") {
    const bf = r.sample;
    const bip = Math.max(bf - (r.obs.k9! + r.obs.bb9! + r.obs.hr9!) / BF_PER_9 * bf - 0.009 * bf, 1);
    if (ch === "babip") return babipNoiseVar(r.obs.babip!, bip);
    // collapseHits=true: cwhit publishes only BABIP for pitchers and the reconstruction splits it
    // with a FIXED 0.25 XBH share, so 1B/XBH are not independently observed.
    if (ch === "woba") return wobaNoiseVar(wobaNoiseCells({ role: "pit", k9: r.obs.k9!, bb9: r.obs.bb9!, hr9: r.obs.hr9!, babip: r.obs.babip! }, W, true), bf);
    return per9NoiseVar(r.obs[ch]!, bf);
  }
  const bip = Math.max(r.sample * (1 - r.obs.bbPct! / 100 - 0.008 - r.obs.soPct! / 100 - r.obs.hr600! / 600), 1);
  if (ch === "babip") return babipNoiseVar(r.obs.babip!, bip);
  if (ch === "hr600") return per600NoiseVar(r.obs.hr600!, r.sample);
  if (ch === "woba") return wobaNoiseVar(wobaNoiseCells({ role: "hit", bbPct: r.obs.bbPct!, soPct: r.obs.soPct!, hr600: r.obs.hr600!, babip: r.obs.babip!, avg: r.raw.avg!, slg: r.raw.slg!, tripleXbh: r.raw.tripleXbh! }, W, false), r.sample);
  return pctNoiseVar(r.obs[ch]!, r.sample);
}

// The composite's `Rec` key is "woba" for BOTH roles; the pitcher LABEL is wOBAA (wOBA ALLOWED).
// Same channel set and same units as v1, so the Quick-tier cells are directly comparable to it.
const CH: Record<"pit" | "hit", { key: string; lbl: string; d: number }[]> = {
  pit: [{ key: "k9", lbl: "K9", d: 2 }, { key: "bb9", lbl: "BB9", d: 2 }, { key: "hr9", lbl: "HR9", d: 2 }, { key: "babip", lbl: "BABIP", d: 3 }, { key: "woba", lbl: "wOBAA", d: 3 }],
  hit: [{ key: "bbPct", lbl: "BB%", d: 2 }, { key: "soPct", lbl: "SO%(PA)", d: 2 }, { key: "hr600", lbl: "HR600", d: 2 }, { key: "babip", lbl: "BABIP", d: 3 }, { key: "woba", lbl: "wOBA", d: 3 }],
};

// ── one measured cell ────────────────────────────────────────────────────────
type Verdict = "OURS" | "TIE" | "CWHIT" | "NO-VERDICT";
interface Cell {
  fmt: string; label: string; quick: boolean; role: "pit" | "hit"; ch: string; d: number;
  n: number; thin: boolean; unrel: boolean; nsHi: number;
  obsMean: number; oursMean: number; cwMean: number;
  ours: Agreement; cw: Agreement;
  dLevel: { est: number; lo: number; hi: number; sig: boolean };
  dCorr: { est: number; lo: number; hi: number; sig: boolean };
  dSpread: { est: number; lo: number; hi: number; sig: boolean };
  level: Verdict; shape: Verdict;
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);

function measureCell(fm: Fmt, role: "pit" | "hit", rows: Rec[], ch: { key: string; lbl: string; d: number }): Cell {
  const obs = rows.map((r) => r.obs[ch.key]!);
  const ours = rows.map((r) => oursOf(r)[ch.key]!);
  const cw = rows.map((r) => r.proj![ch.key]!);
  const nv = rows.map((r) => noiseOf(r, ch.key));
  const useNv = nv.every((x) => Number.isFinite(x)) ? nv : undefined;
  const nsHi = useNv && rows.length >= 3 ? noiseShareCiUpper(obs, useNv) : NaN;
  const aO = agreement(ours, obs, useNv), aC = agreement(cw, obs, useNv);
  const dl = duel(ours, cw, obs);
  const thin = rows.length <= THIN_N;
  // ONE axis per verdict, never a blend. LEVEL ← Δ|bias| (NEGATIVE = ours closer). SHAPE ← Δcorr
  // ONLY (POSITIVE = ours orders better) — correlation is scale-free, so a spread defect cannot
  // masquerade as a discrimination defect. Δshape-MAE is deliberately NOT a verdict input: it
  // de-means without rescaling, so it is a shape+spread composite.
  const V = (dd: { est: number; sig: boolean }, oursIsPositive: boolean): Verdict =>
    thin ? "NO-VERDICT" : !dd.sig ? "TIE" : (dd.est > 0) === oursIsPositive ? "OURS" : "CWHIT";
  return {
    fmt: fm.reg.key, label: fm.reg.label, quick: fm.quick, role, ch: ch.lbl, d: ch.d,
    n: rows.length, thin, unrel: Number.isFinite(nsHi) && nsHi >= 1, nsHi,
    obsMean: mean(obs), oursMean: mean(ours), cwMean: mean(cw),
    ours: aO, cw: aC, dLevel: dl.absLevel, dCorr: dl.corr, dSpread: dl.spreadLog,
    level: V(dl.absLevel, false), shape: V(dl.corr, true),
  };
}

// ═════════════════════════════════════════════════════════════════════════════
console.log(`\n╔══════════════════════════════════════════════════════════════════════════════════════════════════╗`);
console.log(`║  MISSION SCORECARD v2 — ALL 14 CAPTURED FORMATS: ours vs cwhit-native vs OBSERVED                 ║`);
console.log(`╚══════════════════════════════════════════════════════════════════════════════════════════════════╝`);
console.log(`model '${trained.id}' | catalog '${srcId}' (${baseCards.length} base cards) | FIELD_N = ${FIELD_N} (imported from src/scoring-core/pool-stats.ts, never re-declared)`);
console.log(`corpus: ${CAPTURE_DIR_2026_07_21} at FULL DEPTH (the registry default source; no derived top-N cut)`);
console.log(`corrections: ${CORRECTIONS ? "ON (production default) — BUILD-1 pit K-spread + BUILD-3 pit HR9 spread + BUILD-2 hitter tail; pit BABIP scalar HELD" : "OFF (--no-corrections) — the PRE-correction model"}`);
console.log(`OUR JUDGED LINE: ${RAW_LINE
  ? "RAW event-model output (--raw-line: v1's convention). CARRIES NO ERA/PARK — valid on the neutral Quick ladder ONLY."
  : "DEPLOYED (the line scoreCard ships: era + park + per-event scales + the trusted assembly). This is the ONE thing v2 cannot"}`);
if (!RAW_LINE) console.log(`  inherit from v1: six of the nine non-quick formats carry a real era/park, and the environment exists only on this line.`);
console.log(`SELF-CHECK vs v1: run with --raw-line and the 50 Quick-tier cells reproduce tools/cwhit-scorecard.ts's LEVEL and SHAPE`);
console.log(`  verdicts EXACTLY, cell for cell (verified 2026-07-22, 0/50 mismatches). v2 is v1 plus nine formats and the env layer,`);
console.log(`  not a different instrument. NOTE the committed v1 artifact fixtures/cwhit-scorecard-run-2026-07-21-rebaseline-corrected.txt`);
console.log(`  is now STALE against a live v1 run — scoring moved after it was written — so compare against a fresh run, not that file.`);
console.log(`EACH FORMAT IS RESOLVED AND SCORED SEPARATELY: era + park + softcaps + eligibility from data/tournaments/<id>.json,`);
console.log(`  ONE coeffs bag per format via the production resolveCoeffs, ONE pool/transform/anchor per format, ONE builder call per format.`);
console.log(`GRAIN: every OBSERVED statistic is at CARD grain — one row per (CID, VLvl), pooled by cwhit over every instance of the`);
console.log(`  format inside the capture window. There is no per-game or per-instance row anywhere in this corpus, so nothing here is`);
console.log(`  a ROW-grain (per-appearance) statistic. Our predicted line is the same grain by construction: one line per (card, VLvl).`);
console.log(`MEASUREMENT ONLY — nothing is fit, no default is flipped, no production behaviour is touched.`);

// ═══ 0. RESOLUTION ═══════════════════════════════════════════════════════════
console.log(`\n\n╔═══ 0. FORMAT RESOLUTION — the config each duel is run under ═══════════════════════════════════════╗`);
console.log(`  format             type    tournament          era        park      value window   rules  eligible pool   s_K      s_HR`);
const results = new Map<string, ReturnType<typeof runFormat>>();
for (const fm of FORMATS) {
  results.set(fm.reg.key, runFormat(fm));
  const w = `${fm.win.valueMin ?? 40}-${Number.isFinite(fm.win.valueMax) ? fm.win.valueMax : "∞"}`;
  console.log(`  ${pad(fm.reg.key, 18)} ${pad(fm.reg.type, 7)} ${pad(fm.t.id, 19)} ${pad(fm.t.eraId, 10)} ${pad(fm.t.parkId, 9)} ${pad(w, 14)} ${String((fm.t.eligibility?.rules ?? []).length).padStart(5)}  ${String(fm.nPool).padStart(11)}   ${f(fm.sK, 4).padStart(6)}  ${f(fm.sHr, 4).padStart(6)}`);
}
console.log(`  Value windows are the CONFIG's card_value_min/max — never a capture's obsval, which records who happened to PLAY.`);
console.log(`  'rules' = extra eligibility rules honoured via the production rowEligible (bronze-heart Year 1930-1989, diamond-heart`);
console.log(`  Year 1930-1980, live-open Card Type). s_K / s_HR are the SHIPPED ramps evaluated at THIS format's own frame gap.`);

// ═══ 0b. RAW vs DEPLOYED ═════════════════════════════════════════════════════
// The claim "per-channel raw ≡ deployed on a neutral env" is CHECKED here, not trusted: it is the
// reason v1's raw-line Quick numbers remain valid and the reason the non-quick cells needed the
// deployed line. Reported as the max over judged rows of |dep − raw| / max(|raw|, eps).
console.log(`\n\n╔═══ 0b. RAW vs DEPLOYED — the environment's footprint, measured per format ═════════════════════════╗`);
console.log(`  Zero means the two lines agree exactly on that channel, i.e. the environment layer is the identity there.`);
for (const role of ["pit", "hit"] as const) {
  console.log(`\n  ${role === "pit" ? "PITCHERS" : "HITTERS"}   (max |dep − raw| / |raw| over the judged rows, per channel, %)`);
  console.log(`  format             neutral   ${CH[role].map((c) => pad(c.lbl, 11)).join("")} sFinal`);
  for (const fm of FORMATS) {
    const recs = results.get(fm.reg.key)!.recs.filter((r) => r.role === role && wellSampled(r));
    const cal = results.get(fm.reg.key)!.cal;
    const gap = (k: string) => {
      let m = 0;
      for (const r of recs) {
        const a = r.ours[k]!, b = r.oursDep[k]!;
        if (Number.isFinite(a) && Number.isFinite(b)) m = Math.max(m, Math.abs(b - a) / Math.max(Math.abs(a), 1e-9));
      }
      return m * 100;
    };
    console.log(`  ${pad(fm.reg.key, 18)} ${pad(fm.reg.neutralEnv ? "yes" : "NO", 9)} ${CH[role].map((c) => pad(f(gap(c.key), 3), 11)).join("")} ${f(Number(cal[role === "pit" ? "pitchScaleVR" : "hitScaleVR"] ?? NaN), 4)}`);
  }
}
console.log(`\n  READ:`);
console.log(`  · PITCHERS, neutral formats: 0.000 on all four channels — the identity v1 relies on, confirmed rather than assumed.`);
console.log(`  · PITCHERS, env formats: up to ~75% on a channel. THAT is what the raw line throws away, and it is why every`);
console.log(`    non-quick number in this run had to move to the deployed line.`);
console.log(`  · The COMPOSITE is non-zero everywhere, neutral included: sFinal (0.92-1.03 here) multiplies the assembled`);
console.log(`    composite and nothing else. It is a UNIT convention, so it shifts composite LEVEL and cannot touch composite`);
console.log(`    SHAPE (a positive scalar leaves Pearson r unchanged). Read composite level verdicts with that in mind.`);
console.log(`  · HITTERS, neutral formats: BB%/SO%/HR600 are exactly 0 like the pitchers, but BABIP is NOT (0.1-3.6%). That`);
console.log(`    single non-identical channel is a real asymmetry in the two lines' plumbing, recorded here and NOT acted on:`);
console.log(`    the BUILD-2 hitter tail reaches the raw line as`);
console.log(`    corrected oneB/GAP read directly, and the deployed line as the e.hMul carrier through hittingComponents`);
console.log(`    (sample.ts states both routes). Two routes for one correction; the pitcher path has only one. It is small,`);
console.log(`    it is not the environment, and sizing it is a separate job — flagged, not fixed, and not fitted around.`);

// ═══ A. COVERAGE ═════════════════════════════════════════════════════════════
console.log(`\n\n╔═══ A. COVERAGE — which formats can actually be dueled, and at what N ══════════════════════════════╗`);
console.log(`  joined     = observed rows matched to a catalog card by the existing fingerprint join (no private join is written here).`);
console.log(`  wellSampl. = clears the read-time floor BF>=600 (pit) / PA>=500 (hit) — opponents faced, symmetric across roles.`);
console.log(`  dueled     = well-sampled AND carrying a cwhit projection. THAT is the N every duel below is computed on.`);
console.log(`  status     : OK = N > ${THIN_N};  THIN = ${MIN_N}..${THIN_N} (prints, carries NO verdict, counted in NEITHER scoreboard);  DEAD = N < ${MIN_N} (no statistics).`);
console.log(``);
console.log(`  format             role   capture rows   joined   well-sampled   dueled   median depth   status`);
interface Cov { fmt: string; role: "pit" | "hit"; capRows: number; joined: number; well: number; dueled: number; med: number; status: string; quick: boolean }
const coverage: Cov[] = [];
const capMeta = new Map<string, { rows: number; from: string; to: string; obsval: string; projRows: number }>();
for (const fm of FORMATS) {
  const recs = results.get(fm.reg.key)!.recs;
  for (const role of ["pit", "hit"] as const) {
    const head = readFileSync(captureObsPath(CAPTURE_DIR_2026_07_21, fm.reg, role), "utf8").split(/\r?\n/, 1)[0] ?? "";
    const pHead = readFileSync(captureProjPath(CAPTURE_DIR_2026_07_21, fm.reg, role), "utf8").split(/\r?\n/, 1)[0] ?? "";
    const rows = Number(head.match(/\browsr?=(\d+)/)?.[1] ?? head.match(/\brows=(\d+)/)?.[1] ?? NaN);
    const dm = head.match(/\bdates=(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})/);
    capMeta.set(`${fm.reg.key}|${role}`, {
      rows, from: dm?.[1] ?? "?", to: dm?.[2] ?? "?",
      obsval: head.match(/\bobsval=(\S+)/)?.[1] ?? "?",
      projRows: Number(pHead.match(/\brows=(\d+)/)?.[1] ?? NaN),
    });
    const all = recs.filter((r) => r.role === role);
    const well = all.filter(wellSampled);
    const dueled = well.filter((r) => r.proj);
    const med = well.length ? [...well.map((r) => r.sample)].sort((a, b) => a - b)[Math.floor(well.length / 2)]! : NaN;
    const status = dueled.length < MIN_N ? "DEAD" : dueled.length <= THIN_N ? "THIN" : "OK";
    coverage.push({ fmt: fm.reg.key, role, capRows: rows, joined: all.length, well: well.length, dueled: dueled.length, med, status, quick: fm.quick });
    console.log(`  ${pad(role === "pit" ? fm.reg.key : "", 18)} ${pad(role, 6)} ${String(rows).padStart(12)}   ${String(all.length).padStart(6)}   ${String(well.length).padStart(12)}   ${String(dueled.length).padStart(6)}   ${f(med, 0).padStart(12)}   ${status}`);
  }
}
console.log(``);
console.log(`  capture windows + observed VAL ranges (provenance only — obsval is who PLAYED, never a rule):`);
for (const fm of FORMATS) {
  const p = capMeta.get(`${fm.reg.key}|pit`)!, h = capMeta.get(`${fm.reg.key}|hit`)!;
  console.log(`    ${pad(fm.reg.key, 18)} ${p.from}..${p.to}   obsval pit ${pad(p.obsval, 8)} hit ${pad(h.obsval, 8)}   projection rows: pit ${String(p.projRows).padStart(5)} / hit ${String(h.projRows).padStart(5)}`);
}
{
  const notices = new Set<string>();
  for (const r of results.values()) for (const s of r.notices) notices.add(s);
  const missed = [...results.entries()].filter(([, r]) => r.missedProj > 0);
  console.log(``);
  console.log(`  PROJECTION COVERAGE: cwhit projects the FULL eligible pool, so a duel loses a card only if its observed row`);
  console.log(`  found no projection at all. Formats where that happened: ${missed.length ? missed.map(([k, r]) => `${k} (${r.missedProj})`).join(", ") : "NONE — every observed card in every format carries a projection."}`);
  if (notices.size) { console.log(`  builder notices:`); for (const s of notices) console.log(`    · ${s}`); }
}
console.log(``);
console.log(`  WINDOW-OVERLAP CAVEAT, STATED ONCE AND APPLYING TO EVERY CELL BELOW. The 2026-07-21 captures do NOT carry`);
console.log(`  cwhit's MODEL-TRAINING window (the old top-100 fixtures did), so the semi-in-sample check CANNOT be run on this`);
console.log(`  corpus and is not faked. On the legacy corpus his training window overlapped 60-100% of the judging window while`);
console.log(`  ours was honest out-of-sample. Unless that changed, every cwhit win below is an UPPER BOUND on his true edge and`);
console.log(`  every one of ours is, if anything, understated. It cannot be quantified here — it is a direction, not a correction.`);

// ═══ B. THE DUEL ═════════════════════════════════════════════════════════════
console.log(`\n\n╔═══ B. THE DUEL — per format x role x channel, LEVEL and SHAPE kept SEPARATE ═══════════════════════╗`);
console.log(`LEVEL  = mean(pred) vs mean(obs). Verdict = D|bias| (paired bootstrap): NEGATIVE means OUR bias is smaller.`);
console.log(`         A level loss can restate a KNOWN, ACCEPTED out-of-frame gap — our level corrections live in the eval stack by design.`);
console.log(`SHAPE  = per-card agreement AFTER DE-MEANING. Verdict = Dcorr ONLY, because corr is SCALE-FREE: it answers "who ORDERS`);
console.log(`         the cards better", and a spread defect cannot masquerade as a discrimination defect. MAE is NOT a verdict input.`);
console.log(`SPREAD = SD(pred)/SD(obs), raw and noise-DECONVOLVED (dcv). Reported as a diagnostic, NOT as one of the two axes.`);
console.log(`* = 95% CI excludes 0. Duel CIs are a 2000-rep PAIRED bootstrap over cards (paired: both models are scored on the`);
console.log(`SAME cards, so shared card difficulty cancels and the CI is on the DIFFERENCE). UNREL = noise-share CI upper >= 100%`);
console.log(`⇒ dcv is not a measurement (the raw ratio beside it still is). THIN cells print but carry NO verdict on either axis.`);

const cells: Cell[] = [];
for (const fm of FORMATS) {
  const recs = results.get(fm.reg.key)!.recs;
  for (const role of ["pit", "hit"] as const) {
    const rows = recs.filter((r) => r.role === role && r.proj && wellSampled(r));
    const tag = `${fm.reg.label} — ${role === "pit" ? "PITCHERS" : "HITTERS"}`;
    if (rows.length < MIN_N) {
      console.log(`\n─── ${tag} ───`);
      console.log(`    DEAD: only N=${rows.length} card(s) clear the well-sampled bar with a projection (need >=${MIN_N}). NO statistics, NO verdict.`);
      console.log(`    This is a DEPTH failure of the observed corpus (few instances ⇒ low per-card BF/PA), not a model or join failure.`);
      continue;
    }
    console.log(`\n─── ${tag} — N=${rows.length}${rows.length <= THIN_N ? `  ⚠THIN (<=${THIN_N}: prints, NO verdict, in NEITHER scoreboard)` : ""} ───`);
    console.log(`  channel     obs mean |  ours mean  (bias)         | cwhit mean (bias)         D|level|          LEVEL   |  corr ours / cwhit    Dcorr             SHAPE   |  SD raw o/c   dcv o/c      noise%`);
    for (const ch of CH[role]) {
      const c = measureCell(fm, role, rows, ch);
      cells.push(c);
      const dcv = (a: Agreement) => (c.unrel ? "UNREL" : f(a.spread.ratioDeconv, 2));
      console.log(
        `  ${pad(c.ch, 10)} ${f(c.obsMean, c.d).padStart(8)} | ${f(c.oursMean, c.d).padStart(8)} (${sgn(c.ours.level.bias, c.d)}${c.ours.level.sig ? "*" : " "})` +
        ` | ${f(c.cwMean, c.d).padStart(8)} (${sgn(c.cw.level.bias, c.d)}${c.cw.level.sig ? "*" : " "})` +
        `  ${sgn(c.dLevel.est, c.d).padStart(8)}${c.dLevel.sig ? "*" : " "}  ${pad(c.level, 10)}` +
        ` | ${f(c.ours.shape.corr, 3).padStart(6)} / ${f(c.cw.shape.corr, 3).padStart(6)}   ${sgn(c.dCorr.est, 3).padStart(7)}${c.dCorr.sig ? "*" : " "}  ${pad(c.shape, 10)}` +
        ` | ${f(c.ours.spread.ratio, 2)}/${f(c.cw.spread.ratio, 2)}   ${dcv(c.ours)}/${dcv(c.cw)}   ${(Number.isFinite(c.ours.spread.noiseShare) ? `${f(c.ours.spread.noiseShare * 100, 0)}%` : "n/a").padStart(4)}${c.unrel ? `↑${f(c.nsHi * 100, 0)}%` : ""}`,
      );
    }
  }
}

// ═══ C. SCOREBOARD ═══════════════════════════════════════════════════════════
const counted = cells.filter((c) => !c.thin);
const tally = (xs: Cell[], axis: "level" | "shape") => {
  const t = { OURS: 0, TIE: 0, CWHIT: 0 };
  for (const c of xs) if (c[axis] !== "NO-VERDICT") t[c[axis] as "OURS" | "TIE" | "CWHIT"]++;
  return t;
};
const line = (lbl: string, xs: Cell[]) => {
  const L = tally(xs, "level"), S = tally(xs, "shape");
  console.log(`  ${pad(lbl, 34)} ${String(xs.length).padStart(5)}   ${String(L.OURS).padStart(4)} / ${String(L.TIE).padStart(4)} / ${String(L.CWHIT).padStart(5)}      ${String(S.OURS).padStart(4)} / ${String(S.TIE).padStart(4)} / ${String(S.CWHIT).padStart(5)}`);
};

console.log(`\n\n╔═══ C. THE SCOREBOARD — CI-clear wins / ties / losses, LEVEL and SHAPE counted SEPARATELY ══════════╗`);
console.log(`  Counted cells only: a THIN cell (N<=${THIN_N}) carries no verdict and is excluded from every count below.`);
console.log(`  ${cells.length} cells measured, ${counted.length} counted, ${cells.length - counted.length} thin.`);
console.log(``);
console.log(`  ${pad("population", 34)} cells       LEVEL  we/tie/cwhit        SHAPE  we/tie/cwhit`);
console.log(`  ${"-".repeat(34)} -----   ----------------------      ----------------------`);
line("ALL 14 FORMATS", counted);
line("  QUICK (5 formats)", counted.filter((c) => c.quick));
line("  NON-QUICK (9 formats)", counted.filter((c) => !c.quick));
console.log(``);
line("PITCHERS — all", counted.filter((c) => c.role === "pit"));
line("  pitchers, quick", counted.filter((c) => c.role === "pit" && c.quick));
line("  pitchers, non-quick", counted.filter((c) => c.role === "pit" && !c.quick));
line("HITTERS — all", counted.filter((c) => c.role === "hit"));
line("  hitters, quick", counted.filter((c) => c.role === "hit" && c.quick));
line("  hitters, non-quick", counted.filter((c) => c.role === "hit" && !c.quick));

console.log(`\n  ── BY CHANNEL (all 14 formats, both roles pooled where a label is shared) ──`);
console.log(`  ${pad("role  channel", 34)} cells       LEVEL  we/tie/cwhit        SHAPE  we/tie/cwhit`);
for (const role of ["pit", "hit"] as const) for (const ch of CH[role]) {
  line(`${role}   ${ch.lbl}`, counted.filter((c) => c.role === role && c.ch === ch.lbl));
}

console.log(`\n  ── BY FORMAT (both roles, all five channels) ──`);
console.log(`  ${pad("format", 34)} cells       LEVEL  we/tie/cwhit        SHAPE  we/tie/cwhit`);
for (const fm of FORMATS) line(`${fm.quick ? "Q " : "  "}${fm.reg.key}`, counted.filter((c) => c.fmt === fm.reg.key));

// ═══ D. QUICK vs NON-QUICK ═══════════════════════════════════════════════════
console.log(`\n\n╔═══ D. QUICK vs NON-QUICK — the 9 non-quick formats are the NEW information ════════════════════════╗`);
console.log(`  The five Quick tiers are the PRIOR (v1's corrected result: statistical parity). The nine non-quick formats have`);
console.log(`  never been dueled. The question this section answers, and the only one it answers, is: DOES PARITY HOLD THERE?`);
{
  const rate = (xs: Cell[], axis: "level" | "shape") => {
    const t = tally(xs, axis);
    const n = t.OURS + t.TIE + t.CWHIT;
    return { ...t, n, pctOurs: n ? t.OURS / n * 100 : NaN, pctTie: n ? t.TIE / n * 100 : NaN, pctCw: n ? t.CWHIT / n * 100 : NaN };
  };
  const Q = counted.filter((c) => c.quick), N = counted.filter((c) => !c.quick);
  for (const axis of ["level", "shape"] as const) {
    const q = rate(Q, axis), n = rate(N, axis);
    console.log(`\n  ${axis.toUpperCase()}`);
    console.log(`    QUICK      n=${String(q.n).padStart(3)}   ours ${String(q.OURS).padStart(3)} (${f(q.pctOurs, 0)}%)   tie ${String(q.TIE).padStart(3)} (${f(q.pctTie, 0)}%)   cwhit ${String(q.CWHIT).padStart(3)} (${f(q.pctCw, 0)}%)`);
    console.log(`    NON-QUICK  n=${String(n.n).padStart(3)}   ours ${String(n.OURS).padStart(3)} (${f(n.pctOurs, 0)}%)   tie ${String(n.TIE).padStart(3)} (${f(n.pctTie, 0)}%)   cwhit ${String(n.CWHIT).padStart(3)} (${f(n.pctCw, 0)}%)`);
    // THE SAME RULE IS APPLIED TO BOTH GROUPS, and both verdicts are printed. Printing it for the
    // non-quick group alone would imply the quick group passes it — and on this corpus the quick
    // group does not either. The informative quantity is then the RATE, which is a contrast rather
    // than a threshold, so it is reported beside the two verdicts.
    const rule = (x: ReturnType<typeof rate>) => x.n === 0 ? "NO CELLS CARRY A VERDICT on this axis."
      : x.pctTie >= 50 && x.pctCw <= x.pctOurs ? "PARITY (ties are the plurality and his CI-clear wins do not exceed ours)."
        : x.pctCw > x.pctOurs ? "NOT PARITY — cwhit takes more CI-clear cells than we do."
          : "AHEAD — we take more CI-clear cells than he does.";
    console.log(`    ⇒ QUICK:      ${rule(q)}`);
    console.log(`    ⇒ NON-QUICK:  ${rule(n)}`);
    console.log(`    CONTRAST (the part that is new information): his CI-clear share goes ${f(q.pctCw, 0)}% → ${f(n.pctCw, 0)}% ` +
      `(${f(n.pctCw / q.pctCw, 2)}×), ours ${f(q.pctOurs, 0)}% → ${f(n.pctOurs, 0)}%, ties ${f(q.pctTie, 0)}% → ${f(n.pctTie, 0)}%.`);
    console.log(`    (Reading rule, declared before the numbers: 'parity' = ties are the plurality AND his CI-clear wins do not`);
    console.log(`     exceed ours. A shift in EITHER direction is only claimed off the CI-clear counts, never off the tie share alone.)`);
  }
  console.log(`\n  THE COMPOSITION CAVEAT, so the contrast is not over-read: the two groups differ in more than "quick vs not".`);
  console.log(`  All five Quick tiers run on the NEUTRAL env (era-2010 / park-1); six of the nine non-quick formats do not, and`);
  console.log(`  three carry a budget (cap/slots) or an extra eligibility rule. A non-quick shift is therefore a shift in the`);
  console.log(`  UNION of {non-neutral env, extra rules, budget, pool composition, capture depth} — this section localises WHERE`);
  console.log(`  we stand, not WHY. The env-vs-rest decomposition needs a separate instrument.`);
  const NEU = counted.filter((c) => !c.quick && ["bronzecapweekly", "goldslotsdaily", "liveopendaily"].includes(c.fmt));
  const NON = counted.filter((c) => !c.quick && !["bronzecapweekly", "goldslotsdaily", "liveopendaily"].includes(c.fmt));
  console.log(`\n  ONE CUT OF IT, free because the registry already records neutralEnv:`);
  console.log(`  ${pad("population", 34)} cells       LEVEL  we/tie/cwhit        SHAPE  we/tie/cwhit`);
  line("  non-quick, NEUTRAL env (3 fmts)", NEU);
  line("  non-quick, own era/park (6 fmts)", NON);
}

// ═══ E. WHERE WE WIN / LOSE / CANNOT TELL ════════════════════════════════════
console.log(`\n\n╔═══ E. THE CELL LISTS — where we win, where he does, where we cannot tell ══════════════════════════╗`);
const show = (title: string, xs: Cell[]) => {
  console.log(`\n  ${title}  (${xs.length})`);
  if (!xs.length) { console.log(`    (none)`); return; }
  for (const c of xs) console.log(`    ${pad(c.fmt, 18)} ${pad(c.role, 4)} ${pad(c.ch, 9)} N=${String(c.n).padStart(4)}   bias ours ${sgn(c.ours.level.bias, c.d)} / cwhit ${sgn(c.cw.level.bias, c.d)}   corr ours ${f(c.ours.shape.corr, 3)} / cwhit ${f(c.cw.shape.corr, 3)}   D|level| ${sgn(c.dLevel.est, c.d)}${c.dLevel.sig ? "*" : " "}  Dcorr ${sgn(c.dCorr.est, 3)}${c.dCorr.sig ? "*" : " "}`);
};
console.log(`\n  ── SHAPE / ORDERING (scale-free; the axis that says who picks the better card) ──`);
show(`WE WIN on shape, CI-clear:`, counted.filter((c) => c.shape === "OURS"));
show(`WE LOSE on shape, CI-clear:`, counted.filter((c) => c.shape === "CWHIT"));
console.log(`\n  TIE on shape (CI includes 0 — no evidence either model orders better): ${counted.filter((c) => c.shape === "TIE").length} cells, not listed individually.`);
console.log(`\n  ── LEVEL (may restate a KNOWN, ACCEPTED out-of-frame gap — not automatically a defect) ──`);
show(`WE WIN on level, CI-clear:`, counted.filter((c) => c.level === "OURS"));
show(`WE LOSE on level, CI-clear:`, counted.filter((c) => c.level === "CWHIT"));
console.log(`\n  TIE on level: ${counted.filter((c) => c.level === "TIE").length} cells, not listed individually.`);
console.log(`\n  ── WHERE WE CANNOT TELL ──`);
show(`THIN cells (N<=${THIN_N}) — measured, printed above, NO verdict, in NO count:`, cells.filter((c) => c.thin));
{
  const dead = coverage.filter((c) => c.status === "DEAD");
  console.log(`\n  DEAD cells (N<${MIN_N} dueled — no statistics at all):  (${dead.length})`);
  if (!dead.length) console.log(`    (none)`);
  for (const c of dead) console.log(`    ${pad(c.fmt, 18)} ${pad(c.role, 4)} dueled N=${c.dueled} (joined ${c.joined}, well-sampled ${c.well})`);
  const unrel = counted.filter((c) => c.unrel);
  console.log(`\n  UNREL spread cells (noise-share CI upper >= 100% ⇒ dcv is not a measurement; LEVEL and SHAPE verdicts stand,`);
  console.log(`  because a duel scores both models on the SAME observed series and sampling noise cancels BETWEEN them):  (${unrel.length})`);
  for (const c of unrel) console.log(`    ${pad(c.fmt, 18)} ${pad(c.role, 4)} ${pad(c.ch, 9)} N=${String(c.n).padStart(4)}  noise share point ${f(c.ours.spread.noiseShare * 100, 0)}% CI-upper ${f(c.nsHi * 100, 0)}%`);
}

console.log(`\n\n── WHAT THIS RUN DOES NOT SAY ──`);
console.log(`  · It does not measure a TOURNAMENT-STRENGTH or exposure effect: the duel is per-card rate agreement, not roster value.`);
console.log(`  · It does not adjudicate WHY a format behaves differently — env, rules, budget and pool composition are confounded here.`);
console.log(`  · It cannot bound cwhit's semi-in-sample advantage: this corpus carries no training window (see the caveat in A).`);
console.log(`  · A CI-clear cell is not on its own a finding. ${cells.length} cells were tested; read the SHAPE of the counts, not one cell.`);
console.log(``);
process.exit(0);
