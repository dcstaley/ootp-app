// PHASE-1c STEP 3 — CONTEXT-INVARIANCE + early-exit. With the adopted form (pit = rawquad-all+aux,
// hit = RAWPOLY_HIT), score the ladder in the BASE frame (NO transform) and measure deconvolved value
// spread-ratio per dataset. Compare to the in-frame reference (pit ~0.78, hit ~0.97, §11.26/11.28).
//   - out-of-frame ≈ in-frame within CIs across the ladder → SHIP FORM-ONLY, skip Hyp-1. End-state:
//     raw model + form + anchor, NO transforms.
//   - out-of-frame < in-frame (pool-conditioned residual survives) → Hyp-1, sized to the residual.
// Deployed form shown for contrast (its in-frame ~0.62, so its out-of-frame drop is the status quo).
//   run: node tools/context-invariance.ts
import { readFileSync, existsSync } from "node:fs";
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { resolveCoeffs, type Model } from "../src/config/coeff-resolve.ts";
import type { Era, Park, Tournament } from "../src/config/tournament.ts";
import { applyWobaWeights } from "../src/scoring-core/index.ts";
import { loadTournamentOutcomes, tournamentExposure, tournamentCardValues, type TournamentObs, type CardValues } from "../src/training/tournament-eval.ts";
import { wobaWeightsFromCoeffs } from "../src/scoring-core/woba-weights.ts";
import { loadWindow, type TrainObs } from "../src/training/loader.ts";
import { fitHitForm, fitPitForm, RAWPOLY_HIT } from "../src/training/forms.ts";
import type { EventForm } from "../src/model/curves.ts";
import { cleanTournamentRows } from "../src/eval/tournament-clean.ts";

const R2 = { kind: "rawpoly", degree: 2 } as const;
const TH = 100;
const repo = new Repository("data");
await seedDefaults(repo); await seedEras(repo); await seedAccounts(repo);
const state: any = (await repo.load<any>("state", "app")) ?? {};
const model = (await repo.loadAll<Model>("models"))[0]!;
const eras = new Map((await repo.loadAll<Era>("eras")).map((e) => [e.id, e]));
const parks = new Map((await repo.loadAll<Park>("parks")).map((p) => [p.id, p]));
const trained = (await repo.loadAll<any>("trained-models")).find((x) => x.id === state.activeModelId);
const win: number[] = Array.isArray(trained.window) && trained.window.length ? trained.window : [];
const lgObs = loadWindow("League Files", win.length ? win : undefined).observations.filter((o: TrainObs) => (trained.includeVariants ?? true) || !o.variant);

// Adopted form: hit RAWPOLY_HIT (log holds), pit rawquad-all + aux (§11.27/11.28).
const winnerForm: EventForm = { hit: fitHitForm(RAWPOLY_HIT, lgObs), pit: fitPitForm({ name: "rawquad+aux", bb: R2, k: R2, hr: R2, h: R2, stuffAug: true } as any, lgObs) };

const wvar = (x: number[], wt: number[]) => { const sw = wt.reduce((a, b) => a + b, 0); const m = x.reduce((a, v, i) => a + wt[i]! * v, 0) / sw; return x.reduce((a, v, i) => a + wt[i]! * (v - m) ** 2, 0) / sw; };
const wmean = (x: number[], wt: number[]) => { const sw = wt.reduce((a, b) => a + b, 0); return x.reduce((a, v, i) => a + wt[i]! * v, 0) / sw; };
const ratio = (cv: CardValues, se: number[]) => { const sPred = Math.sqrt(wvar(cv.pred, cv.w)); const sTrue = Math.sqrt(Math.max(wvar(cv.real, cv.w) - wmean(se.map((s) => s * s), cv.w), 1e-9)); return sPred / sTrue; };
function boot(cv: CardValues, se: number[]) { const pt = ratio(cv, se); const n = cv.pred.length, bs: number[] = []; for (let b = 0; b < 400; b++) { const idx = Array.from({ length: n }, () => Math.floor(Math.random() * n)); bs.push(ratio({ pred: idx.map((i) => cv.pred[i]!), real: idx.map((i) => cv.real[i]!), w: idx.map((i) => cv.w[i]!) }, idx.map((i) => se[i]!))); } bs.sort((a, b) => a - b); return { pt, lo: bs[10]!, hi: bs[389]! }; }
const f = (n: number) => (Number.isFinite(n) ? n.toFixed(2) : "n/a");

console.log(`CONTEXT-INVARIANCE (Step 3) — adopted form, BASE frame (no transform), deconvolved value spread ± CI.`);
console.log(`In-frame reference: pit ~0.78, hit ~0.97.  If ladder ≈ that → form-only ship (no transforms).\n`);
console.log(`dataset      HIT spread [CI]          PIT spread [CI]`);
for (const [name, dir, TID] of [
  ["Open", "Tournament Data/Quicks - Open", "default-neutral"],
  ["Bronze-q", "Tournament Data/Quicks - Bronze", "bronze-quick"],
  ["Gold-q", "Tournament Data/Quicks - Gold", "gold-quick"],
  ["EG-clean", "Tournament Data/Early Gold", "early-gold"],
  ["Bronze-t", "Tournament Data/Return of the Bronze", "bronze-return"],
] as const) {
  if (!existsSync(dir)) continue;
  const t = (await repo.loadAll<Tournament>("tournaments")).find((x) => x.id === TID)!;
  const coeffs = resolveCoeffs(model, eras.get(t.eraId)!, parks.get(t.parkId)!, t.softcaps);
  if (trained.wobaWeights) applyWobaWeights(coeffs, trained.wobaWeights);
  const ww = wobaWeightsFromCoeffs(coeffs);
  const seR = (a: any, d: number) => { const t2: [number, number][] = [[ww.bb, a.uBB / 600], [ww.b1, (a.HmHR - (a.XBH ?? 0)) / 600], [ww.xbh, (a.XBH ?? 0) / 600], [ww.hr, a.HR / 600]]; const E = t2.reduce((s, [w2, p]) => s + w2 * p, 0), E2 = t2.reduce((s, [w2, p]) => s + w2 * w2 * p, 0); return d > 0 ? Math.sqrt(Math.max(E2 - E * E, 0) / d) : 0; };
  const obs = loadTournamentOutcomes(dir, { clean: (rows) => cleanTournamentRows(rows).cleaned });
  const exposure = tournamentExposure(obs);
  const cv = tournamentCardValues(obs, { coeffs, eventForm: winnerForm }, exposure, { minPA: TH, minBF: TH }); // BASE frame
  const seHit = obs.filter((o: TournamentObs) => o.pa >= TH).map((o) => seR(o.actual.hit, o.pa));
  const sePit = obs.filter((o: TournamentObs) => o.bf >= TH).map((o) => seR(o.actual.pit, o.bf));
  const h = boot(cv.hit, seHit), p = boot(cv.pit, sePit);
  console.log(`${name.padEnd(11)} ${f(h.pt)} [${f(h.lo)},${f(h.hi)}]  N=${cv.hit.pred.length}    ${f(p.pt)} [${f(p.lo)},${f(p.hi)}]  N=${cv.pit.pred.length}`);
}
console.log(`\nRead per role: is the ladder spread ≈ the in-frame reference within CIs? PIT below ~0.78 = pool-conditioned`);
console.log(`residual survives the form fix → Hyp-1 sized to it. PIT ≈0.78 across ladder → form-only, skip Hyp-1, sunset transforms.`);
process.exit(0);
