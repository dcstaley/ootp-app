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
  computeUnifiedFieldStats, buildPoolTransform, applyAffine, calibrate,
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
import { applyKSpread } from "../../model/pool-transform.ts";
import { parseCwhitPit, parseCwhitHit } from "./parse.ts";
import { joinCwhit, type JoinCard, type JoinObs } from "./join.ts";
import { hitWobaFromRates, pitWobaFromChannels, type WobaWeights as WW } from "./audit.ts";
import {
  parseCwhitProjPit, parseCwhitProjHit, windowOverlap, xbhNonHrPerPa, soPctPerAbToPerPa, BF_PER_9,
  type CwhitProjMeta,
} from "./scorecard.ts";

export const OBS_DIR = "fixtures/cwhit";
export const PROJ_DIR = "fixtures/cwhit-proj";
export const FIELD_N = 50;
/** "Well-sampled" bars, carried from the v1 triangulation for continuity. */
export const MIN_IP = 1000, MIN_PA = 1000;
/** The five Quick tiers: known VAL caps + neutral era/park. Daily/Cap formats are out of scope. */
export const QUICK: { tier: string; cap: number }[] = [
  { tier: "iron", cap: 59 }, { tier: "bronze", cap: 69 }, { tier: "silver", cap: 79 },
  { tier: "gold", cap: 89 }, { tier: "diamond", cap: 99 },
];

export const n_ = (v: unknown): number => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
export const handLetter = (c: number): string => (c === 2 ? "L" : c === 3 ? "S" : "R");
export const isPit = (c: Card): boolean => n_(c["Pitcher Role"]) > 0 || String(c["Position"]).trim() === "1";
export const cardName = (c: Card): string => `${(c["FirstName"] ?? "").trim()} ${(c["LastName"] ?? "").trim()}`.trim();

export type Chan = Record<string, number>;
export type Exposure = Map<string, { wR: number; wL: number }>;

/** One judged card: our line, cwhit's observed line, optionally cwhit's projected line. */
export interface Rec {
  tier: string; role: "pit" | "hit";
  title: string; name: string; vlvl: number;
  sample: number;          // IP (pit) or PA (hit)
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
}

/** The full-pool predicted distribution for one tier×role — the reference the top-100 is selected FROM. */
export interface PoolDist { tier: string; role: "pit" | "hit"; n: number; byChannel: Record<string, number[]> }

/** Pitcher K-spread correction for the eval line: `s` = the spread scalar (s(gap) from the fitted
 *  ramp), `mean` = K̄_pool per 600 in the RAW pre-era own-gap frame (poolMeanKOwn). Pitcher-ONLY —
 *  the hitter path never sees it (the hitter fix is BUILD-2's separate tail-form workstream). */
export interface KSpreadPit { s: number; mean: number }

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
}

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
  projUnjoined: string[];
  obsFiles: string[];
  projFiles: string[];
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
  // Pitcher K-spread (eval mirror of score-card.ts line "if (kSpread) e.K = applyKSpread(...)"):
  // rescale the RAW predicted K about the pool mean per side, BEFORE the BIP chain and BEFORE era —
  // the production placement verified in the old joint run. The raw line then re-derives non-HR hits
  // from the corrected BIP via the fitted H-curve — the SAME recompute the deployed pitchingComponents
  // runs — so the raw babip/woba channels stay physical (more K ⇒ fewer BIP ⇒ fewer hits, BABIP ~flat)
  // instead of carrying a stale hit count against a shrunken BIP. (Per-side, because hRate is
  // nonlinear in BIP: correcting the blend instead would be a slightly different number.)
  if (ks && ks.s !== 1) {
    for (const e of [eR, eL]) {
      e.K = applyKSpread(e.K, ks.mean, ks.s);
      const bip = Math.max(600 - e.BB - e.K - e.HR - PIT_BIP_ADJ, 1);
      e.nHH = hRate(d.eventForm.pit.h, e.pbabipSC, bip);
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

/** Hitter: combined own-gap line → per-PA channels + wOBA (BATTING-ONLY, to match cwhit), RAW and DEPLOYED. */
export function ourHit(c: Card, pt: PoolTransform, d: SampleDeps, cal: CalScales): TwoLines {
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

export const wellSampled = (r: Rec): boolean => (r.role === "pit" ? r.sample >= MIN_IP : r.sample >= MIN_PA);

/**
 * Build the judged sample: for every Quick tier × role with an observed fixture, join cwhit's observed
 * table to our catalog (via the EXISTING fingerprint join — not rebuilt) and attach our predicted line
 * and, when the fixture exists, cwhit's projected line. Also returns the full-pool predicted
 * distribution per tier×role.
 */
export function buildCwhitSample(d: SampleDeps): SampleResult {
  const obsFiles = existsSync(OBS_DIR) ? readdirSync(OBS_DIR) : [];
  const projFiles = existsSync(PROJ_DIR) ? readdirSync(PROJ_DIR) : [];
  const hasObs = (tier: string, role: "pit" | "hit") => obsFiles.includes(`cwhit-${tier}-${role}.tsv`);
  const projFile = (tier: string, role: "pit" | "hit") =>
    (projFiles.includes(`cwhit-${tier}-${role}-proj.tsv`) ? `${PROJ_DIR}/cwhit-${tier}-${role}-proj.tsv` : null);

  const recs: Rec[] = [];
  const pools: PoolDist[] = [];
  const cals: { tier: string; cal: CalScales }[] = [];
  const windows: SampleResult["windows"] = [];
  const notices: string[] = [];
  const projUnjoined: string[] = [];

  for (const { tier, cap } of QUICK) {
    const basePool = d.baseCards.filter((c) => n_(c["Card Value"]) <= cap);
    const pt = buildPoolTransform(d.ref, computeUnifiedFieldStats(basePool, d.coeffs, d.model, FIELD_N, true), d.envelope);
    // Optional pitcher K-spread for this tier — threaded into calibrate too (production computes the
    // anchor on the SAME corrected events the scores use). sHit=1 ⇒ the hitter side is untouched
    // (applyKSpread short-circuits s===1 to the exact raw K).
    const ks = d.kSpreadPit?.get(tier);
    const kSpread = ks ? { sHit: 1, sPit: ks.s, meanHit: 0, meanPit: ks.mean } : undefined;
    // The REAL per-tier calibration — same call the deployed path makes (cf. tools/cwhit-bsr-validate.ts).
    const cal = calibrate(basePool, { coeffs: d.coeffs, derived: d.derived, eventForm: d.eventForm, poolTransform: pt, kSpread });
    cals.push({ tier, cal });

    for (const role of ["pit", "hit"] as const) {
      if (!hasObs(tier, role)) { notices.push(`no observed fixture ${OBS_DIR}/cwhit-${tier}-${role}.tsv → tier×role skipped entirely`); continue; }

      // our side: base (VLvl 0) + v5 variant, keyed by (title, vlvl) — the projected join key.
      const cards: JoinCard[] = [];
      const byCid = new Map<string, { title: string; vlvl: number; ours: Chan; oursDep: Chan; axis: number }>();
      const poolCh: Record<string, number[]> = {};
      for (const bc of d.baseCards) {
        for (const [vlvl, c] of [[0, bc], [5, makeVariant(bc)]] as const) {
          if (n_(c["Card Value"]) > cap) continue;
          if (role === "pit" ? !isPit(c) : isPit(c)) continue;
          const cid = `${bc["Card ID"]}|${vlvl}`;
          const p = role === "pit" ? ourPit(c, pt, d, cal, ks) : ourHit(c, pt, d, cal);
          // The JOIN fingerprint rides the same line the audit judges. Immaterial either way: the two
          // lines coincide per-channel on a neutral env (sBB=sHR=1, era/park=1) — the tool proves it.
          const fp = role === "pit"
            ? { primary: [Math.max(0, Math.min(1, (n_(c["Stamina"]) - 20) / 40)), p.raw.babip!], validate: [p.raw.k9!, p.raw.bb9!, p.raw.hr9!] }
            : { primary: [p.raw.babip!], validate: [p.raw.bbPct!, p.raw.soPct!, p.raw.hr600!] };
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
      if (!pf) { notices.push(`no projected fixture ${PROJ_DIR}/cwhit-${tier}-${role}-proj.tsv → ${tier} ${role} runs on the OBSERVED-ONLY axis (ours vs observed)`); }
      else {
        projBy = new Map();
        const conv: string[] = [];
        let meta: CwhitProjMeta;
        if (role === "pit") {
          const p = parseCwhitProjPit(readFileSync(pf, "utf8"), pf); meta = p.meta;
          conv.push(`K/BB/HR %-columns read as per-BATTER-FACED (per-PA), converted to per-9 with BF/9=${BF_PER_9.toFixed(1)} — the SAME constant our per-600 line uses, so the constant cancels in ours-vs-cwhit and touches only the vs-observed LEVEL`);
          for (const r of p.rows) projBy.set(`${r.title}|${r.vlvl}`, { k9: r.kPerPa * BF_PER_9, bb9: r.bbPerPa * BF_PER_9, hr9: r.hrPerPa * BF_PER_9, babip: r.babip, woba: pitWobaFromChannels(r.kPerPa * BF_PER_9, r.bbPerPa * BF_PER_9, r.hrPerPa * BF_PER_9, r.babip, d.W) });
        } else {
          const p = parseCwhitProjHit(readFileSync(pf, "utf8"), pf); meta = p.meta;
          if (p.rows[0]) { conv.push(`SO: ${p.rows[0].soConvention}`); conv.push(`HR: ${p.rows[0].hrConvention}`); conv.push(`XBH: ${p.rows[0].xbhConvention}`); }
          conv.push(`his pwOBA column NOT used as truth; wOBA recomputed from his projected events with OUR weights, BATTING-ONLY (no BsR) to match his convention and our woba_* metric — never our Offense score`);
          for (const r of p.rows) {
            const hrPa = r.hrPer600 / 600;
            const bip = Math.max(1 - r.bbPerPa - 0.008 - r.kPerPa - hrPa, 0.01);
            const nonHR = r.babip * bip, H = nonHR + hrPa;
            const xbh = Number.isFinite(r.xbhPct) ? xbhNonHrPerPa(r.xbhPct, H, hrPa) : 0.30 * nonHR;
            projBy.set(`${r.title}|${r.vlvl}`, {
              bbPct: r.bbPerPa * 100, soPct: r.kPerPa * 100, hr600: r.hrPer600, babip: r.babip,
              woba: d.W.bb * r.bbPerPa + d.W.hbp * 0.008 + d.W.b1 * Math.max(nonHR - xbh, 0) + d.W.xbh * xbh + d.W.hr * hrPa,
            });
          }
        }
        const parsed = role === "pit"
          ? parseCwhitPit(readFileSync(`${OBS_DIR}/cwhit-${tier}-${role}.tsv`, "utf8")).meta
          : parseCwhitHit(readFileSync(`${OBS_DIR}/cwhit-${tier}-${role}.tsv`, "utf8")).meta;
        windows.push({ tier, role, meta, conv, w: windowOverlap(parsed.coverageFrom, parsed.coverageTo, meta.trainFrom, meta.trainTo) });
      }

      // observed → our cards (the EXISTING fingerprint join; not rebuilt).
      if (role === "pit") {
        const { rows } = parseCwhitPit(readFileSync(`${OBS_DIR}/cwhit-${tier}-pit.tsv`, "utf8"));
        const obs: JoinObs<typeof rows[0]>[] = rows.map((r) => ({ name: r.name, val: r.val, vlvl: r.vlvl, hand: r.hand, primary: [r.gsPer, r.babip], validate: [r.k9, r.bb9, r.hr9], sample: r.ip, row: r }));
        const j = joinCwhit(obs, cards);
        for (const m of j.matched) {
          const our = byCid.get(m.card.cid)!, o = m.obs.row;
          recs.push({
            tier, role, title: our.title, name: o.name, vlvl: our.vlvl, sample: o.ip, axis: our.axis, ours: our.ours, oursDep: our.oursDep,
            obs: { k9: o.k9, bb9: o.bb9, hr9: o.hr9, babip: o.babip, woba: pitWobaFromChannels(o.k9, o.bb9, o.hr9, o.babip, d.W) },
            proj: projBy?.get(`${our.title}|${our.vlvl}`),
            raw: { ip: o.ip, k9: o.k9, bb9: o.bb9, hr9: o.hr9, babip: o.babip, ra9: o.ra9, era: o.era, gsPer: o.gsPer, ipPerGame: o.ipPerGame },
          });
        }
        if (projBy) { const seen = new Set(recs.filter((r) => r.tier === tier && r.role === role).map((r) => `${r.title}|${r.vlvl}`)); for (const k of projBy.keys()) if (!seen.has(k)) projUnjoined.push(`${tier} ${role}: ${k}`); }
      } else {
        const { rows } = parseCwhitHit(readFileSync(`${OBS_DIR}/cwhit-${tier}-hit.tsv`, "utf8"));
        const obs: JoinObs<typeof rows[0]>[] = rows.map((r) => ({ name: r.name, val: r.val, vlvl: r.vlvl, hand: r.hand, primary: [r.babip], validate: [r.bbPct, r.soPct, r.hr600], sample: r.pa, row: r }));
        const j = joinCwhit(obs, cards);
        for (const m of j.matched) {
          const our = byCid.get(m.card.cid)!, o = m.obs.row;
          // cwhit's observed SO% is K/AB → convert to our K/PA convention before ANY comparison.
          const soPa = soPctPerAbToPerPa(o.soPct, o.avg, o.obp, o.bbPct);
          recs.push({
            tier, role, title: our.title, name: o.name, vlvl: our.vlvl, sample: o.pa, axis: our.axis, ours: our.ours, oursDep: our.oursDep,
            obs: { bbPct: o.bbPct, soPct: soPa, hr600: o.hr600, babip: o.babip, woba: hitWobaFromRates({ ...o, soPct: soPa }, d.W) },
            proj: projBy?.get(`${our.title}|${our.vlvl}`),
            raw: { pa: o.pa, avg: o.avg, obp: o.obp, slg: o.slg, bbPct: o.bbPct, soPctPerAb: o.soPct, soPctPerPa: soPa, hr600: o.hr600, babip: o.babip, xbhPct: o.xbhPct, tripleXbh: o.tripleXbh },
          });
        }
        if (projBy) { const seen = new Set(recs.filter((r) => r.tier === tier && r.role === role).map((r) => `${r.title}|${r.vlvl}`)); for (const k of projBy.keys()) if (!seen.has(k)) projUnjoined.push(`${tier} ${role}: ${k}`); }
      }
    }
  }
  return { recs, pools, cals, windows, notices, projUnjoined, obsFiles, projFiles };
}
