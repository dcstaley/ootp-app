// THE ARCHETYPE LEDGER — does the event model systematically mis-value player TYPES?
//   run: node tools/cwhit-archetypes.ts
//
// DEREK'S QUESTION (verbatim in substance, handoff #3 §5): "Events are the main focus right now,
// because I'm worried we're undervaluing or overvaluing certain types of players (ex: HR hitters)."
// This tool answers it in HIS terms: one table, per-archetype mwOBA mis-valuation, with CIs.
//
// METHOD:
//   · The judged sample is THE scorecard sample — built by the ONE shared builder
//     (src/eval/cwhit/sample.ts): same model, same neutral env, same own-gap pool transform, same
//     fingerprint join (ambiguous collisions already dropped, misses excluded), same well-sampled bar.
//   · Archetypes are defined from WITHIN-POOL rating quantiles PER TIER (so "elite" is pool-relative:
//     an iron elite-power bat is elite among iron-eligible cards, not among diamond ones). A card can
//     belong to several archetypes.
//   · The headline number is LEVEL-FREE: per rec, (pred − obs) batting wOBA MINUS the role×tier mean
//     bias. Every known level/frame constant (and the anchor convention — Ruling 1) is removed, so
//     what remains is pure TYPE-RELATIVE mis-valuation: "vs the average judged card of this role and
//     tier, how much extra/missing value does this TYPE get?" By construction the judged-sample mean
//     is 0 per role×tier — archetype deviations are zero-sum against the rest of the sample.
//   · SIGN IS NORMALIZED TO VALUATION: + = we OVER-value the archetype, − = we UNDER-value it.
//     (Hitter: over-value = pred wOBA above obs. Pitcher: over-value = pred wOBAA BELOW obs —
//     the pitcher sign is flipped from raw pred−obs. Stated per table so nobody has to re-derive it.)
//   · CIs: stratified card bootstrap (resample cards within each tier, re-derive the tier centering
//     each rep — so the centering's own sampling error is inside the CI, not ignored).
//   · CHANNEL DRIVER: per-channel one-at-a-time substitution into a COMMON assembly (obs line with
//     one predicted channel swapped in), centered per role×tier like the total. The hitter assembly
//     uses a fixed 0.30 non-HR XBH share — fine for ATTRIBUTION deltas because both sides go through
//     the identical assembly (the scorecard's XBH lesson applies to card-to-card SHAPE, not to this);
//     whatever the four channels cannot reach (hit-mix + interaction) is reported as `resid`, never
//     swept up.
//
// EVAL FRAME (Ruling 1 / handoff #3 §3d): judged on the RAW (unanchored) event-model line — `ours`,
// never `oursDep` — and on BATTING-ONLY wOBA recomputed from cwhit's raw events with OUR weights
// (his pwOBA is never truth). Measurement only; nothing here feeds the scoring path.

import { readFileSync } from "node:fs";
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { resolveCoeffs, type Model } from "../src/config/coeff-resolve.ts";
import type { Era, Park, Tournament } from "../src/config/tournament.ts";
import {
  makeRawPolyModel, computeUnifiedFieldStats, applyWobaWeights, computeDerived,
  type EventForm, type FieldStats, type RatingEnvelope, type WobaWeights,
} from "../src/scoring-core/index.ts";
import { parseCatalogCsv, type Card } from "../src/data/catalog.ts";
import { makeVariant } from "../src/data/variants.ts";
import { pitWobaFromChannels, type WobaWeights as WW } from "../src/eval/cwhit/audit.ts";
import { HBP_PER_PA } from "../src/eval/cwhit/scorecard.ts";
import { qualityBins } from "../src/eval/cwhit/two-ledger.ts";
import {
  buildCwhitSample, wellSampled, handLetter, isPit, n_, FIELD_N, MIN_IP, MIN_PA, QUICK,
  type Rec, type SampleDeps, type Exposure,
} from "../src/eval/cwhit/sample.ts";

const f = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "n/a");
const sgn = (x: number, d = 2) => (Number.isFinite(x) ? `${x >= 0 ? "+" : ""}${x.toFixed(d)}` : "n/a");

// ── deployed model + neutral env (identical boilerplate to tools/cwhit-scorecard.ts) ─────────────
const repo = new Repository("data");
await seedDefaults(repo); await seedEras(repo); await seedAccounts(repo);
const state = (await repo.load<{ activeModelId?: string; catalogSourceId?: string }>("state", "app")) ?? {};
type TM = { id: string; eventForm?: EventForm; wobaWeights?: WobaWeights; ratingEnvelope?: RatingEnvelope; platoon?: { pit: { hand: string; vsRHB: number; vsLHB: number }[]; hit: { hand: string; vsRHP: number; vsLHP: number }[] } };
const trained = (await repo.loadAll<TM>("trained-models")).find((x) => x.id === state.activeModelId);
if (!trained?.eventForm || !trained.wobaWeights || !trained.platoon) throw new Error("active model missing eventForm/wobaWeights/platoon");
const rp = makeRawPolyModel(trained.eventForm);
const W = trained.wobaWeights as WW;
const envelope = trained.ratingEnvelope;
const model = (await repo.loadAll<Model>("models"))[0]!;
const eras = new Map((await repo.loadAll<Era>("eras")).map((e) => [e.id, e]));
const parks = new Map((await repo.loadAll<Park>("parks")).map((p) => [p.id, p]));
const bq = (await repo.loadAll<Tournament>("tournaments")).find((t) => t.id === "bronze-quick")!;   // neutral era/park
const coeffs = resolveCoeffs(model, eras.get(bq.eraId)!, parks.get(bq.parkId)!, bq.softcaps);
applyWobaWeights(coeffs, trained.wobaWeights);
const derived = computeDerived(coeffs);
const pitExp: Exposure = new Map(trained.platoon.pit.map((p) => [p.hand, { wR: p.vsRHB, wL: p.vsLHB }]));
const hitExp: Exposure = new Map(trained.platoon.hit.map((p) => [p.hand, { wR: p.vsRHP, wL: p.vsLHP }]));

const srcId = state.catalogSourceId ?? "cdmx";
const baseCards = parseCatalogCsv(readFileSync(`data/imports/${srcId}.csv`, "utf8")).cards.filter((c) => String(c["Variant"] ?? "").toUpperCase() !== "Y");
const ref: FieldStats = computeUnifiedFieldStats(baseCards, coeffs, rp, FIELD_N, true);

const deps: SampleDeps = { baseCards, coeffs, derived, eventForm: trained.eventForm, model: rp, W, ref, envelope, pitExp, hitExp };
const { recs } = buildCwhitSample(deps);
const kept = recs.filter(wellSampled);

// ── archetype rating axes (exposure-weighted vR/vL blend — the same weights the prediction uses) ──
// Quantile membership is invariant to any monotone per-axis transform, so raw catalog ratings are
// equivalent to own-gap-lifted ones for defining WITHIN-POOL quantiles; the blend just collapses the
// two sides the way the model's exposure weights do.
function blendRatings(c: Card, role: "pit" | "hit"): Record<string, number> {
  const exp = role === "pit" ? pitExp.get(handLetter(n_(c["Throws"]))) : hitExp.get(handLetter(n_(c["Bats"])));
  const { wR, wL } = exp ?? { wR: 0.5, wL: 0.5 };
  const b = (field: string) => wR * n_(c[`${field} vR`]) + wL * n_(c[`${field} vL`]);
  return role === "pit"
    ? { stu: b("Stuff"), con: b("Control"), pbabip: b("pBABIP") }
    : { pow: b("Power"), eye: b("Eye"), babip: b("BABIP"), kRat: b("Avoid K") };
}
const AXES: Record<"pit" | "hit", string[]> = { pit: ["stu", "con", "pbabip"], hit: ["pow", "eye", "babip", "kRat"] };

// ratings per judged card, keyed the way the sample keys cards: (//Card Title, VLvl).
const ratingsBy = new Map<string, Record<string, number>>();
for (const bc of baseCards) {
  for (const [vlvl, c] of [[0, bc], [5, makeVariant(bc)]] as const) {
    const key = `${bc["//Card Title"]}|${vlvl}`;
    if (ratingsBy.has(key)) console.log(`⚠ duplicate //Card Title "${key}" — first occurrence kept; archetype ratings may be wrong for it`);
    else ratingsBy.set(key, blendRatings(c, isPit(c) ? "pit" : "hit"));
  }
}

// ── WITHIN-POOL quantile thresholds, per tier×role (VLvl-0 card pool — the sample.ts convention) ──
interface Q { p25: number; p50: number; p75: number }
function quantile(sorted: number[], p: number): number {
  if (!sorted.length) return NaN;
  const i = (sorted.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (i - lo);
}
const poolQ = new Map<string, Record<string, Q>>();          // `${tier}|${role}` → axis → Q
const poolRatings = new Map<string, Record<string, number>[]>();  // pool cards' ratings (for shares)
for (const { tier, cap } of QUICK) {
  for (const role of ["pit", "hit"] as const) {
    const pool = baseCards
      .filter((c) => n_(c["Card Value"]) <= cap && (role === "pit") === isPit(c))
      .map((c) => blendRatings(c, role));
    poolRatings.set(`${tier}|${role}`, pool);
    const q: Record<string, Q> = {};
    for (const a of AXES[role]) {
      const xs = pool.map((r) => r[a]!).filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
      q[a] = { p25: quantile(xs, 0.25), p50: quantile(xs, 0.50), p75: quantile(xs, 0.75) };
    }
    poolQ.set(`${tier}|${role}`, q);
  }
}

// ── archetype definitions (a card can be in several; "balanced" = no extreme on any axis) ─────────
interface Arch {
  id: string; role: "pit" | "hit"; label: string;
  axis?: string;                                   // the defining axis (selection guard reports it)
  test: (r: Record<string, number>, q: Record<string, Q>) => boolean;
}
const within = (x: number, q: Q) => x >= q.p25 && x <= q.p75;
const ARCH: Arch[] = [
  { id: "elite-power", role: "hit", label: "Elite power (POW ≥ pool p75)", axis: "pow", test: (r, q) => r.pow! >= q.pow!.p75 },
  { id: "walk-machine", role: "hit", label: "Walk machine (EYE ≥ p75)", axis: "eye", test: (r, q) => r.eye! >= q.eye!.p75 },
  { id: "contact", role: "hit", label: "Contact (BABIP ≥ p75)", axis: "babip", test: (r, q) => r.babip! >= q.babip!.p75 },
  { id: "whiff-slugger", role: "hit", label: "Whiff-prone slugger (POW ≥ p75 & AvoidK ≤ p25)", axis: "pow", test: (r, q) => r.pow! >= q.pow!.p75 && r.kRat! <= q.kRat!.p25 },
  { id: "balanced-hit", role: "hit", label: "Balanced (all 4 axes inside p25–p75)", test: (r, q) => AXES.hit.every((a) => within(r[a]!, q[a]!)) },
  { id: "power-arm", role: "pit", label: "Power arm (STU ≥ p75)", axis: "stu", test: (r, q) => r.stu! >= q.stu!.p75 },
  { id: "control-artist", role: "pit", label: "Control artist (CON ≥ p75 & STU ≤ p50)", axis: "con", test: (r, q) => r.con! >= q.con!.p75 && r.stu! <= q.stu!.p50 },
  { id: "gb-contact", role: "pit", label: "GB/contact (pBABIP ≥ p75)", axis: "pbabip", test: (r, q) => r.pbabip! >= q.pbabip!.p75 },
  { id: "balanced-pit", role: "pit", label: "Balanced (all 3 axes inside p25–p75)", test: (r, q) => AXES.pit.every((a) => within(r[a]!, q[a]!)) },
];

// ── per-rec measures: composite diff + channel substitution contributions ────────────────────────
const CHANS: Record<"pit" | "hit", string[]> = { pit: ["k9", "bb9", "hr9", "babip"], hit: ["bbPct", "soPct", "hr600", "babip"] };
const HIT_XBH_SHARE = 0.30;
/** Hitter composite from the four headline channels ONLY — the attribution assembly. The fixed XBH
 *  share is safe HERE (identical assembly both sides ⇒ deltas are channel-attributable); the TOTAL
 *  mis-valuation never uses it (it uses the exact recon wOBA the scorecard judges). */
function hitWobaFromChannels(bbPct: number, soPct: number, hr600: number, babip: number, w: WW): number {
  const bb = bbPct / 100, k = soPct / 100, hr = hr600 / 600;
  const bip = Math.max(1 - bb - HBP_PER_PA - k - hr, 0);
  const nHH = babip * bip, xbh = HIT_XBH_SHARE * nHH, oneB = nHH - xbh;
  return w.bb * bb + w.hbp * HBP_PER_PA + w.b1 * oneB + w.xbh * xbh + w.hr * hr;
}

interface MRec {
  rec: Rec;
  ratings: Record<string, number>;
  memb: string[];                    // archetype ids
  total: number;                     // pred − obs composite wOBA (exact recon channel — the headline)
  ch: Record<string, number>;        // per-channel substitution contribution to pred−obs, wOBA units
  resid: number;                     // total − Σ ch  (hit-mix + assembly interaction)
}
let missingRatings = 0;
const mrecs: MRec[] = [];
for (const r of kept) {
  const ratings = ratingsBy.get(`${r.title}|${r.vlvl}`);
  if (!ratings) { missingRatings++; continue; }
  const q = poolQ.get(`${r.tier}|${r.role}`)!;
  const memb = ARCH.filter((a) => a.role === r.role && a.test(ratings, q)).map((a) => a.id);
  const asm = (c: Record<string, number>) => (r.role === "pit"
    ? pitWobaFromChannels(c["k9"]!, c["bb9"]!, c["hr9"]!, c["babip"]!, W)
    : hitWobaFromChannels(c["bbPct"]!, c["soPct"]!, c["hr600"]!, c["babip"]!, W));
  const base = asm(r.obs);
  const ch: Record<string, number> = {};
  for (const c of CHANS[r.role]) ch[c] = asm({ ...r.obs, [c]: r.ours[c]! }) - base;
  const total = r.ours["woba"]! - r.obs["woba"]!;
  const resid = total - CHANS[r.role].reduce((a, c) => a + ch[c]!, 0);
  mrecs.push({ rec: r, ratings, memb, total, ch, resid });
}

// ── centering + aggregation machinery ─────────────────────────────────────────────────────────────
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
const wmean = (xs: number[], ws: number[]) => {
  let s = 0, sw = 0;
  for (let i = 0; i < xs.length; i++) { s += xs[i]! * ws[i]!; sw += ws[i]!; }
  return sw > 0 ? s / sw : NaN;
};
/** Valuation sign: + = OVER-valued. Hitters keep pred−obs; pitchers flip (higher pred wOBAA = rated worse). */
const valSign = (role: "pit" | "hit") => (role === "hit" ? 1 : -1);

const tiers = QUICK.map((x) => x.tier);
const byTier = (role: "pit" | "hit") => tiers
  .map((t) => ({ tier: t, rows: mrecs.filter((m) => m.rec.role === role && m.rec.tier === t) }))
  .filter((g) => g.rows.length > 0);

/** Level-free per-rec value: sign-normalized mwOBA, centered on the (possibly resampled) tier mean. */
function centeredVals(groups: { tier: string; rows: MRec[] }[], role: "pit" | "hit", get: (m: MRec) => number, weighted = false): { m: MRec; v: number }[] {
  const out: { m: MRec; v: number }[] = [];
  const s = valSign(role);
  for (const g of groups) {
    const c = weighted ? wmean(g.rows.map(get), g.rows.map((m) => m.rec.sample)) : mean(g.rows.map(get));
    for (const m of g.rows) out.push({ m, v: s * 1000 * (get(m) - c) });
  }
  return out;
}
function archMean(vals: { m: MRec; v: number }[], archId: string, weighted = false): { n: number; mean: number } {
  const mem = vals.filter((x) => x.m.memb.includes(archId));
  return { n: mem.length, mean: weighted ? wmean(mem.map((x) => x.v), mem.map((x) => x.m.rec.sample)) : mean(mem.map((x) => x.v)) };
}

/** Deterministic RNG (mulberry32) — same generator the scorecard's bootstrap uses. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
/** Stratified card bootstrap: resample cards WITHIN each tier, re-derive the tier centering each rep. */
function bootCi(groups: { tier: string; rows: MRec[] }[], role: "pit" | "hit", archId: string, B = 2000, seed = 20260716): { lo: number; hi: number; sig: boolean } {
  const rnd = rng(seed);
  const stats: number[] = [];
  for (let b = 0; b < B; b++) {
    const rs = groups.map((g) => ({ tier: g.tier, rows: g.rows.map(() => g.rows[Math.floor(rnd() * g.rows.length)]!) }));
    const a = archMean(centeredVals(rs, role, (m) => m.total), archId);
    if (a.n >= 2 && Number.isFinite(a.mean)) stats.push(a.mean);
  }
  if (stats.length < 100) return { lo: NaN, hi: NaN, sig: false };
  stats.sort((x, y) => x - y);
  const lo = stats[Math.floor(0.025 * stats.length)]!, hi = stats[Math.min(Math.floor(0.975 * stats.length), stats.length - 1)]!;
  return { lo, hi, sig: lo * hi > 0 };
}

// ═══ header ══════════════════════════════════════════════════════════════════════════════════════
console.log(`\n╔══════════════════════════════════════════════════════════════════════════════════════════╗`);
console.log(`║  THE ARCHETYPE LEDGER — per-TYPE mwOBA mis-valuation (level-free), vs cwhit observed       ║`);
console.log(`╚══════════════════════════════════════════════════════════════════════════════════════════╝`);
console.log(`model '${trained.id}' | catalog '${srcId}' | neutral env | own-gap ON | RAW event-model line (Ruling 1: unanchored)`);
console.log(`metric: batting-only wOBA both sides (his pwOBA never used); + = we OVER-value the type, − = UNDER-value (pitcher sign already flipped)`);
console.log(`level-free: role×tier mean bias subtracted ⇒ frame/format/anchor level constants are OUT of every number below`);
console.log(`sample: ${kept.length} well-sampled joined cards (IP≥${MIN_IP} / PA≥${MIN_PA}); ${missingRatings} dropped for missing ratings lookup`);
const nBy = (role: "pit" | "hit") => byTier(role).map((g) => `${g.tier} ${g.rows.length}`).join(", ");
console.log(`  hitters: ${nBy("hit")}\n  pitchers: ${nBy("pit")}  (diamond pit is a known dead cell)`);
console.log(`\nCAVEAT (pooled rows): the same card recurs across tiers (Quick pools nest), so pooled N overstates`);
console.log(`independent evidence — the bootstrap resamples within tiers and treats tiers as independent. The`);
console.log(`per-tier consistency table is the honest replication test; read pooled + per-tier together.`);

// ═══ A. THE ARCHETYPE TABLE (pooled across tiers) ════════════════════════════════════════════════
console.log(`\n\n╔═══ A. THE ARCHETYPE TABLE — pooled across tiers, level-free mis-valuation in mwOBA ═══════╗`);
for (const role of ["hit", "pit"] as const) {
  const groups = byTier(role);
  if (!groups.length) continue;
  const vals = centeredVals(groups, role, (m) => m.total);
  const chVals = new Map(CHANS[role].map((c) => [c, centeredVals(groups, role, (m) => m.ch[c]!)]));
  const residVals = centeredVals(groups, role, (m) => m.resid);
  console.log(`\n─── ${role === "hit" ? "HITTERS" : "PITCHERS"} (+ = OVER-valued, − = UNDER-valued; mwOBA) ───`);
  console.log(`archetype                                        N   cards   mis-val   [95% CI]        driver (centered channel contributions, mwOBA)`);
  for (const a of ARCH.filter((x) => x.role === role)) {
    const t = archMean(vals, a.id);
    if (t.n < 4) { console.log(`${a.label.padEnd(46)} ${String(t.n).padStart(4)}   (too few members — no read)`); continue; }
    const ci = bootCi(groups, role, a.id);
    const cards = new Set(vals.filter((x) => x.m.memb.includes(a.id)).map((x) => x.m.rec.title)).size;
    const parts = CHANS[role].map((c) => `${c} ${sgn(archMean(chVals.get(c)!, a.id).mean, 1)}`);
    const rs = archMean(residVals, a.id).mean;
    const drv = CHANS[role].reduce((best, c) => (Math.abs(archMean(chVals.get(c)!, a.id).mean) > Math.abs(archMean(chVals.get(best)!, a.id).mean) ? c : best), CHANS[role][0]!);
    console.log(
      `${a.label.padEnd(46)} ${String(t.n).padStart(4)}   ${String(cards).padStart(4)}   ${sgn(t.mean, 2).padStart(7)}${ci.sig ? "*" : " "}  [${sgn(ci.lo, 2)}, ${sgn(ci.hi, 2)}]   ` +
      `${parts.join("  ")}  resid ${sgn(rs, 1)}  ⇒ ${drv.toUpperCase()}`,
    );
  }
  console.log(`  (* = bootstrap 95% CI excludes 0. resid = hit-mix + assembly interaction — the part the 4 channels can't see.)`);
}

// ═══ B. PER-TIER CONSISTENCY ═════════════════════════════════════════════════════════════════════
console.log(`\n\n╔═══ B. PER-TIER CONSISTENCY — the replication test (within-tier centering + within-tier bootstrap) ═══╗`);
for (const role of ["hit", "pit"] as const) {
  const groups = byTier(role);
  if (!groups.length) continue;
  console.log(`\n─── ${role === "hit" ? "HITTERS" : "PITCHERS"} — level-free mis-val (mwOBA) per tier ───`);
  console.log(`archetype                                    ${groups.map((g) => g.tier.padStart(14)).join("")}`);
  for (const a of ARCH.filter((x) => x.role === role)) {
    const cells = groups.map((g) => {
      const one = [{ tier: g.tier, rows: g.rows }];
      const t = archMean(centeredVals(one, role, (m) => m.total), a.id);
      if (t.n < 4) return `(N=${t.n})`.padStart(14);
      const ci = bootCi(one, role, a.id, 2000, 20260716 + g.tier.length);
      return `${sgn(t.mean, 1)}${ci.sig ? "*" : " "} n${t.n}`.padStart(14);
    });
    console.log(`${a.label.slice(0, 44).padEnd(44)} ${cells.join("")}`);
  }
}
console.log(`  (cells with N<4 members are not read; * = within-tier bootstrap CI excludes 0)`);

// ═══ C. SANITY GUARDS ════════════════════════════════════════════════════════════════════════════
console.log(`\n\n╔═══ C. SANITY GUARDS ═══════════════════════════════════════════════════════════════════════╗`);
console.log(`\n── C1. PA/IP-WEIGHTED recompute (weighted tier centering + weighted archetype mean) ──`);
console.log(`If the weighted number moves materially or flips sign vs Table A, low-sample members drive the read.`);
for (const role of ["hit", "pit"] as const) {
  const groups = byTier(role); if (!groups.length) continue;
  const un = centeredVals(groups, role, (m) => m.total);
  const wt = centeredVals(groups, role, (m) => m.total, true);
  const line = ARCH.filter((x) => x.role === role).map((a) => {
    const u = archMean(un, a.id), w = archMean(wt, a.id, true);
    return u.n >= 4 ? `${a.id} ${sgn(u.mean, 1)}→${sgn(w.mean, 1)}` : `${a.id} (n/a)`;
  });
  console.log(`  ${role}: ${line.join("   ")}`);
}

console.log(`\n── C2. SELECTION — could top-100-BY-USAGE capture bias archetype membership? ──`);
console.log(`pool% = archetype share of the tier's eligible VLvl-0 card pool; judged% = share of the judged sample.`);
console.log(`ratio >1 = the type is over-represented among heavily-used cards (usage-selection correlates with the axis).`);
console.log(`axisΔ = judged members' mean defining-axis rating − pool members' mean (in rating points): how much deeper`);
console.log(`        into the tail the judged members sit — a big Δ means the estimate describes the EXTREME of the type.`);
for (const role of ["hit", "pit"] as const) {
  const groups = byTier(role); if (!groups.length) continue;
  console.log(`\n  ${role === "hit" ? "HITTERS" : "PITCHERS"}:`);
  console.log(`  archetype                                        pool%   judged%   ratio    axisΔ`);
  for (const a of ARCH.filter((x) => x.role === role)) {
    let poolIn = 0, poolAll = 0, poolAxis: number[] = [], judIn = 0, judAll = 0, judAxis: number[] = [];
    for (const g of groups) {
      const q = poolQ.get(`${g.tier}|${role}`)!;
      for (const pr of poolRatings.get(`${g.tier}|${role}`)!) {
        poolAll++;
        if (a.test(pr, q)) { poolIn++; if (a.axis) poolAxis.push(pr[a.axis]!); }
      }
      for (const m of g.rows) {
        judAll++;
        if (m.memb.includes(a.id)) { judIn++; if (a.axis) judAxis.push(m.ratings[a.axis]!); }
      }
    }
    const pp = 100 * poolIn / (poolAll || 1), jp = 100 * judIn / (judAll || 1);
    const ratio = pp > 0 ? jp / pp : NaN;
    const dAxis = a.axis ? mean(judAxis) - mean(poolAxis) : NaN;
    const flag = Number.isFinite(ratio) && (ratio > 1.5 || ratio < 0.67) ? "  ⚠ selection-skewed" : "";
    console.log(`  ${a.label.padEnd(46)} ${f(pp, 1).padStart(6)}  ${f(jp, 1).padStart(7)}  ${f(ratio, 2).padStart(6)}  ${a.axis ? sgn(dAxis, 1).padStart(7) : "    n/a"}${flag}`);
  }
}
console.log(`\n  NOTE: level-free centering absorbs the OVERALL quality selection; what it cannot absorb is`);
console.log(`  within-type selection (judged members deeper in the tail than pool-typical members — read axisΔ),`);
console.log(`  and any archetype flagged ⚠ describes the usage-selected end of its type, not the whole pool type.`);
console.log(`  Derek: "top 100 is a capture choice, not a rule" — deeper capture is available if a flag binds.`);

// ═══ D. PRIOR-EVIDENCE RECONCILIATION (salted numbers, recomputed) ═══════════════════════════════
console.log(`\n\n╔═══ D. PRIOR-EVIDENCE RECONCILIATION — do the salted session numbers reproduce here? ═══════╗`);

console.log(`\n── D1. The elite-HR "Q4 cliff" (prior: hitter HR600 bias ≈0 Q1–Q3, −5.48 at Q4 @iron; NON-MONOTONE) ──`);
console.log(`hitter (pred−obs) HR600 by quartile of PREDICTED hr600 (raw units, HR per 600 PA; NEVER fit a line to this):`);
for (const g of byTier("hit")) {
  const p = g.rows.map((m) => m.rec.ours["hr600"]!), o = g.rows.map((m) => m.rec.obs["hr600"]!);
  const bins = qualityBins(p, o, 4);
  console.log(`  ${g.tier.padEnd(8)} ${bins.map((b) => `${b.label} ${sgn(b.bias.est, 2)}${b.bias.sig ? "*" : " "}(n${b.n})`).join("  ")}`);
}

console.log(`\n── D2. Pitcher stuff/control partial slopes (prior, own-gap audit: STU +1.53 mwOBA/+10 sig; CON −0.38 ns) ──`);
console.log(`OLS of within-tier-centered (pred−obs) wOBAA (mwOBA) on within-tier-centered STU + CON, pooled; per +10 rating.`);
console.log(`sign: β>0 ⇒ we predict MORE offense allowed than observed ⇒ we UNDER-value that end of the axis.`);
{
  const g = byTier("pit");
  const rows: { y: number; x: number[] }[] = [];
  for (const grp of g) {
    const cy = mean(grp.rows.map((m) => m.total));
    const cs = mean(grp.rows.map((m) => m.ratings["stu"]!)), cc = mean(grp.rows.map((m) => m.ratings["con"]!));
    for (const m of grp.rows) rows.push({ y: 1000 * (m.total - cy), x: [m.ratings["stu"]! - cs, m.ratings["con"]! - cc] });
  }
  const o = ols(rows.map((r) => r.y), rows.map((r) => r.x), g.length);
  console.log(`  N=${rows.length}: STU ${sgn(o.beta[0]! * 10, 2)} ± ${f(o.se[0]! * 10 * 1.96, 2)}   CON ${sgn(o.beta[1]! * 10, 2)} ± ${f(o.se[1]! * 10 * 1.96, 2)}   (±=95% CI half-width)`);
}

console.log(`\n── D3. Hitter axis partial slopes (prior, own-gap-confounded: EYE +0.77 / POW −1.42 / kRat −1.24 / BABIP −1.66; β>0 = over-value) ──`);
console.log(`OLS of within-tier-centered (pred−obs) wOBA (mwOBA) on the four centered axes, pooled; per +10 rating.`);
{
  const g = byTier("hit");
  const ax = AXES.hit;
  const rows: { y: number; x: number[] }[] = [];
  for (const grp of g) {
    const cy = mean(grp.rows.map((m) => m.total));
    const cx = ax.map((a) => mean(grp.rows.map((m) => m.ratings[a]!)));
    for (const m of grp.rows) rows.push({ y: 1000 * (m.total - cy), x: ax.map((a, i) => m.ratings[a]! - cx[i]!) });
  }
  const o = ols(rows.map((r) => r.y), rows.map((r) => r.x), g.length);
  console.log(`  N=${rows.length}: ` + ax.map((a, i) => `${a} ${sgn(o.beta[i]! * 10, 2)} ±${f(o.se[i]! * 10 * 1.96, 2)}`).join("   "));
}
console.log(``);
process.exit(0);

/** Small OLS (no intercept — data pre-centered within tiers; df charged for the absorbed tier means). */
function ols(y: number[], X: number[][], nTiers: number): { beta: number[]; se: number[] } {
  const n = y.length, k = X[0]?.length ?? 0;
  const xtx: number[][] = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  const xty = new Array<number>(k).fill(0);
  for (let i = 0; i < n; i++) for (let a = 0; a < k; a++) {
    xty[a]! += X[i]![a]! * y[i]!;
    for (let b = 0; b < k; b++) xtx[a]![b]! += X[i]![a]! * X[i]![b]!;
  }
  // Gauss-Jordan inverse of xtx.
  const inv: number[][] = xtx.map((row, i) => [...row, ...row.map((_, j) => (i === j ? 1 : 0))]);
  for (let col = 0; col < k; col++) {
    let piv = col;
    for (let r = col + 1; r < k; r++) if (Math.abs(inv[r]![col]!) > Math.abs(inv[piv]![col]!)) piv = r;
    [inv[col], inv[piv]] = [inv[piv]!, inv[col]!];
    const d = inv[col]![col]!;
    for (let j = 0; j < 2 * k; j++) inv[col]![j]! /= d;
    for (let r = 0; r < k; r++) if (r !== col) {
      const m = inv[r]![col]!;
      for (let j = 0; j < 2 * k; j++) inv[r]![j]! -= m * inv[col]![j]!;
    }
  }
  const beta = Array.from({ length: k }, (_, a) => inv[a]!.slice(k).reduce((s, v, b) => s + v * xty[b]!, 0));
  let rss = 0;
  for (let i = 0; i < n; i++) { const e = y[i]! - beta.reduce((s, b, a) => s + b * X[i]![a]!, 0); rss += e * e; }
  const s2 = rss / Math.max(n - k - nTiers, 1);
  const se = Array.from({ length: k }, (_, a) => Math.sqrt(s2 * inv[a]![k + a]!));
  return { beta, se };
}
