// THROWAWAY diagnostic (tournament-model planning). Uses LEAGUE data — where the true vL/vR
// split IS known — to answer two questions about no-split tournament play, WITHOUT collecting
// any tournament data:
//
//   A) SENSITIVITY — how much do hitter values/rankings move as the platoon-capture rate ρ
//      swings from uncapped-heavy-platoon (ρ→1: a card always gets its favorable matchup) to
//      capped-low-platoon (ρ→0.5: it plays both sides equally)? deployed(ρ) = ρ·fav + (1−ρ)·off.
//      This is exactly WinParams.platoonCapture / effectiveWoba. It tells us how much getting the
//      per-format exposure wrong actually costs in card value + ranking.
//
//   B) RECOVERABILITY — can the AGGREGATE ρ of a format be backed out of COMBINED (no-split)
//      stat lines + the known league curve? For a specialist, ρ is algebraically invertible:
//      ρ̂ = (V_obs − off)/(fav − off), where fav/off are the league model's per-side predictions.
//      Well-conditioned only for big-gap specialists (the cards where ρ matters). We simulate
//      combined outcomes at a TRUE ρ with tournament-scale PA noise, invert per card, inverse-
//      variance-aggregate, and Monte-Carlo the recovered ρ across PA budgets — answering "how
//      much specialist PA pins ρ to ±0.05?".
//
//   run: node tools/tournament-exposure-stress.ts

import { existsSync } from "node:fs";
import { loadWindow, availableYears, type TrainObs } from "../src/training/loader.ts";
import { fitHitForm, predictHitForm, RAWPOLY_HIT } from "../src/training/forms.ts";

const ROOT = ["League Files", "Model 2037 and 2038"].find((d) => existsSync(d));
if (!ROOT) { console.error("no training data dir"); process.exit(1); }

const WOBA_PA_SD = 0.42;   // sd of a single plate appearance's wOBA (well-established ≈ 0.42)
const MINPA_FIT = 1000;    // deployed-fit qualifier (matches the server)
const MINPA_CARD = 300;    // a card needs both sides + this combined PA to enter the analysis

// ── Load + fit the deployed hitting curve, then pull each card's true vL/vR wOBA ──────────────
const years = availableYears(ROOT);
const window = years.slice(-2);
const { observations } = loadWindow(ROOT, window);
const hitFit = fitHitForm(RAWPOLY_HIT, observations.filter((o) => o.hit.PA >= MINPA_FIT));

// Pair the two side-observations of each card (base/variant kept distinct). We don't care which
// side is which — only the two predicted wOBAs (fav = better side, off = worse) and the PA.
const groups = new Map<string, TrainObs[]>();
for (const o of observations) {
  if (o.hit.PA <= 0) continue;
  const k = `${o.cid}|${o.variant ? "V" : "B"}`;
  (groups.get(k) ?? groups.set(k, []).get(k)!).push(o);
}
interface Card { fav: number; off: number; gap: number; pa: number }
const cards: Card[] = [];
for (const g of groups.values()) {
  if (g.length < 2) continue;                      // need both sides
  const w = g.map((o) => predictHitForm(hitFit, o));
  const pa = g.reduce((s, o) => s + o.hit.PA, 0);
  if (pa < MINPA_CARD) continue;
  const fav = Math.max(...w), off = Math.min(...w);
  cards.push({ fav, off, gap: fav - off, pa });
}
cards.sort((a, b) => b.gap - a.gap);
const gaps = cards.map((c) => c.gap);
const pct = (arr: number[], p: number) => arr.slice().sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor(p * arr.length))]!;
console.log(`\n=== Tournament exposure stress test — root=${ROOT}, window=${window.join("+")} ===`);
console.log(`paired hitter cards (both sides, ≥${MINPA_CARD} PA): ${cards.length}`);
console.log(`vL/vR wOBA gap (pts): median ${(1000 * pct(gaps, 0.5)).toFixed(1)}, p90 ${(1000 * pct(gaps, 0.9)).toFixed(1)}, max ${(1000 * Math.max(...gaps)).toFixed(1)}`);
const specialists = cards.filter((c) => c.gap >= 0.020);
console.log(`"specialists" (gap ≥ 20 pts): ${specialists.length} of ${cards.length}`);

// ── Experiment A: ρ SENSITIVITY of value + ranking ────────────────────────────────────────────
const RHOS = [1.0, 0.9, 0.8, 0.7, 0.6, 0.5];
const deployed = (c: Card, rho: number) => rho * c.fav + (1 - rho) * c.off;
// rank map (1 = best) for a given ρ
const rankAt = (rho: number) => {
  const order = cards.map((c, i) => ({ i, v: deployed(c, rho) })).sort((a, b) => b.v - a.v);
  const rank = new Array(cards.length); order.forEach((o, r) => (rank[o.i] = r + 1));
  return rank as number[];
};
const spearman = (a: number[], b: number[]) => {
  const n = a.length, ma = (n + 1) / 2;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { const x = a[i]! - ma, y = b[i]! - ma; num += x * y; da += x * x; db += y * y; }
  return num / Math.sqrt(da * db);
};
const rankHi = rankAt(1.0);            // uncapped-heavy-platoon reference
console.log(`\n── A) ρ sensitivity (ranking vs the ρ=1.0 uncapped reference) ──`);
console.log(`   value swing per card from ρ=1.0→0.5 = ½·gap → median ${(1000 * pct(gaps, 0.5) / 2).toFixed(1)} pts, p90 ${(1000 * pct(gaps, 0.9) / 2).toFixed(1)} pts`);
const top = (rank: number[], n: number) => new Set(rank.map((r, i) => ({ r, i })).filter((x) => x.r <= n).map((x) => x.i));
for (const rho of RHOS) {
  const rk = rankAt(rho);
  const rho1Top26 = top(rankHi, 26), rhoTop26 = top(rk, 26);
  const rho1Top100 = top(rankHi, 100), rhoTop100 = top(rk, 100);
  const keep26 = [...rhoTop26].filter((i) => rho1Top26.has(i)).length;
  const keep100 = [...rhoTop100].filter((i) => rho1Top100.has(i)).length;
  console.log(`   ρ=${rho.toFixed(1)}: Spearman vs ρ=1.0 = ${spearman(rankHi, rk).toFixed(4)}   top-26 kept ${keep26}/26   top-100 kept ${keep100}/100`);
}
// Which cards move most between the uncapped (ρ=1) and capped (ρ=0.6) regimes?
const rk06 = rankAt(0.6);
const movers = cards.map((c, i) => ({ i, gap: c.gap, move: rk06[i]! - rankHi[i]! })).sort((a, b) => Math.abs(b.move) - Math.abs(a.move)).slice(0, 8);
console.log(`   biggest rank moves ρ=1.0→0.6 (− = rises when platoon capture drops; balanced bats gain):`);
for (const m of movers) console.log(`      gap ${(1000 * m.gap).toFixed(0)} pts  rank ${rankHi[m.i]}→${rk06[m.i]}  (${m.move > 0 ? "+" : ""}${m.move})`);

// ── Experiment B: can we RECOVER ρ from combined (no-split) lines + the league curve? ─────────
// mulberry32 seeded RNG + Box–Muller normal (deterministic; Math.random avoided for reproducibility).
function rng(seed: number) { return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const normal = (u: () => number) => { const a = Math.max(u(), 1e-12), b = u(); return Math.sqrt(-2 * Math.log(a)) * Math.cos(2 * Math.PI * b); };

const RHO_TRUE = 0.85;   // an uncapped-ish true deployment
const BUDGETS = [100, 300, 1000, 3000];  // simulated PA per card in a tournament dataset
const SIMS = 400;
console.log(`\n── B) recover the aggregate ρ from combined lines (true ρ=${RHO_TRUE}, ${cards.length} cards) ──`);
console.log(`   per-card ρ̂=(V−off)/(fav−off), inverse-variance weighted (w ∝ gap²·PA). Monte-Carlo over ${SIMS} sims:`);
for (const budget of BUDGETS) {
  const sigma = WOBA_PA_SD / Math.sqrt(budget);
  const recs: number[] = [];
  for (let s = 0; s < SIMS; s++) {
    const u = rng(s * 2654435761 + budget);
    let wsum = 0, wrho = 0;
    for (const c of cards) {
      if (c.gap < 1e-4) continue;
      const V = RHO_TRUE * c.fav + (1 - RHO_TRUE) * c.off + sigma * normal(u);
      const rhoHat = (V - c.off) / c.gap;
      const w = (c.gap * c.gap) / (sigma * sigma); // inverse-variance of ρ̂ (∝ gap²·PA)
      wsum += w; wrho += w * rhoHat;
    }
    recs.push(wrho / wsum);
  }
  const mean = recs.reduce((s, x) => s + x, 0) / recs.length;
  const sd = Math.sqrt(recs.reduce((s, x) => s + (x - mean) ** 2, 0) / recs.length);
  const totalPA = budget * cards.length;
  console.log(`   PA/card ${String(budget).padStart(4)} (total ${(totalPA / 1000).toFixed(0)}k):  ρ_recovered = ${mean.toFixed(3)} ± ${sd.toFixed(3)}   → ±${(2 * sd).toFixed(3)} at 95%`);
}
console.log(`\n   (±0.05 on ρ ⇒ need sd ≲ 0.025. Read the smallest PA/card row meeting that; multiply by`);
console.log(`    cards to get total specialist-PA, then divide by the per-tournament PA in the sizing table.)`);
process.exit(0);
