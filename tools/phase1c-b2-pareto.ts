// VERIFICATION DEBT B.2 — channel-subset PARETO under quad. B.1 showed the all-quad WINNER FAILS the
// monotone gate on pitcher BB (rawquad BB turns over in-domain, uncapped) while beating deployed on
// ordering. So: which channels MUST be quad to reach the ~0.78 in-frame spread, and can a partial flip
// keep most of it with FEWER quad tails (less extrapolation surface, cleaner gate)? For each subset we
// report the axis the quad BUYS (in-frame deconvolved pit value spread), the axis it RISKS (OOT ordering:
// CV + OOT-down Spearman/valueRegret), and the gate (which channels turn over). aux (StuffAug) is ON
// throughout (B.1: aux-ON dominates aux-OFF); log on the non-flipped channels.
//   run: node tools/phase1c-b2-pareto.ts
import { readFileSync, existsSync } from "node:fs";
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { resolveCoeffs, type Model } from "../src/config/coeff-resolve.ts";
import type { Era, Park, Tournament } from "../src/config/tournament.ts";
import { applyWobaWeights, makeRawPolyModel, computeDerived } from "../src/scoring-core/index.ts";
import { pitchingComponents } from "../src/scoring-core/woba.ts";
import { wobaWeightsFromCoeffs } from "../src/scoring-core/woba-weights.ts";
import { loadWindow, availableYears, type TrainObs } from "../src/training/loader.ts";
import { PITCHER } from "../src/training/bakeoff.ts";
import { fitPitForm, pitFormModel, gatePit, STUFFAUG_PIT, type PitForm } from "../src/training/forms.ts";
import { crossValidate, outOfTime } from "../src/training/evaluate.ts";
import type { EventForm, FittedHit } from "../src/model/curves.ts";

const R2 = { kind: "rawpoly", degree: 2 } as const, LOGc = { kind: "log" } as const;
const MINN = 1000;
const repo = new Repository("data");
await seedDefaults(repo); await seedEras(repo); await seedAccounts(repo);
const state: any = (await repo.load<any>("state", "app")) ?? {};
const model = (await repo.loadAll<Model>("models"))[0]!;
const eras = new Map((await repo.loadAll<Era>("eras")).map((e) => [e.id, e]));
const parks = new Map((await repo.loadAll<Park>("parks")).map((p) => [p.id, p]));
const trained = (await repo.loadAll<any>("trained-models")).find((x) => x.id === state.activeModelId);
const win: number[] = Array.isArray(trained.window) && trained.window.length ? trained.window : [2041, 2042];
const lgObs = loadWindow("League Files", win).observations.filter((o: TrainObs) => (trained.includeVariants ?? true) || !o.variant);
const lgPit = lgObs.filter((o) => PITCHER.qualifies(o, MINN));
const years = availableYears("League Files");
const oldY = [2032, 2033];
const oldObs = oldY.every((y) => years.includes(y)) ? loadWindow("League Files", oldY).observations : [];
const neut = (await repo.loadAll<Tournament>("tournaments")).find((x) => x.id === "default-neutral")!;
const coeffs = resolveCoeffs(model, eras.get(neut.eraId)!, parks.get(neut.parkId)!, neut.softcaps);
if (trained.wobaWeights) applyWobaWeights(coeffs, trained.wobaWeights);
const derived = computeDerived(coeffs, true);
const w = wobaWeightsFromCoeffs(coeffs);
const HIT = trained.eventForm.hit as FittedHit;

const per600 = (x: number, d: number) => (d > 0 ? (x * 600) / d : 0);
const wvar = (x: number[], wt: number[]) => { const sw = wt.reduce((a, b) => a + b, 0); const m = x.reduce((a, v, i) => a + wt[i]! * v, 0) / sw; return x.reduce((a, v, i) => a + wt[i]! * (v - m) ** 2, 0) / sw; };
const wmean = (x: number[], wt: number[]) => { const sw = wt.reduce((a, b) => a + b, 0); return x.reduce((a, v, i) => a + wt[i]! * v, 0) / sw; };
const seW = (uBB: number, HmHR: number, HR: number, XBH: number, d: number) => { const t: [number, number][] = [[w.bb, uBB / 600], [w.b1, (HmHR - XBH) / 600], [w.xbh, XBH / 600], [w.hr, HR / 600]]; const E = t.reduce((a, [ww, p]) => a + ww * p, 0), E2 = t.reduce((a, [ww, p]) => a + ww * ww * p, 0); return d > 0 ? Math.sqrt(Math.max(E2 - E * E, 0) / d) : 0; };

function inframeSpread(pf: PitForm) {
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
  return Math.sqrt(wvar(pred, wt)) / Math.sqrt(Math.max(wvar(real, wt) - wmean(se.map((s) => s * s), wt), 1e-9));
}

// Subsets of {bb,k,hr,h} flipped to raw-quad(2); the rest stay LOG; aux (StuffAug) ON throughout.
const base: PitForm = { ...(STUFFAUG_PIT as PitForm), bb: LOGc, k: LOGc, hr: LOGc, h: LOGc, stuffAug: true };
const mk = (name: string, flip: Partial<Record<"bb" | "k" | "hr" | "h", true>>): PitForm =>
  ({ ...base, name, bb: flip.bb ? R2 : LOGc, k: flip.k ? R2 : LOGc, hr: flip.hr ? R2 : LOGc, h: flip.h ? R2 : LOGc });

const SUBSETS: PitForm[] = [
  mk("deployed {} (all log+aux)", {}),
  mk("{HR}", { hr: true }),
  mk("{HR,K}", { hr: true, k: true }),
  mk("{HR,K,H} (drop BB)", { hr: true, k: true, h: true }),   // BB stays log — the B.1 gate offender
  mk("{HR,K,BB}", { hr: true, k: true, bb: true }),
  mk("{all} = WINNER", { hr: true, k: true, bb: true, h: true }),
];

const f = (n: number) => (Number.isFinite(n) ? n.toFixed(3) : " n/a ");
console.log(`B.2 PARETO — pitcher quad channel subsets (aux ON, log elsewhere). in-frame N=${lgPit.length}, ceiling ~0.78.`);
console.log(`SPREAD = axis-2 the quad buys (in-frame deconvolved value spread). CV/OOT = axis-1 ordering it risks.`);
console.log(`GATE flags which quad channel turns over (uncapped) — extrapolation surface.\n`);
console.log(`subset                          spread | CV: r    ρ     regret | OOTdn: r    ρ     regret | gate`);
for (const pf of SUBSETS) {
  const spread = inframeSpread(pf);
  const mdl = pitFormModel(pf);
  const cv = crossValidate(lgObs, mdl, PITCHER, { minN: MINN, topN: 26, k: 5 });
  const oot = oldObs.length ? outOfTime(lgObs, oldObs, mdl, PITCHER, { minN: MINN, topN: 26 }) : null;
  const g = gatePit(mdl.fit(lgPit, []) as any, lgPit);
  const gate = g.status === "pass" ? "pass" : g.notes.map((n) => n.replace(" curve", "").replace(" in-domain", "")).join(",");
  console.log(`${pf.name.padEnd(30)} ${f(spread)} | ${f(cv.pearson)} ${f(cv.spearman)} ${f(cv.valueRegret)} | ${oot ? `${f(oot.pearson)} ${f(oot.spearman)} ${f(oot.valueRegret)}` : "   —"} | ${gate}`);
}
console.log(`\nRead: the smallest subset whose spread ≈ 0.78 with a CLEAN gate and CV/OOT ordering ≥ deployed is the`);
console.log(`pareto pick. If {HR,K,H} (BB log) keeps the spread AND passes the gate, it beats the all-quad winner.`);
process.exit(0);
