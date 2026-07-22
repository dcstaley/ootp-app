// THE JUDGED-SAMPLE BUILDER — the ONE home for "our predicted line for a cwhit-observed card".
//
// WHY THIS EXISTS: `tools/cwhit-scorecard.ts` originally carried this inline. `tools/cwhit-two-ledger.ts`
// needs the IDENTICAL sample (same model, same neutral env, same own-gap pool transform, same join,
// same well-sampled bar) or its level numbers would not be the ones the scorecard reports and the whole
// diagnostic would be measuring a different thing. Copying the assembly into a second driver is exactly
// the drift failure CLAUDE.md bans for scoring — so it lives here once and both drivers import it.
//
// This is MEASUREMENT plumbing, not scoring: it CONSUMES the scoring core / event model and reshapes
// the output for eval. No scoring math is defined here.
//
// It also exposes, per tier×role, the FULL-POOL predicted distribution per channel (`pool`), which the
// selection test needs: cwhit's tables are the top-100 BY USAGE, so "where does the judged sample sit
// relative to the pool it was drawn from" is only answerable against the whole pool's predictions.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import type { Coeffs, Derived, CalScales } from "../../config/types.ts";
import {
  FIELD_N, computeUnifiedFieldStats, productionFieldStats, buildPoolTransform, applyAffine, calibrate,
  type EventModel, type FieldStats, type PoolTransform, type RatingEnvelope,
} from "../../scoring-core/index.ts";
// Reached into directly rather than re-exported from scoring-core/index.ts: these are the SCORING
// CORE's own internals and this is an EVAL consumer. Widening the public surface for a diagnostic
// would invite non-eval callers to assemble wOBA by hand — the exact thing the one-core rule forbids.
// Importing them here means the deployed line below IS the deployed math, not a copy of it.
import {
  hittingComponents, pitchingComponents, trustedHittingWoba, trustedPitchingSideWoba,
  hittingBsr, assembleRawHittingWoba, assembleRawPitchingWoba,
} from "../../scoring-core/woba.ts";
import type { Card } from "../../data/catalog.ts";
import { makeVariant } from "../../data/variants.ts";
import { PIT_BIP_ADJ, HIT_BIP_ADJ, hRate, type EventForm } from "../../model/curves.ts";
import { applyPitSpread } from "../../model/pool-transform.ts";
import { applyHitTail, type HitTail } from "../../scoring-core/hit-tail.ts";
import { parseCwhitPit, parseCwhitHit } from "./parse.ts";
import { formatByKey, formatByLegacySlug, captureObsPath, captureProjPath, topNView, CAPTURE_DIR_2026_07_21 } from "./corpus.ts";
import { joinCwhit, type JoinCard, type JoinObs } from "./join.ts";
import { hitWobaFromRates, pitWobaFromChannels, type WobaWeights as WW } from "./audit.ts";
import {
  parseCwhitProjPit, parseCwhitProjHit, windowOverlap, xbhNonHrPerPa, soPctPerAbToPerPa, BF_PER_9,
  type CwhitProjMeta,
} from "./scorecard.ts";

export const OBS_DIR = "fixtures/cwhit";
export const PROJ_DIR = "fixtures/cwhit-proj";
/** Re-exported, NOT re-declared (Fable ruling (d)): the ~50 tools that import FIELD_N from this
 *  module keep working, but the value now has exactly one definition, in scoring-core/pool-stats. */
export { FIELD_N };
/** THE FINAL-CONFIG BARS (re-baseline, 2026-07-21). Lowered from 1000/1000 to 600/500 as A/B factor
 *  (iii). BF600 is the noise-equivalent of the old IP>=150 floor once expressed in the correct unit.
 *
 *  WHY THE LEVEL MATTERS MORE THAN THE DEPTH: the A/B measured that going top-100 -> full depth at the
 *  1000 bar adds N only at iron and bronze (+14..+28) and NOTHING at silver/gold/diamond, because those
 *  tiers never had 100 cards above 1000 in the first place. The bar is what reaches them — it roughly
 *  doubles the two thinnest cells (diamond pit 19->36, diamond hit 13->35). Two pre-registered
 *  conditions were written against "deeper data"; their power comes from here, not from depth.
 *
 *  Both bars count OPPONENTS FACED and are symmetric by construction (a pitcher's BF is the
 *  plate-appearance analogue). HISTORY: the pitcher bar was once MIN_IP=1000 compared against IP,
 *  i.e. BF>=4300 — 4.3x too strict and asymmetric with the hitter bar — and it silently fed the
 *  K/HR-spread fits. Fixed 2026-07-21 (d40287a); see also 697cdb2, where the same IP/BF confusion
 *  was found to have survived in every noise call site. */
export const MIN_BF = 600, MIN_PA = 500;
/** The five Quick tiers: known VAL caps + neutral era/park. Daily/Cap formats are out of scope. */
// ── ELIGIBILITY WINDOW (Derek's terminology ruling, 2026-07-20) ──────────────
// "CAP" MEANS SALARY CAP IN OOTP AND NOTHING ELSE. These are card-VALUE tier cutoffs, which is
// a different quantity from `total_cap` (a budget in the same config file), and calling both
// "cap" is how a matched-pair read gets misinterpreted later. Field is `valueMax`.
//
// `valueMin` EXISTS BECAUSE REAL FORMATS HAVE ONE: nightmare-cap is 50–74, cwhit-cap 60–74,
// gold-sporer-sandlot 60–89. The Quick ladder happens to be max-only, so every consumer wrote
// `cardValue <= cap` — which SILENTLY ADMITS INELIGIBLE CARDS BELOW THE MIN the moment a
// min-bearing format is scored. Pools feed the own-gap/spread machinery, so that is a wrong
// number, not a cosmetic one. Use `inValueWindow`; do not re-implement the comparison.
export interface ValueWindow {
  tier: string; valueMin?: number; valueMax: number;
  /** A format's OWN eligibility rules beyond the value window — e.g. bronze-heart's Year 1930-1989,
   *  live-open's Card Type restriction. Absent ⇒ the window is the whole rule, which is true of the
   *  Quick ladder and is why this was not needed until the daily formats came through the builder.
   *
   *  IT LIVES HERE, ON THE WINDOW, BECAUSE ELIGIBILITY IS ONE DECISION. The daily legs of the fit
   *  tools used to apply their own `rowEligible` beside their own join; routing them through the
   *  builder without this would have silently DROPPED the rule and quietly widened those pools. */
  eligible?: (c: Record<string, unknown>) => boolean;
}

export const QUICK: ValueWindow[] = [
  { tier: "iron", valueMax: 59 }, { tier: "bronze", valueMax: 69 }, { tier: "silver", valueMax: 79 },
  { tier: "gold", valueMax: 89 }, { tier: "diamond", valueMax: 99 },
];

/** THE one place that decides whether a card falls in a format's card-value eligibility window.
 *  Mirrors the server's config-level test (server.ts ~line 398, card_value_min/card_value_max). */
export const inValueWindow = (c: Record<string, unknown>, w: ValueWindow): boolean => {
  const v = n_(c["Card Value"]);
  if (!(v <= w.valueMax && (w.valueMin === undefined || v >= w.valueMin))) return false;
  return w.eligible ? w.eligible(c) : true;
};

export const n_ = (v: unknown): number => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
export const handLetter = (c: number): string => (c === 2 ? "L" : c === 3 ? "S" : "R");
export const isPit = (c: Card): boolean => n_(c["Pitcher Role"]) > 0 || String(c["Position"]).trim() === "1";
export const cardName = (c: Card): string => `${(c["FirstName"] ?? "").trim()} ${(c["LastName"] ?? "").trim()}`.trim();

export type Chan = Record<string, number>;
export type Exposure = Map<string, { wR: number; wL: number }>;

/** One judged card: our line, cwhit's observed line, optionally cwhit's projected line. */
export interface Rec {
  tier: string; role: "pit" | "hit";
  /** EXACT card identity, `${Card ID}|${vlvl}` — the same key the builder joins on. Carried so a
   *  consumer can map a matched row back to the catalog card (base) or its v5 variant WITHOUT
   *  re-deriving identity from the name, which is exactly the collision-prone step the fingerprint
   *  join exists to avoid. Load-bearing for variant-aware work: `title` is the BASE title for both
   *  variant levels, so (title) alone cannot distinguish a card from its v5. */
  cid: string;
  title: string; name: string; vlvl: number;
  sample: number;          // BF (pit) or PA (hit) — 'opponents faced', symmetric across roles
  axis: number;            // the headline rating axis (Stuff vR / Power vR) — reported, never joined on
  /** RAW event-model line — THE EVAL FRAME. Derek's call: the anchor/sFinal is a CONVENTION (a readable
   *  scale + the cap optimizer's budget unit), not a prediction, so absolute agreement with cwhit on an
   *  anchored composite is a unit mismatch rather than a defect. Eval judges the unanchored quantity. */
  ours: Chan;
  /** DEPLOYED line (×sFinal) — kept alongside so the calibration's footprint stays checkable. Per-channel
   *  it is identical to `ours` on a neutral env; only the composite differs. Never used for a verdict. */
  oursDep: Chan;
  obs: Chan; proj?: Chan;
  /** cwhit's raw observed row, carried through for the ledger's over-identification checks. */
  raw: Record<string, number>;
  /** Whether this row clears the run's well-sampled floor, decided AT READ TIME against the effective
   *  `minBf`/`minPa`. Present so the ~16 callers that filter with `wellSampled(r)` automatically honour
   *  a widened bar instead of silently re-applying the module defaults to a differently-floored sample. */
  wellSampled?: boolean;
}

/** The full-pool predicted distribution for one tier×role — the reference the top-100 is selected FROM. */
export interface PoolDist { tier: string; role: "pit" | "hit"; n: number; byChannel: Record<string, number[]> }

/** Pitcher spread corrections for the eval line: `s`/`mean` = the K-spread scalar + K̄_pool
 *  (poolMeanKOwn, RAW pre-era own-gap frame); the optional BUILD-3 per-channel siblings carry the
 *  HR9 and BABIP spread scalars about their own pool means (poolPitMeansOwn). Pitcher-ONLY — the
 *  hitter path never sees any of it (the hitter fix is BUILD-2's separate tail workstream).
 *  Absent optional fields ⇒ bit-identical to the K-only seam. */
export interface KSpreadPit { s: number; mean: number; sHr?: number; meanHr?: number; sBab?: number; meanBab?: number }

export interface SampleDeps {
  baseCards: Card[];
  coeffs: Coeffs;
  derived: Derived;
  eventForm: EventForm;
  model: EventModel;
  W: WW;
  ref: FieldStats;
  envelope?: RatingEnvelope;
  pitExp: Exposure;
  hitExp: Exposure;
  /** Optional per-Quick-tier pitcher K-spread (the eval mirror of production `config.kSpread` with
   *  sHit = 1). Present ⇒ ourPit applies it at the PRODUCTION placement (raw K, pre-BIP, pre-era)
   *  and the per-tier calibrate() sees the same correction. Absent ⇒ bit-identical to before. */
  kSpreadPit?: Map<string, KSpreadPit>;
  /** Optional per-Quick-tier BUILD-2 hitter tail correction (the eval mirror of production
   *  `config.hitTail`, built by the ONE `computeHitTail`). Present ⇒ ourHit applies it at the
   *  PRODUCTION placement (applyHitTail on the raw side events, post-model, pre-BIP, pre-era —
   *  the score-card.ts seam) and the per-tier calibrate() sees the same correction. Absent ⇒
   *  bit-identical to before. Hitter-ONLY — the pitcher path never sees it (BUILD-1/3 own pitchers). */
  hitTail?: Map<string, HitTail>;
  /** The value windows to build. Absent ⇒ the five Quick tiers (`QUICK`), i.e. every existing caller
   *  is unchanged.
   *
   *  THIS EXISTS TO RETIRE A MUTATION. `tools/park-hand-contrast.ts` needed to push NON-Quick formats
   *  through this builder under their own resolved coeffs, and — correctly refusing to fork the sample
   *  assembly (that copy is the drift failure CLAUDE.md bans) — reached the only seam available:
   *  `QUICK.splice(0, QUICK.length, ...fm.tiers)` with a restore in a `finally`. That made the module's
   *  exported ladder mutable shared state for the duration of a call, so any concurrent or nested read
   *  of `QUICK` would have seen a foreign list, and an early process exit would have left it swapped.
   *  Passing the list in is the same capability without the shared-state hazard.
   *
   *  ONE CONSTRAINT the caller owns: `kSpreadPit`/`hitTail` are keyed by `tier`. A caller that widens
   *  `formats` MUST widen those maps to match, or the new formats run with corrections SILENTLY OFF
   *  (`.get(tier)` returns undefined ⇒ the identity legs). `buildCwhitSample` reports any such gap in
   *  `notices` rather than leaving it to be discovered in a number. */
  formats?: ValueWindow[];
  /** WHERE the cwhit tables come from, and at what depth. Absent ⇒ `{ kind: "legacy" }`, i.e. the
   *  old top-100 fixtures — every existing caller is unchanged.
   *
   *  ONE CORPUS ON DISK (Fable ruling, 2026-07-21): the full-depth capture is the only stored copy
   *  and the historical top-100 shape is reconstructed AT READ TIME via `topNView`, so the depth
   *  contrast is a knob rather than a second set of files that could drift from the first. */
  source?: CwhitSource;
  /** Read-time well-sampled floors, in OPPONENTS FACED (BF for pitchers, PA for hitters — symmetric
   *  by construction). Absent ⇒ MIN_BF / MIN_PA. Rows below the floor are NOT dropped: they are
   *  flagged via `Rec.wellSampled` and remain available, so a caller can widen the bar without
   *  re-reading the corpus and the thin tail stays inspectable rather than invisible. */
  minBf?: number;
  minPa?: number;
}

/** The corpus a sample is built from.
 *  · `legacy`  — the 2026-07-20-and-earlier top-100 fixtures in `fixtures/cwhit` + `fixtures/cwhit-proj`.
 *  · `capture` — a dated full-depth capture directory, optionally cut to a `topN` DERIVED VIEW.
 *
 *  These are NOT interchangeable and the difference is not only depth: the legacy fixtures cover
 *  2026-06-28..07-12 while the 2026-07-21 capture covers 07-05..07-19. Comparing legacy against the
 *  capture confounds DEPTH with the CAPTURE WINDOW; comparing the capture against its own derived
 *  top-100 isolates depth cleanly. Use the derived view for the depth contrast. */
export type CwhitSource =
  | { kind: "legacy" }
  | { kind: "capture"; dir: string; topN?: number };

/** THE DEFAULT CORPUS (re-baseline, 2026-07-21). Every tool that does not pass `source` explicitly
 *  now reads the FULL-DEPTH 2026-07-21 capture rather than the legacy top-100 fixtures.
 *
 *  This is a MEASUREMENT-CHANGING default, landed deliberately as one event rather than tool by tool:
 *  ~18 tools consume through buildCwhitSample, and a staggered switch would have left them comparing
 *  numbers drawn from two different corpora with nothing in the output saying so. The legacy fixtures
 *  remain readable via `{ kind: "legacy" }` for historical reproduction, and every run prints which
 *  corpus it used.
 *
 *  The legacy fixtures are NOT merely shallower — they cover 2026-06-28..07-12 against the capture's
 *  07-05..07-19, and for gold that is a ONE-DAY overlap. They are a different sample, not a subset. */
export const DEFAULT_SOURCE: CwhitSource = { kind: "capture", dir: CAPTURE_DIR_2026_07_21 };

/** A card's two predicted lines. See `ourPit`/`ourHit` for why BOTH exist and what each answers. */
export interface TwoLines { raw: Chan; dep: Chan; axis: number }

export interface SampleResult {
  recs: Rec[];
  pools: PoolDist[];
  /** The REAL calScales per tier, from `calibrate(basePool, ...)` — reported so the size of the
   *  calibration correction is visible rather than implied. */
  cals: { tier: string; cal: CalScales }[];
  windows: { tier: string; role: string; w: ReturnType<typeof windowOverlap>; meta: CwhitProjMeta; conv: string[] }[];
  notices: string[];
  /** Projection rows matching NO catalog card — a REAL join failure, listed individually. */
  projUnjoinedCatalog: string[];
  /** Eligible catalog cards nobody played — EXPECTED under full-pool projections, counted per cell. */
  projUnobserved: { tier: string; role: string; n: number }[];
  obsFiles: string[];
  projFiles: string[];
  /** What this sample was actually built from + the floors it was built under — reported so a run's
   *  provenance line states its corpus and bar instead of assuming the module defaults. */
  source: CwhitSource;
  floors: { minBf: number; minPa: number };
  /** How the PROJECTION join resolved. `viaTitle > 0` on a capture source means CID lookup missed and
   *  the lossy fallback carried the row — worth knowing, not necessarily wrong. */
  projJoin: ProjJoinAudit;
}

// ── THE TWO LINES: RAW (event-model) vs DEPLOYED (calibrated) ────────────────
//
// These answer DIFFERENT questions and both are reported:
//   RAW — the event model's own output, used directly. Asks "is the model's FORM right?"
//   DEP — what `scoreCard` actually ships: the raw events pushed through the SAME core the app uses
//         (`hittingComponents`/`pitchingComponents` for era/park + the per-event scales, then the
//         `trusted*` assembly with the anchor scalar sFinal). Asks "is the SHIPPED SCORE right?"
//
// WHAT THE CALIBRATION ACTUALLY DOES ON THIS PATH — measured, not assumed (see the tool's §0f, which
// prints these per tier so the claim is checkable rather than trusted):
//   · sBB = sHR = 1 EXACTLY, both roles, every tier. `calibrate.ts` sets `noEvCal = !!eventForm`, and
//     the deployed raw-poly model HAS an eventForm — the per-event calibration was RETIRED under it
//     (its job moved to the rating-space pool transform). So there is no per-event rescale to omit.
//   · era/park factors are ALL exactly 1.0 on the neutral bronze-quick env (era-2010 / park-1), so
//     `hittingComponents` reduces to the identity on BB/SO/HR and re-derives BA/GAP on the same BIP the
//     model used. RAW and DEP per-channel rates therefore coincide on THIS env — but they would NOT on
//     a non-neutral tournament, which is exactly why the deployed path must be the one wired in.
//   · sFinal (hitScaleVR/VL, pitchScale) is REAL but small: 0.974–0.995, not the ~1.15 an older note
//     recorded. It multiplies ONLY the assembled composite — it never touches a per-channel rate.
// ⇒ the per-channel level biases are mathematically INVARIANT to calibration on this env; only the
//   composite wOBA/wOBAA moves. The tool proves this empirically rather than resting on this comment.

/** Pitcher: combined own-gap line → per-9 channels + a proxy wOBAA on OUR weights, RAW and DEPLOYED.
 *  `ks` (optional) = the pitcher K-spread correction, applied EXACTLY where production applies it. */
export function ourPit(c: Card, pt: PoolTransform, d: SampleDeps, cal: CalScales, ks?: KSpreadPit): TwoLines {
  const { wR, wL } = d.pitExp.get(handLetter(n_(c["Throws"]))) ?? { wR: 0.5, wL: 0.5 };
  const thr = n_(c["Throws"]);
  const side = (s: "R" | "L") => {
    const t = pt.pit[s === "R" ? "vR" : "vL"];
    return d.model.predictPitching({
      con: applyAffine(n_(c[`Control v${s}`]), t?.con), stu: applyAffine(n_(c[`Stuff v${s}`]), t?.stu),
      pbabip: applyAffine(n_(c[`pBABIP v${s}`]), t?.pbabip), hrr: applyAffine(n_(c[`pHR v${s}`]), t?.hrr),
    }, d.coeffs);
  };
  const eR = side("R"), eL = side("L");
  // Pitcher spread corrections (eval mirror of the production seam): applyPitSpread is the ONE
  // copy of the order of operations — K about K̄ (BUILD-1 ramp), then HR about HR̄, then BABIP
  // pivoted on the ORIGINAL BIP with the rate move riding e.hMul. All pre-BIP-chain, pre-era —
  // the production placement. The raw line then re-derives non-HR hits from the corrected BIP via
  // the fitted H-curve × hMul — the SAME recompute the deployed pitchingComponents runs — so the
  // raw babip/woba channels stay physical (more K/HR ⇒ fewer BIP ⇒ fewer hits) instead of
  // carrying a stale hit count against a shrunken BIP. (Per-side, because hRate is nonlinear in
  // BIP: correcting the blend instead would be a slightly different number.) K-only ks objects
  // are bit-identical to the pre-BUILD-3 behavior (hMul stays unset ⇒ ×1 exact).
  if (ks && (ks.s !== 1 || (ks.sHr ?? 1) !== 1 || (ks.sBab ?? 1) !== 1)) {
    for (const e of [eR, eL]) {
      applyPitSpread(e, { sPit: ks.s, meanPit: ks.mean, sPitHr: ks.sHr, meanPitHr: ks.meanHr, sPitBab: ks.sBab, meanPitBab: ks.meanBab });
      const bip = Math.max(600 - e.BB - e.K - e.HR - PIT_BIP_ADJ, 1);
      e.nHH = hRate(d.eventForm.pit.h, e.pbabipSC, bip) * (e.hMul ?? 1);
      e.XBH = e.nHH * 0.25; // the model's fixed pitcher XBH share (raw-poly.ts)
    }
  }
  const per9 = BF_PER_9 / 600;

  // RAW — the event model's own numbers, used directly.
  const BB = wR * eR.BB + wL * eL.BB, K = wR * eR.K + wL * eL.K, HR = wR * eR.HR + wL * eL.HR, nHH = wR * eR.nHH + wL * eL.nHH;
  const BIP = Math.max(600 - BB - K - HR - PIT_BIP_ADJ, 1);
  const rawCh = { k9: K * per9, bb9: BB * per9, hr9: HR * per9, babip: nHH / BIP };
  const raw = { ...rawCh, woba: pitWobaFromChannels(rawCh.k9, rawCh.bb9, rawCh.hr9, rawCh.babip, d.W) };

  // DEPLOYED — through the scoring core's own component recompute + trusted assembly.
  const kR = pitchingComponents(eR, cal.pBBScaleVR ?? 1, cal.pHRScaleVR ?? 1, "vR", d.coeffs, d.derived, d.eventForm);
  const kL = pitchingComponents(eL, cal.pBBScaleVL ?? 1, cal.pHRScaleVL ?? 1, "vL", d.coeffs, d.derived, d.eventForm);
  const dBB = wR * kR.BB_fin + wL * kL.BB_fin;
  const dK = (wR * eR.K + wL * eL.K) * d.coeffs.era_k;
  const dHR = wR * kR.HR_fin + wL * kL.HR_fin;
  const dNHH = wR * (kR.oneB_fin + kR.XBH_fin) + wL * (kL.oneB_fin + kL.XBH_fin);
  const dBIP = Math.max(600 - dBB - dK - dHR - PIT_BIP_ADJ * d.derived.era_bip_adj, 1);
  // The composite comes from the trusted assembly (which applies sFinal), blended by the same exposure
  // weights as the channels — NOT re-assembled here. Assembling it by hand would be a second copy.
  const wobaDep = wR * trustedPitchingSideWoba(eR, assembleRawPitchingWoba(eR, 1, d.coeffs), thr, "vR", d.coeffs, d.derived, cal, d.eventForm)
    + wL * trustedPitchingSideWoba(eL, assembleRawPitchingWoba(eL, 1, d.coeffs), thr, "vL", d.coeffs, d.derived, cal, d.eventForm);
  const dep = { k9: dK * per9, bb9: dBB * per9, hr9: dHR * per9, babip: dNHH / dBIP, woba: wobaDep };

  return { raw, dep, axis: n_(c["Stuff vR"]) };
}

/** Hitter: combined own-gap line → per-PA channels + wOBA (BATTING-ONLY, to match cwhit), RAW and DEPLOYED.
 *  `ht` (optional) = the BUILD-2 hitter tail correction, applied EXACTLY where production applies it. */
export function ourHit(c: Card, pt: PoolTransform, d: SampleDeps, cal: CalScales, ht?: HitTail): TwoLines {
  const { wR, wL } = d.hitExp.get(handLetter(n_(c["Bats"]))) ?? { wR: 0.5, wL: 0.5 };
  const bats = n_(c["Bats"]);
  const speed = n_(c["Speed"]), stealRate = n_(c["Steal Rate"]), steal = n_(c["Stealing"]), run = n_(c["Baserunning"]);
  const side = (s: "R" | "L") => {
    const t = pt.hit[s === "R" ? "vR" : "vL"];
    return d.model.predictHitting({
      eye: applyAffine(n_(c[`Eye v${s}`]), t?.eye), pow: applyAffine(n_(c[`Power v${s}`]), t?.pow),
      kRat: applyAffine(n_(c[`Avoid K v${s}`]), t?.kRat), babip: applyAffine(n_(c[`BABIP v${s}`]), t?.babip),
      gap: applyAffine(n_(c[`Gap v${s}`]), t?.gap), speed, steal, run,
    }, d.coeffs);
  };
  const eR = side("R"), eL = side("L");
  // BUILD-2 hitter tail correction (eval mirror of the production seam): applyHitTail is the ONE
  // copy of the order of operations — SO′/HR′ from their own channels, then BABIP measured on the
  // ORIGINAL BIP, corrected, re-applied on the NEW BIP with the rate move riding e.hMul (the
  // deployed hittingComponents carrier). Per-side, post-model, pre-BIP-chain, pre-era — exactly
  // score-card.ts. The RAW line below then reads the corrected oneB/GAP/SO/HR directly, and the
  // DEPLOYED line's hittingComponents/trusted assembly picks the BABIP leg up via e.hMul.
  if (ht) { applyHitTail(eR, ht); applyHitTail(eL, ht); }

  // RAW.
  const BB = wR * eR.BB + wL * eL.BB, SO = wR * eR.SO + wL * eL.SO, HR = wR * eR.HR + wL * eL.HR;
  const oneB = wR * eR.oneB + wL * eL.oneB, GAP = wR * eR.GAP + wL * eL.GAP;
  const BIP = Math.max(600 - BB - SO - HR - HIT_BIP_ADJ, 1);
  const raw = {
    bbPct: BB / 6, soPct: SO / 6, hr600: HR, babip: (oneB + GAP) / BIP,
    woba: (d.W.bb * BB + d.W.hbp * 6 + d.W.b1 * oneB + d.W.xbh * GAP + d.W.hr * HR) / 600,
  };

  // DEPLOYED.
  const kR = hittingComponents(eR, cal.hitBBScaleVR ?? 1, cal.hitHRScaleVR ?? 1, bats, "vR", d.coeffs, d.derived, d.eventForm);
  const kL = hittingComponents(eL, cal.hitBBScaleVL ?? 1, cal.hitHRScaleVL ?? 1, bats, "vL", d.coeffs, d.derived, d.eventForm);
  const dBB = wR * kR.BB_fin + wL * kL.BB_fin;
  const dSO = (wR * eR.SO + wL * eL.SO) * d.coeffs.era_k;
  const dHR = wR * kR.HR_fin + wL * kL.HR_fin;
  const dOneB = wR * kR.oneB_fin + wL * kL.oneB_fin, dGAP = wR * kR.GAP_fin + wL * kL.GAP_fin;
  const dBIP = Math.max(600 - dBB - dSO - dHR - HIT_BIP_ADJ * d.derived.era_bip_adj, 1);
  // BATTING-ONLY, exactly as score-card derives its `woba_*` split: offense − bsr. cwhit's wOBA is
  // batting-only, so this is the like-for-like metric; our Offense score is NOT comparable to it.
  const battingSide = (e: Parameters<typeof trustedHittingWoba>[0], s: "vR" | "vL") =>
    trustedHittingWoba(e, assembleRawHittingWoba(e, 1, speed, stealRate, steal, run, d.coeffs), bats, s, d.coeffs, d.derived, cal, d.eventForm, speed, stealRate, steal, run)
    - hittingBsr(speed, stealRate, steal, run, d.coeffs, cal);
  const dep = {
    bbPct: dBB / 6, soPct: dSO / 6, hr600: dHR, babip: (dOneB + dGAP) / dBIP,
    woba: wR * battingSide(eR, "vR") + wL * battingSide(eL, "vL"),
  };

  return { raw, dep, axis: n_(c["Power vR"]) };
}

/** Does this row clear the well-sampled floor? Prefers the flag the builder computed from the RUN's
 *  effective floors, falling back to the module defaults for a `Rec` built before floors were
 *  configurable. Keeping the free-function shape means no caller had to change. */
/**
 * THE observed-table path for a format slug, under a given source (default: the run's DEFAULT_SOURCE).
 *
 * WHY THIS IS EXPORTED. Three tools score the Quick tiers through `buildCwhitSample` but read their
 * daily / weird-env formats by hand-building a LEGACY path (`fixtures/cwhit/cwhit-<slug>-<role>.tsv`),
 * bypassing the builder entirely. That was harmless while the builder also defaulted to legacy. The
 * moment DEFAULT_SOURCE moved to the capture it became a MIXED-CORPUS comparison: Quick tiers on
 * 2026-07-05..07-19 against dailies on 2026-06-28..07-12 — two different windows, in one table, with
 * nothing in the output saying so. Routing every such read through here means the daily leg follows
 * whatever corpus the Quick leg is using, by construction rather than by remembering.
 *
 * Returns null for a slug the registry does not know under a capture source, so the caller can say
 * which format is missing instead of failing on an unreadable path.
 */
export function obsTablePath(legacySlug: string, role: "pit" | "hit", source: CwhitSource = DEFAULT_SOURCE): string | null {
  if (source.kind === "legacy") return `${OBS_DIR}/cwhit-${legacySlug}-${role}.tsv`;
  const f = formatByLegacySlug(legacySlug);
  return f ? captureObsPath(source.dir, f, role) : null;
}

export const wellSampled = (r: Rec): boolean =>
  r.wellSampled ?? (r.role === "pit" ? r.sample >= MIN_BF : r.sample >= MIN_PA);

/**
 * Build the judged sample: for every Quick tier × role with an observed fixture, join cwhit's observed
 * table to our catalog (via the EXISTING fingerprint join — not rebuilt) and attach our predicted line
 * and, when the fixture exists, cwhit's projected line. Also returns the full-pool predicted
 * distribution per tier×role.
 */
/** Projection JOIN KEY. CID when the table has one (the 2026-07-21 captures do), else the title.
 *  WHY CID IS PRIMARY, measured not assumed: the capture's `Name` column is HTML-escaped where our
 *  catalog's title is not, so a raw title compare drops 101 distinct names / 577 rows across the five
 *  Quick tiers — silently, as a smaller Section A rather than an error. `unescapeName` in scorecard.ts
 *  repairs that for the fallback, but one card (CID 86244) was also RENAMED between the capture and
 *  the catalog, which no title normalisation can fix and CID handles for free. Verified 1:1 at the
 *  VARIANT grain: VLvl is exactly {0,5}, (CID,VLvl) is unique in all 28 files, and all 3521 CIDs
 *  resolve into the 3669-card catalog. CID ALONE IS NOT UNIQUE — a card appears once per variant
 *  level with different projected values (iron pit: 800 rows over 554 CIDs, 246 of them twice), so
 *  the VLvl component is load-bearing, not decoration. */
const projKey = (r: { cid?: string; title: string; vlvl: number }): string =>
  r.cid ? `${r.cid}|${r.vlvl}` : `${r.title}|${r.vlvl}`;

export interface ProjJoinAudit { viaCid: number; viaTitle: number; missed: number; used: Set<string> }

/** Our card's `cid` is already `${Card ID}|${vlvl}`, i.e. the CID key shape — so the primary lookup is
 *  a direct hit. Falls back to the title key for the legacy fixtures, which carry no CID column. */
function lookupProj(
  projBy: Map<string, Chan> | null, cardCid: string, title: string, vlvl: number, audit: ProjJoinAudit,
): Chan | undefined {
  if (!projBy) return undefined;
  const byCidHit = projBy.get(cardCid);
  if (byCidHit) { audit.viaCid++; audit.used.add(cardCid); return byCidHit; }
  const tk = `${title}|${vlvl}`;
  const byTitle = projBy.get(tk);
  if (byTitle) { audit.viaTitle++; audit.used.add(tk); return byTitle; }
  audit.missed++; return undefined;
}

/**
 * Split the projection rows that no observed card consumed into the TWO things they actually are.
 *
 * Under the legacy top-100 fixtures these were one bucket and that was defensible: both tables were
 * 100-row cuts, so a projection row without an observed partner was mostly a selection artifact. Under
 * FULL-POOL projections the bucket is dominated by cards nobody played — bronze proj carries 1424
 * pitcher rows against 357 observed — and burying a genuine catalog-join failure inside a four-figure
 * count of normal non-usage is how a real defect becomes invisible.
 *
 *   projUnjoinedCatalog — a projection row that matches nothing in THIS tier x role's eligible pool.
 *                         NOT necessarily a catalog miss: `byCid` is scoped by value window AND by our
 *                         `isPit` role split, so a card cwhit files as a pitcher and we classify as a
 *                         hitter (or vice versa) lands here too. Measured 2026-07-21: 784 such rows at
 *                         the final config, while an independent check found all 3521 projection CIDs
 *                         DO resolve to catalog cards — so this bucket is dominated by role/window
 *                         classification differences, not by unidentifiable cards. Reported
 *                         individually because it is the only place such a difference is visible.
 *   projUnobserved      — an eligible card in our own pool that nobody used. EXPECTED. Counted only.
 *
 * The distinguishing information was always present at the call site and merely not passed in: `byCid`
 * is the complete set of catalog-eligible `${Card ID}|${vlvl}` keys for this tier x role, and it is the
 * SAME key shape `projKey` emits for a capture row — which is exactly why lookupProj's primary lookup
 * is a direct hit. On the LEGACY source the projection tables carry no CID, so keys are `title|vlvl`
 * and catalog membership is tested through the titles instead.
 */
function recordUnjoined(
  projBy: Map<string, Chan>, used: Set<string>,
  byCid: Map<string, { title: string; vlvl: number }>,
  tier: string, role: "pit" | "hit",
  outCatalog: string[], outUnobserved: { tier: string; role: string; n: number }[],
): void {
  const titleKeys = new Set<string>();
  for (const v of byCid.values()) titleKeys.add(`${v.title}|${v.vlvl}`);
  let unobserved = 0;
  for (const k of projBy.keys()) {
    if (used.has(k)) continue;
    const inCatalog = byCid.has(k) || titleKeys.has(k);
    if (inCatalog) unobserved++;
    else outCatalog.push(`${tier} ${role}: ${k}`);
  }
  if (unobserved) outUnobserved.push({ tier, role, n: unobserved });
}

export function buildCwhitSample(d: SampleDeps): SampleResult {
  const src = d.source ?? DEFAULT_SOURCE;
  const minBf = d.minBf ?? MIN_BF, minPa = d.minPa ?? MIN_PA;
  // The derived top-N cut, applied to PARSED rows. `undefined` on the legacy source because those
  // fixtures are ALREADY a top-100 capture — re-cutting them would be a second, silent selection.
  const topN = src.kind === "capture" ? src.topN : undefined;

  // Path resolution per source. A capture resolves the tier through the corpus REGISTRY, so a format
  // the registry does not know is reported rather than silently reading nothing — an existsSync miss
  // looks identical to "this tier has no data".
  //
  // THE TIER STRING IS THE LEGACY SLUG *OR* THE REGISTRY KEY. It used to be the legacy slug ONLY,
  // which made FIVE of the fourteen captured formats unreachable through this builder: `legacySlug`
  // is optional by design (it records the slug a format carried in the OLD top-100 fixtures, and
  // diamond-heart / late-bronze / bronze-cap-weekly / gold-slots / live-open-daily never had one).
  // A caller naming those formats got `null` and a "not in the corpus registry" notice for a format
  // that IS in the registry and DOES have a capture on disk. Falling back to `formatByKey` costs
  // nothing for existing callers (a key lookup only runs when the slug lookup misses) and cannot
  // collide: the only two strings that are both a key and a legacy slug — `goldcapdaily` and
  // `diamondcapdaily` — belong to the same format under either lookup.
  const registryFor = (tier: string) => formatByLegacySlug(tier) ?? formatByKey(tier);
  const obsPathOf = (tier: string, role: "pit" | "hit"): string | null => {
    if (src.kind === "legacy") return `${OBS_DIR}/cwhit-${tier}-${role}.tsv`;
    const f = registryFor(tier); return f ? captureObsPath(src.dir, f, role) : null;
  };
  const projPathOf = (tier: string, role: "pit" | "hit"): string | null => {
    if (src.kind === "legacy") return `${PROJ_DIR}/cwhit-${tier}-${role}-proj.tsv`;
    const f = registryFor(tier); return f ? captureProjPath(src.dir, f, role) : null;
  };

  const obsDir = src.kind === "legacy" ? OBS_DIR : src.dir;
  const projDir = src.kind === "legacy" ? PROJ_DIR : `${src.dir}/proj`;
  const obsFiles = existsSync(obsDir) ? readdirSync(obsDir) : [];
  const projFiles = existsSync(projDir) ? readdirSync(projDir) : [];
  const hasObs = (tier: string, role: "pit" | "hit") => { const p = obsPathOf(tier, role); return !!p && existsSync(p); };
  const projFile = (tier: string, role: "pit" | "hit") => { const p = projPathOf(tier, role); return p && existsSync(p) ? p : null; };

  const projJoin: ProjJoinAudit = { viaCid: 0, viaTitle: 0, missed: 0, used: new Set() };
  const recs: Rec[] = [];
  const pools: PoolDist[] = [];
  const cals: { tier: string; cal: CalScales }[] = [];
  const windows: SampleResult["windows"] = [];
  const notices: string[] = [];
  const projUnjoinedCatalog: string[] = [];
  const projUnobserved: { tier: string; role: string; n: number }[] = [];

  const formats = d.formats ?? QUICK;
  // A caller that widened `formats` but not the correction maps would score the new formats with the
  // corrections silently off. That is a wrong number, not a missing feature, so say so out loud.
  if (d.kSpreadPit || d.hitTail) {
    for (const w of formats) {
      if (d.kSpreadPit && !d.kSpreadPit.has(w.tier)) notices.push(`format "${w.tier}" has NO kSpreadPit entry while other formats do → its pitchers run with the K/HR/BABIP spread corrections OFF`);
      if (d.hitTail && !d.hitTail.has(w.tier)) notices.push(`format "${w.tier}" has NO hitTail entry while other formats do → its hitters run with the BUILD-2 tail correction OFF`);
    }
  }

  for (const win of formats) {
    const { tier } = win;
    const basePool = d.baseCards.filter((c) => inValueWindow(c, win));
    // MIRRORS PRODUCTION EXACTLY (2026-07-22 instrument correction). This used to build a
    // variant-free field at an unscaled FIELD_N while production had moved to the presence-weighted
    // construction, so the eval instrument measured a different coordinate from the one production
    // scored on. `productionFieldStats` is now the single definition both call.
    const pt = buildPoolTransform(d.ref, productionFieldStats(basePool, d.coeffs, d.model), d.envelope);
    // Optional pitcher spread + hitter tail for this tier — threaded into calibrate too (production
    // computes the anchor on the SAME corrected events the scores use). sHit=1 ⇒ the hitter K leg is
    // untouched (applyKSpread short-circuits s===1 to the exact raw K); the BUILD-3 HR/BABIP fields
    // ride along so the anchor matches production (absent ⇒ exact identity legs).
    const ks = d.kSpreadPit?.get(tier);
    const ht = d.hitTail?.get(tier);
    const kSpread = ks ? { sHit: 1, sPit: ks.s, meanHit: 0, meanPit: ks.mean, sPitHr: ks.sHr, meanPitHr: ks.meanHr, sPitBab: ks.sBab, meanPitBab: ks.meanBab } : undefined;
    // The REAL per-tier calibration — same call the deployed path makes (cf. tools/cwhit-bsr-validate.ts).
    const cal = calibrate(basePool, { coeffs: d.coeffs, derived: d.derived, eventForm: d.eventForm, poolTransform: pt, kSpread, hitTail: ht });
    cals.push({ tier, cal });

    for (const role of ["pit", "hit"] as const) {
      if (!hasObs(tier, role)) {
        notices.push(obsPathOf(tier, role) === null
          ? `format "${tier}" is not in the corpus registry (src/eval/cwhit/corpus.ts) → no capture path exists for it, tier×role skipped`
          : `no observed table at ${obsPathOf(tier, role)} → tier×role skipped entirely`);
        continue;
      }
      // Per-tier×role: the SAME CID appears in several tiers' projection tables, so a global
      // used-set would let a hit in one tier mark another tier's key as consumed.
      projJoin.used.clear();

      // our side: base (VLvl 0) + v5 variant, keyed by (title, vlvl) — the projected join key.
      const cards: JoinCard[] = [];
      const byCid = new Map<string, { title: string; vlvl: number; ours: Chan; oursDep: Chan; axis: number }>();
      const poolCh: Record<string, number[]> = {};
      for (const bc of d.baseCards) {
        for (const [vlvl, c] of [[0, bc], [5, makeVariant(bc)]] as const) {
          if (!inValueWindow(c, win)) continue;
          if (role === "pit" ? !isPit(c) : isPit(c)) continue;
          const cid = `${bc["Card ID"]}|${vlvl}`;
          const p = role === "pit" ? ourPit(c, pt, d, cal, ks) : ourHit(c, pt, d, cal, ht);
          // IDENTITY MUST NOT DEPEND ON THE CORRECTION UNDER TEST.
          // The join fingerprint lives in EVENT space (cwhit publishes no ratings, so our side has to
          // meet the observed side there), and it used to be built from the CORRECTED line `p.raw`.
          // That made the matched SAMPLE a function of which corrections were active: applying the
          // K-spread ramp moves predicted K/BABIP enough to change collision disambiguation, so two
          // rows that were dropped as ambiguous became separable and joined. Measured: bronze pit
          // 337 rows uncorrected vs 339 with the ramp — and BOTH extra rows are "Bob Miller", the
          // exact 3-way name collision join.ts documents. That is how the two fit tools came to
          // report different N (156 vs 158) over the same corpus and floors: one builds its sample
          // pre-correction, the other with the shipped ramp.
          // It is also circular — the sample a correction is measured on must not be selected by that
          // correction — so the fingerprint is built from the UNCORRECTED line. Reused directly when
          // no correction is active, so the common path costs nothing.
          const pFp = (ks || ht) ? (role === "pit" ? ourPit(c, pt, d, cal) : ourHit(c, pt, d, cal)) : p;
          // The JOIN fingerprint rides the same line the audit judges. Immaterial either way: the two
          // lines coincide per-channel on a neutral env (sBB=sHR=1, era/park=1) — the tool proves it.
          const fp = role === "pit"
            ? { primary: [Math.max(0, Math.min(1, (n_(c["Stamina"]) - 20) / 40)), pFp.raw.babip!], validate: [pFp.raw.k9!, pFp.raw.bb9!, pFp.raw.hr9!] }
            : { primary: [pFp.raw.babip!], validate: [pFp.raw.bbPct!, pFp.raw.soPct!, pFp.raw.hr600!] };
          cards.push({ cid, name: cardName(c), val: n_(c["Card Value"]), vlvl, hand: handLetter(n_(c[role === "pit" ? "Throws" : "Bats"])), ...fp });
          byCid.set(cid, { title: String(bc["//Card Title"]), vlvl, ours: p.raw, oursDep: p.dep, axis: p.axis });
          // POOL reference: VLvl-0 only. cwhit's format pool is the CARD pool, and counting each card
          // twice (base + v5) would shift the pool mean toward the variant and fake a selection gap.
          if (vlvl === 0) for (const [k, v] of Object.entries(p.raw)) (poolCh[k] ??= []).push(v);
        }
      }
      pools.push({ tier, role, n: (poolCh[role === "pit" ? "k9" : "bbPct"] ?? []).length, byChannel: poolCh });

      // projected side (optional): (title|vlvl) → his channels, in OUR units.
      const pf = projFile(tier, role);
      let projBy: Map<string, Chan> | null = null;
      // The path is asked for, not re-templated: this message used to hard-code the LEGACY template
      // and so named a file that does not exist under a capture source.
      if (!pf) { notices.push(`no projected fixture ${projPathOf(tier, role) ?? "(unresolvable path)"} → ${tier} ${role} runs on the OBSERVED-ONLY axis (ours vs observed)`); }
      else {
        projBy = new Map();
        const conv: string[] = [];
        let meta: CwhitProjMeta;
        if (role === "pit") {
          const p0 = parseCwhitProjPit(readFileSync(pf, "utf8"), pf); meta = p0.meta;
          const p = { ...p0, rows: topNView(p0.rows, "proj", "pit", topN) };
          conv.push(`K/BB/HR %-columns read as per-BATTER-FACED (per-PA), converted to per-9 with BF/9=${BF_PER_9.toFixed(1)} — the SAME constant our per-600 line uses, so the constant cancels in ours-vs-cwhit and touches only the vs-observed LEVEL`);
          for (const r of p.rows) projBy.set(projKey(r), { k9: r.kPerPa * BF_PER_9, bb9: r.bbPerPa * BF_PER_9, hr9: r.hrPerPa * BF_PER_9, babip: r.babip, woba: pitWobaFromChannels(r.kPerPa * BF_PER_9, r.bbPerPa * BF_PER_9, r.hrPerPa * BF_PER_9, r.babip, d.W) });
        } else {
          const p0 = parseCwhitProjHit(readFileSync(pf, "utf8"), pf); meta = p0.meta;
          const p = { ...p0, rows: topNView(p0.rows, "proj", "hit", topN) };
          if (p.rows[0]) { conv.push(`SO: ${p.rows[0].soConvention}`); conv.push(`HR: ${p.rows[0].hrConvention}`); conv.push(`XBH: ${p.rows[0].xbhConvention}`); }
          conv.push(`his pwOBA column NOT used as truth; wOBA recomputed from his projected events with OUR weights, BATTING-ONLY (no BsR) to match his convention and our woba_* metric — never our Offense score`);
          for (const r of p.rows) {
            const hrPa = r.hrPer600 / 600;
            const bip = Math.max(1 - r.bbPerPa - 0.008 - r.kPerPa - hrPa, 0.01);
            const nonHR = r.babip * bip, H = nonHR + hrPa;
            const xbh = Number.isFinite(r.xbhPct) ? xbhNonHrPerPa(r.xbhPct, H, hrPa) : 0.30 * nonHR;
            projBy.set(projKey(r), {
              bbPct: r.bbPerPa * 100, soPct: r.kPerPa * 100, hr600: r.hrPer600, babip: r.babip,
              woba: d.W.bb * r.bbPerPa + d.W.hbp * 0.008 + d.W.b1 * Math.max(nonHR - xbh, 0) + d.W.xbh * xbh + d.W.hr * hrPa,
            });
          }
        }
        const op = obsPathOf(tier, role)!;
        const parsed = role === "pit" ? parseCwhitPit(readFileSync(op, "utf8")).meta : parseCwhitHit(readFileSync(op, "utf8")).meta;
        windows.push({ tier, role, meta, conv, w: windowOverlap(parsed.coverageFrom, parsed.coverageTo, meta.trainFrom, meta.trainTo) });
      }

      // observed → our cards (the EXISTING fingerprint join; not rebuilt).
      if (role === "pit") {
        const rows = topNView(parseCwhitPit(readFileSync(obsPathOf(tier, "pit")!, "utf8")).rows, "obs", "pit", topN);
        const obs: JoinObs<typeof rows[0]>[] = rows.map((r) => ({ name: r.name, val: r.val, vlvl: r.vlvl, hand: r.hand, primary: [r.gsPer, r.babip], validate: [r.k9, r.bb9, r.hr9], sample: r.bf, row: r }));
        const j = joinCwhit(obs, cards);
        for (const m of j.matched) {
          const our = byCid.get(m.card.cid)!, o = m.obs.row;
          recs.push({
            tier, role, cid: m.card.cid, title: our.title, name: o.name, vlvl: our.vlvl, sample: o.bf, axis: our.axis, ours: our.ours, oursDep: our.oursDep,
            obs: { k9: o.k9, bb9: o.bb9, hr9: o.hr9, babip: o.babip, woba: pitWobaFromChannels(o.k9, o.bb9, o.hr9, o.babip, d.W) },
            proj: lookupProj(projBy, m.card.cid, our.title, our.vlvl, projJoin), wellSampled: o.bf >= minBf,
            raw: { ip: o.ip, k9: o.k9, bb9: o.bb9, hr9: o.hr9, babip: o.babip, ra9: o.ra9, era: o.era, gsPer: o.gsPer, ipPerGame: o.ipPerGame },
          });
        }
        if (projBy) recordUnjoined(projBy, projJoin.used, byCid, tier, role, projUnjoinedCatalog, projUnobserved);
      } else {
        const rows = topNView(parseCwhitHit(readFileSync(obsPathOf(tier, "hit")!, "utf8")).rows, "obs", "hit", topN);
        const obs: JoinObs<typeof rows[0]>[] = rows.map((r) => ({ name: r.name, val: r.val, vlvl: r.vlvl, hand: r.hand, primary: [r.babip], validate: [r.bbPct, r.soPct, r.hr600], sample: r.pa, row: r }));
        const j = joinCwhit(obs, cards);
        for (const m of j.matched) {
          const our = byCid.get(m.card.cid)!, o = m.obs.row;
          // cwhit's observed SO% is K/AB → convert to our K/PA convention before ANY comparison.
          const soPa = soPctPerAbToPerPa(o.soPct, o.avg, o.obp, o.bbPct);
          recs.push({
            tier, role, cid: m.card.cid, title: our.title, name: o.name, vlvl: our.vlvl, sample: o.pa, axis: our.axis, ours: our.ours, oursDep: our.oursDep,
            obs: { bbPct: o.bbPct, soPct: soPa, hr600: o.hr600, babip: o.babip, woba: hitWobaFromRates({ ...o, soPct: soPa }, d.W) },
            proj: lookupProj(projBy, m.card.cid, our.title, our.vlvl, projJoin), wellSampled: o.pa >= minPa,
            raw: { pa: o.pa, avg: o.avg, obp: o.obp, slg: o.slg, bbPct: o.bbPct, soPctPerAb: o.soPct, soPctPerPa: soPa, hr600: o.hr600, babip: o.babip, xbhPct: o.xbhPct, tripleXbh: o.tripleXbh },
          });
        }
        if (projBy) recordUnjoined(projBy, projJoin.used, byCid, tier, role, projUnjoinedCatalog, projUnobserved);
      }
    }
  }
  if (projJoin.viaCid || projJoin.viaTitle)
    notices.push(`projection join: ${projJoin.viaCid} via CID+VLvl, ${projJoin.viaTitle} via title fallback, ${projJoin.missed} observed rows with no projection`);
  return { recs, pools, cals, windows, notices, projUnjoinedCatalog, projUnobserved, obsFiles, projFiles, source: src, floors: { minBf, minPa }, projJoin };
}
