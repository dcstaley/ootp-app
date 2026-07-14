// DEPLOYED-PIPELINE calibration audit (Batch 2, Derek: "apply own-gap, tier pool"). Re-runs the
// audit with the SHIPPED own-gap PoolTransform applied per tier — the same rebasing score-card.ts
// does — so the comparison is against what the app actually scores, not the raw event model. Scoped
// to the QUICK tiers (Derek: Quicks are neutral era/park ⇒ absolute levels are directly comparable;
// dailies are non-neutral and excluded until their env is pulled). run: node tools/cwhit-audit-deployed.ts
//
// own-gap lifts a weak pool's ratings toward the full-catalog reference (buildPoolTransform), so a
// low-tier card is scored as it dominates its weak field — which should absorb the opponent-frame
// gradient the raw pass showed. The residual after own-gap IS the deployed calibration defect.

import { readFileSync, readdirSync } from "node:fs";
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { resolveCoeffs, type Model } from "../src/config/coeff-resolve.ts";
import type { Era, Park, Tournament } from "../src/config/tournament.ts";
import {
  makeRawPolyModel, computeUnifiedFieldStats, buildPoolTransform, applyAffine, applyWobaWeights,
  type EventForm, type FieldStats, type PoolTransform, type RatingEnvelope, type Coeffs, type WobaWeights,
} from "../src/scoring-core/index.ts";
import { parseCatalogCsv, type Card } from "../src/data/catalog.ts";
import { makeVariant } from "../src/data/variants.ts";
import { PIT_BIP_ADJ } from "../src/model/curves.ts";
import { wls } from "../src/training/fit.ts";
import { parseCwhitPit } from "../src/eval/cwhit/index.ts";
import { joinCwhit, type JoinCard, type JoinObs } from "../src/eval/cwhit/index.ts";
import { pitWobaFromChannels, channelBias, spread, PER9_TO_PER600, type AuditRow, type WobaWeights as WW } from "../src/eval/cwhit/audit.ts";

const FIX = "fixtures/cwhit", FIELD_N = 50, PER600_TO_PER9 = 1 / PER9_TO_PER600;
const n = (v: unknown): number => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const handLetter = (c: number) => (c === 2 ? "L" : c === 3 ? "S" : "R");
const fmt = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "n/a");
// Quick-tier value caps (nested eligibility: a tier's pool = all cards ≤ cap). Iron 59 standard.
const QUICK: { tier: string; cap: number }[] = [{ tier: "iron", cap: 59 }, { tier: "bronze", cap: 69 }, { tier: "silver", cap: 79 }, { tier: "gold", cap: 89 }, { tier: "diamond", cap: 99 }];

const repo = new Repository("data");
await seedDefaults(repo); await seedEras(repo); await seedAccounts(repo);
const state = (await repo.load<{ activeModelId?: string; catalogSourceId?: string }>("state", "app")) ?? {};
type TM = { id: string; eventForm?: EventForm; wobaWeights?: WobaWeights; ratingEnvelope?: RatingEnvelope; platoon?: { pit: { hand: string; vsRHB: number; vsLHB: number }[] } };
const trained = (await repo.loadAll<TM>("trained-models")).find((x) => x.id === state.activeModelId);
if (!trained?.eventForm || !trained.wobaWeights || !trained.platoon) throw new Error("active model missing eventForm/weights/platoon");
const rp = makeRawPolyModel(trained.eventForm);
const W = trained.wobaWeights as WW;
const envelope = trained.ratingEnvelope;
const model = (await repo.loadAll<Model>("models"))[0]!;
const eras = new Map((await repo.loadAll<Era>("eras")).map((e) => [e.id, e]));
const parks = new Map((await repo.loadAll<Park>("parks")).map((p) => [p.id, p]));
const bq = (await repo.loadAll<Tournament>("tournaments")).find((t) => t.id === "bronze-quick")!; // neutral env (era-2010/park-1)
const coeffs = resolveCoeffs(model, eras.get(bq.eraId)!, parks.get(bq.parkId)!, bq.softcaps);
applyWobaWeights(coeffs, trained.wobaWeights);
const pitExp = new Map(trained.platoon.pit.map((p) => [p.hand, { wR: p.vsRHB, wL: p.vsLHB }]));

const srcId = state.catalogSourceId ?? "cdmx";
const baseCards = parseCatalogCsv(readFileSync(`data/imports/${srcId}.csv`, "utf8")).cards.filter((c) => String(c["Variant"] ?? "").toUpperCase() !== "Y");
const isPitcher = (c: Card) => n(c["Pitcher Role"]) > 0 || String(c["Position"]).trim() === "1";
const cardName = (c: Card) => `${(c["FirstName"] ?? "").trim()} ${(c["LastName"] ?? "").trim()}`.trim();
const ref: FieldStats = computeUnifiedFieldStats(baseCards, coeffs, rp, FIELD_N, true);
console.log(`[deployed-audit] model '${trained.id}', own-gap ON, Quick tiers (neutral env). ${baseCards.length} cards.\n`);

/** Combined pitcher line with a PoolTransform applied to ratings first (deployed own-gap path). */
function combinedPit(c: Card, pt?: PoolTransform): { k9: number; bb9: number; hr9: number; babip: number; woba: number } {
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

// Build own-gap audit rows per Quick tier (transform pool = cards ≤ cap; predictions tier-specific).
const rowsByMode: Record<"raw" | "owngap", AuditRow[]> = { raw: [], owngap: [] };
for (const { tier, cap } of QUICK) {
  const f = `cwhit-${tier}-pit.tsv`;
  if (!readdirSync(FIX).includes(f)) continue;
  const basePool = baseCards.filter((c) => n(c["Card Value"]) <= cap);
  const poolField = computeUnifiedFieldStats(basePool, coeffs, rp, FIELD_N, true);
  const pt = buildPoolTransform(ref, poolField, envelope);
  // our-side cards eligible at this tier, predicted with the tier transform (own-gap) and without (raw).
  const mkCards = (mode: "raw" | "owngap"): { cards: JoinCard[]; byId: Map<string, { ratings: Record<string, number>; pred: Record<string, number> }> } => {
    const cards: JoinCard[] = [], byId = new Map<string, { ratings: Record<string, number>; pred: Record<string, number> }>();
    for (const bc of baseCards) for (const [vlvl, c] of [[0, bc], [5, makeVariant(bc)]] as const) {
      if (!isPitcher(c) || n(c["Card Value"]) > cap) continue;
      const cid = `${bc["Card ID"]}${vlvl ? "#V" : ""}`, p = combinedPit(c, mode === "owngap" ? pt : undefined);
      cards.push({ cid, name: cardName(c), val: n(c["Card Value"]), vlvl, hand: handLetter(n(c["Throws"])), primary: [clamp01((n(c["Stamina"]) - 20) / 40), p.babip], validate: [p.k9, p.bb9, p.hr9] });
      byId.set(cid, { ratings: { con: n(c["Control vR"]), stu: n(c["Stuff vR"]), hrr: n(c["pHR vR"]), pbabip: n(c["pBABIP vR"]) }, pred: p });
    }
    return { cards, byId };
  };
  const { rows: cwrows } = parseCwhitPit(readFileSync(`${FIX}/${f}`, "utf8"));
  const obs: JoinObs<typeof cwrows[0]>[] = cwrows.map((r) => ({ name: r.name, val: r.val, vlvl: r.vlvl, hand: r.hand, primary: [r.gsPer, r.babip], validate: [r.k9, r.bb9, r.hr9], sample: r.ip, row: r }));
  for (const mode of ["raw", "owngap"] as const) {
    const { cards, byId } = mkCards(mode);
    for (const m of joinCwhit(obs, cards).matched) {
      const pr = byId.get(m.card.cid)!, o = m.obs.row;
      rowsByMode[mode].push({ cid: m.card.cid, name: m.obs.name, tier, role: "pit", sample: o.ip, ratings: pr.ratings, pred: pr.pred,
        obs: { k9: o.k9, bb9: o.bb9, hr9: o.hr9, babip: o.babip, woba: pitWobaFromChannels(o.k9, o.bb9, o.hr9, o.babip, W) } });
    }
  }
}

const sig = (b: { ciLo: number; ciHi: number }) => (b.ciLo * b.ciHi > 0 ? "*" : " ");
// ── (1) Quick-tier pitcher wOBAA bias: raw vs own-gap (does own-gap absorb the frame?) ──
console.log(`═══ (1) PITCHER wOBAA BIAS by tier (mwOBA, pred−obs) — raw event model vs own-gap applied ═══`);
console.log(`tier        N    raw wOBAA        own-gap wOBAA`);
for (const { tier } of QUICK) {
  const rr = rowsByMode.raw.filter((r) => r.tier === tier), ro = rowsByMode.owngap.filter((r) => r.tier === tier);
  if (!rr.length) continue;
  const br = channelBias(rr, "woba"), bo = channelBias(ro, "woba");
  console.log(`${tier.padEnd(10)} ${String(rr.length).padStart(3)}  ${(br.bias * 1000 >= 0 ? "+" : "")}${fmt(br.bias * 1000, 1)}${sig(br)} [${fmt(br.ciLo * 1000, 0)},${fmt(br.ciHi * 1000, 0)}]   ${(bo.bias * 1000 >= 0 ? "+" : "")}${fmt(bo.bias * 1000, 1)}${sig(bo)} [${fmt(bo.ciLo * 1000, 0)},${fmt(bo.ciHi * 1000, 0)}]`);
}

// ── (2) con-vs-stu partial slopes on OWN-GAP predictions (the deployed attribution) ──
console.log(`\n═══ (2) con-vs-stu ATTRIBUTION on OWN-GAP predictions — within-tier partial slopes (mwOBA per +10 rating) ═══`);
console.log(`(β>0 ⇒ we score the pitcher WORSE than observed; β<0 ⇒ BETTER = the over-valuation direction)`);
const axes = ["con", "stu", "hrr", "pbabip"] as const;
for (const mode of ["raw", "owngap"] as const) {
  const per: Record<string, number[]> = { con: [], stu: [], hrr: [], pbabip: [] };
  for (const { tier } of QUICK) {
    const rs = rowsByMode[mode].filter((r) => r.tier === tier); if (rs.length < 20) continue;
    const mean = (g: (r: AuditRow) => number) => rs.reduce((a, r) => a + g(r), 0) / rs.length;
    const mu = Object.fromEntries(axes.map((a) => [a, mean((r) => r.ratings[a]!)]));
    const beta = wls(rs.map((r) => [1, ...axes.map((a) => r.ratings[a]! - mu[a]!)]), rs.map((r) => (r.pred.woba! - r.obs.woba!) * 1000), rs.map(() => 1));
    axes.forEach((a, i) => per[a]!.push(beta[i + 1]!));
  }
  const line = axes.map((a) => {
    const s = per[a]!, m = s.reduce((x, y) => x + y, 0) / s.length, sd = Math.sqrt(s.reduce((x, v) => x + (v - m) ** 2, 0) / Math.max(s.length - 1, 1)), se = sd / Math.sqrt(s.length);
    return `${a} ${m * 10 >= 0 ? "+" : ""}${fmt(m * 10, 2)}${(m - 1.96 * se) * (m + 1.96 * se) > 0 ? "*" : " "}`;
  }).join("  ");
  console.log(`  ${mode.padEnd(7)} ${line}`);
}

// ── (3) IRON GATE on own-gap predictions ──
console.log(`\n═══ (3) IRON GATE (own-gap) — levels, spread, concordance ═══`);
const iron = rowsByMode.owngap.filter((r) => r.tier === "iron"), ironRaw = rowsByMode.raw.filter((r) => r.tier === "iron");
if (iron.length) {
  const mP = (rows: AuditRow[], g: (r: AuditRow) => number) => rows.reduce((a, r) => a + g(r), 0) / rows.length;
  for (const [ch, d] of [["k9", 2], ["bb9", 2], ["hr9", 2], ["babip", 3], ["woba", 3]] as const)
    console.log(`  ${ch.padEnd(6)} obs ${fmt(mP(iron, (r) => r.obs[ch]!), d)}  pred(raw) ${fmt(mP(ironRaw, (r) => r.pred[ch]!), d)}  pred(own-gap) ${fmt(mP(iron, (r) => r.pred[ch]!), d)}`);
  // Elite-tail spread across Quick SP at DEEPER cuts (shallow cuts inflate obs SD with sample noise;
  // memory's near-0-noise elite SD ≈ 0.0109 was IP≥1500). Pool the Quick tiers for enough deep SP.
  console.log(`  wOBAA SPREAD — obs vs pred (own-gap), by IP cut (deeper ⇒ less obs noise; SP-heavy):`);
  const spAll = rowsByMode.owngap.filter((r) => r.obs.k9 != null);
  const spRaw = rowsByMode.raw;
  for (const ipCut of [500, 1000, 1500]) {
    const deepO = spAll.filter((r) => r.sample >= ipCut), deepR = spRaw.filter((r) => r.sample >= ipCut);
    if (deepO.length < 5) { console.log(`    IP≥${ipCut}: N=${deepO.length} (too few)`); continue; }
    console.log(`    IP≥${String(ipCut).padStart(4)} (N=${String(deepO.length).padStart(3)}):  obs SD ${fmt(spread(deepO, (r) => r.obs.woba!), 4)}   pred own-gap SD ${fmt(spread(deepO, (r) => r.pred.woba!), 4)}   raw SD ${fmt(spread(deepR, (r) => r.pred.woba!), 4)}`);
  }
  const deep = spAll.filter((r) => r.sample >= 1000);
  const xs = deep.map((r) => r.pred.woba!), ys = deep.map((r) => r.obs.woba!), mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let cov = 0, vx = 0, vy = 0; for (let i = 0; i < xs.length; i++) { cov += (xs[i]! - mx) * (ys[i]! - my); vx += (xs[i]! - mx) ** 2; vy += (ys[i]! - my) ** 2; }
  console.log(`  CONCORDANCE (own-gap, Quick SP IP≥1000, N=${deep.length}): corr(pred,obs wOBAA) = ${fmt(cov / Math.sqrt(vx * vy), 3)}`);
}
process.exit(0);
