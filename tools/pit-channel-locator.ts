// PHASE-1c STEP 1 (locator) — WHERE does the pitcher value spread live? One-channel-at-a-time from the
// deployed baseline (StuffAug: bb LOG+aux, k LOG, hr LOG+aux, h LOG), flipping ONE channel's curve family
// to raw-poly (and aux on/off), measuring in-frame deconvolved value spread-ratio + Pearson + level bias.
// §11.24 showed K-alone barely helps (0.65) while uniform rawquad reaches 0.76 → the spread is multi-channel;
// this locates it cheaply before any full factorial. Log is INCUMBENT ONLY (Derek) — every seat re-earned.
//   run: node tools/pit-channel-locator.ts
import { readFileSync } from "node:fs";
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { resolveCoeffs, type Model } from "../src/config/coeff-resolve.ts";
import type { Era, Park, Tournament } from "../src/config/tournament.ts";
import { applyWobaWeights, makeRawPolyModel, computeDerived } from "../src/scoring-core/index.ts";
import { pitchingComponents } from "../src/scoring-core/woba.ts";
import { wobaWeightsFromCoeffs } from "../src/scoring-core/woba-weights.ts";
import { loadWindow, type TrainObs } from "../src/training/loader.ts";
import { PITCHER } from "../src/training/bakeoff.ts";
import { fitPitForm, STUFFAUG_PIT } from "../src/training/forms.ts";
import type { EventForm, FittedHit } from "../src/model/curves.ts";
import { wobaNoiseVar } from "../src/eval/cwhit/scorecard.ts";

const R2 = { kind: "rawpoly", degree: 2 } as const, R3 = { kind: "rawpoly", degree: 3 } as const, LOGc = { kind: "log" } as const;
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
const lgPit = lgObs.filter((o) => PITCHER.qualifies(o, minPA));
const neut = (await repo.loadAll<Tournament>("tournaments")).find((x) => x.id === "default-neutral")!;
const coeffs = resolveCoeffs(model, eras.get(neut.eraId)!, parks.get(neut.parkId)!, neut.softcaps);
if (trained.wobaWeights) applyWobaWeights(coeffs, trained.wobaWeights);
const derived = computeDerived(coeffs, true);
const w = wobaWeightsFromCoeffs(coeffs);
const HIT = trained.eventForm.hit as FittedHit;

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

function evalForm(pf: any) {
  const ef: EventForm = { hit: HIT, pit: fitPitForm(pf, lgObs) };
  const m = makeRawPolyModel(ef);
  const pred: number[] = [], real: number[] = [], wt: number[] = [], se: number[] = [];
  for (const o of lgPit) {
    const e = m.predictPitching(o.ratings.pitch, coeffs);
    const k = pitchingComponents(e, 1, 1, "vR", coeffs, derived, ef);
    pred.push((w.bb * k.BB_fin + w.hbp * coeffs.adv_hbp + w.b1 * k.oneB_fin + w.xbh * k.XBH_fin + w.hr * k.HR_fin) / 600);
    const uBB = per600(o.pitch.BB - o.pitch.IBB, o.pitch.BF), HmHR = per600(o.pitch.b1 + o.pitch.b2 + o.pitch.b3, o.pitch.BF), HR = per600(o.pitch.HR, o.pitch.BF), XBH = per600(o.pitch.b2 + o.pitch.b3, o.pitch.BF);
    real.push((w.bb * uBB + w.hbp * coeffs.adv_hbp + w.b1 * (HmHR - XBH) + w.xbh * XBH + w.hr * HR) / 600);
    wt.push(o.pitch.BF); se.push(seW(uBB, HmHR, HR, XBH, o.pitch.BF));
  }
  const sPred = Math.sqrt(wvar(pred, wt)), sTrue = Math.sqrt(Math.max(wvar(real, wt) - wmean(se.map((s) => s * s), wt), 1e-9));
  const mp = wmean(pred, wt), mr = wmean(real, wt); let c = 0, vp = 0, vr = 0; for (let i = 0; i < pred.length; i++) { const dp = pred[i]! - mp, dr = real[i]! - mr; c += wt[i]! * dp * dr; vp += wt[i]! * dp * dp; vr += wt[i]! * dr * dr; }
  return { spread: sPred / sTrue, pearson: c / Math.sqrt(vp * vr), levelBias: mp - mr };
}

const SA = STUFFAUG_PIT as any;
const VARIANTS: [string, any][] = [
  ["deployed (SA: bb log+aux,k log,hr log+aux,h log)", SA],
  ["  K → rawquad2", { ...SA, k: R2 }],
  ["  K → rawcubic3", { ...SA, k: R3 }],
  ["  BB → rawquad2 (keep aux)", { ...SA, bb: R2 }],
  ["  HR → rawquad2 (keep aux)", { ...SA, hr: R2 }],
  ["  H → rawquad2", { ...SA, h: R2 }],
  ["  aux OFF (all log, no stuff-aux)", { ...SA, stuffAug: false }],
  ["  aux OFF + K rawquad2", { ...SA, stuffAug: false, k: R2 }],
  ["  ALL rawquad2 + aux OFF (=rawquad_pit)", { name: "rawquad_pit", bb: R2, k: R2, hr: R2, h: R2 }],
  ["  ALL rawquad2 + aux ON", { name: "rawquad+aux", bb: R2, k: R2, hr: R2, h: R2, stuffAug: true }],
];
const f = (n: number) => (n >= 0 ? " " : "") + n.toFixed(3);
console.log(`PIT CHANNEL LOCATOR — league in-frame pitchers (window ${win.join("+")}), N=${lgPit.length}. Ceiling ref ~0.78 (§11.26).\n`);
console.log(`variant                                          spread  Pearson  levelBias`);
for (const [label, pf] of VARIANTS) { const r = evalForm(pf); console.log(`${label.padEnd(48)} ${f(r.spread)}  ${f(r.pearson)}  ${f(r.levelBias)}`); }
console.log(`\nRead: which single-channel flip moves 'spread' toward 0.78? K alone (§11.24) was weak; locate the real lever (BB/HR/H/aux) before the full cross. Pearson must not drop; levelBias must stay ~0.`);
process.exit(0);
