// ═══ CENTERPIECE #2, STEP 0 — WHERE DO THE CARDS SIT IN THE CURVE'S FIT DOMAIN? ══
//
// Pre-registered in docs/CWHIT_CENTERPIECE2_PREREG_2026-07-21.md §2, and run BEFORE anything is
// fitted, because it decides which version of the hypothesis is even live.
//
// WHY THIS EXISTS. BUILD-2 killed the analogous HITTER story with a structural proof: league in-frame
// is calibrated and own-gap-lifted ratings stay IN-DOMAIN, so any league-fit form gives the same
// in-domain predictions and a form change cannot express an out-of-frame defect. The pitcher K
// equivalent has never been checked. The deployed K curve stamps its own fit domain (mu, sd, uMin,
// uMax), so "is the tournament card sitting where the curve was actually fitted?" is a measurement,
// not an argument.
//
// THE COORDINATE IS THE ONE THE CURVE IS EVALUATED AT: applyAffine(Stuff v{R,L}, poolTransform.pit.
// v{R,L}.stu) — exactly what ourPit feeds predictPitching, per side. Not the raw rating: the own-gap
// transform LIFTS ratings toward the league frame, and whether that lift carries cards back into the
// supported region is the entire question.
//
// THREE PRE-COMMITTED READINGS (prereg §2): outside the domain => literal extrapolation is live;
// inside but concentrated in the sparse LOW tail => the weaker rating-local form (stop calling it
// extrapolation); well-supported interior => STOP AND REPORT, do not fit anyway.
//
// MEASUREMENT ONLY. Nothing is fitted, proposed or shipped.

import { readFileSync } from "node:fs";
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { resolveCoeffs, type Model } from "../src/config/coeff-resolve.ts";
import type { Era, Park, Tournament } from "../src/config/tournament.ts";
import {
  makeRawPolyModel, applyWobaWeights, computeDerived, computeUnifiedFieldStats, buildPoolTransform,
  type EventForm, type FieldStats, type RatingEnvelope, type WobaWeights, type TrainingMeans,
} from "../src/scoring-core/index.ts";
import { effectiveStuff } from "../src/model/k-support.ts"; // the ONE copy of the effective-stuff construction
import { parseCatalogCsv, type Card } from "../src/data/catalog.ts";
import { QUICK, inValueWindow, isPit, n_, buildCwhitSample, wellSampled, FIELD_N, type SampleDeps } from "../src/eval/cwhit/sample.ts";
import { opponentSet } from "../src/eval/cwhit/realized.ts";
import { loadWindow } from "../src/training/loader.ts";

const repo = new Repository("data");
await seedDefaults(repo); await seedEras(repo); await seedAccounts(repo);
const state = (await repo.load<{ activeModelId?: string; catalogSourceId?: string }>("state", "app")) ?? {};
type TM_ = { id: string; eventForm?: EventForm; wobaWeights?: WobaWeights; ratingEnvelope?: RatingEnvelope; trainingMeans?: TrainingMeans;
  platoon?: { pit: { hand: string; vsRHB: number; vsLHB: number }[]; hit: { hand: string; vsRHP: number; vsLHP: number }[] } };
const trained = (await repo.loadAll<TM_>("trained-models")).find((x) => x.id === state.activeModelId);
if (!trained?.eventForm || !trained.wobaWeights || !trained.platoon || !trained.trainingMeans) throw new Error("active model missing eventForm/wobaWeights/platoon/trainingMeans");
const rp = makeRawPolyModel(trained.eventForm);
const model = (await repo.loadAll<Model>("models"))[0]!;
const eras = new Map((await repo.loadAll<Era>("eras")).map((e) => [e.id, e]));
const parks = new Map((await repo.loadAll<Park>("parks")).map((p) => [p.id, p]));
const tournaments = await repo.loadAll<Tournament>("tournaments");
const bq = tournaments.find((t) => t.id === "bronze-quick")!;
const coeffs = resolveCoeffs(model, eras.get(bq.eraId)!, parks.get(bq.parkId)!, bq.softcaps);
applyWobaWeights(coeffs, trained.wobaWeights);
const derived = computeDerived(coeffs);
const srcId = state.catalogSourceId ?? "cdmx";
const baseCards = parseCatalogCsv(readFileSync(`data/imports/${srcId}.csv`, "utf8")).cards
  .filter((c) => String(c["Variant"] ?? "").toUpperCase() !== "Y");
const ref: FieldStats = computeUnifiedFieldStats(baseCards, coeffs, rp, FIELD_N, true);
const deps: SampleDeps = {
  baseCards, coeffs, derived, eventForm: trained.eventForm, model: rp, W: trained.wobaWeights, ref,
  envelope: trained.ratingEnvelope,
  pitExp: new Map(trained.platoon.pit.map((p) => [p.hand, { wR: p.vsRHB, wL: p.vsLHB }])),
  hitExp: new Map(trained.platoon.hit.map((p) => [p.hand, { wR: p.vsRHP, wL: p.vsLHP }])),
};
const res = buildCwhitSample(deps);

// THE FIT DOMAIN, read off the deployed artifact — never re-derived or assumed.
const K = trained.eventForm.pit.k as { mu: number; sd: number; uMin?: number; uMax?: number; curve?: { kind: string; degree: number } };
if (K.uMin === undefined || K.uMax === undefined)
  throw new Error("the deployed pit.k curve carries NO stored fit domain — step 0 cannot be run against an unstamped curve");
const zOf = (r: number) => (r - K.mu) / K.sd;
const rOf = (z: number) => K.mu + z * K.sd;

console.log(`\n╔═══ CENTERPIECE #2 STEP 0 — EFFECTIVE STUFF vs THE K CURVE'S FIT DOMAIN ═══╗`);
console.log(`model '${trained.id}' | catalog '${srcId}' | corpus ${res.source.kind === "capture" ? res.source.dir : "legacy"} | floor BF>=${res.floors.minBf}`);
console.log(`\nDEPLOYED pit.k curve: ${K.curve?.kind}-${K.curve?.degree}  mu=${K.mu.toFixed(2)}  sd=${K.sd.toFixed(2)}`);
console.log(`FIT DOMAIN z=[${K.uMin.toFixed(3)}, ${K.uMax.toFixed(3)}]  ⇒  stuff rating [${rOf(K.uMin).toFixed(1)}, ${rOf(K.uMax).toFixed(1)}]`);
console.log(`training mean stuff = ${trained.trainingMeans.pit.stu} (z=${zOf(trained.trainingMeans.pit.stu!).toFixed(2)})   ratingEnvelope.pit.stu = ${trained.ratingEnvelope?.pit?.stu}`);
console.log(`\nNOTE ON WHAT THE DOMAIN IS AND IS NOT: [uMin,uMax] is the SPAN of the fit, not its density.`);
console.log(`Training DENSITY is not recoverable from the artifact (ratingEnvelope carries the max only),`);
console.log(`so "sparse low tail" cannot be settled here — it needs the league exports, stated separately.`);

/** This card's platoon exposure weights (the trained per-hand blend ourPit uses). */
const sideW = (c: Card) => deps.pitExp.get(n_(c["Throws"]) === 2 ? "L" : n_(c["Throws"]) === 3 ? "S" : "R") ?? { wR: 0.5, wL: 0.5 };

const pctl = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))]!; };
const share = (xs: number[], f: (x: number) => boolean) => xs.filter(f).length / (xs.length || 1);
const f2 = (x: number, w = 7) => x.toFixed(2).padStart(w);

interface Row { tier: string; set: string; n: number; zs: number[]; raws: number[] }
const rows: Row[] = [];

for (const win of QUICK) {
  const basePool = baseCards.filter((c) => inValueWindow(c, win));
  const poolField = computeUnifiedFieldStats(basePool, coeffs, rp, FIELD_N, true);
  const pt = buildPoolTransform(ref, poolField, deps.envelope);
  const byCid = new Map(opponentSet(baseCards, win, "pit").map((o) => [o.cid, o.card]));

  /** The exposure-weighted effective stuff of one card — per side through applyAffine (the exact
   *  argument ourPit feeds the curve), then blended by the SAME platoon weights ourPit blends with,
   *  so a single z per card is reported without inventing a second convention. The construction
   *  now lives in src/model/k-support.ts (it is shared with the C4 low-support display flag) —
   *  this tool CALLS it rather than keeping a second copy. */
  const effStu = (c: Card): number => effectiveStuff(c, pt, sideW(c));
  const rawStu = (c: Card): number => {
    const hand = n_(c["Throws"]) === 2 ? "L" : n_(c["Throws"]) === 3 ? "S" : "R";
    const { wR, wL } = deps.pitExp.get(hand) ?? { wR: 0.5, wL: 0.5 };
    return wR * n_(c["Stuff vR"]) + wL * n_(c["Stuff vL"]);
  };

  // FULL POOL (base cards only — production's basePool, the distribution-setting set).
  const pool = basePool.filter((c) => isPit(c));
  rows.push({ tier: win.tier, set: "full pool", n: pool.length, zs: pool.map((c) => zOf(effStu(c))), raws: pool.map(rawStu) });

  // REALIZED WELL-SAMPLED — the cards the needs are actually measured over. Variant-correct: a v5 is
  // its own card at its own effective stuff, resolved through the cid the builder joined on.
  const played: Card[] = [];
  for (const r of res.recs) {
    if (r.tier !== win.tier || r.role !== "pit" || !wellSampled(r)) continue;
    const c = byCid.get(r.cid); if (c) played.push(c);
  }
  rows.push({ tier: win.tier, set: "realized", n: played.length, zs: played.map((c) => zOf(effStu(c))), raws: played.map(rawStu) });
}

console.log(`\n── EFFECTIVE STUFF in z units of the K curve (own-gap applied, exposure-blended) ──`);
console.log(`   'realized' = well-sampled matched pitchers, i.e. the exact cards the needs are measured over.`);
console.log(`\n  tier      set            N       min      p10     p50      p90      max   │  below uMin   below z=-1   raw stu p50`);
for (const r of rows) {
  const below = 100 * share(r.zs, (z) => z < K.uMin!), belowM1 = 100 * share(r.zs, (z) => z < -1);
  console.log(`  ${r.tier.padEnd(9)} ${r.set.padEnd(11)} ${String(r.n).padStart(5)}  ${f2(pctl(r.zs, 0))}${f2(pctl(r.zs, .10))}${f2(pctl(r.zs, .50))}${f2(pctl(r.zs, .90))}${f2(pctl(r.zs, 1))}   │ ${below.toFixed(1).padStart(9)}%  ${belowM1.toFixed(1).padStart(9)}%   ${pctl(r.raws, .50).toFixed(1).padStart(9)}`);
}

// ── THE DECIDER: TRAINING DENSITY, not just the domain span ──────────────────
//
// The prereg says the span alone cannot separate its second reading ("inside, but in the sparse low
// tail") from its third ("well-supported interior"), and that density has to come from the league
// exports rather than the artifact. So it does — through the SAME loader and the SAME row selection
// and weighting the trainer uses, not a re-derivation:
//   trainEventPitching: players = obs.filter(o => o.pitch.BF >= minBF), weights = BF^0.75
// vL and vR are separate observations there, which is also how they are counted here.
{
  const root = (trained as { datasetRoot?: string }).datasetRoot ?? "League Files";
  const win = (trained as { window?: number[] }).window;
  const minBF = (trained as { minPA?: number }).minPA ?? 1000;
  const loaded = loadWindow(root, win && win.length ? win : undefined);
  const tr = loaded.observations
    .filter((o) => o.pitch.BF >= minBF && Number.isFinite(o.ratings.pitch.stu))
    .map((o) => ({ z: zOf(o.ratings.pitch.stu), w: Math.pow(o.pitch.BF, 0.75) }))
    .sort((a, b) => a.z - b.z);
  const wTot = tr.reduce((a, x) => a + x.w, 0);
  /** weighted quantile on the training z distribution */
  const wq = (p: number) => { let acc = 0; for (const x of tr) { acc += x.w; if (acc >= p * wTot) return x.z; } return tr[tr.length - 1]?.z ?? NaN; };
  /** share of TRAINING WEIGHT below a z */
  const wBelow = (z: number) => tr.reduce((a, x) => a + (x.z < z ? x.w : 0), 0) / (wTot || 1);

  console.log(`\n── LEAGUE TRAINING SUPPORT for the K curve (root '${root}', window ${JSON.stringify(win)}, BF>=${minBF}, weights BF^0.75) ──`);
  console.log(`   N obs = ${tr.length} (vL and vR counted separately, as the trainer counts them)`);
  console.log(`   training z quantiles:  p01 ${wq(.01).toFixed(2)}   p05 ${wq(.05).toFixed(2)}   p10 ${wq(.10).toFixed(2)}   p25 ${wq(.25).toFixed(2)}   p50 ${wq(.50).toFixed(2)}   p90 ${wq(.90).toFixed(2)}`);
  console.log(`   share of training weight below z=-1: ${(100 * wBelow(-1)).toFixed(1)}%   below z=-2: ${(100 * wBelow(-2)).toFixed(1)}%   below uMin: ${(100 * wBelow(K.uMin!)).toFixed(1)}%`);

  console.log(`\n── THE COMPARISON THAT DECIDES STEP 0 ──`);
  console.log(`   For each tier's REALIZED cards: how much LEAGUE TRAINING WEIGHT sits below that card's z.`);
  console.log(`   A card at a z where the training percentile is tiny is a card the curve was barely fitted for.`);
  console.log(`\n  tier      realized p10 z  → train pctile │ realized p50 z → train pctile │ % of realized cards below train p05`);
  for (const r of rows.filter((x) => x.set === "realized")) {
    const p10 = pctl(r.zs, .10), p50 = pctl(r.zs, .50);
    const tp05 = wq(.05);
    console.log(`  ${r.tier.padEnd(9)} ${f2(p10)}        ${(100 * wBelow(p10)).toFixed(1).padStart(6)}%   │ ${f2(p50)}       ${(100 * wBelow(p50)).toFixed(1).padStart(6)}%   │ ${(100 * share(r.zs, (z) => z < tp05)).toFixed(1).padStart(6)}%`);
  }

  // ── WHAT THE TAIL CAN ACTUALLY DO ──────────────────────────────────────────
  //
  // The median card being well-supported and the bottom decile being thinly supported are BOTH true,
  // and the prereg's three readings do not cover that mixed case. This converts it into a number.
  //
  // A calibration slope is a VARIANCE-WEIGHTED quantity: beta = Cov(pred,obs)/Var(pred), so a card's
  // influence on the tier's slope goes as (pred - mean)^2. A thinly-supported region can only drive
  // the need to the extent it carries the tier's predicted-K VARIANCE. If the thin low tail holds a
  // small share of that variance, no local error living there can produce a slope of 1.5-1.8, and the
  // hypothesis is dead regardless of how wrong the curve is down there.
  console.log(`\n── VARIANCE LEVERAGE OF THE THINLY-SUPPORTED REGION ──`);
  console.log(`   Share of each tier's realized SUM (pred_k9 - mean)^2 contributed by cards below the`);
  console.log(`   league training p05 / p10 in effective stuff. This bounds what a low-region curve`);
  console.log(`   error could contribute to that tier's calibration slope.`);
  console.log(`\n  tier      N    cards<p05   VARIANCE share <p05   cards<p10   VARIANCE share <p10`);
  const t05 = wq(.05), t10 = wq(.10);
  for (const win of QUICK) {
    const basePool = baseCards.filter((c) => inValueWindow(c, win));
    const poolField = computeUnifiedFieldStats(basePool, coeffs, rp, FIELD_N, true);
    const pt = buildPoolTransform(ref, poolField, deps.envelope);
    const byCid = new Map(opponentSet(baseCards, win, "pit").map((o) => [o.cid, o.card]));
    const pts: { z: number; k: number }[] = [];
    for (const r of res.recs) {
      if (r.tier !== win.tier || r.role !== "pit" || !wellSampled(r)) continue;
      const c = byCid.get(r.cid); if (!c || !Number.isFinite(r.ours.k9)) continue;
      pts.push({ z: zOf(effectiveStuff(c, pt, sideW(c))), k: r.ours.k9! }); // same shared construction

    }
    const mk = pts.reduce((a, p) => a + p.k, 0) / (pts.length || 1);
    const tot = pts.reduce((a, p) => a + (p.k - mk) ** 2, 0);
    const shareVar = (thr: number) => pts.reduce((a, p) => a + (p.z < thr ? (p.k - mk) ** 2 : 0), 0) / (tot || 1);
    const n05 = pts.filter((p) => p.z < t05).length, n10 = pts.filter((p) => p.z < t10).length;
    console.log(`  ${win.tier.padEnd(9)} ${String(pts.length).padStart(3)}   ${String(n05).padStart(7)}      ${(100 * shareVar(t05)).toFixed(1).padStart(11)}%   ${String(n10).padStart(7)}      ${(100 * shareVar(t10)).toFixed(1).padStart(11)}%`);
  }
}

console.log(`\n── HOW MUCH OF THE DOMAIN'S LOW END IS OCCUPIED ──`);
console.log(`   The curve was fitted from z=${K.uMin.toFixed(2)} (stuff ${rOf(K.uMin).toFixed(0)}). A card at z=-1 sits at stuff ${rOf(-1).toFixed(0)}.`);
console.log(`   The training MEAN sits at z=${zOf(trained.trainingMeans.pit.stu!).toFixed(2)}, so anything materially below 0 is`);
console.log(`   below the centre of the fit even when it is inside the span.`);

console.log(`\n(end of centerpiece #2 step 0 — domain occupancy, measurement only)`);
