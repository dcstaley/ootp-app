// Bake-off PARITY + full-field scoreboard (2026-07-25).
//
// WHY: the bake-off harness had never scored what production ships. Two defects, both
// verified before this run:
//   (1) PINNING. server.saveTrainedModel fits fitHitForm(RAWPOLY_HIT, …, 0.75, vertexPinned)
//       and fitPitForm(PARETO_PIT, …, 0.75, vertexPinned) — always with a pin collector — while
//       the harness wrappers hitFormModel/pitFormModel called fitHitForm(form, train) with
//       `pins` undefined, so every candidate was fitted UNPINNED.
//   (2) CANDIDATE SET. FORM_ENTRIES carried RAWPOLY_PIT, not the deployed PARETO_PIT (switched
//       2026-07-14, after the bake-off); STUFFAUG_PIT and SATBB_PIT were absent too.
// Both are now fixed in src/training/forms.ts. This tool runs the resulting field and answers:
//   Q1 does the deployed configuration (RAWPOLY_HIT + PARETO_PIT, pinned) actually win?
//   Q2 does `stuffAug` (the linear ln(Stuff) aux on pitcher BB and HR) earn its place?
//
// DATA: root 'League Files', league seasons 2037–2043 ONLY. `League Files/Old Data` (2032–33)
// sits after a four-season gap and is EXCLUDED (never pooled) via the new EvalOpts.years.
//
// UNCERTAINTY: distinct CARDS ≪ rows and a card's residual is near-fixed given its ratings, so
// every interval here is a CLUSTER bootstrap over cid (row-level resampling ran ~3.1× too narrow
// on this data). Models are fit once per (train, test) pair; the bootstrap resamples the TEST
// clusters only, so intervals cover test-sampling uncertainty, not train-side refit uncertainty.

import { writeFileSync } from "node:fs";
import { loadWindow, availableYears, type TrainObs } from "../src/training/loader.ts";
import { buildScoreboard, foldOf, cvFoldKey } from "../src/training/evaluate.ts";
import { HITTER, PITCHER, type RoleSpec, type BakeoffModel } from "../src/training/bakeoff.ts";
import { inDomainVertex } from "../src/model/curves.ts";
import { validateDataset } from "../src/training/validate.ts";
import { evalMetrics } from "../src/training/metrics.ts";
import {
  fitHitForm, fitPitForm, predictHitForm, predictPitForm, pitFormModel, gatePit,
  RAWPOLY_HIT, RAWPOLY_PIT, PARETO_PIT, PARETO_NOAUG_PIT, STUFFAUG_PIT, SATBB_PIT,
  RAWCUBIC_HIT, RAWLIN_HIT, RAWLIN_PIT, QPOWLIN_HIT, PERBIP_HIT, PERBIP_PIT,
  type VertexPin, type HitForm, type PitForm,
} from "../src/training/forms.ts";

const ROOT = "League Files";
const OUT = "fixtures/bakeoff-parity-scoreboard-2026-07-25.txt";
const MINN = 1000, TOPN = 26, K = 5;
const LEAGUE_YEARS = availableYears(ROOT).filter((y) => y >= 2037);

const lines: string[] = [];
const say = (s = "") => { lines.push(s); console.log(s); };
const f = (x: number, d = 4) => (Number.isFinite(x) ? x.toFixed(d) : "n/a");

// ── header ────────────────────────────────────────────────────────────────────
say("================================================================================");
say("BAKE-OFF PARITY FIX + FULL-FIELD SCOREBOARD — 2026-07-25");
say("tools/bakeoff-parity-scoreboard.ts · root 'League Files' · seasons 2037–2043");
say("================================================================================");
say();
say("§1  THE PARITY FIX");
say("--------------------------------------------------------------------------------");
say("(a) PINNING. src/training/forms.ts:630-636 — hitFormModel/pitFormModel now take a");
say("    `pinned` flag (DEFAULT TRUE) and call fitHitForm(form, train, 0.75, pinned ? [] : undefined)");
say("    / fitPitForm(form, train, 0.75, pinned ? [] : undefined). Production");
say("    (src/server/server.ts:1567) passes a `vertexPinned` collector to both fits, so any");
say("    degree-2 rawpoly channel whose UNCONSTRAINED vertex lands strictly inside the fit domain");
say("    is refit with the vertex pinned at the domain max (pinQuadAtDomainMax).");
say("    The pins are DATA-DEPENDENT — computed per fit by inDomainVertex, never a fixed list —");
say("    so parity means handing every fit its own FRESH collector, exactly as saveTrainedModel");
say("    does. That is what the wrappers now do (a new [] per fit call, including per CV fold).");
say("    The collector is discarded by the harness (nothing downstream reads the provenance);");
say("    §3 reports which channels actually pinned.");
say();
say("(b) CANDIDATES. src/training/forms.ts — added to FORM_ENTRIES: PARETO_PIT (the DEPLOYED");
say("    pitcher form since 2026-07-14, previously not a candidate at all), STUFFAUG_PIT (the");
say("    form it replaced), SATBB_PIT, and a NEW form PARETO_NOAUG_PIT ('woba·pareto-noaug') =");
say("    PARETO_PIT with stuffAug:false, so the aux is a testable candidate instead of baked in.");
say();
say("(c) HARNESS SCOPE. src/training/evaluate.ts — EvalOpts gained an optional `years` filter so a");
say("    run can restrict the year universe (window + both OOT blocks). Omitting it reproduces the");
say("    previous behavior exactly. Used here to keep 'League Files/Old Data' (2032–33) out.");
say();
say("CALLER AUDIT of hitFormModel / pitFormModel (every call site in the repo):");
say("  · src/training/forms.ts:831-832 hitEntry/pitEntry → FORM_ENTRIES → buildScoreboard.");
say("      THE TARGET of the fix. Now pinned = production.");
say("  · src/training/residuals.ts:84,89 (HIT_CFG/PIT_CFG, feeds the live /api/residuals endpoint).");
say("      UNAFFECTED. Pitcher side uses STUFFAUG_PIT, which is all-LOG — pinEvent requires a");
say("      rawpoly-2 channel, so it can never fire. Hitter side uses RAWPOLY_HIT, whose only quad");
say("      is hit.hr; §3 shows its vertex is OUT of domain on every window tested, so the pinned");
say("      and unpinned fits are bit-identical (maxΔpred = 0.00e+0). Verified empirically, not assumed.");
say("      (SEPARATE FINDING, not fixed here: residuals.ts claims to 'track the deployed forms by");
say("      reference' but pins the pitcher role to STUFFAUG_PIT, which stopped being deployed on");
say("      2026-07-14. The live residual endpoint is scoring a retired pitcher form.)");
say("  · tools/pithr-form-bakeoff.ts:122 and tools/diag-pithr-2043.ts:68 — the two archival tools");
say("      whose PURPOSE is to exhibit the unconstrained quad's in-domain vertex (A' unpinned vs C");
say("      pinned). Default pinning would have silently collapsed A' into C. Both now pass");
say("      `pinned=false` explicitly, preserving their published semantics.");
say("  · tools/satbb-bakeoff.ts:56, tools/phase1c-b1-cv.ts:37,51, tools/phase1c-b2-pareto.ts:87 —");
say("      archived one-off measurements, left on the new DEFAULT (pinned). Their committed");
say("      fixtures predate the fix and are not re-derivable byte-for-byte; flagged, not rewritten.");
say("  · tools/tournament-matchupk.ts:60,62 — RAWPOLY_HIT + STUFFAUG_PIT only ⇒ no pin can fire.");
say("  · tests/forms.test.ts:28,36,44,51 — LOG_HIT/LOG_PIT/LOGCUBIC_HIT carry no rawpoly-2");
say("      channel; RAWPOLY_HIT does not pin on the test fixture. Full suite green: 492/492.");
say("      (tests/bakeoff.test.ts's hard-coded field counts were updated for the 4 new pitcher");
say("      entries, and a new assertion now fails the suite if either DEPLOYED form ever drops");
say("      out of FORM_ENTRIES again — the defect this whole exercise exists to prevent.)");
say("  · No scoring-core path imports these wrappers. Production scoring is untouched.");
say();

// ── §2 data + exclusions ──────────────────────────────────────────────────────
const loaded = loadWindow(ROOT, LEAGUE_YEARS);
const val = validateDataset(loaded.summary);
say("§2  DATA AND EXCLUSIONS");
say("--------------------------------------------------------------------------------");
say(`years present under root: ${availableYears(ROOT).join(", ")}`);
say(`years USED: ${LEAGUE_YEARS.join(", ")}   (Old Data 2032–33 excluded — four-season gap, never pooled)`);
const byYear = new Map<number, Set<string>>();
for (const c of loaded.summary.cells) { if (!byYear.has(c.year)) byYear.set(c.year, new Set()); byYear.get(c.year)!.add(c.league); }
const excl = new Set(loaded.summary.excludedCells);
for (const [y, ls] of [...byYear].sort((a, b) => a[0] - b[0])) {
  const kept = [...ls].sort().filter((l) => !excl.has(`${l}|${y}`));
  const dropped = [...ls].sort().filter((l) => excl.has(`${l}|${y}`));
  say(`  ${y}: ${kept.length} league(s) ${kept.join(" ")}${dropped.length ? `   EXCLUDED: ${dropped.join(" ")}` : ""}`);
}
say(`loader auto-exclusions (corrupt cells): ${loaded.summary.excludedCells.length ? loaded.summary.excludedCells.join(", ") : "none"}`);
say(`validateDataset: ${val.errors} error(s), ${val.warnings} warning(s)`);
for (const i of val.issues.filter((x) => x.severity === "error")) say(`  ERROR  ${i.scope}: ${i.message}`);
say("SEASON COVERAGE IS UNEQUAL: 2037 has 4 leagues (no HD452); 2038 and 2040–2043 have 5;");
say("2039 is effectively 4 after the HD450 exclusion. Any cross-season consistency claim below");
say("is qualified by this.");
say();

// ── §3 pin audit ──────────────────────────────────────────────────────────────
const cache = new Map<string, TrainObs[]>();
const obsOf = (ys: number[]) => { const k = ys.join(","); if (!cache.has(k)) cache.set(k, loadWindow(ROOT, ys).observations); return cache.get(k)!; };

const WINDOWS: number[][] = [[2037, 2038], [2040, 2041], [2042, 2043]];
say("§3  PIN AUDIT — which channels the parity fix actually moves");
say("--------------------------------------------------------------------------------");
say("window      role form                 pinned channels          max |Δ predicted wOBA| vs unpinned");
for (const w of WINDOWS) {
  const obs = obsOf(w);
  const hq = obs.filter((o) => HITTER.qualifies(o, MINN)), pq = obs.filter((o) => PITCHER.qualifies(o, MINN));
  const rowH = (fm: HitForm) => {
    const pins: VertexPin[] = [];
    const a = fitHitForm(fm, hq, 0.75, pins), b = fitHitForm(fm, hq, 0.75, undefined);
    const md = Math.max(...hq.map((o) => Math.abs(predictHitForm(a, o) - predictHitForm(b, o))));
    say(`${w.join("+")}   HIT  ${fm.name.padEnd(20)} ${(pins.length ? pins.map((p) => `${p.channel}@z=${p.pinZ.toFixed(3)}`).join(",") : "— none —").padEnd(24)} ${md.toExponential(2)}`);
  };
  const rowP = (fm: PitForm) => {
    const pins: VertexPin[] = [];
    const a = fitPitForm(fm, pq, 0.75, pins), b = fitPitForm(fm, pq, 0.75, undefined);
    const md = Math.max(...pq.map((o) => Math.abs(predictPitForm(a, o) - predictPitForm(b, o))));
    say(`${w.join("+")}   PIT  ${fm.name.padEnd(20)} ${(pins.length ? pins.map((p) => `${p.channel}@z=${p.pinZ.toFixed(3)}`).join(",") : "— none —").padEnd(24)} ${md.toExponential(2)}`);
  };
  rowH(RAWPOLY_HIT);
  for (const fm of [RAWPOLY_PIT, PARETO_PIT, PARETO_NOAUG_PIT, STUFFAUG_PIT, SATBB_PIT]) rowP(fm);
}
say();
say("READ: the pin fires on exactly one channel — pit.hr — and only on the [2042,2043] window,");
say("for the two forms that carry BOTH a quad hr AND the Stuff aux (pareto, satbb). The pinned z");
say("(2.652) MATCHES data/trained-models/league-42-43.json's recorded vertexPinned entry, which is");
say("independent confirmation that the harness now fits the way the live artifact was fitted.");
say("Note the asymmetry: pareto-noaug does NOT pin — removing the aux moves the hr vertex back out");
say("of domain. So the aux A/B is not a pure one-term change on [2042,2043]; both arms are");
say("nonetheless fitted exactly as production would fit them, which is the comparison that matters.");
say();

// ── §4 scoreboards ────────────────────────────────────────────────────────────
const DEPLOYED_HIT = "woba·rawpoly", DEPLOYED_PIT = "woba·pareto";
say("§4  SCOREBOARD — full candidate field, pinned, League Files 2037–2043");
say("--------------------------------------------------------------------------------");
say(`minN=${MINN} (PA/BF)  topN=${TOPN}  k=${K}-fold  includeVariants=true  foldKey=cid|side`);
say("metrics: wPears = weighted Pearson (affine-invariant, blind to level); top26 = fraction of the");
say("model's top-26 that are truly top-26; regret = mean per-slot actual-wOBA shortfall of the");
say("model's top-26 (LOWER is better; this and top26 are the deliverable metrics).");
say("'*' marks the DEPLOYED form for that role (hitting woba·rawpoly, pitching woba·pareto).");
say();

interface Row { model: string; role: string; evaluation: string; window: string; n: number; pearson: number; spearman: number; top: number; regret: number; gapRmse: number; bias: number; gate: string }
const runs: { label: string; window: number[]; rows: Row[] }[] = [];

for (const w of WINDOWS) {
  const t0 = Date.now();
  const sb = buildScoreboard(ROOT, { minN: MINN, topN: TOPN, k: K, window: w, years: LEAGUE_YEARS, includeVariants: true });
  const rows: Row[] = sb.rows.map((r) => ({
    model: r.model, role: r.role, evaluation: r.evaluation, window: r.window, n: r.metrics.n,
    pearson: r.metrics.pearson, spearman: r.metrics.spearman, top: r.metrics.topNOverlap,
    regret: r.metrics.valueRegret, gapRmse: r.metrics.gapRmse, bias: r.metrics.bias,
    gate: r.gate ? `${r.gate.status}${r.gate.notes.length ? ` (${r.gate.notes.join("; ")})` : ""}` : "",
  }));
  runs.push({ label: `train window ${w.join("+")}`, window: w, rows });
  console.error(`[scoreboard ${w.join("+")}] ${((Date.now() - t0) / 1000).toFixed(1)}s, ${rows.length} rows`);
}

const EVALS = ["in-sample", "cv", "forward", "backward"];
for (const run of runs) {
  say("================================================================================");
  say(`RUN — ${run.label}`);
  const wins = new Map<string, string>();
  for (const r of run.rows) wins.set(r.evaluation, r.window);
  for (const e of EVALS) if (wins.has(e)) say(`  ${e.padEnd(10)} ${wins.get(e)}`);
  say("================================================================================");
  for (const role of ["hitter", "pitcher"] as const) {
    for (const e of EVALS) {
      const rs = run.rows.filter((r) => r.role === role && r.evaluation === e);
      if (!rs.length) continue;
      const dep = role === "hitter" ? DEPLOYED_HIT : DEPLOYED_PIT;
      // sort by the deliverable metric first (top26 desc, then regret asc)
      const sorted = [...rs].sort((a, b) => b.top - a.top || a.regret - b.regret);
      say();
      say(`-- ${role.toUpperCase()} · ${e} (n=${rs[0]!.n}) — sorted by top26 desc, then regret asc --`);
      say("     model                 wPears  spear   top26   regret    gapRmse    bias      gate");
      sorted.forEach((r, i) => {
        const mark = r.model === dep ? "*" : " ";
        say(`${String(i + 1).padStart(3)}${mark} ${r.model.padEnd(21)} ${f(r.pearson)}  ${f(r.spearman)}  ${f(r.top)}  ${f(r.regret, 5)}  ${f(r.gapRmse, 5)}  ${(r.bias >= 0 ? "+" : "") + f(r.bias, 5)}  ${r.gate}`);
      });
    }
  }
  say();
}

// ── §5 deployed-vs-field summary ──────────────────────────────────────────────
say("================================================================================");
say("§5  Q1 — DOES THE DEPLOYED CONFIGURATION WIN?");
say("--------------------------------------------------------------------------------");
say("Rank of the deployed form within its role's field, per run × evaluation, on each metric.");
say("(field size in parentheses; rank 1 = best. regret rank is ascending.)");
say();
say("run          role     eval        wPears-rank  top26-rank  regret-rank   top26   regret     leader by top26 / by regret");
for (const run of runs) {
  for (const role of ["hitter", "pitcher"] as const) {
    const dep = role === "hitter" ? DEPLOYED_HIT : DEPLOYED_PIT;
    for (const e of EVALS) {
      const rs = run.rows.filter((r) => r.role === role && r.evaluation === e);
      if (!rs.length) continue;
      const me = rs.find((r) => r.model === dep);
      if (!me) continue;
      const rk = (key: (r: Row) => number, desc: boolean) => {
        const s = [...rs].sort((a, b) => (desc ? key(b) - key(a) : key(a) - key(b)));
        return s.findIndex((r) => r.model === dep) + 1;
      };
      const bestTop = [...rs].sort((a, b) => b.top - a.top || a.regret - b.regret)[0]!;
      const bestReg = [...rs].sort((a, b) => a.regret - b.regret)[0]!;
      say(`${run.window.join("+").padEnd(12)} ${role.padEnd(8)} ${e.padEnd(11)} ${String(rk((r) => r.pearson, true)).padStart(6)}/${rs.length}    ${String(rk((r) => r.top, true)).padStart(5)}/${rs.length}   ${String(rk((r) => r.regret, false)).padStart(5)}/${rs.length}   ${f(me.top)}  ${f(me.regret, 5)}   ${bestTop.model} / ${bestReg.model}`);
    }
  }
}
say();

// ── §6 stuffAug A/B with cluster bootstrap ────────────────────────────────────
say("================================================================================");
say("§6  Q2 — DOES stuffAug EARN ITS PLACE?  (woba·pareto vs woba·pareto-noaug)");
say("--------------------------------------------------------------------------------");
say("Identical curves (LOG bb, Q2 k/hr/h), identical pinning discipline, identical folds; the");
say("ONLY declared difference is the linear z-scored ln(Stuff) aux on the pitcher BB and HR fits.");
say("Uncertainty = 4000-replicate CLUSTER bootstrap over cid on the TEST rows (paired: both arms");
say("see the same resample). Reported as Δ = pareto − pareto-noaug with a 95% percentile interval.");
say("Sign convention: top26 Δ>0 favours the aux; regret Δ<0 favours the aux (lower regret better).");
say();

const B = 4000;
function rngFactory(seed: number) { let s = seed >>> 0; return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }

/** Paired cluster bootstrap over cid: returns {mean, lo, hi} of (a − b) for each metric. */
function clusterBoot(rowsCid: string[], predA: number[], predB: number[], actual: number[], weight: number[], higherBetter: boolean) {
  const groups = new Map<string, number[]>();
  rowsCid.forEach((c, i) => { const g = groups.get(c); if (g) g.push(i); else groups.set(c, [i]); });
  const clusters = [...groups.values()];
  const rnd = rngFactory(0x5eed1234);
  const dTop: number[] = [], dReg: number[] = [], dPea: number[] = [];
  for (let b = 0; b < B; b++) {
    const idx: number[] = [];
    for (let c = 0; c < clusters.length; c++) idx.push(...clusters[Math.floor(rnd() * clusters.length)]!);
    const act = idx.map((i) => actual[i]!), wt = idx.map((i) => weight[i]!);
    const mA = evalMetrics(idx.map((i) => predA[i]!), act, wt, higherBetter, TOPN);
    const mB = evalMetrics(idx.map((i) => predB[i]!), act, wt, higherBetter, TOPN);
    dTop.push(mA.topNOverlap - mB.topNOverlap); dReg.push(mA.valueRegret - mB.valueRegret); dPea.push(mA.pearson - mB.pearson);
  }
  const q = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))]!; };
  const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
  return { top: { m: mean(dTop), lo: q(dTop, 0.025), hi: q(dTop, 0.975) }, reg: { m: mean(dReg), lo: q(dReg, 0.025), hi: q(dReg, 0.975) }, pea: { m: mean(dPea), lo: q(dPea, 0.025), hi: q(dPea, 0.975) }, nClusters: clusters.length };
}

const modelA = pitFormModel(PARETO_PIT), modelB = pitFormModel(PARETO_NOAUG_PIT);
const spec: RoleSpec = PITCHER;

/** Out-of-time predictions for both arms on a (train, test) year pair. */
function ootPreds(trainYrs: number[], testYrs: number[]) {
  const tr = obsOf(trainYrs).filter((o) => spec.qualifies(o, MINN));
  const te = obsOf(testYrs).filter((o) => spec.qualifies(o, MINN));
  const pA = modelA.predict(modelA.fit(tr), te), pB = modelB.predict(modelB.fit(tr), te);
  return { te, pA, pB };
}
/** Pooled out-of-fold CV predictions for both arms (same folds). */
function cvPreds(yrs: number[]) {
  const qual = obsOf(yrs).filter((o) => spec.qualifies(o, MINN));
  const te: TrainObs[] = [], pA: number[] = [], pB: number[] = [];
  for (let f2 = 0; f2 < K; f2++) {
    const test = qual.filter((o) => foldOf(cvFoldKey(o), K) === f2);
    const train = qual.filter((o) => foldOf(cvFoldKey(o), K) !== f2);
    if (!test.length || train.length < 10) continue;
    const a = modelA.predict(modelA.fit(train), test), b = modelB.predict(modelB.fit(train), test);
    test.forEach((o, i) => { te.push(o); pA.push(a[i]!); pB.push(b[i]!); });
  }
  return { te, pA, pB };
}

const AB: { label: string; te: TrainObs[]; pA: number[]; pB: number[] }[] = [
  { label: "FORWARD  fit 2037+2038 → test 2039–2043", ...ootPreds([2037, 2038], [2039, 2040, 2041, 2042, 2043]) },
  { label: "FORWARD  fit 2040+2041 → test 2042+2043", ...ootPreds([2040, 2041], [2042, 2043]) },
  { label: "BACKWARD fit 2042+2043 → test 2037–2041", ...ootPreds([2042, 2043], [2037, 2038, 2039, 2040, 2041]) },
  { label: "BACKWARD fit 2040+2041 → test 2037–2039", ...ootPreds([2040, 2041], [2037, 2038, 2039]) },
  { label: "CV       5-fold on 2042+2043 (cid|side)", ...cvPreds([2042, 2043]) },
  { label: "CV       5-fold on 2040+2041 (cid|side)", ...cvPreds([2040, 2041]) },
];

say("evaluation                                n   cards   metric     pareto   noaug     Δ (aux − no-aux)   95% CI (cluster-by-card)");
for (const { label, te, pA, pB } of AB) {
  const act = te.map(spec.actualWoba), wt = te.map(spec.weight);
  const mA = evalMetrics(pA, act, wt, spec.higherBetter, TOPN), mB = evalMetrics(pB, act, wt, spec.higherBetter, TOPN);
  const bs = clusterBoot(te.map((o) => o.cid), pA, pB, act, wt, spec.higherBetter);
  const sig = (lo: number, hi: number) => (lo > 0 || hi < 0 ? "  CI EXCLUDES 0" : "  CI spans 0");
  say(`${label.padEnd(42)} ${String(te.length).padStart(3)}  ${String(bs.nClusters).padStart(5)}   top26      ${f(mA.topNOverlap)}   ${f(mB.topNOverlap)}   ${(bs.top.m >= 0 ? "+" : "") + f(bs.top.m)}            [${(bs.top.lo >= 0 ? "+" : "") + f(bs.top.lo)}, ${(bs.top.hi >= 0 ? "+" : "") + f(bs.top.hi)}]${sig(bs.top.lo, bs.top.hi)}`);
  say(`${" ".repeat(42)} ${" ".repeat(3)}  ${" ".repeat(5)}   regret     ${f(mA.valueRegret, 5)}  ${f(mB.valueRegret, 5)}  ${(bs.reg.m >= 0 ? "+" : "") + f(bs.reg.m, 5)}           [${(bs.reg.lo >= 0 ? "+" : "") + f(bs.reg.lo, 5)}, ${(bs.reg.hi >= 0 ? "+" : "") + f(bs.reg.hi, 5)}]${sig(bs.reg.lo, bs.reg.hi)}`);
  say(`${" ".repeat(42)} ${" ".repeat(3)}  ${" ".repeat(5)}   wPearson   ${f(mA.pearson)}   ${f(mB.pearson)}   ${(bs.pea.m >= 0 ? "+" : "") + f(bs.pea.m)}            [${(bs.pea.lo >= 0 ? "+" : "") + f(bs.pea.lo)}, ${(bs.pea.hi >= 0 ? "+" : "") + f(bs.pea.hi)}]${sig(bs.pea.lo, bs.pea.hi)}`);
  say();
}

// ── §7 paired cluster bootstrap: deployed vs every rival that led an OOT cell ──
say("================================================================================");
say("§7  HOW BIG IS THE GAP?  deployed form vs each rival, paired cluster bootstrap");
say("--------------------------------------------------------------------------------");
say("§5's ranks are ORDINAL and the field is tightly packed — on n≈130–260 rows with a 26-slot");
say("cut, ONE slot = 0.0385 of top26, so a several-place rank move can be a single card. This");
say("section puts an interval on the gaps that matter. Δ = rival − deployed, so Δtop26 > 0 and");
say("Δregret < 0 mean the RIVAL is better. Same 4000-replicate cid-clustered bootstrap as §6.");
say();

const hitModelOf = (fm: HitForm): BakeoffModel => ({ name: fm.name, role: "hitter", fit: (t) => fitHitForm(fm, t, 0.75, []), predict: (p, te) => te.map((o) => predictHitForm(p as ReturnType<typeof fitHitForm>, o)) });
const RIVALS: { role: "hitter" | "pitcher"; deployed: BakeoffModel; rivals: BakeoffModel[] }[] = [
  { role: "hitter", deployed: hitModelOf(RAWPOLY_HIT), rivals: [hitModelOf(RAWCUBIC_HIT), hitModelOf(RAWLIN_HIT), hitModelOf(QPOWLIN_HIT), hitModelOf(PERBIP_HIT)] },
  { role: "pitcher", deployed: pitFormModel(PARETO_PIT), rivals: [pitFormModel(STUFFAUG_PIT), pitFormModel(SATBB_PIT), pitFormModel(RAWLIN_PIT), pitFormModel(PERBIP_PIT), pitFormModel(PARETO_NOAUG_PIT)] },
];
const OOT_PAIRS: { label: string; train: number[]; test: number[] }[] = [
  { label: "FWD 37+38→39-43", train: [2037, 2038], test: [2039, 2040, 2041, 2042, 2043] },
  { label: "FWD 40+41→42+43", train: [2040, 2041], test: [2042, 2043] },
  { label: "BCK 42+43→37-41", train: [2042, 2043], test: [2037, 2038, 2039, 2040, 2041] },
  { label: "BCK 40+41→37-39", train: [2040, 2041], test: [2037, 2038, 2039] },
];
for (const { role, deployed, rivals } of RIVALS) {
  const sp = role === "hitter" ? HITTER : PITCHER;
  say(`-- ${role.toUpperCase()} · deployed = ${deployed.name} --`);
  say("direction         rival                 Δtop26   95% CI              Δregret     95% CI                  ΔwPearson  95% CI");
  for (const { label, train, test } of OOT_PAIRS) {
    const tr = obsOf(train).filter((o) => sp.qualifies(o, MINN));
    const te = obsOf(test).filter((o) => sp.qualifies(o, MINN));
    const act = te.map(sp.actualWoba), wt = te.map(sp.weight), cids = te.map((o) => o.cid);
    const pD = deployed.predict(deployed.fit(tr), te);
    for (const rv of rivals) {
      const pR = rv.predict(rv.fit(tr), te);
      const bs = clusterBoot(cids, pR, pD, act, wt, sp.higherBetter);
      const s = (x: number, d: number) => (x >= 0 ? "+" : "") + f(x, d);
      say(`${label.padEnd(17)} ${rv.name.padEnd(21)} ${s(bs.top.m, 4)}  [${s(bs.top.lo, 4)}, ${s(bs.top.hi, 4)}]  ${s(bs.reg.m, 5)}  [${s(bs.reg.lo, 5)}, ${s(bs.reg.hi, 5)}]  ${s(bs.pea.m, 4)}  [${s(bs.pea.lo, 4)}, ${s(bs.pea.hi, 4)}]${bs.top.lo > 0 || bs.top.hi < 0 || bs.reg.lo > 0 || bs.reg.hi < 0 ? "  ** deliverable CI excludes 0" : ""}`);
    }
    say();
  }
}

// ── §8 gate vs production guard on a pinned channel ───────────────────────────
say("================================================================================");
say("§8  FLAG — the bake-off gate and production's vertex guard disagree on a PINNED quad");
say("--------------------------------------------------------------------------------");
{
  const pq = obsOf([2042, 2043]).filter((o) => PITCHER.qualifies(o, MINN));
  const pins: VertexPin[] = [];
  const fit = fitPitForm(PARETO_PIT, pq, 0.75, pins);
  const g = gatePit(fit, pq);
  const iv = inDomainVertex(fit.hr);
  say(`window [2042,2043], PARETO_PIT fitted the production way (pins collected: ${pins.map((p) => p.channel).join(",") || "none"}).`);
  say(`  production guard  inDomainVertex(pit.hr) = ${iv == null ? "null → PASSES (this is what saveTrainedModel checks)" : iv.toFixed(3)}`);
  say(`  bake-off gate     gatePit = ${g.status}${g.notes.length ? ` — ${g.notes.join("; ")}` : ""}`);
  say("  The pinned family puts the vertex EXACTLY at the domain max, so it is monotone over the");
  say("  whole fit domain and inDomainVertex (a strict-interior test) passes by construction. But");
  say("  chkEvent samples the domain PLUS a 10% extrapolation margin, and the parabola necessarily");
  say("  turns over inside that margin — so the gate reports 'non-monotone IN-DOMAIN', which is not");
  say("  what it observed. The label is wrong and the warning is unavoidable for any pinned channel.");
  say("  Consequence for reading §4: a 'warn (HR curve non-monotone in-domain)' on a pinned form is");
  say("  NOT evidence of a corrupt shape. Not changed here (it would alter gate semantics); flagged.");
}
say();

// ── §9 verdict ────────────────────────────────────────────────────────────────
say("================================================================================");
say("§9  VERDICT");
say("================================================================================");
say();
say("Q1 — DOES THE DEPLOYED CONFIGURATION (RAWPOLY_HIT + PARETO_PIT, pinned) WIN?");
say();
say("No — and neither does anything else. On the two metrics that carry the deliverable (top-26");
say("overlap and value-regret) the field is statistically indistinguishable. Across the four");
say("out-of-time comparisons in §7, spanning both directions and both roles, NOT ONE rival's");
say("Δtop26 or Δregret confidence interval excludes zero against the deployed form. The typical");
say("95% interval on Δtop26 is ±0.077 to ±0.115 — that is 2 to 3 roster slots out of 26 — because");
say("only 63–82 distinct CARDS clear the 1000-PA/BF bar in any test block. The ordinal ranks in §5");
say("(where woba·pareto lands 17/20 on one in-sample cell and 2/20 on another) are noise at this");
say("resolution and should not be read as a result. That is the primary finding: the bake-off");
say("cannot separate model FORMS on deliverable outcomes with this much league data. It could not");
say("have done so before the parity fix either; the fix means the comparison is now at least");
say("scoring the right model.");
say();
say("On weighted Pearson — which does separate, being a pooled-fidelity statistic rather than a");
say("26-slot cut — the deployed forms hold up:");
say("  · HITTER woba·rawpoly is CI-clear BETTER than woba·rawlin in 4 of 4 directions (−0.019 to");
say("    −0.034) and than woba·qpow-lin in 3 of 4 (−0.011 to −0.021), and is a statistical TWIN of");
say("    woba·rawcubic (Δ from −0.0001 to +0.0020, every CI spanning 0). rawcubic is not a reason to");
say("    switch: indistinguishable, and it trips the monotone gate on HR and XBH in three of the");
say("    four in-sample windows. woba·perbip is the one form that genuinely SPLITS the directions —");
say("    CI-clear better forward on 40+41→42+43 (+0.0093) and CI-clear worse backward on");
say("    42+43→37-41 (−0.0031). Both effects are ≤0.01 Pearson and neither shows up in top26 or");
say("    regret, so this is a fidelity trade, not a deliverable one.");
say("  · PITCHER woba·pareto is CI-clear better than woba·rawlin in 1 of 4 directions and than its");
say("    own no-aux variant in 2 of 4, and is statistically tied with woba·stuffaug, woba·satbb,");
say("    woba·perbip and woba·matchupK in every direction.");
say("Conclusion: keep the deployed configuration. It is never beaten at measurable confidence, it");
say("beats the low-flexibility forms on fidelity, and the forms that match it are either gate-dirty");
say("(rawcubic) or already-known equivalents. But the honest framing is 'not refuted', not 'wins'.");
say();
say("Q2 — DOES stuffAug EARN ITS PLACE?");
say();
say("Partly — on fidelity yes, on the deliverable it is unmeasurable. The direction is consistent:");
say("ΔwPearson (pareto − pareto-noaug) is POSITIVE in all six evaluations in §6 (+0.012, +0.020,");
say("+0.017, +0.023, +0.032, +0.033), and the cid-clustered CI excludes zero in FOUR of the six");
say("(both CV windows, the 37+38→39-43 forward, and the 40+41→37-39 backward). Six of six");
say("same-signed is itself informative beyond the individual intervals: under a true null the");
say("chance of that is 1/32, and these six evaluations are not independent but they are not");
say("nested either. So the aux is doing real work in the fit.");
say("But in deliverable terms it is a null: Δtop26 runs −0.030 to +0.016 with every CI spanning");
say("zero, and Δregret runs −0.00021 to +0.00075 wOBA per slot — five of the six magnitudes under");
say("0.00022 — again with every CI spanning zero. At 63–82 clusters the design simply cannot");
say("resolve an effect of that size on a 26-slot cut.");
say("Recommendation: KEEP the aux. It is consistently positive on fidelity, never negative on the");
say("deliverable, and the sequential-resolution mechanism (high Stuff getting ahead in counts");
say("suppressing walks) is coherent. This run is its first committed evidence artifact — the");
say("previous position was that it had none. Two caveats on the record: (i) on the [2042,2043]");
say("window the aux changes WHETHER pit.hr pins (§3), so that arm is not a strict one-term contrast");
say("— both arms are nonetheless fitted exactly as production fits them; (ii) the fidelity gain is");
say("small enough that it should not be cited as decisive for anything downstream.");
say();
say("CONTRADICTIONS / FLAGS AGAINST THE EXISTING RECORD");
say();
say("1. server.ts:1466 and plan §11.31 record PARETO_PIT as beating StuffAug. On LEAGUE fidelity");
say("   that is not visible here: woba·stuffaug's wPearson is NOMINALLY HIGHER than woba·pareto's in");
say("   three of the four out-of-time directions (+0.0018, +0.0068, +0.0054; the fourth −0.0011),");
say("   every CI spanning zero, and stuffaug also leads pareto on several §4 cells. This is not a");
say("   refutation — §11.31's claim was about in-frame value SPREAD and out-of-frame cap-bias on");
say("   tournament data, which this scoreboard does not measure — but the record should not be read");
say("   as 'pareto is the better league fit'. It is not distinguishable from the form it replaced.");
say("2. src/training/residuals.ts:89 pins the pitcher role to STUFFAUG_PIT while its comment claims");
say("   to 'track the deployed forms by reference'. The deployed pitcher form has been PARETO_PIT");
say("   since 2026-07-14, so the live /api/residuals endpoint has been reporting the misses of a");
say("   retired form for eleven days. Not fixed here (it changes a live endpoint's numbers).");
say("3. The bake-off gate mislabels every PINNED quad as 'non-monotone in-domain' (§8). Production's");
say("   own guard passes the same fit. Any past reading of a gate warn on a pinned channel as a");
say("   corrupt shape was wrong.");
say("4. RAWPOLY_PIT — the entry that stood in FORM_ENTRIES as 'the #2 pitcher form' — is not what");
say("   ships and does not behave like what ships: on the 2042+2043 CV it ranks 1/20 by top26 while");
say("   woba·pareto ranks 4/20 (both 0.5385 — the same value, differing only on the regret tiebreak),");
say("   and its wPearson is 0.030 LOWER. Any conclusion drawn from the old scoreboard about 'the");
say("   deployed pitcher model' was about a form we do not deploy.");
say("5. Out-of-time pitcher top-26 overlap sits at 0.50–0.65 for essentially every candidate in");
say("   three of the four OOT cells (the 40+41→37-39 backward cell runs higher, 0.73–0.81), and");
say("   ceiling·flex — the practical ceiling for a smooth model in these ratings — is INSIDE that");
say("   band or below it in every one of them. The pitcher selection problem is data-limited, not");
say("   form-limited; no curve change in this family will move it.");
say();

writeFileSync(OUT, lines.join("\n") + "\n", "utf8");
console.error(`\nwrote ${OUT}`);
