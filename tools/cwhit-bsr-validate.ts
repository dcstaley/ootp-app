// BsR VALIDATION — deployed baserunning value vs cwhit OBSERVED baserunning (post-fix confirmation).
// We just shipped baserunning into the deployed hitter Offense score: scoreCard(card,cfg).hit.bsr600
// is a card's predicted BsR in runs/600 (UBR + steals, side-invariant, POOL-CENTERED ⇒ mean≈0).
// cwhit's observed BsR ≈ wSB600 + UBR600 (raw event columns = ground truth). Per Quick tier + pooled,
// we compare OUR bsr600 to cwhit's observed BsR. Because ours is pool-centered (mean 0) while cwhit's
// is on its own population, we RE-CENTER both to their own means before comparing — the read is on
// CORRELATION, SPREAD-RATIO and relative ordering, not absolute bias. Well-sampled cards only (PA≥1000).
//   run: node tools/cwhit-bsr-validate.ts
import { readFileSync, readdirSync } from "node:fs";
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { resolveCoeffs, type Model } from "../src/config/coeff-resolve.ts";
import type { Era, Park, Tournament } from "../src/config/tournament.ts";
import {
  scoreCard, calibrate, computeDerived, makeRawPolyModel, applyWobaWeights, applyAffine,
  computeUnifiedFieldStats, buildPoolTransform,
  type EventForm, type FieldStats, type PoolTransform, type RatingEnvelope, type WobaWeights,
} from "../src/scoring-core/index.ts";
import { HIT_BIP_ADJ } from "../src/model/curves.ts";
import { parseCatalogCsv, type Card } from "../src/data/catalog.ts";
import { makeVariant } from "../src/data/variants.ts";
import { parseCwhitHit, joinCwhit, type JoinCard, type JoinObs } from "../src/eval/cwhit/index.ts";

const FIX = "fixtures/cwhit", FIELD_N = 50, MIN_PA = 1000;
const n = (v: unknown): number => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const handLetter = (c: number) => (c === 2 ? "L" : c === 3 ? "S" : "R");
const fmt = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "n/a");
const QUICK = [{ tier: "iron", cap: 59 }, { tier: "bronze", cap: 69 }, { tier: "silver", cap: 79 }, { tier: "gold", cap: 89 }, { tier: "diamond", cap: 99 }];

// ── load deployed model + neutral (bronze-quick) env coeffs ──
const repo = new Repository("data");
await seedDefaults(repo); await seedEras(repo); await seedAccounts(repo);
const state = (await repo.load<{ activeModelId?: string; catalogSourceId?: string }>("state", "app")) ?? {};
type TM = { id: string; eventForm?: EventForm; wobaWeights?: WobaWeights; ratingEnvelope?: RatingEnvelope; platoon?: { hit: { hand: string; vsRHP: number; vsLHP: number }[] } };
const trained = (await repo.loadAll<TM>("trained-models")).find((x) => x.id === state.activeModelId);
if (!trained?.eventForm || !trained.wobaWeights || !trained.platoon) throw new Error("active model missing eventForm/weights/platoon");
const ef = trained.eventForm;
const rp = makeRawPolyModel(ef);
const W = trained.wobaWeights;
const envelope = trained.ratingEnvelope;
const model = (await repo.loadAll<Model>("models"))[0]!;
const eras = new Map((await repo.loadAll<Era>("eras")).map((e) => [e.id, e]));
const parks = new Map((await repo.loadAll<Park>("parks")).map((p) => [p.id, p]));
const bq = (await repo.loadAll<Tournament>("tournaments")).find((t) => t.id === "bronze-quick")!; // neutral era-2010/park
const coeffs = resolveCoeffs(model, eras.get(bq.eraId)!, parks.get(bq.parkId)!, bq.softcaps);
applyWobaWeights(coeffs, trained.wobaWeights);
const derived = computeDerived(coeffs);
const hitExp = new Map(trained.platoon.hit.map((p) => [p.hand, { wR: p.vsRHP, wL: p.vsLHP }]));

const srcId = state.catalogSourceId ?? "cdmx";
const baseCards = parseCatalogCsv(readFileSync(`data/imports/${srcId}.csv`, "utf8")).cards.filter((c) => String(c["Variant"] ?? "").toUpperCase() !== "Y");
const isHitter = (c: Card) => String(c["Position"]).trim() !== "1";
const cardName = (c: Card) => `${(c["FirstName"] ?? "").trim()} ${(c["LastName"] ?? "").trim()}`.trim();
const ref: FieldStats = computeUnifiedFieldStats(baseCards, coeffs, rp, FIELD_N, true);

// Fingerprint (bbPct/soPct/hr600/babip) for the join ONLY — mirrors cwhit-audit-deployed-hit's
// combinedHit (own-gap path). NOT the validated quantity; bsr600 comes straight from scoreCard.
function fingerprint(c: Card, pt: PoolTransform) {
  const { wR, wL } = hitExp.get(handLetter(n(c["Bats"]))) ?? { wR: 0.5, wL: 0.5 };
  const side = (s: "R" | "L") => {
    const t = pt.hit[s === "R" ? "vR" : "vL"];
    return rp.predictHitting({ eye: applyAffine(n(c[`Eye v${s}`]), t?.eye), pow: applyAffine(n(c[`Power v${s}`]), t?.pow), kRat: applyAffine(n(c[`Avoid K v${s}`]), t?.kRat), babip: applyAffine(n(c[`BABIP v${s}`]), t?.babip), gap: applyAffine(n(c[`Gap v${s}`]), t?.gap), speed: n(c["Speed"]), steal: n(c["Steal Rate"]), run: n(c["Baserunning"]) }, coeffs);
  };
  const eR = side("R"), eL = side("L");
  const BB = wR * eR.BB + wL * eL.BB, SO = wR * eR.SO + wL * eL.SO, HR = wR * eR.HR + wL * eL.HR, oneB = wR * eR.oneB + wL * eL.oneB, GAP = wR * eR.GAP + wL * eL.GAP;
  const BIP = Math.max(600 - BB - SO - HR - HIT_BIP_ADJ, 1);
  return { bbPct: BB / 6, soPct: SO / 6, hr600: HR, babip: (oneB + GAP) / BIP };
}

interface Rec { cid: string; name: string; tier: string; hand: string; pa: number; ours: number; obs: number }
const recs: Rec[] = [];

for (const { tier, cap } of QUICK) {
  const f = `cwhit-${tier}-hit.tsv`;
  if (!readdirSync(FIX).includes(f)) continue;
  // Per-tier deployed config: own-gap PoolTransform (tier pool vs full-catalog ref) + calibration
  // (calScales carries brCenterHit, the per-pool baserunning centering that bsr600 subtracts).
  const basePool = baseCards.filter((c) => n(c["Card Value"]) <= cap);
  const pt = buildPoolTransform(ref, computeUnifiedFieldStats(basePool, coeffs, rp, FIELD_N, true), envelope);
  const calScales = calibrate(basePool, { coeffs, derived, eventForm: ef, poolTransform: pt });
  const cfg = { coeffs, derived, calScales, eventForm: ef, poolTransform: pt };

  const cards: JoinCard[] = [], byId = new Map<string, { pa: number; ours: number; hand: string }>();
  for (const bc of baseCards) for (const [vlvl, c] of [[0, bc], [5, makeVariant(bc)]] as const) {
    if (!isHitter(c) || n(c["Card Value"]) > cap) continue;
    const cid = `${bc["Card ID"]}${vlvl ? "#V" : ""}`;
    const fp = fingerprint(c, pt);
    const bsr600 = scoreCard(c, cfg).hit.bsr600; // ← the DEPLOYED quantity under validation
    cards.push({ cid, name: cardName(c), val: n(c["Card Value"]), vlvl, hand: handLetter(n(c["Bats"])), primary: [fp.babip], validate: [fp.bbPct, fp.soPct, fp.hr600] });
    byId.set(cid, { pa: 0, ours: bsr600, hand: handLetter(n(c["Bats"])) });
  }
  const { rows: cwrows } = parseCwhitHit(readFileSync(`${FIX}/${f}`, "utf8"));
  const obs: JoinObs<typeof cwrows[0]>[] = cwrows.map((r) => ({ name: r.name, val: r.val, vlvl: r.vlvl, hand: r.hand, primary: [r.babip], validate: [r.bbPct, r.soPct, r.hr600], sample: r.pa, row: r }));
  for (const m of joinCwhit(obs, cards).matched) {
    const b = byId.get(m.card.cid)!, o = m.obs.row;
    recs.push({ cid: m.card.cid, name: m.obs.name, tier, hand: b.hand, pa: o.pa, ours: b.ours, obs: o.wsb600 + o.ubr600 });
  }
}

// ── stats helpers ──
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
const sd = (xs: number[]) => { const m = mean(xs); return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length || 1)); };
const corr = (xs: number[], ys: number[]) => {
  const nn = xs.length; if (nn < 3) return NaN;
  const mx = mean(xs), my = mean(ys); let cv = 0, vx = 0, vy = 0;
  for (let i = 0; i < nn; i++) { cv += (xs[i]! - mx) * (ys[i]! - my); vx += (xs[i]! - mx) ** 2; vy += (ys[i]! - my) ** 2; }
  return cv / Math.sqrt(vx * vy);
};

const kept = recs.filter((r) => r.pa >= MIN_PA);
console.log(`[bsr-validate] model '${trained.id}', Quick tiers (neutral env), own-gap ON.`);
console.log(`joined ${recs.length} cards; ${kept.length} with PA≥${MIN_PA}. Comparing OUR bsr600 vs cwhit (wSB600+UBR600).\n`);

// ── (1) per-tier: correlation, spread-ratio (SD ours / SD obs), level bias (pre-centering) ──
console.log(`═══ (1) PER-TIER — OUR bsr600 vs OBSERVED (wSB600+UBR600), PA≥${MIN_PA} ═══`);
console.log(`tier       N     corr   SD ours  SD obs   spread-ratio   mean ours  mean obs   level-bias`);
// Pool the tier-DEMEANED series for an unbiased pooled read (each tier's own mean removed on both sides).
const pooledOurs: number[] = [], pooledObs: number[] = [];
for (const { tier } of QUICK) {
  const rs = kept.filter((r) => r.tier === tier); if (rs.length < 3) { if (rs.length) console.log(`${tier.padEnd(10)} ${String(rs.length).padStart(3)}  (too few)`); continue; }
  const ours = rs.map((r) => r.ours), obs = rs.map((r) => r.obs);
  const mo = mean(ours), mb = mean(obs);
  const c = corr(ours, obs), so = sd(ours), sb = sd(obs);
  console.log(`${tier.padEnd(10)} ${String(rs.length).padStart(3)}  ${fmt(c, 3)}   ${fmt(so)}     ${fmt(sb)}     ${fmt(so / sb, 2)}           ${fmt(mo, 2)}      ${fmt(mb, 2)}      ${(mo - mb >= 0 ? "+" : "")}${fmt(mo - mb)}`);
  ours.forEach((v) => pooledOurs.push(v - mo)); obs.forEach((v) => pooledObs.push(v - mb));
}

// ── (2) pooled (tier-demeaned) ──
console.log(`\n═══ (2) POOLED (each tier demeaned on both sides) ═══`);
console.log(`  N=${pooledOurs.length}   corr=${fmt(corr(pooledOurs, pooledObs), 3)}   SD ours=${fmt(sd(pooledOurs))}  SD obs=${fmt(sd(pooledObs))}  spread-ratio=${fmt(sd(pooledOurs) / sd(pooledObs), 2)}`);
// also the raw (non-demeaned) pooled level bias, for reference on absolute scale
const allO = kept.map((r) => r.ours), allB = kept.map((r) => r.obs);
console.log(`  raw pooled: mean ours=${fmt(mean(allO), 2)}  mean obs=${fmt(mean(allB), 2)}  level-bias=${(mean(allO) - mean(allB) >= 0 ? "+" : "")}${fmt(mean(allO) - mean(allB))} runs/600 (ours is pool-centered ⇒ level not directly comparable)`);

// ── (3) example cards — top & bottom baserunners by OBSERVED, ours alongside ──
console.log(`\n═══ (3) EXAMPLE CARDS (PA≥${MIN_PA}, by OBSERVED wSB600+UBR600) ═══`);
const uniq = new Map<string, Rec>(); for (const r of kept) { const k = `${r.name}|${r.tier}`; if (!uniq.has(k)) uniq.set(k, r); }
const sorted = [...uniq.values()].sort((a, b) => b.obs - a.obs);
const show = (r: Rec) => `  ${r.name.slice(0, 26).padEnd(27)} ${r.tier.padEnd(8)} ${r.hand}  PA ${String(r.pa).padStart(5)}   ours ${(r.ours >= 0 ? "+" : "")}${fmt(r.ours)}   obs ${(r.obs >= 0 ? "+" : "")}${fmt(r.obs)}`;
console.log(`  TOP baserunners (observed):`);
for (const r of sorted.slice(0, 8)) console.log(show(r));
console.log(`  BOTTOM baserunners (observed):`);
for (const r of sorted.slice(-8)) console.log(show(r));

process.exit(0);
