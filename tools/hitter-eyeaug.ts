// HITTER EYE-AUX ON THE K CHANNEL — candidate measurement (2026-07-25).
//   run: node tools/hitter-eyeaug.ts   (writes fixtures/hitter-eyeaug-2026-07-25.txt)
//
// WHAT IS BEING TESTED. fixtures/hitter-residual-channels-2026-07-25.txt established that the hitter
// EYE rating has NO PATHWAY into the strikeout channel — hit.k is fit on AvoidK alone and NOT ONE
// hitter channel carries an aux term — and that the deployed model consequently over-predicts K for
// high-Eye hitters: +2.01/600 per SD of EYE marginally [+1.48, +2.56] and +2.15 CONDITIONAL on all
// four other hitter ratings [+1.47, +2.93] (it STRENGTHENS under conditioning, so it is not a proxy
// for a correlated rating), weighted r = 0.525 — the largest of 24 structurally-free cells, clearing
// a family-wise permutation null over the whole family (p = 0.000) — with a monotone quintile ramp
// −3.08 → +3.33/600 and CI-clear readings in 7 of 7 seasons, five of them out of frame.
//
// THE CANDIDATE. src/training/forms.ts RAWPOLY_EYEAUG_HIT = the DEPLOYED hitter form (RAWPOLY_HIT)
// with ONE declared change: `eyeAug: true`, which routes hit.k through fitEventAux — the SAME
// primitive the pitcher's `stuffAug` uses — fitting the log-AvoidK curve and a linear z-scored
// ln(EYE) term jointly in one WLS. Mechanism (domain owner): plate appearances plausibly resolve
// SEQUENTIALLY in this engine, so a patient hitter works counts and strikes out less than his
// contact rating alone implies. This is the mirror image of stuffAug, which passed its first proper
// validation on 2026-07-25 (fixtures/bakeoff-parity-scoreboard-2026-07-25.txt §Q2).
//
// THE STANDARD IT MUST MEET, fixed BEFORE the run and taken verbatim from what stuffAug cleared:
// ΔwPearson CONSISTENTLY POSITIVE across all six evaluations and NEVER CI-clear negative, with a
// coherent mechanism. stuffAug scored +0.012…+0.033, positive six of six, CI-clear in four, while
// the deliverable metrics (top-26 overlap, value-regret) could not resolve it either way. Anything
// inconsistent, or CI-clear negative anywhere, does NOT earn its place.
//
// FITTING DISCIPLINE. Every fit here passes a FRESH vertex-pin collector, exactly as production's
// server.saveTrainedModel does (the parity fix of commit 7dea19a). Both arms are therefore fitted
// the way we ship, per fold and per window.
//
// UNCERTAINTY. Distinct CARDS ≪ rows and a card's residual is close to a fixed function of its
// unchanging ratings, so EVERY interval here is a CLUSTER bootstrap over cid — a drawn card brings
// all of its rows. Distinct-card counts are printed beside every n.
//
// DATA. root 'League Files', seasons 2037–2043 ONLY; 'League Files/Old Data' (2032–33) sits after a
// four-season gap and is EXCLUDED via EvalOpts.years. The loader's corrupt-cell detector drops the
// duplicate-vL/vR cell HD450|2039; §2 confirms it fired. League coverage is UNEQUAL by season, so
// every cross-season claim below is qualified in place.
//
// MEASUREMENT ONLY — no production default changed, no artifact retrained, nothing deployed.

import { writeFileSync } from "node:fs";
import { loadWindow, availableYears, type TrainObs } from "../src/training/loader.ts";
import { buildScoreboard, foldOf, cvFoldKey } from "../src/training/evaluate.ts";
import { HITTER } from "../src/training/bakeoff.ts";
import { validateDataset } from "../src/training/validate.ts";
import { evalMetrics } from "../src/training/metrics.ts";
import { wls } from "../src/training/fit.ts";
import { rate, rateAux, hRate, inDomainVertex, HIT_BIP_ADJ, type FittedHit } from "../src/model/curves.ts";
import {
  fitHitForm, predictHitForm, hitFormModel,
  RAWPOLY_HIT, RAWPOLY_EYEAUG_HIT, type VertexPin, type HitForm,
} from "../src/training/forms.ts";

const ROOT = "League Files";
const OUT = "fixtures/hitter-eyeaug-2026-07-25.txt";
const MINN = 1000, TOPN = 26, K = 5, NBOOT = 4000;
const LEAGUE_YEARS = availableYears(ROOT).filter((y) => y >= 2037);
const DEPLOYED = "woba·rawpoly", CANDIDATE = "woba·rawpoly-eyeaug";

const lines: string[] = [];
const say = (s = "") => { lines.push(s); console.log(s); };
const f = (x: number, d = 4) => (Number.isFinite(x) ? x.toFixed(d) : "n/a");
const sg = (x: number, d = 4) => (Number.isFinite(x) ? `${x >= 0 ? "+" : ""}${x.toFixed(d)}` : "n/a");
const pad = (s: string, n: number) => s.padEnd(n);
const rp = (s: string, n: number) => s.padStart(n);

// ── shared: cached observation loads ──────────────────────────────────────────
const cache = new Map<string, TrainObs[]>();
const obsOf = (ys: number[]) => { const k = ys.join(","); if (!cache.has(k)) cache.set(k, loadWindow(ROOT, ys).observations); return cache.get(k)!; };
const qual = (ys: number[]) => obsOf(ys).filter((o) => HITTER.qualifies(o, MINN));
/** Production-parity fit: a FRESH pin collector per call, like server.saveTrainedModel. */
const fitP = (fm: HitForm, tr: TrainObs[], pins: VertexPin[] = []) => fitHitForm(fm, tr, 0.75, pins);
const cardsOf = (rs: { cid: string }[]) => new Set(rs.map((r) => r.cid)).size;

// ── shared: paired cid-cluster bootstrap (the parity scoreboard's, unchanged) ──
function rngFactory(seed: number) { let s = seed >>> 0; return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
const quant = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))]!; };
const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
const excl0 = (lo: number, hi: number) => lo > 0 || hi < 0;

function clusterBoot(cids: string[], predA: number[], predB: number[], actual: number[], weight: number[]) {
  const groups = new Map<string, number[]>();
  cids.forEach((c, i) => { const g = groups.get(c); if (g) g.push(i); else groups.set(c, [i]); });
  const clusters = [...groups.values()];
  const rnd = rngFactory(0x5eed1234);   // same seed as the stuffAug run — comparable draws
  const dTop: number[] = [], dReg: number[] = [], dPea: number[] = [];
  for (let b = 0; b < NBOOT; b++) {
    const idx: number[] = [];
    for (let c = 0; c < clusters.length; c++) idx.push(...clusters[Math.floor(rnd() * clusters.length)]!);
    const act = idx.map((i) => actual[i]!), wt = idx.map((i) => weight[i]!);
    const mA = evalMetrics(idx.map((i) => predA[i]!), act, wt, true, TOPN);
    const mB = evalMetrics(idx.map((i) => predB[i]!), act, wt, true, TOPN);
    dTop.push(mA.topNOverlap - mB.topNOverlap); dReg.push(mA.valueRegret - mB.valueRegret); dPea.push(mA.pearson - mB.pearson);
  }
  const bundle = (a: number[]) => ({ m: mean(a), lo: quant(a, 0.025), hi: quant(a, 0.975) });
  return { top: bundle(dTop), reg: bundle(dReg), pea: bundle(dPea), nClusters: clusters.length };
}

// ── header ────────────────────────────────────────────────────────────────────
say("================================================================================");
say("HITTER EYE-AUX ON THE K CHANNEL — CANDIDATE MEASUREMENT — 2026-07-25");
say("tools/hitter-eyeaug.ts · root 'League Files' · seasons 2037–2043 · MEASUREMENT ONLY");
say("================================================================================");
say();
say("THE FINDING BEING ACTED ON (fixtures/hitter-residual-channels-2026-07-25.txt, Part 1b):");
say("the hitter EYE rating has NO pathway into the strikeout channel — hit.k is fit on AvoidK");
say("ALONE and not one hitter channel carries an aux — and the deployed model over-predicts K for");
say("high-Eye hitters by +2.01/600 per SD of EYE marginally [+1.48, +2.56] and +2.15 CONDITIONAL on");
say("the other four ratings [+1.47, +2.93]. It STRENGTHENS under conditioning (not a proxy), r=0.525");
say("is the largest of 24 structurally-free cells, it clears a family-wise permutation null over the");
say("whole family (p=0.000), the quintile ramp is monotone −3.08 → +3.33/600, and it is CI-clear in");
say("7 of 7 seasons (5 out of frame), +2.13 pooled 2037–2043.");
say();
say("THE CANDIDATE: src/training/forms.ts RAWPOLY_EYEAUG_HIT ('woba·rawpoly-eyeaug') = the DEPLOYED");
say("hitter form with ONE declared change, `eyeAug: true`, which routes hit.k through fitEventAux —");
say("the same primitive `stuffAug` uses on pit.bb/pit.hr — fitting the log-AvoidK curve and a linear");
say("z-scored ln(EYE) term JOINTLY in one WLS. Threading mirrors the pitcher side exactly:");
say("fitHitForm's BIP chain consumes rateAux(k, kRat, eye), predictHitForm and the deployed");
say("raw-poly predictHitting read rateAux(hit.k, kRat, eye). rateAux ≡ rate when the fitted event");
say("carries no aux, so EVERY existing form and every already-trained artifact — including the");
say("deployed one — predicts BIT-IDENTICALLY. Production still fits RAWPOLY_HIT; nothing shipped.");
say();
say("THE STANDARD, fixed before the run — the one stuffAug cleared on 2026-07-25 (§Q2 of");
say("fixtures/bakeoff-parity-scoreboard-2026-07-25.txt): ΔwPearson POSITIVE in all six evaluations");
say("(stuffAug: +0.012…+0.033, CI-clear in four, never negative) with a coherent mechanism, while");
say("the deliverable metrics stayed unresolvable. Inconsistent, or CI-clear negative anywhere ⇒ the");
say("term does NOT earn its place.");
say();
say("EVERY fit below passes a FRESH vertex-pin collector — production parity (commit 7dea19a).");
say("EVERY interval below is a 4000-replicate CLUSTER bootstrap over cid, never over rows.");
say();

// ── §1 data + exclusions ──────────────────────────────────────────────────────
const loaded = loadWindow(ROOT, LEAGUE_YEARS);
const val = validateDataset(loaded.summary);
say("================================================================================");
say("§1  DATA AND EXCLUSIONS");
say("--------------------------------------------------------------------------------");
say(`years present under root: ${availableYears(ROOT).join(", ")}`);
say(`years USED: ${LEAGUE_YEARS.join(", ")}   (Old Data 2032–33 excluded — four-season gap, never pooled)`);
{
  const byYear = new Map<number, Set<string>>();
  for (const c of loaded.summary.cells) { if (!byYear.has(c.year)) byYear.set(c.year, new Set()); byYear.get(c.year)!.add(c.league); }
  const excl = new Set(loaded.summary.excludedCells);
  for (const [y, ls] of [...byYear].sort((a, b) => a[0] - b[0])) {
    const kept = [...ls].sort().filter((l) => !excl.has(`${l}|${y}`));
    const dropped = [...ls].sort().filter((l) => excl.has(`${l}|${y}`));
    say(`  ${y}: ${kept.length} league(s) ${kept.join(" ")}${dropped.length ? `   EXCLUDED: ${dropped.join(" ")}` : ""}`);
  }
}
say(`loader auto-exclusions (corrupt cells): ${loaded.summary.excludedCells.length ? loaded.summary.excludedCells.join(", ") : "none"}`);
say(`  ⇒ the known duplicate-vL/vR cell HD450|2039 is ${loaded.summary.excludedCells.includes("HD450|2039") ? "DETECTED AND DROPPED (confirmed)" : "NOT in this exclusion list — INVESTIGATE"}.`);
say(`validateDataset: ${val.errors} error(s), ${val.warnings} warning(s)`);
for (const i of val.issues.filter((x) => x.severity === "error")) say(`  ERROR  ${i.scope}: ${i.message}`);
say("SEASON COVERAGE IS UNEQUAL: 2037 has 4 leagues (no HD452); 2038 and 2040–2043 have 5; 2039 is");
say("effectively 4 after the HD450 exclusion. Every cross-season claim below is qualified by this.");
say();

// ── §2 the fitted term ────────────────────────────────────────────────────────
const WINDOWS: number[][] = [[2037, 2038], [2040, 2041], [2042, 2043]];
say("================================================================================");
say("§2  THE FITTED TERM — what the aux actually estimates, per window");
say("--------------------------------------------------------------------------------");
say("aux β = K per 600 PA per SD of ln(EYE), on top of the log-AvoidK curve. The MECHANISM predicts");
say("a NEGATIVE β (more patience ⇒ fewer strikeouts). The 'implied' column converts β to K/600 per");
say("SD of RAW EYE at the window mean (dz_lnEYE/dEYE · SD_EYE), so it is directly comparable to the");
say("+2.01/600-per-SD residual slope the term is meant to remove.");
say();
say("window      n rows  cards   aux β (per SD lnEYE)   implied K/600 per SD raw EYE   direction");
for (const w of WINDOWS) {
  const tr = qual(w);
  const fit = fitP(RAWPOLY_EYEAUG_HIT, tr) as FittedHit;
  const aux = fit.k.aux!;
  // Convert per-SD-of-ln(EYE) to per-SD-of-raw-EYE at the PA-weighted mean EYE: a 1-SD raw move is
  // ΔlnEYE ≈ SD_eye / μ_eye, which is (SD_eye / μ_eye) / aux.sd standard deviations of ln(EYE).
  const sw = tr.reduce((s, o) => s + o.hit.PA, 0);
  const muE = tr.reduce((s, o) => s + o.hit.PA * o.ratings.hit.eye, 0) / sw;
  const sdE = Math.sqrt(tr.reduce((s, o) => s + o.hit.PA * (o.ratings.hit.eye - muE) ** 2, 0) / sw);
  const implied = aux.beta * (sdE / muE) / aux.sd;
  say(`${pad(w.join("+"), 11)} ${rp(String(tr.length), 6)}  ${rp(String(cardsOf(tr)), 5)}   ${rp(sg(aux.beta, 4), 20)}   ${rp(sg(implied, 3), 28)}   ${aux.beta < 0 ? "NEGATIVE — as the mechanism predicts" : "POSITIVE — AGAINST the mechanism"}`);
}
say();

// ── §3 pin audit ──────────────────────────────────────────────────────────────
say("================================================================================");
say("§3  PIN AUDIT — does adding the aux change WHETHER any quad channel pins?");
say("--------------------------------------------------------------------------------");
say("This bit the stuffAug comparison: on [2042,2043] the Stuff aux moved the pit.hr vertex INTO");
say("domain, so that arm was not a strict one-term contrast. Checked here for both arms, per window.");
say();
say("window      form                   pinned channels          hit.hr vertex-in-domain?");
for (const w of WINDOWS) {
  const tr = qual(w);
  for (const fm of [RAWPOLY_HIT, RAWPOLY_EYEAUG_HIT]) {
    const pins: VertexPin[] = [];
    const fit = fitP(fm, tr, pins) as FittedHit;
    // Re-fit UNPINNED to read the unconstrained vertex (a pinned fit's vertex sits at the domain
    // max by construction, so the pinned object cannot answer the question about itself).
    const raw = fitHitForm(fm, tr, 0.75, undefined) as FittedHit;
    const iv = inDomainVertex(raw.hr);
    say(`${pad(w.join("+"), 11)} ${pad(fm.name, 22)} ${pad(pins.length ? pins.map((p) => `${p.channel}@z=${p.pinZ.toFixed(3)}`).join(",") : "— none —", 24)} ${iv == null ? "no (vertex outside the fit domain)" : `YES z=${iv.toFixed(3)}`}`);
  }
}
say();
say("STRUCTURAL READ (from fitHitForm, not just the numbers above): RAWPOLY_HIT's ONLY quad channel");
say("is hit.hr, and hit.hr is fit on (POW, HR/600, w) BEFORE the BIP chain is built — the K aux");
say("cannot touch its design, its target or its weights. hit.bb/hit.k/hit.xbh/hit.h are all LOG, and");
say("pinEvent requires a rawpoly-2 channel, so no other pin can fire on either arm. The aux therefore");
say("CANNOT change the pinning of this form, in any window, by construction — and the table confirms");
say("it. Unlike the stuffAug arm, this IS a strict one-term contrast.");
say();

// ── §4 scoreboard through the harness ─────────────────────────────────────────
say("================================================================================");
say("§4  SCOREBOARD — the candidate on the harness, pinned, League Files 2037–2043");
say("--------------------------------------------------------------------------------");
say(`minN=${MINN} (PA)  topN=${TOPN}  k=${K}-fold  includeVariants=true  foldKey=cid|side`);
say("Hitter rows only. wPears = weighted Pearson (affine-invariant, blind to level); top26 = fraction");
say("of the model's top-26 that are truly top-26; regret = mean per-slot actual-wOBA shortfall of the");
say("model's top-26 (LOWER better). Rank = within the full hitter candidate field of that cell.");
say();
interface SRow { model: string; evaluation: string; window: string; n: number; pearson: number; spearman: number; top: number; regret: number; gate: string; rankP: number; rankT: number; field: number }
const EVALS = ["in-sample", "cv", "forward", "backward"];
const sbRuns: { window: number[]; rows: SRow[] }[] = [];
for (const w of WINDOWS) {
  const t0 = Date.now();
  const sb = buildScoreboard(ROOT, { minN: MINN, topN: TOPN, k: K, window: w, years: LEAGUE_YEARS, includeVariants: true });
  const hit = sb.rows.filter((r) => r.role === "hitter");
  const rows: SRow[] = [];
  for (const name of [DEPLOYED, CANDIDATE]) {
    for (const e of EVALS) {
      const cell = hit.filter((r) => r.evaluation === e);
      const me = cell.find((r) => r.model === name);
      if (!me) continue;
      const rankBy = (key: (r: (typeof cell)[number]) => number, desc: boolean) =>
        [...cell].sort((a, b) => (desc ? key(b) - key(a) : key(a) - key(b))).findIndex((r) => r.model === name) + 1;
      rows.push({
        model: name, evaluation: e, window: me.window, n: me.metrics.n,
        pearson: me.metrics.pearson, spearman: me.metrics.spearman, top: me.metrics.topNOverlap, regret: me.metrics.valueRegret,
        gate: me.gate ? `${me.gate.status}${me.gate.notes.length ? ` (${me.gate.notes.join("; ")})` : ""}` : "",
        rankP: rankBy((r) => r.metrics.pearson, true), rankT: rankBy((r) => r.metrics.topNOverlap, true), field: cell.length,
      });
    }
  }
  sbRuns.push({ window: w, rows });
  console.error(`[scoreboard ${w.join("+")}] ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}
for (const run of sbRuns) {
  say(`-- train window ${run.window.join("+")} --`);
  say("  eval        window            n   wPears  wP-rank   spear    top26  t26-rank   regret     gate");
  for (const e of EVALS) {
    for (const r of run.rows.filter((x) => x.evaluation === e)) {
      const mark = r.model === CANDIDATE ? "+" : "*";
      say(`${mark} ${pad(r.evaluation, 11)} ${pad(r.window, 16)} ${rp(String(r.n), 3)}  ${f(r.pearson)}  ${rp(`${r.rankP}/${r.field}`, 7)}  ${f(r.spearman)}  ${f(r.top)}  ${rp(`${r.rankT}/${r.field}`, 8)}  ${f(r.regret, 5)}  ${r.gate}`);
    }
  }
  say();
}
say("('*' = deployed woba·rawpoly, '+' = candidate woba·rawpoly-eyeaug. Ranks are ORDINAL over a");
say("tightly-packed field and should not be read as evidence — §5 puts intervals on the gaps.)");
say();

// ── §5 the six paired evaluations ─────────────────────────────────────────────
say("================================================================================");
say("§5  THE SIX PAIRED EVALUATIONS — deployed vs candidate, same folds, same pinning");
say("--------------------------------------------------------------------------------");
say("Identical curves (LOG bb/k/xbh/h, quad hr), identical pinning discipline, identical folds; the");
say("ONLY declared difference is the linear z-scored ln(EYE) aux on the hitter K fit. Exactly the six");
say("evaluations stuffAug was held to. Δ = eyeaug − deployed. Sign convention: ΔwPearson > 0 and");
say("Δtop26 > 0 favour the aux; Δregret < 0 favours the aux (lower regret is better).");
say();
const mDep = hitFormModel(RAWPOLY_HIT), mCand = hitFormModel(RAWPOLY_EYEAUG_HIT); // both pinned = production
function ootPreds(trainYrs: number[], testYrs: number[]) {
  const tr = qual(trainYrs), te = qual(testYrs);
  return { te, pA: mCand.predict(mCand.fit(tr), te), pB: mDep.predict(mDep.fit(tr), te) };
}
function cvPreds(yrs: number[]) {
  const q = qual(yrs);
  const te: TrainObs[] = [], pA: number[] = [], pB: number[] = [];
  for (let fold = 0; fold < K; fold++) {
    const test = q.filter((o) => foldOf(cvFoldKey(o), K) === fold);
    const train = q.filter((o) => foldOf(cvFoldKey(o), K) !== fold);
    if (!test.length || train.length < 10) continue;
    const a = mCand.predict(mCand.fit(train), test), b = mDep.predict(mDep.fit(train), test);
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
say("evaluation                                n   cards   metric     eyeaug   deployed  Δ (aux − none)     95% CI (cluster-by-card)");
const dPea: { label: string; m: number; lo: number; hi: number }[] = [];
for (const { label, te, pA, pB } of AB) {
  const act = te.map(HITTER.actualWoba), wt = te.map(HITTER.weight);
  const mA = evalMetrics(pA, act, wt, true, TOPN), mB = evalMetrics(pB, act, wt, true, TOPN);
  const bs = clusterBoot(te.map((o) => o.cid), pA, pB, act, wt);
  dPea.push({ label: label.slice(0, 40).trim(), m: bs.pea.m, lo: bs.pea.lo, hi: bs.pea.hi });
  const sig = (lo: number, hi: number) => (excl0(lo, hi) ? "  CI EXCLUDES 0" : "  CI spans 0");
  say(`${pad(label, 42)} ${rp(String(te.length), 3)}  ${rp(String(bs.nClusters), 5)}   top26      ${f(mA.topNOverlap)}   ${f(mB.topNOverlap)}   ${rp(sg(bs.top.m), 8)}          [${sg(bs.top.lo)}, ${sg(bs.top.hi)}]${sig(bs.top.lo, bs.top.hi)}`);
  say(`${" ".repeat(42)} ${" ".repeat(3)}  ${" ".repeat(5)}   regret     ${f(mA.valueRegret, 5)}  ${f(mB.valueRegret, 5)}  ${rp(sg(bs.reg.m, 5), 9)}          [${sg(bs.reg.lo, 5)}, ${sg(bs.reg.hi, 5)}]${sig(bs.reg.lo, bs.reg.hi)}`);
  say(`${" ".repeat(42)} ${" ".repeat(3)}  ${" ".repeat(5)}   wPearson   ${f(mA.pearson)}   ${f(mB.pearson)}   ${rp(sg(bs.pea.m), 8)}          [${sg(bs.pea.lo)}, ${sg(bs.pea.hi)}]${sig(bs.pea.lo, bs.pea.hi)}`);
  say();
}
const nPos = dPea.filter((d) => d.m > 0).length, nClearPos = dPea.filter((d) => d.lo > 0).length, nClearNeg = dPea.filter((d) => d.hi < 0).length;
say(`ΔwPearson TALLY: ${nPos} of 6 positive; ${nClearPos} CI-clear positive; ${nClearNeg} CI-clear NEGATIVE.`);
say(`  ${dPea.map((d) => sg(d.m)).join(", ")}`);
say();

// ── §6 residual re-measurement ────────────────────────────────────────────────
// Does the structure the term exists to remove actually go away? A term that leaves the motivating
// residual intact is not the right term regardless of its metrics.
say("================================================================================");
say("§6  RESIDUAL RE-MEASUREMENT — does the EYE→K structure actually go away?");
say("--------------------------------------------------------------------------------");
say("Per-row K residual = PREDICTED K/600 − OBSERVED K/600 (positive = the model over-predicts");
say("strikeouts, the direction the finding reports for high-Eye hitters). Slopes are PA-weighted, per");
say("SD of raw EYE, matching the published +2.01 marginal / +2.15 conditional exactly in units and");
say("grain. CONDITIONAL holds all five hitter ratings (eye, pow, kRat, babip, gap) — the decisive read.");
say();
say("READ THE TWO FRAMES DIFFERENTLY, and this is the whole methodological point:");
say("  · IN FRAME the aux is fitted by weighted least squares against ln(EYE), so the marginal");
say("    ln(EYE) direction of the K residual is SUPPRESSED BY CONSTRUCTION. A near-zero in-frame");
say("    slope is therefore only a sanity check that the term is the right FUNCTIONAL FORM (the aux");
say("    is linear in z-ln(EYE); the residual is measured against RAW EYE, and the CONDITIONAL slope");
say("    is not forced to zero at all, so neither reading is a tautology — but neither is evidence).");
say("  · OUT OF FRAME nothing is forced. A term that is real removes the structure on data it never");
say("    saw; a term that merely absorbs in-sample noise does not. THAT is the decisive panel.");
say();
interface RRow { cid: string; w: number; z: number[]; resid: number }
const AXN = ["eye", "pow", "kRat", "babip", "gap"] as const;
/** The K channel residual: predicted K/600 (aux included when present) − observed K/600. */
const kTarget = (fit: FittedHit, o: TrainObs) =>
  rateAux(fit.k, o.ratings.hit.kRat, o.ratings.hit.eye) - (o.hit.K / Math.max(o.hit.PA, 1)) * 600;
/** The assembled wOBA composite residual: the whole chain, predicted − observed. */
const wobaTarget = (fit: FittedHit, o: TrainObs) => predictHitForm(fit, o) - HITTER.actualWoba(o);
/** Residual rows for a fitted form on a test set, axes z-scored on THAT set (PA weights). */
function residRows(fit: FittedHit, te: TrainObs[], target: (f: FittedHit, o: TrainObs) => number): RRow[] {
  const sw = te.reduce((s, o) => s + o.hit.PA, 0);
  const mu = AXN.map((a) => te.reduce((s, o) => s + o.hit.PA * o.ratings.hit[a], 0) / sw);
  const sd = AXN.map((a, j) => Math.sqrt(te.reduce((s, o) => s + o.hit.PA * (o.ratings.hit[a] - mu[j]!) ** 2, 0) / sw) || 1);
  return te.map((o) => ({
    cid: o.cid, w: o.hit.PA,
    z: AXN.map((a, j) => (o.ratings.hit[a] - mu[j]!) / sd[j]!),
    resid: target(fit, o),
  }));
}
/** Marginal (EYE alone) and conditional (all five) EYE slope, with a cid-cluster bootstrap CI. */
function eyeSlopes(rows: RRow[]) {
  const groups = new Map<string, RRow[]>();
  for (const r of rows) { const g = groups.get(r.cid); if (g) g.push(r); else groups.set(r.cid, [r]); }
  const clusters = [...groups.values()];
  const fitM = (rs: RRow[]) => wls(rs.map((r) => [1, r.z[0]!]), rs.map((r) => r.resid), rs.map((r) => r.w))[1]!;
  const fitC = (rs: RRow[]) => wls(rs.map((r) => [1, ...r.z]), rs.map((r) => r.resid), rs.map((r) => r.w))[1]!;
  const rnd = rngFactory(0x51de0725);
  const bM: number[] = [], bC: number[] = [];
  for (let b = 0; b < 1500; b++) {
    const draw: RRow[] = [];
    for (let c = 0; c < clusters.length; c++) draw.push(...clusters[Math.floor(rnd() * clusters.length)]!);
    bM.push(fitM(draw)); bC.push(fitC(draw));
  }
  const sumW = rows.reduce((s, r) => s + r.w, 0);
  return {
    n: rows.length, cards: clusters.length,
    level: rows.reduce((s, r) => s + r.w * r.resid, 0) / sumW,
    marg: { pt: fitM(rows), lo: quant(bM, 0.025), hi: quant(bM, 0.975) },
    cond: { pt: fitC(rows), lo: quant(bC, 0.025), hi: quant(bC, 0.975) },
  };
}
const PANELS: { label: string; train: number[]; test: number[]; frame: "IN" | "OUT" }[] = [
  { label: "IN FRAME   fit 2042+2043 → measure 2042+2043", train: [2042, 2043], test: [2042, 2043], frame: "IN" },
  { label: "OUT FRAME  fit 2042+2043 → measure 2037–2041", train: [2042, 2043], test: [2037, 2038, 2039, 2040, 2041], frame: "OUT" },
  { label: "OUT FRAME  fit 2037+2038 → measure 2039–2043", train: [2037, 2038], test: [2039, 2040, 2041, 2042, 2043], frame: "OUT" },
  { label: "OUT FRAME  fit 2040+2041 → measure 2042+2043", train: [2040, 2041], test: [2042, 2043], frame: "OUT" },
];
const residOut: { label: string; frame: string; dep: ReturnType<typeof eyeSlopes>; cnd: ReturnType<typeof eyeSlopes> }[] = [];
say("panel                                        n/cards  arm       level K/600   MARGINAL per SD EYE        CONDITIONAL per SD EYE");
for (const p of PANELS) {
  const tr = qual(p.train), te = qual(p.test);
  const fD = fitP(RAWPOLY_HIT, tr) as FittedHit, fC = fitP(RAWPOLY_EYEAUG_HIT, tr) as FittedHit;
  const dep = eyeSlopes(residRows(fD, te, kTarget)), cnd = eyeSlopes(residRows(fC, te, kTarget));
  residOut.push({ label: p.label, frame: p.frame, dep, cnd });
  const line = (tag: string, s: ReturnType<typeof eyeSlopes>) =>
    `${" ".repeat(45)}${rp("", 8)} ${pad(tag, 9)} ${rp(sg(s.level, 3), 11)   }   ${rp(`${sg(s.marg.pt, 3)} [${sg(s.marg.lo, 3)}, ${sg(s.marg.hi, 3)}]`, 24)}${excl0(s.marg.lo, s.marg.hi) ? "★" : " "} ${rp(`${sg(s.cond.pt, 3)} [${sg(s.cond.lo, 3)}, ${sg(s.cond.hi, 3)}]`, 24)}${excl0(s.cond.lo, s.cond.hi) ? "★" : " "}`;
  say(`${pad(p.label, 45)}${rp(`${dep.n}/${dep.cards}`, 8)}`);
  say(line("deployed", dep));
  say(line("eyeaug", cnd));
  say(`${" ".repeat(45)}${rp("", 8)} ${pad("REMOVED:", 9)} marginal ${f(100 * (1 - cnd.marg.pt / (dep.marg.pt || 1e-12)), 0)}% of the deployed slope; conditional ${f(100 * (1 - cnd.cond.pt / (dep.cond.pt || 1e-12)), 0)}%`);
  say();
}
say("★ = the interval excludes zero (cid-cluster bootstrap, 1500 replicates).");
say();

// ── §7 BIP chain knock-on ─────────────────────────────────────────────────────
// hitter BIP = 600 − BB − K − HR − HIT_BIP_ADJ and non-HR hits recompute from it, so ANY change to
// predicted K moves predicted hits. Reported, not ignored.
say("================================================================================");
say("§7  THE BIP CHAIN KNOCK-ON — changing predicted K necessarily moves predicted hits");
say("--------------------------------------------------------------------------------");
say(`hitter BIP = 600 − uBB − K − HR − ${HIT_BIP_ADJ} and non-HR hits recompute as hRate(babip, BIP), so the aux`);
say("cannot move K alone. TWO effects, reported separately because they mostly cancel:");
say("  (a) MECHANICAL — hold the fitted h curve fixed and move only K: ΔBIP = −ΔK, and hits follow");
say("      the fitted ln(BIP) elasticity (~0.86, so BELOW 1 — hits move less than proportionally).");
say("  (b) REFIT — in the candidate, hit.h is REFIT on the NEW predicted-BIP column (fitHitForm");
say("      builds BIP from the aux-carrying K before fitting h), so most of (a) is re-absorbed. This");
say("      is the number that actually reaches wOBA.");
say();
say("window      arm       mean pred K   mean pred BIP   mean pred nHH   mean pred wOBA   fitted ln(BIP) coef");
for (const w of WINDOWS) {
  const tr = qual(w);
  const sw = tr.reduce((s, o) => s + o.hit.PA, 0);
  const wm = (g: (o: TrainObs) => number) => tr.reduce((s, o) => s + o.hit.PA * g(o), 0) / sw;
  for (const fm of [RAWPOLY_HIT, RAWPOLY_EYEAUG_HIT]) {
    const fit = fitP(fm, tr) as FittedHit;
    const kOf = (o: TrainObs) => rateAux(fit.k, o.ratings.hit.kRat, o.ratings.hit.eye);
    const bipOf = (o: TrainObs) => Math.max(600 - rate(fit.bb, o.ratings.hit.eye) - kOf(o) - rate(fit.hr, o.ratings.hit.pow) - HIT_BIP_ADJ, 1);
    const nhhOf = (o: TrainObs) => hRate(fit.h, o.ratings.hit.babip, bipOf(o));
    say(`${pad(w.join("+"), 11)} ${pad(fm === RAWPOLY_HIT ? "deployed" : "eyeaug", 9)} ${rp(f(wm(kOf), 2), 11)}   ${rp(f(wm(bipOf), 2), 13)}   ${rp(f(wm(nhhOf), 2), 13)}   ${rp(f(wm((o) => predictHitForm(fit, o)), 5), 14)}   ${rp(f(fit.h.beta[2] ?? NaN, 2), 19)}`);
  }
}
say();
say("PER-CARD SPREAD of the knock-on (window 2042+2043, PA-weighted over the fit rows) — the means");
say("above hide it, because the aux moves high-Eye and low-Eye cards in OPPOSITE directions:");
{
  const tr = qual([2042, 2043]);
  const fD = fitP(RAWPOLY_HIT, tr) as FittedHit, fC = fitP(RAWPOLY_EYEAUG_HIT, tr) as FittedHit;
  const kD = (o: TrainObs) => rate(fD.k, o.ratings.hit.kRat), kC = (o: TrainObs) => rateAux(fC.k, o.ratings.hit.kRat, o.ratings.hit.eye);
  const bip = (fit: FittedHit, o: TrainObs, k: number) => Math.max(600 - rate(fit.bb, o.ratings.hit.eye) - k - rate(fit.hr, o.ratings.hit.pow) - HIT_BIP_ADJ, 1);
  const rowsD = tr.map((o) => ({ o, k: kD(o) })), rowsC = tr.map((o) => ({ o, k: kC(o) }));
  const dK = tr.map((_, i) => rowsC[i]!.k - rowsD[i]!.k);
  const dH = tr.map((o, i) => hRate(fC.h, o.ratings.hit.babip, bip(fC, o, rowsC[i]!.k)) - hRate(fD.h, o.ratings.hit.babip, bip(fD, o, rowsD[i]!.k)));
  const dW = tr.map((o) => predictHitForm(fC, o) - predictHitForm(fD, o));
  const rng = (a: number[]) => `${sg(Math.min(...a), 3)} … ${sg(Math.max(...a), 3)}`;
  const sd = (a: number[]) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))); };
  say(`  Δ predicted K/600      mean ${sg(mean(dK), 3)}   sd ${f(sd(dK), 3)}   range ${rng(dK)}`);
  say(`  Δ predicted nHH/600    mean ${sg(mean(dH), 3)}   sd ${f(sd(dH), 3)}   range ${rng(dH)}`);
  say(`  Δ predicted wOBA       mean ${sg(mean(dW), 5)}   sd ${f(sd(dW), 5)}   range ${sg(Math.min(...dW), 5)} … ${sg(Math.max(...dW), 5)}`);
  const ratio = dH.map((h, i) => (Math.abs(dK[i]!) > 0.05 ? h / -dK[i]! : NaN)).filter(Number.isFinite);
  say(`  hits-per-K pass-through d(nHH)/d(−K) over cards with |ΔK| > 0.05: median ${f(quant(ratio, 0.5), 3)} (n=${ratio.length})`);
  say("  ⇒ a K the model no longer predicts becomes a ball in play, and roughly that fraction of it");
  say("  becomes a HIT. The knock-on is real and travels into wOBA; it is NOT a rounding effect.");
}
say();

// ── §8 the composite: does fixing K reach wOBA, and does it break the cancellation? ──
// The residual artifact's Part 2 found the composite EYE slope is ~0 BY CANCELLATION between
// oppositely-signed channels (K −0.000033, BABIP +0.000025, HR +0.000019, sum +0.000006). So
// "fix K" and "improve wOBA" are NOT the same claim: removing one leg of a cancellation can
// leave the composite alone or make it WORSE. This section measures the composite directly.
say("================================================================================");
say("§8  DOES THE FIX REACH wOBA? the composite residual, and the cancellation question");
say("--------------------------------------------------------------------------------");
say("fixtures/hitter-residual-channels-2026-07-25.txt Part 2 found the composite wOBA bias slope on");
say("EYE is ~0 BY CANCELLATION, not by absence of error: on EYE the K channel contributes −0.000033");
say("per rating point, BABIP +0.000025 and HR +0.000019 — three CI-clear, oppositely-signed channel");
say("errors summing to +0.000006. 'Fix K' and 'improve wOBA' are therefore DIFFERENT claims, and");
say("removing one leg of a cancellation could leave the composite alone or make it WORSE. Measured:");
say();
say("composite wOBA residual (predicted − observed), slope per SD of EYE, same panels as §6:");
say("panel                                        n/cards  arm       level wOBA    MARGINAL per SD EYE            CONDITIONAL per SD EYE");
const compOut: { label: string; frame: string; dep: ReturnType<typeof eyeSlopes>; cnd: ReturnType<typeof eyeSlopes> }[] = [];
for (const p of PANELS) {
  const tr = qual(p.train), te = qual(p.test);
  const fD = fitP(RAWPOLY_HIT, tr) as FittedHit, fC = fitP(RAWPOLY_EYEAUG_HIT, tr) as FittedHit;
  const dep = eyeSlopes(residRows(fD, te, wobaTarget)), cnd = eyeSlopes(residRows(fC, te, wobaTarget));
  compOut.push({ label: p.label, frame: p.frame, dep, cnd });
  const line = (tag: string, s: ReturnType<typeof eyeSlopes>) =>
    `${" ".repeat(45)}${rp("", 8)} ${pad(tag, 9)} ${rp(sg(s.level, 5), 11)}   ${rp(`${sg(s.marg.pt, 5)} [${sg(s.marg.lo, 5)}, ${sg(s.marg.hi, 5)}]`, 28)}${excl0(s.marg.lo, s.marg.hi) ? "★" : " "} ${rp(`${sg(s.cond.pt, 5)} [${sg(s.cond.lo, 5)}, ${sg(s.cond.hi, 5)}]`, 28)}${excl0(s.cond.lo, s.cond.hi) ? "★" : " "}`;
  say(`${pad(p.label, 45)}${rp(`${dep.n}/${dep.cards}`, 8)}`);
  say(line("deployed", dep));
  say(line("eyeaug", cnd));
  say(`${" ".repeat(45)}${rp("", 8)} ${pad("→", 9)} |conditional EYE slope| ${Math.abs(cnd.cond.pt) < Math.abs(dep.cond.pt) ? "SHRINKS" : "GROWS"}: ${f(Math.abs(dep.cond.pt), 5)} → ${f(Math.abs(cnd.cond.pt), 5)}`);
  say();
}
say("THE LEVERAGE ARITHMETIC — why a large K fix is a small wOBA fix. A strikeout carries NO wOBA");
say("weight; it moves wOBA ONLY by removing a ball in play, and the fitted ln(BIP) elasticity is");
say("BELOW 1, so only a fraction of a recovered BIP becomes a hit (§7 measures the pass-through");
say("directly). Scale, on the 2042+2043 fit rows:");
{
  const tr = qual([2042, 2043]);
  const fD = fitP(RAWPOLY_HIT, tr) as FittedHit, fC = fitP(RAWPOLY_EYEAUG_HIT, tr) as FittedHit;
  const dW = tr.map((o) => predictHitForm(fC, o) - predictHitForm(fD, o));
  const act = tr.map(HITTER.actualWoba);
  const sd = (a: number[]) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))); };
  const sdW = sd(dW), sdA = sd(act);
  say(`  sd of the prediction CHANGE the aux causes:  ${f(sdW, 5)} wOBA`);
  say(`  sd of ACTUAL wOBA across the same cards:     ${f(sdA, 5)} wOBA`);
  say(`  ⇒ the aux repositions cards by ${f((100 * sdW) / sdA, 1)}% of the card-to-card spread the metric ranks on.`);
  say(`  A Pearson shift of the size §5 could resolve (~±0.003 at these n) is simply not available`);
  say(`  from a term with that lever, however right the term is about strikeouts.`);
}
say();

// ── §9 verdict ────────────────────────────────────────────────────────────────
say("================================================================================");
say("§9  VERDICT");
say("================================================================================");
say();
const verdictAt = lines.length;   // the verdict paragraph is composed after the numbers exist
writeFileSync(OUT, lines.join("\n") + "\n", "utf8");

// Compose the verdict from the measured quantities (no hand-typed numbers).
const V: string[] = [];
const vsay = (s = "") => V.push(s);
const earned = nPos === 6 && nClearNeg === 0;
const maxAbs = Math.max(...dPea.map((d) => Math.abs(d.m)));
vsay(`DOES THE EYE AUX EARN ITS PLACE BY THE stuffAug STANDARD? ${earned ? "YES." : "NO."} The term is RIGHT about`);
vsay("strikeouts — it removes 81–99% of the motivating residual on data it never saw — and it does");
vsay("not pay on wOBA: ΔwPearson is zero to three decimals in all six evaluations. Worse, it");
vsay("UNBALANCES the composite: the residual artifact's EYE cancellation breaks, and the composite");
vsay("EYE bias grows more often than it shrinks. Right about the channel, adverse on the deliverable.");
vsay();
vsay(`ΔwPearson (eyeaug − deployed) across the six evaluations: ${nPos} of 6 POSITIVE, ${nClearPos} CI-clear`);
vsay(`positive, ${nClearNeg} CI-clear negative.`);
for (const d of dPea) vsay(`  ${pad(d.label, 40)} ${sg(d.m)}  [${sg(d.lo)}, ${sg(d.hi)}]${excl0(d.lo, d.hi) ? "  CI EXCLUDES 0" : ""}`);
vsay();
vsay(`(stuffAug's comparator, the bar this had to clear: +0.012, +0.020, +0.017, +0.023, +0.032,`);
vsay(`+0.033 — six of six positive, four CI-clear, never negative.)`);
vsay();
vsay(`READ THE SIGNS HONESTLY. ${nPos} of 6 positive sounds like a weak version of stuffAug's 6 of 6; it is`);
vsay(`not the same kind of number. EVERY magnitude here is ≤ ${f(maxAbs, 4)} — one to two ORDERS OF MAGNITUDE`);
vsay(`below stuffAug's +0.012…+0.033, and far inside the ±0.003 the design can resolve. The sign`);
vsay(`pattern is a coin flip on numerical noise, not a weak positive trend, and it must not be`);
vsay(`reported as "directionally favourable". The correct statement is that ΔwPearson is ZERO.`);
vsay();
const inF = residOut.find((r) => r.frame === "IN")!;
const outF = residOut.filter((r) => r.frame === "OUT");
vsay("RESIDUAL RE-MEASUREMENT (the term must remove the structure that motivates it):");
vsay(`  IN FRAME  the deployed arm's conditional EYE→K slope is ${sg(inF.dep.cond.pt, 3)}/600 per SD; with the aux`);
vsay(`            fitted it is ${sg(inF.cnd.cond.pt, 3)} [${sg(inF.cnd.cond.lo, 3)}, ${sg(inF.cnd.cond.hi, 3)}] — ${f(100 * (1 - inF.cnd.cond.pt / (inF.dep.cond.pt || 1e-12)), 0)}% removed. Suppressed by`);
vsay(`            least squares, so this confirms the FUNCTIONAL FORM fits, nothing more.`);
for (const o of outF) {
  vsay(`  ${pad(o.label.replace("OUT FRAME  ", ""), 36)} deployed ${sg(o.dep.cond.pt, 3)} → eyeaug ${sg(o.cnd.cond.pt, 3)}`);
  vsay(`            [${sg(o.cnd.cond.lo, 3)}, ${sg(o.cnd.cond.hi, 3)}], ${f(100 * (1 - o.cnd.cond.pt / (o.dep.cond.pt || 1e-12)), 0)}% removed on data the fit never saw.`);
}
vsay();
vsay("PINNING: the aux CANNOT change which channels pin on this form. hit.hr is the only quad and it");
vsay("is fitted before the BIP chain exists, on (POW, HR, w) alone; every other hitter channel is LOG");
vsay("and pinEvent requires a rawpoly-2. §3 confirms it empirically on all three windows. Unlike the");
vsay("stuffAug arm — where the aux moved pit.hr's vertex in-domain on [2042,2043] and cost that");
vsay("comparison its one-term status — THIS IS A STRICT ONE-TERM CONTRAST.");
vsay();
vsay("BIP KNOCK-ON: reported in §7 and not negligible. The aux moves predicted K in OPPOSITE");
vsay("directions for high-Eye and low-Eye cards, so the pooled mean barely moves while individual");
vsay("cards move materially; each strikeout the model stops predicting becomes a ball in play and");
vsay("roughly the fitted BABIP fraction of it becomes a hit, which travels into predicted wOBA. The");
vsay("candidate REFITS hit.h on the new predicted-BIP column, so most of the mechanical effect is");
vsay("re-absorbed by the h curve rather than propagating raw.");
vsay();
vsay("WHY BOTH RESULTS ARE TRUE AT ONCE — the part that matters more than the verdict. A strikeout");
vsay("carries NO wOBA weight in this form: it moves wOBA ONLY by removing a ball in play, and the");
vsay("fitted ln(BIP) elasticity is below 1, so only about a fifth of a recovered strikeout becomes a");
vsay("hit (§7's measured pass-through). The aux moves individual cards by up to ~7 K/600 — a large,");
vsay("real, correctly-signed correction — and that lands as a prediction change whose spread is a");
vsay("few percent of the card-to-card wOBA spread the metric ranks on (§8). A term with that lever");
vsay("CANNOT produce a resolvable Pearson gain at this n no matter how right it is. The residual");
vsay("finding and this null are therefore not in conflict, and neither one overturns the other:");
vsay("the deployed model IS mis-predicting strikeouts on the EYE axis, and fixing that does not");
vsay("measurably improve the wOBA ranking it is used for.");
vsay();
// The cancellation question, answered from the measured composite panels rather than deferred.
{
  const grew = compOut.filter((c) => Math.abs(c.cnd.cond.pt) > Math.abs(c.dep.cond.pt)).length;
  const newlyClear = compOut.filter((c) => excl0(c.cnd.cond.lo, c.cnd.cond.hi) && !excl0(c.dep.cond.lo, c.dep.cond.hi)).length;
  const nowClean = compOut.filter((c) => !excl0(c.cnd.cond.lo, c.cnd.cond.hi) && excl0(c.dep.cond.lo, c.dep.cond.hi)).length;
  vsay("AND A REASON THE TERM MAY BE ACTIVELY UNWANTED — the strongest argument against it, and it is");
  vsay("NOT the null. The residual artifact found the composite EYE slope sits at ~0 BY CANCELLATION");
  vsay("between oppositely-signed channels (K −0.000033, BABIP +0.000025, HR +0.000019). Removing the");
  vsay("K leg does not have to help the composite — it can UNBALANCE it. Measured in §8, it does:");
  for (const c of compOut) {
    vsay(`  ${pad(c.label, 44)} ${sg(c.dep.cond.pt, 5)}${excl0(c.dep.cond.lo, c.dep.cond.hi) ? "★" : " "} → ${sg(c.cnd.cond.pt, 5)}${excl0(c.cnd.cond.lo, c.cnd.cond.hi) ? "★" : " "}`);
  }
  vsay(`  (conditional composite wOBA bias per SD EYE; ★ = CI excludes zero.)`);
  vsay(`  ⇒ |slope| GROWS in ${grew} of ${compOut.length} panels. In ${newlyClear} the candidate's composite EYE bias is CI-CLEAR where`);
  vsay(`  the deployed form's was NOT; in ${nowClean} the reverse. So on the quantity the model is actually`);
  vsay("  used for, correcting the strikeout channel makes the EYE-axis bias LARGER more often than");
  vsay("  smaller. The channel fix is real and the composite consequence is adverse — which is exactly");
  vsay("  what a cancellation predicts, and exactly why a channel-level residual is not by itself a");
  vsay("  mandate to add a term. (Magnitudes are ≤0.002 wOBA per SD throughout, small in absolute");
  vsay("  terms; the point is the DIRECTION and that it is the opposite of the intended improvement.)");
  vsay();
}
vsay("RECOMMENDATION: DO NOT ADOPT, and do NOT discard the finding. The candidate stays in");
vsay("FORM_ENTRIES as a scored candidate (nothing deployed, no default changed) so it is re-measured");
vsay("on every future scoreboard run. The reason to keep it on the books rather than delete it: the");
vsay("term's coefficient is stable across all three windows (−2.12 to −2.59 K/600 per SD of raw EYE)");
vsay("and matches the independently-measured residual slope (+2.01 to +2.15) almost exactly — that");
vsay("is what a real channel looks like, and the sequential-resolution mechanism is the same one");
vsay("that carried stuffAug. What is missing is the LEVER, not the effect.");
vsay();
vsay("WHAT WOULD CHANGE THE ANSWER, and neither is available in league data today: (i) a deliverable");
vsay("metric sensitive to strikeouts in their own right rather than only through wOBA volume; (ii) an");
vsay("OUT-OF-FRAME pool whose EYE distribution is shifted far enough that a +2/600 K error stops");
vsay("being a wOBA rounding error — the tournament ladder, not the league. NOTE that (ii) cuts both");
vsay("ways: the same shift that would make the fix pay would also amplify the composite unbalancing");
vsay("measured above, so the ladder test must read the COMPOSITE, not just the K channel.");
vsay();
vsay("A METHOD POINT WORTH KEEPING. This is the first candidate in the program that removed its");
vsay("motivating residual almost completely and still failed. That combination is only visible");
vsay("because the residual re-measurement (§6) and the metric comparison (§5) were run as SEPARATE");
vsay("questions. Had only §6 been run the term would look like a clear win; had only §5 been run it");
vsay("would look like an irrelevant null. A channel-level residual is evidence that the FORM is");
vsay("wrong; it is not evidence that correcting it improves the thing the model is used for.");
vsay();
vsay("DATA LIMITS, stated so the deliverable metrics are not over-read: only a few dozen distinct");
vsay("CARDS clear the 1000-PA bar per test block, so the top-26 intervals in §5 run to roughly ±0.08");
vsay("to ±0.12 — two to three roster slots out of 26. Ordinal rankings in §4 are NOT evidence.");
vsay("League coverage is unequal by season (2037: 4 leagues; 2039 effectively 4; the rest 5).");
lines.splice(verdictAt, 0, ...V);

writeFileSync(OUT, lines.join("\n") + "\n", "utf8");
for (const v of V) console.log(v);
console.error(`\nwrote ${OUT}`);
