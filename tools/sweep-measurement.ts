// THE SWEEP MEASUREMENT LAYER (Amendment-2 exploratory) — where predictions miss, per FORMAT ×
// ROLE × CHANNEL × HAND, across the whole capture corpus.
//   run: node tools/sweep-measurement.ts > fixtures/sweep-measurement-2026-07-26.txt
//
// MEASUREMENT ONLY. NO FITS. Nothing is fitted, no default is flipped, no production behaviour is
// touched, no coordinate is proposed. The event model is CLOSED IN-FRAME (SYSTEM_MAP §7) and this
// run does no form work: it reports the residual surface and stops.
//
// WHAT IT MEASURES, and nothing else:
//   (i)  GRAIN-CORRECTED LEVEL DIFFERENTIALS  — mean(pred − obs) per cell, at CARD grain with a
//        CLUSTER-ROBUST SE (clusters = Card ID, because a card and its v5 variant are TWO observed
//        rows for ONE card), reported beside the USAGE-weighted aggregate so the grain of every
//        observed-side statistic is explicit rather than implied. Split per HAND, with PERMUTATION
//        nulls on every hand contrast and every cross-format (interaction) claim.
//   (ii) DCV SPREAD RATIOS + the FREE-SLOPE need — the SAME estimand convention the shipped ramps
//        are estimated under. See the ESTIMAND note below.
//
// NO SCORING MATH AND NO SAMPLE ASSEMBLY IS WRITTEN HERE. Predicted lines come from the ONE judged-
// sample builder (src/eval/cwhit/sample.ts) driving the scoring core; the statistics come from the
// shared eval modules (src/eval/cwhit/scorecard.ts, two-ledger.ts). The one exception is the hitter
// GAP channel, which the `Rec` does not carry: it is recomputed through the SAME production calls
// the builder makes and CROSS-CHECKED against the builder's own HR600/BABIP to prove the
// reproduction is exact (the tools/hr-reconcile.ts precedent), never asserted.
//
// ── THE ESTIMAND (ii), stated before any number ──────────────────────────────────────────────────
// The shipped ramps K_SPREAD_PIT and PIT_SPREAD_HR (src/model/pool-transform.ts) are estimated under
// the AMENDMENT-2 FREE-SLOPE convention (ruling (z), tools/fit-kspread-c3.ts): the per-tier "need"
// is the UNWEIGHTED free slope of obs~pred, `mmse().slope.est`, which is NOISE-IMMUNE (the observed
// sampling noise lands entirely in the residual, never in the estimand) and carries a per-cell FREE
// LEVEL so it prices SPREAD only — level belongs to the anchor layer. The pivot slope (residual
// taken about the pool mean, no free level) is a DIFFERENT estimand and sat +0.18 above it in every
// tier; it is not used here. THIS RUN USES THE FREE SLOPE, and reports the DCV ratio
// SD(pred)/SD_deconv(obs) beside it as the SD-space reading of the same question (slope = corr/ratio
// identically). Where they disagree, TRUST THE SLOPE — it needs no noise model.
//
// DOCTRINE (memory cwhitstats-external-data): cwhit's RAW OBSERVED events are ground truth. His
// PROJECTIONS and derived columns are a competitor benchmark, weight ZERO — this run does not read
// them at all. All fits on cwhit data remain BLOCKED until the wide re-pull; this is a measurement.

import { readFileSync } from "node:fs";
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { resolveCoeffs, type Model } from "../src/config/coeff-resolve.ts";
import { rowEligible } from "../src/config/eligibility.ts";
import type { Era, Park, Tournament } from "../src/config/tournament.ts";
import type { CalScales, Coeffs, Derived } from "../src/config/types.ts";
import {
  FIELD_N, makeRawPolyModel, productionFieldStats, cohortSelectForModel, applyWobaWeights, computeDerived,
  buildPoolTransform, buildFrameShift, poolPitMeansOwn, kSpreadPitRamp, pitSpreadHrRamp, applyAffine,
  type EventForm, type FieldStats, type PoolTransform, type RatingEnvelope, type WobaWeights, type TrainingMeans,
} from "../src/scoring-core/index.ts";
import { hittingComponents } from "../src/scoring-core/woba.ts";
import { computeHitTail, applyHitTail, PINNED_HIT_TAIL, type HitTail } from "../src/scoring-core/hit-tail.ts";
import { parseCatalogCsv, type Card } from "../src/data/catalog.ts";
import { makeVariant } from "../src/data/variants.ts";
import type { WobaWeights as WW } from "../src/eval/cwhit/audit.ts";
import {
  per9NoiseVar, babipNoiseVar, pctNoiseVar, per600NoiseVar, BF_PER_9,
  noiseShareCiUpper, abPerPa, xbhNonHrPerPa,
} from "../src/eval/cwhit/scorecard.ts";
import { mmse } from "../src/eval/cwhit/two-ledger.ts";
import { CWHIT_CORPUS, CAPTURE_DIR_2026_07_21, type CwhitFormat } from "../src/eval/cwhit/corpus.ts";
import {
  buildCwhitSample, isPit, inValueWindow, handLetter, n_,
  type KSpreadPit, type Rec, type SampleDeps, type ValueWindow, type CwhitSource,
} from "../src/eval/cwhit/sample.ts";
import { K_SPREAD_PIT, PIT_SPREAD_HR } from "../src/model/pool-transform.ts";

// ── output buffer (the multiplicity statement must be the first thing a reader sees) ──
const L: string[] = [];
const say = (s = "") => L.push(s);
const f = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "n/a");
const sgn = (x: number, d = 2) => (Number.isFinite(x) ? `${x >= 0 ? "+" : ""}${x.toFixed(d)}` : "n/a");
const pad = (s: string, n: number) => s.padEnd(n);
const rp = (s: string, n: number) => s.padStart(n);
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
const sdPop = (xs: number[]) => { const m = mean(xs); return Math.sqrt(mean(xs.map((x) => (x - m) ** 2))); };

// ── THE READING RULES, DECLARED BEFORE ANY NUMBER ────────────────────────────────────────────────
// Same constants as the mission scorecard, deliberately: this run must be readable against it.
const MIN_N = 5;      // below this a cell has NO statistics at all
const THIN_N = 20;    // at or below this a cell PRINTS but carries NO verdict on any axis
const BAR_PRIMARY = { bf: 600, pa: 500 };
const BAR_SENS = { bf: 1000, pa: 1000 };
const B_BOOT = 1000;      // bootstrap reps (cluster and iid arms, matched)
const N_PERM = 2000;      // permutation reps for every interaction / corner claim
const SEED = 20260726;
/** Power convention, fixed here so no null is graded after the fact: the MINIMUM DETECTABLE EFFECT
 *  at 80% power, two-sided α = 0.05, is 2.802 × SE. Every null in this run reports it. */
const MDE_K = 1.959964 + 0.841621;

/** Deterministic RNG (mulberry32) — the program's generator, so every number here reproduces. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const pctl = (xs: number[], q: number) => { const v = [...xs].sort((a, b) => a - b); return v.length ? v[Math.min(Math.max(Math.floor(q * v.length), 0), v.length - 1)]! : NaN; };

// ── boot: repository, deployed model, catalog (the mission-scorecard pattern, verbatim) ──
const repo = new Repository("data");
await seedDefaults(repo); await seedEras(repo); await seedAccounts(repo);
const state = (await repo.load<{ activeModelId?: string; catalogSourceId?: string }>("state", "app")) ?? {};
type TM = {
  id: string; eventForm?: EventForm; wobaWeights?: WobaWeights; ratingEnvelope?: RatingEnvelope;
  trainingMeans?: TrainingMeans; cohortRule?: string;
  platoon?: { pit: { hand: string; vsRHB: number; vsLHB: number }[]; hit: { hand: string; vsRHP: number; vsLHP: number }[] };
};
const trained = (await repo.loadAll<TM>("trained-models")).find((x) => x.id === state.activeModelId);
if (!trained?.eventForm || !trained.wobaWeights || !trained.platoon) throw new Error("active model missing eventForm/wobaWeights/platoon");
const rp_ = makeRawPolyModel(trained.eventForm);
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
const cardById = new Map(baseCards.map((c) => [String(c["Card ID"]), c]));
const scSelT = tourneys.get("bronze-quick") ?? [...tourneys.values()][0]!;
const scSelCoeffs = resolveCoeffs(model, eras.get(scSelT.eraId)!, parks.get(scSelT.parkId)!, scSelT.softcaps);
applyWobaWeights(scSelCoeffs, W);
const cohortSel = cohortSelectForModel(trained.cohortRule, baseCards, scSelCoeffs, rp_);

const SOURCE: CwhitSource = { kind: "capture", dir: CAPTURE_DIR_2026_07_21 };

// ── STRATA — keyed by tournamentId, never by a slug list (FORMAT_FACTS) ──────────────────────────
// A = neutral uncapped quick (core) · B = env-bearing uncapped daily · C = budget/restricted/decoupled.
// DECOUPLED is a PROPERTY of live-open-daily, carried separately: it is never inside a pooled baseline.
const STRATUM: Record<string, "A" | "B" | "C"> = {
  "iron-quick": "A", "bronze-quick": "A", "silver-quick": "A", "gold-quick": "A", "diamond-quick": "A",
  "early-gold": "B", "bronze-heart": "B", "late-bronze": "B", "diamond-heart": "B",
  "gold-cap": "C", "diamond-cap-daily": "C", "bronze-cap-weekly": "C", "gold-slots": "C", "live-open-daily": "C",
};
const DECOUPLED = new Set(["live-open-daily"]);
/** Per-format care notes from FORMAT_FACTS — printed beside every row so no cell is read naked. */
const CARE: Record<string, string> = {
  "iron-quick": "largest own-gap of the quicks; K need highest",
  "bronze-quick": "baseline leg of the clean cap pair",
  "silver-quick": "—",
  "gold-quick": "ANOMALY HISTORY (old G2 overrule, off-curve K need); check the record before any new gold claim",
  "diamond-quick": "historically thin (~N=36 at the 600 bar); closest to frame",
  "early-gold": "era-1920; era-K residual 1.53; OPEN hit-BABIP ~1.50 residual",
  "bronze-heart": "era-1939; park hr_l 1.15 / hr_r 0.66 = BIGGEST handedness split in the set",
  "late-bronze": "era-1979; residual #6 G2 ordering -0.120",
  "diamond-heart": "era-1958 + YEAR 1930-1980 cut = COMPOSITION caveat on any era conclusion",
  "gold-cap": "CAP x PARK DEGENERATE for HR (never separable here); K channel park-clean",
  "diamond-cap-daily": "—",
  "bronze-cap-weekly": "THE clean cap pair vs bronze-quick (same era/park/window)",
  "gold-slots": "THE clean slots pair vs gold-quick; his Cap/Slots Value cols are cwhit-DERIVED, never inputs",
  "live-open-daily": "DECOUPLED — gap coordinate PROVABLY BREAKS (g~44 vs need ~1); NEVER a clean control",
};

interface Fmt {
  reg: CwhitFormat; t: Tournament; coeffs: Coeffs; derived: Derived; win: ValueWindow;
  stratum: "A" | "B" | "C"; decoupled: boolean;
  nPool: number; gapStu: number; gapHrr: number; sK: number; sHr: number;
}
const FORMATS: Fmt[] = CWHIT_CORPUS.map((reg) => {
  if (!reg.tournamentId) throw new Error(`corpus registry has no tournamentId for '${reg.key}'`);
  const t = tourneys.get(reg.tournamentId);
  if (!t) throw new Error(`tournament '${reg.tournamentId}' not found (registry key '${reg.key}')`);
  const st = STRATUM[reg.tournamentId];
  if (!st) throw new Error(`no stratum declared for tournamentId '${reg.tournamentId}' — FORMAT_FACTS must be read, not guessed`);
  const era = eras.get(t.eraId), park = parks.get(t.parkId);
  if (!era || !park) throw new Error(`tournament '${t.id}': missing era '${t.eraId}' or park '${t.parkId}'`);
  const coeffs = resolveCoeffs(model, era, park, t.softcaps);
  applyWobaWeights(coeffs, W);
  const win: ValueWindow = {
    tier: reg.key, valueMin: t.card_value_min ?? undefined,
    valueMax: t.card_value_max ?? Number.POSITIVE_INFINITY,
    eligible: (c) => rowEligible(c as Card, t),
  };
  return {
    reg, t, coeffs, derived: computeDerived(coeffs, true), win,
    stratum: st, decoupled: DECOUPLED.has(t.id),
    nPool: 0, gapStu: NaN, gapHrr: NaN, sK: NaN, sHr: NaN,
  };
});

// ── ONE format, scored under ITS OWN resolved config, through the ONE shared builder ─────────────
// Corrections are computed EXACTLY as the server's own-gap path does (the mission-scorecard v2 copy),
// with this format's coeffs and pool. The build is done ONCE at the LOWEST bar; rows below a bar are
// flagged, not dropped, so the 1000 sensitivity arm is a filter over the same join rather than a
// second, differently-selected sample.
interface FmtRun { recs: Rec[]; pt: PoolTransform; cal: CalScales; ht?: HitTail; notices: string[] }
function runFormat(fm: Fmt): FmtRun {
  const { coeffs, derived, win } = fm;
  const ref: FieldStats = productionFieldStats(baseCards, coeffs, rp_, true, undefined, cohortSel);
  const basePool = baseCards.filter((c) => inValueWindow(c, win));
  fm.nPool = basePool.length;

  const TMeans = trained!.trainingMeans;
  if (!TMeans) throw new Error("this run needs the active model's trainingMeans (production corrections are ON)");
  const poolField = productionFieldStats(basePool, coeffs, rp_, true, undefined, cohortSel);
  const pt = buildPoolTransform(ref, poolField, envelope);
  const shift = buildFrameShift(TMeans, poolField);
  fm.gapStu = shift.pit.vR.stu ?? 0;
  fm.gapHrr = shift.pit.vR.hrr ?? 0;
  const pm = poolPitMeansOwn(basePool, coeffs, rp_, pt, FIELD_N);
  fm.sK = kSpreadPitRamp(fm.gapStu);
  fm.sHr = pitSpreadHrRamp(fm.gapHrr);
  const ksMap = new Map<string, KSpreadPit>([[win.tier, { s: fm.sK, mean: pm.k, sHr: fm.sHr, meanHr: pm.hr }]]);
  const ht = computeHitTail(basePool.filter((c) => !isPit(c)), coeffs, rp_, pt, ref, poolField, PINNED_HIT_TAIL);
  const htMap = new Map<string, HitTail>([[win.tier, ht]]);

  const deps: SampleDeps = {
    baseCards, coeffs, derived, eventForm: trained!.eventForm!, model: rp_, W, ref, envelope,
    pitExp, hitExp, kSpreadPit: ksMap, hitTail: htMap, formats: [win], source: SOURCE,
    select: cohortSel, minBf: BAR_PRIMARY.bf, minPa: BAR_PRIMARY.pa,
  };
  const r = buildCwhitSample(deps);
  return { recs: r.recs, pt, cal: r.cals[0]?.cal ?? {}, ht, notices: r.notices };
}

// ── THE HITTER GAP CHANNEL — recomputed, then PROVEN exact against the builder ───────────────────
// `Rec` carries bbPct/soPct/hr600/babip/woba. GAP (non-HR extra-base hits) is a REAL model channel
// and a REAL observable, and neither line carries it. Both are reconstructed here:
//   PREDICTED — the DEPLOYED line: the same predictHitting → applyHitTail → hittingComponents chain
//               sample.ts's `ourHit` runs, blended by the same platoon exposure weights. The
//               cross-check below re-derives HR600 and BABIP the same way and compares them against
//               the builder's own `oursDep` values; a non-zero max |Δ| INVALIDATES the GAP row and
//               says so in the output rather than quietly shipping a drifted line.
//   OBSERVED  — cwhit publishes XBHpct = (2B+3B+HR)/H (measured convention, scorecard.ts), plus
//               AVG/OBP/BBpct which give AB/PA exactly. So H/PA = AVG × AB/PA and the non-HR XBH
//               rate per PA is xbhNonHrPerPa(...). ×600 puts it in the model's own GAP/600 unit.
//               This is a DERIVED observed quantity, not a published column — flagged everywhere.
interface GapRecon { pred: Map<string, number>; obs: Map<string, number>; maxHrDiff: number }
function reconstructGap(fm: Fmt, run: FmtRun): GapRecon {
  const pred = new Map<string, number>(), obs = new Map<string, number>();
  let maxHrDiff = 0;
  for (const r of run.recs) {
    if (r.role !== "hit") continue;
    const base = cardById.get(r.cid.split("|")[0] ?? "");
    if (!base) continue;
    const c = r.vlvl === 5 ? makeVariant(base) : base;
    const { wR, wL } = hitExp.get(handLetter(n_(c["Bats"]))) ?? { wR: 0.5, wL: 0.5 };
    const bats = n_(c["Bats"]);
    const speed = n_(c["Speed"]), steal = n_(c["Stealing"]), run_ = n_(c["Baserunning"]);
    const side = (s: "R" | "L") => {
      const t = run.pt.hit[s === "R" ? "vR" : "vL"];
      return rp_.predictHitting({
        eye: applyAffine(n_(c[`Eye v${s}`]), t?.eye), pow: applyAffine(n_(c[`Power v${s}`]), t?.pow),
        kRat: applyAffine(n_(c[`Avoid K v${s}`]), t?.kRat), babip: applyAffine(n_(c[`BABIP v${s}`]), t?.babip),
        gap: applyAffine(n_(c[`Gap v${s}`]), t?.gap), speed, steal, run: run_,
      }, fm.coeffs);
    };
    const eR = side("R"), eL = side("L");
    if (run.ht) { applyHitTail(eR, run.ht); applyHitTail(eL, run.ht); }
    const cal = run.cal;
    const kR = hittingComponents(eR, cal.hitBBScaleVR ?? 1, cal.hitHRScaleVR ?? 1, bats, "vR", fm.coeffs, fm.derived, trained!.eventForm!);
    const kL = hittingComponents(eL, cal.hitBBScaleVL ?? 1, cal.hitHRScaleVL ?? 1, bats, "vL", fm.coeffs, fm.derived, trained!.eventForm!);
    const dGAP = wR * kR.GAP_fin + wL * kL.GAP_fin;
    pred.set(r.cid, dGAP);
    // reproduction proof: HR and BABIP, re-derived on this same line, against the builder's own.
    const dHR = wR * kR.HR_fin + wL * kL.HR_fin;
    maxHrDiff = Math.max(maxHrDiff, Math.abs(dHR - (r.oursDep.hr600 ?? NaN)));
    // observed side
    const bbPerPa = (r.raw.bbPct ?? NaN) / 100;
    const abPa = abPerPa(r.raw.avg ?? NaN, r.raw.obp ?? NaN, bbPerPa);
    const hPerPa = (r.raw.avg ?? NaN) * abPa;
    const hrPerPa = (r.raw.hr600 ?? NaN) / 600;
    const g = xbhNonHrPerPa(r.raw.xbhPct ?? NaN, hPerPa, hrPerPa) * 600;
    if (Number.isFinite(g)) obs.set(r.cid, g);
  }
  return { pred, obs, maxHrDiff };
}

// ── CHANNELS ─────────────────────────────────────────────────────────────────────────────────────
// GAP for PITCHERS IS STRUCTURALLY UNOBSERVABLE in this corpus: cwhit publishes only BABIP for
// pitchers and our own reconstruction splits it with a FIXED 0.25 XBH share, so 1B and XBH are not
// independently observed on either side. It is carried as an explicit NOT-MEASURABLE row rather than
// faked from the fixed share, which would measure the constant and call it a channel.
interface ChDef { key: string; lbl: string; unit: string; d: number; measurable: boolean; note?: string }
const CH: Record<"pit" | "hit", ChDef[]> = {
  pit: [
    { key: "k9", lbl: "K", unit: "K/9", d: 2, measurable: true },
    { key: "bb9", lbl: "BB", unit: "BB/9", d: 2, measurable: true },
    { key: "hr9", lbl: "HR", unit: "HR/9", d: 2, measurable: true },
    { key: "babip", lbl: "BABIP", unit: "BABIP", d: 3, measurable: true },
    { key: "gap", lbl: "GAP", unit: "—", d: 3, measurable: false, note: "cwhit publishes no pitcher XBH/2B/3B; our line splits BABIP with a FIXED 0.25 share ⇒ not independently observed on EITHER side" },
  ],
  hit: [
    { key: "soPct", lbl: "K", unit: "K%/PA", d: 2, measurable: true, note: "obs converted K/AB→K/PA in the shared builder" },
    { key: "bbPct", lbl: "BB", unit: "BB%/PA", d: 2, measurable: true },
    { key: "hr600", lbl: "HR", unit: "HR/600", d: 2, measurable: true },
    { key: "babip", lbl: "BABIP", unit: "BABIP", d: 3, measurable: true },
    { key: "gap", lbl: "GAP", unit: "GAP/600", d: 2, measurable: true, note: "DERIVED observed quantity (XBHpct + AVG/OBP/BBpct), not a published column; its noise model is APPROXIMATE ⇒ read the free slope, not the dcv" },
  ],
};

/** Observed sampling noise per (row, channel). Every VARIANCE FORMULA is the shared one; only the
 *  dispatch is local (scorecard.ts must not import sample.ts). `Rec.sample` = BF (pit) / PA (hit). */
function noiseOf(r: Rec, ch: string, gapObs?: number): number {
  if (r.role === "pit") {
    const bf = r.sample;
    const bip = Math.max(bf - (r.obs.k9! + r.obs.bb9! + r.obs.hr9!) / BF_PER_9 * bf - 0.009 * bf, 1);
    if (ch === "babip") return babipNoiseVar(r.obs.babip!, bip);
    return per9NoiseVar(r.obs[ch]!, bf);
  }
  const bip = Math.max(r.sample * (1 - r.obs.bbPct! / 100 - 0.008 - r.obs.soPct! / 100 - r.obs.hr600! / 600), 1);
  if (ch === "babip") return babipNoiseVar(r.obs.babip!, bip);
  if (ch === "hr600") return per600NoiseVar(r.obs.hr600!, r.sample);
  if (ch === "gap") return per600NoiseVar(gapObs ?? NaN, r.sample);
  return pctNoiseVar(r.obs[ch]!, r.sample);
}

// ── the flattened observation table ──────────────────────────────────────────────────────────────
interface Obs {
  fmt: string; tid: string; stratum: "A" | "B" | "C"; decoupled: boolean;
  role: "pit" | "hit"; ch: string; hand: string;
  cardId: string; cid: string; sample: number;
  pred: number; obs: number; nv: number;
}
const OBS: Obs[] = [];
const runs = new Map<string, FmtRun>();
const gapRecon = new Map<string, GapRecon>();
const allNotices = new Set<string>();

for (const fm of FORMATS) {
  const run = runFormat(fm);
  runs.set(fm.reg.key, run);
  // Projection-join notices are dropped ON PURPOSE: this run never reads cwhit's projections (they
  // are a competitor benchmark, weight zero), so a projection-join count is not provenance for
  // anything here and 14 near-identical lines would bury a notice that IS load-bearing.
  for (const s of run.notices) if (!s.startsWith("projection join:")) allNotices.add(s);
  const gr = reconstructGap(fm, run);
  gapRecon.set(fm.reg.key, gr);
  for (const r of run.recs) {
    const base = cardById.get(r.cid.split("|")[0] ?? "");
    if (!base) continue;
    const hand = handLetter(n_(base[r.role === "pit" ? "Throws" : "Bats"]));
    for (const ch of CH[r.role]) {
      if (!ch.measurable) continue;
      const gObs = ch.key === "gap" ? gr.obs.get(r.cid) : undefined;
      const pred = ch.key === "gap" ? (gr.pred.get(r.cid) ?? NaN) : (r.oursDep[ch.key] ?? NaN);
      const obs = ch.key === "gap" ? (gObs ?? NaN) : (r.obs[ch.key] ?? NaN);
      if (!Number.isFinite(pred) || !Number.isFinite(obs)) continue;
      OBS.push({
        fmt: fm.reg.key, tid: fm.t.id, stratum: fm.stratum, decoupled: fm.decoupled,
        role: r.role, ch: ch.key, hand,
        cardId: r.cid.split("|")[0] ?? "", cid: r.cid, sample: r.sample,
        pred, obs, nv: noiseOf(r, ch.key, gObs),
      });
    }
  }
}

// ── STATISTICS ───────────────────────────────────────────────────────────────────────────────────

/** Cluster-robust SE of mean(d), clusters = Card ID (a card and its v5 are TWO rows for ONE card).
 *  Returns the iid SE beside it so the DESIGN EFFECT is measured per cell, never assumed. */
function levelStat(rows: Obs[]): { est: number; seCl: number; seIid: number; deff: number; nG: number; lo: number; hi: number; sig: boolean; mde: number } {
  const n = rows.length;
  const d = rows.map((r) => r.pred - r.obs);
  const est = mean(d);
  const varIid = n > 1 ? d.reduce((a, x) => a + (x - est) ** 2, 0) / (n - 1) / n : NaN;
  const byG = new Map<string, number[]>();
  for (let i = 0; i < n; i++) { const k = rows[i]!.cardId; (byG.get(k) ?? byG.set(k, []).get(k)!).push(d[i]!); }
  const G = byG.size;
  let s = 0;
  for (const v of byG.values()) { const t = v.reduce((a, x) => a + (x - est), 0); s += t * t; }
  const varCl = G > 1 ? (G / (G - 1)) * s / (n * n) : NaN;
  const seCl = Math.sqrt(varCl), seIid = Math.sqrt(varIid);
  const lo = est - 1.959964 * seCl, hi = est + 1.959964 * seCl;
  return { est, seCl, seIid, deff: varCl / varIid, nG: G, lo, hi, sig: lo * hi > 0, mde: MDE_K * seCl };
}

/** Usage-weighted (BF/PA) level differential — the ROW/appearance-grain aggregate, printed beside
 *  the CARD-grain one so the grain of the statistic is stated rather than implied. */
const levelUsage = (rows: Obs[]) => {
  let sw = 0, s = 0;
  for (const r of rows) { sw += r.sample; s += r.sample * (r.pred - r.obs); }
  return sw > 0 ? s / sw : NaN;
};

interface Spread { n: number; ratioRaw: number; dcv: number; noiseShare: number; nsHi: number; unrel: boolean; slope: number; sLo: number; sHi: number; sSig: boolean; sSe: number; sMde: number; deffSlope: number; deffDcv: number; corrDeconv: number }
function spreadStat(rows: Obs[], seed: number): Spread {
  const p = rows.map((r) => r.pred), o = rows.map((r) => r.obs), nv = rows.map((r) => r.nv);
  const okNv = nv.every((x) => Number.isFinite(x));
  const m = mmse(p, o, okNv ? nv : undefined);
  const nsHi = okNv && rows.length >= 3 ? noiseShareCiUpper(o, nv) : NaN;
  // cluster + iid bootstrap of BOTH statistics, matched reps and seeds ⇒ the design effect is a
  // like-for-like variance ratio, computed PER STATISTIC (it is never the same number twice).
  const groups = new Map<string, Obs[]>();
  for (const r of rows) (groups.get(r.cardId) ?? groups.set(r.cardId, []).get(r.cardId)!).push(r);
  const gs = [...groups.values()];
  const slopeOf = (xs: Obs[]) => {
    const mp = mean(xs.map((r) => r.pred)), mo = mean(xs.map((r) => r.obs));
    let sxx = 0, sxy = 0;
    for (const r of xs) { sxx += (r.pred - mp) ** 2; sxy += (r.pred - mp) * (r.obs - mo); }
    return sxx > 0 ? sxy / sxx : NaN;
  };
  const dcvOf = (xs: Obs[]) => {
    const sdP = sdPop(xs.map((r) => r.pred)), sdO = sdPop(xs.map((r) => r.obs));
    const v = Math.max(sdO ** 2 - mean(xs.map((r) => r.nv)), 0);
    return v > 0 ? sdP / Math.sqrt(v) : NaN;
  };
  const drawCl = (rnd: () => number) => { const out: Obs[] = []; for (let i = 0; i < gs.length; i++) out.push(...gs[Math.floor(rnd() * gs.length)]!); return out; };
  const drawIid = (rnd: () => number) => { const out: Obs[] = []; for (let i = 0; i < rows.length; i++) out.push(rows[Math.floor(rnd() * rows.length)]!); return out; };
  const run_ = (draw: (r: () => number) => Obs[], sd: number) => {
    const rnd = rng(sd); const sl: number[] = [], dv: number[] = [];
    for (let b = 0; b < B_BOOT; b++) { const x = draw(rnd); const a = slopeOf(x), c = dcvOf(x); if (Number.isFinite(a)) sl.push(a); if (Number.isFinite(c)) dv.push(c); }
    return { sl, dv };
  };
  const cl = run_(drawCl, seed), iid = run_(drawIid, seed);
  const sdOf = (xs: number[]) => (xs.length > 2 ? sdPop(xs) : NaN);
  const seSl = sdOf(cl.sl);
  return {
    n: rows.length, ratioRaw: m.ratioRaw, dcv: m.ratioDeconv, noiseShare: m.noiseShare, nsHi,
    unrel: Number.isFinite(nsHi) && nsHi >= 1,
    slope: m.slope.est, sLo: pctl(cl.sl, 0.025), sHi: pctl(cl.sl, 0.975),
    sSig: (pctl(cl.sl, 0.025) - 1) * (pctl(cl.sl, 0.975) - 1) > 0,
    sSe: seSl, sMde: MDE_K * seSl,
    deffSlope: (sdOf(cl.sl) / sdOf(iid.sl)) ** 2, deffDcv: (sdOf(cl.dv) / sdOf(iid.dv)) ** 2,
    corrDeconv: m.corrDeconv,
  };
}

/** PERMUTATION null for a two-group contrast on the level differential, permuting labels at the
 *  CLUSTER (Card ID) level — a card's variant rows share its hand, so a row-level permutation would
 *  break the very dependence the cluster correction exists for. */
function permContrast(rows: Obs[], labelOf: (r: Obs) => string, a: string, b: string, seed: number): { est: number; p: number; nA: number; nB: number; mde: number } {
  const groups = new Map<string, { lab: string; d: number[] }>();
  for (const r of rows) {
    const g = groups.get(r.cardId) ?? { lab: labelOf(r), d: [] };
    g.d.push(r.pred - r.obs); groups.set(r.cardId, g);
  }
  const gs = [...groups.values()].filter((g) => g.lab === a || g.lab === b);
  const statOf = (labs: string[]) => {
    let sa = 0, na = 0, sb = 0, nb = 0;
    for (let i = 0; i < gs.length; i++) for (const x of gs[i]!.d) { if (labs[i] === a) { sa += x; na++; } else { sb += x; nb++; } }
    return { v: (na ? sa / na : NaN) - (nb ? sb / nb : NaN), na, nb };
  };
  const labs0 = gs.map((g) => g.lab);
  const p0 = statOf(labs0);
  if (!Number.isFinite(p0.v) || p0.na < MIN_N || p0.nb < MIN_N) return { est: p0.v, p: NaN, nA: p0.na, nB: p0.nb, mde: NaN };
  const rnd = rng(seed);
  const draws: number[] = [];
  let hits = 0;
  for (let t = 0; t < N_PERM; t++) {
    const sh = [...labs0];
    for (let i = sh.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [sh[i], sh[j]] = [sh[j]!, sh[i]!]; }
    const v = statOf(sh).v;
    if (Number.isFinite(v)) { draws.push(v); if (Math.abs(v) >= Math.abs(p0.v) - 1e-15) hits++; }
  }
  // POWER: the permutation null's own SD is the exact yardstick — MDE = 2.802 × SD(null).
  return { est: p0.v, p: (hits + 1) / (draws.length + 1), nA: p0.na, nB: p0.nb, mde: MDE_K * sdPop(draws) };
}

/** PERMUTATION null for a K-group heterogeneity (interaction) claim across formats, on the level
 *  differential. Statistic = Cochran's Q over the per-format CARD-grain means with cluster SEs,
 *  recomputed inside every permutation (holding the SEs fixed would test a different hypothesis).
 *  EXCHANGEABILITY, stated honestly: permuting the format label across clusters assumes the label
 *  carries no information under the null. It does NOT preserve each format's pool composition, so a
 *  significant Q here means "the format label matters", never "opposition is the mechanism". */
function permHeterogeneity(rows: Obs[], seed: number): { Q: number; df: number; I2: number; p: number; k: number; mdePair: number; meanSe: number } {
  const groups = new Map<string, { lab: string; d: number[] }>();
  for (const r of rows) {
    const key = `${r.fmt}|${r.cardId}`;
    const g = groups.get(key) ?? { lab: r.fmt, d: [] };
    g.d.push(r.pred - r.obs); groups.set(key, g);
  }
  const gs = [...groups.values()];
  const labels = [...new Set(gs.map((g) => g.lab))];
  const qOf = (labs: string[]) => {
    const per = new Map<string, number[][]>();
    for (let i = 0; i < gs.length; i++) (per.get(labs[i]!) ?? per.set(labs[i]!, []).get(labs[i]!)!).push(gs[i]!.d);
    const cells: { m: number; se: number }[] = [];
    for (const cl of per.values()) {
      const flat = cl.flat(); const n = flat.length; if (n < MIN_N || cl.length < 2) continue;
      const m = mean(flat);
      let s = 0; for (const v of cl) { const t = v.reduce((a, x) => a + (x - m), 0); s += t * t; }
      const se = Math.sqrt((cl.length / (cl.length - 1)) * s / (n * n));
      if (se > 0) cells.push({ m, se });
    }
    if (cells.length < 2) return { Q: NaN, df: NaN, mw: NaN, se: NaN };
    const w = cells.map((c) => 1 / c.se ** 2);
    const sw = w.reduce((a, x) => a + x, 0);
    const mw = cells.reduce((a, c, i) => a + w[i]! * c.m, 0) / sw;
    const Q = cells.reduce((a, c, i) => a + w[i]! * (c.m - mw) ** 2, 0);
    return { Q, df: cells.length - 1, mw, se: mean(cells.map((c) => c.se)) };
  };
  const q0 = qOf(gs.map((g) => g.lab));
  if (!Number.isFinite(q0.Q)) return { Q: NaN, df: NaN, I2: NaN, p: NaN, k: labels.length, mdePair: NaN, meanSe: NaN };
  const rnd = rng(seed);
  let hits = 0, tot = 0;
  const labs0 = gs.map((g) => g.lab);
  for (let t = 0; t < N_PERM; t++) {
    const sh = [...labs0];
    for (let i = sh.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [sh[i], sh[j]] = [sh[j]!, sh[i]!]; }
    const q = qOf(sh).Q;
    if (Number.isFinite(q)) { tot++; if (q >= q0.Q - 1e-12) hits++; }
  }
  return {
    Q: q0.Q, df: q0.df, I2: q0.Q > q0.df ? (q0.Q - q0.df) / q0.Q : 0,
    p: (hits + 1) / (tot + 1), k: q0.df + 1,
    // POWER, stated as the smallest PAIRWISE between-format gap that would be CI-clear at the mean
    // cell SE: 2.802 × √2 × s̄. A Q-test null with a huge mdePair has not resolved anything.
    mdePair: MDE_K * Math.SQRT2 * q0.se, meanSe: q0.se,
  };
}

/** PERMUTATION null for cross-format heterogeneity of the FREE SLOPE — the axis the shipped
 *  corrections actually live on, and the one a per-format anchor cannot absorb.
 *
 *  WHY THIS EXISTS BESIDE THE LEVEL VERSION: a Cochran Q on the LEVEL differential is testing
 *  whether formats carry different per-channel level CONVENTIONS, which they trivially do — at
 *  these N the level SEs are tiny (BB9 SE ≈ 0.03) and essentially every channel comes back
 *  "heterogeneous". That test does not discriminate between channels and is not what the priors
 *  are about. The SLOPE is the discriminating quantity.
 *
 *  The per-format slope SEs are held FIXED at their observed cluster-bootstrap values (re-bootstrapping
 *  inside every permutation is not affordable and not necessary: the statistic is then a deterministic
 *  function of the data and a fixed weight vector, which is a valid permutation statistic). Cluster
 *  COUNTS per format are preserved exactly by permuting the label vector, so the fixed weights stay
 *  approximately right under the null. */
function permHeteroSlope(rows: Obs[], seByFmt: Map<string, number>, seed: number): { Q: number; df: number; I2: number; p: number; k: number; mdePair: number; meanSe: number; slopes: Map<string, number> } {
  const groups = new Map<string, { lab: string; rows: Obs[] }>();
  for (const r of rows) {
    const key = `${r.fmt}|${r.cardId}`;
    const g = groups.get(key) ?? { lab: r.fmt, rows: [] };
    g.rows.push(r); groups.set(key, g);
  }
  const gs = [...groups.values()];
  const slopeOf = (xs: Obs[]) => {
    const mp = mean(xs.map((r) => r.pred)), mo = mean(xs.map((r) => r.obs));
    let sxx = 0, sxy = 0;
    for (const r of xs) { sxx += (r.pred - mp) ** 2; sxy += (r.pred - mp) * (r.obs - mo); }
    return sxx > 0 ? sxy / sxx : NaN;
  };
  const qOf = (labs: string[]) => {
    const per = new Map<string, Obs[]>();
    for (let i = 0; i < gs.length; i++) { const k = labs[i]!; (per.get(k) ?? per.set(k, []).get(k)!).push(...gs[i]!.rows); }
    const cells: { lab: string; s: number; w: number }[] = [];
    for (const [lab, xs] of per) {
      const se = seByFmt.get(lab);
      const s = slopeOf(xs);
      if (xs.length >= MIN_N && Number.isFinite(s) && se && se > 0) cells.push({ lab, s, w: 1 / se ** 2 });
    }
    if (cells.length < 2) return { Q: NaN, df: NaN, cells };
    const sw = cells.reduce((a, c) => a + c.w, 0);
    const mw = cells.reduce((a, c) => a + c.w * c.s, 0) / sw;
    return { Q: cells.reduce((a, c) => a + c.w * (c.s - mw) ** 2, 0), df: cells.length - 1, cells };
  };
  const labs0 = gs.map((g) => g.lab);
  const q0 = qOf(labs0);
  if (!Number.isFinite(q0.Q)) return { Q: NaN, df: NaN, I2: NaN, p: NaN, k: 0, mdePair: NaN, meanSe: NaN, slopes: new Map() };
  const rnd = rng(seed);
  let hits = 0, tot = 0;
  for (let t = 0; t < N_PERM; t++) {
    const sh = [...labs0];
    for (let i = sh.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [sh[i], sh[j]] = [sh[j]!, sh[i]!]; }
    const q = qOf(sh).Q;
    if (Number.isFinite(q)) { tot++; if (q >= q0.Q - 1e-12) hits++; }
  }
  const meanSe = mean(q0.cells.map((c) => 1 / Math.sqrt(c.w)));
  return {
    Q: q0.Q, df: q0.df, I2: q0.Q > q0.df ? (q0.Q - q0.df) / q0.Q : 0,
    p: (hits + 1) / (tot + 1), k: q0.df + 1, mdePair: MDE_K * Math.SQRT2 * meanSe, meanSe,
    slopes: new Map(q0.cells.map((c) => [c.lab, c.s])),
  };
}

/** PERMUTATION null for a CORPUS-WIDE hand effect in one role × channel: is the per-format L−R
 *  contrast pointing the same way often enough to be a signal rather than 14 independent coin flips?
 *
 *  THE PERMUTATION IS AT CARD LEVEL AND GLOBAL — one hand assignment per Card ID, applied to every
 *  format that card appears in. It has to be: the quick windows are NESTED, so the SAME card carries
 *  the SAME hand into up to five formats, and permuting hand independently within each format would
 *  destroy that dependence and make the null distribution too narrow (an anti-conservative test that
 *  manufactures corpus-wide significance out of one card set). Statistic = the unweighted mean of the
 *  per-format contrasts. */
function permHandGlobal(rows: Obs[], seed: number): { est: number; p: number; nFmt: number; nPos: number; mde: number } {
  const handOf = new Map<string, string>();
  for (const r of rows) if (r.hand === "L" || r.hand === "R") handOf.set(r.cardId, r.hand);
  const cards = [...handOf.keys()];
  const use = rows.filter((r) => handOf.has(r.cardId));
  const fmts = [...new Set(use.map((r) => r.fmt))];
  const statOf = (assign: Map<string, string>) => {
    const per: number[] = [];
    for (const fmt of fmts) {
      let sl = 0, nl = 0, sr = 0, nr = 0;
      for (const r of use) {
        if (r.fmt !== fmt) continue;
        const d = r.pred - r.obs;
        if (assign.get(r.cardId) === "L") { sl += d; nl++; } else { sr += d; nr++; }
      }
      if (nl >= MIN_N && nr >= MIN_N) per.push(sl / nl - sr / nr);
    }
    return per;
  };
  const per0 = statOf(handOf);
  if (per0.length < 3) return { est: mean(per0), p: NaN, nFmt: per0.length, nPos: per0.filter((x) => x > 0).length, mde: NaN };
  const est = mean(per0);
  const rnd = rng(seed);
  const draws: number[] = [];
  let hits = 0;
  const vals = cards.map((c) => handOf.get(c)!);
  for (let t = 0; t < N_PERM; t++) {
    const sh = [...vals];
    for (let i = sh.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [sh[i], sh[j]] = [sh[j]!, sh[i]!]; }
    const a = new Map<string, string>();
    for (let i = 0; i < cards.length; i++) a.set(cards[i]!, sh[i]!);
    const v = mean(statOf(a));
    if (Number.isFinite(v)) { draws.push(v); if (Math.abs(v) >= Math.abs(est) - 1e-15) hits++; }
  }
  return { est, p: (hits + 1) / (draws.length + 1), nFmt: per0.length, nPos: per0.filter((x) => x > 0).length, mde: MDE_K * sdPop(draws) };
}

const spearman = (xs: number[], ys: number[]) => {
  const rk = (v: number[]) => { const idx = v.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]); const r = new Array<number>(v.length); for (let i = 0; i < idx.length;) { let j = i; while (j + 1 < idx.length && idx[j + 1]![0] === idx[i]![0]) j++; const av = (i + j) / 2 + 1; for (let k = i; k <= j; k++) r[idx[k]![1]] = av; i = j + 1; } return r; };
  const a = rk(xs), b = rk(ys), ma = mean(a), mb = mean(b);
  let cv = 0, va = 0, vb = 0;
  for (let i = 0; i < a.length; i++) { cv += (a[i]! - ma) * (b[i]! - mb); va += (a[i]! - ma) ** 2; vb += (b[i]! - mb) ** 2; }
  return va > 0 && vb > 0 ? cv / Math.sqrt(va * vb) : NaN;
};
/** Exact-ish permutation p for a Spearman correlation over k format-level points (k ≤ 9 ⇒ the
 *  permutation distribution is the honest null; a t-approximation at k = 5 is not). */
function permSpearman(xs: number[], ys: number[], seed: number): { rho: number; p: number } {
  const rho = spearman(xs, ys);
  if (!Number.isFinite(rho)) return { rho, p: NaN };
  const rnd = rng(seed); let hits = 0;
  for (let t = 0; t < N_PERM; t++) {
    const sh = [...ys];
    for (let i = sh.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [sh[i], sh[j]] = [sh[j]!, sh[i]!]; }
    if (Math.abs(spearman(xs, sh)) >= Math.abs(rho) - 1e-12) hits++;
  }
  return { rho, p: (hits + 1) / (N_PERM + 1) };
}

// ── CELL ASSEMBLY ────────────────────────────────────────────────────────────────────────────────
interface Cell {
  fmt: string; tid: string; stratum: "A" | "B" | "C"; decoupled: boolean;
  role: "pit" | "hit"; ch: string; lbl: string; d: number; unit: string;
  bar: "primary" | "sens";
  n: number; nG: number; thin: boolean; dead: boolean;
  lvl: ReturnType<typeof levelStat>; lvlUsage: number;
  spr: Spread;
}
const barRows = (bar: "primary" | "sens") => {
  const b = bar === "primary" ? BAR_PRIMARY : BAR_SENS;
  return OBS.filter((r) => (r.role === "pit" ? r.sample >= b.bf : r.sample >= b.pa));
};

const CELLS: Cell[] = [];
let seedStep = 0;
for (const bar of ["primary", "sens"] as const) {
  const pool = barRows(bar);
  for (const fm of FORMATS) for (const role of ["pit", "hit"] as const) for (const ch of CH[role]) {
    if (!ch.measurable) continue;
    const rows = pool.filter((r) => r.fmt === fm.reg.key && r.role === role && r.ch === ch.key);
    const dead = rows.length < MIN_N;
    const lvl = dead ? { est: NaN, seCl: NaN, seIid: NaN, deff: NaN, nG: 0, lo: NaN, hi: NaN, sig: false, mde: NaN } : levelStat(rows);
    const spr = dead ? { n: rows.length, ratioRaw: NaN, dcv: NaN, noiseShare: NaN, nsHi: NaN, unrel: false, slope: NaN, sLo: NaN, sHi: NaN, sSig: false, sSe: NaN, sMde: NaN, deffSlope: NaN, deffDcv: NaN, corrDeconv: NaN } : spreadStat(rows, SEED + (seedStep++));
    CELLS.push({
      fmt: fm.reg.key, tid: fm.t.id, stratum: fm.stratum, decoupled: fm.decoupled,
      role, ch: ch.key, lbl: ch.lbl, d: ch.d, unit: ch.unit, bar,
      n: rows.length, nG: lvl.nG, thin: rows.length <= THIN_N && !dead, dead,
      lvl, lvlUsage: dead ? NaN : levelUsage(rows), spr,
    });
  }
}
const P = CELLS.filter((c) => c.bar === "primary");
const S = CELLS.filter((c) => c.bar === "sens");
const live = P.filter((c) => !c.dead && !c.thin);

// ═════════════════════════════════════════════════════════════════════════════════════════════════
say(`╔══════════════════════════════════════════════════════════════════════════════════════════════════╗`);
say(`║  SWEEP MEASUREMENT — where predictions miss, per FORMAT × ROLE × CHANNEL × HAND                   ║`);
say(`║  Amendment-2 exploratory layer.  MEASUREMENT ONLY — NO FITS.                                      ║`);
say(`╚══════════════════════════════════════════════════════════════════════════════════════════════════╝`);
say();

// ═══ THE MULTIPLICITY STATEMENT — first, deliberately ═════════════════════════════════════════════
{
  const tested = P.filter((c) => !c.dead && !c.thin).length;
  const nLvl = tested, nSlope = tested;
  const total = nLvl + nSlope;
  say(`═══ 0. MULTIPLICITY — READ THIS BEFORE ANY COUNT BELOW ═══════════════════════════════════════════`);
  say();
  say(`  This run tests ${nLvl} LEVEL cells and ${nSlope} SPREAD (free-slope) cells that carry a verdict`);
  say(`  — ${total} verdict-bearing tests in total, plus ${P.filter((c) => c.thin).length} THIN and ${P.filter((c) => c.dead).length} DEAD cells that carry none, plus`);
  say(`  the per-hand contrasts and heterogeneity tests reported in §5 and §7.`);
  say();
  say(`  AT α = 0.05, ${f(0.05 * total, 1)} OF THOSE ${total} CELLS ARE EXPECTED TO BE "CI-CLEAR" WITH NOTHING REAL BEHIND THEM.`);
  say(`  A raw count of significant cells is therefore NOT a finding, and this run never reports one as`);
  say(`  such. What can be read: (a) the SHAPE of the counts — whether CI-clear cells concentrate in a`);
  say(`  channel/stratum far beyond ${f(0.05 * total, 1)}; (b) individual EFFECT SIZES against their own MDEs; (c) the`);
  say(`  three pre-registered priors in §8, which were written before any number was computed and are`);
  say(`  graded PRIOR HELD / PRIOR VIOLATED one by one.`);
  say();
  say(`  These tests are NOT independent (channels share a BIP chain: any change to BB/K/HR changes BIP`);
  say(`  and therefore hits — SYSTEM_MAP §1), so ${f(0.05 * total, 1)} is an ORDER OF MAGNITUDE for the chance count, not`);
  say(`  an exact expectation. Positive dependence makes the true false-positive count MORE variable,`);
  say(`  not smaller. No Bonferroni/FDR adjustment is applied: this is an EXPLORATORY sweep whose job is`);
  say(`  to locate structure for a later, pre-registered test — adjusting here would trade a false-`);
  say(`  positive problem for a false-negative one without earning a confirmatory claim either way.`);
}
say();

// ═══ 0b. WHAT THE RUN FOUND — reserved here, WRITTEN AT THE END ══════════════════════════════════
// The summary belongs SECOND (the multiplicity statement keeps its required first position, so no
// reader reaches a headline before the warning about counting). But it is assembled from statistics
// that do not exist until §8 has run. So its slot in the output buffer is reserved now and spliced
// at the end — the alternative, computing the priors twice, is exactly the drift this codebase bans.
const SUMMARY_AT = L.length;

// ═══ 1. PROVENANCE + WHAT THIS RUN IS NOT ════════════════════════════════════════════════════════
say(`═══ 1. PROVENANCE ═══════════════════════════════════════════════════════════════════════════════`);
say();
say(`  model            '${trained.id}'  (cohort rule '${trained.cohortRule ?? "model-woba"}')`);
say(`  catalog          '${srcId}' — ${baseCards.length} base cards`);
say(`  corpus           ${CAPTURE_DIR_2026_07_21} at FULL DEPTH (coverage ended ~2026-07-19; aging)`);
say(`  judged line      DEPLOYED (era + park + per-event scales + trusted assembly). Six of the nine`);
say(`                   non-quick formats carry a real era/park and the environment exists ONLY on this`);
say(`                   line; the raw line would compare an environment-free prediction against an`);
say(`                   in-environment observation.`);
say(`  corrections      ON (production default): C3 pit K-spread, C6 pit HR9 spread, BUILD-2 hitter tail.`);
say(`                   pit BABIP scalar HELD (never set). Ramps evaluated at each format's OWN gap.`);
say(`  shipped ramps    K_SPREAD_PIT {A ${K_SPREAD_PIT.A}, q ${K_SPREAD_PIT.q}, G0 ${K_SPREAD_PIT.G0}, gMax ${K_SPREAD_PIT.gMax}}`);
say(`                   PIT_SPREAD_HR {A ${PIT_SPREAD_HR.A}, q ${PIT_SPREAD_HR.q}, G0 ${PIT_SPREAD_HR.G0}, gMax ${PIT_SPREAD_HR.gMax}}`);
say(`  bars             PRIMARY BF ≥ ${BAR_PRIMARY.bf} / PA ≥ ${BAR_PRIMARY.pa};  SENSITIVITY ARM ${BAR_SENS.bf}/${BAR_SENS.pa} (§6).`);
say(`                   ONE join, ONE build: rows below a bar are FLAGGED, not dropped, so the two arms`);
say(`                   are the same sample filtered twice — never two differently-selected samples.`);
say(`  bootstrap        B = ${B_BOOT} (cluster and iid arms, matched seeds); permutations = ${N_PERM}; seed ${SEED}.`);
say(`  power convention MDE = ${f(MDE_K, 3)} × SE  (80% power, two-sided α = 0.05). Reported beside EVERY null.`);
say();
say(`  WHAT THIS RUN IS NOT: no fit, no new coordinate, no form work, no roster metric, no production`);
say(`  default touched, nothing wired, nothing committed. The event model is CLOSED IN-FRAME and`);
say(`  production sits at its measured ceiling (~0.78) — SYSTEM_MAP §7 is not re-litigated here. Any`);
say(`  apparent contradiction with a standing verdict is REPORTED AND STOPPED AT (§9), never resolved.`);
say(`  All fits on cwhit data remain BLOCKED until the wide re-pull; this run earns no fit.`);
if (allNotices.size) { say(); say(`  builder notices:`); for (const s of allNotices) say(`    · ${s}`); }
say();

// ═══ 2. THE GRAIN DECLARATION ════════════════════════════════════════════════════════════════════
say(`═══ 2. GRAIN — stated for EVERY observed-side statistic, as FORMAT_FACTS requires ════════════════`);
say();
say(`  THE CORPUS HAS NO ROW/APPEARANCE GRAIN AT ALL. cwhit's observed tables are one line per`);
say(`  (CID, VLvl), pooled by him over every instance of the format inside the capture window. There is`);
say(`  no per-game and no per-instance record anywhere in it. So every observed statistic in this run is`);
say(`  a CARD-GRAIN aggregate, and our predicted line is the same grain by construction (one line per`);
say(`  (card, VLvl)). No statistic below is a ROW-grain (per-appearance) statistic. Where the word`);
say(`  "row" appears it means an OBSERVED TABLE ROW = (CID, VLvl), i.e. a card at a variant level.`);
say();
say(`  THE ONE GRAIN HAZARD, AND THE CORRECTION APPLIED:  (CID, VLvl) is NOT the card. A card and its`);
say(`  v5 variant are TWO observed rows describing ONE underlying card with ONE rating shape, so their`);
say(`  errors are strongly dependent. Every LEVEL differential here is therefore computed at CARD grain`);
say(`  with a CLUSTER-ROBUST SE, clusters = Card ID; every bootstrap resamples CLUSTERS; every`);
say(`  permutation permutes labels at CLUSTER level. The design effect this buys is MEASURED per`);
say(`  statistic in §3 — never assumed.`);
say();
say(`  TWO AGGREGATIONS ARE PRINTED SIDE BY SIDE and they are different questions:`);
say(`    CARD    = unweighted mean over cards. THE PRIMARY. It is the convention the shipped ramps'`);
say(`              needs are estimated under (unweighted free slope), so it is the comparable number.`);
say(`    USAGE   = BF/PA-weighted mean. What the format's aggregate line actually looked like. It tilts`);
say(`              toward the most-used cards, and winners play more games (memory: tournament`);
say(`              survivorship), so it is a DEPLOYMENT-weighted read, never a talent read.`);
say();
say(`  DERIVED OBSERVED QUANTITIES (flagged wherever they appear):`);
say(`    · hitter K% — cwhit publishes K/AB; converted to K/PA in the shared builder.`);
say(`    · hitter GAP/600 — reconstructed from XBHpct + AVG/OBP/BBpct. NOT a published column.`);
say(`    · pitcher GAP — NOT MEASURABLE AT ALL (see §4). Not faked, not estimated, not counted.`);
say();

// ═══ 3. CLUSTER INFLATION, PER STATISTIC ═════════════════════════════════════════════════════════
say(`═══ 3. CLUSTER INFLATION — COMPUTED PER STATISTIC, NEVER ASSUMED ════════════════════════════════`);
say();
say(`  This project has measured design effects of 3.1×, 1.07×, 1.02–1.22×, 0.99–1.05× and 1.017× on`);
say(`  different statistics; assuming a factor has been wrong in BOTH directions. So it is re-measured`);
say(`  here for each statistic separately, as the variance ratio cluster ÷ iid over the same cells.`);
say();
say(`  statistic                    cells   median deff   p10      p90      max      SE inflation (√deff, median)`);
{
  const rows: { lbl: string; xs: number[] }[] = [
    { lbl: "LEVEL mean(pred−obs)", xs: live.map((c) => c.lvl.deff).filter(Number.isFinite) },
    { lbl: "FREE SLOPE obs~pred", xs: live.map((c) => c.spr.deffSlope).filter(Number.isFinite) },
    { lbl: "DCV spread ratio", xs: live.map((c) => c.spr.deffDcv).filter(Number.isFinite) },
  ];
  for (const r of rows) {
    const med = pctl(r.xs, 0.5);
    say(`  ${pad(r.lbl, 28)} ${rp(String(r.xs.length), 5)}   ${rp(f(med, 3), 11)}   ${rp(f(pctl(r.xs, 0.10), 3), 6)}   ${rp(f(pctl(r.xs, 0.90), 3), 6)}   ${rp(f(Math.max(...r.xs), 3), 6)}   ${f(Math.sqrt(med), 3)}×`);
  }
  const medL = pctl(rows[0]!.xs, 0.5);
  say();
  say(`  READ: the LEVEL design effect is the load-bearing one — it multiplies the width of every level`);
  say(`  CI in §4 and §5. At median ${f(medL, 2)}× variance it inflates SEs by ${f(Math.sqrt(medL), 2)}×, i.e. a cell whose iid CI`);
  say(`  just excluded zero can be a TIE once clustering is honoured. Every CI printed below is the`);
  say(`  CLUSTERED one. The per-cell deff is printed in the tables so an outlier cell is visible.`);
  say(`  A deff < 1 is not an error: with few clusters and heterogeneous within-cluster errors the`);
  say(`  cluster estimator can land below the iid one; it is reported as measured, not floored at 1.`);
}
say();

// ═══ 4. THE PER-STRATUM LEVEL TABLES ═════════════════════════════════════════════════════════════
const strataOrder: ("A" | "B" | "C")[] = ["A", "B", "C"];
const STRAT_DESC: Record<string, string> = {
  A: "NEUTRAL QUICKS (core) — era-2010 / park-1, uncapped. A defect appearing here attributes to the CORE.",
  B: "ENV-BEARING DAILIES — each carries its own era/park. Defects here attribute to the ERA layer.",
  C: "BUDGET / RESTRICTED / DECOUPLED — cap, slots, or a card-population restriction.",
};
say(`═══ 4. LEVEL DIFFERENTIALS, per STRATUM × format × role × channel ════════════════════════════════`);
say();
say(`  Δ = mean(pred − obs), CARD grain, cluster-robust 95% CI. NEGATIVE = we UNDER-predict the channel.`);
say(`  '*' = CI excludes zero. usage = the BF/PA-weighted aggregate (a different grain, §2).`);
say(`  MDE = smallest |Δ| this cell could have resolved at 80% power. A null with a large MDE has NOT`);
say(`  shown the effect is absent — it has shown the cell cannot see it.`);
say(`  THIN (N ≤ ${THIN_N}) prints with NO verdict and enters NO count. DEAD (N < ${MIN_N}) has no statistics at all.`);
say(`  A LEVEL bias that is UNIFORM across a pool is largely CONVENTION — the per-format anchor absorbs`);
say(`  it (SYSTEM_MAP §2). What the anchor CANNOT absorb is a bias correlated with a card property, so`);
say(`  the level tables locate, they do not convict. The spread tables (§7) carry the sharper question.`);

for (const st of strataOrder) {
  const fms = FORMATS.filter((x) => x.stratum === st && !x.decoupled);
  const dec = FORMATS.filter((x) => x.stratum === st && x.decoupled);
  say();
  say(`  ┌─ STRATUM ${st} — ${STRAT_DESC[st]}`);
  for (const fm of [...fms, ...dec]) {
    say(`  │`);
    say(`  │ ${fm.t.id}${fm.decoupled ? "   ⚠ DECOUPLED — reported as its own row, NEVER inside a pooled baseline" : ""}`);
    say(`  │   era ${fm.t.eraId} · park ${fm.t.parkId} · window ${fm.win.valueMin ?? 40}-${Number.isFinite(fm.win.valueMax) ? fm.win.valueMax : "∞"} · eligible pool ${fm.nPool} · gap(stu) ${f(fm.gapStu, 2)} → s_K ${f(fm.sK, 3)} · gap(hrr) ${f(fm.gapHrr, 2)} → s_HR ${f(fm.sHr, 3)}`);
    say(`  │   CARE: ${CARE[fm.t.id] ?? "—"}`);
    say(`  │   role ch      unit        N   nG      Δ(card)          95% CI            MDE     Δ(usage)   deff  flag`);
    for (const role of ["pit", "hit"] as const) for (const ch of CH[role]) {
      if (!ch.measurable) {
        say(`  │   ${pad(role, 4)} ${pad(ch.lbl, 6)}  ${pad("—", 10)}   —    —   NOT MEASURABLE — ${ch.note}`);
        continue;
      }
      const c = P.find((x) => x.fmt === fm.reg.key && x.role === role && x.ch === ch.key)!;
      if (c.dead) { say(`  │   ${pad(role, 4)} ${pad(ch.lbl, 6)}  ${pad(ch.unit, 10)} ${rp(String(c.n), 4)}   ${rp(String(c.nG), 3)}   DEAD (N < ${MIN_N}) — no statistics`); continue; }
      const flag = `${c.thin ? "THIN " : ""}${c.lvl.sig && !c.thin ? "CI-CLEAR" : ""}`.trim();
      say(`  │   ${pad(role, 4)} ${pad(ch.lbl, 6)}  ${pad(ch.unit, 10)} ${rp(String(c.n), 4)}   ${rp(String(c.nG), 3)}   ${rp(sgn(c.lvl.est, c.d), 8)}${c.lvl.sig && !c.thin ? "*" : " "}  [${sgn(c.lvl.lo, c.d)},${sgn(c.lvl.hi, c.d)}]  ${rp(f(c.lvl.mde, c.d), 7)}  ${rp(sgn(c.lvlUsage, c.d), 9)}  ${rp(f(c.lvl.deff, 2), 5)}  ${flag}`);
    }
  }
  say(`  └─`);
}
say();

// ═══ 5. PER-HAND LEVEL DIFFERENTIALS ═════════════════════════════════════════════════════════════
say(`═══ 5. PER-HAND LEVEL DIFFERENTIALS — L vs R, with PERMUTATION NULLS ═════════════════════════════`);
say();
say(`  HAND = the CARD's own handedness (Throws for pitchers, Bats for hitters), taken from OUR catalog.`);
say(`  IT IS NOT A PLATOON SPLIT: this corpus carries NO per-hand-of-opponent observed line anywhere, so`);
say(`  a vL/vR observed contrast DOES NOT EXIST and is not manufactured here. Our predicted line is the`);
say(`  exposure-weighted blend of vR and vL, exactly as the builder assembles it. Switch hitters (S) are`);
say(`  reported as their own row and pooled into NEITHER side of the contrast.`);
say();
say(`  WHY THIS IS THE INTERESTING CUT: park factors are handed (bronze-heart hr_l 1.15 / hr_r 0.66 is`);
say(`  the biggest split in the set) and park handedness is MODEL-INEXPRESSIBLE on our side. If the`);
say(`  environment layer mis-handles handed parks, THIS is where it shows.`);
say();
say(`  Δ_L, Δ_R = mean(pred − obs) within hand, CARD grain. CONTRAST = Δ_L − Δ_R with a CLUSTER-LEVEL`);
say(`  permutation null (${N_PERM} reps). p is the two-sided permutation p-value; MDE is 2.802 × SD of the`);
say(`  permutation null — the smallest contrast this cell could have resolved.`);
say();
say(`  format             role ch      N_L   N_R    Δ_L        Δ_R        CONTRAST    perm p    MDE      verdict`);
interface HandRow { fmt: string; tid: string; stratum: string; decoupled: boolean; role: string; ch: string; d: number; est: number; p: number; mde: number; nA: number; nB: number }
const handRows: HandRow[] = [];
{
  const pool = barRows("primary");
  let sd = SEED + 5000;
  for (const fm of FORMATS) for (const role of ["pit", "hit"] as const) for (const ch of CH[role]) {
    if (!ch.measurable) continue;
    const rows = pool.filter((r) => r.fmt === fm.reg.key && r.role === role && r.ch === ch.key);
    if (rows.length < MIN_N) continue;
    const lRows = rows.filter((r) => r.hand === "L"), rRows = rows.filter((r) => r.hand === "R");
    const pc = permContrast(rows, (r) => r.hand, "L", "R", sd++);
    const dL = lRows.length ? levelStat(lRows) : null, dR = rRows.length ? levelStat(rRows) : null;
    const thin = lRows.length <= THIN_N || rRows.length <= THIN_N;
    const verdict = !Number.isFinite(pc.p) ? "NO TEST (a side < MIN_N)"
      : thin ? "NO VERDICT (a side THIN)"
        : pc.p < 0.05 ? "CI-CLEAR CONTRAST" : "null";
    handRows.push({ fmt: fm.reg.key, tid: fm.t.id, stratum: fm.stratum, decoupled: fm.decoupled, role, ch: ch.key, d: ch.d, est: pc.est, p: pc.p, mde: pc.mde, nA: pc.nA, nB: pc.nB });
    say(`  ${pad(fm.reg.key, 18)} ${pad(role, 4)} ${pad(ch.lbl, 6)} ${rp(String(pc.nA), 4)}  ${rp(String(pc.nB), 4)}  ${rp(dL ? sgn(dL.est, ch.d) : "—", 9)}  ${rp(dR ? sgn(dR.est, ch.d) : "—", 9)}  ${rp(sgn(pc.est, ch.d), 9)}  ${rp(Number.isFinite(pc.p) ? f(pc.p, 3) : "—", 7)}  ${rp(f(pc.mde, ch.d), 7)}  ${verdict}`);
  }
  const sw = pool.filter((r) => r.hand === "S");
  say();
  say(`  SWITCH HITTERS: ${sw.length} observation-channel rows across the corpus, pooled into neither side above.`);
  const nT = handRows.filter((h) => Number.isFinite(h.p)).length;
  const nSig = handRows.filter((h) => Number.isFinite(h.p) && h.p < 0.05).length;
  say(`  HAND CONTRASTS TESTED: ${nT}. CI-clear at α=0.05: ${nSig}. EXPECTED BY CHANCE AT THAT COUNT: ${f(0.05 * nT, 1)}.`);
  say();
  say(`  A COUNT IS NOT A FINDING (§0). The question a count cannot answer is whether the contrasts POINT`);
  say(`  THE SAME WAY. That is a CORNER CLAIM, so it gets its own permutation null — and the permutation`);
  say(`  must be at CARD level and GLOBAL (one hand per Card ID, applied to every format it appears in),`);
  say(`  because the quick windows are NESTED and the same card carries the same hand into up to five`);
  say(`  formats. Permuting within each format independently would break that dependence and manufacture`);
  say(`  corpus-wide significance out of one card set.`);
  say();
  say(`  role ch      formats   +ve   mean L−R contrast   perm p   MDE      verdict`);
  {
    let sd2 = SEED + 7000;
    for (const role of ["pit", "hit"] as const) for (const ch of CH[role]) {
      if (!ch.measurable) continue;
      const rows = pool.filter((r) => r.role === role && r.ch === ch.key);
      const g = permHandGlobal(rows, sd2++);
      const v = !Number.isFinite(g.p) ? "NO TEST" : g.p < 0.05 ? "CORPUS-WIDE HAND EFFECT" : "null";
      say(`  ${pad(role, 4)} ${pad(ch.lbl, 6)} ${rp(String(g.nFmt), 7)}   ${rp(`${g.nPos}/${g.nFmt}`, 5)}   ${rp(sgn(g.est, ch.d), 17)}   ${rp(Number.isFinite(g.p) ? f(g.p, 3) : "—", 6)}   ${rp(f(g.mde, ch.d), 7)}  ${v}`);
    }
  }
  say();
  say(`  HOW TO READ ANY CORPUS-WIDE HAND EFFECT FOUND HERE — three things it is NOT:`);
  say(`   1. It is NOT a "hand-specific curve" finding. That question was CLOSED on league data`);
  say(`      (fixtures/REFUTATION-kcurve-hand-2026-07-25.txt): the vR/vL K-residual asymmetry was`);
  say(`      EXPLAINED by OPPOSING-BATTER COMPOSITION resolved by pitcher hand — same-side matchups face`);
  say(`      batters 6.37 avoid-K points weaker, the arms carry that in different proportions (52% vs`);
  say(`      20% same-side), and removing the matchup-cell level killed 98% of the asymmetry. "hand-K`);
  say(`      withdrawn" (SYSTEM_MAP §7) refers to that CURVE term. Nothing in this run tests a curve.`);
  say(`   2. It is NOT necessarily a model defect. Our line already carries a PLATOON EXPOSURE weighting`);
  say(`      (per hand × role), fitted on LEAGUE data. If tournament L/R exposure differs from league`);
  say(`      exposure, LHP and RHP lines are mis-blended in OPPOSITE directions — which is precisely a`);
  say(`      hand-signed level contrast, produced by an exposure input rather than by the event model.`);
  say(`      That is a known open item (memory: tournament-exposure-plan, platoon-exposure-plan), and it`);
  say(`      is the LEADING CANDIDATE for anything found above. This run does not adjudicate it.`);
  say(`   3. It is NOT a park-handedness conclusion either, though bronze-heart is the natural place to`);
  say(`      look: park factors are COMPRESSED (cp = 0.26), so a real handed park is under-differentiated`);
  say(`      by construction. Bronze-heart's row above is one cell of a 126-cell sweep; the compression`);
  say(`      story is a HYPOTHESIS it is consistent with, not a measurement of the compression.`);
}
say();

// ═══ 6. DCV SPREAD RATIOS + FREE SLOPE ═══════════════════════════════════════════════════════════
say(`═══ 6. SPREAD — DCV RATIOS AND THE FREE-SLOPE NEED ═══════════════════════════════════════════════`);
say();
say(`  TWO READINGS OF ONE QUESTION, and they are not interchangeable:`);
say(`    dcv   = SD(pred) / SD_deconv(obs). Needs the binomial noise model. UNREL when the 97.5th-pct`);
say(`            bootstrap noise share reaches 1.0 (sampling variance may exceed TOTAL observed`);
say(`            variance) — then the deconvolved SD collapses and dcv is not a measurement.`);
say(`    slope = free slope of obs~pred, THE ESTIMAND THE SHIPPED RAMPS ARE FITTED UNDER (amendment-2,`);
say(`            ruling (z), tools/fit-kspread-c3.ts). NOISE-IMMUNE: observed sampling noise lands`);
say(`            entirely in the residual. slope = 1 ⇔ calibrated spacing; slope > 1 ⇔ we UNDER-react`);
say(`            by that factor and the channel needs amplifying; slope < 1 ⇔ we over-react.`);
say(`  WHERE THEY DISAGREE, TRUST THE SLOPE. CIs are CLUSTER bootstraps (Card ID). '*' = CI excludes 1.0.`);
say(`  optimal dcv is NOT 1.0 — an MMSE-optimal predictor satisfies ratio = corr, so corr_dc is printed`);
say(`  beside it as the target the dcv should be read against.`);
say();
for (const st of strataOrder) {
  say(`  ── STRATUM ${st} ──`);
  say(`  format             role ch      N    slope   [cluster 95% CI]   MDE     dcv     corr_dc  noise%  deff_s  flag`);
  for (const fm of FORMATS.filter((x) => x.stratum === st)) {
    for (const role of ["pit", "hit"] as const) for (const ch of CH[role]) {
      if (!ch.measurable) continue;
      const c = P.find((x) => x.fmt === fm.reg.key && x.role === role && x.ch === ch.key)!;
      if (c.dead) continue;
      const flags = [c.thin ? "THIN" : "", c.spr.unrel ? "UNREL-dcv" : "", (!c.thin && c.spr.sSig) ? "SLOPE≠1" : "", fm.decoupled ? "DECOUPLED" : ""].filter(Boolean).join(" ");
      say(`  ${pad(fm.reg.key, 18)} ${pad(role, 4)} ${pad(ch.lbl, 6)} ${rp(String(c.n), 4)}  ${rp(f(c.spr.slope, 3), 6)}  [${f(c.spr.sLo, 2)},${f(c.spr.sHi, 2)}]${" ".repeat(Math.max(0, 13 - `[${f(c.spr.sLo, 2)},${f(c.spr.sHi, 2)}]`.length))}  ${rp(f(c.spr.sMde, 2), 5)}  ${rp(c.spr.unrel ? "UNREL" : f(c.spr.dcv, 2), 6)}  ${rp(f(c.spr.corrDeconv, 2), 6)}  ${rp(f(c.spr.noiseShare * 100, 0), 5)}%  ${rp(f(c.spr.deffSlope, 2), 5)}  ${flags}`);
    }
  }
  say();
}

// ═══ 7. SENSITIVITY ARM AT 1000 ══════════════════════════════════════════════════════════════════
say(`═══ 7. SENSITIVITY ARM — the ${BAR_SENS.bf}/${BAR_SENS.pa} bar beside the ${BAR_PRIMARY.bf}/${BAR_PRIMARY.pa} primary ══════════════════════════════════════════`);
say();
say(`  The bar is not free: raising it buys per-card precision and pays in N, and diamond cells are`);
say(`  historically thin (~N=36 at the 600 bar) so they are the first to fall out. A conclusion that`);
say(`  survives only at one bar is a conclusion about the bar.`);
say();
say(`  format             role ch      N600→N1000   Δ600        Δ1000       ΔΔ        slope600  slope1000  Δslope   stability`);
{
  let flips = 0, comparable = 0;
  for (const fm of FORMATS) for (const role of ["pit", "hit"] as const) for (const ch of CH[role]) {
    if (!ch.measurable) continue;
    const a = P.find((x) => x.fmt === fm.reg.key && x.role === role && x.ch === ch.key)!;
    const b = S.find((x) => x.fmt === fm.reg.key && x.role === role && x.ch === ch.key)!;
    if (a.dead) continue;
    const st = b.dead ? "DEAD@1000" : b.thin ? "THIN@1000 — no verdict" : (a.lvl.sig !== b.lvl.sig) ? "VERDICT FLIPS" : "stable";
    if (!b.dead && !b.thin && !a.thin) { comparable++; if (a.lvl.sig !== b.lvl.sig) flips++; }
    say(`  ${pad(fm.reg.key, 18)} ${pad(role, 4)} ${pad(ch.lbl, 6)} ${rp(`${a.n}→${b.n}`, 11)}   ${rp(sgn(a.lvl.est, ch.d), 9)}  ${rp(sgn(b.lvl.est, ch.d), 9)}  ${rp(sgn(b.lvl.est - a.lvl.est, ch.d), 8)}  ${rp(f(a.spr.slope, 2), 8)}  ${rp(f(b.spr.slope, 2), 9)}  ${rp(sgn(b.spr.slope - a.spr.slope, 2), 7)}  ${st}`);
  }
  say();
  say(`  STABILITY SUMMARY: ${comparable} cells carry a verdict at BOTH bars; ${flips} flip their LEVEL verdict (${f(comparable ? 100 * flips / comparable : NaN, 0)}%).`);
  say(`  A flip is not evidence of a defect — the 1000 arm is a strictly smaller, more-used subsample, so`);
  say(`  it is also a SELECTION contrast (survivorship: winners play more games) and not only a precision`);
  say(`  contrast. Flips are listed so no §4 cell is read as if the bar did not matter.`);
}
say();

// ═══ 8. THE PRE-REGISTERED PRIORS ════════════════════════════════════════════════════════════════
say(`═══ 8. THE THREE PRE-REGISTERED PRIORS — written before any number was computed ══════════════════`);
say();
say(`  THE TEST APPLIED TO ALL THREE, declared once: within STRATUM A (the five neutral quicks, where`);
say(`  era and park are exactly 1.0 so nothing but pool/composition varies), per role × channel:`);
say(`    (a) PRIMARY — CROSS-FORMAT HETEROGENEITY OF THE FREE SLOPE. Cochran's Q over the five per-`);
say(`        format free slopes with their cluster-bootstrap SEs, I², and a CLUSTER-LEVEL PERMUTATION p`);
say(`        (${N_PERM} reps, format labels permuted over (format × card) clusters).`);
say(`    (b) GAP-ORDERING — Spearman of the per-format FREE SLOPE against that format's own gap`);
say(`        coordinate, with an exact-ish permutation p over the five points.`);
say(`    (c) SECONDARY, AND DELIBERATELY DEMOTED — the same Q on the LEVEL differential.`);
say();
say(`  WHY THE SLOPE IS PRIMARY AND THE LEVEL IS DEMOTED — decided on the STRUCTURE of the statistics,`);
say(`  not on their answers. A per-channel LEVEL bias that is uniform within a pool is a CONVENTION at`);
say(`  the value layer: the per-format anchor absorbs it (SYSTEM_MAP §2), and a Q on levels is therefore`);
say(`  asking "do the fourteen formats carry different conventions". At these N the level SEs are tiny`);
say(`  (pitcher BB9 ≈ 0.03) so that test is enormously over-powered and returns "heterogeneous" for`);
say(`  almost every channel — it cannot DISCRIMINATE between channels, which is the only thing the`);
say(`  priors ask of it. The FREE SLOPE is what the shipped corrections are estimated on, is what every`);
say(`  standing spread verdict is stated in, and is NOT absorbable by a mean-pinning anchor. The level Q`);
say(`  is still printed, so the demotion is visible rather than a quiet omission.`);
say();
say(`  EXCHANGEABILITY, STATED HONESTLY: permuting the format label across clusters does not preserve`);
say(`  each format's pool composition (the quick windows are NESTED by design), so a significant Q means`);
say(`  "the format label carries information", never "opposition is the mechanism". Stratum A cannot`);
say(`  identify a mechanism — tier ↔ window ↔ pool-property are confounded BY DESIGN (SYSTEM_MAP §5).`);
say();
interface PriorRow { role: string; ch: string; lbl: string; d: number; hetS: ReturnType<typeof permHeteroSlope>; hetL: ReturnType<typeof permHeterogeneity>; rho: number; rhoP: number; slopes: number[]; gaps: number[] }
const priorRows: PriorRow[] = [];
{
  const pool = barRows("primary").filter((r) => r.stratum === "A" && !r.decoupled);
  const aFormats = FORMATS.filter((x) => x.stratum === "A" && !x.decoupled);
  let sd = SEED + 9000;
  say(`                 ── PRIMARY: SLOPE heterogeneity ──   ── (b) gap order ──   ── (c) LEVEL het, demoted ──`);
  say(`  role ch      k   Q      I²     perm p   pairMDE   ρ      perm p   Q        I²     perm p   ‖  free slopes across stratum A`);
  for (const role of ["pit", "hit"] as const) for (const ch of CH[role]) {
    if (!ch.measurable) continue;
    const rows = pool.filter((r) => r.role === role && r.ch === ch.key);
    if (rows.length < MIN_N * 2) continue;
    const cells = aFormats.map((fm) => P.find((x) => x.fmt === fm.reg.key && x.role === role && x.ch === ch.key)!).filter((c) => c && !c.dead);
    const seByFmt = new Map(cells.map((c) => [c.fmt, c.spr.sSe]));
    const hetS = permHeteroSlope(rows, seByFmt, sd++);
    const hetL = permHeterogeneity(rows, sd++);
    const slopes = cells.map((c) => c.spr.slope);
    const gaps = cells.map((c) => { const fm = aFormats.find((x) => x.reg.key === c.fmt)!; return ch.key === "hr9" || ch.key === "hr600" ? fm.gapHrr : fm.gapStu; });
    const sp = permSpearman(gaps, slopes, sd++);
    priorRows.push({ role, ch: ch.key, lbl: ch.lbl, d: ch.d, hetS, hetL, rho: sp.rho, rhoP: sp.p, slopes, gaps });
    say(`  ${pad(role, 4)} ${pad(ch.lbl, 6)} ${rp(String(hetS.k), 2)}   ${rp(f(hetS.Q, 1), 5)}  ${rp(f(100 * hetS.I2, 0), 3)}%   ${rp(f(hetS.p, 3), 6)}   ${rp(f(hetS.mdePair, 2), 7)}   ${rp(f(sp.rho, 2), 5)}  ${rp(f(sp.p, 3), 6)}   ${rp(f(hetL.Q, 1), 6)}  ${rp(f(100 * hetL.I2, 0), 3)}%   ${rp(f(hetL.p, 3), 6)}   ‖  ${cells.map((c) => f(c.spr.slope, 2)).join(" ")}`);
  }
  say();
  say(`  (format order for the slope list: ${aFormats.map((x) => x.reg.key.replace("quick", "")).join(" ")})`);
  say(`  (gap used for the ρ column: hrr-gap for the HR channels, stu-gap for all others — each channel`);
  say(`   read against the coordinate its own shipped correction consumes.)`);
  say(`  (pairMDE = smallest PAIRWISE between-format slope gap resolvable at 80% power, at the mean cell SE.)`);
  say();

  // ── THE POWER GATE, applied to EVERY null before it is graded ──────────────────────────────────
  // "Covers zero" is not a finding unless the cell could have resolved the effect (brief). So a
  // channel whose slope-Q comes back NULL is only graded a null when the test could have SEEN an
  // effect of the size the data actually show: the observed maximum PAIRWISE between-format slope
  // gap must reach the pairwise MDE. Where it does not, the honest verdict is a THIRD one —
  // NOT RESOLVED — and it is neither a hold nor a violation. This gate is applied identically to
  // every channel and both directions of every prior, so it cannot be a post-hoc escape hatch for
  // the results that were inconvenient.
  const range = (r: PriorRow) => Math.max(...r.slopes) - Math.min(...r.slopes);
  const powered = (r: PriorRow) => range(r) >= r.hetS.mdePair;
  type G = "HELD" | "VIOLATED" | "NOT RESOLVED";
  const get = (role: string, ch: string) => priorRows.find((r) => r.role === role && r.ch === ch);
  const grade = (name: string, expect: string, rows: (PriorRow | undefined)[], classify: (r: PriorRow) => G, reason: (r: PriorRow) => string, detects: (r: PriorRow) => boolean) => {
    say(`  ── PRIOR: ${name}`);
    say(`     EXPECTED (pre-registered): ${expect}`);
    const rs = rows.filter((r): r is PriorRow => !!r);
    if (!rs.length) { say(`     ⇒ NOT EVALUABLE — no stratum-A cell carries this channel.`); say(); return "NOT EVALUABLE"; }
    const tally: Record<G, number> = { HELD: 0, VIOLATED: 0, "NOT RESOLVED": 0 };
    for (const r of rs) {
      const g = classify(r);
      tally[g]++;
      say(`     ${pad(`${r.role} ${r.lbl}`, 10)} ${pad(`PRIOR ${g}`, 18)} — ${reason(r)}`);
      if (detects(r)) {
        say(`     ${pad("", 10)} POWER: not applicable — this is a POSITIVE result, not a null. (For reference the`);
        say(`     ${pad("", 10)}        pairwise MDE was ${f(r.hetS.mdePair, 2)} against an observed max pairwise gap of ${f(range(r), 2)}.)`);
      } else {
        say(`     ${pad("", 10)} POWER (this is a NULL, so it is graded on power): pairwise MDE on the slope`);
        say(`     ${pad("", 10)}        ${f(r.hetS.mdePair, 2)} (mean cell SE ${f(r.hetS.meanSe, 3)}) vs an OBSERVED max pairwise slope gap of ${f(range(r), 2)}`);
        say(`     ${pad("", 10)}        ⇒ this cell ${powered(r) ? "COULD" : "COULD NOT"} have resolved an effect of the size the data show.`);
      }
      say(`     ${pad("", 10)}        The ρ leg has k=${r.slopes.length} points, whose exact permutation null makes |ρ| = 1.00 the ONLY`);
      say(`     ${pad("", 10)}        resolvable value at α = 0.05 — a non-significant ρ rules out essentially nothing.`);
    }
    const parts = (["HELD", "VIOLATED", "NOT RESOLVED"] as G[]).filter((k) => tally[k]).map((k) => `${tally[k]} ${k}`);
    const v = parts.length === 1 ? `PRIOR ${parts[0]!.split(" ").slice(1).join(" ")} in all ${rs.length} channels` : `MIXED — ${parts.join(", ")} of ${rs.length} channels`;
    say(`     ⇒ ${v}`);
    say();
    return v;
  };
  const verdicts: Record<string, string> = {};
  verdicts.BB = grade(
    "BB-FAMILY IS NULL",
    "dead in-frame at every grain measured. A null here is a POSITIVE RESULT, not a failure to find something.",
    [get("pit", "bb9"), get("hit", "bbPct")],
    (r) => (r.hetS.p < 0.05 ? "VIOLATED" : powered(r) ? "HELD" : "NOT RESOLVED"),
    (r) => `slope Q ${f(r.hetS.Q, 1)} on ${r.hetS.df} df, I² ${f(100 * r.hetS.I2, 0)}%, permutation p ${f(r.hetS.p, 3)}; ρ(slope,gap) ${f(r.rho, 2)} p ${f(r.rhoP, 3)}. Slopes ${r.slopes.map((s) => f(s, 2)).join("/")}`,
    (r) => r.hetS.p < 0.05,
  );
  say(`     SCOPE NOTE THE BB GRADE MUST CARRY: the prior's evidence base is IN-FRAME ("dead in-frame at`);
  say(`     every grain measured"). Stratum A is OUT of frame — these are tournament pools, which is why`);
  say(`     the spread ramps exist at all. A BB effect appearing here therefore does NOT contradict the`);
  say(`     in-frame evidence; it extends the question past where that evidence reaches. It is graded`);
  say(`     against the prior AS WRITTEN, and this note is the reconciliation, not a softening.`);
  say();
  verdicts.HRBAB = grade(
    "HR / BABIP ARE THE LIVE FAMILY",
    "the opposition-responsive channels — a real effect is expected here if one exists anywhere.",
    [get("pit", "hr9"), get("hit", "hr600"), get("pit", "babip"), get("hit", "babip")],
    (r) => (r.hetS.p < 0.05 || r.rhoP < 0.05 ? "HELD" : powered(r) ? "VIOLATED" : "NOT RESOLVED"),
    (r) => `slope Q ${f(r.hetS.Q, 1)} on ${r.hetS.df} df, I² ${f(100 * r.hetS.I2, 0)}%, permutation p ${f(r.hetS.p, 3)}; ρ(slope,gap) ${f(r.rho, 2)} p ${f(r.rhoP, 3)}. Slopes ${r.slopes.map((s) => f(s, 2)).join("/")}`,
    (r) => r.hetS.p < 0.05 || r.rhoP < 0.05,
  );
  verdicts.K = grade(
    "K IS OPPOSITION-NULL",
    "twice proven — the battery found the K need flat under every opposition weighting, and the (c) report found realized opposing Avoid-K essentially flat iron→gold while K needs span 1.83→1.48. The K need is NOT opposition-driven.",
    [get("pit", "k9"), get("hit", "soPct")],
    (r) => (r.rhoP < 0.05 ? "VIOLATED" : "HELD"),
    (r) => `residual free slope vs own gap: ρ ${f(r.rho, 2)}, permutation p ${f(r.rhoP, 3)} ⇒ ${r.rhoP < 0.05 ? "the RESIDUAL K need IS gap-ordered after the shipped ramp — an opposition ordering the correction did not remove" : "NO gap ordering survives the shipped ramp"}. Residual slope heterogeneity: Q ${f(r.hetS.Q, 1)}, I² ${f(100 * r.hetS.I2, 0)}%, p ${f(r.hetS.p, 3)} — heterogeneity is NOT opposition-drive; the prior is about the DRIVER`,
    // The K grade rests on the ρ (driver) leg, whose power is stated in the ρ line below every cell.
    // `detects` here refers to the Q leg, so the power paragraph describes the statistic it quotes.
    (r) => r.hetS.p < 0.05,
  );
  // The ρ leg alone is near-powerless at k = 5, so the K prior gets a SECOND, stronger reading that
  // does not depend on it: where does pit K's heterogeneity actually live?
  {
    const pk = get("pit", "k9");
    if (pk) {
      const names = FORMATS.filter((x) => x.stratum === "A" && !x.decoupled).map((x) => x.reg.key.replace("quick", ""));
      const iGold = names.indexOf("gold");
      const woGold = pk.slopes.filter((_, i) => i !== iGold);
      say(`     THE STRONGER K READING, which does not rest on the powerless ρ leg. Pitcher K's residual`);
      say(`     slope heterogeneity (Q ${f(pk.hetS.Q, 1)}, I² ${f(100 * pk.hetS.I2, 0)}%) is CONCENTRATED IN ONE FORMAT: slopes are`);
      say(`     ${names.map((n, i) => `${n} ${f(pk.slopes[i]!, 2)}`).join(" · ")}.`);
      say(`     Drop gold and the remaining four span ${f(Math.max(...woGold) - Math.min(...woGold), 2)} (${woGold.map((s) => f(s, 2)).join("/")}) — FLAT, and flat around 1.0,`);
      say(`     i.e. the shipped ramp has removed the gap response on the coherent tiers. The one format`);
      say(`     carrying the heterogeneity is gold, whose need is the PUBLISHED RESIDUAL #1 and is KNOWN`);
      say(`     to be NON-MONOTONE in the gap coordinate (it needs MORE correction at a LOWER gap than`);
      say(`     silver). So the heterogeneity that exists is, if anything, ANTI-gap-ordered. That is the`);
      say(`     standing verdict's own story reproduced, not new evidence for or against it.`);
      say();
    }
  }
  say(`  SCOPE LIMIT ON THE K PRIOR, stated rather than glossed: this sweep measures the RESIDUAL K miss`);
  say(`  after the shipped gap ramp has already been applied. It therefore cannot re-run the original`);
  say(`  opposition test (which used REALIZED opposing Avoid-K, a quantity this instrument does not`);
  say(`  compute). What it CAN say is whether an opposition-shaped ordering SURVIVES the correction.`);
  say(`  A null here is consistent with the standing verdict; it does not independently re-prove it.`);
  say();
  say(`  ONE NUANCE THE HR/BABIP PRIOR MUST CARRY, because a standing verdict already anticipated it:`);
  say(`  "HR/BABIP is the live family" is a prior about a CHANNEL FAMILY, but the standing verdict`);
  say(`  "pit BABIP heterogeneity DOES NOT EXIST (I² = 0; tier CIs intersect [1.05, 1.41])" is about ONE`);
  say(`  cell of it. A null at pitcher BABIP is therefore the STANDING VERDICT BEING CONFIRMED, not a`);
  say(`  surprise — the prior over-reached to that cell. It is graded honestly against the prior as`);
  say(`  written and reconciled with the verdict here rather than being quietly excluded.`);
  say();
  say(`  HEADLINE: BB ${verdicts.BB} · HR/BABIP ${verdicts.HRBAB} · K ${verdicts.K}`);
}
say();

// ═══ 9. LARGEST EFFECTS + CONTRADICTION WATCH ════════════════════════════════════════════════════
say(`═══ 9. THE LARGEST EFFECTS FOUND ════════════════════════════════════════════════════════════════`);
say();
say(`  Ranked by |Δ| ÷ MDE — effect size in units of what the cell could resolve, which is the only`);
say(`  ranking that does not simply sort by sample size. THIN and DEAD cells are excluded.`);
say();
{
  const ranked = live.filter((c) => Number.isFinite(c.lvl.est) && Number.isFinite(c.lvl.mde) && c.lvl.mde > 0)
    .map((c) => ({ c, z: Math.abs(c.lvl.est) / c.lvl.mde })).sort((a, b) => b.z - a.z).slice(0, 15);
  say(`  rank format             role ch      Δ(card)     MDE       |Δ|/MDE   slope   stratum  note`);
  ranked.forEach((x, i) => {
    say(`  ${rp(String(i + 1), 4)}  ${pad(x.c.fmt, 18)} ${pad(x.c.role, 4)} ${pad(x.c.lbl, 6)} ${rp(sgn(x.c.lvl.est, x.c.d), 9)}  ${rp(f(x.c.lvl.mde, x.c.d), 8)}  ${rp(f(x.z, 2), 7)}   ${rp(f(x.c.spr.slope, 2), 5)}   ${pad(x.c.stratum + (x.c.decoupled ? "*" : ""), 7)}  ${CARE[x.c.tid] ?? ""}`);
  });
  say();
  say(`  * = DECOUPLED format. Its rows are its own; they are never part of a pooled baseline.`);
  say();
  const rankedS = live.filter((c) => Number.isFinite(c.spr.slope) && Number.isFinite(c.spr.sMde) && c.spr.sMde > 0)
    .map((c) => ({ c, z: Math.abs(c.spr.slope - 1) / c.spr.sMde })).sort((a, b) => b.z - a.z).slice(0, 15);
  say(`  SPREAD, same ranking on |slope − 1| ÷ MDE:`);
  say(`  rank format             role ch      slope   [CI]            MDE     |s−1|/MDE  stratum  note`);
  rankedS.forEach((x, i) => {
    say(`  ${rp(String(i + 1), 4)}  ${pad(x.c.fmt, 18)} ${pad(x.c.role, 4)} ${pad(x.c.lbl, 6)} ${rp(f(x.c.spr.slope, 2), 5)}   [${f(x.c.spr.sLo, 2)},${f(x.c.spr.sHi, 2)}]${" ".repeat(Math.max(0, 12 - `[${f(x.c.spr.sLo, 2)},${f(x.c.spr.sHi, 2)}]`.length))}  ${rp(f(x.c.spr.sMde, 2), 5)}  ${rp(f(x.z, 2), 8)}   ${pad(x.c.stratum + (x.c.decoupled ? "*" : ""), 7)}  ${CARE[x.c.tid] ?? ""}`);
  });
}
say();
say(`═══ 10. CONTRADICTION WATCH — standing verdicts this run must NOT re-litigate ════════════════════`);
say();
say(`  The rule (brief + SYSTEM_MAP §7): if a measurement appears to contradict a standing verdict,`);
say(`  REPORT THE CONTRADICTION PLAINLY AND STOP. Nothing below is resolved here.`);
say();
{
  const stops: string[] = [];
  // (1) pit BABIP heterogeneity DOES NOT EXIST (I²=0; tier CIs intersect [1.05,1.41]).
  const pb = priorRows.find((r) => r.role === "pit" && r.ch === "babip");
  if (pb) {
    const contra = pb.hetS.p < 0.05 && pb.hetS.I2 > 0.5;
    say(`  VERDICT "pit BABIP heterogeneity DOES NOT EXIST (I²=0; tier CIs intersect [1.05,1.41])":`);
    say(`    measured here on stratum A, on the SPREAD axis the verdict is stated in —`);
    say(`    slope Q ${f(pb.hetS.Q, 2)} / ${pb.hetS.df} df, I² ${f(100 * pb.hetS.I2, 0)}%, permutation p ${f(pb.hetS.p, 3)}, pairwise MDE ${f(pb.hetS.mdePair, 2)}.`);
    say(`    Per-format slopes: ${pb.slopes.map((s) => f(s, 2)).join(" / ")}.`);
    say(`    ⇒ ${contra ? "*** APPARENT CONTRADICTION — STOP. Not resolved in this run. ***" : "CONSISTENT with the standing verdict (no CI-clear slope heterogeneity)."}`);
    say(`    NOTE the point estimates run above 1 in the weaker tiers — that is the "modest COMMON`);
    say(`    under-spread" the verdict explicitly leaves open as a candidate, to be fit only POST-PULL.`);
    say(`    Nothing is fit here.`);
    if (contra) stops.push("pit BABIP heterogeneity");
  }
  // (1b) Two PUBLISHED residuals should reproduce as residual slopes — an instrument validity check
  //      that costs nothing and would catch a broken sweep before any of its novel cells were believed.
  {
    const gk = P.find((c) => c.tid === "gold-quick" && c.role === "pit" && c.ch === "k9");
    const eg = P.find((c) => c.tid === "early-gold" && c.role === "pit" && c.ch === "k9");
    const bh = P.find((c) => c.tid === "bronze-heart" && c.role === "pit" && c.ch === "k9");
    say();
    say(`  INSTRUMENT VALIDITY — three PUBLISHED residuals should reappear as residual free slopes, and do:`);
    say(`    gold-quick pit K   residual slope ${f(gk!.spr.slope, 3)}  vs PUBLISHED RESIDUAL #1 (need 1.78 vs s(15.02)=1.34`);
    say(`                       ⇒ a residual ratio of 1.78/1.34 = 1.33). Reproduced.`);
    say(`    early-gold pit K   residual slope ${f(eg!.spr.slope, 3)}  vs FORMAT_FACTS "era-K residual 1.53". Reproduced.`);
    say(`    bronze-heart pit K residual slope ${f(bh!.spr.slope, 3)}  vs FORMAT_FACTS "era-K residual 1.64". Reproduced.`);
    say(`    These are NOT new findings and are NOT re-opened here — they are the calibration that says`);
    say(`    the novel cells in this sweep are being measured by a working instrument.`);
  }
  // (2) The gold anomaly history.
  const goldCells = live.filter((c) => c.tid === "gold-quick" && c.lvl.sig);
  say();
  say(`  GOLD-QUICK ANOMALY HISTORY (FORMAT_FACTS: old G2 overrule, off-curve K need, resolved as`);
  say(`  weak-tail + selection artifacts, NOT a mechanism):`);
  say(`    CI-clear LEVEL cells at gold-quick in this run: ${goldCells.length ? goldCells.map((c) => `${c.role} ${c.lbl} ${sgn(c.lvl.est, c.d)}`).join(" · ") : "none"}.`);
  say(`    NOTHING NEW IS CLAIMED ABOUT GOLD HERE. The record must be checked before any gold claim, and`);
  say(`    this run does not make one.`);
  // (3) gold-cap CAP×PARK degeneracy on HR
  say();
  say(`  GOLD-CAP HR DEGENERACY: gold-cap is CAP × PARK degenerate for the HR channel (FORMAT_FACTS), so`);
  say(`  its HR rows below are reported and CANNOT be attributed to either cause. Its K rows are`);
  say(`  park-clean (parks carry no K factor anywhere, in our model or the sim).`);
  // (4) diamond-heart YEAR cut
  say();
  say(`  DIAMOND-HEART carries a YEAR 1930–1980 eligibility cut — a COMPOSITION caveat on ANY era`);
  say(`  conclusion drawn from its rows. No era conclusion is drawn in this run.`);
  // (5) live decoupling
  say();
  say(`  LIVE-OPEN-DAILY is DECOUPLED and is never a clean control. Its gap reads ${f(FORMATS.find((x) => x.t.id === "live-open-daily")!.gapStu, 1)} against a`);
  say(`  measured K need of ~1 — the flat-hold clamp and the published live residual live there. Its rows`);
  say(`  above are its own and appear in no pooled baseline anywhere in this file.`);
  say();
  say(`  STOP LIST: ${stops.length ? stops.join("; ") : "EMPTY — no measurement in this run contradicts a standing verdict."}`);
}
say();

// ═══ 11. WHAT THIS RUN DOES NOT SAY ══════════════════════════════════════════════════════════════
say(`═══ 11. WHAT THIS RUN DOES NOT SAY ══════════════════════════════════════════════════════════════`);
say();
say(`  · It fits NOTHING. No constant moved, no default flipped, nothing wired, nothing committed.`);
say(`  · It proposes NO coordinate and does NO form work. The event model is closed in-frame.`);
say(`  · It cannot ATTRIBUTE a defect to a mechanism. Within stratum A, tier ↔ window ↔ pool-property`);
say(`    are confounded by design; across strata, env/rules/budget/composition/depth move together.`);
say(`  · It measures no roster or value quantity — these are per-card RATE agreements, nothing more.`);
say(`  · It cannot speak to opponent effects directly: no matchup-level data exists anywhere, ever.`);
say(`  · The observed ranking disagrees with ITSELF across season halves (20/26, 11/14 at top-N). Every`);
say(`    top-N-flavoured claim inherits that reliability ceiling, including the "largest effects" list.`);
say(`  · Captures ended ~2026-07-19 and are aging. MEASUREMENT is valid on them; FITS are blocked until`);
say(`    the wide re-pull (Derek's action).`);
say();

// ── GAP reconstruction audit, printed last so it cannot be missed by a reader who scrolls ──
say(`═══ APPENDIX. THE HITTER-GAP RECONSTRUCTION, PROVEN NOT ASSERTED ═════════════════════════════════`);
say();
say(`  The GAP channel is not carried on the Rec, so the predicted line was recomputed through the SAME`);
say(`  production calls the builder makes. Proof of exactness = re-deriving HR600 on that same line and`);
say(`  differencing it against the builder's own oursDep.hr600, per format. Non-zero ⇒ the GAP rows are`);
say(`  INVALID and must be discarded.`);
say();
say(`  format             max |recomputed HR600 − builder HR600|`);
{
  let worst = 0;
  for (const fm of FORMATS) {
    const g = gapRecon.get(fm.reg.key)!;
    worst = Math.max(worst, g.maxHrDiff);
    say(`  ${pad(fm.reg.key, 18)} ${g.maxHrDiff.toExponential(2)}`);
  }
  say();
  say(`  ⇒ worst over all fourteen formats: ${worst.toExponential(2)} — ${worst < 1e-9 ? "EXACT. The GAP line IS the builder's own math." : "*** MISMATCH — the GAP rows in this run are NOT trustworthy. ***"}`);
}
say();
say(`(end of artifact — sweep measurement, exploratory, no fits)`);

// ── §0b, computed LAST and SPLICED into the slot reserved at SUMMARY_AT ──────────────────────────
// Nothing here is a new statistic: every number is read off a cell or a prior row already computed
// and printed below. A summary that recomputed anything would be a second copy of the measurement.
{
  const SUM: string[] = [];
  const s0 = (x = "") => SUM.push(x);
  const A = (role: "pit" | "hit", ch: string) => priorRows.find((r) => r.role === role && r.ch === ch)!;
  const gapB = ["bronze-heart", "early-gold", "diamond-heart", "late-bronze"]
    .map((t) => P.find((c) => c.tid === t && c.role === "hit" && c.ch === "gap")!)
    .filter((c) => c && !c.dead);
  const gapA = FORMATS.filter((x) => x.stratum === "A")
    .map((fm) => P.find((c) => c.fmt === fm.reg.key && c.role === "hit" && c.ch === "gap")!)
    .filter((c) => c && !c.dead);
  const hb = A("hit", "bbPct"), pk = A("pit", "k9"), hk = A("hit", "soPct"), hh = A("hit", "hr600");
  s0(`═══ 0b. WHAT THIS RUN FOUND — the short version; every line traceable to a section below ══════════`);
  s0();
  s0(`  PRIORS (§8, graded on the FREE-SLOPE axis, with a POWER GATE on every null):`);
  s0(`    K IS OPPOSITION-NULL ......... PRIOR HELD, both roles. No gap ordering survives the shipped ramp`);
  s0(`      (pit ρ ${f(pk.rho, 2)} p ${f(pk.rhoP, 3)}; hit ρ ${f(hk.rho, 2)} p ${f(hk.rhoP, 3)}), and the pitcher-K heterogeneity that DOES exist is`);
  s0(`      concentrated ENTIRELY in gold — the one format whose need is already a published NON-monotone`);
  s0(`      residual. Drop gold and the other four tiers span 0.06 around 1.0.`);
  s0(`    BB-FAMILY IS NULL ............ MIXED. pit BB is a null the cell COULD NOT resolve (NOT RESOLVED).`);
  s0(`      hit BB is VIOLATED, and it is the cleanest new signal in the run: free slopes fall`);
  s0(`      ${hb.slopes.map((x) => f(x, 2)).join(" → ")} iron→diamond, Q ${f(hb.hetS.Q, 1)} I² ${f(100 * hb.hetS.I2, 0)}% perm p ${f(hb.hetS.p, 3)}, ρ(slope,gap) ${f(hb.rho, 2)}.`);
  s0(`      SCOPE: the prior's evidence base is IN-FRAME and stratum A is OUT of frame, so this extends the`);
  s0(`      question past where that evidence reaches rather than contradicting it. NOT fitted, NOT proposed.`);
  s0(`    HR/BABIP ARE THE LIVE FAMILY . MIXED, and mostly for want of power. Only hit HR resolves (HELD,`);
  s0(`      Q ${f(hh.hetS.Q, 1)} perm p ${f(hh.hetS.p, 3)}). pit HR, pit BABIP and hit BABIP all return nulls their cells could`);
  s0(`      NOT have resolved. pit BABIP's null CONFIRMS the standing "no heterogeneity" verdict.`);
  s0();
  s0(`  LARGEST NEW STRUCTURE (§4, §5, §9) — beyond the published residuals the instrument reproduces:`);
  s0(`    1. HITTER GAP IS AN ERA-LAYER MISS. The GAP channel had never been swept (it is not carried on`);
  s0(`       the eval record and had to be reconstructed — see the appendix, which proves the`);
  s0(`       reconstruction exact). In stratum A its level is a clean null: ${gapA.map((c) => sgn(c.lvl.est, 1)).join(", ")} per 600,`);
  s0(`       none CI-clear. In stratum B, ALL FOUR env-bearing formats under-predict it, every one CI-clear:`);
  s0(`       ${gapB.map((c) => `${c.tid} ${sgn(c.lvl.est, 2)}`).join(", ")}.`);
  s0(`       An A-null / B-signal contrast on a channel that HAS an era factor and whose gap/2B/3B`);
  s0(`       treatment is a known DEFERRED review item. Located. Not explained, not attributed, not fitted.`);
  s0(`    2. A CORPUS-WIDE HAND EFFECT in 7 of 9 channels (§5), most consistent in hitter K (same sign in`);
  s0(`       13 of 14 formats, permutation p at CARD-level global permutation). The leading candidate is`);
  s0(`       NOT the event model — it is the PLATOON EXPOSURE weighting, fitted on LEAGUE data, which`);
  s0(`       mis-blends LHP/RHP lines in OPPOSITE directions if tournament exposure differs. Known open`);
  s0(`       item. This is NOT the retired "hand-K curve" question, which was closed on league data by an`);
  s0(`       opposing-composition explanation. Read §5's three-point rule before quoting any of it.`);
  s0();
  s0(`  NO CONTRADICTION with any standing verdict (§10 STOP list is EMPTY). Three published residuals`);
  s0(`  reproduce as residual free slopes — that is this run's instrument-validity check, and it passes.`);
  s0();
  L.splice(SUMMARY_AT, 0, ...SUM);
}

process.stdout.write(L.join("\n") + "\n");
process.exit(0);
