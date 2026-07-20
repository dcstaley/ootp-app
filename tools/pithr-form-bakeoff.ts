// PIT.HR FORM BAKE-OFF (2026-07-21) — window [2042,2043], the guard-blocked quad vs its two remedies.
// MEASUREMENT ONLY: no production form specs change; artifacts built here are installed only
// transiently (backup/restore around the run) and never left active.
//
// Candidates (all PARETO_PIT except the hr channel):
//   A' = PARETO_PIT as-is (hr: rawpoly-2). On [2042,2043] the quad vertex lands at z=2.50 inside
//        the fit domain [.., 2.65] → the deploy-time vertex gate (inDomainVertex) FIRES. Built here
//        with the guard BYPASSED for measurement, so B/C have a fixed-window pure-form contrast.
//   B  = HRLOG: hr → LOG (the guard's named remedy).
//   C  = HRCQ: vertex-constrained quad. If the unconstrained vertex z* is INSIDE the fit domain,
//        refit the one-parameter family HR(z) = c0 + c2·(z − zpin)² (+ Stuff aux), zpin = uMax,
//        c2 ≥ 0 — an upward parabola with its vertex pinned AT the domain edge, hence monotone
//        DECREASING over z ≤ zmax (HR falls as the rating rises). Repackaged as a standard
//        rawpoly-2 FittedEvent (beta0 = c0 + c2·zpin², beta1 = −2·c2·zpin, beta2 = c2) so every
//        downstream evaluator (rate/rateAux/tangent extension/guard) works unchanged; the vertex
//        sits exactly at uMax ⇒ inDomainVertex (strict interior test) passes. When the
//        unconstrained vertex is OUTSIDE the domain the constraint is inactive and the fit is the
//        unconstrained PARETO_PIT fit exactly (verified below on [2041,2042]).
//        2026-07-21 RULING: candidate C SHIPPED as the production vertex-pin fallback. The
//        constrained-fit math now lives in src/training/forms.ts (pinQuadAtDomainMax /
//        pinHQuadAtDomainMax, generic across all quad channels) and fitPitFormHRCQ below is a
//        thin wrapper over the production path — this tool holds NO second copy of it.
//
// Subcommands:
//   node tools/pithr-form-bakeoff.ts fit                 → in-frame three-way table + elite-tail
//   node tools/pithr-form-bakeoff.ts build <A|B|C> <out> → full trained artifact (mirrors
//        server.saveTrainedModel assembly: coefficients + eventForm + envelope + trainingMeans +
//        platoon + wobaWeights), written to <out> as JSON. Never through the HTTP API.

import { writeFileSync, readFileSync } from "node:fs";
import { loadWindow, type TrainObs, type LoadedTraining } from "../src/training/loader.ts";
import {
  fitPitForm, fitHitForm, pitFormModel, predictPitForm, PARETO_PIT, RAWPOLY_HIT,
  type PitForm, type FittedPit, type FittedHit, type VertexPin,
} from "../src/training/forms.ts";
import { HITTER, PITCHER } from "../src/training/bakeoff.ts";
import { inSample, crossValidate } from "../src/training/evaluate.ts";
import { evalMetrics } from "../src/training/metrics.ts";
import { predictHitWoba, predictPitWoba, actualHitWoba, actualPitWoba } from "../src/training/bakeoff.ts";
import { trainWobaHitting, trainWobaPitching, trainBasicHitting, trainBasicPitching } from "../src/training/fit.ts";
import {
  inDomainVertex, rateAux, rateRaw, LOG,
  formVertexOffenders, type Curve, type FittedEvent, type EventForm,
} from "../src/model/curves.ts";
import { computePlatoon } from "../src/training/platoon.ts";
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { resolveCoeffs, type Model } from "../src/config/coeff-resolve.ts";
import type { Era, Park, Tournament } from "../src/config/tournament.ts";
import {
  makeRawPolyModel, computeUnifiedFieldStats, applyWobaWeights,
  type RatingEnvelope, type TrainingMeans,
} from "../src/scoring-core/index.ts";
import { parseCatalogCsv } from "../src/data/catalog.ts";
import { isPit, n_, cardName, FIELD_N } from "../src/eval/cwhit/sample.ts";

const ROOT = "League Files";
const WINDOW = [2042, 2043];
const MINPA = 1000;
const Q2: Curve = { kind: "rawpoly", degree: 2 };
const HRLOG_PIT: PitForm = { name: "woba·pareto-hrlog", bb: LOG, k: Q2, hr: LOG, h: Q2, stuffAug: true };
const f = (x: number, d = 4) => (Number.isFinite(x) ? x.toFixed(d) : "n/a");
const sd = (xs: number[]) => { const m = xs.reduce((s, x) => s + x, 0) / xs.length; return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / xs.length); };

// ── Candidate C: vertex-pinned quad — NOW THE PRODUCTION FALLBACK ───────────────
// 2026-07-21 ruling: the constrained-fit math moved INTO production (src/training/forms.ts
// pinQuadAtDomainMax/pinHQuadAtDomainMax, applied per quad channel by fitPitForm/fitHitForm
// when a `pins` collector is passed — exactly what server.saveTrainedModel now does). This
// wrapper IS that path; the tool keeps no second copy of the constrained fit. When no vertex
// is in-domain the pins stay empty and the fit is bit-identical to the unconstrained PARETO_PIT
// fit (verified below on [2041,2042]).
export function fitPitFormHRCQ(obs: TrainObs[], fitExp = 0.75): FittedPit {
  const pins: VertexPin[] = []; // collector arms the production pin; contents not needed here
  return fitPitForm(PARETO_PIT, obs, fitExp, pins);
}
const HRCQ_MODEL = { name: "woba·pareto-hrcq", role: "pitcher" as const, fit: (t: TrainObs[]) => fitPitFormHRCQ(t), predict: (p: unknown, test: TrainObs[]) => test.map((o) => predictPitForm(p as FittedPit, o)) };

// ── shared fit context ───────────────────────────────────────────────────────
function fitAll(loaded: LoadedTraining) {
  const obs = loaded.observations; // includeVariants=true (trainer default)
  const pitQual = obs.filter((o) => PITCHER.qualifies(o, MINPA));
  return {
    obs, pitQual,
    A: fitPitForm(PARETO_PIT, pitQual),
    B: fitPitForm(HRLOG_PIT, pitQual),
    C: fitPitFormHRCQ(pitQual),
  };
}

// ═══ subcommand: fit — the in-frame three-way + verifications + elite tail ═════
if (process.argv[2] === "fit") {
  const loaded = loadWindow(ROOT, WINDOW);
  const { obs, pitQual, A, B, C } = fitAll(loaded);
  console.log(`window [${WINDOW}] pitQual n=${pitQual.length} (minBF=${MINPA}, variants included)`);

  // Verification 1: constrained fit reduces to the unconstrained one when the constraint is inactive.
  {
    const l0 = loadWindow(ROOT, [2041, 2042]);
    const q0 = l0.observations.filter((o) => PITCHER.qualifies(o, MINPA));
    const a0 = fitPitForm(PARETO_PIT, q0), c0 = fitPitFormHRCQ(q0);
    const same = JSON.stringify(a0.hr) === JSON.stringify(c0.hr) && JSON.stringify(a0.h) === JSON.stringify(c0.h);
    console.log(`VERIFY inactive-constraint reduction on [2041,2042] (vertex ${inDomainVertex(a0.hr) == null ? "OUTSIDE domain" : "INSIDE domain!?"}): HRCQ === unconstrained → ${same ? "PASS (bit-identical)" : "FAIL"}`);
  }
  // Verification 2: guard predicate on each candidate's hr.
  const vz = (e: FittedEvent) => inDomainVertex(e);
  console.log(`GUARD (inDomainVertex on pit.hr): A' vertex z=${f(vz(A.hr) ?? NaN, 3)} → ${vz(A.hr) != null ? "FIRES (blocked in production; bypassed here for measurement)" : "passes"}`);
  console.log(`                                 B  (log) → ${vz(B.hr) == null ? "passes" : "FIRES"};  C (pinned quad, b=[${C.hr.beta.map((b) => f(b, 4)).join(", ")}], vertex z=${f(-(C.hr.beta[1] ?? 0) / (2 * (C.hr.beta[2] ?? 1e-12)), 3)} = uMax ${f(C.hr.uMax!, 3)}) → ${vz(C.hr) == null ? "passes" : "FIRES"}`);
  // Any OTHER pit channel offenders per candidate (k / h quads can in principle turn over too).
  for (const [nm, m] of [["A'", A], ["B", B], ["C", C]] as const) {
    const off: string[] = [];
    if (inDomainVertex(m.k) != null) off.push(`pit.k z=${f(inDomainVertex(m.k)!, 2)}`);
    if (inDomainVertex(m.bb) != null) off.push(`pit.bb z=${f(inDomainVertex(m.bb)!, 2)}`);
    const hb1 = m.h.beta[1] ?? 0, hb2 = m.h.beta[2] ?? 0, hv = Math.abs(hb2) < 1e-12 ? null : -hb1 / (2 * hb2);
    if (hv != null && m.h.rating.uMin != null && hv > m.h.rating.uMin && hv < m.h.rating.uMax!) off.push(`pit.h z=${f(hv, 2)}`);
    if (off.length) console.log(`  NOTE ${nm}: other in-domain vertices: ${off.join(", ")}`);
  }

  // In-sample + CV (the diag's exact harness), per candidate.
  console.log(`\n=== IN-FRAME THREE-WAY [${WINDOW}] ===`);
  console.log(`cand   in-sample wP/spear     cv wP/spear         HRch SD/600 (rateAux)   composite wOBAA SD`);
  const models = [["A' quad", pitFormModel(PARETO_PIT), A], ["B hrlog", pitFormModel(HRLOG_PIT), B], ["C hrcq ", HRCQ_MODEL, C]] as const;
  for (const [nm, mdl, fit] of models) {
    const is = inSample(obs, mdl, PITCHER, { minN: MINPA });
    const cv = crossValidate(obs, mdl, PITCHER, { minN: MINPA });
    const hrPred = pitQual.map((o) => rateAux(fit.hr, o.ratings.pitch.hrr, o.ratings.pitch.stu));
    const wPred = pitQual.map((o) => predictPitForm(fit, o));
    console.log(`${nm}  ${f(is.pearson)}/${f(is.spearman)}      ${f(cv.pearson)}/${f(cv.spearman)}     ${f(sd(hrPred), 3)}                   ${f(sd(wPred), 4)}`);
  }

  // Elite tail: top-10 catalog (cdmx) pitchers by pHR vR — predicted HR/600 per candidate.
  console.log(`\n=== ELITE TAIL — top 10 cdmx pitchers by pHR vR, raw ratings → hr channel (per 600 BF) ===`);
  const cards = parseCatalogCsv(readFileSync("data/imports/cdmx.csv", "utf8")).cards.filter((c) => String(c["Variant"] ?? "").toUpperCase() !== "Y" && isPit(c));
  const rowsE = cards.map((c) => ({ name: cardName(c), val: n_(c["Card Value"]), hrr: n_(c["pHR vR"]), stu: n_(c["Stuff vR"]) }))
    .filter((r) => r.hrr > 0).sort((a, b) => b.hrr - a.hrr).slice(0, 10);
  const zA = (r: number) => (r - A.hr.mu) / A.hr.sd;
  console.log(`name                        VAL  pHRvR  z(A')   A'cap    A'raw    B(log)   C(hrcq)`);
  for (const r of rowsE) {
    console.log(`${r.name.padEnd(27)} ${String(r.val).padStart(3)}  ${String(r.hrr).padStart(5)}  ${f(zA(r.hrr), 2).padStart(5)}  ${f(rateAux(A.hr, r.hrr, r.stu), 2).padStart(6)}  ${f(rateRaw(A.hr, r.hrr), 2).padStart(6)}  ${f(rateAux(B.hr, r.hrr, r.stu), 2).padStart(6)}  ${f(rateAux(C.hr, r.hrr, r.stu), 2).padStart(6)}`);
  }
  console.log(`(A'cap = deployed eval: monotone cap + tangent extension + Stuff aux; A'raw = uncapped quad, no aux — the shape itself.)`);
  process.exit(0);
}

// ═══ subcommand: build <A|B|C> <outfile> — full artifact, saveTrainedModel mirror ═
if (process.argv[2] === "build") {
  const cand = process.argv[3] as "A" | "B" | "C";
  const out = process.argv[4];
  if (!["A", "B", "C"].includes(cand) || !out) throw new Error("usage: build <A|B|C> <outfile>");
  const loaded = loadWindow(ROOT, WINDOW);
  const obs = loaded.observations;
  const hitQual = obs.filter((o) => HITTER.qualifies(o, MINPA));
  const pitQual = obs.filter((o) => PITCHER.qualifies(o, MINPA));
  const pit: FittedPit = cand === "A" ? fitPitForm(PARETO_PIT, pitQual) : cand === "B" ? fitPitForm(HRLOG_PIT, pitQual) : fitPitFormHRCQ(pitQual);
  const hit: FittedHit = fitHitForm(RAWPOLY_HIT, hitQual);
  const eventForm: EventForm = { hit, pit };
  const vertexOffenders = formVertexOffenders(eventForm);
  if (cand !== "A" && vertexOffenders.length) throw new Error(`candidate ${cand} has vertex offenders: ${JSON.stringify(vertexOffenders)} — expected clean`);
  // legacy log-linear coefficient sets (kept on the artifact exactly as saveTrainedModel does)
  const wh = trainWobaHitting(obs, MINPA), wp = trainWobaPitching(obs, MINPA);
  const bh = trainBasicHitting(obs, MINPA), bp = trainBasicPitching(obs, MINPA);
  const maxOf = (rows: TrainObs[], get: (o: TrainObs) => number) => rows.reduce((m, o) => Math.max(m, get(o)), 0);
  const ratingEnvelope: RatingEnvelope = {
    hit: { eye: maxOf(hitQual, (o) => o.ratings.hit.eye), pow: maxOf(hitQual, (o) => o.ratings.hit.pow), kRat: maxOf(hitQual, (o) => o.ratings.hit.kRat), babip: maxOf(hitQual, (o) => o.ratings.hit.babip), gap: maxOf(hitQual, (o) => o.ratings.hit.gap) },
    pit: { con: maxOf(pitQual, (o) => o.ratings.pitch.con), stu: maxOf(pitQual, (o) => o.ratings.pitch.stu), pbabip: maxOf(pitQual, (o) => o.ratings.pitch.pbabip), hrr: maxOf(pitQual, (o) => o.ratings.pitch.hrr) },
  };
  // trainingMeans — matched-legs top-50 field of the training league (saveTrainedModel's exact recipe)
  const repo = new Repository("data");
  await seedDefaults(repo); await seedEras(repo); await seedAccounts(repo);
  const tmScoringModel = (await repo.loadAll<Model>("models"))[0]!;
  const eras = new Map((await repo.loadAll<Era>("eras")).map((e) => [e.id, e]));
  const tournaments = await repo.loadAll<Tournament>("tournaments");
  const tmCoeffs = resolveCoeffs(tmScoringModel, eras.get("era-2010")!,
    { id: "neutral", name: "neutral", avg_l: 1, avg_r: 1, hr_l: 1, hr_r: 1, gap: 1 } as Park, tournaments[0]!.softcaps);
  applyWobaWeights(tmCoeffs, loaded.wobaWeights);
  const tmModel = makeRawPolyModel(eventForm);
  const tmCards = new Map<string, Record<string, unknown>>();
  for (const o of obs) {
    const key = `${o.cid}|${o.variant ? "V" : "B"}`;
    let c = tmCards.get(key);
    if (!c) { c = { maxPA: 0, maxBF: 0, Bats: o.bats, Throws: o.throws, Speed: o.ratings.hit.speed, Stealing: o.ratings.hit.steal, Baserunning: o.ratings.hit.run }; tmCards.set(key, c); }
    const s = o.side;
    c[`Eye v${s}`] = o.ratings.hit.eye; c[`Power v${s}`] = o.ratings.hit.pow; c[`Avoid K v${s}`] = o.ratings.hit.kRat; c[`BABIP v${s}`] = o.ratings.hit.babip; c[`Gap v${s}`] = o.ratings.hit.gap;
    c[`Control v${s}`] = o.ratings.pitch.con; c[`Stuff v${s}`] = o.ratings.pitch.stu; c[`pBABIP v${s}`] = o.ratings.pitch.pbabip; c[`pHR v${s}`] = o.ratings.pitch.hrr;
    c.maxPA = Math.max(c.maxPA as number, o.hit.PA); c.maxBF = Math.max(c.maxBF as number, o.pitch.BF);
  }
  const tmAll = [...tmCards.values()].filter((c) => c["Eye vR"] != null && c["Eye vL"] != null && c["Control vR"] != null && c["Control vL"] != null);
  const tmFieldHit = computeUnifiedFieldStats(tmAll.filter((c) => (c.maxPA as number) >= MINPA), tmCoeffs, tmModel, FIELD_N, true);
  const tmFieldPit = computeUnifiedFieldStats(tmAll.filter((c) => (c.maxBF as number) >= MINPA), tmCoeffs, tmModel, FIELD_N, true);
  const mu = (fs: Record<string, { mu: number } | undefined>, k: string): number | undefined => fs[k]?.mu;
  const tmHit = { eye: mu(tmFieldHit.hit.vR, "eye"), pow: mu(tmFieldHit.hit.vR, "pow"), kRat: mu(tmFieldHit.hit.vR, "kRat"), babip: mu(tmFieldHit.hit.vR, "babip"), gap: mu(tmFieldHit.hit.vR, "gap") };
  const tmPit = { con: mu(tmFieldPit.pit.vR, "con"), stu: mu(tmFieldPit.pit.vR, "stu"), pbabip: mu(tmFieldPit.pit.vR, "pbabip"), hrr: mu(tmFieldPit.pit.vR, "hrr") };
  if (![...Object.values(tmHit), ...Object.values(tmPit)].every((x) => Number.isFinite(x))) throw new Error("trainingMeans incomplete");
  const trainingMeans: TrainingMeans = { hit: tmHit as TrainingMeans["hit"], pit: tmPit as TrainingMeans["pit"] };
  const platoon = { ...computePlatoon(obs), pitchRoleSplits: loaded.pitchRoleSplits };
  const ids = { A: "bakeoff-aq-4243", B: "bakeoff-hrlog-4243", C: "bakeoff-hrcq-4243" } as const;
  const artifact = {
    id: ids[cand], name: `BAKEOFF ${cand} 42+43 (transient)`, datasetRoot: ROOT, window: WINDOW, minPA: MINPA, includeVariants: true,
    formatVersion: 4,
    validation: { errors: 0, warnings: 0, excluded: loaded.summary.excludedCells ?? [], forced: false },
    vertexGate: { ok: vertexOffenders.length === 0, forced: vertexOffenders.length > 0, offenders: vertexOffenders },
    coefficients: { woba_hitting: wh.coefficients, woba_pitching: wp.coefficients, basic_hitting: bh.coefficients, basic_pitching: bp.coefficients },
    eventForm, platoon, wobaWeights: loaded.wobaWeights, ratingEnvelope, trainingMeans,
    diag: {
      hitPearson: evalMetrics(hitQual.map((o) => predictHitWoba(wh.coefficients, o)), hitQual.map(actualHitWoba), hitQual.map(HITTER.weight), true).pearson,
      pitPearson: evalMetrics(pitQual.map((o) => predictPitWoba(wp.coefficients, o)), pitQual.map(actualPitWoba), pitQual.map(PITCHER.weight), false).pearson,
      rowsHit: wh.rowCount, rowsPit: wp.rowCount,
    },
    trainedAt: new Date().toISOString(),
    notes: `pithr form bake-off 2026-07-21 — MEASUREMENT ONLY, never leave active. Candidate ${cand}${cand === "A" ? " (guard-bypassed quad)" : ""}.`,
  };
  writeFileSync(out, JSON.stringify(artifact, null, 2));
  console.log(`built ${ids[cand]} → ${out}  (pit.hr curve=${JSON.stringify(pit.hr.curve)}, offenders=${JSON.stringify(vertexOffenders)})`);
  process.exit(0);
}

console.error("usage: node tools/pithr-form-bakeoff.ts fit | build <A|B|C> <outfile>");
process.exit(1);
