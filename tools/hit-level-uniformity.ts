// HITTER wOBA LEVEL OVERSHOOT — UNIFORM ACROSS CARDS, OR CARD-DEPENDENT?
//   run: node tools/hit-level-uniformity.ts            (both runs; the full analysis)
//        node tools/hit-level-uniformity.ts --no-corrections   (same analysis; r_c headline reported
//                                                               on the PRE-correction line instead)
//
// THE QUESTION. The production corrections (BUILD-1 pit K-spread, BUILD-2 hitter tail, BUILD-3 pit
// HR9) push the hitter wOBA LEVEL up by +0.011..+0.017. We already know that overshoot is uniform
// ACROSS TIERS (no tier trend). That is NOT the claim under test here. Under project doctrine:
//   · a level error that is UNIFORM WITHIN A ROLE is a CONVENTION — the production per-role anchor
//     (sFinal) absorbs it wholesale, so it is harmless;
//   · anything CARD-DEPENDENT is SPACING/SHAPE, which is fully live and a real defect.
// So the object of interest is the PER-CARD correction footprint
//     d_c = r_c(corrections ON) − r_c(corrections OFF),  r_c = pred_woba(c) − obs_woba(c)
// i.e. "what did the corrections do to THIS card". Note d_c = pred_ON(c) − pred_OFF(c) exactly: the
// observed term CANCELS. d_c therefore carries ZERO sampling noise by construction — the noise
// deconvolution the two-axis doctrine demands for a spread read is, for d_c, the identity, and any
// nonzero within-tier SD of d_c is REAL card-dependence, not a small-sample artifact. Deconvolution
// is still run (with the observed-wOBA noise variance) for the r_c spread reads and for the §4
// yardstick, where it genuinely bites.
//
// ONE SCORING CORE: no scoring math is written here. This tool boots the SAME Repository / active
// trained model / neutral env / production correction parameters as tools/cwhit-scorecard.ts and
// calls the SAME shared sample builder (src/eval/cwhit/sample.ts) twice — once with the corrections
// wired, once without. The only arithmetic below is measurement statistics.
//
// GROUND TRUTH: cwhit's RAW OBSERVED events only. cwhit PROJECTIONS are not read, joined, or used
// anywhere in this tool.

import { readFileSync } from "node:fs";
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { resolveCoeffs, type Model } from "../src/config/coeff-resolve.ts";
import type { Era, Park, Tournament } from "../src/config/tournament.ts";
import {
  makeRawPolyModel, computeUnifiedFieldStats, applyWobaWeights, computeDerived,
  buildPoolTransform, buildFrameShift, poolPitMeansOwn, kSpreadPitRamp, pitSpreadHrRamp,
  HIT_RATINGS,
  type EventForm, type FieldStats, type RatingEnvelope, type WobaWeights, type TrainingMeans,
} from "../src/scoring-core/index.ts";
import { computeHitTail, PINNED_HIT_TAIL, type HitTail } from "../src/scoring-core/hit-tail.ts";
import { parseCatalogCsv, type Card } from "../src/data/catalog.ts";
import { makeVariant } from "../src/data/variants.ts";
import type { WobaWeights as WW } from "../src/eval/cwhit/audit.ts";
import {
  buildCwhitSample, wellSampled, handLetter, isPit, n_, FIELD_N, MIN_PA, QUICK, inValueWindow,
  type KSpreadPit, type Rec, type SampleDeps,
} from "../src/eval/cwhit/sample.ts";

const f = (x: number, d = 4) => (Number.isFinite(x) ? x.toFixed(d) : "n/a");
const sgn = (x: number, d = 4) => (Number.isFinite(x) ? `${x >= 0 ? "+" : ""}${x.toFixed(d)}` : "n/a");

// ── deployed model + neutral env (mirrors tools/cwhit-scorecard.ts exactly) ──
const repo = new Repository("data");
await seedDefaults(repo); await seedEras(repo); await seedAccounts(repo);
const state = (await repo.load<{ activeModelId?: string; catalogSourceId?: string }>("state", "app")) ?? {};
type TM = { id: string; eventForm?: EventForm; wobaWeights?: WobaWeights; ratingEnvelope?: RatingEnvelope; trainingMeans?: TrainingMeans; platoon?: { pit: { hand: string; vsRHB: number; vsLHB: number }[]; hit: { hand: string; vsRHP: number; vsLHP: number }[] } };
const trained = (await repo.loadAll<TM>("trained-models")).find((x) => x.id === state.activeModelId);
if (!trained?.eventForm || !trained.wobaWeights || !trained.platoon) throw new Error("active model missing eventForm/wobaWeights/platoon");
const rp = makeRawPolyModel(trained.eventForm);
const W = trained.wobaWeights as WW;
const envelope = trained.ratingEnvelope;
const model = (await repo.loadAll<Model>("models"))[0]!;
const eras = new Map((await repo.loadAll<Era>("eras")).map((e) => [e.id, e]));
const parks = new Map((await repo.loadAll<Park>("parks")).map((p) => [p.id, p]));
const bq = (await repo.loadAll<Tournament>("tournaments")).find((t) => t.id === "bronze-quick")!;
const coeffs = resolveCoeffs(model, eras.get(bq.eraId)!, parks.get(bq.parkId)!, bq.softcaps);
applyWobaWeights(coeffs, trained.wobaWeights);
const derived = computeDerived(coeffs);
const pitExp = new Map(trained.platoon.pit.map((p) => [p.hand, { wR: p.vsRHB, wL: p.vsLHB }]));
const hitExp = new Map(trained.platoon.hit.map((p) => [p.hand, { wR: p.vsRHP, wL: p.vsLHP }]));

const srcId = state.catalogSourceId ?? "cdmx";
const baseCards = parseCatalogCsv(readFileSync(`data/imports/${srcId}.csv`, "utf8")).cards.filter((c) => String(c["Variant"] ?? "").toUpperCase() !== "Y");
const ref: FieldStats = computeUnifiedFieldStats(baseCards, coeffs, rp, FIELD_N, true);

// ── PRODUCTION correction parameters, per Quick tier (identical construction to the scorecard) ──
const ksMap = new Map<string, KSpreadPit>();
const htMap = new Map<string, HitTail>();
const poolFieldByTier = new Map<string, FieldStats>();
const TMeans = trained.trainingMeans;
if (!TMeans) throw new Error("this tool needs the active model's trainingMeans (retrain to embed them)");
for (const win of QUICK) {
  const { tier } = win;
  const basePool = baseCards.filter((c) => inValueWindow(c, win));
  const poolField = computeUnifiedFieldStats(basePool, coeffs, rp, FIELD_N, true);
  poolFieldByTier.set(tier, poolField);
  const pt = buildPoolTransform(ref, poolField, envelope);
  const shift = buildFrameShift(TMeans, poolField);
  const pm = poolPitMeansOwn(basePool, coeffs, rp, pt, FIELD_N);
  ksMap.set(tier, { s: kSpreadPitRamp(shift.pit.vR.stu ?? 0), mean: pm.k, sHr: pitSpreadHrRamp(shift.pit.vR.hrr ?? 0), meanHr: pm.hr }); // sBab HELD
  htMap.set(tier, computeHitTail(basePool.filter((c) => !isPit(c)), coeffs, rp, pt, ref, poolField, PINNED_HIT_TAIL));
}

// ── the two samples: corrections ON (production) and OFF (pre-correction) ────
const baseDeps: Omit<SampleDeps, "kSpreadPit" | "hitTail"> = {
  baseCards, coeffs, derived, eventForm: trained.eventForm, model: rp, W, ref, envelope, pitExp, hitExp,
};
const ON = buildCwhitSample({ ...baseDeps, kSpreadPit: ksMap, hitTail: htMap });
const OFF = buildCwhitSample({ ...baseDeps });

// ── PAIR the two runs on (tier, title, VLvl) ─────────────────────────────────
// NOT on the builder's own match order: the join fingerprint rides PREDICTED channel values, which
// differ between the two runs, so the matched sets are not guaranteed identical. Pairing on the card
// identity and then REQUIRING the observed line to be bit-identical makes any join drift visible
// instead of silently contaminating d_c.
const HK = (r: Rec) => `${r.tier}|${r.title}|${r.vlvl}`;
const offBy = new Map(OFF.recs.filter((r) => r.role === "hit").map((r) => [HK(r), r]));

interface Pair {
  tier: string; title: string; vlvl: number; name: string; pa: number;
  rOn: number; rOff: number; d: number;          // residuals + correction footprint (RAW eval line)
  dDep: number;                                  // same on the DEPLOYED (anchored) line
  predOn: number; obs: number; obsNoiseVar: number;
  rat: Record<string, number>;                   // exposure-weighted eye/pow/kRat/babip/gap
  ownGap: number;                                // mean z-distance from the tier pool field mean
}

// Observed-wOBA sampling variance, per card. wOBA is a per-PA weighted multinomial over
// {BB, HBP, 1B, XBH, HR, out}: Var(wOBA) = (Σ w_i² p_i − (Σ w_i p_i)²)/PA. This is the wOBA-scale
// analogue of scorecard.ts's per600NoiseVar/pctNoiseVar/babipNoiseVar (which the scorecard declines
// to compute for the wOBA composite). MEASUREMENT only — it never touches a predicted value.
// The event mix is read off the SAME reconstruction audit.ts#hitWobaFromRates uses.
function obsWobaNoiseVar(raw: Record<string, number>, w: WW, hbp = 0.008): number {
  const pa = raw.pa!; if (!(pa > 0)) return NaN;
  const bb = raw.bbPct! / 100, k = raw.soPctPerPa! / 100, hr = raw.hr600! / 600;
  const bip = Math.max(1 - bb - hbp - k - hr, 0);
  const hNonHR = raw.babip! * bip, H = hNonHR + hr;
  const basesPerHit = raw.avg! > 0 ? raw.slg! / raw.avg! : 1;
  const nonHRbases = basesPerHit * H - 4 * hr;
  const r3 = raw.tripleXbh! / 100;
  const xbh = Math.max((nonHRbases - hNonHR) / (1 + r3), 0);
  const oneB = Math.max(hNonHR - xbh, 0);
  const cats: [number, number][] = [[w.bb, bb], [w.hbp, hbp], [w.b1, oneB], [w.xbh, xbh], [w.hr, hr]];
  const m1 = cats.reduce((a, [wt, p]) => a + wt * p, 0);
  const m2 = cats.reduce((a, [wt, p]) => a + wt * wt * p, 0);
  return Math.max(m2 - m1 * m1, 0) / pa;
}

// Card ratings, keyed the same way, so d_c can be regressed on card properties. Exposure-weighted
// vR/vL by the card's Bats hand — the same weights the prediction itself blends the two sides with.
const ratByKey = new Map<string, Record<string, number>>();
for (const win of QUICK) {
  const { tier } = win;
  for (const bc of baseCards) {
    for (const [vlvl, c] of [[0, bc], [5, makeVariant(bc)]] as [number, Card][]) {
      if (!inValueWindow(c, win) || isPit(c)) continue;
      const { wR, wL } = hitExp.get(handLetter(n_(c["Bats"]))) ?? { wR: 0.5, wL: 0.5 };
      const col: Record<string, string> = { eye: "Eye", pow: "Power", kRat: "Avoid K", babip: "BABIP", gap: "Gap" };
      const rat: Record<string, number> = {};
      for (const k of HIT_RATINGS) rat[k] = wR * n_(c[`${col[k]} vR`]) + wL * n_(c[`${col[k]} vL`]);
      ratByKey.set(`${tier}|${String(bc["//Card Title"])}|${vlvl}`, rat);
    }
  }
}

const pairs: Pair[] = [];
const integrity: string[] = [];
let onOnly = 0, obsMismatch = 0, noRat = 0;
for (const r of ON.recs) {
  if (r.role !== "hit" || !wellSampled(r)) continue;
  const o = offBy.get(HK(r));
  if (!o) { onOnly++; continue; }
  if (Math.abs(o.obs.woba! - r.obs.woba!) > 1e-12 || Math.abs(o.sample - r.sample) > 1e-9) { obsMismatch++; continue; }
  const rat = ratByKey.get(HK(r));
  if (!rat) { noRat++; continue; }
  const pf = poolFieldByTier.get(r.tier)!.hit.vR;
  let g = 0;
  for (const k of HIT_RATINGS) { const s = pf[k]!; g += s.sd > 0 ? (rat[k]! - s.mu) / s.sd : 0; }
  pairs.push({
    tier: r.tier, title: r.title, vlvl: r.vlvl, name: r.name, pa: r.sample,
    rOn: r.ours.woba! - r.obs.woba!, rOff: o.ours.woba! - o.obs.woba!,
    d: r.ours.woba! - o.ours.woba!, dDep: r.oursDep.woba! - o.oursDep.woba!,
    predOn: r.ours.woba!, obs: r.obs.woba!, obsNoiseVar: obsWobaNoiseVar(r.raw, W),
    rat, ownGap: g / HIT_RATINGS.length,
  });
}
if (onOnly) integrity.push(`${onOnly} ON-run card(s) had no OFF-run counterpart on (tier,title,VLvl) — EXCLUDED (join drift between runs)`);
if (obsMismatch) integrity.push(`${obsMismatch} paired card(s) carried a DIFFERENT observed line between runs — EXCLUDED (the fingerprint join landed on a different observed row)`);
if (noRat) integrity.push(`${noRat} paired card(s) had no catalog rating row — EXCLUDED`);

// ── statistics (measurement only) ────────────────────────────────────────────
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
const sdSample = (xs: number[]) => { if (xs.length < 2) return NaN; const m = mean(xs); return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1)); };
function meanCI(xs: number[]): { m: number; lo: number; hi: number; sig: boolean } {
  const m = mean(xs), se = sdSample(xs) / Math.sqrt(xs.length);
  const lo = m - 1.96 * se, hi = m + 1.96 * se;
  return { m, lo, hi, sig: lo * hi > 0 };
}
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const q = (xs: number[], p: number) => { const v = [...xs].sort((a, b) => a - b); return v[Math.min(Math.max(Math.floor(p * v.length), 0), v.length - 1)]!; };

/** Within-group demeaned SD of `val`, noise-deconvolved with the per-card `nv` (Var_true = Var_obs −
 *  mean noise Var), pooled over groups. For d_c the noise array is ZERO by construction. */
function deconvSd(groups: { val: number[]; nv: number[] }[]): { sdObs: number; nvBar: number; sdTrue: number; n: number } {
  let ss = 0, dof = 0, nvSum = 0, n = 0;
  for (const g of groups) {
    if (g.val.length < 2) continue;
    const m = mean(g.val);
    ss += g.val.reduce((a, x) => a + (x - m) ** 2, 0);
    dof += g.val.length - 1;
    nvSum += g.nv.reduce((a, x) => a + x, 0); n += g.val.length;
  }
  const varObs = dof > 0 ? ss / dof : NaN;
  const nvBar = n > 0 ? nvSum / n : NaN;
  return { sdObs: Math.sqrt(varObs), nvBar, sdTrue: Math.sqrt(Math.max(varObs - nvBar, 0)), n };
}
/** Bootstrap CI on sdTrue — resample CARDS WITHIN each tier (the tier mean is a nuisance parameter,
 *  so the resample must preserve the tier blocks). */
function bootSdTrue(groups: { val: number[]; nv: number[] }[], B = 2000, seed = 20260720): { lo: number; hi: number } {
  const rnd = rng(seed); const out: number[] = [];
  for (let b = 0; b < B; b++) {
    const rs = groups.map((g) => {
      const ix = g.val.map(() => Math.floor(rnd() * g.val.length));
      return { val: ix.map((i) => g.val[i]!), nv: ix.map((i) => g.nv[i]!) };
    });
    const s = deconvSd(rs).sdTrue;
    if (Number.isFinite(s)) out.push(s);
  }
  return out.length >= 20 ? { lo: q(out, 0.025), hi: q(out, 0.975) } : { lo: NaN, hi: NaN };
}
/** OLS of y on x with TIER FIXED EFFECTS (both series demeaned within tier), 95% CI on the slope. */
function feSlope(rows: { tier: string; x: number; y: number }[]): { slope: number; lo: number; hi: number; sig: boolean; sdX: number; n: number; r2: number } {
  const byTier = new Map<string, typeof rows>();
  for (const r of rows) (byTier.get(r.tier) ?? byTier.set(r.tier, []).get(r.tier)!).push(r);
  const dx: number[] = [], dy: number[] = [];
  for (const g of byTier.values()) {
    if (g.length < 2) continue;
    const mx = mean(g.map((r) => r.x)), my = mean(g.map((r) => r.y));
    for (const r of g) { dx.push(r.x - mx); dy.push(r.y - my); }
  }
  const n = dx.length, k = byTier.size;
  const sxx = dx.reduce((a, x) => a + x * x, 0), sxy = dx.reduce((a, x, i) => a + x * dy[i]!, 0);
  const slope = sxx > 0 ? sxy / sxx : NaN;
  const sse = dy.reduce((a, y, i) => a + (y - slope * dx[i]!) ** 2, 0);
  const sst = dy.reduce((a, y) => a + y * y, 0);
  const dof = n - k - 1;
  const se = dof > 0 && sxx > 0 ? Math.sqrt(sse / dof / sxx) : NaN;
  const lo = slope - 1.96 * se, hi = slope + 1.96 * se;
  return { slope, lo, hi, sig: Number.isFinite(se) && lo * hi > 0, sdX: sdSample(dx), n, r2: sst > 0 ? 1 - sse / sst : NaN };
}

// ── assemble the numbers, THEN print (verdict leads) ────────────────────────
const tiers = QUICK.map((x) => x.tier).filter((t) => pairs.some((p) => p.tier === t));
const THIN = 5;
const readable = tiers.filter((t) => pairs.filter((p) => p.tier === t).length >= THIN);
const thin = tiers.filter((t) => !readable.includes(t));
const pooled = pairs.filter((p) => readable.includes(p.tier));

const zeros = (n: number) => new Array<number>(n).fill(0);
const grp = (t: string) => { const v = pairs.filter((p) => p.tier === t); return { val: v.map((p) => p.d), nv: zeros(v.length) }; };
const groups = readable.map(grp);
const dSd = deconvSd(groups);
const dCI = bootSdTrue(groups);
const dDepGroups = readable.map((t) => { const v = pairs.filter((p) => p.tier === t); return { val: v.map((p) => p.dDep), nv: zeros(v.length) }; });
const dDepSd = deconvSd(dDepGroups);

// The yardstick: the hitter wOBA spread we are trying to get right, noise-deconvolved, within tier.
const obsGroups = readable.map((t) => { const v = pairs.filter((p) => p.tier === t); return { val: v.map((p) => p.obs), nv: v.map((p) => p.obsNoiseVar) }; });
const obsSd = deconvSd(obsGroups);
const predGroups = readable.map((t) => { const v = pairs.filter((p) => p.tier === t); return { val: v.map((p) => p.predOn), nv: zeros(v.length) }; });
const predSd = deconvSd(predGroups);

const props: { key: string; lbl: string; get: (p: Pair) => number }[] = [
  ...HIT_RATINGS.map((k) => ({ key: k, lbl: `rating ${k}`, get: (p: Pair) => p.rat[k]! })),
  { key: "predOn", lbl: "pred wOBA (ON)", get: (p: Pair) => p.predOn },
  { key: "ownGap", lbl: "own-gap (mean z)", get: (p: Pair) => p.ownGap },
];
const slopes = props.map((pr) => ({ ...pr, fit: feSlope(pooled.map((p) => ({ tier: p.tier, x: pr.get(p), y: p.d }))) }));

const share = dSd.sdTrue / obsSd.sdTrue;
const CARD_DEP = Number.isFinite(dSd.sdTrue) && dSd.sdTrue > 0 && (dCI.lo > 0);
const MATERIAL = share >= 0.10;
const anySlope = slopes.filter((s) => s.fit.sig);

// ═══════════════════════════════════════════════════════════════════════════
// READ THE VERDICT CORRECTLY — card-dependence here is NOT prima facie a defect.
// BUILD-2 is the hitter TAIL correction. Reshaping card-to-card spacing is its DESIGNED
// FUNCTION: a tail correction with zero card-dependence would be a pure level shift and would
// do nothing for spread. So a nonzero σ_true(d_c) is the correction WORKING, and the question
// this tool answers is narrower than "is BUILD-2 broken":
//   (a) is the LEVEL overshoot uniform-within-role, hence absorbed by the production anchor?
//       — that is the watch item, and it is answered in §1/§2 (mean d_c per tier + the anchored line).
//   (b) how big is the card-dependent part, and what does it track? — §2/§3, for diagnosis.
// Whether the reshaping is in the RIGHT DIRECTION is a question this tool cannot answer, because
// d_c never touches the observed line. That is a two-axis scorecard read, and as of 2026-07-20 the
// scorecard answers it in BUILD-2's favour at every tier: OFF→ON, hitter wOBA ordering corr rises
// (iron .29→.42, bronze .45→.58, silver .39→.49, gold .16→.40, diamond .59→.70) and the calibration
// slope moves TOWARD 1.0 (.19→.25, .34→.50, .19→.27, .09→.25, .23→.37) from a badly under-spread
// baseline. So do NOT read the strings below as "BUILD-2 has a defect."
const HEADLINE = !CARD_DEP
  ? "LEVEL EFFECT IS UNIFORM ACROSS CARDS — a pure convention; the per-role anchor absorbs it entirely."
  : MATERIAL
    ? "CARD-DEPENDENT AND MATERIAL — BUILD-2 reshapes hitter wOBA SPACING, not just level. EXPECTED for a tail correction (see the note above); judge the DIRECTION on the scorecard, not here. The uniform LEVEL part is separately anchor-absorbable — see §1/§2."
    : "CARD-DEPENDENT BUT SMALL — BUILD-2's spacing footprint is a small fraction of the hitter wOBA spread; the uniform level part is anchor-absorbable. See §1/§2.";

console.log(`\n╔══════════════════════════════════════════════════════════════════════════════════════════════╗`);
console.log(`║  HITTER wOBA LEVEL OVERSHOOT — uniform across CARDS, or card-dependent?                       ║`);
console.log(`╚══════════════════════════════════════════════════════════════════════════════════════════════╝`);
console.log(`VERDICT: ${HEADLINE}`);
console.log(`         σ_true(d_c) within tier = ${f(dSd.sdTrue)} wOBA  [95% CI ${f(dCI.lo)}, ${f(dCI.hi)}]  vs deconvolved observed hitter wOBA spread ${f(obsSd.sdTrue)}  ⇒  ${f(share * 100, 1)}% of it.`);
console.log(`         CI-clear property slopes: ${anySlope.length ? anySlope.map((s) => s.lbl).join(", ") : "NONE"}`);
console.log(``);
console.log(`model '${trained.id}' | catalog '${srcId}' | neutral env (bronze-quick era/park) | own-gap pool transform ON | HITTERS only, the five Quick tiers`);
console.log(`d_c = pred_ON(c) − pred_OFF(c)  (the observed term cancels out of r_ON − r_OFF)  — on the RAW eval line (unanchored), which is the frame the scorecard judges.`);
console.log(`CORRECTIONS ON = production default (BUILD-1 pit K-spread + BUILD-3 pit HR9 + BUILD-2 hitter tail; pit BABIP scalar HELD). Only BUILD-2 can move a HITTER, so d_c here is BUILD-2's footprint.`);
console.log(`--no-corrections is ACCEPTED and is a NO-OP by design: d_c requires BOTH runs, so this tool always builds both in one process and §1 prints r_c(ON) and r_c(OFF) side by side.`);
console.log(`cwhit RAW OBSERVED events = ground truth. cwhit PROJECTIONS are NOT read by this tool.`);

// ── §0. sample ──────────────────────────────────────────────────────────────
console.log(`\n── §0. SAMPLE (hitters, PA ≥ ${MIN_PA}, paired across both runs) ──`);
console.log(`tier       N paired   median PA    mean d_c      note`);
for (const t of tiers) {
  const v = pairs.filter((p) => p.tier === t);
  const med = [...v.map((p) => p.pa)].sort((a, b) => a - b)[Math.floor(v.length / 2)]!;
  console.log(`${t.padEnd(9)}  ${String(v.length).padStart(4)}      ${String(med).padStart(6)}     ${sgn(mean(v.map((p) => p.d)))}     ${v.length < THIN ? `TOO THIN (<${THIN}) — EXCLUDED from every pooled read below; no within-tier statement is made for this tier`
    : v.length < 25 ? `THIN (N=${v.length}) — kept, but this tier's OWN σ and CI are wide; lean on the pooled read, not this row` : ""}`);
}
for (const s of integrity) console.log(`  ⚠ INTEGRITY: ${s}`);
if (!integrity.length) console.log(`  integrity: every well-sampled ON-run hitter paired to an OFF-run row with a bit-identical observed line.`);
if (!readable.length) { console.log(`\n  no tier has ≥${THIN} paired well-sampled hitters — NOTHING is readable. Stopping.`); process.exit(0); }

// ── §1. levels ──────────────────────────────────────────────────────────────
console.log(`\n── §1. LEVELS — the residual before and after, and the correction footprint (per tier) ──`);
console.log(`tier         N    r_c(ON) mean [95% CI]              r_c(OFF) mean [95% CI]             d_c mean [95% CI]`);
for (const t of readable) {
  const v = pairs.filter((p) => p.tier === t);
  const a = meanCI(v.map((p) => p.rOn)), b = meanCI(v.map((p) => p.rOff)), c = meanCI(v.map((p) => p.d));
  console.log(`${t.padEnd(9)} ${String(v.length).padStart(4)}    ${sgn(a.m)} [${sgn(a.lo)}, ${sgn(a.hi)}]${a.sig ? "*" : " "}    ${sgn(b.m)} [${sgn(b.lo)}, ${sgn(b.hi)}]${b.sig ? "*" : " "}    ${sgn(c.m)} [${sgn(c.lo)}, ${sgn(c.hi)}]${c.sig ? "*" : " "}`);
}
{
  const a = meanCI(pooled.map((p) => p.rOn)), b = meanCI(pooled.map((p) => p.rOff)), c = meanCI(pooled.map((p) => p.d));
  console.log(`POOLED    ${String(pooled.length).padStart(4)}    ${sgn(a.m)} [${sgn(a.lo)}, ${sgn(a.hi)}]${a.sig ? "*" : " "}    ${sgn(b.m)} [${sgn(b.lo)}, ${sgn(b.hi)}]${b.sig ? "*" : " "}    ${sgn(c.m)} [${sgn(c.lo)}, ${sgn(c.hi)}]${c.sig ? "*" : " "}`);
}
console.log(`  (* = CI excludes 0. The pooled row mixes tiers with different means; it is a summary, not the tier-uniformity test — that was settled separately and is NOT re-litigated here.)`);

// ── §2. THE TEST ────────────────────────────────────────────────────────────
console.log(`\n── §2. IS d_c UNIFORM ACROSS CARDS? (tier mean removed; the remainder is card-dependence) ──`);
console.log(`tier         N    SD(d_c − tier mean)   mean noise var   σ_true(d_c)`);
for (const t of readable) {
  const g = grp(t), s = deconvSd([g]);
  console.log(`${t.padEnd(9)} ${String(g.val.length).padStart(4)}    ${f(s.sdObs).padStart(10)}            ${f(s.nvBar, 6).padStart(8)}     ${f(s.sdTrue)}`);
}
console.log(`POOLED    ${String(dSd.n).padStart(4)}    ${f(dSd.sdObs).padStart(10)}            ${f(dSd.nvBar, 6).padStart(8)}     ${f(dSd.sdTrue)}   [95% CI ${f(dCI.lo)}, ${f(dCI.hi)}]  (2000-rep bootstrap, resampled WITHIN tier)`);
console.log(`  NOISE IS EXACTLY ZERO HERE, BY CONSTRUCTION — not by assumption: d_c = pred_ON − pred_OFF, so the observed value (the only stochastic term) cancels.`);
console.log(`  Deconvolution is therefore the identity for d_c and σ_observed = σ_true. Any nonzero value above is REAL card-to-card variation in what the corrections did.`);
console.log(`  DEPLOYED (anchored) line, same statistic: σ_true(d_c^dep) = ${f(dDepSd.sdTrue)} (mean ${sgn(mean(pooled.map((p) => p.dDep)))}). The anchor moves the LEVEL, so a σ that survives it is the part the anchor cannot absorb.`);

// ── §3. structure ───────────────────────────────────────────────────────────
console.log(`\n── §3. DOES d_c HAVE SYSTEMATIC CARD STRUCTURE? (OLS with TIER FIXED EFFECTS; N=${pooled.length}) ──`);
console.log(`property             slope (d_c per unit)        95% CI                        SD(x)      per-1-SD move   R²`);
for (const s of slopes) {
  const per1sd = s.fit.slope * s.fit.sdX;
  console.log(`${s.lbl.padEnd(20)} ${sgn(s.fit.slope, 6).padStart(11)}${s.fit.sig ? "*" : " "}          [${sgn(s.fit.lo, 6)}, ${sgn(s.fit.hi, 6)}]        ${f(s.fit.sdX, 3).padStart(6)}     ${sgn(per1sd).padStart(8)}      ${f(s.fit.r2, 3)}`);
}
console.log(`  (* = 95% CI excludes 0 ⇒ the correction's effect on this card VARIES with the property ⇒ it is reshaping SPACING, not applying a constant.)`);
console.log(`  Slopes are UNIVARIATE with tier fixed effects. The five ratings are mutually correlated, so a significant slope identifies WHERE the`);
console.log(`  card-dependence lives, NOT which rating causes it. R² is the within-tier share of Var(d_c) that single property explains.`);

// ── §4. magnitude in context ────────────────────────────────────────────────
console.log(`\n── §4. MAGNITUDE IN CONTEXT — is a card-dependent component material? ──`);
console.log(`  σ_true(d_c)                                          ${f(dSd.sdTrue)}   ← the card-dependent part of the correction`);
console.log(`  |mean d_c| (pooled)                                  ${f(Math.abs(mean(pooled.map((p) => p.d))))}   ← the uniform part (anchor-absorbable)`);
console.log(`  SD of our PREDICTED hitter wOBA, within tier         ${f(predSd.sdTrue)}   ← the spread we produce`);
console.log(`  SD of OBSERVED hitter wOBA, within tier, raw         ${f(obsSd.sdObs)}`);
console.log(`  SD of OBSERVED hitter wOBA, within tier, DECONVOLVED ${f(obsSd.sdTrue)}   ← the true spread we are trying to get right (noise share ${f((obsSd.nvBar / obsSd.sdObs ** 2) * 100, 0)}%)`);
console.log(`  ⇒ card-dependent component = ${f(share * 100, 1)}% of the true hitter wOBA spread, and ${f((dSd.sdTrue / Math.max(Math.abs(mean(pooled.map((p) => p.d))), 1e-12)) * 100, 0)}% of the uniform shift's own size.`);
console.log(`  READ: the uniform part is a CONVENTION the per-role anchor absorbs. The σ_true part is NOT absorbable — it is a spacing move, and it is`);
console.log(`  what any "is the overshoot harmless?" claim has to be judged against.`);
console.log(``);
process.exit(0);
