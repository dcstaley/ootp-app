// (a) HR ASYMMETRY: hitter HR is already rawpoly-2 (power event); pitcher HR is LOG in StuffAug. Test
//     reverting hitter HR→log (should HURT) and confirm pit HR→raw2 (helps, §11.27). Corrects the
//     imprecise "log holds every seat" — it's the CONTACT/DISCIPLINE channels that hold log.
// (b) TRANSFORM MECHANISM: does own-gap's faded mean-scalar COMPRESS the rating spread (differential
//     lift: low lifted ×k, high faded to ~0) while frame-v2's additive shift PRESERVES it? Map a stu
//     range through both for a weak pool.
//   run: node tools/hr-and-transform.ts
import { readFileSync } from "node:fs";
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { resolveCoeffs, type Model } from "../src/config/coeff-resolve.ts";
import type { Era, Park, Tournament } from "../src/config/tournament.ts";
import { applyWobaWeights, makeRawPolyModel, computeDerived, computeUnifiedFieldStats } from "../src/scoring-core/index.ts";
import { hittingComponents } from "../src/scoring-core/woba.ts";
import { wobaWeightsFromCoeffs } from "../src/scoring-core/woba-weights.ts";
import { affineFor, applyAffine } from "../src/model/pool-transform.ts";
import { loadWindow, type TrainObs } from "../src/training/loader.ts";
import { HITTER } from "../src/training/bakeoff.ts";
import { fitHitForm, RAWPOLY_HIT } from "../src/training/forms.ts";
import type { FittedHit } from "../src/model/curves.ts";
import { rowEligible } from "../src/config/eligibility.ts";
import { parseCatalogCsv } from "../src/data/catalog.ts";

const R2 = { kind: "rawpoly", degree: 2 } as const, LOGc = { kind: "log" } as const;
const repo = new Repository("data");
await seedDefaults(repo); await seedEras(repo); await seedAccounts(repo);
const state: any = (await repo.load<any>("state", "app")) ?? {};
const model = (await repo.loadAll<Model>("models"))[0]!;
const eras = new Map((await repo.loadAll<Era>("eras")).map((e) => [e.id, e]));
const parks = new Map((await repo.loadAll<Park>("parks")).map((p) => [p.id, p]));
const trained = (await repo.loadAll<any>("trained-models")).find((x) => x.id === state.activeModelId);
const win: number[] = Array.isArray(trained.window) && trained.window.length ? trained.window : [];
const minPA = Math.max(0, Number(trained.minPA ?? 1000) || 1000);
const lgObs = loadWindow("League Files", win.length ? win : undefined).observations.filter((o: TrainObs) => (trained.includeVariants ?? true) || !o.variant);
const lgHit = lgObs.filter((o) => HITTER.qualifies(o, minPA));
const neut = (await repo.loadAll<Tournament>("tournaments")).find((x) => x.id === "default-neutral")!;
const coeffs = resolveCoeffs(model, eras.get(neut.eraId)!, parks.get(neut.parkId)!, neut.softcaps);
if (trained.wobaWeights) applyWobaWeights(coeffs, trained.wobaWeights);
const derived = computeDerived(coeffs, true);
const w = wobaWeightsFromCoeffs(coeffs);
const per600 = (x: number, d: number) => (d > 0 ? (x * 600) / d : 0);
const wvar = (x: number[], wt: number[]) => { const sw = wt.reduce((a, b) => a + b, 0); const m = x.reduce((a, v, i) => a + wt[i]! * v, 0) / sw; return x.reduce((a, v, i) => a + wt[i]! * (v - m) ** 2, 0) / sw; };
const wmean = (x: number[], wt: number[]) => { const sw = wt.reduce((a, b) => a + b, 0); return x.reduce((a, v, i) => a + wt[i]! * v, 0) / sw; };
const seW = (uBB: number, HmHR: number, HR: number, XBH: number, d: number) => { const t: [number, number][] = [[w.bb, uBB / 600], [w.b1, (HmHR - XBH) / 600], [w.xbh, XBH / 600], [w.hr, HR / 600]]; const E = t.reduce((a, [ww, p]) => a + ww * p, 0), E2 = t.reduce((a, [ww, p]) => a + ww * ww * p, 0); return d > 0 ? Math.sqrt(Math.max(E2 - E * E, 0) / d) : 0; };
const hitSpread = (h: FittedHit) => { const m = makeRawPolyModel({ hit: h } as any); const pred: number[] = [], real: number[] = [], wt: number[] = [], se: number[] = []; for (const o of lgHit) { const e = m.predictHitting(o.ratings.hit, coeffs); const k = hittingComponents(e, 1, 1, 1, "vR", coeffs, derived, { hit: h } as any); pred.push((w.bb * k.BB_fin + w.hbp * coeffs.adv_hbp + w.b1 * k.oneB_fin + w.xbh * k.GAP_fin + w.hr * k.HR_fin) / 600); const uBB = per600(o.hit.BB - o.hit.IBB, o.hit.PA), HmHR = per600(o.hit.H - o.hit.HR, o.hit.PA), HR = per600(o.hit.HR, o.hit.PA), XBH = per600(o.hit.b2 + o.hit.b3, o.hit.PA); real.push((w.bb * uBB + w.hbp * coeffs.adv_hbp + w.b1 * (HmHR - XBH) + w.xbh * XBH + w.hr * HR) / 600); wt.push(o.hit.PA); se.push(seW(uBB, HmHR, HR, XBH, o.hit.PA)); } return Math.sqrt(wvar(pred, wt)) / Math.sqrt(Math.max(wvar(real, wt) - wmean(se.map((s) => s * s), wt), 1e-9)); };
const f = (n: number) => n.toFixed(3);

console.log(`(a) HITTER HR ASYMMETRY — in-frame deconvolved value spread. Deployed hitter HR is already RAWPOLY-2.\n`);
for (const [label, hf] of [
  ["deployed RAWPOLY_HIT (hr=raw2, rest log)", RAWPOLY_HIT],
  ["  HR → LOG (revert power event)", { ...RAWPOLY_HIT, hr: LOGc }],
  ["  ALL log (incl HR)", { name: "alllog", bb: LOGc, k: LOGc, hr: LOGc, xbh: LOGc, h: LOGc }],
] as const) { console.log(`${label.padEnd(44)} spread ${f(hitSpread(fitHitForm(hf as any, lgObs)))}`); }
console.log(`  → if HR→LOG drops the spread, hitter HR MUST stay raw-quad (power event); the LOG seats are bb/k/xbh/h.`);

console.log(`\n(b) TRANSFORM MECHANISM — own-gap faded mean-scalar vs frame-v2 additive shift, on a weak pool's Stuff.`);
const cat = parseCatalogCsv(readFileSync("data/imports/cdmx.csv", "utf8"));
const isB = (c: any) => String(c["Variant"] ?? "").toUpperCase() !== "Y";
const t = (await repo.loadAll<Tournament>("tournaments")).find((x) => x.id === "bronze-return")!;
const bc = resolveCoeffs(model, eras.get(t.eraId)!, parks.get(t.parkId)!, t.softcaps); if (trained.wobaWeights) applyWobaWeights(bc, trained.wobaWeights);
const inV = (c: any) => { const v = Number(c["Card Value"]) || 0; return (t.card_value_min == null || v >= t.card_value_min) && (t.card_value_max == null || v <= t.card_value_max); };
const basePool = cat.cards.filter((c: any) => isB(c) && inV(c) && rowEligible(c as any, t));
const rp = makeRawPolyModel(trained.eventForm);
const refF = computeUnifiedFieldStats(cat.cards.filter(isB), bc, rp, 50, true);
const poolF = computeUnifiedFieldStats(basePool, bc, rp, 50, true);
const leagueStu = { mu: refF.pit.vR.stu!.mu, sd: refF.pit.vR.stu!.sd }, poolStu = { mu: poolF.pit.vR.stu!.mu, sd: poolF.pit.vR.stu!.sd };
const ceiling = (trained.ratingEnvelope?.pit?.stu ?? Infinity) as number;
const aff = affineFor(leagueStu, poolStu, ceiling);
const gap = leagueStu.mu - poolStu.mu; // additive (own-gap proxy; frame-v2 crosses channels, magnitude similar)
console.log(`  Bronze-t: pool μStu ${poolStu.mu.toFixed(0)}, ref μStu ${leagueStu.mu.toFixed(0)}, k=${aff.k.toFixed(3)}, ceiling ${Number.isFinite(ceiling) ? ceiling.toFixed(0) : "∞"}, +gap ${gap.toFixed(0)}`);
console.log(`  rawStu :   own-gap(faded ×k)   frame-v2(+gap)`);
const raws = [50, 65, 80, 95, 110];
for (const r of raws) console.log(`   ${String(r).padStart(4)}  →   ${applyAffine(r, aff).toFixed(1).padStart(6)}          ${(r + gap).toFixed(1).padStart(6)}`);
const own = raws.map((r) => applyAffine(r, aff)), fv2 = raws.map((r) => r + gap);
console.log(`  SPREAD (max−min):  raw ${(raws[raws.length - 1]! - raws[0]!).toFixed(0)}   own-gap ${(own[own.length - 1]! - own[0]!).toFixed(1)} (${((own[own.length - 1]! - own[0]!) / (raws[raws.length - 1]! - raws[0]!) * 100).toFixed(0)}%)   frame-v2 ${(fv2[fv2.length - 1]! - fv2[0]!).toFixed(1)} (100%)`);
console.log(`  → own-gap COMPRESSES the spread (low lifted more than high, faded near ceiling); frame-v2 PRESERVES it.`);
process.exit(0);
