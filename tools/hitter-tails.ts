// PHASE-1c STEP-1(hitter) + top-decile slice + CI on the pitcher winner.
//  (a) HITTER channel locator: one-at-a-time from deployed RAWPOLY_HIT (bb log,k log,hr raw2,xbh log,h log)
//      → in-frame deconvolved value spread + Pearson. Hitters are ~1.0 pooled (§11.23) — does any form
//      help/hurt, or does log hold its seats?
//  (b) TOP-DECILE SLICE (both roles): spread ratio in the top-10%-by-value slice vs pooled — the pooled
//      1.02 can hide ELITE-tail compression (the gaps that most drive roster decisions). Fable's flag.
//  (c) CI on the pitcher winner (rawquad-all+aux) vs deployed — bootstrap, confirm CI-clear (Step 2).
//   run: node tools/hitter-tails.ts
import { readFileSync } from "node:fs";
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { resolveCoeffs, type Model } from "../src/config/coeff-resolve.ts";
import type { Era, Park, Tournament } from "../src/config/tournament.ts";
import { applyWobaWeights, makeRawPolyModel, computeDerived } from "../src/scoring-core/index.ts";
import { hittingComponents, pitchingComponents } from "../src/scoring-core/woba.ts";
import { wobaWeightsFromCoeffs } from "../src/scoring-core/woba-weights.ts";
import { loadWindow, type TrainObs } from "../src/training/loader.ts";
import { HITTER, PITCHER } from "../src/training/bakeoff.ts";
import { fitHitForm, fitPitForm, RAWPOLY_HIT, STUFFAUG_PIT } from "../src/training/forms.ts";
import type { EventForm, FittedHit, FittedPit } from "../src/model/curves.ts";
import { wobaNoiseVar } from "../src/eval/cwhit/scorecard.ts";

const R2 = { kind: "rawpoly", degree: 2 } as const;
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
const lgHit = lgObs.filter((o) => HITTER.qualifies(o, minPA)), lgPit = lgObs.filter((o) => PITCHER.qualifies(o, minPA));
const neut = (await repo.loadAll<Tournament>("tournaments")).find((x) => x.id === "default-neutral")!;
const coeffs = resolveCoeffs(model, eras.get(neut.eraId)!, parks.get(neut.parkId)!, neut.softcaps);
if (trained.wobaWeights) applyWobaWeights(coeffs, trained.wobaWeights);
const derived = computeDerived(coeffs, true);
const w = wobaWeightsFromCoeffs(coeffs);

const per600 = (x: number, d: number) => (d > 0 ? (x * 600) / d : 0);
const wvar = (x: number[], wt: number[]) => { const sw = wt.reduce((a, b) => a + b, 0); const m = x.reduce((a, v, i) => a + wt[i]! * v, 0) / sw; return x.reduce((a, v, i) => a + wt[i]! * (v - m) ** 2, 0) / sw; };
const wmean = (x: number[], wt: number[]) => { const sw = wt.reduce((a, b) => a + b, 0); return x.reduce((a, v, i) => a + wt[i]! * v, 0) / sw; };
// COMPOSITE NOISE — the multinomial weighted-sum variance is IMPORTED, not re-derived.
// This file previously carried its own `seW`. It was arithmetically correct — and that is the
// point: FOUR tools held the correct closed form while tools/cwhit-scorecard.ts asserted "a
// composite; no clean binomial form" and returned NaN, which produced two retracted findings on
// 2026-07-20 (plan §15.8). The form now lives once, in src/eval/cwhit/scorecard.ts.
// Local wrapper keeps this file's units: per-600 rates -> proportions, and SD not variance.
const seW = (uBB: number, HmHR: number, HR: number, XBH: number, d: number) => Math.sqrt(wobaNoiseVar([{ p: uBB / 600, w: w.bb }, { p: (HmHR - XBH) / 600, w: w.b1 }, { p: XBH / 600, w: w.xbh }, { p: HR / 600, w: w.hr }], d));
interface Row { pred: number; real: number; w: number; se: number }
const spreadRatio = (rs: Row[]) => { const sPred = Math.sqrt(wvar(rs.map((r) => r.pred), rs.map((r) => r.w))); const sTrue = Math.sqrt(Math.max(wvar(rs.map((r) => r.real), rs.map((r) => r.w)) - wmean(rs.map((r) => r.se ** 2), rs.map((r) => r.w)), 1e-9)); return sPred / sTrue; };
const pear = (rs: Row[]) => { const p = rs.map((r) => r.pred), a = rs.map((r) => r.real), wt = rs.map((r) => r.w); const mp = wmean(p, wt), mr = wmean(a, wt); let c = 0, vp = 0, vr = 0; for (let i = 0; i < p.length; i++) { const dp = p[i]! - mp, dr = a[i]! - mr; c += wt[i]! * dp * dr; vp += wt[i]! * dp * dp; vr += wt[i]! * dr * dr; } return c / Math.sqrt(vp * vr); };
const bootCI = (rs: Row[]) => { const bs: number[] = []; for (let b = 0; b < 400; b++) { const s = Array.from({ length: rs.length }, () => rs[Math.floor(Math.random() * rs.length)]!); bs.push(spreadRatio(s)); } bs.sort((a, b) => a - b); return [bs[10]!, bs[389]!] as const; };

const hitRows = (h: FittedHit): Row[] => { const m = makeRawPolyModel({ hit: h, pit: STUFFAUG_PIT as any } as any); return lgHit.map((o) => { const e = m.predictHitting(o.ratings.hit, coeffs); const k = hittingComponents(e, 1, 1, 1, "vR", coeffs, derived, { hit: h } as any); const pred = (w.bb * k.BB_fin + w.hbp * coeffs.adv_hbp + w.b1 * k.oneB_fin + w.xbh * k.GAP_fin + w.hr * k.HR_fin) / 600; const uBB = per600(o.hit.BB - o.hit.IBB, o.hit.PA), HmHR = per600(o.hit.H - o.hit.HR, o.hit.PA), HR = per600(o.hit.HR, o.hit.PA), XBH = per600(o.hit.b2 + o.hit.b3, o.hit.PA); const real = (w.bb * uBB + w.hbp * coeffs.adv_hbp + w.b1 * (HmHR - XBH) + w.xbh * XBH + w.hr * HR) / 600; return { pred, real, w: o.hit.PA, se: seW(uBB, HmHR, HR, XBH, o.hit.PA) }; }); };
const pitRows = (p: FittedPit): Row[] => { const m = makeRawPolyModel({ hit: RAWPOLY_HIT as any, pit: p } as any); return lgPit.map((o) => { const e = m.predictPitching(o.ratings.pitch, coeffs); const k = pitchingComponents(e, 1, 1, "vR", coeffs, derived, { pit: p } as any); const pred = (w.bb * k.BB_fin + w.hbp * coeffs.adv_hbp + w.b1 * k.oneB_fin + w.xbh * k.XBH_fin + w.hr * k.HR_fin) / 600; const uBB = per600(o.pitch.BB - o.pitch.IBB, o.pitch.BF), HmHR = per600(o.pitch.b1 + o.pitch.b2 + o.pitch.b3, o.pitch.BF), HR = per600(o.pitch.HR, o.pitch.BF), XBH = per600(o.pitch.b2 + o.pitch.b3, o.pitch.BF); const real = (w.bb * uBB + w.hbp * coeffs.adv_hbp + w.b1 * (HmHR - XBH) + w.xbh * XBH + w.hr * HR) / 600; return { pred, real, w: o.pitch.BF, se: seW(uBB, HmHR, HR, XBH, o.pitch.BF) }; }); };
// top-decile slice: keep the top 10% by ACTUAL value (higherBetter: hit yes, pit no = lowest allowed).
const topDecile = (rs: Row[], higherBetter: boolean) => { const s = [...rs].sort((a, b) => (higherBetter ? b.real - a.real : a.real - b.real)); return s.slice(0, Math.max(6, Math.ceil(s.length * 0.1))); };
const f = (n: number) => (Number.isFinite(n) ? (n >= 0 ? " " : "") + n.toFixed(3) : "  n/a");

console.log(`HITTER LOCATOR — league in-frame (window ${win.join("+")}), N=${lgHit.length}. Deployed hit = RAWPOLY_HIT.\n`);
console.log(`variant                          spread  Pearson`);
const HV: [string, any][] = [
  ["deployed RAWPOLY_HIT", RAWPOLY_HIT], ["  BB→raw2", { ...RAWPOLY_HIT, bb: R2 }], ["  K→raw2", { ...RAWPOLY_HIT, k: R2 }],
  ["  XBH→raw2", { ...RAWPOLY_HIT, xbh: R2 }], ["  H→raw2", { ...RAWPOLY_HIT, h: R2 }], ["  ALL raw2", { name: "hitrawquad", bb: R2, k: R2, hr: R2, xbh: R2, h: R2 }],
];
for (const [label, hf] of HV) { const rs = hitRows(fitHitForm(hf, lgObs)); console.log(`${label.padEnd(30)} ${f(spreadRatio(rs))}  ${f(pear(rs))}`); }

console.log(`\nTOP-DECILE SLICE (elite-tail spread ratio vs pooled; pooled hides tail compression):`);
const winPit = fitPitForm({ name: "rawquad+aux", bb: R2, k: R2, hr: R2, h: R2, stuffAug: true } as any, lgObs);
const deplPit = fitPitForm(STUFFAUG_PIT, lgObs);
const deplHit = fitHitForm(RAWPOLY_HIT, lgObs);
const slices: [string, Row[], boolean][] = [
  ["HIT deployed", hitRows(deplHit), true],
  ["PIT deployed(K=log)", pitRows(deplPit), false],
  ["PIT winner(rawquad+aux)", pitRows(winPit), false],
];
for (const [label, rs, hb] of slices) { const td = topDecile(rs, hb); console.log(`  ${label.padEnd(26)} pooled ${f(spreadRatio(rs))}   top-decile(N=${td.length}) ${f(spreadRatio(td))}`); }

console.log(`\nCI (Step 2) — pitcher in-frame spread, PAIRED bootstrap (same cards resampled for both forms):`);
const dp = pitRows(deplPit), wp = pitRows(winPit); // aligned per-card (same lgPit order)
const diffs: number[] = [];
for (let b = 0; b < 800; b++) {
  const idx = Array.from({ length: dp.length }, () => Math.floor(Math.random() * dp.length));
  diffs.push(spreadRatio(idx.map((i) => wp[i]!)) - spreadRatio(idx.map((i) => dp[i]!)));
}
diffs.sort((a, b) => a - b);
const dlo = diffs[20]!, dhi = diffs[779]!; // 95%
console.log(`  deployed(K=log)       ${f(spreadRatio(dp))} [${bootCI(dp).map(f).join(",")}]`);
console.log(`  winner(rawquad+aux)   ${f(spreadRatio(wp))} [${bootCI(wp).map(f).join(",")}]`);
console.log(`  Δ(winner−deployed)    ${f(spreadRatio(wp) - spreadRatio(dp))} [${f(dlo)},${f(dhi)}]   → CI EXCLUDES 0 (winner materially better)? ${dlo > 0 ? "YES" : "no"}`);
process.exit(0);
