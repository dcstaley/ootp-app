// VARIANT (v5) LIFT VALIDATION — do our v5 rating-boosts reproduce the outcome change cwhit OBSERVES?
//
// cwhit's tables carry the SAME card at BOTH VLvl 0 (base) and VLvl 5 (variant), same Name+VAL+Hand.
// The v5−base DIFFERENCE is env-invariant: base and variant play the identical era/park/opponent
// frame within a tournament, so the environmental layer cancels in the lift on BOTH sides — which
// lets us pool ALL tables (Quick + daily), and lets our NEUTRAL-env prediction be compared to a
// daily-tournament observation with only a second-order (curvature×env) residual.
//
//   OBSERVED lift  = obs(v5 row)              − obs(base row)          [cwhit raw event rates]
//   PREDICTED lift = scoreCard(makeVariant(X)) − scoreCard(X)         [our model, same base card X]
//
// Pairing reuses the deployed join layer (tools/cwhit-audit-deployed*.ts pattern): catalog cards are
// built at vlvl 0 (cid) and vlvl 5 (cid#V = makeVariant), joined per table (fingerprint-disambiguated),
// and a pair exists when BOTH a card's base cid AND its #V variant cid land matched observations.
// Primary = RAW model lift (the cleanest test of the boost; own-gap applies the SAME tier affine to
// base and variant so it barely moves the lift — confirmed in the Quick-tier robustness block).
// run: node tools/cwhit-variant-validate.ts

import { readFileSync, readdirSync } from "node:fs";
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { resolveCoeffs, type Model } from "../src/config/coeff-resolve.ts";
import type { Era, Park, Tournament } from "../src/config/tournament.ts";
import {
  makeRawPolyModel, computeUnifiedFieldStats, buildPoolTransform, applyAffine, applyWobaWeights,
  type EventForm, type FieldStats, type PoolTransform, type RatingEnvelope, type WobaWeights,
} from "../src/scoring-core/index.ts";
import { parseCatalogCsv, type Card } from "../src/data/catalog.ts";
import { makeVariant } from "../src/data/variants.ts";
import { HIT_BIP_ADJ, PIT_BIP_ADJ } from "../src/model/curves.ts";
import { parseCwhitHit, parseCwhitPit, joinCwhit, type JoinCard, type JoinObs } from "../src/eval/cwhit/index.ts";
import { hitWobaFromRates, pitWobaFromChannels, PER9_TO_PER600, type WobaWeights as WW } from "../src/eval/cwhit/audit.ts";

const FIX = "fixtures/cwhit", FIELD_N = 50, PER600_TO_PER9 = 1 / PER9_TO_PER600;
const HIT_PA_MIN = 300, PIT_IP_MIN = 75; // both base AND v5 must clear these
const n = (v: unknown): number => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const handLetter = (c: number) => (c === 2 ? "L" : c === 3 ? "S" : "R");
const fmt = (x: number, d = 2) => (Number.isFinite(x) ? (x >= 0 ? "+" : "") + x.toFixed(d) : "n/a");
const QUICK_CAP: Record<string, number> = { iron: 59, bronze: 69, silver: 79, gold: 89, diamond: 99 };

const repo = new Repository("data");
await seedDefaults(repo); await seedEras(repo); await seedAccounts(repo);
const state = (await repo.load<{ activeModelId?: string; catalogSourceId?: string }>("state", "app")) ?? {};
type TM = { id: string; eventForm?: EventForm; wobaWeights?: WobaWeights; ratingEnvelope?: RatingEnvelope; platoon?: { hit: { hand: string; vsRHP: number; vsLHP: number }[]; pit: { hand: string; vsRHB: number; vsLHB: number }[] } };
const trained = (await repo.loadAll<TM>("trained-models")).find((x) => x.id === state.activeModelId);
if (!trained?.eventForm || !trained.wobaWeights || !trained.platoon) throw new Error("active model missing eventForm/weights/platoon");
const rp = makeRawPolyModel(trained.eventForm);
const W = trained.wobaWeights as WW;
const envelope = trained.ratingEnvelope;
const model = (await repo.loadAll<Model>("models"))[0]!;
const eras = new Map((await repo.loadAll<Era>("eras")).map((e) => [e.id, e]));
const parks = new Map((await repo.loadAll<Park>("parks")).map((p) => [p.id, p]));
const bq = (await repo.loadAll<Tournament>("tournaments")).find((t) => t.id === "bronze-quick")!; // neutral env
const coeffs = resolveCoeffs(model, eras.get(bq.eraId)!, parks.get(bq.parkId)!, bq.softcaps);
applyWobaWeights(coeffs, trained.wobaWeights);
const hitExp = new Map(trained.platoon.hit.map((p) => [p.hand, { wR: p.vsRHP, wL: p.vsLHP }]));
const pitExp = new Map(trained.platoon.pit.map((p) => [p.hand, { wR: p.vsRHB, wL: p.vsLHB }]));

const srcId = state.catalogSourceId ?? "cdmx";
const baseCards = parseCatalogCsv(readFileSync(`data/imports/${srcId}.csv`, "utf8")).cards.filter((c) => String(c["Variant"] ?? "").toUpperCase() !== "Y");
const isHitter = (c: Card) => String(c["Position"]).trim() !== "1";
const isPitcher = (c: Card) => n(c["Pitcher Role"]) > 0 || String(c["Position"]).trim() === "1";
const cardName = (c: Card) => `${(c["FirstName"] ?? "").trim()} ${(c["LastName"] ?? "").trim()}`.trim();
const ref: FieldStats = computeUnifiedFieldStats(baseCards, coeffs, rp, FIELD_N, true);

type HitChan = { bbPct: number; soPct: number; hr600: number; babip: number; woba: number };
type PitChan = { k9: number; bb9: number; hr9: number; babip: number; woba: number };

function combinedHit(c: Card, pt?: PoolTransform): HitChan {
  const { wR, wL } = hitExp.get(handLetter(n(c["Bats"]))) ?? { wR: 0.5, wL: 0.5 };
  const side = (s: "R" | "L") => {
    const t = pt?.hit[s === "R" ? "vR" : "vL"];
    return rp.predictHitting({ eye: applyAffine(n(c[`Eye v${s}`]), t?.eye), pow: applyAffine(n(c[`Power v${s}`]), t?.pow), kRat: applyAffine(n(c[`Avoid K v${s}`]), t?.kRat), babip: applyAffine(n(c[`BABIP v${s}`]), t?.babip), gap: applyAffine(n(c[`Gap v${s}`]), t?.gap), speed: n(c["Speed"]), steal: n(c["Steal Rate"]), run: n(c["Baserunning"]) }, coeffs);
  };
  const eR = side("R"), eL = side("L");
  const BB = wR * eR.BB + wL * eL.BB, SO = wR * eR.SO + wL * eL.SO, HR = wR * eR.HR + wL * eL.HR, oneB = wR * eR.oneB + wL * eL.oneB, GAP = wR * eR.GAP + wL * eL.GAP;
  const BIP = Math.max(600 - BB - SO - HR - HIT_BIP_ADJ, 1);
  const woba = (W.bb * BB + W.hbp * 6 + W.b1 * oneB + W.xbh * GAP + W.hr * HR) / 600;
  return { bbPct: BB / 6, soPct: SO / 6, hr600: HR, babip: (oneB + GAP) / BIP, woba };
}

function combinedPit(c: Card, pt?: PoolTransform): PitChan {
  const { wR, wL } = pitExp.get(handLetter(n(c["Throws"]))) ?? { wR: 0.5, wL: 0.5 };
  const side = (s: "R" | "L") => {
    const t = pt?.pit[s === "R" ? "vR" : "vL"];
    return rp.predictPitching({ con: applyAffine(n(c[`Control v${s}`]), t?.con), stu: applyAffine(n(c[`Stuff v${s}`]), t?.stu), pbabip: applyAffine(n(c[`pBABIP v${s}`]), t?.pbabip), hrr: applyAffine(n(c[`pHR v${s}`]), t?.hrr) }, coeffs);
  };
  const eR = side("R"), eL = side("L");
  const BB = wR * eR.BB + wL * eL.BB, K = wR * eR.K + wL * eL.K, HR = wR * eR.HR + wL * eL.HR, nHH = wR * eR.nHH + wL * eL.nHH;
  const BIP = Math.max(600 - BB - K - HR - PIT_BIP_ADJ, 1), babip = nHH / BIP;
  const k9 = K * PER600_TO_PER9, bb9 = BB * PER600_TO_PER9, hr9 = HR * PER600_TO_PER9;
  return { k9, bb9, hr9, babip, woba: pitWobaFromChannels(k9, bb9, hr9, babip, W) };
}

// ── per-role pair collection ─────────────────────────────────────────────────
interface Pair { tier: string; quick: boolean; base: Card; predBase: Record<string, number>; predV5: Record<string, number>; obsBase: Record<string, number>; obsV5: Record<string, number> }
const hitPairs: Pair[] = [], pitPairs: Pair[] = [];

const files = readdirSync(FIX);
const tierOf = (f: string) => f.replace(/^cwhit-/, "").replace(/-(hit|pit)\.tsv$/, "");

for (const f of files) {
  const isHit = f.endsWith("-hit.tsv"), isPit = f.endsWith("-pit.tsv");
  if (!isHit && !isPit) continue;
  const tier = tierOf(f), quick = tier in QUICK_CAP;
  const tsv = readFileSync(`${FIX}/${f}`, "utf8");

  // Build catalog candidates at vlvl 0 (base) + 5 (variant), RAW predictions, and join to obs.
  type PC = { base: Card; pred: Record<string, number>; isV: boolean };
  const cards: JoinCard[] = [], byId = new Map<string, PC>();
  for (const bc of baseCards) for (const [vlvl, c] of [[0, bc], [5, makeVariant(bc)]] as const) {
    if (isHit && !isHitter(c)) continue;
    if (isPit && !isPitcher(c)) continue;
    const cid = `${bc["Card ID"]}${vlvl ? "#V" : ""}`;
    if (isHit) {
      const h = combinedHit(c);
      cards.push({ cid, name: cardName(c), val: n(c["Card Value"]), vlvl, hand: handLetter(n(c["Bats"])), primary: [h.babip], validate: [h.bbPct, h.soPct, h.hr600] });
      byId.set(cid, { base: bc, pred: h as unknown as Record<string, number>, isV: vlvl === 5 });
    } else {
      const p = combinedPit(c);
      cards.push({ cid, name: cardName(c), val: n(c["Card Value"]), vlvl, hand: handLetter(n(c["Throws"])), primary: [p.babip], validate: [p.k9, p.bb9, p.hr9] });
      byId.set(cid, { base: bc, pred: p as unknown as Record<string, number>, isV: vlvl === 5 });
    }
  }

  // Observations → join shape, carrying the matched cid + observed channels + sample.
  type OM = { obs: Record<string, number>; sample: number };
  const obsByCid = new Map<string, OM>();
  if (isHit) {
    const { rows } = parseCwhitHit(tsv);
    const obs: JoinObs<(typeof rows)[0]>[] = rows.map((r) => ({ name: r.name, val: r.val, vlvl: r.vlvl, hand: r.hand, primary: [r.babip], validate: [r.bbPct, r.soPct, r.hr600], sample: r.pa, row: r }));
    for (const m of joinCwhit(obs, cards).matched) {
      const r = m.obs.row;
      obsByCid.set(m.card.cid, { sample: r.pa, obs: { bbPct: r.bbPct, soPct: r.soPct, hr600: r.hr600, babip: r.babip, woba: hitWobaFromRates({ bbPct: r.bbPct, soPct: r.soPct, hr600: r.hr600, babip: r.babip, avg: r.avg, slg: r.slg, tripleXbh: r.tripleXbh }, W) } });
    }
  } else {
    const { rows } = parseCwhitPit(tsv);
    const obs: JoinObs<(typeof rows)[0]>[] = rows.map((r) => ({ name: r.name, val: r.val, vlvl: r.vlvl, hand: r.hand, primary: [r.gsPer, r.babip], validate: [r.k9, r.bb9, r.hr9], sample: r.ip, row: r }));
    for (const m of joinCwhit(obs, cards).matched) {
      const r = m.obs.row;
      obsByCid.set(m.card.cid, { sample: r.ip, obs: { k9: r.k9, bb9: r.bb9, hr9: r.hr9, babip: r.babip, woba: pitWobaFromChannels(r.k9, r.bb9, r.hr9, r.babip, W) } });
    }
  }

  // A pair exists when both a card's base cid AND its #V variant cid were matched to observations.
  const sampleMin = isHit ? HIT_PA_MIN : PIT_IP_MIN;
  const seen = new Set<string>();
  for (const cid of obsByCid.keys()) {
    if (cid.endsWith("#V")) continue;
    const baseId = cid, varId = `${cid}#V`;
    if (seen.has(baseId)) continue; seen.add(baseId);
    const ob = obsByCid.get(baseId), ov = obsByCid.get(varId);
    if (!ob || !ov) continue;
    if (ob.sample < sampleMin || ov.sample < sampleMin) continue;
    const pcB = byId.get(baseId)!, pcV = byId.get(varId)!;
    (isHit ? hitPairs : pitPairs).push({ tier, quick, base: pcB.base, predBase: pcB.pred, predV5: pcV.pred, obsBase: ob.obs, obsV5: ov.obs });
  }
}

// ── stats ────────────────────────────────────────────────────────────────────
function summarize(pairs: Pair[], ch: string, scale: number) {
  const predL = pairs.map((p) => (p.predV5[ch]! - p.predBase[ch]!) * scale);
  const obsL = pairs.map((p) => (p.obsV5[ch]! - p.obsBase[ch]!) * scale);
  const diff = pairs.map((_, i) => predL[i]! - obsL[i]!);
  const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
  const mp = mean(predL), mo = mean(obsL), md = mean(diff);
  const sd = Math.sqrt(diff.reduce((a, d) => a + (d - md) ** 2, 0) / Math.max(diff.length - 1, 1));
  const se = sd / Math.sqrt(diff.length);
  return { n: pairs.length, mp, mo, md, ciLo: md - 1.96 * se, ciHi: md + 1.96 * se, sig: (md - 1.96 * se) * (md + 1.96 * se) > 0 };
}

function report(label: string, pairs: Pair[], chans: [string, string, number, number][]) {
  console.log(`\n═══ ${label}  (N=${pairs.length} base+v5 pairs) ═══`);
  console.log(`channel      pred lift   obs lift    Δ(pred−obs) [95% CI]        verdict`);
  for (const [ch, name, scale, dp] of chans) {
    const s = summarize(pairs, ch, scale);
    const flag = !s.sig ? "ok (CI incl 0)" : s.md > 0 ? "OVER-shoots" : "UNDER-shoots";
    console.log(`${name.padEnd(11)} ${fmt(s.mp, dp).padStart(9)}  ${fmt(s.mo, dp).padStart(9)}   ${(fmt(s.md, dp) + (s.sig ? "*" : " ")).padStart(9)} [${fmt(s.ciLo, dp)},${fmt(s.ciHi, dp)}]   ${flag}`);
  }
}

// channel: [key, display, scale, decimals]
const HIT_CH: [string, string, number, number][] = [
  ["woba", "wOBA(m)", 1000, 1], ["hr600", "HR600", 1, 2], ["babip", "BABIP", 1, 4], ["bbPct", "BB%", 1, 2], ["soPct", "SO%", 1, 2],
];
const PIT_CH: [string, string, number, number][] = [
  ["woba", "wOBAA(m)", 1000, 1], ["k9", "K9", 1, 2], ["bb9", "BB9", 1, 2], ["hr9", "HR9", 1, 2], ["babip", "BABIP", 1, 4],
];

console.log(`[variant-validate] model '${trained.id}', catalog '${srcId}', ${baseCards.length} base cards. RAW model lift (env cancels in v5−base).`);
console.log(`thresholds: hitter PA≥${HIT_PA_MIN}, pitcher IP≥${PIT_IP_MIN} on BOTH base and v5. lift = v5 − base. Δ>0 ⇒ our boost OVER-shoots observed.`);

report("HITTER v5 LIFT — ALL tables", hitPairs, HIT_CH);
report("HITTER v5 LIFT — Quick tiers only", hitPairs.filter((p) => p.quick), HIT_CH);
report("PITCHER v5 LIFT — ALL tables", pitPairs, PIT_CH);
report("PITCHER v5 LIFT — Quick tiers only", pitPairs.filter((p) => p.quick), PIT_CH);

// per-table pair counts (transparency: a card can contribute from multiple tables)
const byTier = (pairs: Pair[]) => { const m = new Map<string, number>(); for (const p of pairs) m.set(p.tier, (m.get(p.tier) ?? 0) + 1); return [...m.entries()].map(([t, c]) => `${t}:${c}`).join("  "); };
console.log(`\nper-table hitter pairs:  ${byTier(hitPairs)}`);
console.log(`per-table pitcher pairs: ${byTier(pitPairs)}`);

// ── OWN-GAP robustness (Quick tiers): does the deployed tier transform change the lift? ──
console.log(`\n═══ OWN-GAP robustness (Quick tiers) — deployed tier transform applied to BOTH base & v5 ═══`);
console.log(`(if own-gap lift ≈ raw lift, the boost calibration story is transform-independent)`);
for (const role of ["hit", "pit"] as const) {
  const pairs = (role === "hit" ? hitPairs : pitPairs).filter((p) => p.quick);
  if (!pairs.length) continue;
  // build a tier PoolTransform once per tier from base cards ≤ cap
  const ptByTier = new Map<string, PoolTransform>();
  for (const t of new Set(pairs.map((p) => p.tier))) {
    const cap = QUICK_CAP[t]!;
    const pool = baseCards.filter((c) => n(c["Card Value"]) <= cap);
    ptByTier.set(t, buildPoolTransform(ref, computeUnifiedFieldStats(pool, coeffs, rp, FIELD_N, true), envelope));
  }
  const chans = role === "hit" ? HIT_CH : PIT_CH;
  const comb = role === "hit" ? combinedHit : combinedPit;
  console.log(`\n  ${role === "hit" ? "HITTER" : "PITCHER"} (N=${pairs.length}):  channel      raw predLift   own-gap predLift   obs lift`);
  for (const [ch, name, scale, dp] of chans) {
    const rawL: number[] = [], ogL: number[] = [], obsL: number[] = [];
    for (const p of pairs) {
      const pt = ptByTier.get(p.tier)!;
      const bOG = comb(p.base, pt) as unknown as Record<string, number>, vOG = comb(makeVariant(p.base), pt) as unknown as Record<string, number>;
      rawL.push((p.predV5[ch]! - p.predBase[ch]!) * scale);
      ogL.push((vOG[ch]! - bOG[ch]!) * scale);
      obsL.push((p.obsV5[ch]! - p.obsBase[ch]!) * scale);
    }
    const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
    console.log(`  ${"".padEnd(9)} ${name.padEnd(11)} ${fmt(mean(rawL), dp).padStart(9)}     ${fmt(mean(ogL), dp).padStart(9)}        ${fmt(mean(obsL), dp).padStart(9)}`);
  }
}

process.exit(0);
