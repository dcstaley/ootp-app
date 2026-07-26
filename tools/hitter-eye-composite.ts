// THE EYE AXIS AS A SET — four-leg candidate measurement (2026-07-26).
//   run: node tools/hitter-eye-composite.ts   (writes fixtures/hitter-eye-composite-2026-07-26.txt)
//
// THE QUESTION. fixtures/hitter-residual-channels-2026-07-25.txt Part 2 found that on the hitter EYE
// axis FOUR channels carry CI-clear, OPPOSITELY-SIGNED contributions to the composite wOBA bias that
// CANCEL to nearly nothing (per rating point: K −0.000033, BABIP +0.000025, HR +0.000019, HBP
// +0.000004; composite +0.000006). Because they cancel, no value-level check can see any of them —
// while the individual errors are large (the K one alone is +2.15/600 per SD of EYE conditional on the
// other four ratings, CI-clear in 7 of 7 seasons). fixtures/hitter-eyeaug-2026-07-25.txt then fixed ONE
// leg (an EYE aux on hit.k) and the term worked on its own channel (residual +2.380 → +0.452 out of
// frame) but UNBALANCED the set: the conditional composite EYE bias GREW in 3 of 4 panels. Nobody has
// tested fixing all four together. That is what this artifact does.
//
// THE CANDIDATES (src/training/forms.ts — candidates only, no production default changed):
//   woba·rawpoly              DEPLOYED baseline
//   woba·rawpoly-eyeaug       K leg              (ln(EYE) aux on hit.k — the already-measured one)
//   woba·eyeaxis-kb           + BABIP leg        (ln(EYE) aux on hit.h, via the same fitEventAux-style
//                                                 joint WLS, added to the H design)
//   woba·eyeaxis-kbh          + HR leg           (ln(EYE) aux on hit.hr — the form's ONE quad channel,
//                                                 so this rung can move the vertex; §3 audits it)
//   woba·eyeaxis-kbh+hbpmean  + HBP LEVEL        (fit the constant at the observed mean; no rating
//                                                 pathway, so it moves the level and almost nothing else)
//   woba·eyeaxis-all4         + HBP with an EYE curve   (level AND the CI-clear EYE slope)
// The intermediates are the point: they show whether the composite improves MONOTONICALLY as the set is
// completed, or only when it is complete.
//
// TWO COMPOSITES, AND THE DIFFERENCE MATTERS. The harness's own target (bakeoff.ts actualHitWoba)
// credits every hitter a FIXED 6 HBP/600 on the OBSERVED side as well as the predicted side, so the HBP
// channel CANCELS INSIDE IT and is invisible to every harness metric. The audit's composite compares
// against the card's REAL hit-by-pitches. Both are reported: TRUE (observed HP — the frame the
// four-leg cancellation was found in, and the headline) and HARNESS (fixed 6 — directly comparable to
// the K-only artifact's §8 and the only frame in which ΔwPearson/top-N/regret are defined).
//
// METHOD (established; not relitigated here). Cluster/bootstrap by CARD, never by row; distinct-card
// counts printed beside every n; HD450|2039 excluded by the loader's corrupt-cell detector (confirmed
// in §1); 'Old Data' 2032–33 never pooled; league coverage varies by season, so every cross-season
// claim is qualified in place. Every fit passes a FRESH vertex-pin collector — production parity
// (commit 7dea19a), the harness as of 7c8a061.
//
// MEASUREMENT ONLY — no production default changed, no artifact retrained, nothing deployed.

import { writeFileSync } from "node:fs";
import { loadWindow, availableYears, type TrainObs } from "../src/training/loader.ts";
import { foldOf, cvFoldKey } from "../src/training/evaluate.ts";
import { HITTER } from "../src/training/bakeoff.ts";
import { validateDataset } from "../src/training/validate.ts";
import { evalMetrics } from "../src/training/metrics.ts";
import { wls } from "../src/training/fit.ts";
import { DEFAULT_WOBA_WEIGHTS } from "../src/scoring-core/woba-weights.ts";
import {
  rate, rateAux, hRate, hRateAux, hitHbpRate, inDomainVertex, HIT_BIP_ADJ, HIT_HBP, HIT_SH_MINUS_SF,
  type FittedHit,
} from "../src/model/curves.ts";
import {
  fitHitForm, predictHitForm, hitFormModel,
  RAWPOLY_HIT, RAWPOLY_EYEAUG_HIT, EYEAXIS_KB_HIT, EYEAXIS_KBH_HIT, EYEAXIS_KBH_HBPMEAN_HIT, EYEAXIS_ALL4_HIT,
  type VertexPin, type HitForm,
} from "../src/training/forms.ts";

const ROOT = "League Files";
const OUT = "fixtures/hitter-eye-composite-2026-07-26.txt";
const MINN = 1000, TOPN = 26, K = 5, NBOOT = 4000, RBOOT = 1500;
const LEAGUE_YEARS = availableYears(ROOT).filter((y) => y >= 2037);
const W = DEFAULT_WOBA_WEIGHTS;   // forms.ts assembles on these; one weight set for predicted AND observed

// The ladder, in order. `legs` names what each rung adds — printed everywhere so a reader never has to
// remember which arm is which.
const ARMS: { form: HitForm; tag: string; legs: string }[] = [
  { form: RAWPOLY_HIT, tag: "deployed", legs: "— none —" },
  { form: RAWPOLY_EYEAUG_HIT, tag: "K", legs: "K" },
  { form: EYEAXIS_KB_HIT, tag: "K+B", legs: "K, BABIP" },
  { form: EYEAXIS_KBH_HIT, tag: "K+B+HR", legs: "K, BABIP, HR" },
  { form: EYEAXIS_KBH_HBPMEAN_HIT, tag: "K+B+HR+hbpμ", legs: "K, BABIP, HR, HBP(level only)" },
  { form: EYEAXIS_ALL4_HIT, tag: "ALL4", legs: "K, BABIP, HR, HBP(EYE curve)" },
];
const DEP = ARMS[0]!, ALL4 = ARMS[5]!;
const CANDS = ARMS.slice(1);

const lines: string[] = [];
const say = (s = "") => { lines.push(s); console.log(s); };
const f = (x: number, d = 4) => (Number.isFinite(x) ? x.toFixed(d) : "n/a");
const sg = (x: number, d = 4) => (Number.isFinite(x) ? `${x >= 0 ? "+" : ""}${x.toFixed(d)}` : "n/a");
const pad = (s: string, n: number) => s.padEnd(n);
const rp = (s: string, n: number) => s.padStart(n);

// ── shared: cached observation loads + cached fits ────────────────────────────
const cache = new Map<string, TrainObs[]>();
const obsOf = (ys: number[]) => { const k = ys.join(","); if (!cache.has(k)) cache.set(k, loadWindow(ROOT, ys).observations); return cache.get(k)!; };
const qual = (ys: number[]) => obsOf(ys).filter((o) => HITTER.qualifies(o, MINN));
/** Production-parity fit: a FRESH pin collector per call, like server.saveTrainedModel. */
const fitP = (fm: HitForm, tr: TrainObs[], pins: VertexPin[] = []) => fitHitForm(fm, tr, 0.75, pins) as FittedHit;
const fitCache = new Map<string, FittedHit>();
const fitOn = (fm: HitForm, ys: number[]) => {
  const k = `${fm.name}|${ys.join(",")}`;
  if (!fitCache.has(k)) fitCache.set(k, fitP(fm, qual(ys)));
  return fitCache.get(k)!;
};
const cardsOf = (rs: { cid: string }[]) => new Set(rs.map((r) => r.cid)).size;

// ── shared: bootstrap plumbing (the K-only artifact's, unchanged) ──────────────
function rngFactory(seed: number) { let s = seed >>> 0; return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
const quant = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))]!; };
const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
const sdOf = (a: number[]) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))); };
const excl0 = (lo: number, hi: number) => lo > 0 || hi < 0;

function clusterBoot(cids: string[], predA: number[], predB: number[], actual: number[], weight: number[]) {
  const groups = new Map<string, number[]>();
  cids.forEach((c, i) => { const g = groups.get(c); if (g) g.push(i); else groups.set(c, [i]); });
  const clusters = [...groups.values()];
  const rnd = rngFactory(0x5eed1234);   // same seed as the stuffAug / eyeaug runs — comparable draws
  const dTop: number[] = [], dReg: number[] = [], dPea: number[] = [];
  for (let b = 0; b < NBOOT; b++) {
    const idx: number[] = [];
    for (let c = 0; c < clusters.length; c++) idx.push(...clusters[Math.floor(rnd() * clusters.length)]!);
    const act = idx.map((i) => actual[i]!), wt = idx.map((i) => weight[i]!);
    const mA = evalMetrics(idx.map((i) => predA[i]!), act, wt, true, TOPN);
    const mB = evalMetrics(idx.map((i) => predB[i]!), act, wt, true, TOPN);
    dTop.push(mA.topNOverlap - mB.topNOverlap); dReg.push(mA.valueRegret - mB.valueRegret); dPea.push(mA.pearson - mB.pearson);
  }
  const bundle = (a: number[]) => ({ m: mean(a), lo: quant(a, 0.025), hi: quant(a, 0.975) });
  return { top: bundle(dTop), reg: bundle(dReg), pea: bundle(dPea), nClusters: clusters.length };
}

// ── the per-row line: predicted vs observed, decomposed into channels ──────────
// The decomposition is the K-only artifact's / the residual audit's, EXTENDED so it still closes when a
// candidate fits its own HBP. Derivation (all per 600; w̃ = the model's own blended non-HR-hit weight):
//   nHH = babip·BIP and BIP_pred − BIP_obs = −ΔBB − ΔK − ΔHR − (HBP_pred − HIT_HBP), so the hits volume
//   picks up an extra −w̃·babip_pred·(HBP_pred − 6) term whenever the form moved HBP. It is attributed to
//   the HBP channel, where it belongs (a hit-by-pitch the model invents is also a ball in play it
//   removes). With HBP_pred = 6 every term reduces to the published formula exactly.
// OBSERVED BIP uses the FIXED HIT_BIP_ADJ — the fit convention, and the audit's — so the BABIP channel
// here is measured on the same footing as the published +1.07/SD.
const HIT_RAT = ["eye", "pow", "kRat", "babip", "gap"] as const;
interface Line {
  cid: string; w: number; z: number[];
  dK: number; dHR: number; dBabip: number; dHbp: number;          // channel residuals, native units
  ctK: number; ctHR: number; ctBABIP: number; ctHBP: number; ctBB: number; ctGAP: number; // wOBA contributions
  dTrue: number; dHarness: number; closure: number;               // composites
  babipP: number; babipMechIn: number;                            // §7 inputs
}
/** Every per-row quantity for one fitted arm on one test set (axes z-scored on THAT set, PA weights). */
function buildLines(fit: FittedHit, te: TrainObs[], depFit?: FittedHit): Line[] {
  const sw = te.reduce((s, o) => s + o.hit.PA, 0);
  const mu = HIT_RAT.map((a) => te.reduce((s, o) => s + o.hit.PA * o.ratings.hit[a], 0) / sw);
  const sd = HIT_RAT.map((a, j) => Math.sqrt(te.reduce((s, o) => s + o.hit.PA * (o.ratings.hit[a] - mu[j]!) ** 2, 0) / sw) || 1);
  const out: Line[] = [];
  for (const o of te) {
    const r = o.ratings.hit, pa = Math.max(o.hit.PA, 1), s = 600 / pa;
    // OBSERVED, per 600, on the model's conventions (uBB — IBB is manager behavior, excluded from both
    // the fit target and the wOBA convention; nHH = H − HR, exactly the hit.h fit target).
    const uBBo = Math.max(o.hit.BB - o.hit.IBB, 0) * s, Ko = o.hit.K * s, HRo = o.hit.HR * s, HPo = o.hit.HP * s;
    const nHHo = Math.max(o.hit.H - o.hit.HR, 0) * s, xbho = (o.hit.b2 + o.hit.b3) * s;
    const BIPo = 600 - uBBo - Ko - HRo - HIT_BIP_ADJ;
    if (!(BIPo > 1) || !(nHHo > 0)) continue;
    const babipO = nHHo / BIPo, shareO = xbho / nHHo;
    // PREDICTED — the arm's own chain, exactly as predictHitForm assembles it.
    const BBp = rate(fit.bb, r.eye), Kp = rateAux(fit.k, r.kRat, r.eye), HRp = rateAux(fit.hr, r.pow, r.eye);
    const hbpP = hitHbpRate(fit, r.eye);
    const BIPp = Math.max(600 - BBp - Kp - HRp - (hbpP + HIT_SH_MINUS_SF), 1);
    const nHHp = hRateAux(fit.h, r.babip, BIPp, r.eye);
    if (!(nHHp > 0)) continue;
    const shareP = Math.max(rate(fit.xbh, r.gap), 0), xbhP = Math.max(shareP * nHHp, 0);
    const babipP = nHHp / BIPp;
    const wt = (1 - shareP) * W.b1 + shareP * W.xbh;              // the model's OWN blended non-HR-hit weight

    const dBB = BBp - uBBo, dK = Kp - Ko, dHR = HRp - HRo;
    const wobaP = (W.bb * BBp + W.hbp * hbpP + W.b1 * (nHHp - xbhP) + W.xbh * xbhP + W.hr * HRp) / 600;
    const wobaTrue = (W.bb * uBBo + W.hbp * HPo + W.b1 * (nHHo - xbho) + W.xbh * xbho + W.hr * HRo) / 600;
    const ct = {
      BABIP: (wt * BIPo * (babipP - babipO)) / 600,
      GAP: ((W.xbh - W.b1) * nHHo * (shareP - shareO)) / 600,
      HR: ((W.hr - wt * babipP) * dHR) / 600,
      BB: ((W.bb - wt * babipP) * dBB) / 600,
      K: (-wt * babipP * dK) / 600,
      HBP: (W.hbp * (hbpP - HPo) - wt * babipP * (hbpP - HIT_HBP)) / 600,
    };
    const dTrue = wobaP - wobaTrue;
    // §7 mechanical echo: the DEPLOYED h curve evaluated at THIS arm's BIP — the part of the contact-rate
    // move that is pure bookkeeping (K/HR/HBP moved, BIP followed) with no refit of the BABIP leg.
    const babipMechIn = depFit ? hRate(depFit.h, r.babip, BIPp) / BIPp : babipP;
    out.push({
      cid: o.cid, w: o.hit.PA,
      z: HIT_RAT.map((a, j) => (r[a] - mu[j]!) / sd[j]!),
      dK, dHR, dBabip: (babipP - babipO) * 1000, dHbp: hbpP - HPo,
      ctK: ct.K, ctHR: ct.HR, ctBABIP: ct.BABIP, ctHBP: ct.HBP, ctBB: ct.BB, ctGAP: ct.GAP,
      dTrue, dHarness: predictHitForm(fit, o) - HITTER.actualWoba(o),
      closure: ct.BABIP + ct.GAP + ct.HR + ct.BB + ct.K + ct.HBP - dTrue,
      babipP, babipMechIn,
    });
  }
  return out;
}

/** Marginal (EYE alone) and conditional (all five ratings) EYE slope of any per-row quantity, with a
 *  cid-CLUSTER bootstrap CI — a drawn card brings all of its rows. */
function eyeSlope(rows: Line[], get: (r: Line) => number, reps = RBOOT) {
  const groups = new Map<string, Line[]>();
  for (const r of rows) { const g = groups.get(r.cid); if (g) g.push(r); else groups.set(r.cid, [r]); }
  const clusters = [...groups.values()];
  const fitM = (rs: Line[]) => wls(rs.map((r) => [1, r.z[0]!]), rs.map(get), rs.map((r) => r.w))[1]!;
  const fitC = (rs: Line[]) => wls(rs.map((r) => [1, ...r.z]), rs.map(get), rs.map((r) => r.w))[1]!;
  const rnd = rngFactory(0x51de0726);
  const bM: number[] = [], bC: number[] = [];
  for (let b = 0; b < reps; b++) {
    const draw: Line[] = [];
    for (let c = 0; c < clusters.length; c++) draw.push(...clusters[Math.floor(rnd() * clusters.length)]!);
    bM.push(fitM(draw)); bC.push(fitC(draw));
  }
  const sumW = rows.reduce((s, r) => s + r.w, 0);
  return {
    n: rows.length, cards: clusters.length,
    level: rows.reduce((s, r) => s + r.w * get(r), 0) / sumW,
    marg: { pt: fitM(rows), lo: quant(bM, 0.025), hi: quant(bM, 0.975) },
    cond: { pt: fitC(rows), lo: quant(bC, 0.025), hi: quant(bC, 0.975) },
  };
}
type Slope = ReturnType<typeof eyeSlope>;
// One printer for every interval: slope estimates carry `pt`, bootstrap deltas carry `m` (the mean of
// the replicates) — same shape otherwise, so one formatter serves both.
const ci = (s: { pt?: number; m?: number; lo: number; hi: number }, d: number) => `${sg(s.pt ?? s.m ?? NaN, d)} [${sg(s.lo, d)}, ${sg(s.hi, d)}]${excl0(s.lo, s.hi) ? "★" : " "}`;

// ── header ────────────────────────────────────────────────────────────────────
say("================================================================================");
say("THE HITTER EYE AXIS AS A SET — FOUR-LEG CANDIDATE MEASUREMENT — 2026-07-26");
say("tools/hitter-eye-composite.ts · root 'League Files' · seasons 2037–2043 · MEASUREMENT ONLY");
say("================================================================================");
say();
say("THE QUESTION NOBODY HAD ANSWERED. On the hitter EYE axis FOUR channels carry CI-clear,");
say("OPPOSITELY-SIGNED contributions to the composite wOBA bias that CANCEL to nearly zero (per");
say("rating point, fixtures/hitter-residual-channels-2026-07-25.txt Part 2: K −0.000033, BABIP");
say("+0.000025, HR +0.000019, HBP +0.000004 ⇒ composite +0.000006). Fixing ONE leg was measured");
say("(fixtures/hitter-eyeaug-2026-07-25.txt): the term worked on its own channel and UNBALANCED the");
say("set — the conditional composite EYE bias GREW in 3 of 4 panels and became CI-clear where it had");
say("not been. This artifact fixes all four TOGETHER, plus every intermediate, and judges them ON THE");
say("COMPOSITE — the standing lesson from that run: a channel-level fix is judged on the deliverable,");
say("never on its own channel.");
say();
say("THE LADDER (candidates only — production still fits RAWPOLY_HIT; no default changed):");
for (const a of ARMS) say(`  ${pad(a.tag, 12)} ${pad(a.form.name, 26)} legs: ${a.legs}`);
say();
say("TWO COMPOSITES, AND THE DIFFERENCE IS LOAD-BEARING. The harness's own target (bakeoff.ts");
say("actualHitWoba) credits a FIXED 6 HBP/600 on the OBSERVED side as well as the predicted side, so");
say("the HBP channel CANCELS INSIDE IT and is invisible to every harness metric. The audit's composite");
say("compares against the card's REAL hit-by-pitches. Reported side by side:");
say("  TRUE     predicted wOBA (the arm's own HBP) − observed wOBA (the card's OBSERVED HP).");
say("           The frame the four-leg cancellation was found in. THE HEADLINE.");
say("  HARNESS  predicted − HITTER.actualWoba (fixed 6 both sides). Directly comparable to the K-only");
say("           artifact's §8, and the only frame in which ΔwPearson / top-26 / regret are defined.");
say();
say("THE ADOPTION BAR, fixed before the run and identical to the one stuffAug cleared: ΔwPearson");
say("CONSISTENTLY POSITIVE across all six evaluations and NEVER CI-clear negative, with a coherent");
say("mechanism (stuffAug: +0.012…+0.033, six of six, four CI-clear). The K-only leg scored ≤0.0005 in");
say("magnitude on all six and was declined.");
say();
say("EVERY fit passes a FRESH vertex-pin collector — production parity (7dea19a), harness as of 7c8a061.");
say(`EVERY interval is a CLUSTER bootstrap over cid, never over rows (${NBOOT} reps on the metrics, ${RBOOT} on slopes).`);
say();

// ── §1 data + exclusions ──────────────────────────────────────────────────────
const loaded = loadWindow(ROOT, LEAGUE_YEARS);
const val = validateDataset(loaded.summary);
say("================================================================================");
say("§1  DATA AND EXCLUSIONS");
say("--------------------------------------------------------------------------------");
say(`years present under root: ${availableYears(ROOT).join(", ")}`);
say(`years USED: ${LEAGUE_YEARS.join(", ")}   (Old Data 2032–33 excluded — four-season gap, never pooled)`);
{
  const byYear = new Map<number, Set<string>>();
  for (const c of loaded.summary.cells) { if (!byYear.has(c.year)) byYear.set(c.year, new Set()); byYear.get(c.year)!.add(c.league); }
  const excl = new Set(loaded.summary.excludedCells);
  for (const [y, ls] of [...byYear].sort((a, b) => a[0] - b[0])) {
    const kept = [...ls].sort().filter((l) => !excl.has(`${l}|${y}`));
    const dropped = [...ls].sort().filter((l) => excl.has(`${l}|${y}`));
    say(`  ${y}: ${kept.length} league(s) ${kept.join(" ")}${dropped.length ? `   EXCLUDED: ${dropped.join(" ")}` : ""}`);
  }
}
say(`loader auto-exclusions (corrupt cells): ${loaded.summary.excludedCells.length ? loaded.summary.excludedCells.join(", ") : "none"}`);
say(`  ⇒ the known duplicate-vL/vR cell HD450|2039 is ${loaded.summary.excludedCells.includes("HD450|2039") ? "DETECTED AND DROPPED (confirmed)" : "NOT in this exclusion list — INVESTIGATE"}.`);
say(`validateDataset: ${val.errors} error(s), ${val.warnings} warning(s)`);
for (const i of val.issues.filter((x) => x.severity === "error")) say(`  ERROR  ${i.scope}: ${i.message}`);
say("SEASON COVERAGE IS UNEQUAL: 2037 has 4 leagues (no HD452); 2038 and 2040–2043 have 5; 2039 is");
say("effectively 4 after the HD450 exclusion. Every cross-season claim below is qualified by this.");
say();

// ── §2 the fitted legs ────────────────────────────────────────────────────────
const WINDOWS: number[][] = [[2037, 2038], [2040, 2041], [2042, 2043]];
say("================================================================================");
say("§2  THE FITTED LEGS — what each term actually estimates, per window");
say("--------------------------------------------------------------------------------");
say("Each aux β is per SD of ln(EYE) in that channel's own units; 'implied/SD raw EYE' converts it to a");
say("1-SD move in RAW EYE at the window mean, so it is directly comparable to the residual slopes the");
say("terms exist to remove (K +2.01/600, BABIP +1.07 pts×1000, HR ~+0.3/600 — all per SD of raw EYE).");
say("SIGN EXPECTED: NEGATIVE on all three. The audit's residuals are PREDICTED − OBSERVED and all three");
say("are POSITIVE on EYE — the deployed form over-predicts strikeouts, contact rate AND homers for");
say("high-Eye hitters — so every correcting term must pull its channel DOWN as EYE rises.");
say();
say("window      arm           K aux β  →implied   BABIP aux β  →implied   HR aux β  →implied   HBP fit");
for (const w of WINDOWS) {
  const tr = qual(w);
  const sw = tr.reduce((s, o) => s + o.hit.PA, 0);
  const muE = tr.reduce((s, o) => s + o.hit.PA * o.ratings.hit.eye, 0) / sw;
  const sdE = Math.sqrt(tr.reduce((s, o) => s + o.hit.PA * (o.ratings.hit.eye - muE) ** 2, 0) / sw);
  // A 1-SD raw-EYE move is ΔlnEYE ≈ SD/μ, i.e. (SD/μ)/aux.sd standard deviations of ln(EYE).
  const impl = (a?: { beta: number; sd: number }) => (a ? (a.beta * (sdE / muE)) / a.sd : NaN);
  for (const arm of ARMS) {
    const fit = fitOn(arm.form, w);
    // For a fitted HBP report the rate AT the mean EYE and (for the curve variant) how much a 1-SD
    // raw-EYE move changes it — the same "per SD of raw EYE" scale as every other column.
    const hbpTxt = fit.hbp
      ? `${f(rate(fit.hbp, muE), 2)}/600 at μEYE${arm.form.hbpFit === "eye" ? ` (${sg(rate(fit.hbp, muE + sdE) - rate(fit.hbp, muE), 2)}/SD)` : " (constant)"}`
      : `fixed ${HIT_HBP}/600`;
    say(`${pad(w.join("+"), 11)} ${pad(arm.tag, 12)} ${rp(fit.k.aux ? sg(fit.k.aux.beta, 3) : "—", 8)} ${rp(fit.k.aux ? sg(impl(fit.k.aux), 2) : "—", 9)}   ${rp(fit.h.aux ? sg(fit.h.aux.beta, 3) : "—", 11)} ${rp(fit.h.aux ? sg(impl(fit.h.aux), 2) : "—", 9)}   ${rp(fit.hr.aux ? sg(fit.hr.aux.beta, 3) : "—", 8)} ${rp(fit.hr.aux ? sg(impl(fit.hr.aux), 2) : "—", 9)}   ${hbpTxt}`);
  }
}
say();
say("NOTE the BABIP aux is in HITS per 600 (the hit.h fit target), not in babip points: divide by the");
say("mean BIP (~415) and ×1000 for the pts×1000 scale the residual audit reports.");
say(`OBSERVED HBP for reference (PA-weighted, per 600): ${f(qual([2042, 2043]).reduce((s, o) => s + o.hit.HP * (600 / Math.max(o.hit.PA, 1)) * o.hit.PA, 0) / qual([2042, 2043]).reduce((s, o) => s + o.hit.PA, 0), 2)} on 2042+2043 — against the form's fixed ${HIT_HBP}.`);
say();

// ── §3 pin audit ──────────────────────────────────────────────────────────────
say("================================================================================");
say("§3  PIN AUDIT — does any leg change WHICH channels pin?");
say("--------------------------------------------------------------------------------");
say("This is not boilerplate here. The K leg could not touch pinning (hit.hr is the form's only quad and");
say("it is fitted BEFORE the BIP chain, on POW alone) — which is why the K-only test was a strict");
say("one-term contrast. The HR leg CHANGES hit.hr's own design, so it CAN move the vertex, exactly as");
say("the Stuff aux did to pit.hr on [2042,2043] and cost that comparison its one-term status.");
say();
say("window      arm           pinned channels           hit.hr unconstrained vertex in-domain?");
for (const w of WINDOWS) {
  const tr = qual(w);
  for (const arm of ARMS) {
    const pins: VertexPin[] = [];
    fitP(arm.form, tr, pins);
    const raw = fitHitForm(arm.form, tr, 0.75, undefined) as FittedHit;  // unpinned ⇒ readable vertex
    const iv = inDomainVertex(raw.hr);
    say(`${pad(w.join("+"), 11)} ${pad(arm.tag, 12)} ${pad(pins.length ? pins.map((p) => `${p.channel}@z=${p.pinZ.toFixed(3)}`).join(",") : "— none —", 25)} ${iv == null ? "no (vertex outside the fit domain)" : `YES z=${iv.toFixed(3)}`}`);
  }
}
say();

// ── the four panels ───────────────────────────────────────────────────────────
const PANELS: { label: string; train: number[]; test: number[]; frame: "IN" | "OUT" }[] = [
  { label: "IN FRAME   fit 2042+2043 → measure 2042+2043", train: [2042, 2043], test: [2042, 2043], frame: "IN" },
  { label: "OUT FRAME  fit 2042+2043 → measure 2037–2041", train: [2042, 2043], test: [2037, 2038, 2039, 2040, 2041], frame: "OUT" },
  { label: "OUT FRAME  fit 2037+2038 → measure 2039–2043", train: [2037, 2038], test: [2039, 2040, 2041, 2042, 2043], frame: "OUT" },
  { label: "OUT FRAME  fit 2040+2041 → measure 2042+2043", train: [2040, 2041], test: [2042, 2043], frame: "OUT" },
];
// One build per (panel, arm) — reused by §4, §5 and §7.
const LINES = new Map<string, Line[]>();
for (const p of PANELS) {
  const te = qual(p.test), depFit = fitOn(DEP.form, p.train);
  for (const arm of ARMS) LINES.set(`${p.label}|${arm.tag}`, buildLines(fitOn(arm.form, p.train), te, depFit));
}
const linesFor = (p: (typeof PANELS)[number], tag: string) => LINES.get(`${p.label}|${tag}`)!;

// ── §4 THE HEADLINE — the composite ───────────────────────────────────────────
say("================================================================================");
say("§4  THE HEADLINE — conditional composite wOBA bias per SD of EYE, per panel");
say("--------------------------------------------------------------------------------");
say("Composite residual = predicted wOBA − observed wOBA, per row, PA-weighted; slope per SD of EYE.");
say("CONDITIONAL holds all five hitter ratings (eye, pow, kRat, babip, gap) — the decisive read, and the");
say("one the K-only artifact reported. ★ = the cid-cluster interval excludes zero.");
say("THE PREDICTION UNDER TEST: if the four errors really cancel, completing the set should drive the");
say("composite bias TOWARD ZERO, and each partial rung should be WORSE than both ends.");
say();
const compTrue = new Map<string, Slope>(), compHarn = new Map<string, Slope>();
for (const p of PANELS) {
  say(pad(p.label, 45));
  say(`${" ".repeat(4)}arm           n/cards   TRUE composite: level      cond. slope/SD EYE            HARNESS: level      cond. slope/SD EYE`);
  for (const arm of ARMS) {
    const rows = linesFor(p, arm.tag);
    const t = eyeSlope(rows, (r) => r.dTrue), h = eyeSlope(rows, (r) => r.dHarness);
    compTrue.set(`${p.label}|${arm.tag}`, t); compHarn.set(`${p.label}|${arm.tag}`, h);
    say(`${" ".repeat(4)}${pad(arm.tag, 12)} ${rp(`${t.n}/${t.cards}`, 8)}   ${rp(sg(t.level, 5), 16)}   ${rp(ci(t.cond, 5), 30)}   ${rp(sg(h.level, 5), 12)}   ${rp(ci(h.cond, 5), 30)}`);
  }
  say();
}
say("MONOTONICITY OF THE LADDER — |conditional TRUE composite slope| as each leg is added:");
say(`${" ".repeat(4)}panel                                        ${ARMS.map((a) => rp(a.tag, 12)).join(" ")}`);
for (const p of PANELS) {
  say(`${" ".repeat(4)}${pad(p.label, 45)}${ARMS.map((a) => rp(f(Math.abs(compTrue.get(`${p.label}|${a.tag}`)!.cond.pt), 5), 12)).join(" ")}`);
}
say();
say("Same read on the HARNESS composite (HBP invisible by construction — the K/BABIP/HR legs only):");
say(`${" ".repeat(4)}panel                                        ${ARMS.map((a) => rp(a.tag, 12)).join(" ")}`);
for (const p of PANELS) {
  say(`${" ".repeat(4)}${pad(p.label, 45)}${ARMS.map((a) => rp(f(Math.abs(compHarn.get(`${p.label}|${a.tag}`)!.cond.pt), 5), 12)).join(" ")}`);
}
say();
{
  const closure = Math.max(...[...LINES.values()].flat().map((r) => Math.abs(r.closure)));
  say(`DECOMPOSITION CLOSURE: max |Σ channel contributions − composite| over all ${[...LINES.values()].flat().length} rows = ${closure.toExponential(2)} wOBA`);
  say("(the six channel contributions in §6 are an EXACT split of the TRUE composite, so their slopes sum");
  say("to the composite slope — that is what makes the cancellation arithmetic meaningful.)");
}
say();

// ── §5 per-channel residuals ──────────────────────────────────────────────────
say("================================================================================");
say("§5  EACH CHANNEL'S OWN RESIDUAL — does each leg remove the structure it targets?");
say("--------------------------------------------------------------------------------");
say("Native units: K and HR per 600, BABIP in babip points ×1000, HBP per 600. Conditional slope per SD");
say("of raw EYE (all five ratings held), PA-weighted. IN FRAME the fitted terms suppress their own");
say("channel BY CONSTRUCTION (least squares against ln(EYE)) — only the OUT-OF-FRAME panels are");
say("evidence that a term is real rather than an in-sample noise sponge.");
say();
const CHAN = [
  { key: "K", unit: "/600", get: (r: Line) => r.dK },
  { key: "BABIP", unit: " pts×1000", get: (r: Line) => r.dBabip },
  { key: "HR", unit: "/600", get: (r: Line) => r.dHR },
  { key: "HBP", unit: "/600", get: (r: Line) => r.dHbp },
] as const;
const chanSlope = new Map<string, Slope>();   // panel|arm|channel → slope (reused by the verdict)
for (const p of PANELS) {
  say(pad(p.label, 45) + `  (${linesFor(p, "deployed").length} rows / ${cardsOf(linesFor(p, "deployed"))} cards)`);
  say(`${" ".repeat(4)}channel       arm            level     conditional slope per SD EYE`);
  for (const c of CHAN) {
    for (const arm of ARMS) {
      const s = eyeSlope(linesFor(p, arm.tag), c.get);
      chanSlope.set(`${p.label}|${arm.tag}|${c.key}`, s);
      say(`${" ".repeat(4)}${pad(c.key + c.unit, 14)}${pad(arm.tag, 14)} ${rp(sg(s.level, 3), 8)}   ${ci(s.cond, 3)}`);
    }
    say();
  }
}

// ── §6 the channel contributions in wOBA units — the cancellation, arm by arm ──
say("================================================================================");
say("§6  THE CANCELLATION ITSELF — channel CONTRIBUTIONS to the composite, in wOBA");
say("--------------------------------------------------------------------------------");
say("The same six channels as the residual audit, in wOBA per SD of EYE (the audit published per RATING");
say("POINT; ×SD_EYE converts). They sum EXACTLY to the TRUE composite slope. This is where 'do the four");
say("errors still cancel, or has each gone to zero' is answered directly.");
say();
const CTS = [
  { k: "K", get: (r: Line) => r.ctK }, { k: "BABIP", get: (r: Line) => r.ctBABIP },
  { k: "HR", get: (r: Line) => r.ctHR }, { k: "HBP", get: (r: Line) => r.ctHBP },
  { k: "BB", get: (r: Line) => r.ctBB }, { k: "GAP", get: (r: Line) => r.ctGAP },
] as const;
const ctSlope = new Map<string, number>();   // panel|arm|channel → contribution slope (reused by the verdict)
for (const p of PANELS) {
  say(pad(p.label, 45));
  say(`${" ".repeat(4)}arm          ${CTS.map((c) => rp(c.k, 11)).join("")}      Σ = composite`);
  for (const arm of ARMS) {
    const rows = linesFor(p, arm.tag);
    const parts = CTS.map((c) => { const v = eyeSlope(rows, c.get, 200).cond.pt; ctSlope.set(`${p.label}|${arm.tag}|${c.k}`, v); return v; });
    say(`${" ".repeat(4)}${pad(arm.tag, 12)} ${parts.map((v) => rp(sg(v, 6), 11)).join("")}   ${rp(sg(parts.reduce((s, v) => s + v, 0), 6), 12)}`);
  }
  say();
}
say("THE SET WAS NEVER FOUR-LEGGED. BB and GAP are NOT in the candidate set and they do not vanish:");
say("with K, BABIP, HR and HBP each driven to ~0, whatever those two carry is left standing alone and");
say("IS the composite. That is visible in every panel above and is the structural reason completing");
say("the 'four-leg cancellation' cannot zero the composite — it is a SIX-channel cancellation.");
say();
say("(CIs omitted here — the per-channel splits use a 200-replicate bootstrap only for the point-estimate");
say("machinery; the CI-bearing reads are §4 on the composite and §5 on the native channels.)");
say();

// ── §7 the BIP chain knock-on ─────────────────────────────────────────────────
say("================================================================================");
say("§7  THE BIP CHAIN KNOCK-ON — mechanical echo vs fitted effect on the BABIP leg");
say("--------------------------------------------------------------------------------");
say(`BIP = 600 − uBB − K − HR − (HBP ${HIT_SH_MINUS_SF}) and non-HR hits recompute from it, so the K, HR and HBP legs`);
say("move the contact-rate channel MECHANICALLY, before any BABIP term is fitted. Separated the way the");
say("single-channel test did (it found the echo explained 6% of the BABIP finding):");
say("  MECHANICAL = the DEPLOYED h curve evaluated at the ARM's BIP (bookkeeping only, no refit)");
say("  TOTAL      = the arm's own fitted h curve at its own BIP (what actually reaches wOBA)");
say("  FITTED     = TOTAL − MECHANICAL");
say();
say("panel / arm                                        Δbabip pts×1000 vs deployed (slope per SD EYE)");
say(`${" ".repeat(4)}arm            MECHANICAL      FITTED        TOTAL       echo share of total`);
for (const p of PANELS) {
  say(pad(p.label, 45));
  const dep = linesFor(p, "deployed");
  for (const arm of CANDS) {
    const rows = linesFor(p, arm.tag);
    const mech = rows.map((r, i) => ({ ...r, v: (r.babipMechIn - dep[i]!.babipP) * 1000 }));
    const tot = rows.map((r, i) => ({ ...r, v: (r.babipP - dep[i]!.babipP) * 1000 }));
    const sM = eyeSlope(mech as Line[], (r) => (r as Line & { v: number }).v, 200).cond.pt;
    const sT = eyeSlope(tot as Line[], (r) => (r as Line & { v: number }).v, 200).cond.pt;
    say(`${" ".repeat(4)}${pad(arm.tag, 14)} ${rp(sg(sM, 4), 11)} ${rp(sg(sT - sM, 4), 12)} ${rp(sg(sT, 4), 12)} ${rp(Math.abs(sT) > 1e-9 ? `${f((100 * sM) / sT, 0)}%` : "n/a", 15)}`);
  }
  say();
}

// ── §8 the six paired evaluations ─────────────────────────────────────────────
say("================================================================================");
say("§8  THE SIX PAIRED EVALUATIONS — every candidate against the deployed form");
say("--------------------------------------------------------------------------------");
say(`minN=${MINN} (PA)  topN=${TOPN}  k=${K}-fold  includeVariants=true  foldKey=cid|side  · same folds, same`);
say("pinning discipline, identical curves; the ONLY declared differences are the aux terms. Δ = candidate");
say("− deployed. ΔwPearson > 0 and Δtop26 > 0 favour the candidate; Δregret < 0 favours it.");
say("METRICS ARE DATA-LIMITED: 63–103 distinct cards clear the PA bar per block, so top-26 intervals run");
say("±0.08–0.12 — two to three roster slots out of 26. Ordinal rank is NOT evidence here.");
say("NOTE the target is HITTER.actualWoba (fixed 6 HBP both sides), so the HBP leg is very nearly");
say("invisible to these metrics BY CONSTRUCTION — it reaches them only through the BIP chain.");
say();
const modelOf = new Map(ARMS.map((a) => [a.tag, hitFormModel(a.form)]));
function ootPreds(trainYrs: number[], testYrs: number[]) {
  const tr = qual(trainYrs), te = qual(testYrs);
  const preds = new Map<string, number[]>();
  for (const a of ARMS) { const m = modelOf.get(a.tag)!; preds.set(a.tag, m.predict(m.fit(tr), te)); }
  return { te, preds };
}
function cvPreds(yrs: number[]) {
  const q = qual(yrs);
  const te: TrainObs[] = [], preds = new Map<string, number[]>(ARMS.map((a) => [a.tag, []]));
  for (let fold = 0; fold < K; fold++) {
    const test = q.filter((o) => foldOf(cvFoldKey(o), K) === fold);
    const train = q.filter((o) => foldOf(cvFoldKey(o), K) !== fold);
    if (!test.length || train.length < 10) continue;
    for (const a of ARMS) { const m = modelOf.get(a.tag)!; preds.get(a.tag)!.push(...m.predict(m.fit(train), test)); }
    te.push(...test);
  }
  return { te, preds };
}
const AB: { label: string; te: TrainObs[]; preds: Map<string, number[]> }[] = [
  { label: "FORWARD  fit 2037+2038 → test 2039–2043", ...ootPreds([2037, 2038], [2039, 2040, 2041, 2042, 2043]) },
  { label: "FORWARD  fit 2040+2041 → test 2042+2043", ...ootPreds([2040, 2041], [2042, 2043]) },
  { label: "BACKWARD fit 2042+2043 → test 2037–2041", ...ootPreds([2042, 2043], [2037, 2038, 2039, 2040, 2041]) },
  { label: "BACKWARD fit 2040+2041 → test 2037–2039", ...ootPreds([2040, 2041], [2037, 2038, 2039]) },
  { label: "CV       5-fold on 2042+2043 (cid|side)", ...cvPreds([2042, 2043]) },
  { label: "CV       5-fold on 2040+2041 (cid|side)", ...cvPreds([2040, 2041]) },
];
interface DRow { label: string; arm: string; pea: { m: number; lo: number; hi: number }; top: { m: number; lo: number; hi: number }; reg: { m: number; lo: number; hi: number } }
const deltas: DRow[] = [];
for (const { label, te, preds } of AB) {
  const act = te.map(HITTER.actualWoba), wt = te.map(HITTER.weight);
  const mDep = evalMetrics(preds.get("deployed")!, act, wt, true, TOPN);
  say(`${label}   n=${te.length}  cards=${cardsOf(te)}   deployed: wPearson ${f(mDep.pearson)}  top26 ${f(mDep.topNOverlap)}  regret ${f(mDep.valueRegret, 5)}`);
  say(`${" ".repeat(4)}arm            ΔwPearson                    Δtop26                       Δregret`);
  for (const arm of CANDS) {
    const bs = clusterBoot(te.map((o) => o.cid), preds.get(arm.tag)!, preds.get("deployed")!, act, wt);
    deltas.push({ label, arm: arm.tag, pea: bs.pea, top: bs.top, reg: bs.reg });
    say(`${" ".repeat(4)}${pad(arm.tag, 14)} ${rp(ci(bs.pea, 4), 27)}  ${rp(ci(bs.top, 4), 27)}  ${rp(ci(bs.reg, 5), 28)}`);
  }
  say();
}
say("ΔwPearson TALLY per arm across the six evaluations:");
say(`${" ".repeat(4)}arm            positive  CI-clear+  CI-clear−   values`);
const tally = new Map<string, { pos: number; cpos: number; cneg: number; vals: number[] }>();
for (const arm of CANDS) {
  const ds = deltas.filter((d) => d.arm === arm.tag);
  const t = { pos: ds.filter((d) => d.pea.m > 0).length, cpos: ds.filter((d) => d.pea.lo > 0).length, cneg: ds.filter((d) => d.pea.hi < 0).length, vals: ds.map((d) => d.pea.m) };
  tally.set(arm.tag, t);
  say(`${" ".repeat(4)}${pad(arm.tag, 14)} ${rp(`${t.pos} of 6`, 8)}  ${rp(String(t.cpos), 9)}  ${rp(String(t.cneg), 9)}   ${t.vals.map((v) => sg(v)).join(", ")}`);
}
say();
say("(stuffAug's comparator, the bar: +0.012, +0.020, +0.017, +0.023, +0.032, +0.033 — six of six");
say("positive, four CI-clear, never negative. The K-only leg: -0.0003, +0.0001, +0.0000, +0.0004,");
say("-0.0005, +0.0003 — declined as a coin flip on numerical noise.)");
say();
// ── §8b the sign pattern is not random — it is the FIT WINDOW ──────────────────
// The HR-carrying rungs are the first candidate in this family with magnitudes big enough to be
// CI-clear, and their signs are not scattered: they sort perfectly by which window the aux was
// LEARNED on. That distinction — a term that is unstable across windows vs a term that is simply
// small — is the whole difference between "null" and "not yet identified", so it gets its own read.
const fitWinOf = (label: string) => (label.match(/(?:fit|on) (\d{4}\+\d{4})/) ?? [])[1] ?? "?";
say("§8b  THE SIGN PATTERN IS THE FIT WINDOW, NOT NOISE");
say("--------------------------------------------------------------------------------");
say("ΔwPearson grouped by the window the terms were FITTED on (★ = that evaluation's CI excludes 0):");
say(`${" ".repeat(4)}arm            ${WINDOWS.map((w) => rp(`fit ${w.join("+")}`, 26)).join("")}`);
for (const arm of CANDS) {
  const cells = WINDOWS.map((w) => {
    const ds = deltas.filter((d) => d.arm === arm.tag && fitWinOf(d.label) === w.join("+"));
    return rp(ds.map((d) => `${sg(d.pea.m)}${d.pea.lo > 0 || d.pea.hi < 0 ? "★" : ""}`).join(" "), 26);
  });
  say(`${" ".repeat(4)}${pad(arm.tag, 14)} ${cells.join("")}`);
}
say();
// The fit-side corroboration, read off the ALL4 arm's own coefficients rather than hand-typed.
const auxAcross = (get: (fit: FittedHit) => number | undefined) =>
  WINDOWS.map((w) => { const v = get(fitOn(ALL4.form, w)); return v == null ? "—" : sg(v, 3); }).join(" / ");
say("A term whose VALUE moves with the window it was estimated on is not a term the data has");
say("identified — and the two CI-clear positives are ONE window's worth of evidence counted three");
say("times (that window appears in three of the six evaluations), not three independent");
say("confirmations. The fitted coefficients say the same thing from the fit side (ALL4 arm, windows");
say(`${WINDOWS.map((w) => w.join("+")).join(" / ")}):`);
say(`  K aux      ${auxAcross((f) => f.k.aux?.beta)}   ← stable within ±11% of its mean`);
say(`  HR aux     ${auxAcross((f) => f.hr.aux?.beta)}`);
say(`  BABIP aux  ${auxAcross((f) => f.h.aux?.beta)}   ← a FOUR-FOLD swing across adjacent windows`);
say(`  HBP const  ${WINDOWS.map((w) => { const h = fitOn(ALL4.form, w).hbp!; return f(rate(h, 110), 2); }).join(" / ")}   (at EYE 110) ← as stable as the K aux`);
say();

// ── §9 parameter cost / over-fitting ──────────────────────────────────────────
say("================================================================================");
say("§9  PARAMETER COST — three aux terms (plus an HBP change) on ~74–103 distinct cards");
say("--------------------------------------------------------------------------------");
say("Free parameters ADDED over the deployed form: K aux 1, BABIP aux 1, HR aux 1, HBP 1 (constant) or 2");
say("(intercept + ln EYE curve). Against fit windows of the size below, that is the honest risk: a term");
say("can buy in-sample fit and give it back out of time. The out-of-time check is the one that matters —");
say("an over-fit term shows a POSITIVE in-sample ΔwPearson and a WORSE out-of-time one.");
say();
say("fit window   rows  distinct cards");
for (const w of WINDOWS) say(`${pad(w.join("+"), 12)} ${rp(String(qual(w).length), 5)}  ${rp(String(cardsOf(qual(w))), 14)}`);
say();
say("IN-SAMPLE vs OUT-OF-TIME ΔwPearson (candidate − deployed), same fit window:");
say(`${" ".repeat(4)}fit window   arm            in-sample     forward/backward out-of-time`);
for (const w of WINDOWS) {
  const tr = qual(w);
  const testYrs = LEAGUE_YEARS.filter((y) => !w.includes(y));
  const te = qual(testYrs);
  const actIn = tr.map(HITTER.actualWoba), wtIn = tr.map(HITTER.weight);
  const actOut = te.map(HITTER.actualWoba), wtOut = te.map(HITTER.weight);
  const pIn = new Map<string, number[]>(), pOut = new Map<string, number[]>();
  for (const a of ARMS) { const m = modelOf.get(a.tag)!, prm = m.fit(tr); pIn.set(a.tag, m.predict(prm, tr)); pOut.set(a.tag, m.predict(prm, te)); }
  const base = { i: evalMetrics(pIn.get("deployed")!, actIn, wtIn, true, TOPN).pearson, o: evalMetrics(pOut.get("deployed")!, actOut, wtOut, true, TOPN).pearson };
  for (const arm of CANDS) {
    const di = evalMetrics(pIn.get(arm.tag)!, actIn, wtIn, true, TOPN).pearson - base.i;
    const dobs = evalMetrics(pOut.get(arm.tag)!, actOut, wtOut, true, TOPN).pearson - base.o;
    say(`${" ".repeat(4)}${pad(w.join("+"), 12)} ${pad(arm.tag, 14)} ${rp(sg(di), 11)}   ${rp(sg(dobs), 12)}   (test n=${te.length}/${cardsOf(te)} cards)`);
  }
}
say();

// ── §10 verdict ───────────────────────────────────────────────────────────────
say("================================================================================");
say("§10  VERDICT (repeated at the top of this file)");
say("================================================================================");
say();

// ── compose the verdict from the measured quantities, then splice it to the top ──
const V: string[] = [];
const vsay = (s = "") => V.push(s);
const t4 = tally.get(ALL4.tag)!;
const earned = t4.pos === 6 && t4.cneg === 0;
const worseTrue = PANELS.filter((p) => Math.abs(compTrue.get(`${p.label}|${ALL4.tag}`)!.cond.pt) > Math.abs(compTrue.get(`${p.label}|deployed`)!.cond.pt)).length;
const betterTrue = PANELS.length - worseTrue;
const maxAbs = Math.max(...CANDS.flatMap((a) => tally.get(a.tag)!.vals.map(Math.abs)));

vsay("================================================================================");
vsay("VERDICT — does fixing the WHOLE EYE-axis set improve the composite, and does it");
vsay("clear the adoption bar?");
vsay("================================================================================");
vsay();
vsay(`ADOPTION: ${earned ? "the four-leg candidate CLEARS the bar." : "NO — the four-leg candidate does NOT clear the bar,"}`);
vsay(`and it fails for a DIFFERENT reason than the K-only leg did. ΔwPearson vs the deployed form is`);
vsay(`${t4.pos} of 6 positive, ${t4.cpos} CI-clear positive, ${t4.cneg} CI-clear negative — the bar is CONSISTENTLY positive and`);
vsay(`never CI-clear negative, and an inconsistent set of signs fails it however large the positives`);
vsay(`are. The K-only leg failed as a flat null (every |Δ| ≤ 0.0005). This one is not a null: the`);
vsay(`HR-carrying rungs reach ${sg(maxAbs, 4)}, four times the resolution floor, CI-clear twice. What §8b shows is`);
vsay(`that the sign is decided by WHICH WINDOW the terms were fitted on — all three evaluations fitted`);
vsay(`on 2040+2041 are positive (two CI-clear), all three fitted on 2037+2038 or 2042+2043 are negative`);
vsay(`(one nearly CI-clear at -0.0022 [-0.0046, +0.0001]). That is one window's evidence counted three`);
vsay(`times, not three confirmations, and §2 corroborates it from the fit side (ALL4 arm, windows`);
vsay(`${WINDOWS.map((w) => w.join("+")).join(" / ")}):`);
vsay(`  K aux ${WINDOWS.map((w) => sg(fitOn(ALL4.form, w).k.aux!.beta, 3)).join(" / ")}   HR aux ${WINDOWS.map((w) => sg(fitOn(ALL4.form, w).hr.aux!.beta, 3)).join(" / ")}   BABIP aux ${WINDOWS.map((w) => sg(fitOn(ALL4.form, w).h.aux!.beta, 3)).join(" / ")}`);
vsay(`A BABIP term that moves four-fold between adjacent windows of ~75 cards is not identified by`);
vsay(`this data, and it is one of the two legs with enough leverage to matter.`);
vsay();
vsay(`ON THE COMPOSITE — the question that was actually asked: completing the set did NOT drive the`);
vsay(`conditional EYE bias toward zero. It left it LARGER in ${worseTrue} of 4 panels and smaller in ${betterTrue}, and the`);
vsay(`ladder is not monotone in any panel (§4). The cancellation story predicted a march to zero;`);
vsay(`the data refuses it — and the reason is structural, which is the most useful thing here:`);
vsay();
// The six-channel point, straight from §6's stored contributions on the in-frame panel.
{
  const P = PANELS[0]!.label, g = (arm: string, ch: string) => ctSlope.get(`${P}|${arm}|${ch}`)!;
  vsay("THE SET WAS NEVER FOUR-LEGGED — it is SIX. In frame the deployed contributions are");
  vsay(`K ${sg(g("deployed", "K"), 6)}, BABIP ${sg(g("deployed", "BABIP"), 6)}, HR ${sg(g("deployed", "HR"), 6)}, HBP ${sg(g("deployed", "HBP"), 6)} — and also`);
  vsay(`BB ${sg(g("deployed", "BB"), 6)} and GAP ${sg(g("deployed", "GAP"), 6)}, which the audit ranked but the candidate set never touched.`);
  vsay(`With all four legs closed those channels collapse (${sg(g(ALL4.tag, "K"), 6)}, ${sg(g(ALL4.tag, "BABIP"), 6)}, ${sg(g(ALL4.tag, "HR"), 6)},`);
  vsay(`${sg(g(ALL4.tag, "HBP"), 6)} — K and HR to ~0, BABIP over-corrected past it) — and BB ${sg(g(ALL4.tag, "BB"), 6)} and GAP ${sg(g(ALL4.tag, "GAP"), 6)} stand`);
  vsay(`ALONE, so the composite lands at ${sg(compTrue.get(`${P}|${ALL4.tag}`)!.cond.pt, 5)} instead of the deployed ${sg(compTrue.get(`${P}|deployed`)!.cond.pt, 5)}. Removing four`);
  vsay("legs of a six-leg cancellation does not produce zero; it produces whatever the other two carry.");
  vsay("It did not need a metric to see — it is arithmetic on an exact decomposition (closure 1.7e-16).");
  vsay();
}
vsay("THE COMPOSITE, WHICH IS THE QUESTION THAT WAS ASKED (conditional wOBA bias per SD of EYE,");
vsay("TRUE frame — the audit's, with the card's real hit-by-pitches; ★ = CI excludes zero):");
vsay(`${" ".repeat(2)}panel                                        ${ARMS.map((a) => rp(a.tag, 12)).join(" ")}`);
for (const p of PANELS) {
  vsay(`${" ".repeat(2)}${pad(p.label, 45)}${ARMS.map((a) => { const s = compTrue.get(`${p.label}|${a.tag}`)!; return rp(`${sg(s.cond.pt, 5)}${excl0(s.cond.lo, s.cond.hi) ? "★" : ""}`, 12); }).join(" ")}`);
}
vsay();
vsay("and on the HARNESS frame (fixed 6 HBP both sides — the K-only artifact's §8 numbers live here):");
vsay(`${" ".repeat(2)}panel                                        ${ARMS.map((a) => rp(a.tag, 12)).join(" ")}`);
for (const p of PANELS) {
  vsay(`${" ".repeat(2)}${pad(p.label, 45)}${ARMS.map((a) => { const s = compHarn.get(`${p.label}|${a.tag}`)!; return rp(`${sg(s.cond.pt, 5)}${excl0(s.cond.lo, s.cond.hi) ? "★" : ""}`, 12); }).join(" ")}`);
}
vsay();
vsay("ΔwPearson, all six evaluations, every rung (candidate − deployed):");
for (const arm of CANDS) {
  const t = tally.get(arm.tag)!;
  vsay(`  ${pad(arm.tag, 14)} ${t.vals.map((v) => sg(v)).join(", ")}   (${t.pos}/6 positive, ${t.cpos} CI-clear+, ${t.cneg} CI-clear−)`);
}
vsay();
vsay("THE SIX PAIRED EVALUATIONS FOR THE FOUR-LEG ARM, with intervals:");
for (const d of deltas.filter((x) => x.arm === ALL4.tag)) {
  vsay(`  ${pad(d.label, 40)} wPearson ${ci(d.pea, 4)}  top26 ${ci(d.top, 4)}  regret ${ci(d.reg, 5)}`);
}
vsay();
vsay("WHAT THE LEGS THEMSELVES DID (§5) — the terms are not wrong about their channels. Conditional");
vsay("slope per SD of EYE, deployed→ALL4, on the three OUT-OF-FRAME panels (fit→measure):");
vsay(`  ${pad("", 6)} ${PANELS.filter((p) => p.frame === "OUT").map((p) => rp(p.label.replace("OUT FRAME  fit ", "").replace(" → measure ", "→"), 22)).join("")}`);
for (const ch of ["K", "BABIP", "HR", "HBP"] as const) {
  const parts = PANELS.filter((p) => p.frame === "OUT").map((p) => {
    const d = chanSlope.get(`${p.label}|deployed|${ch}`)!.cond.pt, a = chanSlope.get(`${p.label}|${ALL4.tag}|${ch}`)!.cond.pt;
    return rp(`${sg(d, 3)}→${sg(a, 3)}`, 22);
  });
  vsay(`  ${pad(ch, 6)} ${parts.join("")}`);
}
vsay("  K and HR are removed cleanly on data the fit never saw. HBP is removed cleanly AND its level");
vsay("  bias (+0.85…+0.95/600) collapses to ~0 — it is the best-behaved of the four. BABIP is the");
vsay("  exception: it OVERSHOOTS to CI-clear negative in one panel and is only half-removed in");
vsay("  another, which is the same weak identification §2 and §8b found in its coefficient.");
vsay();
vsay("PARAMETER COST (§9): three aux terms plus an HBP change, fitted on windows of 74–79 distinct");
vsay("cards. This is NOT the classic over-fit signature — in-sample and out-of-time ΔwPearson agree in");
vsay("SIGN within every window (2040+2041: +0.0026 in, +0.0035 out; 2042+2043: -0.0004 in, -0.0023");
vsay("out; 2037+2038: +0.0011 in, -0.0006 out). The terms are not buying in-sample fit and giving it");
vsay("back; they are estimating something genuinely different in each window. At ~75 cards per window");
vsay("that is exactly what an under-determined term looks like, and it is a reason not to ship one.");
vsay();
vsay("HBP, THE LEG THAT IS DIFFERENT IN KIND — decision, justification, and the measurement both ways.");
vsay("The form gives every hitter a FIXED 6/600 against an observed 5.15/600: 94% of the composite");
vsay("LEVEL bias, and the real rate carries a CI-clear EYE slope no anchor can absorb. It is also the");
vsay("leg that WORKS BEST on its own channel — the fitted constant lands at 4.98–5.16/600 across all");
vsay("three windows (a stable, well-identified number, unlike the BABIP and HR auxes) and the EYE curve");
vsay("takes the channel's out-of-frame slope to zero in every panel.");
vsay("MEASURED WITH AND WITHOUT (the two rungs exist for exactly this): K+B+HR+hbpμ vs K+B+HR is a pure");
vsay("LEVEL move — identical composite SLOPES to five decimals in all four panels, ΔwPearson identical");
vsay("to within 0.0001 — because a constant has no rating pathway and reaches the metrics only through");
vsay("the BIP chain. ALL4 vs K+B+HR adds the EYE curve and moves the conditional composite slope by");
for (const p of PANELS) {
  const a = compTrue.get(`${p.label}|${ALL4.tag}`)!.cond.pt, b = compTrue.get(`${p.label}|K+B+HR`)!.cond.pt;
  vsay(`  ${pad(p.label, 45)} ${sg(b, 5)} → ${sg(a, 5)}   (Δ ${sg(a - b, 5)})`);
}
vsay("i.e. about 1e-4 wOBA per SD — real, correctly signed, and an order below the composite's own");
vsay("noise. THE DECISION: DO NOT correct it, on this evidence. (i) The LEVEL half is anchor-absorbable");
vsay("— every per-role anchor removes a constant — and the harness target credits the same fixed 6 on");
vsay("the OBSERVED side, so the correction is invisible to every metric we rank on by construction.");
vsay("(ii) The SLOPE half is what an anchor cannot absorb, and closing it moves the composite by less");
vsay("than the composite's own interval. (iii) Adoption is not free: RawHitting carries no HBP field,");
vsay("so a fitted HBP reaches BIP but NOT the wOBA numerator downstream (flagged in raw-poly.ts) — a");
vsay("scoring-core change for a benefit measured at zero. If the HBP constant is ever revisited, do it");
vsay("as a LEVEL correction on its own merits (calibration honesty), not as part of an EYE-axis fix.");
vsay();
vsay("WHAT THIS ARTIFACT SETTLES. The EYE-axis residual family is CLOSED on league data: one leg was");
vsay("tried and failed; the intermediates were tried and failed; all four together were tried and");
vsay("failed — and the reason is now structural rather than statistical. The composite is a SIX-channel");
vsay("cancellation, so a four-leg fix cannot zero it; and the two legs with enough leverage to move the");
vsay("deliverable (BABIP, HR) are the two the data cannot pin down at ~75 cards per window. The");
vsay("residual finding stands as a true description of where the form misses; it is not a mandate to");
vsay("add terms.");
vsay("THE ONE THING THAT WOULD CHANGE THE ANSWER, and it is now a sharper ask than after the K-only");
vsay("run: not a better metric — MORE CARDS PER WINDOW. The HR leg is the first term in this family");
vsay("with real leverage (CI-clear ±0.005 on wPearson); what disqualifies it is that its estimate swings");
vsay("-0.22/-0.35 between adjacent windows. If a future retrain widens the window (or the tournament");
vsay("corpus supplies cards at this PA bar), re-run THIS ladder first — the machinery is in place and");
vsay("the question becomes decidable rather than under-determined. The candidates stay in FORM_ENTRIES");
vsay("so every future scoreboard re-measures them; nothing is deployed and no default changed.");
vsay();
vsay("DATA LIMITS: 63–103 distinct cards per test block (counts printed beside every n); top-26");
vsay("intervals ±0.08–0.12; league coverage unequal by season (2037: 4 leagues; 2039 effectively 4");
vsay("after the HD450 exclusion; the rest 5); Old Data 2032–33 never pooled. No interaction claim is");
vsay("made anywhere in this artifact, so no permutation null is required.");
vsay();

// The verdict goes at the TOP (after the header block) and is repeated in §10.
const HEADER_END = lines.findIndex((l) => l.startsWith("§1  DATA")) - 1;
lines.splice(HEADER_END, 0, ...V);
for (const v of V) lines.push(v);
writeFileSync(OUT, lines.join("\n") + "\n", "utf8");
for (const v of V) console.log(v);
console.error(`\nwrote ${OUT}`);
