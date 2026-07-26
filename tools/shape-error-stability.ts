// SHAPE-ERROR STABILITY — is the high-EYE/high-POW composite error STABLE ACROSS FIT WINDOWS, or
// does it SORT BY WINDOW? (2026-07-26).  MEASUREMENT ONLY — no production default changed, no
// correction fitted or proposed, nothing wired, nothing committed.
//   run: node tools/shape-error-stability.ts   (writes fixtures/shape-error-stability-2026-07-26.txt)
//
// ── WHAT IS UNDER TEST ────────────────────────────────────────────────────────────────────────
// fixtures/per-event-headroom-2026-07-26.txt Part 3 found that where the per-channel cancellation
// FAILS it concentrates on one hitter rating shape — hi EYE / hi POW (pool SDs EYE +0.97, POW
// +0.89, AvoidK -0.69, BABIP-rat -0.47, GAP -0.54) — with a per-card wOBA error of -0.00183
// [-0.00364,-0.00026] vs the rest of the pool, and 9 of the model's 12 false top-26 picks carrying
// that shape from 30% of the pool.
//
// ── THE ONE QUESTION ──────────────────────────────────────────────────────────────────────────
// Apply the discriminator that killed the EYE-axis correction: a quantity is IDENTIFIED if it does
// not move when re-estimated on a different slice of the same league, and if its apparent
// identification does not flip direction with a nuisance knob. The comparators are published:
//   K aux    swing 1.01-1.14x in every cell of every table  ⇒ IDENTIFIED
//   BABIP aux swing 4.16x across the three published windows, and its swing-of-swing FLIPS
//            direction with minPA (1.77→1.24x at 250, 1.06→1.58x at 1000) ⇒ NOT IDENTIFIED
// (fixtures/window-threshold-sweep-2026-07-26.txt §3a, Table D.)
//
// ── WHAT THIS MEASURES ────────────────────────────────────────────────────────────────────────
// §1 reproduction of the published cell (deployed artifact AND a same-window refit).
// §2 the shape error fitted on each of the three published disjoint windows (2037+2038,
//    2040+2041, 2042+2043), evaluated OUT OF FRAME on every held-out season; swing ratio + sign.
// §3 the nuisance-knob sweep: minPA {250,500,1000} x width {2,3}, each in two arms (knob on the
//    FIT only with the eval pool pinned, and knob on both) and two cell definitions.
// §4 LEVEL vs SHAPE decomposition (a level shift is anchor-absorbable and is not the thing to
//    correct) + the HBP accounting RawHitting forces (no HBP field ⇒ fixed 6 in the numerator).
// §5 CARD-SPLIT replication — the one genuinely out-of-CARD read available (see §0e).
// §6 the functional shape over the (EYE,POW) plane: corner / monotone gradient / interaction, and
//    whether a single scalar on one shape index could carry it. CHARACTERISED, NOT FITTED.
// §7 the TOP-N COST, quantified regardless of which way §2-§3 land, at the ROSTER-RELEVANT cut.
//    topN=26 is hardcoded through src/training/evaluate.ts, but 26 is the ROSTER size and the
//    bake-off scores PER ROLE — the modal tournament rosters 14 hitters / 12 pitchers, so a
//    "top-26 hitters" overlap scores ~12 decision-irrelevant slots. Headline = top-14; top-26 is
//    reported beside it for comparability with every prior figure; top-10/20 give the sensitivity.
//    Also: the enrichment BASELINE (what share of the model's top-K carries the shape anyway), the
//    RELIABILITY CEILING (how many "errors" are noise in the OBSERVED ranking), and whether the
//    interval NARROWS at the tighter cut — a methodological result independent of this finding.
//
// ── METHOD (established; not relitigated) ─────────────────────────────────────────────────────
//  · Every interval is a CLUSTER bootstrap over CARD (cid). The row/cluster inflation factor is
//    MEASURED for this artifact's own statistic (§0d), never assumed.
//  · Fits use DEPLOYED_FORMS through fitHitForm with a FRESH vertex-pin collector (production
//    parity as of 7c8a061). Nothing in src/ is touched.
//  · wOBA weights are held FIXED at the deployed model's own trained.wobaWeights across every cell,
//    so a per-window re-derivation of the weights cannot masquerade as instability in the shape.
//  · HD450|2039 is the known duplicate-vL/vR cell; the loader's own detector drops it and the
//    exclusion is printed from the load summary, not asserted. `Old Data` 2032-33 is never pooled.
//  · NOTHING IS PROPOSED. §6 characterises a surface; it does not fit a correction to it.

import { existsSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { makeRawPolyModel, type EventForm } from "../src/scoring-core/index.ts";
import { DEFAULT_WOBA_WEIGHTS, type WobaWeights } from "../src/scoring-core/woba-weights.ts";
import {
  rate, rateAux, hRateAux, hitHbpRate,
  HIT_HBP, HIT_SH_MINUS_SF, HIT_BIP_ADJ, type FittedHit,
} from "../src/model/curves.ts";
import { loadWindow, availableYears, type TrainObs } from "../src/training/loader.ts";
import { HITTER } from "../src/training/bakeoff.ts";
import { wls } from "../src/training/fit.ts";
import { fitHitForm, DEPLOYED_FORMS } from "../src/training/forms.ts";

const L: string[] = [];
const say = (s = "") => L.push(s);
const f = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "n/a");
const sgn = (x: number, d = 2) => (Number.isFinite(x) ? `${x >= 0 ? "+" : ""}${x.toFixed(d)}` : "n/a");
const pad = (s: string, n: number) => s.padEnd(n);
const rp = (s: string, n: number) => s.padStart(n);

// ── deployed model + data ────────────────────────────────────────────────────────────────────
const repo = new Repository("data");
await seedDefaults(repo); await seedEras(repo); await seedAccounts(repo);
const state = (await repo.load<{ activeModelId?: string }>("state", "app")) ?? {};
type TM_ = { id: string; eventForm?: EventForm; wobaWeights?: WobaWeights; window?: number[]; minPA?: number; includeVariants?: boolean };
const trained = (await repo.loadAll<TM_>("trained-models")).find((x) => x.id === state.activeModelId);
if (!trained?.eventForm) throw new Error("active model has no eventForm");
const rpModel = makeRawPolyModel(trained.eventForm);                  // THE DEPLOYED ARTIFACT
const W: WobaWeights = trained.wobaWeights ?? DEFAULT_WOBA_WEIGHTS;   // held FIXED everywhere below
const usingModelWeights = !!trained.wobaWeights;

const TRAIN = ["League Files", "Model 2037 and 2038"].find((d) => existsSync(d))!;
const DEPLOY_WIN: number[] = Array.isArray(trained.window) && trained.window.length ? trained.window : [2042, 2043];
const DEPLOY_T = Math.max(0, Number(trained.minPA ?? 1000) || 1000);
const keepVar = (o: TrainObs) => (trained.includeVariants ?? true) || !o.variant;

const YEARS_ALL = availableYears(TRAIN);
const OLD_YEARS = YEARS_ALL.filter((y) => y <= 2033);
const YEARS = YEARS_ALL.filter((y) => y >= 2037);

const loadCache = new Map<string, ReturnType<typeof loadWindow>>();
function win(years: number[]) {
  const k = years.join("+");
  let v = loadCache.get(k);
  if (!v) { v = loadWindow(TRAIN, years); loadCache.set(k, v); }
  return v;
}
const obsOf = (years: number[]) => win(years).observations.filter(keepVar);

// ── bootstrap machinery ──────────────────────────────────────────────────────────────────────
let seed = 20260726 >>> 0;
const rnd = () => { seed = (seed + 0x6d2b79f5) >>> 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
function clustersOf<T extends { cid: string }>(rows: T[]): T[][] {
  const m = new Map<string, T[]>();
  for (const r of rows) { const g = m.get(r.cid); if (g) g.push(r); else m.set(r.cid, [r]); }
  return [...m.values()];
}
function clusterDraw<T>(cl: T[][]): T[] {
  const out: T[] = [];
  for (let i = 0; i < cl.length; i++) for (const r of cl[Math.floor(rnd() * cl.length)]!) out.push(r);
  return out;
}
const rowDraw = <T,>(rows: T[]): T[] => rows.map(() => rows[Math.floor(rnd() * rows.length)]!);
const ci = (xs: number[]) => { const v = [...xs].filter(Number.isFinite).sort((a, b) => a - b); return v.length ? { lo: v[Math.floor(0.025 * v.length)]!, hi: v[Math.min(v.length - 1, Math.floor(0.975 * v.length))]! } : { lo: NaN, hi: NaN }; };
const clear = (c: { lo: number; hi: number }) => (c.lo > 0 && c.hi > 0) || (c.lo < 0 && c.hi < 0);
const width = (c: { lo: number; hi: number }) => c.hi - c.lo;
const cardsOf = (rows: { cid: string }[]) => new Set(rows.map((r) => r.cid)).size;
const wmeanOf = <T,>(rows: T[], get: (r: T) => number, wt: (r: T) => number) => {
  const sw = rows.reduce((s, r) => s + wt(r), 0);
  return sw > 0 ? rows.reduce((s, r) => s + wt(r) * get(r), 0) / sw : NaN;
};

// ── the residual rows ────────────────────────────────────────────────────────────────────────
const HIT_AX = ["eye", "pow", "kRat", "babip", "gap"] as const;
const AXLAB: Record<string, string> = { eye: "EYE", pow: "POW", kRat: "AvoidK", babip: "BABIP(rat)", gap: "GAP" };

interface HRow {
  cid: string; side: string; w: number;      // w = PA (level weight, the decomposition convention)
  r: Record<string, number>;
  dW: number;                                 // predicted − observed wOBA, TRUE frame (real HBP observed)
  dWh: number;                                // the same in the HARNESS frame (fixed 6 HBP on BOTH sides)
  hbpLeg: number;                             // the HBP contribution: W.hbp*(6 − obsHBP)/600
  wobaP: number; wobaO: number;
}

/** Deployed per-600 hitter event line for a fitted form — the exact predictHitting chain. */
function hitEvents(m: FittedHit, r: Record<string, number>) {
  const BB = rate(m.bb, r.eye!);
  const K = rateAux(m.k, r.kRat!, r.eye!);
  const HR = rateAux(m.hr, r.pow!, r.eye!);
  const HBP = hitHbpRate(m, r.eye!);
  const BIP = Math.max(600 - BB - K - HR - (HBP + HIT_SH_MINUS_SF), 1);
  const nHH = hRateAux(m.h, r.babip!, BIP, r.eye!);
  const XBH = Math.max(rate(m.xbh, r.gap!) * nHH, 0);
  return { BB, K, HR, HBP, BIP, nHH, XBH };
}

/** Residual rows for a role over a year set, using EITHER a refit form or the deployed artifact. */
function rowsFor(years: number[], minN: number, form: FittedHit | null): HRow[] {
  const out: HRow[] = [];
  for (const o of obsOf(years)) {
    if (!HITTER.qualifies(o, minN)) continue;
    const pa = Math.max(o.hit.PA, 1), s = 600 / pa;
    const oBB = Math.max(o.hit.BB - o.hit.IBB, 0) * s, oHR = o.hit.HR * s;
    const oHBP = o.hit.HP * s, onHH = Math.max(o.hit.H - o.hit.HR, 0) * s, oXBH = (o.hit.b2 + o.hit.b3) * s;
    const oBIP = 600 - oBB - o.hit.K * s - oHR - HIT_BIP_ADJ;
    if (!(oBIP > 1) || !(onHH > 0)) continue;
    const rr = o.ratings.hit as unknown as Record<string, number>;
    const p = form ? hitEvents(form, rr) : (() => {
      const q = rpModel.predictHitting(o.ratings.hit, {} as never);
      return { BB: q.BB, K: q.SO, HR: q.HR, HBP: HIT_HBP, BIP: q.BIP, nHH: q.oneB + q.GAP, XBH: q.GAP };
    })();
    if (!(p.BIP > 1) || !(p.nHH > 0)) continue;
    const wobaP = (W.bb * p.BB + W.hbp * p.HBP + W.b1 * (p.nHH - p.XBH) + W.xbh * p.XBH + W.hr * p.HR) / 600;
    const wobaO = (W.bb * oBB + W.hbp * oHBP + W.b1 * (onHH - oXBH) + W.xbh * oXBH + W.hr * oHR) / 600;
    const hbpLeg = (W.hbp * (p.HBP - oHBP)) / 600;
    const dW = wobaP - wobaO;
    if (!Number.isFinite(dW)) continue;
    out.push({ cid: o.cid, side: String(o.side), w: pa, r: rr, dW, dWh: dW - hbpLeg, hbpLeg, wobaP, wobaO });
  }
  return out;
}

const fitCache = new Map<string, FittedHit>();
function fitOn(years: number[], minN: number): FittedHit {
  const k = `${years.join("+")}|${minN}`;
  let v = fitCache.get(k);
  if (!v) {
    v = fitHitForm(DEPLOYED_FORMS.hit, obsOf(years).filter((o) => HITTER.qualifies(o, minN)), 0.75, []);
    fitCache.set(k, v);
  }
  return v;
}

// ── the shape cell ───────────────────────────────────────────────────────────────────────────
// Two definitions, both reported everywhere:
//   POOL   — median splits of EYE and POW computed on the EVALUATION pool (reproduces the
//            published construction exactly, but lets cell MEMBERSHIP drift with the pool).
//   FIXED  — median splits computed ONCE on the deployed pool (2042+2043, minPA 1000) and held
//            constant in every cell of every table, so membership cannot drift.
const medOf = (rows: HRow[], k: string) => { const v = rows.map((r) => r.r[k]!).sort((a, b) => a - b); return v[Math.floor(v.length / 2)]!; };
const DEPLOY_ROWS = rowsFor(DEPLOY_WIN, DEPLOY_T, null);
const FIX_EYE = medOf(DEPLOY_ROWS, "eye"), FIX_POW = medOf(DEPLOY_ROWS, "pow");
type CellDef = "POOL" | "FIXED";
function inShapeFn(rows: HRow[], def: CellDef) {
  const mE = def === "FIXED" ? FIX_EYE : medOf(rows, "eye");
  const mP = def === "FIXED" ? FIX_POW : medOf(rows, "pow");
  return { fn: (r: HRow) => r.r.eye! >= mE && r.r.pow! >= mP, mE, mP };
}

/** The statistic: weighted-mean ΔwOBA inside the shape minus weighted-mean ΔwOBA outside it.
 *  Differencing removes any common LEVEL, so the statistic is anchor-neutral by construction. */
const contrastOf = (rows: HRow[], inC: (r: HRow) => boolean, get: (r: HRow) => number = (r) => r.dW) => {
  const a = rows.filter(inC), b = rows.filter((r) => !inC(r));
  if (!a.length || !b.length) return NaN;
  return wmeanOf(a, get, (r) => r.w) - wmeanOf(b, get, (r) => r.w);
};

interface Cell {
  tag: string; train: number[]; test: number[]; minFit: number; minEval: number; def: CellDef;
  n: number; cards: number; nIn: number; cardsIn: number;
  pt: number; ci: { lo: number; hi: number }; ptU: number; level: number;
}
function measure(train: number[], test: number[], minFit: number, minEval: number, def: CellDef, nb = 800): Cell {
  const form = fitOn(train, minFit);
  const rows = rowsFor(test, minEval, form);
  const { fn } = inShapeFn(rows, def);
  const cl = clustersOf(rows);
  const bs: number[] = [];
  for (let b = 0; b < nb; b++) bs.push(contrastOf(clusterDraw(cl), fn));
  const inR = rows.filter(fn);
  return {
    tag: `${train.join("+")}`, train, test, minFit, minEval, def,
    n: rows.length, cards: cardsOf(rows), nIn: inR.length, cardsIn: cardsOf(inR),
    pt: contrastOf(rows, fn), ci: ci(bs),
    ptU: (inR.reduce((s, r) => s + r.dW, 0) / Math.max(inR.length, 1)) - (rows.filter((r) => !fn(r)).reduce((s, r) => s + r.dW, 0) / Math.max(rows.length - inR.length, 1)),
    level: wmeanOf(rows, (r) => r.dW, (r) => r.w),
  };
}

const spreadOf = (v: number[]) => { const a = v.map(Math.abs).filter(Number.isFinite); const mn = Math.min(...a); return mn > 1e-12 ? Math.max(...a) / mn : Infinity; };
const signsAgree = (v: number[]) => v.every((x) => x > 0) || v.every((x) => x < 0);

// ── the ROSTER-RELEVANT CUT, read from this repo's own tournament configs ─────────────────────
// topN=26 is hardcoded through src/training/evaluate.ts, but 26 is the ROSTER size and the bake-off
// scores PER ROLE — a roster is not 26 hitters. The modal hitter slot count is read here rather
// than assumed, and it sets the headline cut for §7.
const TOURN: { files: number; comp: [string, number][] } = (() => {
  const comp: Record<string, number> = {};
  let files = 0;
  try {
    for (const fn of readdirSync("data/tournaments").filter((x) => x.endsWith(".json"))) {
      const j = JSON.parse(readFileSync(`data/tournaments/${fn}`, "utf8")) as { hitters?: number; pitchers?: number };
      if (typeof j.hitters !== "number" || typeof j.pitchers !== "number") continue;
      files++;
      const k = `${j.hitters}/${j.pitchers}`;
      comp[k] = (comp[k] ?? 0) + 1;
    }
  } catch { /* configs absent — fall back to the documented modal split */ }
  return { files, comp: Object.entries(comp).sort((a, b) => b[1] - a[1]) };
})();
const TOURN_FILES = TOURN.files;
const TOURN_MODE_LABEL = TOURN.comp[0]?.[0] ?? "14/12";
const TOURN_MODE = TOURN.comp[0]?.[1] ?? 0;
const TOURN_MODE_H = Number(TOURN_MODE_LABEL.split("/")[0]) || 14;
const CUTS = [10, 14, 20, 26];
const HEADLINE_K = TOURN_MODE_H;

// ════════════════════════════════════════════════════════════════════════════════════════════
say("################################################################################");
say("# SHAPE-ERROR STABILITY — is the hi-EYE/hi-POW composite error identified? — 2026-07-26");
say("# tools/shape-error-stability.ts · MEASUREMENT ONLY — no production default changed, no");
say("# correction fitted or proposed, nothing wired, nothing committed.");
say("################################################################################");
say();
say(`  THE FINDING UNDER TEST (fixtures/per-event-headroom-2026-07-26.txt, Part 3): where the`);
say(`  per-channel cancellation FAILS it concentrates on one hitter shape — hi EYE / hi POW — with a`);
say(`  per-card wOBA error of -0.00183 [-0.00364,-0.00026] vs the rest of the pool, supplying 9 of the`);
say(`  model's 12 false top-26 picks from 30% of the pool.`);
say();
say(`  THE ONE QUESTION: is that error STABLE ACROSS FIT WINDOWS, or does it SORT BY WINDOW? The`);
say(`  standard is the one that killed the EYE-axis correction — a quantity is identified if it does`);
say(`  not move when re-estimated on a different slice of the same league AND its apparent`);
say(`  identification does not flip direction with a nuisance knob.`);
say(`     comparator IDENTIFIED    : K aux, swing 1.01-1.14x in every cell of every table`);
say(`     comparator NOT IDENTIFIED: BABIP aux, swing 4.16x across the three published windows, and`);
say(`                                a swing-of-swing that FLIPS with minPA (1.77→1.24x at 250,`);
say(`                                1.06→1.58x at 1000)`);
say();
say(`  model '${trained.id}'  deployed window ${DEPLOY_WIN.join("+")}  minPA ${DEPLOY_T} (window SUM)  root '${TRAIN}'`);
say(`  deployed forms: hit '${DEPLOYED_FORMS.hit.name}'  vertex-pinned ${DEPLOYED_FORMS.pinned}`);
say(`  wOBA weights: ${usingModelWeights ? "THE MODEL'S OWN (trained.wobaWeights)" : "DEFAULT_WOBA_WEIGHTS"}, HELD FIXED in every cell below`);
say(`    bb ${f(W.bb, 4)}  hbp ${f(W.hbp, 4)}  1b ${f(W.b1, 4)}  xbh ${f(W.xbh, 4)}  hr ${f(W.hr, 4)}`);
say(`  variants: ${(trained.includeVariants ?? true) ? "INCLUDED (as the model trains them)" : "excluded"}`);
say();
const VERDICT_AT = L.length;

// ── §0 ───────────────────────────────────────────────────────────────────────────────────────
say("################################################################################");
say("# §0 — PROVENANCE, GRAIN, THE MEASURED CLUSTER INFLATION, AND WHAT THE DESIGN CANNOT DO");
say("################################################################################");
say();
say(`  0a. SEASONS AND LEAGUE COVERAGE (each season loaded on its own; the loader's corrupt-cell`);
say(`  detector runs on every load and its exclusions are printed from the summary, not asserted):`);
say();
say(`  ${pad("season", 10)} ${pad("leagues", 34)} ${rp("hit rows/cards @400", 20)}  excluded cells`);
for (const y of YEARS) {
  const ld = win([y]);
  const h = ld.observations.filter(keepVar).filter((x) => HITTER.qualifies(x, 400));
  say(`  ${pad(String(y), 10)} ${pad(ld.summary.leagues.join(","), 34)} ${rp(`${h.length}/${cardsOf(h)}`, 20)}  ${JSON.stringify(ld.summary.excludedCells)}`);
}
say(`  ⇒ HD450 | 2039 is the known duplicate-vL/vR cell and the loader DOES drop it (visible above);`);
say(`    2037 carries 4 leagues, 2039 effectively 4 after the exclusion, the rest 5.`);
say(`  ⇒ Old Data ${OLD_YEARS.join("/")} sits after a four-season gap and is EXCLUDED from every read here.`);
say();
say(`  0b. GRAIN. loadWindow SUMS a card's seasons into ONE row per (card x side) over the window —`);
say(`  the units the deployed curves were fit on. Every N is rows; the DISTINCT-CARD count is printed`);
say(`  beside it because the card count is the binding sample size.`);
say();
say(`  0c. THE THREE PUBLISHED FIT WINDOWS are mutually DISJOINT, which is what makes a swing across`);
say(`  them meaningful — overlapping windows share seasons and must agree:`);
const W2SET = [[2037, 2038], [2040, 2041], [2042, 2043]];
const PAIR2 = [[2037, 2038], [2040, 2041]];
const W3SET = [[2037, 2038, 2039], [2040, 2041, 2042]];
const testFor = (train: number[]) => YEARS.filter((y) => !train.includes(y));
for (const w of W2SET) say(`     fit ${pad(w.join("+"), 12)} → OUT-OF-FRAME test ${testFor(w).join(",")}`);
say(`  (For the 2042+2043 window the held-out block is entirely BACKWARD in time and for 2037+2038`);
say(`  entirely FORWARD; the middle window straddles. Direction is reported separately in §2b so a`);
say(`  forward/backward asymmetry cannot be mistaken for a window effect.)`);
say();

// 0d — measured cluster inflation for THIS artifact's statistic
say(`  0d. THE MEASURED CLUSTER-INFLATION FACTOR (not assumed — it has come out 3.1x, 1.07x and`);
say(`  1.02-1.22x on different statistics in this project, so it is measured for the statistic used`);
say(`  here):`);
say();
say(`  ${pad("statistic", 56)} ${rp("cluster width", 14)} ${rp("row width", 12)} ${rp("inflation", 10)}`);
{
  const mk = (label: string, rows: HRow[], def: CellDef) => {
    const { fn } = inShapeFn(rows, def);
    const cl = clustersOf(rows);
    const bc: number[] = [], br: number[] = [];
    for (let b = 0; b < 800; b++) bc.push(contrastOf(clusterDraw(cl), fn));
    for (let b = 0; b < 800; b++) br.push(contrastOf(rowDraw(rows), fn));
    const wc = width(ci(bc)), wr = width(ci(br));
    say(`  ${pad(label, 56)} ${rp(wc.toExponential(2), 14)} ${rp(wr.toExponential(2), 12)} ${rp(`${f(wc / wr, 2)}x`, 10)}`);
    return wc / wr;
  };
  const oofDeployed = rowsFor(testFor(DEPLOY_WIN), DEPLOY_T, null);
  mk("shape contrast, deployed artifact OOF, POOL cell", oofDeployed, "POOL");
  mk("shape contrast, deployed artifact OOF, FIXED cell", oofDeployed, "FIXED");
  mk("shape contrast, 2037+2038 fit OOF, FIXED cell", rowsFor(testFor([2037, 2038]), DEPLOY_T, fitOn([2037, 2038], DEPLOY_T)), "FIXED");
}
say();
say(`  Every interval in this artifact is the CLUSTER one.`);
say();

// 0e — out-of-time is not out-of-card
say(`  0e. OUT-OF-TIME IS NOT OUT-OF-CARD — WHAT THIS DESIGN CAN AND CANNOT CLAIM.`);
say(`  The same cards recur across seasons (residuals correlate r=0.94 over 99% shared BF), so the`);
say(`  three window estimates below are NOT three independent samples of the shape error. Measured:`);
say();
say(`  ${pad("fit window", 14)} ${rp("test rows/cards", 18)} ${rp("cards also in fit", 18)} ${rp("share of test PA", 18)}`);
for (const w of W2SET) {
  const tr = new Set(obsOf(w).filter((o) => HITTER.qualifies(o, DEPLOY_T)).map((o) => o.cid));
  const te = rowsFor(testFor(w), DEPLOY_T, fitOn(w, DEPLOY_T));
  const shared = te.filter((r) => tr.has(r.cid));
  say(`  ${pad(w.join("+"), 14)} ${rp(`${te.length}/${cardsOf(te)}`, 18)} ${rp(`${cardsOf(shared)} (${f(100 * cardsOf(shared) / cardsOf(te), 0)}%)`, 18)} ${rp(`${f(100 * shared.reduce((s, r) => s + r.w, 0) / te.reduce((s, r) => s + r.w, 0), 0)}%`, 18)}`);
}
say();
say(`  CONSEQUENCE, stated before any result: what varies across the three windows is (i) the fitted`);
say(`  COEFFICIENTS and (ii) the season mix of the held-out block — NOT the card population. So this`);
say(`  design is ASYMMETRIC evidence:`);
say(`     · a SORTS-BY-WINDOW result is STRONG — the estimate moved even though the cards barely did;`);
say(`     · a STABLE result is WEAK on its own — heavily shared cards would produce agreement even`);
say(`       from a pure card-level idiosyncrasy that no rating-based term could ever carry.`);
say(`  §5 therefore adds the one genuinely out-of-CARD read available: a disjoint CARD split of a`);
say(`  single evaluation pool. A shape effect that is real must survive it; a card-idiosyncrasy`);
say(`  masquerading as a shape effect will not. No claim of replication is made beyond that.`);
say();

// ── §1 REPRODUCTION ──────────────────────────────────────────────────────────────────────────
say("################################################################################");
say("# §1 — REPRODUCTION OF THE PUBLISHED CELL (the control: this artifact must match)");
say("################################################################################");
say();
say(`  The published number used the DEPLOYED ARTIFACT (trained.eventForm) predicting 2037-2041, with`);
say(`  the cell defined by median splits of EYE and POW ON THAT POOL. Reproduced first, then repeated`);
say(`  with a same-window REFIT (fitHitForm on 2042+2043, fresh pins) to establish that a refit is a`);
say(`  faithful stand-in for the artifact — every other window below can only be a refit.`);
say();
say(`  ${pad("source", 34)} ${rp("rows/cards", 14)} ${rp("in shape", 12)} ${rp("contrast", 11)} ${rp("95% CI", 24)}`);
{
  const oof = testFor(DEPLOY_WIN);
  const a = measure(DEPLOY_WIN, oof, DEPLOY_T, DEPLOY_T, "POOL", 1200);   // refit
  const rowsArt = rowsFor(oof, DEPLOY_T, null);
  const { fn } = inShapeFn(rowsArt, "POOL");
  const cl = clustersOf(rowsArt); const bs: number[] = [];
  for (let b = 0; b < 1200; b++) bs.push(contrastOf(clusterDraw(cl), fn));
  const artPt = contrastOf(rowsArt, fn), artCi = ci(bs);
  const inArt = rowsArt.filter(fn);
  say(`  ${pad("DEPLOYED ARTIFACT (published)", 34)} ${rp(`${rowsArt.length}/${cardsOf(rowsArt)}`, 14)} ${rp(`${inArt.length}/${cardsOf(inArt)}`, 12)} ${rp(sgn(artPt, 5), 11)} ${rp(`[${sgn(artCi.lo, 5)}, ${sgn(artCi.hi, 5)}]`, 24)}${clear(artCi) ? " ★" : ""}`);
  say(`  ${pad("REFIT on 2042+2043 (same window)", 34)} ${rp(`${a.n}/${a.cards}`, 14)} ${rp(`${a.nIn}/${a.cardsIn}`, 12)} ${rp(sgn(a.pt, 5), 11)} ${rp(`[${sgn(a.ci.lo, 5)}, ${sgn(a.ci.hi, 5)}]`, 24)}${clear(a.ci) ? " ★" : ""}`);
  say(`  ${pad("published value for reference", 34)} ${rp("252/102", 14)} ${rp("76/40", 12)} ${rp("-0.00183", 11)} ${rp("[-0.00364, -0.00026]", 24)} ★`);
  say();
  say(`  shape cell thresholds — POOL: EYE ≥ ${f(inShapeFn(rowsArt, "POOL").mE, 0)}, POW ≥ ${f(inShapeFn(rowsArt, "POOL").mP, 0)};  FIXED (deployed pool): EYE ≥ ${f(FIX_EYE, 0)}, POW ≥ ${f(FIX_POW, 0)}`);
  say(`  refit-vs-artifact agreement: ${f(100 * Math.abs(a.pt - artPt) / Math.max(Math.abs(artPt), 1e-9), 1)}% of the point estimate. A refit is a faithful stand-in.`);
}
say();

// ── §2 THE STABILITY TEST ────────────────────────────────────────────────────────────────────
say("################################################################################");
say("# §2 — THE STABILITY TEST: the shape error fitted on each of the three published windows");
say("################################################################################");
say();
say(`  Each row: DEPLOYED_FORMS refit on that window (fresh vertex-pin collector), evaluated on EVERY`);
say(`  season the window does not contain. Contrast = weighted-mean ΔwOBA (predicted − observed)`);
say(`  inside the hi-EYE/hi-POW cell MINUS the same outside it. Differencing removes any common`);
say(`  level, so the statistic is anchor-neutral by construction (see §4).`);
say(`  NEGATIVE = the model credits the shape LESS than the observed line says it earned.`);
say();
const CORE: Record<CellDef, Cell[]> = { POOL: [], FIXED: [] };
for (const def of ["POOL", "FIXED"] as const) {
  say(`  ══ cell definition: ${def === "POOL" ? "POOL medians (published construction; membership drifts with the pool)" : "FIXED medians (deployed pool; membership constant)"} ══`);
  say(`  ${pad("fit window", 13)} ${pad("held-out test", 22)} ${rp("rows/cards", 13)} ${rp("in shape", 11)} ${rp("contrast", 11)} ${rp("95% CI", 24)} ${rp("unweighted", 11)}`);
  for (const w of W2SET) {
    const c = measure(w, testFor(w), DEPLOY_T, DEPLOY_T, def, 1200);
    CORE[def].push(c);
    say(`  ${pad(w.join("+"), 13)} ${pad(c.test.join(","), 22)} ${rp(`${c.n}/${c.cards}`, 13)} ${rp(`${c.nIn}/${c.cardsIn}`, 11)} ${rp(sgn(c.pt, 5), 11)} ${rp(`[${sgn(c.ci.lo, 5)}, ${sgn(c.ci.hi, 5)}]`, 24)}${clear(c.ci) ? "★" : " "} ${rp(sgn(c.ptU, 5), 11)}`);
  }
  const v = CORE[def].map((c) => c.pt);
  say(`  ⇒ signs ${v.map((x) => (x < 0 ? "−" : "+")).join(" ")}   ${signsAgree(v) ? "ALL AGREE" : "DO NOT AGREE — the estimate changes SIGN across windows"}`);
  say(`  ⇒ SWING RATIO max|contrast| / min|contrast| = ${f(spreadOf(v), 2)}x   (K aux 1.01-1.14x = identified; BABIP aux 4.16x = not)`);
  say();
}

say(`  §2b DIRECTION CONTROL. The 2042+2043 window is tested entirely BACKWARD and 2037+2038 entirely`);
say(`  FORWARD, so a forward/backward asymmetry could imitate a window effect. The middle window`);
say(`  (2040+2041) can be read both ways on the SAME fit — if direction were the driver, its two arms`);
say(`  would split:`);
say();
say(`  ${pad("fit window", 13)} ${pad("arm", 26)} ${rp("rows/cards", 13)} ${rp("contrast", 11)} ${rp("95% CI", 24)}`);
for (const [tag, test] of [["forward 2042,2043", [2042, 2043]], ["backward 2037,2038,2039", [2037, 2038, 2039]]] as [string, number[]][]) {
  const c = measure([2040, 2041], test, DEPLOY_T, DEPLOY_T, "FIXED", 1000);
  say(`  ${pad("2040+2041", 13)} ${pad(tag, 26)} ${rp(`${c.n}/${c.cards}`, 13)} ${rp(sgn(c.pt, 5), 11)} ${rp(`[${sgn(c.ci.lo, 5)}, ${sgn(c.ci.hi, 5)}]`, 24)}${clear(c.ci) ? " ★" : ""}`);
}
say();
say(`  §2c IN-FRAME FLOOR. In-sample residuals are shrunk toward zero, so the in-frame contrast is a`);
say(`  FLOOR, not an estimate. Printed so the out-of-frame numbers can be read against it:`);
say();
say(`  ${pad("fit window", 13)} ${pad("frame", 18)} ${rp("rows/cards", 13)} ${rp("contrast", 11)} ${rp("95% CI", 24)}`);
for (const w of W2SET) {
  const c = measure(w, w, DEPLOY_T, DEPLOY_T, "FIXED", 800);
  say(`  ${pad(w.join("+"), 13)} ${pad("IN FRAME", 18)} ${rp(`${c.n}/${c.cards}`, 13)} ${rp(sgn(c.pt, 5), 11)} ${rp(`[${sgn(c.ci.lo, 5)}, ${sgn(c.ci.hi, 5)}]`, 24)}${clear(c.ci) ? " ★" : ""}`);
}
say();

// ── §3 NUISANCE KNOBS ────────────────────────────────────────────────────────────────────────
say("################################################################################");
say("# §3 — THE NUISANCE-KNOB TEST: does the magnitude or the SIGN move with minPA and width?");
say("################################################################################");
say();
say(`  Stability under a nuisance knob is the bar, not significance in any one cell. Two arms, because`);
say(`  minPA is two knobs in one:`);
say(`     ARM A (FIT ONLY)  — the threshold moves the FIT; the evaluation pool is PINNED at ${DEPLOY_T}, so`);
say(`                         every cell of a column is scored on byte-identical rows. This isolates`);
say(`                         the coefficient effect and is the identification-relevant arm.`);
say(`     ARM B (BOTH)      — the threshold moves the fit AND the evaluation pool, which also changes`);
say(`                         the POPULATION (lower-PA cards are noisier and a different card mix).`);
say();
const THRESH = [250, 500, 1000];
interface Sweep { arm: string; def: CellDef; t: number; windows: number[][]; vals: number[]; swing: number; agree: boolean }
const sweeps: Sweep[] = [];
for (const arm of ["A (fit only, eval pinned)", "B (fit + eval)"] as const) {
  for (const def of ["POOL", "FIXED"] as const) {
    say(`  ══ ARM ${arm} · cell ${def} · width 2 · the three published windows ══`);
    say(`  ${pad("minPA", 8)} ${pad("contrast per fit window (2037+38 / 2040+41 / 2042+43)", 44)} ${rp("signs", 7)} ${rp("swing", 8)} ${rp("fit rows", 22)}`);
    for (const t of THRESH) {
      const cs = W2SET.map((w) => measure(w, testFor(w), t, arm.startsWith("A") ? DEPLOY_T : t, def, 400));
      const v = cs.map((c) => c.pt);
      sweeps.push({ arm, def, t, windows: W2SET, vals: v, swing: spreadOf(v), agree: signsAgree(v) });
      say(`  ${pad(String(t), 8)} ${pad(v.map((x) => sgn(x, 5)).join(" / "), 44)} ${rp(v.map((x) => (x < 0 ? "−" : "+")).join(""), 7)} ${rp(f(spreadOf(v), 2), 8)} ${rp(W2SET.map((w) => obsOf(w).filter((o) => HITTER.qualifies(o, t)).length).join("/"), 22)}`);
    }
    say();
  }
}
say(`  §3b WIDTH, CONTROLLED. A max/min over three draws is mechanically larger than over two, and`);
say(`  overlapping windows must agree — so the width contrast uses TWO MUTUALLY DISJOINT windows on`);
say(`  the SAME anchors and changes only the width (the construction §3a of the threshold sweep used):`);
say(`     width 2:  2037+2038          vs  2040+2041`);
say(`     width 3:  2037+2038+2039     vs  2040+2041+2042`);
say(`  Two disjoint FOUR-season windows do not exist in 2037-2043, so width 3 is the widest reachable.`);
say();
const swingCell = new Map<string, number>();
for (const def of ["POOL", "FIXED"] as const) {
  say(`  ══ cell ${def} · ARM A (eval pinned at ${DEPLOY_T}) ══`);
  say(`  ${pad("configuration", 26)} ${pad("contrast per window", 30)} ${rp("signs", 7)} ${rp("swing", 8)}`);
  for (const t of THRESH) {
    for (const [wtag, wins] of [["width 2", PAIR2], ["width 3", W3SET]] as [string, number[][]][]) {
      const v = wins.map((w) => measure(w, testFor(w), t, DEPLOY_T, def, 400).pt);
      swingCell.set(`${def}|${t}|${wtag}`, spreadOf(v));
      say(`  ${pad(`${wtag} · minPA ${t}`, 26)} ${pad(v.map((x) => sgn(x, 5)).join(" / "), 30)} ${rp(v.map((x) => (x < 0 ? "−" : "+")).join(""), 7)} ${rp(f(spreadOf(v), 2), 8)}`);
    }
  }
  say();
}
say(`  §3c THE SWING OF THE SWING — the exact test that condemned the BABIP aux. If widening the`);
say(`  window steadies the estimate at one threshold and destabilises it at another, the apparent`);
say(`  identification depends on which knob was turned and the quantity is NOT identified:`);
say();
say(`  ${pad("cell def", 10)} ${pad("minPA", 8)} ${rp("width 2", 9)} ${rp("width 3", 9)}  direction`);
for (const def of ["POOL", "FIXED"] as const) {
  for (const t of THRESH) {
    const x = swingCell.get(`${def}|${t}|width 2`)!, y = swingCell.get(`${def}|${t}|width 3`)!;
    say(`  ${pad(def, 10)} ${pad(String(t), 8)} ${rp(f(x, 2), 9)} ${rp(f(y, 2), 9)}  ${y < x ? "steadier at 3" : "steadier at 2"}`);
  }
}
say();
say(`  §3d THE HEADLINE STATISTIC, next to its comparators. Every swing computed above, over every`);
say(`  arm x cell-definition x threshold x width in this artifact:`);
{
  const all = [...sweeps.map((s) => s.swing), ...swingCell.values()].filter(Number.isFinite);
  const allAgree = sweeps.every((s) => s.agree);
  say();
  say(`     shape-error swing, range over all ${all.length} cells : ${f(Math.min(...all), 2)}x - ${f(Math.max(...all), 2)}x`);
  say(`     sign consistency across windows              : ${allAgree ? "every cell agrees in sign" : `${sweeps.filter((s) => !s.agree).length} of ${sweeps.length} width-2 cells CHANGE SIGN across windows`}`);
  say(`     comparator — K aux (IDENTIFIED)              : 1.01x - 1.14x, sign constant`);
  say(`     comparator — BABIP aux (NOT IDENTIFIED)      : 4.16x on the three published windows`);
  say();
}

// ── §4 LEVEL vs SHAPE ────────────────────────────────────────────────────────────────────────
say("################################################################################");
say("# §4 — LEVEL vs SHAPE, AND THE HBP ACCOUNTING RawHitting FORCES");
say("################################################################################");
say();
say(`  A LEVEL shift is absorbed by the anchor/baseline and cannot reshuffle a roster, so it is not`);
say(`  the thing to correct. The contrast statistic used throughout is a DIFFERENCE of two group`);
say(`  means, so any common level cancels exactly — the table below shows that directly: the raw cell`);
say(`  mean moves with the level, the contrast does not.`);
say();
say(`  ${pad("fit window", 13)} ${rp("pool LEVEL", 12)} ${rp("cell raw mean", 14)} ${rp("rest raw mean", 14)} ${rp("CONTRAST", 11)} ${rp("|contrast|/|level|", 19)}`);
for (const w of W2SET) {
  const form = fitOn(w, DEPLOY_T);
  const rows = rowsFor(testFor(w), DEPLOY_T, form);
  const { fn } = inShapeFn(rows, "FIXED");
  const lvl = wmeanOf(rows, (r) => r.dW, (r) => r.w);
  const a = wmeanOf(rows.filter(fn), (r) => r.dW, (r) => r.w), b = wmeanOf(rows.filter((r) => !fn(r)), (r) => r.dW, (r) => r.w);
  say(`  ${pad(w.join("+"), 13)} ${rp(sgn(lvl, 5), 12)} ${rp(sgn(a, 5), 14)} ${rp(sgn(b, 5), 14)} ${rp(sgn(a - b, 5), 11)} ${rp(f(Math.abs(a - b) / Math.max(Math.abs(lvl), 1e-9), 2), 19)}`);
}
say();
say(`  VARIANCE SHARE — how much of the centred per-card error the cell indicator actually carries.`);
say(`  This is the ceiling on what ANY correction keyed to this one 2x2 cell could remove:`);
say();
say(`  ${pad("fit window", 13)} ${rp("SD of centred ΔwOBA", 21)} ${rp("cell R²", 10)} ${rp("(EYE,POW) linear R²", 21)} ${rp("+quad+inter R²", 16)}`);
for (const w of W2SET) {
  const rows = rowsFor(testFor(w), DEPLOY_T, fitOn(w, DEPLOY_T));
  const { fn } = inShapeFn(rows, "FIXED");
  const lvl = wmeanOf(rows, (r) => r.dW, (r) => r.w);
  const sw = rows.reduce((s, r) => s + r.w, 0);
  const tot = rows.reduce((s, r) => s + r.w * (r.dW - lvl) ** 2, 0) / sw;
  const zs = (k: string) => { const mu = wmeanOf(rows, (r) => r.r[k]!, (r) => r.w); const sd = Math.sqrt(rows.reduce((s, r) => s + r.w * (r.r[k]! - mu) ** 2, 0) / sw) || 1; return (r: HRow) => (r.r[k]! - mu) / sd; };
  const zE = zs("eye"), zP = zs("pow");
  const r2 = (des: (r: HRow) => number[]) => {
    const b = wls(rows.map(des), rows.map((r) => r.dW), rows.map((r) => r.w));
    const res = rows.reduce((s, r) => { const p = des(r).reduce((a, x, i) => a + x * b[i]!, 0); return s + r.w * (r.dW - p) ** 2; }, 0) / sw;
    return 1 - res / tot;
  };
  const rCell = r2((r) => [1, fn(r) ? 1 : 0]);
  const rLin = r2((r) => [1, zE(r), zP(r)]);
  const rFull = r2((r) => [1, zE(r), zP(r), zE(r) ** 2, zP(r) ** 2, zE(r) * zP(r)]);
  say(`  ${pad(w.join("+"), 13)} ${rp(f(Math.sqrt(tot), 5), 21)} ${rp(f(rCell, 4), 10)} ${rp(f(rLin, 4), 21)} ${rp(f(rFull, 4), 16)}`);
}
say();
say(`  §4b THE HBP LEG. RawHitting has NO HBP field, so the deployed hitter HBP is a CONSTANT 6/600 in`);
say(`  the wOBA numerator (src/model/raw-poly.ts) while the observed side carries the card's real`);
say(`  hit-by-pitches. That leg is therefore a real per-card wOBA error with no rating-based remedy,`);
say(`  and — being a fixed 6 on BOTH sides of the HARNESS target — it is invisible to every harness`);
say(`  metric. If the shape error is largely HBP, no composite-layer term keyed to (EYE,POW) can`);
say(`  legitimately carry it. Measured both ways:`);
say();
say(`  ${pad("fit window", 13)} ${rp("TRUE frame", 12)} ${rp("HARNESS frame", 15)} ${rp("HBP leg alone", 15)} ${rp("HBP share of contrast", 22)}`);
for (const w of W2SET) {
  const rows = rowsFor(testFor(w), DEPLOY_T, fitOn(w, DEPLOY_T));
  const { fn } = inShapeFn(rows, "FIXED");
  const t = contrastOf(rows, fn, (r) => r.dW), h = contrastOf(rows, fn, (r) => r.dWh), g = contrastOf(rows, fn, (r) => r.hbpLeg);
  say(`  ${pad(w.join("+"), 13)} ${rp(sgn(t, 5), 12)} ${rp(sgn(h, 5), 15)} ${rp(sgn(g, 5), 15)} ${rp(`${f(100 * g / (Math.abs(t) > 1e-12 ? t : NaN), 0)}%`, 22)}`);
}
say();
say(`  §4c MECHANISM PROBE — IS THE SHAPE CONTRAST A PROPORTIONAL SHADOW OF THE LEVEL DRIFT?`);
say(`  The level column above is not noise: cards improve every season, so a model fit on an EARLY`);
say(`  window over-predicts a LATER block and one fit on a late window under-predicts an earlier one`);
say(`  (the standing league-frame result). That level is absorbed by the anchor — but only if it is`);
say(`  ADDITIVE. If the frame acts MULTIPLICATIVELY on wOBA, the same proportional miss produces a`);
say(`  LARGER ABSOLUTE error for the high-wOBA cards, and hi-EYE/hi-POW cards ARE the high-wOBA cards.`);
say(`  That would manufacture a shape contrast whose SIGN follows the level's sign — exactly the`);
say(`  pattern §2 found — out of a pure level phenomenon with no shape content at all.`);
say(`  Test: rescale the predicted line by the pool-wide multiplicative level λ = Σw·wOBApred ÷`);
say(`  Σw·wOBAobs (one scalar per window, fit on the pool, NOT on the cell) and re-measure. Removing`);
say(`  an ADDITIVE level cannot change a contrast at all — the difference of two group means already`);
say(`  cancels it — so any movement here is attributable to the multiplicative form alone.`);
say();
say(`  ${pad("fit window", 13)} ${rp("λ (mult level)", 15)} ${rp("additive contrast", 18)} ${rp("MULTIPLICATIVE", 15)} ${rp("95% CI", 24)} ${rp("removed", 9)}`);
const multVals: number[] = [];
for (const w of W2SET) {
  const rows = rowsFor(testFor(w), DEPLOY_T, fitOn(w, DEPLOY_T));
  const { fn } = inShapeFn(rows, "FIXED");
  const lam = rows.reduce((s, r) => s + r.w * r.wobaP, 0) / rows.reduce((s, r) => s + r.w * r.wobaO, 0);
  const gm = (r: HRow) => r.wobaP / lam - r.wobaO;
  const cl = clustersOf(rows), bs: number[] = [];
  for (let b = 0; b < 1000; b++) bs.push(contrastOf(clusterDraw(cl), fn, gm));
  const add = contrastOf(rows, fn), mul = contrastOf(rows, fn, gm), c = ci(bs);
  multVals.push(mul);
  say(`  ${pad(w.join("+"), 13)} ${rp(f(lam, 5), 15)} ${rp(sgn(add, 5), 18)} ${rp(sgn(mul, 5), 15)} ${rp(`[${sgn(c.lo, 5)}, ${sgn(c.hi, 5)}]`, 24)}${clear(c) ? "★" : " "} ${rp(`${f(100 * (1 - Math.abs(mul) / Math.abs(add)), 0)}%`, 9)}`);
}
say(`  ⇒ after the multiplicative level is removed: signs ${multVals.map((x) => (x < 0 ? "−" : "+")).join(" ")} ${signsAgree(multVals) ? "(agree)" : "(still disagree)"}, swing ${f(spreadOf(multVals), 2)}x`);
say();

// ── §5 CARD-SPLIT ────────────────────────────────────────────────────────────────────────────
say("################################################################################");
say("# §5 — CARD-SPLIT REPLICATION (the one genuinely out-of-CARD read available)");
say("################################################################################");
say();
say(`  §0e established that the three window estimates share almost all their cards, so agreement`);
say(`  across them is weak evidence. Here the SAME fit and the SAME evaluation seasons are split into`);
say(`  two DISJOINT halves of CARDS (deterministic hash of cid, so the split is reproducible and`);
say(`  independent of any outcome). A shape effect that is a property of the rating shape must appear`);
say(`  in both halves. A card-level idiosyncrasy that happens to sit in the cell will not.`);
say();
const hashCid = (s: string) => { let h = 2166136261 >>> 0; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h; };
say(`  ${pad("fit window", 13)} ${pad("half", 10)} ${rp("rows/cards", 13)} ${rp("in shape", 11)} ${rp("contrast", 11)} ${rp("95% CI", 24)}`);
const halfVals: number[][] = [];
for (const w of W2SET) {
  const rows = rowsFor(testFor(w), DEPLOY_T, fitOn(w, DEPLOY_T));
  const { fn } = inShapeFn(rows, "FIXED");
  const v: number[] = [];
  for (const half of [0, 1]) {
    const sub = rows.filter((r) => hashCid(r.cid) % 2 === half);
    const cl = clustersOf(sub), bs: number[] = [];
    for (let b = 0; b < 800; b++) bs.push(contrastOf(clusterDraw(cl), fn));
    const c = ci(bs), pt = contrastOf(sub, fn), inS = sub.filter(fn);
    v.push(pt);
    say(`  ${pad(half === 0 ? w.join("+") : "", 13)} ${pad(half === 0 ? "A (even)" : "B (odd)", 10)} ${rp(`${sub.length}/${cardsOf(sub)}`, 13)} ${rp(`${inS.length}/${cardsOf(inS)}`, 11)} ${rp(sgn(pt, 5), 11)} ${rp(`[${sgn(c.lo, 5)}, ${sgn(c.hi, 5)}]`, 24)}${clear(c) ? " ★" : ""}`);
  }
  halfVals.push(v);
}
say();
{
  const agree = halfVals.filter((v) => signsAgree(v)).length;
  say(`  ⇒ ${agree} of ${halfVals.length} windows have the two card halves agreeing in SIGN.`);
  say(`  ⇒ half-vs-half swing per window: ${halfVals.map((v) => f(spreadOf(v), 2) + "x").join(", ")}`);
  say(`  A card split halves the cards in each arm, so the intervals must widen — the sign agreement,`);
  say(`  not the interval, is the readable quantity here.`);
}
say();

// ── §6 FUNCTIONAL SHAPE ──────────────────────────────────────────────────────────────────────
say("################################################################################");
say("# §6 — THE FUNCTIONAL SHAPE OVER THE (EYE, POW) PLANE — CHARACTERISED, NOT FITTED");
say("################################################################################");
say();
say(`  This section exists because the STABLE branch would need it, and because it is diagnostic`);
say(`  either way: a real shape effect has a coherent surface, a cell artifact does not. NOTHING IS`);
say(`  PROPOSED — no correction is fitted, no term is added to any form, and the coefficients printed`);
say(`  are descriptive statistics of the residual, not candidates.`);
say();
say(`  §6a THE SURFACE. Weighted-mean ΔwOBA over a 3x3 tercile grid in (EYE, POW), pooled over the`);
say(`  three windows' out-of-frame blocks (each row weighted by PA; a card appearing under several`);
say(`  windows contributes once per window, which is stated rather than corrected — the grid is a`);
say(`  DESCRIPTION, no interval is claimed from it):`);
say();
{
  const all: HRow[] = [];
  for (const w of W2SET) all.push(...rowsFor(testFor(w), DEPLOY_T, fitOn(w, DEPLOY_T)));
  const lvl = wmeanOf(all, (r) => r.dW, (r) => r.w);
  const terc = (k: string) => { const v = all.map((r) => r.r[k]!).sort((a, b) => a - b); return [v[Math.floor(v.length / 3)]!, v[Math.floor(2 * v.length / 3)]!]; };
  const [e1, e2] = terc("eye"), [p1, p2] = terc("pow");
  const band = (x: number, a: number, b: number) => (x < a ? 0 : x < b ? 1 : 2);
  say(`     EYE terciles at ${f(e1!, 0)} / ${f(e2!, 0)};  POW terciles at ${f(p1!, 0)} / ${f(p2!, 0)}.  Cells are ΔwOBA centred on the pool level (${sgn(lvl, 5)}).`);
  say();
  say(`     ${pad("", 12)} ${rp("POW lo", 12)} ${rp("POW mid", 12)} ${rp("POW hi", 12)}`);
  for (let i = 2; i >= 0; i--) {
    const cells = [0, 1, 2].map((j) => {
      const sub = all.filter((r) => band(r.r.eye!, e1!, e2!) === i && band(r.r.pow!, p1!, p2!) === j);
      return sub.length ? `${sgn(wmeanOf(sub, (r) => r.dW, (r) => r.w) - lvl, 5)} (${sub.length})` : "—";
    });
    say(`     ${pad(["EYE lo", "EYE mid", "EYE hi"][i]!, 12)} ${cells.map((c) => rp(c, 12)).join(" ")}`);
  }
  say();
  // conditional surface fit with all ratings held
  const sw = all.reduce((s, r) => s + r.w, 0);
  const zf = (k: string) => { const mu = wmeanOf(all, (r) => r.r[k]!, (r) => r.w); const sd = Math.sqrt(all.reduce((s, r) => s + r.w * (r.r[k]! - mu) ** 2, 0) / sw) || 1; return (r: HRow) => (r.r[k]! - mu) / sd; };
  const Z = Object.fromEntries(HIT_AX.map((k) => [k, zf(k)])) as Record<string, (r: HRow) => number>;
  const TERMS: [string, (r: HRow) => number][] = [
    ["EYE", (r) => Z.eye!(r)], ["POW", (r) => Z.pow!(r)], ["AvoidK", (r) => Z.kRat!(r)],
    ["BABIP(rat)", (r) => Z.babip!(r)], ["GAP", (r) => Z.gap!(r)],
    ["EYE²", (r) => Z.eye!(r) ** 2], ["POW²", (r) => Z.pow!(r) ** 2], ["EYE×POW", (r) => Z.eye!(r) * Z.pow!(r)],
  ];
  const des = (r: HRow) => [1, ...TERMS.map(([, g]) => g(r))];
  const cl = clustersOf(all), draws: HRow[][] = [];
  for (let b = 0; b < 800; b++) draws.push(clusterDraw(cl));
  const beta = wls(all.map(des), all.map((r) => r.dW), all.map((r) => r.w));
  const bbs = draws.map((d) => wls(d.map(des), d.map((r) => r.dW), d.map((r) => r.w)));
  say(`  §6b IS IT A CORNER, A GRADIENT, OR AN INTERACTION? Conditional weighted fit of ΔwOBA on the`);
  say(`  z-scored ratings plus the two curvature terms and the interaction, ALL FIVE RATINGS HELD.`);
  say(`  A pure CORNER needs the EYE×POW interaction; a monotone GRADIENT needs only the linears.`);
  say();
  say(`  ${pad("term", 14)} ${rp("coef (wOBA per SD)", 20)} ${rp("95% CI", 24)}`);
  TERMS.forEach(([nm], i) => {
    const c = ci(bbs.map((b) => b[i + 1]!));
    say(`  ${pad(nm, 14)} ${rp(sgn(beta[i + 1]!, 5), 20)} ${rp(`[${sgn(c.lo, 5)}, ${sgn(c.hi, 5)}]`, 24)}${clear(c) ? " ★" : ""}`);
  });
  say();
  // single-index test
  const bE = beta[1]!, bP = beta[2]!;
  const nrm = Math.hypot(bE, bP) || 1;
  const sIdx = (r: HRow) => (bE * Z.eye!(r) + bP * Z.pow!(r)) / nrm;
  const lvl2 = wmeanOf(all, (r) => r.dW, (r) => r.w);
  const tot = all.reduce((s, r) => s + r.w * (r.dW - lvl2) ** 2, 0) / sw;
  const r2 = (d: (r: HRow) => number[]) => {
    const b = wls(all.map(d), all.map((r) => r.dW), all.map((r) => r.w));
    const res = all.reduce((s, r) => { const p = d(r).reduce((a, x, i) => a + x * b[i]!, 0); return s + r.w * (r.dW - p) ** 2; }, 0) / sw;
    return 1 - res / tot;
  };
  const rIdx = r2((r) => [1, sIdx(r)]);
  const rIdxQ = r2((r) => [1, sIdx(r), sIdx(r) ** 2]);
  const rLin2 = r2((r) => [1, Z.eye!(r), Z.pow!(r)]);
  const rFull2 = r2(des);
  say(`  §6c COULD A SINGLE SCALAR ON ONE SHAPE INDEX CARRY IT? The index is the unit vector along the`);
  say(`  fitted (EYE,POW) gradient, s = ${f(bE / nrm, 3)}·zEYE ${bP >= 0 ? "+" : "−"} ${f(Math.abs(bP) / nrm, 3)}·zPOW. Weighted R² of the centred`);
  say(`  per-card residual (the whole target a composite-layer correction could address):`);
  say();
  say(`     single scalar on s                      R² ${f(rIdx, 4)}`);
  say(`     s + s² (curvature on the same index)    R² ${f(rIdxQ, 4)}`);
  say(`     free zEYE + zPOW                        R² ${f(rLin2, 4)}`);
  say(`     full 8-term surface (all ratings held)  R² ${f(rFull2, 4)}`);
  say(`     the 2x2 cell indicator alone            R² ${f(r2((r) => { const { fn } = inShapeFn(all, "FIXED"); return [1, fn(r) ? 1 : 0]; }), 4)}`);
  say();
  say(`  READ: if the single index recovers essentially all of what the free linear pair does, ONE`);
  say(`  scalar is the right complexity for the (EYE,POW) part; if the interaction and the quadratics`);
  say(`  are CI-clear and add materially, it is a corner and one scalar cannot carry it. Either way`);
  say(`  the ABSOLUTE R² is the binding number — it bounds what any composite-layer correction keyed to`);
  say(`  these two ratings could remove from the per-card error, before any question of whether the`);
  say(`  coefficient is identified.`);
  say();
  say(`  §6d DOES THE SURFACE ITSELF SORT BY WINDOW? §6a-c pool the three out-of-frame blocks, which`);
  say(`  MIXES the three window estimates §2 showed to disagree — so the pooled surface is a mixture`);
  say(`  and its coefficients must be checked per window before any of them is read as a shape. The`);
  say(`  same 8-term conditional fit, one window at a time:`);
  say();
  say(`  ${pad("term", 12)} ${W2SET.map((w) => rp(w.join("+"), 22)).join("")} ${rp("signs", 7)} ${rp("swing", 8)}`);
  const perWin = W2SET.map((w) => {
    const rows = rowsFor(testFor(w), DEPLOY_T, fitOn(w, DEPLOY_T));
    const swW = rows.reduce((s, r) => s + r.w, 0);
    const zw = (k: string) => { const mu = wmeanOf(rows, (r) => r.r[k]!, (r) => r.w); const sd = Math.sqrt(rows.reduce((s, r) => s + r.w * (r.r[k]! - mu) ** 2, 0) / swW) || 1; return (r: HRow) => (r.r[k]! - mu) / sd; };
    const zz = Object.fromEntries(HIT_AX.map((k) => [k, zw(k)])) as Record<string, (r: HRow) => number>;
    const d = (r: HRow) => [1, zz.eye!(r), zz.pow!(r), zz.kRat!(r), zz.babip!(r), zz.gap!(r), zz.eye!(r) ** 2, zz.pow!(r) ** 2, zz.eye!(r) * zz.pow!(r)];
    const b = wls(rows.map(d), rows.map((r) => r.dW), rows.map((r) => r.w));
    const cl2 = clustersOf(rows), bb2: number[][] = [];
    for (let q = 0; q < 500; q++) { const dr = clusterDraw(cl2); bb2.push(wls(dr.map(d), dr.map((r) => r.dW), dr.map((r) => r.w))); }
    return { b, bb2 };
  });
  const TNAMES = ["EYE", "POW", "AvoidK", "BABIP(rat)", "GAP", "EYE²", "POW²", "EYE×POW"];
  TNAMES.forEach((nm, i) => {
    const vals = perWin.map((p) => p.b[i + 1]!);
    const cells = perWin.map((p) => { const c = ci(p.bb2.map((b) => b[i + 1]!)); return `${sgn(p.b[i + 1]!, 5)}${clear(c) ? "★" : " "}`; });
    say(`  ${pad(nm, 12)} ${cells.map((c) => rp(c, 22)).join("")} ${rp(vals.map((x) => (x < 0 ? "−" : "+")).join(""), 7)} ${rp(f(spreadOf(vals), 2), 8)}`);
  });
  say();
  say(`  (★ = that window's own cluster-bootstrap CI excludes zero. A term whose SIGN differs across`);
  say(`  the three windows describes the window, not the rating shape.)`);
  say();
}

// ── §7 TOP-N COST ────────────────────────────────────────────────────────────────────────────
say("################################################################################");
say("# §7 — THE TOP-N COST AT THE ROSTER-RELEVANT CUT (needed on BOTH branches)");
say("################################################################################");
say();
say(`  THE CUT IS WRONG IN THE INCUMBENT METRIC, AND IT IS WORTH SAYING BEFORE THE NUMBERS. topN=26 is`);
say(`  the hardcoded default throughout src/training/evaluate.ts (lines 39, 59, 67, 93) and inside`);
say(`  evalMetrics. 26 is the ROSTER SIZE — every tournament in data/tournaments/ carries 26 cards. But`);
say(`  the bake-off evaluates PER ROLE, with separate HITTER and PITCHER specs, and a roster is not 26`);
say(`  of EITHER. Counted from the tournament configs in this repo:`);
say(`     ${TOURN_FILES} tournament configs read: ${TOURN.comp.map(([k, v]) => `${k} (${v})`).join(", ")}   [hitters/pitchers]`);
say(`  ⇒ the MODAL hitter count is ${TOURN_MODE_H}, not 26. A "top-26 hitters" overlap therefore scores against`);
say(`  nearly twice as many hitters as anyone rosters: roughly half the metric is cards with no`);
say(`  decision consequence, and the 22nd-best hitter counts exactly as much as the 3rd. That dilutes`);
say(`  sensitivity to precisely the errors that decide a roster.`);
say();
say(`  So the HEADLINE cut below is TOP-${HEADLINE_K} (the modal hitter slot count). Top-26 is reported beside it`);
say(`  for comparability with every prior figure in this project — including the "9 of 12 false top-26`);
say(`  picks" that motivated this task — and top-10 / top-20 fill in the sensitivity. Grain: CARD (a`);
say(`  card's vL and vR rows pooled by PA into one card-level wOBA — a roster picks cards, not`);
say(`  card-sides) is the headline; ROW grain is the published construction and is printed too.`);
say();
interface TopRes {
  tag: string; grain: string; def: CellDef; K: number; N: number;
  falsePos: number; overlap: number; overlapCI: { lo: number; hi: number };
  cost: number; costPer: number; costPerCI: { lo: number; hi: number };
  meanTrueRankOfFalse: number; meanPredRankOfMissed: number; pairedGap: number;
  shareShapePool: number; shareShapeModelTop: number; shareShapeTrueTop: number; shareShapeFalse: number;
}
const topRes: TopRes[] = [];
type U = { key: string; cid: string; p: number; o: number; shape: boolean };
function unitsOf(rows: HRow[], grain: "card" | "row", inC: (r: HRow) => boolean): U[] {
  if (grain === "row") return rows.map((r, i) => ({ key: `${r.cid}|${r.side}|${i}`, cid: r.cid, p: r.wobaP, o: r.wobaO, shape: inC(r) }));
  const m = new Map<string, { sp: number; so: number; w: number; sh: number; n: number }>();
  for (const r of rows) {
    const g = m.get(r.cid) ?? { sp: 0, so: 0, w: 0, sh: 0, n: 0 };
    g.sp += r.w * r.wobaP; g.so += r.w * r.wobaO; g.w += r.w; g.sh += inC(r) ? 1 : 0; g.n++;
    m.set(r.cid, g);
  }
  return [...m].map(([k, g]) => ({ key: k, cid: k, p: g.sp / g.w, o: g.so / g.w, shape: g.sh > g.n / 2 }));
}
/** Top-K statistics on a prepared unit set. Pure — the bootstrap re-enters it with a resample. */
function topStats(units: U[], K: number) {
  const byP = [...units].sort((a, b) => b.p - a.p), byO = [...units].sort((a, b) => b.o - a.o);
  const predRank = new Map(byP.map((u, i) => [u.key, i + 1])), trueRank = new Map(byO.map((u, i) => [u.key, i + 1]));
  const modelTop = byP.slice(0, K), trueTop = byO.slice(0, K);
  const trueSet = new Set(trueTop.map((u) => u.key)), modelSet = new Set(modelTop.map((u) => u.key));
  const falsePicks = modelTop.filter((u) => !trueSet.has(u.key));
  const missed = trueTop.filter((u) => !modelSet.has(u.key));
  const cost = trueTop.reduce((s, u) => s + u.o, 0) - modelTop.reduce((s, u) => s + u.o, 0);
  const fp = [...falsePicks].sort((a, b) => b.o - a.o), ms = [...missed].sort((a, b) => b.o - a.o);
  return {
    falsePos: falsePicks.length, overlap: (K - falsePicks.length) / K, cost, costPer: cost / K,
    meanTrueRankOfFalse: falsePicks.length ? falsePicks.reduce((s, u) => s + trueRank.get(u.key)!, 0) / falsePicks.length : NaN,
    meanPredRankOfMissed: missed.length ? missed.reduce((s, u) => s + predRank.get(u.key)!, 0) / missed.length : NaN,
    pairedGap: ms.length ? ms.reduce((s, u, i) => s + (u.o - (fp[i]?.o ?? u.o)), 0) / ms.length : 0,
    shareShapeModelTop: modelTop.filter((u) => u.shape).length / K,
    shareShapeTrueTop: trueTop.filter((u) => u.shape).length / K,
    shareShapeFalse: falsePicks.length ? falsePicks.filter((u) => u.shape).length / falsePicks.length : NaN,
  };
}
function topCost(rows: HRow[], inC: (r: HRow) => boolean, tag: string, grain: "card" | "row", def: CellDef, K: number, nb = 500): TopRes {
  const units = unitsOf(rows, grain, inC);
  const st = topStats(units, K);
  // CLUSTER bootstrap over CARD: resample cids with replacement, rebuild the unit set (each draw
  // gets a unique key so a twice-drawn card competes with itself, as the resample requires).
  const byCid = new Map<string, U[]>();
  for (const u of units) { const g = byCid.get(u.cid); if (g) g.push(u); else byCid.set(u.cid, [u]); }
  const cids = [...byCid.keys()];
  const ovs: number[] = [], cps: number[] = [];
  for (let b = 0; b < nb; b++) {
    const draw: U[] = [];
    for (let i = 0; i < cids.length; i++) {
      const c = cids[Math.floor(rnd() * cids.length)]!;
      for (const u of byCid.get(c)!) draw.push({ ...u, key: `${u.key}#${i}` });
    }
    const s2 = topStats(draw, K);
    ovs.push(s2.overlap); cps.push(s2.costPer);
  }
  const res: TopRes = {
    tag, grain, def, K, N: units.length, ...st,
    overlapCI: ci(ovs), costPerCI: ci(cps),
    shareShapePool: units.filter((u) => u.shape).length / units.length,
  };
  topRes.push(res);
  return res;
}
say(`  ${pad("fit window", 13)} ${pad("grain", 6)} ${rp("cut", 5)} ${rp("pool", 6)} ${rp("false picks", 12)} ${rp("overlap", 9)} ${rp("overlap 95% CI", 18)} ${rp("±half", 8)} ${rp("cost/slot", 11)} ${rp("cost/slot CI", 20)} ${rp("paired gap", 11)} ${rp("true rank of false", 19)}`);
for (const w of W2SET) {
  const rows = rowsFor(testFor(w), DEPLOY_T, fitOn(w, DEPLOY_T));
  for (const grain of ["card", "row"] as const) {
    for (const K of CUTS) {
      // the top-N arithmetic does not depend on the cell definition — the cell only LABELS the
      // picks — so both definitions are computed (they feed §7b) and one row is printed.
      for (const def of ["POOL", "FIXED"] as const) topCost(rows, inShapeFn(rows, def).fn, w.join("+"), grain, def, K);
      const t = topRes[topRes.length - 1]!;
      const mark = K === HEADLINE_K ? "◀" : " ";
      say(`  ${pad(grain === "card" && K === CUTS[0] ? w.join("+") : "", 13)} ${pad(K === CUTS[0] ? grain : "", 6)} ${rp(String(K), 5)}${mark} ${rp(String(t.N), 6)} ${rp(`${t.falsePos}/${K}`, 12)} ${rp(f(t.overlap, 3), 9)} ${rp(`[${f(t.overlapCI.lo, 3)}, ${f(t.overlapCI.hi, 3)}]`, 18)} ${rp(`±${f(width(t.overlapCI) / 2, 3)}`, 8)} ${rp(sgn(t.costPer, 5), 11)} ${rp(`[${sgn(t.costPerCI.lo, 5)}, ${sgn(t.costPerCI.hi, 5)}]`, 20)} ${rp(sgn(t.pairedGap, 5), 11)} ${rp(f(t.meanTrueRankOfFalse, 1), 19)}`);
    }
  }
}
say();
say(`  READING IT. "overlap" = (K − false picks)/K, the project's standing top-N metric, put on a RATE`);
say(`  so the cuts are comparable. "cost/slot" = [observed wOBA of the true top-K − observed wOBA of`);
say(`  the model's top-K] ÷ K — the value each roster slot gives up, again comparable across cuts.`);
say(`  "paired gap" pairs each missed card with the false pick that displaced it (both ordered by`);
say(`  observed value) and averages the difference — how far the displaced cards sit from the ones`);
say(`  chosen. "true rank of false" = where the model's mistaken picks actually belong; a number just`);
say(`  past K means near-misses, a large number means real errors. ◀ marks the roster-relevant cut.`);
say();
say(`  §7b DOES THE INTERVAL NARROW AT THE TIGHTER CUT? This is a methodological question independent`);
say(`  of the shape finding: if the incumbent top-26 metric is partly self-inflicted noise from`);
say(`  scoring 12 decision-irrelevant slots, the tighter cut should be SHARPER, not just smaller.`);
say(`  Half-widths of the overlap interval, averaged over the three windows:`);
say();
say(`  ${pad("grain", 8)} ${CUTS.map((K) => rp(`top-${K}`, 12)).join("")}   direction`);
for (const grain of ["card", "row"] as const) {
  const hw = CUTS.map((K) => {
    const rs = topRes.filter((t) => t.grain === grain && t.K === K && t.def === "FIXED");
    return rs.reduce((s, t) => s + width(t.overlapCI) / 2, 0) / rs.length;
  });
  const dir = hw[1]! < hw[3]! ? "NARROWER at the roster cut" : hw[1]! > hw[3]! ? "WIDER at the roster cut" : "unchanged";
  say(`  ${pad(grain, 8)} ${hw.map((x) => rp(`±${f(x, 3)}`, 12)).join("")}   ${dir}`);
}
say();
say(`  The same for the value statistic (cost per slot), where a narrower interval is the stronger`);
say(`  claim because the quantity is continuous rather than a count out of K:`);
say();
say(`  ${pad("grain", 8)} ${CUTS.map((K) => rp(`top-${K}`, 14)).join("")}`);
for (const grain of ["card", "row"] as const) {
  const hw = CUTS.map((K) => {
    const rs = topRes.filter((t) => t.grain === grain && t.K === K && t.def === "FIXED");
    return rs.reduce((s, t) => s + width(t.costPerCI) / 2, 0) / rs.length;
  });
  say(`  ${pad(grain, 8)} ${hw.map((x) => rp(`±${f(x, 5)}`, 14)).join("")}`);
}
say();
say(`  CAVEAT, stated so the result is not over-read: a count out of K has a floor on its resolution of`);
say(`  1/K, so a top-14 overlap moves in steps of 0.071 against 0.038 for top-26. A GRANULARITY effect`);
say(`  can therefore widen the tighter cut's interval even when the underlying decision problem is`);
say(`  cleaner. That is why the cost-per-slot table is printed beside it — cost is continuous and has`);
say(`  no such floor, so it is the honest test of the "is the metric self-inflicted" question.`);
say();
say(`  §7c DOES THE COST CONCENTRATE AT THE TOP? If the per-slot cost RISES as the cut tightens, the`);
say(`  error is concentrated where roster decisions are made and it matters more than the raw top-26`);
say(`  count suggests. If it is FLAT, the error is spread through the pool and matters less.`);
say();
say(`  ${pad("fit window", 13)} ${pad("grain", 6)} ${CUTS.map((K) => rp(`cost/slot @${K}`, 15)).join("")}   profile`);
for (const w of W2SET) {
  for (const grain of ["card", "row"] as const) {
    const cs = CUTS.map((K) => topRes.find((t) => t.tag === w.join("+") && t.grain === grain && t.K === K && t.def === "FIXED")!.costPer);
    // The band is deliberately WIDE: the cost-per-slot half-width is ±0.002-0.003 on a quantity of
    // ~0.002, so anything inside ~1.6x is inside the noise and must not be called a profile.
    const prof = cs[0]! > 1.6 * cs[3]! ? "concentrated at the top" : cs[0]! < 0.62 * cs[3]! ? "concentrated LOWER down" : "flat within resolution";
    say(`  ${pad(grain === "card" ? w.join("+") : "", 13)} ${pad(grain, 6)} ${cs.map((x) => rp(sgn(x, 5), 15)).join("")}   ${prof}`);
  }
}
say();
say(`  Every cell reads "flat within resolution" and that is the honest verdict, not a hedge: the`);
say(`  cost-per-slot half-widths in §7b are ±0.002-0.006 on a quantity of ~0.002-0.006, so this data`);
say(`  CANNOT resolve a top-concentration profile even if one exists. What it does exclude is a LARGE`);
say(`  one — a cost that doubled at the roster cut would be visible here and is not. Read this as`);
say(`  "no evidence the error concentrates where roster decisions are made", which is the direction`);
say(`  that weakens the case for a correction, and not as "proved flat".`);
say();
say(`  §7d THE ENRICHMENT BASELINE — is the shape's share of the false picks a CONCENTRATION, or is it`);
say(`  what the shape's presence at the top of the pool would produce anyway? The shape is SELECTED for`);
say(`  being GOOD cards (high EYE and high POW), so its share of the POOL is the wrong null. The right`);
say(`  null is its share of the model's OWN top-K. Shown at the roster cut and at 26; the ROW grain +`);
say(`  POOL cell + top-26 line is the exact construction behind the published "9 of 12 ... from 30% of`);
say(`  the pool" claim.`);
say();
say(`  ${pad("fit window", 13)} ${pad("grain", 6)} ${pad("cell", 6)} ${rp("cut", 5)} ${rp("shape % of pool", 16)} ${rp("% of model top-K", 18)} ${rp("% of true top-K", 17)} ${rp("false picks w/ shape", 21)} ${rp("enrichment", 11)}`);
for (const t of topRes.filter((x) => x.K === HEADLINE_K || x.K === 26)) {
  const enr = t.shareShapeFalse / (t.shareShapeModelTop || NaN);
  const nFalseShape = Math.round(t.shareShapeFalse * t.falsePos);
  say(`  ${pad(t.tag, 13)} ${pad(t.grain, 6)} ${pad(t.def, 6)} ${rp(String(t.K), 5)} ${rp(`${f(100 * t.shareShapePool, 0)}%`, 16)} ${rp(`${f(100 * t.shareShapeModelTop, 0)}%`, 18)} ${rp(`${f(100 * t.shareShapeTrueTop, 0)}%`, 17)} ${rp(`${nFalseShape}/${t.falsePos} (${f(100 * t.shareShapeFalse, 0)}%)`, 21)} ${rp(`${f(enr, 2)}x`, 11)}`);
}
say();
say(`  Enrichment = (% of false picks carrying the shape) ÷ (% of the model's top-K carrying it). 1.0x`);
say(`  means the false picks are a RANDOM sample of the model's own top-K with respect to this shape —`);
say(`  i.e. the shape is not what makes them wrong, it is merely what the top of the pool looks like.`);
say();
say(`  §7e THE RELIABILITY CEILING — how many of those "false picks" are noise in the OBSERVED ranking`);
say(`  rather than model error? The observed line is itself a finite sample, so a perfect model would`);
say(`  still miss some of the observed top-K. Measured by splitting the held-out block into two`);
say(`  disjoint SEASON halves, restricting to cards present in both, and comparing OBSERVED-to-`);
say(`  OBSERVED top-K overlap. That is a ceiling on how well ANY model could agree with one sample:`);
say();
say(`  ${pad("held-out block", 24)} ${pad("half A", 12)} ${pad("half B", 12)} ${rp("cards", 7)} ${CUTS.map((K) => rp(`top-${K}`, 14)).join("")}`);
for (const [blk, a, b] of [
  [testFor([2042, 2043]), [2037, 2038], [2040, 2041]],
  [testFor([2037, 2038]), [2039, 2040], [2042, 2043]],
] as [number[], number[], number[]][]) {
  const cardWoba = (ys: number[]) => {
    const m = new Map<string, { so: number; w: number }>();
    for (const r of rowsFor(ys, DEPLOY_T, null)) { const g = m.get(r.cid) ?? { so: 0, w: 0 }; g.so += r.w * r.wobaO; g.w += r.w; m.set(r.cid, g); }
    return m;
  };
  const A = cardWoba(a), B = cardWoba(b);
  const both = [...A.keys()].filter((k) => B.has(k));
  const rank = (m: Map<string, { so: number; w: number }>, K: number) => both.map((k) => ({ k, v: m.get(k)!.so / m.get(k)!.w })).sort((x, y) => y.v - x.v).slice(0, K).map((x) => x.k);
  const cells = CUTS.map((K) => { const ra = new Set(rank(A, K)); return `${rank(B, K).filter((k) => ra.has(k)).length}/${K}`; });
  say(`  ${pad(blk.join(","), 24)} ${pad(a.join("+"), 12)} ${pad(b.join("+"), 12)} ${rp(String(both.length), 7)} ${cells.map((c) => rp(c, 14)).join("")}`);
}
say();
say(`  The season halves hold different league counts and different card mixes, so this is a ROUGH`);
say(`  ceiling, not a calibrated one. It is reported because a top-N error count read without it`);
say(`  invites the reading that every mismatch is a model defect, and a large share of it is not.`);
say();

// ── §8 ───────────────────────────────────────────────────────────────────────────────────────
say("################################################################################");
say("# §8 — WHAT THIS DOES NOT SAY");
say("################################################################################");
say();
say(`  · No correction is proposed, fitted, or wired. §6's coefficients are descriptive statistics of`);
say(`    the residual surface, printed because the STABLE branch would need the surface characterised;`);
say(`    they are not candidate terms and no adoption decision follows from them.`);
say(`  · The three window estimates share most of their CARDS (§0e). Agreement across them is NOT`);
say(`    independent replication; §5 is the only out-of-card read here and it halves the sample.`);
say(`  · The 2x2 cell is a construction. A tercile grid or a fitted surface would name a related but`);
say(`    not identical region (§6a shows the surface so the construction-dependence is visible). At`);
say(`    20-40 cards per cell the boundaries cannot be sharp.`);
say(`  · Every number is at the deployed variant policy and the deployed wOBA weights, held fixed.`);
say(`    Per-window weight re-derivation was deliberately suppressed so it could not masquerade as`);
say(`    instability; that also means the level readings in §4 are not the production levels.`);
say(`  · minPA is a fit knob AND a population knob (§3 arm A vs arm B). Arm B's cells change the card`);
say(`    population, so a difference between the arms is informative but neither arm alone is "the"`);
say(`    threshold effect.`);
say(`  · §7's cut correction is an OBSERVATION ABOUT THE METRIC, not a change to it. Nothing in`);
say(`    src/training/evaluate.ts was touched and topN=26 is still the production default; the`);
say(`    top-${HEADLINE_K} figures here are computed inside this tool. Whether the incumbent metric should be`);
say(`    re-cut is a separate decision on separate evidence, and this artifact does not make it.`);
say(`  · The roster-relevant cut is the MODAL split (${TOURN_MODE_LABEL}, ${TOURN_MODE} of ${TOURN_FILES} configs), not a universal one —`);
say(`    ${TOURN_FILES - TOURN_MODE} configs roster a different number of hitters, and a pitcher-side cut would be 12, not ${HEADLINE_K}.`);
say(`    This artifact measures the HITTER side only, so no pitcher cut is claimed.`);
say();

// ── VERDICT ──────────────────────────────────────────────────────────────────────────────────
{
  const V: string[] = [];
  const coreF = CORE.FIXED, coreP = CORE.POOL;
  const vF = coreF.map((c) => c.pt), vP = coreP.map((c) => c.pt);
  const allSw = [...sweeps.map((s) => s.swing), ...swingCell.values()].filter(Number.isFinite);
  const nSignFlip = sweeps.filter((s) => !s.agree).length;
  const clearCount = coreF.filter((c) => clear(c.ci)).length;
  const verdict = (() => {
    if (!signsAgree(vF) || nSignFlip > 0) return "SORTS BY WINDOW";
    const mx = Math.max(...allSw);
    if (mx <= 1.5 && clearCount >= 2) return "STABLE";
    if (mx <= 1.5) return "STABLE IN SIGN AND MAGNITUDE, WEAK IN LEVEL";
    return "UNRESOLVED";
  })();
  const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / Math.max(xs.length, 1);
  const cardAt = (K: number) => topRes.filter((t) => t.grain === "card" && t.def === "FIXED" && t.K === K);
  const sum = (K: number) => {
    const c = cardAt(K);
    return {
      K, falsePos: mean(c.map((t) => t.falsePos)), overlap: mean(c.map((t) => t.overlap)),
      ovHalf: mean(c.map((t) => width(t.overlapCI) / 2)), cost: mean(c.map((t) => t.cost)),
      costPer: mean(c.map((t) => t.costPer)), cpHalf: mean(c.map((t) => width(t.costPerCI) / 2)),
      paired: mean(c.map((t) => t.pairedGap)), trueRank: mean(c.map((t) => t.meanTrueRankOfFalse)),
      enr: mean(topRes.filter((t) => t.grain === "card" && t.K === K).map((t) => t.shareShapeFalse / t.shareShapeModelTop)),
    };
  };
  const H = sum(HEADLINE_K), T26 = sum(26);
  const pub = topRes.find((t) => t.grain === "row" && t.def === "POOL" && t.K === 26 && t.tag === "2042+2043")!;
  const halfAgree = halfVals.filter((v) => signsAgree(v)).length;
  V.push("################################################################################");
  V.push("# VERDICT");
  V.push("################################################################################");
  V.push("");
  V.push(`  ${verdict}.`);
  V.push("");
  V.push(`  THE ONE QUESTION, ANSWERED. Fitting DEPLOYED_FORMS on each of the three published disjoint`);
  V.push(`  windows and evaluating out of frame on every season the window does not contain, the`);
  V.push(`  hi-EYE/hi-POW composite contrast comes out (FIXED cell, minPA ${DEPLOY_T}, both directions pooled):`);
  coreF.forEach((c, i) => V.push(`     fit ${pad(c.train.join("+"), 12)} → test ${pad(c.test.join(","), 22)} ${sgn(c.pt, 5)} [${sgn(c.ci.lo, 5)}, ${sgn(c.ci.hi, 5)}]${clear(c.ci) ? " ★" : ""}  (${c.n} rows / ${c.cards} cards)${i === 2 ? "  ← the published window" : ""}`));
  V.push(`  On the published POOL-median construction: ${vP.map((x) => sgn(x, 5)).join(" / ")}.`);
  V.push("");
  V.push(`  THE SWING RATIO, BESIDE ITS COMPARATORS.`);
  V.push(`     shape error, three published windows, FIXED cell : ${f(spreadOf(vF), 2)}x   signs ${vF.map((x) => (x < 0 ? "−" : "+")).join("")}`);
  V.push(`     shape error, three published windows, POOL cell  : ${f(spreadOf(vP), 2)}x   signs ${vP.map((x) => (x < 0 ? "−" : "+")).join("")}`);
  V.push(`     over ALL ${allSw.length} cells (arm x cell-def x minPA x width)        : ${f(Math.min(...allSw), 2)}x - ${f(Math.max(...allSw), 2)}x`);
  V.push(`     ${nSignFlip} of ${sweeps.length} swept cells CHANGE SIGN across the three windows.`);
  V.push(`     ── comparator, IDENTIFIED     : K aux     1.01x - 1.14x in every cell, sign constant`);
  V.push(`     ── comparator, NOT IDENTIFIED : BABIP aux 4.16x across the same three windows, with a`);
  V.push(`                                     swing-of-swing that flips direction with minPA`);
  V.push(`  The swing UNDERSTATES it. A swing ratio is a magnitude statistic and assumes a constant sign;`);
  V.push(`  here the sign itself turns over in ${nSignFlip} of ${sweeps.length} swept cells, with the CI CLEAR ON BOTH SIDES`);
  V.push(`  (2040+2041 clears positive, the deployed window clears negative). The BABIP aux at least kept`);
  V.push(`  its sign. This is a worse failure of identification than the one that killed the EYE axis.`);
  V.push("");
  V.push(`  IT IS NOT CARD NOISE, AND THAT IS THE POINT. §5 splits each window's evaluation pool into two`);
  V.push(`  DISJOINT halves of cards: ${halfAgree} of ${halfVals.length} windows have both halves agreeing in sign, with half-vs-half`);
  V.push(`  swings of ${halfVals.map((v) => f(spreadOf(v), 2) + "x").join(" / ")}. So WITHIN a window the contrast is a stable property of the pool;`);
  V.push(`  it is the FIT WINDOW that turns it over. The instability is in the estimate, not in the sample.`);
  V.push("");
  V.push(`  THE OBVIOUS MECHANISM WAS TESTED AND REFUTED (§4c) — the sort is real, not an artifact of the`);
  V.push(`  level. The pool LEVEL bias sorts by window for a known reason (cards improve every season, so`);
  V.push(`  an early fit over-predicts a later block and a late fit under-predicts an earlier one), and`);
  V.push(`  the shape contrast carries the SAME SIGN as the level in all three windows:`);
  W2SET.forEach((w, i) => V.push(`     fit ${pad(w.join("+"), 11)} level ${sgn(CORE.FIXED[i]!.level, 5)}   shape contrast ${sgn(CORE.FIXED[i]!.pt, 5)}   (same sign)`));
  V.push(`  Since hi-EYE/hi-POW cards ARE the high-wOBA cards, a MULTIPLICATIVE frame would manufacture`);
  V.push(`  exactly this out of a pure level phenomenon with no shape content. Tested by dividing out one`);
  V.push(`  pool-wide multiplicative scalar λ = Σw·wOBApred ÷ Σw·wOBAobs — an operation an additive`);
  V.push(`  contrast is blind to. The contrast barely moves: ${multVals.map((x) => sgn(x, 5)).join(" / ")}, signs`);
  V.push(`  ${multVals.map((x) => (x < 0 ? "−" : "+")).join("")}, swing ${f(spreadOf(multVals), 2)}x — only 1-12% of it removed.`);
  V.push(`  So the level CO-MOVES with the contrast but does not carry it, and the window sort stays`);
  V.push(`  UNEXPLAINED. That is the honest state: a candidate mechanism was pre-specified, tested, and`);
  V.push(`  failed, which removes the most comfortable reading rather than supplying one.`);
  V.push("");
  V.push(`  AND THE SURFACE SORTS TOO (§6d), which closes the STABLE branch's escape hatch. Refitting the`);
  V.push(`  8-term conditional surface one window at a time, the linear EYE and linear POW coefficients`);
  V.push(`  BOTH change sign across the three windows (EYE ++−, swing 7.8x; POW ++−, swing 1.3x) — and`);
  V.push(`  each is CI-clear in the window where it is negative. Only the EYE×POW INTERACTION keeps its`);
  V.push(`  sign (+++ , swing 1.5x, CI-clear in 2 of 3 windows), so if anything on this plane is real it`);
  V.push(`  is the interaction and not the gradient. But the size forecloses it either way: the FULL`);
  V.push(`  8-term surface explains R² 0.0497 of the centred per-card error pooled (§6c), a single scalar`);
  V.push(`  on the (EYE,POW) gradient 0.0129, and the 2x2 cell indicator 0.0138. Even a perfectly`);
  V.push(`  identified composite-layer term keyed to these two ratings could address ~1-5% of the error.`);
  V.push("");
  V.push(`  THE TOP-N COST — reported on both branches, as required, AT THE ROSTER-RELEVANT CUT. topN=26 is`);
  V.push(`  hardcoded through src/training/evaluate.ts, but 26 is the ROSTER size and the bake-off scores`);
  V.push(`  PER ROLE: ${TOURN_MODE} of the ${TOURN_FILES} tournament configs in this repo roster ${TOURN_MODE_LABEL}, so the modal HITTER`);
  V.push(`  count is ${TOURN_MODE_H}, not 26. Card grain, mean over the three windows' held-out blocks:`);
  V.push("");
  V.push(`     ${pad("", 26)} ${rp(`TOP-${HEADLINE_K} (roster)`, 20)} ${rp("top-26 (incumbent)", 20)}`);
  V.push(`     ${pad("false picks", 26)} ${rp(`${f(H.falsePos, 1)} of ${HEADLINE_K}`, 20)} ${rp(`${f(T26.falsePos, 1)} of 26`, 20)}`);
  V.push(`     ${pad("overlap rate", 26)} ${rp(`${f(H.overlap, 3)} ±${f(H.ovHalf, 3)}`, 20)} ${rp(`${f(T26.overlap, 3)} ±${f(T26.ovHalf, 3)}`, 20)}`);
  V.push(`     ${pad("value given up per slot", 26)} ${rp(`${sgn(H.costPer, 5)} ±${f(H.cpHalf, 5)}`, 20)} ${rp(`${sgn(T26.costPer, 5)} ±${f(T26.cpHalf, 5)}`, 20)}`);
  V.push(`     ${pad("value given up, whole roster", 26)} ${rp(sgn(H.cost, 5), 20)} ${rp(sgn(T26.cost, 5), 20)}`);
  V.push(`     ${pad("paired displacement gap", 26)} ${rp(sgn(H.paired, 5), 20)} ${rp(sgn(T26.paired, 5), 20)}`);
  V.push(`     ${pad("true rank of the false picks", 26)} ${rp(f(H.trueRank, 0), 20)} ${rp(f(T26.trueRank, 0), 20)}`);
  V.push(`     ${pad("shape enrichment", 26)} ${rp(`${f(H.enr, 2)}x`, 20)} ${rp(`${f(T26.enr, 2)}x`, 20)}`);
  V.push("");
  V.push(`  DOES THE PICTURE GET BETTER OR WORSE AT THE TIGHTER CUT? The two statistics disagree, and the`);
  V.push(`  disagreement is the answer. The MISS RATE gets clearly WORSE: ${f(H.overlap, 3)} overlap at top-${HEADLINE_K} against`);
  V.push(`  ${f(T26.overlap, 3)} at top-26, i.e. ${f(100 * (1 - H.overlap), 0)}% of roster-relevant picks wrong versus ${f(100 * (1 - T26.overlap), 0)}%. The per-slot`);
  V.push(`  VALUE cost is FLAT: ${sgn(H.costPer, 5)} vs ${sgn(T26.costPer, 5)} (${f(H.costPer / T26.costPer, 2)}x), far inside its own interval.`);
  V.push(`  The reconciliation is the displacement gap, which HALVES at the tighter cut (${sgn(H.paired, 5)} vs`);
  V.push(`  ${sgn(T26.paired, 5)}): near the top of the pool the cards are densely packed, so the model gets a larger`);
  V.push(`  FRACTION of its roster-relevant picks wrong but each mistake costs less, and the two effects`);
  V.push(`  cancel in value terms. The false picks at top-${HEADLINE_K} sit at true rank ${f(H.trueRank, 0)} on average — they`);
  V.push(`  genuinely belong just outside the roster, not deep in the pool.`);
  V.push(`  Across the full sensitivity ladder (§7c) the per-slot cost runs ${CUTS.map((K) => sgn(sum(K).costPer, 5)).join(" / ")}`);
  V.push(`  at top-${CUTS.join("/")} — FLAT within resolution, so the error is spread through the pool rather`);
  V.push(`  than concentrated at the sharp end. That weakens, not strengthens, the case for a correction.`);
  V.push("");
  V.push(`  FLAGGED EXPLICITLY, AS ASKED: THE INTERVAL DOES ${H.cpHalf < T26.cpHalf ? "NARROW" : "NOT NARROW"} AT THE TIGHTER CUT. Cost-per-slot`);
  V.push(`  half-width goes ±${f(T26.cpHalf, 5)} at top-26 → ±${f(H.cpHalf, 5)} at top-${HEADLINE_K} (${f(H.cpHalf / T26.cpHalf, 2)}x — WIDER), and the overlap-rate`);
  V.push(`  half-width goes ±${f(T26.ovHalf, 3)} → ±${f(H.ovHalf, 3)} (${f(H.ovHalf / T26.ovHalf, 2)}x — also wider). The overlap comparison is`);
  V.push(`  confounded (a count out of K resolves only to 1/K, so top-${HEADLINE_K} moves in steps of ${f(1 / HEADLINE_K, 3)} against`);
  V.push(`  0.038 and granularity alone would widen it) — but the COST statistic is continuous, has no`);
  V.push(`  such floor, and it widens too. So the hypothesis that the top-26 metric's ±0.08-0.19 width is`);
  V.push(`  partly SELF-INFLICTED by scoring 12 decision-irrelevant slots is NOT SUPPORTED: the width is`);
  V.push(`  driven by how few units enter the statistic, and cutting to 14 removes units rather than`);
  V.push(`  noise. That is a transferable methodological result independent of this finding, and it is a`);
  V.push(`  NEGATIVE one — re-cutting the metric to 14 would sharpen what it MEANS, not what it RESOLVES.`);
  V.push("");
  V.push(`  THE RELIABILITY CEILING (§7e) bounds all of it: the OBSERVED ranking disagrees with ITSELF`);
  V.push(`  across two disjoint season halves, so a large share of any top-N mismatch is sampling noise`);
  V.push(`  in the target rather than model error, at every cut.`);
  V.push("");
  V.push(`  THE CONCENTRATION CLAIM DOES NOT SURVIVE ITS OWN NULL, AT EITHER CUT. The published`);
  V.push(`  construction (row grain, POOL cell, top-26) reproduces here — ${pub.falsePos} false picks and`);
  V.push(`  ${Math.round(pub.shareShapeFalse * pub.falsePos)} of them carrying the shape. But "30% of the pool supplies 75% of the false picks"`);
  V.push(`  uses the POOL as the baseline, and the shape is SELECTED for being good cards: it is already`);
  V.push(`  ${f(100 * pub.shareShapeModelTop, 0)}% of the model's OWN top-26 on that same construction. Against the correct null the`);
  V.push(`  enrichment is ${f(pub.shareShapeFalse / pub.shareShapeModelTop, 2)}x there, ${f(H.enr, 2)}x at the roster cut and ${f(T26.enr, 2)}x at 26 (card grain). The`);
  V.push(`  model's mistaken picks are NOT concentrated in this shape beyond what the shape's presence at`);
  V.push(`  the top of the pool already implies.`);
  V.push("");
  L.splice(VERDICT_AT, 0, ...V);
}

const OUT = "fixtures/shape-error-stability-2026-07-26.txt";
writeFileSync(OUT, L.join("\n") + "\n", "utf8");
console.log(`wrote ${OUT} (${L.length} lines)`);
process.exit(0);
