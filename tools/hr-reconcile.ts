// THE RATING→CHANNEL QUARTILE GRID (headline: the HR channel) — level constant, or spread
// compression seen through selection? (Derek work-order 2026-07-16, twice course-corrected.)
//   run: node tools/hr-reconcile.ts
//
// THE HEADLINE QUESTION. Two prior readings on the HR channel appear to contradict:
//   (1) memory `quicks-null-test-and-format-effect`: on OUR quicks exports, observed HR ran BELOW
//       prediction (a "universal format bias" HR ×0.87 — mean-DOWN);
//   (2) the cwhit benchmark scorecard: hitter HR observed ABOVE prediction, concentrated in the
//       top quartile (iron Q4 bias −5.48 per 600 — elite-tail-UP).
// The reconciliation hypothesis: mean-down + top-tail-up is the signature of SPREAD COMPRESSION —
// a compressed predictor over-predicts ordinary power and under-predicts elite power, so the mean
// bias and the tail bias have opposite signs BY CONSTRUCTION of which part of the pool you look at.
//
// PRIORITIES (Derek, 2026-07-16 — supersedes the symmetric "reconciliation" frame):
//   PRIMARY   = the channel structure on CWHIT's data alone, at its 25–100× depth. HR keeps its
//               special duties (the sign quarantine, the headline verdict), but the quartile-table
//               machinery runs over ALL primary rating→channel pairs, per tier, per role:
//                 HITTERS:  EYE→BB%, kRat→SO% (obs converted K/AB→K/PA in the shared builder),
//                           POW→HR/600, BABIP→BABIP, GAP→XBH share ((2B+3B+HR)/H, his convention).
//                 PITCHERS: CON→BB9, STU→K9, HRR→HR9, pBABIP→BABIP.
//               ROLES STRICTLY SEPARATE (the two-ledger test found HR FAILS cross-role sign
//               agreement, so no pooled-role number is quoted anywhere here). Cells are flagged
//               where NON-MONOTONE so nobody fits a line to them later — this quartile view is one
//               of three independently-binned views of the same surface (predicted-value bins and
//               archetype bins run elsewhere), and its unique job is exactly the non-linear
//               structure a linear/predicted-value binning would blur.
//   SECONDARY = our quicks exports as a PIPELINE SANITY TEST only (thin data — 3–9 runnings/tier):
//               does our own export/scoring path show a grossly different HR shape than cwhit's
//               (⇒ era/park config bug on our side)? And: was the ×0.87 level ever distinguishable
//               from 1.0 at our N? If not, the memory claim should be downgraded, and this tool
//               says so with the CI in hand.
//
// READING THE GRID (Ruling-1 scope): a UNIFORM within-role level error is mostly CONVENTION — the
// per-role anchor absorbs it in the deployed composite. The CARD-DEPENDENT part (the quartile
// shape / gradient) is what matters: the anchor cannot absorb a gradient, and a gradient is exactly
// what would mis-order and mis-space elite cards. So the verdict rides the SHAPE of each row, not
// its mean.
//
// PREDICTION BASIS: identical to the benchmark scorecard — the RAW event-model line under the
// own-gap pool transform, NO anchor/sFinal (per-channel rates are anchor-invariant on this neutral
// env; proven empirically in tools/cwhit-two-ledger.ts §0f). The cwhit side comes from the ONE
// shared sample builder (src/eval/cwhit/sample.ts), so these are literally the scorecard's numbers
// re-cut by rating quartile. The one exception is predicted XBH share, which the Rec does not
// carry — it is recomputed through the SAME model/transform calls and CROSS-CHECKED against the
// builder's HR600 to prove the reproduction is exact. Quicks side mirrors the same assembly on our
// own exports (ghost-cleaned in memory via cleanTournamentRows; nothing written).
//
// MEASUREMENT ONLY: fits nothing, changes no scoring, writes nothing.

import Papa from "papaparse";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { resolveCoeffs, type Model } from "../src/config/coeff-resolve.ts";
import type { Era, Park, Tournament } from "../src/config/tournament.ts";
import {
  makeRawPolyModel, computeUnifiedFieldStats, applyWobaWeights, computeDerived,
  buildPoolTransform, applyAffine,
  type EventForm, type FieldStats, type RatingEnvelope, type WobaWeights, type PoolTransform,
} from "../src/scoring-core/index.ts";
import { parseCatalogCsv, type Card } from "../src/data/catalog.ts";
import { makeVariant } from "../src/data/variants.ts";
import { cleanTournamentRows } from "../src/eval/tournament-clean.ts";
import type { WobaWeights as WW } from "../src/eval/cwhit/audit.ts";
import { per600NoiseVar, per9NoiseVar, BF_PER_9 } from "../src/eval/cwhit/scorecard.ts";
import {
  buildCwhitSample, wellSampled, handLetter, isPit, n_, FIELD_N, MIN_IP, MIN_PA, QUICK, inValueWindow, type ValueWindow,
  type Rec, type SampleDeps,
} from "../src/eval/cwhit/sample.ts";
import { meanEst, biasGradient, mmse, type Est } from "../src/eval/cwhit/two-ledger.ts";

const f = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "n/a");
const sgn = (x: number, d = 2) => (Number.isFinite(x) ? `${x >= 0 ? "+" : ""}${x.toFixed(d)}` : "n/a");
const ciS = (e: Est, d = 2) => `${sgn(e.est, d)}${e.sig ? "*" : " "} [${sgn(e.lo, d)},${sgn(e.hi, d)}]`;

// ── deployed model + neutral env (identical to the scorecard / two-ledger setup) ─────────────────
const repo = new Repository("data");
await seedDefaults(repo); await seedEras(repo); await seedAccounts(repo);
const state = (await repo.load<{ activeModelId?: string; catalogSourceId?: string }>("state", "app")) ?? {};
type TM = { id: string; eventForm?: EventForm; wobaWeights?: WobaWeights; ratingEnvelope?: RatingEnvelope; platoon?: { pit: { hand: string; vsRHB: number; vsLHB: number }[]; hit: { hand: string; vsRHP: number; vsLHP: number }[] } };
const trained = (await repo.loadAll<TM>("trained-models")).find((x) => x.id === state.activeModelId);
if (!trained?.eventForm || !trained.wobaWeights || !trained.platoon) throw new Error("active model missing eventForm/wobaWeights/platoon");
const rp = makeRawPolyModel(trained.eventForm);
const W = trained.wobaWeights as WW;
const model = (await repo.loadAll<Model>("models"))[0]!;
const eras = new Map((await repo.loadAll<Era>("eras")).map((e) => [e.id, e]));
const parks = new Map((await repo.loadAll<Park>("parks")).map((p) => [p.id, p]));
const bq = (await repo.loadAll<Tournament>("tournaments")).find((t) => t.id === "bronze-quick")!;
const coeffs = resolveCoeffs(model, eras.get(bq.eraId)!, parks.get(bq.parkId)!, bq.softcaps);
applyWobaWeights(coeffs, trained.wobaWeights);
const derived = computeDerived(coeffs);
const srcId = state.catalogSourceId ?? "cdmx";
const baseCards = parseCatalogCsv(readFileSync(`data/imports/${srcId}.csv`, "utf8")).cards.filter((c) => String(c["Variant"] ?? "").toUpperCase() !== "Y");
const ref: FieldStats = computeUnifiedFieldStats(baseCards, coeffs, rp, FIELD_N, true);
const pitExp = new Map(trained.platoon.pit.map((p) => [p.hand, { wR: p.vsRHB, wL: p.vsLHB }]));
const hitExp = new Map(trained.platoon.hit.map((p) => [p.hand, { wR: p.vsRHP, wL: p.vsLHP }]));
const deps: SampleDeps = { baseCards, coeffs, derived, eventForm: trained.eventForm, model: rp, W, ref, envelope: trained.ratingEnvelope, pitExp, hitExp };

// env sanity — every per-channel claim below assumes the neutral env (all factors 1.0).
const envFactors = [coeffs.era_bb, coeffs.era_k, derived.era_effective_hr, derived.era_h, derived.era_gap, coeffs.park_hr_r, coeffs.park_hr_l];
const envNeutral = envFactors.every((x) => Math.abs(x - 1) < 1e-9);

// ── the quartile axes: the channel-driving RATINGS, exposure-blended, pool-relative ──────────────
// Blended vR/vL by the SAME trained platoon exposure the predicted line uses, so a card sits in
// the quartile its prediction actually lives in.
const blendRating = (c: Card, role: "hit" | "pit", base: string): number => {
  const exp = role === "hit" ? hitExp.get(handLetter(n_(c["Bats"]))) : pitExp.get(handLetter(n_(c["Throws"])));
  const { wR, wL } = exp ?? { wR: 0.5, wL: 0.5 };
  return wR * n_(c[`${base} vR`]) + wL * n_(c[`${base} vL`]);
};
const byTitle = new Map<string, Card>(baseCards.map((c) => [String(c["//Card Title"]), c]));
const cardCache = new Map<Rec, Card | null>();
const cardOf = (r: Rec): Card | null => {
  if (!cardCache.has(r)) {
    const base = byTitle.get(r.title);
    cardCache.set(r, base ? (r.vlvl === 5 ? makeVariant(base) : base) : null);
  }
  return cardCache.get(r)!;
};

// pool-relative quartile machinery. Cuts come from the TIER POOL (every VLvl-0 card under the cap,
// role-filtered) — the population the judged sample was drawn from — NOT from the sample itself.
type Cuts = [number, number, number];
const cutsOf = (pool: number[]): Cuts => {
  const s = [...pool].filter(Number.isFinite).sort((a, b) => a - b);
  const at = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
  return [at(0.25), at(0.5), at(0.75)];
};
const bucketOf = (x: number, c: Cuts): number => (x < c[0] ? 0 : x < c[1] ? 1 : x < c[2] ? 2 : 3);
const poolAxis = (win: ValueWindow, role: "pit" | "hit", ratingBase: string): number[] =>
  baseCards.filter((c) => inValueWindow(c, win) && (role === "pit" ? isPit(c) : !isPit(c)))
    .map((c) => blendRating(c, role === "pit" ? "pit" : "hit", ratingBase));

interface QRow { axis: number; pred: number; obs: number; w: number; nv: number }

/** One quartile cell: exposure-weighted pooled bias (the point estimate Derek asked for) + the
 *  card-level t-CI (the honest uncertainty; cards are the resampling unit). For count channels the
 *  headline tables also print a count-based SE. */
function cell(rows: QRow[], unit: number) {
  const n = rows.length, Wt = rows.reduce((s, r) => s + r.w, 0);
  const pred = rows.reduce((s, r) => s + r.pred * r.w, 0) / (Wt || 1);
  const obs = rows.reduce((s, r) => s + r.obs * r.w, 0) / (Wt || 1);
  const cnt = (obs * Wt) / unit;                       // observed event count in the cell (count channels)
  const sePool = Wt > 0 ? (unit * Math.sqrt(Math.max(cnt, 1))) / Wt : NaN;   // binomial ≈ Poisson on the count
  const card = meanEst(rows.map((r) => r.pred - r.obs));
  return { n, Wt, pred, obs, bias: pred - obs, sePool, card };
}

const monoOf = (biases: number[]): boolean =>
  biases.length < 3 || biases.every((v, i) => i === 0 || v <= biases[i - 1]!) || biases.every((v, i) => i === 0 || v >= biases[i - 1]!);

// ═════════════════════════════════════════════════════════════════════════════════════════════════
console.log(`\n╔════════════════════════════════════════════════════════════════════════════════════════════╗`);
console.log(`║  RATING→CHANNEL QUARTILE GRID — headline: is the HR error a level or a compressed spread?   ║`);
console.log(`╚════════════════════════════════════════════════════════════════════════════════════════════╝`);
console.log(`model '${trained.id}' | catalog '${srcId}' | neutral env (bronze-quick era/park) | own-gap pool transform ON | NO anchor`);
console.log(`env sanity: era_bb=${f(coeffs.era_bb, 3)} era_k=${f(coeffs.era_k, 3)} era_eff_hr=${f(derived.era_effective_hr, 3)} era_h=${f(derived.era_h, 3)} park_hr=${f(coeffs.park_hr_r, 3)}/${f(coeffs.park_hr_l, 3)} ⇒ ${envNeutral ? "ALL 1.0 — the per-channel lines are era/park-free, as required." : "*** NOT NEUTRAL — STOP: an era/park factor is contaminating the channel lines. ***"}`);
console.log(`ROLES ARE NEVER POOLED: the two-ledger test found HR FAILS cross-role sign agreement (hit under-, pit over-predicted),`);
console.log(`so hitter and pitcher grids below are separate ledgers and no cross-role number exists in this tool.`);
console.log(`Ruling-1 scope: a UNIFORM within-role level is mostly convention (the per-role anchor absorbs it); the QUARTILE SHAPE is the verdict.`);

// ═══ PRIMARY — CWHIT DATA (25–100× our depth) ════════════════════════════════════════════════════
console.log(`\n\n╔═══ PRIMARY — THE RATING→CHANNEL GRID ON CWHIT DATA (the deliverable) ═══════════════════════╗`);
console.log(`Judged sample = the scorecard's own (src/eval/cwhit/sample.ts): observed fixtures joined by fingerprint, well-sampled`);
console.log(`(hit PA≥${MIN_PA} / pit IP≥${MIN_IP}). Quartiles are WITHIN-POOL: cuts from every VLvl-0 card under the tier VAL cap; a judged card`);
console.log(`(incl. v5 variants) is placed against those cuts by its own exposure-blended rating. Cells report bias = pred − obs:`);
console.log(`PA/IP-weighted point estimate ± the card-level t 95% half-width, with per-cell n in parentheses. '—' = no judged card`);
console.log(`in that pool quartile (top-100-by-usage selection). mono = quartile biases monotone; NON-MONO rows must never be`);
console.log(`summarized by a fitted line (this is the structure the predicted-value/linear views blur).`);
console.log(`β = OLS slope of bias on the PREDICTED channel (the clean regressor); slope(obs~pred) = 1−β, noise-immune, 1.0 = calibrated.`);

const { recs } = buildCwhitSample(deps);

// predicted XBH share is NOT carried on the Rec — recompute through the SAME calls the builder makes,
// and cross-check HR600 against the builder's own value to prove the reproduction exact.
const xbhPred = new Map<Rec, number>();
{
  let maxDiff = 0;
  for (const win of QUICK) {
    const { tier } = win;
    const basePool = baseCards.filter((c) => inValueWindow(c, win));
    const pt = buildPoolTransform(ref, computeUnifiedFieldStats(basePool, coeffs, rp, FIELD_N, true), trained.ratingEnvelope);
    for (const r of recs.filter((x) => x.tier === tier && x.role === "hit")) {
      const c = cardOf(r); if (!c) continue;
      const { wR, wL } = hitExp.get(handLetter(n_(c["Bats"]))) ?? { wR: 0.5, wL: 0.5 };
      const side = (s: "R" | "L") => {
        const t = pt.hit[s === "R" ? "vR" : "vL"];
        return rp.predictHitting({
          eye: applyAffine(n_(c[`Eye v${s}`]), t?.eye), pow: applyAffine(n_(c[`Power v${s}`]), t?.pow),
          kRat: applyAffine(n_(c[`Avoid K v${s}`]), t?.kRat), babip: applyAffine(n_(c[`BABIP v${s}`]), t?.babip),
          gap: applyAffine(n_(c[`Gap v${s}`]), t?.gap),
          speed: n_(c["Speed"]), steal: n_(c["Stealing"]), run: n_(c["Baserunning"]),
        }, coeffs);
      };
      const eR = side("R"), eL = side("L");
      const oneB = wR * eR.oneB + wL * eL.oneB, GAP = wR * eR.GAP + wL * eL.GAP, HR = wR * eR.HR + wL * eL.HR;
      xbhPred.set(r, ((GAP + HR) / Math.max(oneB + GAP + HR, 1e-9)) * 100);
      maxDiff = Math.max(maxDiff, Math.abs(HR - r.ours.hr600!));
    }
  }
  console.log(`\nXBH-share reproduction cross-check: max |recomputed HR600 − builder HR600| over all judged hitters = ${maxDiff.toExponential(2)} ⇒ ${maxDiff < 1e-9 ? "EXACT — the XBH line is the builder's own math." : "*** MISMATCH — the XBH reproduction has drifted from the shared builder; do not trust the GAP→XBH% row. ***"}`);
}

interface PairDef {
  name: string; axis: string; ch: string; d: number; unit: number; headline?: boolean; note?: string;
  pred?: (r: Rec) => number; obs?: (r: Rec) => number; nv?: (r: Rec) => number;
}
const PAIRS: Record<"hit" | "pit", PairDef[]> = {
  hit: [
    { name: "EYE→BB%", axis: "Eye", ch: "bbPct", d: 2, unit: 100 },
    { name: "kRat→SO%", axis: "Avoid K", ch: "soPct", d: 2, unit: 100, note: "obs SO% converted K/AB→K/PA in the shared builder; high kRat = FEWER K, so Q4 = elite avoiders" },
    { name: "POW→HR600", axis: "Power", ch: "hr600", d: 2, unit: 600, headline: true, nv: (r) => per600NoiseVar(r.obs.hr600!, r.sample) },
    { name: "BABIP→BABIP", axis: "BABIP", ch: "babip", d: 3, unit: 1 },
    { name: "GAP→XBH%", axis: "Gap", ch: "xbhPct", d: 1, unit: 100, note: "XBH% = (2B+3B+HR)/H — cwhit's measured convention (slope 1.027 vs his column); pred = the model's own hit mix", pred: (r) => xbhPred.get(r) ?? NaN, obs: (r) => r.raw.xbhPct ?? NaN },
  ],
  pit: [
    { name: "CON→BB9", axis: "Control", ch: "bb9", d: 2, unit: 9, note: "high CON = FEWER walks, so Q4 = elite control" },
    { name: "STU→K9", axis: "Stuff", ch: "k9", d: 2, unit: 9 },
    { name: "HRR→HR9", axis: "pHR", ch: "hr9", d: 2, unit: 9, headline: true, note: "high HRR = fewer HR allowed, so Q4 = elite suppressors", nv: (r) => per9NoiseVar(r.obs.hr9!, r.sample) },
    { name: "pBABIP→BABIP", axis: "pBABIP", ch: "babip", d: 3, unit: 1 },
  ],
};

const rowsFor = (tier: string, role: "hit" | "pit", p: PairDef): QRow[] =>
  recs.filter((r) => r.tier === tier && r.role === role && wellSampled(r)).flatMap((r) => {
    const c = cardOf(r); if (!c) return [];
    const pred = p.pred ? p.pred(r) : r.ours[p.ch]!;
    const obs = p.obs ? p.obs(r) : r.obs[p.ch]!;
    if (!Number.isFinite(pred) || !Number.isFinite(obs)) return [];
    return [{ axis: blendRating(c, role, p.axis), pred, obs, w: r.sample, nv: p.nv ? p.nv(r) : NaN }];
  });

const flags: string[] = [];
const gridSummaries: { role: string; pair: string; tier: string; cells: (ReturnType<typeof cell> | null)[]; mono: boolean; beta: Est; slope: Est }[] = [];

for (const role of ["hit", "pit"] as const) {
  console.log(`\n\n═══════════ ${role === "hit" ? "HITTERS" : "PITCHERS"} — cells are bias = pred − obs (PA/IP-weighted ± card t half-width (n)) ═══════════`);
  for (const p of PAIRS[role]) {
    console.log(`\n── ${role.toUpperCase()} ${p.name}${p.headline ? "   ◄ HEADLINE" : ""} ──${p.note ? `\n   (${p.note})` : ""}`);
    console.log(`tier      N    ${[1, 2, 3, 4].map((q) => `Q${q}`.padEnd(19)).join("")}mono?      β(bias~pred)          slope(obs~pred)`);
    const pooled: QRow[] = [];
    for (const win of QUICK) {
      const { tier } = win;
      const rows = rowsFor(tier, role, p);
      if (rows.length < 8) { if (rows.length) console.log(`${tier.padEnd(9)} ${String(rows.length).padStart(3)}  (too few well-sampled cards to cut into quartiles)`); continue; }
      const cuts = cutsOf(poolAxis(win, role, p.axis));
      const cs: (ReturnType<typeof cell> | null)[] = [];
      for (let b = 0; b < 4; b++) {
        const rs = rows.filter((r) => bucketOf(r.axis, cuts) === b);
        cs.push(rs.length ? cell(rs, p.unit) : null);
      }
      const present = cs.filter((c): c is NonNullable<typeof c> => !!c);
      const mono = monoOf(present.map((c) => c.bias));
      const g = biasGradient(rows.map((r) => r.pred), rows.map((r) => r.obs));
      const m = mmse(rows.map((r) => r.pred), rows.map((r) => r.obs), rows.every((r) => Number.isFinite(r.nv)) ? rows.map((r) => r.nv) : undefined);
      gridSummaries.push({ role, pair: p.name, tier, cells: cs, mono, beta: g.slope, slope: m.slope });
      const cellStr = (c: ReturnType<typeof cell> | null) =>
        (c ? `${sgn(c.bias, p.d)}${c.card.sig ? "*" : " "}±${f(Number.isFinite(c.card.se) ? (c.card.hi - c.card.lo) / 2 : NaN, p.d)}(${c.n})` : "—").padEnd(19);
      console.log(`${tier.padEnd(9)} ${String(rows.length).padStart(3)}  ${cs.map(cellStr).join("")}${(mono ? "yes" : "NON-MONO").padEnd(10)} ${ciS(g.slope, 3).padEnd(21)} ${ciS(m.slope, 2)}`);
      if (!mono) flags.push(`${role} ${p.name} @ ${tier}: NON-MONOTONE quartile biases [${present.map((c) => sgn(c.bias, p.d)).join(", ")}] — do NOT summarize with a fitted line`);
      if (!g.slope.sig && present.some((c) => c.card.sig && Math.abs(c.bias) > 2 * Math.min(...present.map((x) => Math.abs(x.bias) || Infinity)))) {
        flags.push(`${role} ${p.name} @ ${tier}: linear β is n.s. but a quartile cell is CI-clear — structure a linear/predicted-value binning would MISS`);
      }
      for (const r of rows) pooled.push({ ...r, axis: bucketOf(r.axis, cuts) });
    }
    if (pooled.length >= 8) {
      const cs = [0, 1, 2, 3].map((b) => { const rs = pooled.filter((r) => r.axis === b); return rs.length ? cell(rs, p.unit) : null; });
      const present = cs.filter((c): c is NonNullable<typeof c> => !!c);
      const mono = monoOf(present.map((c) => c.bias));
      const cellStr = (c: ReturnType<typeof cell> | null) =>
        (c ? `${sgn(c.bias, p.d)}${c.card.sig ? "*" : " "}±${f(Number.isFinite(c.card.se) ? (c.card.hi - c.card.lo) / 2 : NaN, p.d)}(${c.n})` : "—").padEnd(19);
      console.log(`${"ALL".padEnd(9)} ${String(pooled.length).padStart(3)}  ${cs.map(cellStr).join("")}${mono ? "yes" : "NON-MONO"}   (rows keep their own tier's pool-relative quartile)`);
      if (!mono) flags.push(`${role} ${p.name} @ ALL-TIERS-POOLED: NON-MONOTONE [${present.map((c) => sgn(c.bias, p.d)).join(", ")}]`);
    }
  }
}

// headline detail: the HR channel with pred/obs levels + spread diagnostics per tier.
console.log(`\n\n── HEADLINE DETAIL — the HR channel, pred & obs levels per quartile (the elite-HR verdict rides here) ──`);
for (const [role, p] of [["hit", PAIRS.hit.find((x) => x.headline)!], ["pit", PAIRS.pit.find((x) => x.headline)!]] as const) {
  console.log(`\n  ${role === "hit" ? "HITTERS HR/600 by POW quartile" : "PITCHERS HR9 by HRR quartile (separate ledger; high HRR = elite suppression)"}`);
  for (const win of QUICK) {
    const { tier } = win;
    const rows = rowsFor(tier, role, p);
    if (rows.length < 8) continue;
    const cuts = cutsOf(poolAxis(win, role, p.axis));
    console.log(`  ${tier.toUpperCase()} — N=${rows.length}, ${Math.round(rows.reduce((s, r) => s + r.w, 0)).toLocaleString()} ${role === "hit" ? "PA" : "IP"}; pool cuts ${cuts.map((c) => f(c, 1)).join("/")}`);
    console.log(`    qtile      n     pred     obs     bias ±1.96·SEcount   card t-CI`);
    for (let b = 0; b < 4; b++) {
      const rs = rows.filter((r) => bucketOf(r.axis, cuts) === b);
      if (!rs.length) { console.log(`    Q${b + 1}         0     (no judged cards in this pool quartile)`); continue; }
      const c = cell(rs, p.unit);
      console.log(`    Q${b + 1}       ${String(c.n).padStart(3)}  ${f(c.pred, 2).padStart(7)} ${f(c.obs, 2).padStart(7)}   ${sgn(c.bias, 2).padStart(7)} ± ${f(1.96 * c.sePool, 2).padEnd(7)}    ${ciS(c.card, 2)}`);
    }
    const m = mmse(rows.map((r) => r.pred), rows.map((r) => r.obs), rows.map((r) => r.nv));
    console.log(`    spread SD(pred)/SD(obs): raw ${f(m.ratioRaw, 2)} deconv ${f(m.ratioDeconv, 2)} | calib slope ${ciS(m.slope, 2)} | ${m.verdict}`);
  }
}

if (flags.length) {
  console.log(`\n── STRUCTURE FLAGS (rows a fitted line would misrepresent) ──`);
  for (const s of flags) console.log(`  ⚑ ${s}`);
} else {
  console.log(`\n── STRUCTURE FLAGS: none — every quartile row is monotone and consistent with its linear summary. ──`);
}

// ═══ SECONDARY — OUR QUICKS EXPORTS (pipeline sanity ONLY; thin data) ════════════════════════════
console.log(`\n\n╔═══ SECONDARY — OUR QUICKS EXPORTS: PIPELINE SANITY TEST (thin data — NOT an equal party) ═══╗`);
console.log(`Purpose: (a) does OUR export/scoring path show a GROSSLY different HR shape than cwhit's (⇒ era/park config bug on`);
console.log(`our side)? (b) was the memory's HR ×0.87 level ever distinguishable from 1.0 at our N? Ghost-cleaning applied in`);
console.log(`memory per running via cleanTournamentRows (PA−BF ledger detector); nothing written.`);
console.log(`Same prediction basis as above: raw event model + own-gap transform for the tier's VAL cap, trained platoon exposure.`);
console.log(`Inclusion: ≥100 PA (hit) / ≥100 BF (pit) — far shallower than cwhit's ≥1000, so per-card noise is ~3× larger.`);
console.log(`Pitcher rates are per-600-BF scaled to HR9 via the shared BF/9=${BF_PER_9.toFixed(1)} constant (cancels in pred−obs shape).`);

const QDIRS = [
  { tier: "open", dir: "Tournament Data/Quicks - Open", valueMax: Infinity },
  { tier: "bronze", dir: "Tournament Data/Quicks - Bronze", valueMax: 69 },
  { tier: "gold", dir: "Tournament Data/Quicks - Gold", valueMax: 89 },
];
const POS_PIT = new Set(["SP", "RP", "CL", "P"]);
const R = (r: Record<string, unknown>, s: string, c: string) => n_(r[`${c} ${s}`]);

interface QAgg { r: Record<string, unknown>; hPA: number; hHR: number; pBF: number; pHR: number }
const qLevels: { tier: string; role: "hit" | "pit"; mult: number; lo: number; hi: number; n: number; W: number }[] = [];

/** Compact quartile print for the quicks sanity tables (same cell machinery as the grid). */
function quicksTable(label: string, rows: QRow[], pool: number[], unit: number, d: number) {
  if (rows.length < 8) { console.log(`  ${label}: N=${rows.length} — too few for quartiles.`); return; }
  const cuts = cutsOf(pool);
  const cs = [0, 1, 2, 3].map((b) => { const rs = rows.filter((r) => bucketOf(r.axis, cuts) === b); return rs.length ? cell(rs, unit) : null; });
  const present = cs.filter((c): c is NonNullable<typeof c> => !!c);
  const mono = monoOf(present.map((c) => c.bias));
  const g = biasGradient(rows.map((r) => r.pred), rows.map((r) => r.obs));
  const cellStr = (c: ReturnType<typeof cell> | null) => (c ? `${sgn(c.bias, d)}${c.card.sig ? "*" : " "}±${f((c.card.hi - c.card.lo) / 2, d)}(${c.n})` : "—").padEnd(19);
  console.log(`  ${label.padEnd(24)} N=${String(rows.length).padStart(3)}  ${cs.map(cellStr).join("")}${mono ? "mono" : "NON-MONO"}  β ${ciS(g.slope, 3)}`);
}

for (const { tier, dir, valueMax } of QDIRS) {
  if (!existsSync(dir)) { console.log(`\n  ${tier.toUpperCase()}: directory "${dir}" not found — skipped.`); continue; }
  const basePool = baseCards.filter((c) => inValueWindow(c, { tier, valueMax }));
  const pt: PoolTransform = buildPoolTransform(ref, computeUnifiedFieldStats(basePool, coeffs, rp, FIELD_N, true), trained.ratingEnvelope);

  const agg = new Map<string, QAgg>();
  console.log(`\n─── QUICKS ${tier.toUpperCase()} (value ≤ ${Number.isFinite(valueMax) ? valueMax : "none"}) — per-running ghost-cleaning ──`);
  let files = 0;
  for (const fn of readdirSync(dir).filter((x) => x.endsWith(".csv"))) {
    files++;
    const rows = Papa.parse(readFileSync(`${dir}/${fn}`, "utf8"), { header: true, skipEmptyLines: true }).data as Record<string, unknown>[];
    const { cleaned, removed, report } = cleanTournamentRows(rows);
    console.log(`  ${fn.padEnd(32)} ledger ${String(report.ledger).padStart(6)} → ${report.status.padEnd(10)}${report.flagged.length ? ` removed ${report.flagged.map((o) => `${o.org} (imb ${o.imb}, asym ${f(o.asym * 100, 1)}%)`).join("; ")} [${removed.length} rows]` : ""}`);
    for (const r of cleaned) {
      const key = `${r.CID}|${r.VLvl}`;
      let a = agg.get(key);
      if (!a) { a = { r, hPA: 0, hHR: 0, pBF: 0, pHR: 0 }; agg.set(key, a); }
      a.hPA += n_(r.PA); a.hHR += n_(r.HR); a.pBF += n_(r.BF); a.pHR += n_(r.HR_1);
    }
  }
  console.log(`  (${files} running(s) aggregated)`);

  // hitters — predicted HR/600 from the row's own (variant-adjusted) ratings, own-gap transformed.
  const hitRows: QRow[] = [...agg.values()]
    .filter((a) => a.hPA >= 100 && !POS_PIT.has(String(a.r.POS)))
    .map((a) => {
      const { wR, wL } = hitExp.get(String(a.r.B)) ?? { wR: 0.5, wL: 0.5 };
      const side = (s: "vR" | "vL") => {
        const t = pt.hit[s];
        return rp.predictHitting({
          eye: applyAffine(R(a.r, s, "EYE"), t?.eye), pow: applyAffine(R(a.r, s, "POW"), t?.pow),
          kRat: applyAffine(R(a.r, s, "K"), t?.kRat), babip: applyAffine(R(a.r, s, "BA"), t?.babip),
          gap: applyAffine(R(a.r, s, "GAP"), t?.gap), speed: 0, steal: 0, run: 0,
        }, coeffs).HR;
      };
      const pred = wR * side("vR") + wL * side("vL");
      const obs = (a.hHR * 600) / a.hPA;
      const axis = wR * R(a.r, "vR", "POW") + wL * R(a.r, "vL", "POW");
      return { axis, pred, obs, w: a.hPA, nv: per600NoiseVar(obs, a.hPA) };
    });
  // pitchers — per-600-BF, displayed as HR9 via the shared constant (identical scaling both sides).
  const pitRows: QRow[] = [...agg.values()]
    .filter((a) => a.pBF >= 100)
    .map((a) => {
      const { wR, wL } = pitExp.get(String(a.r.T)) ?? { wR: 0.5, wL: 0.5 };
      const side = (s: "vR" | "vL") => {
        const t = pt.pit[s];
        return rp.predictPitching({
          con: applyAffine(R(a.r, s, "CON"), t?.con), stu: applyAffine(R(a.r, s, "STU"), t?.stu),
          pbabip: applyAffine(R(a.r, s, "PBABIP"), t?.pbabip), hrr: applyAffine(R(a.r, s, "HRA"), t?.hrr),
        }, coeffs).HR;
      };
      const per9 = BF_PER_9 / 600;
      const pred = (wR * side("vR") + wL * side("vL")) * per9;
      const obs = (a.pHR * 600 / a.pBF) * per9;
      const axis = wR * R(a.r, "vR", "HRA") + wL * R(a.r, "vL", "HRA");
      const ip = a.pBF / (BF_PER_9 / 9);
      return { axis, pred, obs, w: ip, nv: per9NoiseVar(obs, ip) };
    });

  console.log(`  cells: bias = pred − obs, weighted ± card t half-width (n); quartiles within-pool as in the primary grid`);
  quicksTable(`hit HR/600 by POW qtile`, hitRows, poolAxis({ tier, valueMax }, "hit", "Power"), 600, 2);
  quicksTable(`pit HR9 by HRR qtile`, pitRows, poolAxis({ tier, valueMax }, "pit", "pHR"), 9, 2);

  // THE LEVEL + ITS CI — the ×0.87 question. Multiplier = observed total HR / predicted total HR,
  // CI from the Poisson-scale uncertainty on the observed count (pred is deterministic).
  for (const [role, rows, unit] of [["hit", hitRows, 600], ["pit", pitRows, 9]] as const) {
    if (!rows.length) continue;
    const Wt = rows.reduce((s, r) => s + r.w, 0);
    const predTot = rows.reduce((s, r) => s + (r.pred * r.w) / unit, 0);   // predicted HR count
    const obsTot = rows.reduce((s, r) => s + (r.obs * r.w) / unit, 0);     // observed HR count
    const se = Math.sqrt(Math.max(obsTot, 1));
    const mult = obsTot / predTot, lo = (obsTot - 1.96 * se) / predTot, hi = (obsTot + 1.96 * se) / predTot;
    qLevels.push({ tier, role, mult, lo, hi, n: rows.length, W: Wt });
    console.log(`  LEVEL (${role}): observed ${Math.round(obsTot)} HR vs predicted ${f(predTot, 0)} ⇒ mult obs/pred ${f(mult, 3)} [${f(lo, 3)}, ${f(hi, 3)}]  ${lo <= 1 && hi >= 1 ? "— CI INCLUDES 1.0" : "— CI excludes 1.0"}`);
  }
}

console.log(`\n── QUICKS LEVEL SUMMARY — was "HR ×0.87" ever distinguishable from 1.0? ──`);
console.log(`tier      role   N     ${"exposure".padEnd(10)} mult obs/pred [95% CI]     verdict`);
for (const q of qLevels) {
  console.log(`${q.tier.padEnd(9)} ${q.role.padEnd(5)} ${String(q.n).padStart(3)}   ${String(Math.round(q.W)).padStart(8)}   ${f(q.mult, 3)} [${f(q.lo, 3)}, ${f(q.hi, 3)}]        ${q.lo <= 1 && q.hi >= 1 ? "indistinguishable from 1.0" : q.mult < 1 ? "below 1.0 (CI-clear)" : "above 1.0 (CI-clear)"}`);
}
console.log(`  (CI is the Poisson-scale sampling band on the observed HR count alone — no between-running variance component,`);
console.log(`   so it is if anything TOO NARROW; a CI that still includes 1.0 is decisive against a claimed level.)`);
console.log(``);
process.exit(0);
