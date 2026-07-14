// DRIVER for the cwhitstats calibration audit (Batch 2). Builds COMBINED (vR/vL exposure-blended)
// per-card predictions from the active pareto artifact, joins to cwhit's observed tier tables, and
// prints: (1) per-tier pitcher channel bias (K9/BB9/HR9/BABIP/wOBAA) with card-level CIs; (2) the
// con×stu 2-D bins — the presumed #1 defect (high-CON/STU over-valuation); (3) the IRON GATE
// (levels + spread + concordance on iron quick); (4) a hitter per-tier bias summary; (5) the ranked
// mwOBA defect table. EVAL-ONLY, read-only. run: node tools/cwhit-audit.ts
//
// Exposure blend uses the artifact's league platoon splits (documented approximation — the
// tournament opponent mix differs slightly; a constant mis-blend shifts LEVELS but not the
// across-rating ORDER/SPACING, which is where the con×stu defect lives). His wOBA/projection
// columns are never truth; observed = raw events only (memory cwhitstats-external-data).

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { makeRawPolyModel } from "../src/scoring-core/index.ts";
import { parseCatalogCsv, type Card } from "../src/data/catalog.ts";
import { makeVariant } from "../src/data/variants.ts";
import { PIT_BIP_ADJ, HIT_BIP_ADJ, type EventForm } from "../src/model/curves.ts";
import type { Coeffs } from "../src/config/types.ts";
import { wls } from "../src/training/fit.ts";
import { parseCwhitPit, parseCwhitHit } from "../src/eval/cwhit/index.ts";
import { joinCwhit, type JoinCard, type JoinObs } from "../src/eval/cwhit/index.ts";
import {
  pitWobaFromChannels, hitWobaFromRates, channelBias, biasByBin, bias2D, rankDefects, spread,
  PER9_TO_PER600, type AuditRow, type WobaWeights,
} from "../src/eval/cwhit/audit.ts";

const SCRATCH = "C:/Users/dstal/AppData/Local/Temp/claude/C--dev-ootp-app/3424c376-236e-4105-b460-f5fcc1109c7f/scratchpad";
const FIX = "fixtures/cwhit";
const PER600_TO_PER9 = 1 / PER9_TO_PER600;
const n = (v: unknown): number => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const handLetter = (code: number): string => (code === 2 ? "L" : code === 3 ? "S" : "R");
const starterProxy = (stamina: number) => clamp01((stamina - 20) / 40);
const fmt = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "n/a");

const repo = new Repository("data");
await seedDefaults(repo); await seedEras(repo); await seedAccounts(repo);
const state = (await repo.load<{ activeModelId?: string; catalogSourceId?: string }>("state", "app")) ?? {};
type TM = { id: string; eventForm?: EventForm; wobaWeights?: WobaWeights; platoon?: { pit: { hand: string; vsRHB: number; vsLHB: number }[]; hit: { hand: string; vsRHP: number; vsLHP: number }[] } };
const trained = (await repo.loadAll<TM>("trained-models")).find((x) => x.id === state.activeModelId);
if (!trained?.eventForm || !trained.wobaWeights || !trained.platoon) throw new Error(`active model '${state.activeModelId}' missing eventForm/weights/platoon`);
const rp = makeRawPolyModel(trained.eventForm);
const W = trained.wobaWeights;
const C = {} as Coeffs;
const pitExp = new Map(trained.platoon.pit.map((p) => [p.hand, { wR: p.vsRHB, wL: p.vsLHB }]));
const hitExp = new Map(trained.platoon.hit.map((p) => [p.hand, { wR: p.vsRHP, wL: p.vsLHP }]));
const srcId = state.catalogSourceId ?? "cdmx";
const catalog = parseCatalogCsv(readFileSync(`data/imports/${srcId}.csv`, "utf8"));
const baseCards = catalog.cards.filter((c) => String(c["Variant"] ?? "").toUpperCase() !== "Y");
console.log(`[cwhit-audit] model '${trained.id}' | weights bb${fmt(W.bb)} 1b${fmt(W.b1)} xbh${fmt(W.xbh)} hr${fmt(W.hr)} | ${baseCards.length} cards\n`);

// ── combined (exposure-blended) predicted channel lines ──────────────────────────
const isPitcher = (c: Card) => n(c["Pitcher Role"]) > 0 || String(c["Position"]).trim() === "1";
const isHitter = (c: Card) => String(c["Position"]).trim() !== "1";
const cardName = (c: Card) => `${(c["FirstName"] ?? "").trim()} ${(c["LastName"] ?? "").trim()}`.trim();
const pr = (c: Card, k: string, s: "R" | "L") => n(c[`${k} v${s}`]);

/** Combined pitcher line → per-9 channels + wOBAA, exposure-blended over the batter hands faced. */
function combinedPit(c: Card): { k9: number; bb9: number; hr9: number; babip: number; woba: number } {
  const hand = handLetter(n(c["Throws"]));
  const { wR, wL } = pitExp.get(hand) ?? { wR: 0.5, wL: 0.5 };
  const eR = rp.predictPitching({ con: pr(c, "Control", "R"), stu: pr(c, "Stuff", "R"), pbabip: pr(c, "pBABIP", "R"), hrr: pr(c, "pHR", "R") }, C);
  const eL = rp.predictPitching({ con: pr(c, "Control", "L"), stu: pr(c, "Stuff", "L"), pbabip: pr(c, "pBABIP", "L"), hrr: pr(c, "pHR", "L") }, C);
  const BB = wR * eR.BB + wL * eL.BB, K = wR * eR.K + wL * eL.K, HR = wR * eR.HR + wL * eL.HR, nHH = wR * eR.nHH + wL * eL.nHH;
  const BIP = Math.max(600 - BB - K - HR - PIT_BIP_ADJ, 1);
  const babip = nHH / BIP;
  const k9 = K * PER600_TO_PER9, bb9 = BB * PER600_TO_PER9, hr9 = HR * PER600_TO_PER9;
  return { k9, bb9, hr9, babip, woba: pitWobaFromChannels(k9, bb9, hr9, babip, W) };
}
/** Combined hitter line → per-PA rates + wOBA, exposure-blended over the pitcher hands faced. */
function combinedHit(c: Card): { bbPct: number; soPct: number; hr600: number; babip: number; woba: number } {
  const hand = handLetter(n(c["Bats"]));
  const { wR, wL } = hitExp.get(hand) ?? { wR: 0.5, wL: 0.5 };
  const g = (s: "R" | "L") => rp.predictHitting({ eye: pr(c, "Eye", s), pow: pr(c, "Power", s), kRat: n(c[`Avoid K v${s}`]), babip: pr(c, "BABIP", s), gap: pr(c, "Gap", s), speed: n(c["Speed"]), steal: n(c["Steal Rate"]), run: n(c["Baserunning"]) }, C);
  const eR = g("R"), eL = g("L");
  const BB = wR * eR.BB + wL * eL.BB, SO = wR * eR.SO + wL * eL.SO, HR = wR * eR.HR + wL * eL.HR, oneB = wR * eR.oneB + wL * eL.oneB, GAP = wR * eR.GAP + wL * eL.GAP;
  const BIP = Math.max(600 - BB - SO - HR - HIT_BIP_ADJ, 1);
  const woba = (W.bb * BB + W.hbp * 6 + W.b1 * oneB + W.xbh * GAP + W.hr * HR) / 600;
  return { bbPct: BB / 6, soPct: SO / 6, hr600: HR, babip: (oneB + GAP) / BIP, woba };
}

// our-side JoinCards (fingerprint from combined line) + a cid→prediction/ratings map for enrichment.
type Pred = { ratings: Record<string, number>; pred: Record<string, number> };
const pitById = new Map<string, Pred>(), hitById = new Map<string, Pred>();
const ourPit: JoinCard[] = [], ourHit: JoinCard[] = [];
for (const bc of baseCards) {
  for (const [vlvl, c] of [[0, bc], [5, makeVariant(bc)]] as const) {
    const cid = `${bc["Card ID"]}${vlvl ? "#V" : ""}`, val = n(c["Card Value"]);
    if (isPitcher(c)) {
      const p = combinedPit(c);
      ourPit.push({ cid, name: cardName(c), val, vlvl, hand: handLetter(n(c["Throws"])), primary: [starterProxy(n(c["Stamina"])), p.babip], validate: [p.k9, p.bb9, p.hr9] });
      pitById.set(cid, { ratings: { con: pr(c, "Control", "R"), stu: pr(c, "Stuff", "R"), hrr: pr(c, "pHR", "R"), pbabip: pr(c, "pBABIP", "R") }, pred: p });
    }
    if (isHitter(c)) {
      const h = combinedHit(c);
      ourHit.push({ cid, name: cardName(c), val, vlvl, hand: handLetter(n(c["Bats"])), primary: [h.babip], validate: [h.bbPct, h.soPct, h.hr600] });
      hitById.set(cid, { ratings: { eye: pr(c, "Eye", "R"), pow: pr(c, "Power", "R"), kRat: n(c["Avoid K vR"]), babip: pr(c, "BABIP", "R"), gap: pr(c, "Gap", "R") }, pred: h });
    }
  }
}

// ── assemble audit rows per tier ─────────────────────────────────────────────────
const pitRows: AuditRow[] = [], hitRows: AuditRow[] = [];
const tierOf = (f: string) => f.replace("cwhit-", "").replace(/-(pit|hit)\.tsv$/, "");
for (const f of readdirSync(FIX).filter((x) => x.endsWith(".tsv"))) {
  const tsv = readFileSync(`${FIX}/${f}`, "utf8"), tier = tierOf(f);
  if (f.includes("-pit")) {
    const { rows } = parseCwhitPit(tsv);
    const obs: JoinObs<typeof rows[0]>[] = rows.map((r) => ({ name: r.name, val: r.val, vlvl: r.vlvl, hand: r.hand, primary: [r.gsPer, r.babip], validate: [r.k9, r.bb9, r.hr9], sample: r.ip, row: r }));
    for (const m of joinCwhit(obs, ourPit).matched) {
      const p = pitById.get(m.card.cid)!, o = m.obs.row;
      pitRows.push({ cid: m.card.cid, name: m.obs.name, tier, role: "pit", sample: o.ip, ratings: p.ratings,
        pred: p.pred, obs: { k9: o.k9, bb9: o.bb9, hr9: o.hr9, babip: o.babip, woba: pitWobaFromChannels(o.k9, o.bb9, o.hr9, o.babip, W) } });
    }
  } else {
    const { rows } = parseCwhitHit(tsv);
    const obs: JoinObs<typeof rows[0]>[] = rows.map((r) => ({ name: r.name, val: r.val, vlvl: r.vlvl, hand: r.hand, primary: [r.babip], validate: [r.bbPct, r.soPct, r.hr600], sample: r.pa, row: r }));
    for (const m of joinCwhit(obs, ourHit).matched) {
      const p = hitById.get(m.card.cid)!, o = m.obs.row;
      hitRows.push({ cid: m.card.cid, name: m.obs.name, tier, role: "hit", sample: o.pa, ratings: p.ratings,
        pred: p.pred, obs: { bbPct: o.bbPct, soPct: o.soPct, hr600: o.hr600, babip: o.babip, woba: hitWobaFromRates({ bbPct: o.bbPct, soPct: o.soPct, hr600: o.hr600, babip: o.babip, avg: o.avg, slg: o.slg, tripleXbh: o.tripleXbh }, W) } });
    }
  }
}
console.log(`[cwhit-audit] audit rows: ${pitRows.length} pit, ${hitRows.length} hit (matched, combined pred)\n`);

const TIERS = ["iron", "bronze", "silver", "gold", "diamond", "bronzeheartdaily", "earlygolddaily", "goldcapdaily", "diamondcapdaily"];
const bcell = (b: { bias: number; ciLo: number; ciHi: number; n: number }) => `${b.bias >= 0 ? "+" : ""}${fmt(b.bias * (Math.abs(b.bias) < 1 ? 1000 : 1), Math.abs(b.bias) < 1 ? 0 : 2)}`;
const sig = (b: { ciLo: number; ciHi: number }) => (b.ciLo * b.ciHi > 0 ? "*" : " ");

// ── (1) pitcher per-tier channel bias (pred − obs) ──
console.log(`═══ (1) PITCHER CHANNEL BIAS (pred − obs); wOBAA in mwOBA, * = 95% CI excludes 0 ═══`);
console.log(`tier            N   K9      BB9     HR9     BABIP     wOBAA(mwOBA)`);
for (const t of TIERS) {
  const rs = pitRows.filter((r) => r.tier === t); if (!rs.length) continue;
  const c = (ch: string) => channelBias(rs, ch);
  const k = c("k9"), bb = c("bb9"), hr = c("hr9"), ba = c("babip"), wo = c("woba");
  console.log(`${t.padEnd(15)} ${String(rs.length).padStart(3)}  ${fmt(k.bias)}${sig(k)}  ${fmt(bb.bias)}${sig(bb)}  ${fmt(hr.bias)}${sig(hr)}  ${fmt(ba.bias, 3)}${sig(ba)}   ${(wo.bias * 1000 >= 0 ? "+" : "")}${fmt(wo.bias * 1000, 1)}${sig(wo)} [${fmt(wo.ciLo * 1000, 1)},${fmt(wo.ciHi * 1000, 1)}]`);
}

// ── (2) con×stu 2-D wOBAA bias — the presumed #1 defect ──
console.log(`\n═══ (2) con×stu wOBAA BIAS (mwOBA, pred−obs; NEGATIVE = we predict lower wOBAA = OVER-value) ═══`);
const conEdges = [110, 140], stuEdges = [110, 140]; // low / mid / high rating bands
for (const t of ["bronze", "iron", "silver", "gold"]) {
  const rs = pitRows.filter((r) => r.tier === t); if (rs.length < 8) continue;
  console.log(`  ${t}:`);
  const grid = bias2D(rs, "woba", "stu", stuEdges, "con", conEdges);
  const stuL = [...new Set(grid.map((g) => g.x))];
  for (const sl of stuL) {
    const cells = grid.filter((g) => g.x === sl);
    console.log(`    stu ${sl.padEnd(9)} ` + cells.map((c) => `con ${c.y.padEnd(9)} ${c.stat.n ? `${(c.stat.bias * 1000 >= 0 ? "+" : "")}${fmt(c.stat.bias * 1000, 1)}${sig(c.stat)}(${c.stat.n})` : "—"}`).join("  "));
  }
}

// ── (2b) con-vs-stu ATTRIBUTION — within-tier partial slopes (frame-absorbed) ──
// Regress wOBAA-bias (mwOBA) on CENTERED con,stu,hrr,pbabip WITHIN each tier (tier fixed effect
// absorbs the opponent-frame level), then pool the partial slopes across tiers. β>0 ⇒ higher rating
// → MORE positive bias (pred wOBAA higher than obs = we rate the pitcher WORSE than observed);
// β<0 ⇒ higher rating → we rate it BETTER than observed (the over-valuation direction). Partial
// slopes hold the other ratings fixed, so con and stu are finally separated. Raw EVENT model
// (own-gap NOT applied — deployed scoring would lift high-rating cards further, i.e. push β more
// negative), so read this as the event-mapping component of the con/stu question.
console.log(`\n═══ (2b) con-vs-stu ATTRIBUTION — within-tier partial slopes of wOBAA-bias (mwOBA per +10 rating) ═══`);
const axes = ["con", "stu", "hrr", "pbabip"] as const;
const perTierSlopes: Record<string, number[]> = { con: [], stu: [], hrr: [], pbabip: [] };
for (const t of ["iron", "bronze", "silver", "gold", "diamond"]) {
  const rs = pitRows.filter((r) => r.tier === t); if (rs.length < 20) continue;
  const mean = (g: (r: AuditRow) => number) => rs.reduce((a, r) => a + g(r), 0) / rs.length;
  const mu = Object.fromEntries(axes.map((a) => [a, mean((r) => r.ratings[a]!)]));
  const X = rs.map((r) => [1, ...axes.map((a) => r.ratings[a]! - mu[a]!)]);
  const y = rs.map((r) => (r.pred.woba! - r.obs.woba!) * 1000);
  const beta = wls(X, y, rs.map(() => 1));
  axes.forEach((a, i) => perTierSlopes[a]!.push(beta[i + 1]!));
  console.log(`  ${t.padEnd(9)} ` + axes.map((a, i) => `${a} ${beta[i + 1]! * 10 >= 0 ? "+" : ""}${fmt(beta[i + 1]! * 10, 2)}`).join("  "));
}
console.log(`  ${"POOLED".padEnd(9)} ` + axes.map((a) => {
  const s = perTierSlopes[a]!, m = s.reduce((x, y) => x + y, 0) / s.length;
  const sd = Math.sqrt(s.reduce((x, v) => x + (v - m) ** 2, 0) / Math.max(s.length - 1, 1)), se = sd / Math.sqrt(s.length);
  const sig = (m - 1.96 * se) * (m + 1.96 * se) > 0 ? "*" : " ";
  return `${a} ${m * 10 >= 0 ? "+" : ""}${fmt(m * 10, 2)}${sig}`;
}).join("  ") + `   (per +10 rating; * = pooled 95% CI excludes 0)`);

// ── (3) IRON GATE ──
console.log(`\n═══ (3) IRON GATE — iron-quick levels, spread, concordance ═══`);
const iron = pitRows.filter((r) => r.tier === "iron");
if (iron.length) {
  const deep = iron.filter((r) => r.sample * 4.3 >= 500); // ≥500 BF
  const mP = (g: (r: AuditRow) => number) => iron.reduce((a, r) => a + g(r), 0) / iron.length;
  console.log(`  N=${iron.length} (${deep.length} ≥500 BF). Mean pred vs obs:`);
  for (const [ch, d] of [["k9", 2], ["bb9", 2], ["hr9", 2], ["babip", 3], ["woba", 3]] as const)
    console.log(`    ${ch.padEnd(6)} pred ${fmt(mP((r) => r.pred[ch]!), d)}  obs ${fmt(mP((r) => r.obs[ch]!), d)}  bias ${fmt(channelBias(iron, ch).bias, d)}${sig(channelBias(iron, ch))}`);
  const sdP = spread(deep, (r) => r.pred.woba!), sdO = spread(deep, (r) => r.obs.woba!);
  console.log(`  wOBAA SPREAD (≥500 BF): pred SD ${fmt(sdP, 4)}  obs SD ${fmt(sdO, 4)}  ratio ${fmt(sdP / (sdO || 1), 2)}`);
  const xs = deep.map((r) => r.pred.woba!), ys = deep.map((r) => r.obs.woba!), mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let cov = 0, vx = 0, vy = 0; for (let i = 0; i < xs.length; i++) { cov += (xs[i]! - mx) * (ys[i]! - my); vx += (xs[i]! - mx) ** 2; vy += (ys[i]! - my) ** 2; }
  console.log(`  CONCORDANCE (≥500 BF): corr(pred wOBAA, obs wOBAA) = ${fmt(cov / Math.sqrt(vx * vy), 3)}  (N=${deep.length})`);
}

// ── (4) hitter per-tier bias ──
console.log(`\n═══ (4) HITTER CHANNEL BIAS (pred − obs); wOBA in mwOBA ═══`);
console.log(`tier            N   BB%     SO%     HR600   BABIP     wOBA(mwOBA)`);
for (const t of TIERS) {
  const rs = hitRows.filter((r) => r.tier === t); if (!rs.length) continue;
  const c = (ch: string) => channelBias(rs, ch);
  const bb = c("bbPct"), so = c("soPct"), hr = c("hr600"), ba = c("babip"), wo = c("woba");
  console.log(`${t.padEnd(15)} ${String(rs.length).padStart(3)}  ${fmt(bb.bias)}${sig(bb)}  ${fmt(so.bias)}${sig(so)}  ${fmt(hr.bias)}${sig(hr)}  ${fmt(ba.bias, 3)}${sig(ba)}   ${(wo.bias * 1000 >= 0 ? "+" : "")}${fmt(wo.bias * 1000, 1)}${sig(wo)} [${fmt(wo.ciLo * 1000, 1)},${fmt(wo.ciHi * 1000, 1)}]`);
}

// ── (5) ranked defect table (per tier × role, net wOBA bias) ──
console.log(`\n═══ (5) RANKED DEFECTS — net wOBA bias × prevalence (mwOBA), significant only ═══`);
const totalSample = [...pitRows, ...hitRows].reduce((a, r) => a + r.sample, 0);
const defs = [];
for (const t of TIERS) for (const [rows, role] of [[pitRows, "pit"], [hitRows, "hit"]] as const) {
  const rs = rows.filter((r) => r.tier === t); if (rs.length < 5) continue;
  const wo = channelBias(rs, "woba");
  defs.push({ key: `${t}/${role}`, channel: "woba", biasMwoba: wo.bias * 1000, ciLoMwoba: wo.ciLo * 1000, ciHiMwoba: wo.ciHi * 1000, n: wo.n, prevalence: rs.reduce((a, r) => a + r.sample, 0) / totalSample });
}
for (const d of rankDefects(defs).filter((d) => d.significant).slice(0, 14))
  console.log(`  ${d.key.padEnd(22)} ${d.channel}  ${d.biasMwoba >= 0 ? "+" : ""}${fmt(d.biasMwoba, 1)} mwOBA [${fmt(d.ciLoMwoba, 1)},${fmt(d.ciHiMwoba, 1)}]  N=${d.n}  prev ${fmt(d.prevalence * 100, 1)}%  score ${fmt(d.score, 2)}`);

writeFileSync(`${SCRATCH}/cwhit-audit-rows.json`, JSON.stringify({ pit: pitRows, hit: hitRows }, null, 0));
console.log(`\n[cwhit-audit] rows → ${SCRATCH}/cwhit-audit-rows.json`);
process.exit(0);
