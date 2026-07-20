// DEPLOYED-PIPELINE calibration audit — HITTERS (Batch 2). Mirror of cwhit-audit-deployed.ts for
// the hitting surface: own-gap PoolTransform applied per Quick tier (neutral env), predicted vs
// cwhit observed, per-channel bias + within-tier attribution slopes, plus the BASERUNNING first-look
// (wSB600/UBR600 vs our Speed/Stealing/Baserunning ratings — the never-validated blind spot; the
// deployed model weights baserunning at ZERO, so this quantifies what we omit). Quick tiers only.
// run: node tools/cwhit-audit-deployed-hit.ts

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
import { HIT_BIP_ADJ } from "../src/model/curves.ts";
import { wls } from "../src/training/fit.ts";
import { parseCwhitHit } from "../src/eval/cwhit/index.ts";
import { joinCwhit, type JoinCard, type JoinObs } from "../src/eval/cwhit/index.ts";
import { hitWobaFromRates, channelBias, spread, type AuditRow, type WobaWeights as WW } from "../src/eval/cwhit/audit.ts";
import { QUICK, inValueWindow } from "../src/eval/cwhit/sample.ts";

const FIX = "fixtures/cwhit", FIELD_N = 50, WOBA_SCALE = 1.25; // runs per wOBA point (for baserunning mwOBA-equiv)
const n = (v: unknown): number => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const handLetter = (c: number) => (c === 2 ? "L" : c === 3 ? "S" : "R");
const fmt = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "n/a");

const repo = new Repository("data");
await seedDefaults(repo); await seedEras(repo); await seedAccounts(repo);
const state = (await repo.load<{ activeModelId?: string; catalogSourceId?: string }>("state", "app")) ?? {};
type TM = { id: string; eventForm?: EventForm; wobaWeights?: WobaWeights; ratingEnvelope?: RatingEnvelope; platoon?: { hit: { hand: string; vsRHP: number; vsLHP: number }[] } };
const trained = (await repo.loadAll<TM>("trained-models")).find((x) => x.id === state.activeModelId);
if (!trained?.eventForm || !trained.wobaWeights || !trained.platoon) throw new Error("active model missing eventForm/weights/platoon");
const rp = makeRawPolyModel(trained.eventForm);
const W = trained.wobaWeights as WW;
const envelope = trained.ratingEnvelope;
const model = (await repo.loadAll<Model>("models"))[0]!;
const eras = new Map((await repo.loadAll<Era>("eras")).map((e) => [e.id, e]));
const parks = new Map((await repo.loadAll<Park>("parks")).map((p) => [p.id, p]));
const bq = (await repo.loadAll<Tournament>("tournaments")).find((t) => t.id === "bronze-quick")!;
const coeffs = resolveCoeffs(model, eras.get(bq.eraId)!, parks.get(bq.parkId)!, bq.softcaps);
applyWobaWeights(coeffs, trained.wobaWeights);
const hitExp = new Map(trained.platoon.hit.map((p) => [p.hand, { wR: p.vsRHP, wL: p.vsLHP }]));

const srcId = state.catalogSourceId ?? "cdmx";
const baseCards = parseCatalogCsv(readFileSync(`data/imports/${srcId}.csv`, "utf8")).cards.filter((c) => String(c["Variant"] ?? "").toUpperCase() !== "Y");
const isHitter = (c: Card) => String(c["Position"]).trim() !== "1";
const cardName = (c: Card) => `${(c["FirstName"] ?? "").trim()} ${(c["LastName"] ?? "").trim()}`.trim();
const ref: FieldStats = computeUnifiedFieldStats(baseCards, coeffs, rp, FIELD_N, true);
console.log(`[deployed-audit-hit] model '${trained.id}', own-gap ON, Quick tiers. ${baseCards.length} cards.\n`);

/** Combined hitter line with a PoolTransform applied to ratings first (deployed own-gap path). */
function combinedHit(c: Card, pt?: PoolTransform) {
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

const rowsByMode: Record<"raw" | "owngap", AuditRow[]> = { raw: [], owngap: [] };
const brRows: { spd: number; stl: number; run: number; wsb: number; ubr: number; pa: number }[] = [];
for (const win of QUICK) {
  const { tier } = win;
  const f = `cwhit-${tier}-hit.tsv`;
  if (!readdirSync(FIX).includes(f)) continue;
  const basePool = baseCards.filter((c) => inValueWindow(c, win));
  const pt = buildPoolTransform(ref, computeUnifiedFieldStats(basePool, coeffs, rp, FIELD_N, true), envelope);
  const mk = (mode: "raw" | "owngap") => {
    const cards: JoinCard[] = [], byId = new Map<string, { ratings: Record<string, number>; pred: Record<string, number>; spd: number; stl: number; run: number }>();
    for (const bc of baseCards) for (const [vlvl, c] of [[0, bc], [5, makeVariant(bc)]] as const) {
      if (!isHitter(c) || !inValueWindow(c, win)) continue;
      const cid = `${bc["Card ID"]}${vlvl ? "#V" : ""}`, h = combinedHit(c, mode === "owngap" ? pt : undefined);
      cards.push({ cid, name: cardName(c), val: n(c["Card Value"]), vlvl, hand: handLetter(n(c["Bats"])), primary: [h.babip], validate: [h.bbPct, h.soPct, h.hr600] });
      byId.set(cid, { ratings: { eye: n(c["Eye vR"]), pow: n(c["Power vR"]), kRat: n(c["Avoid K vR"]), babip: n(c["BABIP vR"]), gap: n(c["Gap vR"]) }, pred: h, spd: n(c["Speed"]), stl: n(c["Stealing"]), run: n(c["Baserunning"]) });
    }
    return { cards, byId };
  };
  const { rows: cwrows } = parseCwhitHit(readFileSync(`${FIX}/${f}`, "utf8"));
  const obs: JoinObs<typeof cwrows[0]>[] = cwrows.map((r) => ({ name: r.name, val: r.val, vlvl: r.vlvl, hand: r.hand, primary: [r.babip], validate: [r.bbPct, r.soPct, r.hr600], sample: r.pa, row: r }));
  for (const mode of ["raw", "owngap"] as const) {
    const { cards, byId } = mk(mode);
    for (const m of joinCwhit(obs, cards).matched) {
      const p = byId.get(m.card.cid)!, o = m.obs.row;
      rowsByMode[mode].push({ cid: m.card.cid, name: m.obs.name, tier, role: "hit", sample: o.pa, ratings: p.ratings, pred: p.pred,
        obs: { bbPct: o.bbPct, soPct: o.soPct, hr600: o.hr600, babip: o.babip, woba: hitWobaFromRates({ bbPct: o.bbPct, soPct: o.soPct, hr600: o.hr600, babip: o.babip, avg: o.avg, slg: o.slg, tripleXbh: o.tripleXbh }, W) } });
      if (mode === "owngap") brRows.push({ spd: p.spd, stl: p.stl, run: p.run, wsb: o.wsb600, ubr: o.ubr600, pa: o.pa });
    }
  }
}

const sig = (b: { ciLo: number; ciHi: number }) => (b.ciLo * b.ciHi > 0 ? "*" : " ");
// ── (1) hitter wOBA bias by tier: raw vs own-gap ──
console.log(`═══ (1) HITTER wOBA BIAS by tier (mwOBA, pred−obs) — raw vs own-gap ═══`);
console.log(`tier        N    raw wOBA          own-gap wOBA`);
for (const { tier } of QUICK) {
  const rr = rowsByMode.raw.filter((r) => r.tier === tier), ro = rowsByMode.owngap.filter((r) => r.tier === tier);
  if (!rr.length) continue;
  const br = channelBias(rr, "woba"), bo = channelBias(ro, "woba");
  console.log(`${tier.padEnd(10)} ${String(rr.length).padStart(3)}  ${(br.bias * 1000 >= 0 ? "+" : "")}${fmt(br.bias * 1000, 1)}${sig(br)} [${fmt(br.ciLo * 1000, 0)},${fmt(br.ciHi * 1000, 0)}]   ${(bo.bias * 1000 >= 0 ? "+" : "")}${fmt(bo.bias * 1000, 1)}${sig(bo)} [${fmt(bo.ciLo * 1000, 0)},${fmt(bo.ciHi * 1000, 0)}]`);
}

// ── (2) per-channel bias (own-gap) + within-tier attribution slopes ──
console.log(`\n═══ (2) HITTER CHANNEL BIAS (own-gap, pred−obs) ═══`);
console.log(`tier        BB%      SO%      HR600    BABIP`);
for (const { tier } of QUICK) {
  const rs = rowsByMode.owngap.filter((r) => r.tier === tier); if (!rs.length) continue;
  const c = (ch: string) => channelBias(rs, ch);
  const bb = c("bbPct"), so = c("soPct"), hr = c("hr600"), ba = c("babip");
  console.log(`${tier.padEnd(10)}  ${fmt(bb.bias)}${sig(bb)}  ${fmt(so.bias)}${sig(so)}  ${fmt(hr.bias)}${sig(hr)}  ${fmt(ba.bias, 3)}${sig(ba)}`);
}
console.log(`\n═══ (2b) ATTRIBUTION — within-tier partial slopes of wOBA-bias (mwOBA per +10 rating; β>0 ⇒ OVER-value) ═══`);
const axes = ["eye", "pow", "kRat", "babip", "gap"] as const;
for (const mode of ["raw", "owngap"] as const) {
  const per: Record<string, number[]> = { eye: [], pow: [], kRat: [], babip: [], gap: [] };
  for (const { tier } of QUICK) {
    const rs = rowsByMode[mode].filter((r) => r.tier === tier); if (rs.length < 20) continue;
    const mean = (g: (r: AuditRow) => number) => rs.reduce((a, r) => a + g(r), 0) / rs.length;
    const mu = Object.fromEntries(axes.map((a) => [a, mean((r) => r.ratings[a]!)]));
    const beta = wls(rs.map((r) => [1, ...axes.map((a) => r.ratings[a]! - mu[a]!)]), rs.map((r) => (r.pred.woba! - r.obs.woba!) * 1000), rs.map(() => 1));
    axes.forEach((a, i) => per[a]!.push(beta[i + 1]!));
  }
  console.log(`  ${mode.padEnd(7)} ` + axes.map((a) => {
    const s = per[a]!, m = s.reduce((x, y) => x + y, 0) / s.length, sd = Math.sqrt(s.reduce((x, v) => x + (v - m) ** 2, 0) / Math.max(s.length - 1, 1)), se = sd / Math.sqrt(s.length);
    return `${a} ${m * 10 >= 0 ? "+" : ""}${fmt(m * 10, 2)}${(m - 1.96 * se) * (m + 1.96 * se) > 0 ? "*" : " "}`;
  }).join("  "));
}

// ── (3) BASERUNNING FIRST-LOOK ──
console.log(`\n═══ (3) BASERUNNING FIRST-LOOK — cwhit wSB600/UBR600 vs our ratings (deployed weight = ZERO) ═══`);
const corr = (xs: number[], ys: number[]) => { const nn = xs.length, mx = xs.reduce((a, b) => a + b, 0) / nn, my = ys.reduce((a, b) => a + b, 0) / nn; let cv = 0, vx = 0, vy = 0; for (let i = 0; i < nn; i++) { cv += (xs[i]! - mx) * (ys[i]! - my); vx += (xs[i]! - mx) ** 2; vy += (ys[i]! - my) ** 2; } return cv / Math.sqrt(vx * vy); };
const deep = brRows.filter((r) => r.pa >= 2000);
const wsb = deep.map((r) => r.wsb), ubr = deep.map((r) => r.ubr), br = deep.map((r) => r.wsb + r.ubr);
console.log(`  N=${deep.length} (PA≥2000). Observed baserunning runs/600: wSB mean ${fmt(wsb.reduce((a, b) => a + b, 0) / deep.length, 2)} (SD ${fmt(spreadArr(wsb), 2)}), UBR mean ${fmt(ubr.reduce((a, b) => a + b, 0) / deep.length, 2)} (SD ${fmt(spreadArr(ubr), 2)})`);
console.log(`  corr(Stealing rating, wSB600) = ${fmt(corr(deep.map((r) => r.stl), wsb), 3)}   corr(Speed, wSB600) = ${fmt(corr(deep.map((r) => r.spd), wsb), 3)}   corr(Baserunning, UBR600) = ${fmt(corr(deep.map((r) => r.run), ubr), 3)}   corr(Speed, UBR600) = ${fmt(corr(deep.map((r) => r.spd), ubr), 3)}`);
const brSpreadMwoba = spreadArr(br) * WOBA_SCALE / 600 * 1000;
console.log(`  total baserunning (wSB+UBR) SD across cards ≈ ${fmt(spreadArr(br), 2)} runs/600 ≈ ${fmt(brSpreadMwoba, 1)} mwOBA-equiv of value SPREAD our model currently zeroes out.`);
console.log(`  range: ${fmt(Math.min(...br), 1)} to ${fmt(Math.max(...br), 1)} runs/600 (${fmt((Math.max(...br) - Math.min(...br)) * WOBA_SCALE / 600 * 1000, 1)} mwOBA top-to-bottom).`);

function spreadArr(xs: number[]) { const m = xs.reduce((a, b) => a + b, 0) / xs.length; return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / xs.length); }
process.exit(0);
