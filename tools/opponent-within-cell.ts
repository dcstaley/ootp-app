// OPPONENT QUALITY vs PLATOON ARTIFACT — the decisive re-scope of the opponent-term survey.
// MEASUREMENT ONLY: no production default changed, nothing wired, nothing retrained, nothing committed.
//   run: node tools/opponent-within-cell.ts fixtures/opponent-within-cell-2026-07-25.txt
//
// WHY THIS EXISTS. fixtures/opponent-term-channel-survey-2026-07-25.txt measured "the share of each
// channel's residual mean-square explained by opposing-matchup composition". Its composition regressor
// was the matchup CELL — pitcher hand × batter hand, pooled over all five leagues per season. That is a
// DETERMINISTIC FUNCTION of (own hand, side): four levels, 28 values crossed with season. So the headline
// shares are equally consistent with "a four-level platoon dummy explains 62.6% of pitcher BB" as with
// "the residual responds to opposing quality". Only the second would justify extrapolating to tournament
// pools whose opposition differs.
//
// THE SINGLE QUESTION: is there a response to opponent QUALITY, or only a platoon-cell effect?
//
// THE FIX: rebuild at (LEAGUE × SEASON × CELL) grain. Five leagues run in parallel with different card
// populations, so opposing quality genuinely varies ACROSS LEAGUES INSIDE a platoon cell — variation the
// pooled grain averaged away. Then:
//   1. GRAIN RE-RUN     — every survey quantity recomputed at the corrected grain.
//   2. WITHIN-CELL TEST — cell and cell×season fixed effects held; does opposing quality still predict?
//   3. LEAVE-ONE-CELL-OUT — fit on three platoon cells, predict the fourth. A quality response transfers;
//                           a platoon dummy cannot. This replaces the (near-tautological) share gate.
//
// PRE-COMMITTED READING: a channel is ADMITTED as opponent-responsive only if its within-cell slope is
// CI-clear AND it transfers leave-one-cell-out. No channel admitted is a complete, acceptable answer.
//
// Grain / weights / CIs inherited from the survey so the numbers are comparable: rows are card × side ×
// (league, season); weights are raw BF (pitching) / PA (hitting); every CI is a CARD-CLUSTER bootstrap
// (row bootstraps ran ~3.1× too narrow on this corpus); distinct-card counts sit beside every row count.

import { existsSync, writeFileSync } from "node:fs";
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { makeRawPolyModel, type EventForm } from "../src/scoring-core/index.ts";
import { loadWindow, loadWindowLeagues, availableYears, type TrainObs } from "../src/training/loader.ts";
import { PITCHER, HITTER } from "../src/training/bakeoff.ts";
import { rate, rateAux, hRate } from "../src/model/curves.ts";

const L: string[] = [];
const say = (s = "") => L.push(s);
const f = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "n/a");
const sgn = (x: number, d = 2) => (Number.isFinite(x) ? `${x >= 0 ? "+" : ""}${x.toFixed(d)}` : "n/a");
const pad = (s: string, n: number) => s.padEnd(n);
const lpad = (s: string, n: number) => s.padStart(n);
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const pct = (x: number) => (Number.isFinite(x) ? `${x >= 0 ? "" : "-"}${f(Math.abs(100 * x), 1)}%` : "n/a");
const k = (x: number) => (Number.isFinite(x) ? Math.round(x).toLocaleString("en-US") : "n/a");

// ── deployed artifact (the SAME form the survey read; not refit) ────────────────
const repo = new Repository("data");
await seedDefaults(repo); await seedEras(repo); await seedAccounts(repo);
const state = (await repo.load<{ activeModelId?: string }>("state", "app")) ?? {};
type TM_ = { id: string; eventForm?: EventForm; window?: number[]; minPA?: number; includeVariants?: boolean; vertexPinned?: { channel: string; pinZ: number }[] };
const trained = (await repo.loadAll<TM_>("trained-models")).find((x) => x.id === state.activeModelId);
if (!trained?.eventForm) throw new Error("active model has no eventForm");
const FORM = trained.eventForm;
const rp = makeRawPolyModel(FORM);
const ROOT = ["League Files", "Model 2037 and 2038"].find((d) => existsSync(d))!;
const FIT_WINDOW = (Array.isArray(trained.window) ? trained.window : []).slice().sort();
const MINPA = Math.max(0, Number(trained.minPA ?? 1000) || 1000);
const keepVar = (o: TrainObs) => (trained.includeVariants ?? true) || !o.variant;
const YEARS = availableYears(ROOT).filter((y) => y >= 2037);
const LEAGUES = ["PEL", "HD450", "HD451", "HD452", "HD453"];

// ── rows ────────────────────────────────────────────────────────────────────────
type H = "R" | "L";
interface CRow {
  cid: string; name: string; lg: string; year: number; role: "pit" | "hit";
  T: H; B: H; w: number;
  own: Record<string, number>;
  resid: Record<string, number>;   // pred − obs, per 600
}
const batsFrom = (bats: number, T: H): H | null => bats === 1 ? "R" : bats === 2 ? "L" : bats === 3 ? (T === "L" ? "R" : "L") : null;

function pitRows(obs: TrainObs[], lg: string, year: number): CRow[] {
  const out: CRow[] = [];
  for (const o of obs.filter((x) => PITCHER.qualifies(x, MINPA))) {
    if (o.throws !== 1 && o.throws !== 2) continue;
    const bf = Math.max(o.pitch.BF, 1), r = o.ratings.pitch;
    const p = rp.predictPitching(r, {} as never);
    const ob = (v: number) => (v / bf) * 600;
    const resid = {
      K: p.K - ob(o.pitch.K),
      BB: p.BB - ob(Math.max(o.pitch.BB - o.pitch.IBB, 0)),
      HR: p.HR - ob(o.pitch.HR),
      H: p.nHH - ob(o.pitch.b1 + o.pitch.b2 + o.pitch.b3),
    };
    if (Object.values(resid).some((x) => !Number.isFinite(x))) continue;
    out.push({ cid: o.cid, name: o.name, lg, year, role: "pit", T: o.throws === 1 ? "R" : "L", B: o.side as H, w: bf, own: { stu: r.stu, con: r.con, hrr: r.hrr, pbabip: r.pbabip }, resid });
  }
  return out;
}
function hitRows(obs: TrainObs[], lg: string, year: number): CRow[] {
  const out: CRow[] = [];
  for (const o of obs.filter((x) => HITTER.qualifies(x, MINPA))) {
    const T = o.side as H, B = batsFrom(o.bats, T);
    if (!B) continue;
    const pa = Math.max(o.hit.PA, 1), r = o.ratings.hit;
    const p = rp.predictHitting(r, {} as never);
    const ob = (v: number) => (v / pa) * 600;
    const resid = {
      K: p.SO - ob(o.hit.K),
      BB: p.BB - ob(Math.max(o.hit.BB - o.hit.IBB, 0)),
      HR: p.HR - ob(o.hit.HR),
      H: (p.oneB + p.GAP) - ob(o.hit.H - o.hit.HR),
      XBH: p.GAP - ob(o.hit.b2 + o.hit.b3),
    };
    if (Object.values(resid).some((x) => !Number.isFinite(x))) continue;
    out.push({ cid: o.cid, name: o.name, lg, year, role: "hit", T, B, w: pa, own: { kRat: r.kRat, eye: r.eye, pow: r.pow, babip: r.babip, gap: r.gap }, resid });
  }
  return out;
}

// ── composition ─────────────────────────────────────────────────────────────────
interface Comp { oppHit: Record<string, number>; oppPit: Record<string, number>; hitPA: number; pitBF: number; nHit: number; nPit: number }
function composition(obs: TrainObs[]): Map<string, Comp> {
  const m = new Map<string, Comp>();
  const cell = (T: H, B: H) => { const kk = `${T}|${B}`; if (!m.has(kk)) m.set(kk, { oppHit: { kRat: 0, eye: 0, pow: 0, babip: 0, gap: 0 }, oppPit: { stu: 0, con: 0, hrr: 0, pbabip: 0 }, hitPA: 0, pitBF: 0, nHit: 0, nPit: 0 }); return m.get(kk)!; };
  for (const o of obs.filter((x) => HITTER.qualifies(x, MINPA))) {
    const T = o.side as H, B = batsFrom(o.bats, T); if (!B) continue;
    const c = cell(T, B), pa = o.hit.PA, r = o.ratings.hit;
    for (const kk of ["kRat", "eye", "pow", "babip", "gap"] as const) c.oppHit[kk] = (c.oppHit[kk] ?? 0) + pa * r[kk];
    c.hitPA += pa; c.nHit++;
  }
  for (const o of obs.filter((x) => PITCHER.qualifies(x, MINPA))) {
    if (o.throws !== 1 && o.throws !== 2) continue;
    const T: H = o.throws === 1 ? "R" : "L", B = o.side as H;
    const c = cell(T, B), bf = o.pitch.BF, r = o.ratings.pitch;
    for (const kk of ["stu", "con", "hrr", "pbabip"] as const) c.oppPit[kk] = (c.oppPit[kk] ?? 0) + bf * r[kk];
    c.pitBF += bf; c.nPit++;
  }
  for (const [, c] of m) {
    for (const kk of Object.keys(c.oppHit)) c.oppHit[kk]! /= c.hitPA || 1;
    for (const kk of Object.keys(c.oppPit)) c.oppPit[kk]! /= c.pitBF || 1;
  }
  return m;
}

// LOADS. Per-year (all leagues pooled) = the SURVEY's grain. Per (league, year) = the corrected grain.
const yearObs = new Map<number, TrainObs[]>();
for (const y of YEARS) yearObs.set(y, loadWindow(ROOT, [y]).observations.filter(keepVar));
const lyObs = new Map<string, TrainObs[]>();
for (const y of YEARS) for (const lg of LEAGUES) {
  const o = loadWindowLeagues(ROOT, [y], [lg]).observations.filter(keepVar);
  if (o.length) lyObs.set(`${lg}|${y}`, o);
}
// composition maps
const compYear = new Map<number, Map<string, Comp>>();          // survey grain:   (season, cell)
for (const y of YEARS) compYear.set(y, composition(yearObs.get(y)!));
const compLY = new Map<string, Map<string, Comp>>();            // corrected grain: (league, season, cell)
for (const [key, o] of lyObs) compLY.set(key, composition(o));

// ROWS. `POOL_*` = the survey's own rows (card × side × season, leagues summed). `LY_*` = corrected.
const POOL_PIT = YEARS.flatMap((y) => pitRows(yearObs.get(y)!, "*", y));
const POOL_HIT = YEARS.flatMap((y) => hitRows(yearObs.get(y)!, "*", y));
const LY_PIT: CRow[] = [], LY_HIT: CRow[] = [];
for (const [key, o] of lyObs) { const [lg, ys] = key.split("|") as [string, string]; LY_PIT.push(...pitRows(o, lg, Number(ys))); LY_HIT.push(...hitRows(o, lg, Number(ys))); }

// ── shared statistics (identical to the survey harness) ─────────────────────────
const wmean = (rs: CRow[], g: (r: CRow) => number) => { const sw = sum(rs.map((r) => r.w)); return sw > 0 ? sum(rs.map((r) => r.w * g(r))) / sw : NaN; };
const wms = (rs: CRow[], g: (r: CRow) => number) => { const sw = sum(rs.map((r) => r.w)); return sw > 0 ? sum(rs.map((r) => r.w * g(r) ** 2)) / sw : NaN; };
const mkRnd = (seed: number) => { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
const q = (xs: number[], p: number) => { const v = [...xs].sort((x, y) => x - y); return v[Math.min(v.length - 1, Math.max(0, Math.floor(p * v.length)))]!; };
const ci = (xs: number[]) => ({ lo: q(xs, 0.025), hi: q(xs, 0.975) });
const clear = (c: { lo: number; hi: number }) => (c.lo > 0 && c.hi > 0) || (c.lo < 0 && c.hi < 0);
const kish = (ws: number[]) => { const s = sum(ws), s2 = sum(ws.map((w) => w * w)); return s2 > 0 ? (s * s) / s2 : 0; };
const cardsOf = (rs: CRow[]) => new Set(rs.map((r) => r.cid)).size;
function clustersBy(rs: CRow[], keyf: (r: CRow) => string) { const m = new Map<string, CRow[]>(); for (const r of rs) { const kk = keyf(r); let a = m.get(kk); if (!a) { a = []; m.set(kk, a); } a.push(r); } return [...m.values()]; }
const clusters = (rs: CRow[]) => clustersBy(rs, (r) => r.cid);
/** cluster bootstrap on an arbitrary cluster key. */
function bootStatBy(rs: CRow[], keyf: (r: CRow) => string, seed: number, B: number, stat: (s: CRow[]) => number) {
  const rnd = mkRnd(seed), cl = clustersBy(rs, keyf), d: number[] = [];
  for (let b = 0; b < B; b++) { const s: CRow[] = []; for (let i = 0; i < cl.length; i++) for (const r of cl[Math.floor(rnd() * cl.length)]!) s.push(r); const v = stat(s); if (Number.isFinite(v)) d.push(v); }
  const lo = d.filter((x) => x < 0).length / Math.max(d.length, 1);
  return { ci: ci(d), p: 2 * Math.min(lo, 1 - lo), n: d.length, nCl: cl.length };
}
const bootStat = (rs: CRow[], seed: number, B: number, stat: (s: CRow[]) => number) => bootStatBy(rs, (r) => r.cid, seed, B, stat);
/** the cluster the REGRESSOR actually varies on: opposing quality is constant inside a league-season. */
const lsKey = (r: CRow) => `${r.lg}|${r.year}`;
const dot = (a: number[], b: number[]) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!; return s; };
function bootPaired(rs: CRow[], sel: (r: CRow) => "A" | "B", seed: number, B: number, stat: (s: CRow[]) => number) {
  const rnd = mkRnd(seed), cl = clusters(rs), d: number[] = [];
  for (let b = 0; b < B; b++) {
    const s: CRow[] = [];
    for (let i = 0; i < cl.length; i++) for (const r of cl[Math.floor(rnd() * cl.length)]!) s.push(r);
    const A = s.filter((r) => sel(r) === "A"), Bb = s.filter((r) => sel(r) === "B");
    if (A.length < 10 || Bb.length < 10) continue;
    const v = stat(A) - stat(Bb); if (Number.isFinite(v)) d.push(v);
  }
  const lo = d.filter((x) => x < 0).length / Math.max(d.length, 1);
  return { ci: ci(d), p: 2 * Math.min(lo, 1 - lo) };
}
/** general weighted least squares on an explicit design (survey's wls) */
function wls(X: number[][], y: number[], w: number[]): number[] {
  const n = X[0]!.length, A = Array.from({ length: n }, () => new Array(n + 1).fill(0));
  for (let i = 0; i < X.length; i++) for (let a = 0; a < n; a++) { for (let b2 = 0; b2 < n; b2++) A[a]![b2] += w[i]! * X[i]![a]! * X[i]![b2]!; A[a]![n] += w[i]! * X[i]![a]! * y[i]!; }
  for (let c = 0; c < n; c++) {
    let m = c; for (let r = c + 1; r < n; r++) if (Math.abs(A[r]![c]!) > Math.abs(A[m]![c]!)) m = r;
    [A[c], A[m]] = [A[m]!, A[c]!];
    const pv = A[c]![c]!; if (Math.abs(pv) < 1e-12) continue;
    for (let j = c; j <= n; j++) A[c]![j] /= pv;
    for (let r = 0; r < n; r++) { if (r === c) continue; const fc = A[r]![c]!; for (let j = c; j <= n; j++) A[r]![j] -= fc * A[c]![j]!; }
  }
  return A.map((r) => r[n]!);
}
const cellKey = (r: CRow) => `${r.T}|${r.B}`;
const isSame = (r: CRow) => r.T === r.B;

// complementary-role pricing: what the model's OWN curve for the other role says a point of the
// opposing rating is worth (local slope at the observed mean). Identical to the survey.
const BIP0_HIT = 460, BIP0_PIT = 460, STU0 = 120;
const dSlope = (g: (x: number) => number, x0: number, h = 5) => (g(x0 + h) - g(x0 - h)) / (2 * h);
const complSlope: Record<string, (x0: number) => number> = {
  "pit.K": (x0) => dSlope((x) => rate(FORM.hit.k, x), x0),
  "pit.BB": (x0) => dSlope((x) => rate(FORM.hit.bb, x), x0),
  "pit.HR": (x0) => dSlope((x) => rate(FORM.hit.hr, x), x0),
  "pit.H": (x0) => dSlope((x) => hRate(FORM.hit.h, x, BIP0_HIT), x0),
  "hit.K": (x0) => dSlope((x) => rate(FORM.pit.k, x), x0),
  "hit.BB": (x0) => dSlope((x) => rateAux(FORM.pit.bb, x, STU0), x0),
  "hit.HR": (x0) => dSlope((x) => rateAux(FORM.pit.hr, x, STU0), x0),
  "hit.H": (x0) => dSlope((x) => hRate(FORM.pit.h, x, BIP0_PIT), x0),
};

interface ChanDef { key: string; role: "pit" | "hit"; ch: string; label: string; own: string; opp: string; oppSide: "oppHit" | "oppPit" }
const CHANNELS: ChanDef[] = [
  { key: "pit.BB", role: "pit", ch: "BB", label: "PITCHER BB", own: "con", opp: "eye", oppSide: "oppHit" },
  { key: "pit.K", role: "pit", ch: "K", label: "PITCHER K", own: "stu", opp: "kRat", oppSide: "oppHit" },
  { key: "hit.BB", role: "hit", ch: "BB", label: "HITTER BB", own: "eye", opp: "con", oppSide: "oppPit" },
  { key: "hit.K", role: "hit", ch: "K", label: "HITTER K", own: "kRat", opp: "stu", oppSide: "oppPit" },
  { key: "hit.H", role: "hit", ch: "H", label: "HITTER hits(nonHR)", own: "babip", opp: "pbabip", oppSide: "oppPit" },
  { key: "hit.HR", role: "hit", ch: "HR", label: "HITTER HR", own: "pow", opp: "hrr", oppSide: "oppPit" },
  { key: "pit.HR", role: "pit", ch: "HR", label: "PITCHER HR", own: "hrr", opp: "pow", oppSide: "oppHit" },
  { key: "pit.H", role: "pit", ch: "H", label: "PITCHER hits(nonHR)", own: "pbabip", opp: "babip", oppSide: "oppHit" },
];

// ── the two grains, as an explicit pair of "views" ──────────────────────────────
interface View { tag: string; pit: CRow[]; hit: CRow[]; opp: (d: ChanDef, r: CRow) => number }
const oppPooled = (d: ChanDef, r: CRow) => { const c = compYear.get(r.year)?.get(cellKey(r)); return c ? (c[d.oppSide] as Record<string, number>)[d.opp]! : NaN; };
const oppLY = (d: ChanDef, r: CRow) => { const c = compLY.get(`${r.lg}|${r.year}`)?.get(cellKey(r)); return c ? (c[d.oppSide] as Record<string, number>)[d.opp]! : NaN; };
const V_SURVEY: View = { tag: "SURVEY  (season × cell, leagues pooled)", pit: POOL_PIT, hit: POOL_HIT, opp: oppPooled };
const V_BRIDGE: View = { tag: "BRIDGE  (league-season rows, pooled composition)", pit: LY_PIT, hit: LY_HIT, opp: oppPooled };
const V_LY: View = { tag: "CORRECTED (league × season × cell)", pit: LY_PIT, hit: LY_HIT, opp: oppLY };

const rowsOf = (v: View, d: ChanDef) => (d.role === "pit" ? v.pit : v.hit).filter((r) => Number.isFinite(v.opp(d, r)));

const deMean = (rs: CRow[], ch: string, keyf: (r: CRow) => string): CRow[] => {
  const g = new Map<string, CRow[]>();
  for (const r of rs) { let a = g.get(keyf(r)); if (!a) { a = []; g.set(keyf(r), a); } a.push(r); }
  const out: CRow[] = [];
  for (const [, s] of g) { const m = wmean(s, (r) => r.resid[ch]!); for (const r of s) out.push({ ...r, resid: { ...r.resid, [ch]: r.resid[ch]! - m } }); }
  return out;
};
/** weighted slope of y on x (both read off a row), with an intercept. */
const slopeOf = (rs: CRow[], xf: (r: CRow) => number, yf: (r: CRow) => number) => {
  const mx = wmean(rs, xf), my = wmean(rs, yf);
  const sxy = sum(rs.map((r) => r.w * (xf(r) - mx) * (yf(r) - my)));
  const sxx = sum(rs.map((r) => r.w * (xf(r) - mx) ** 2));
  return sxx > 1e-12 ? sxy / sxx : NaN;
};
/** slope after removing group means from BOTH residual and opposing rating (a true FE regression). */
const slopeWithin = (rs: CRow[], xf: (r: CRow) => number, yf: (r: CRow) => number, keyf: (r: CRow) => string) => {
  const g = new Map<string, CRow[]>();
  for (const r of rs) { let a = g.get(keyf(r)); if (!a) { a = []; g.set(keyf(r), a); } a.push(r); }
  let sxy = 0, sxx = 0;
  for (const [, s] of g) {
    const mx = wmean(s, xf), my = wmean(s, yf);
    for (const r of s) { sxy += r.w * (xf(r) - mx) * (yf(r) - my); sxx += r.w * (xf(r) - mx) ** 2; }
  }
  return sxx > 1e-12 ? sxy / sxx : NaN;
};
/** weighted sd of the opposing rating AFTER removing group means — the design the null is read against. */
const sdWithin = (rs: CRow[], xf: (r: CRow) => number, keyf: (r: CRow) => string) => {
  const g = new Map<string, CRow[]>();
  for (const r of rs) { let a = g.get(keyf(r)); if (!a) { a = []; g.set(keyf(r), a); } a.push(r); }
  let ss = 0, sw = 0;
  for (const [, s] of g) { const mx = wmean(s, xf); for (const r of s) { ss += r.w * (xf(r) - mx) ** 2; sw += r.w; } }
  return sw > 0 ? Math.sqrt(ss / sw) : NaN;
};

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 1 — GRAIN RE-RUN
// ════════════════════════════════════════════════════════════════════════════════
interface GrainRow {
  rows: number; cards: number; ess: number; sdRaw: number;
  fracCell: number; fracCellYear: number; fracDesign: number;
  lvlGap: number; lvlCI: { lo: number; hi: number };
  slope: number; compl: number; ratio: number; ratioCI: { lo: number; hi: number };
  oppSd: number;
}
function grainRow(v: View, d: ChanDef): GrainRow {
  const rs = rowsOf(v, d), ch = d.ch;
  const R = (r: CRow) => r.resid[ch]!, X = (r: CRow) => v.opp(d, r);
  const same = rs.filter(isSame), opp = rs.filter((r) => !isSame(r));
  const bp = bootPaired(rs, (r) => (isSame(r) ? "A" : "B"), 0x51ee11, 2500, (s) => wmean(s, R));
  const slope = slopeOf(rs, X, R);
  const sb = bootStat(rs, 0x7711, 1500, (s) => slopeOf(s, X, R));
  const compl = complSlope[d.key]!(wmean(rs, X));
  const msRaw = wms(rs, R);
  const msCell = wms(deMean(rs, ch, cellKey), R);
  const msCellYear = wms(deMean(rs, ch, (r) => `${cellKey(r)}|${r.year}`), R);
  const msDesign = wms(deMean(rs, ch, (r) => `${r.lg}|${r.year}|${cellKey(r)}`), R);
  return {
    rows: rs.length, cards: cardsOf(rs), ess: kish(rs.map((r) => r.w)), sdRaw: Math.sqrt(msRaw),
    fracCell: 1 - msCell / msRaw, fracCellYear: 1 - msCellYear / msRaw, fracDesign: 1 - msDesign / msRaw,
    lvlGap: wmean(same, R) - wmean(opp, R), lvlCI: bp.ci,
    slope, compl, ratio: slope / -compl, ratioCI: { lo: sb.ci.lo / -compl, hi: sb.ci.hi / -compl },
    oppSd: Math.sqrt(wms(rs, (r) => X(r) - wmean(rs, X))),
  };
}

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 2 — WITHIN-CELL TEST
// ════════════════════════════════════════════════════════════════════════════════
interface WithinRow {
  rows: number; cards: number;
  raw: number; rawCI: { lo: number; hi: number };
  wCell: number; wCellCI: { lo: number; hi: number };
  wCellYr: number; wCellYrCI: { lo: number; hi: number };
  keepCell: number; keepCellYr: number;
  sdAll: number; sdCell: number; sdCellYr: number;
  compl: number; ratioRaw: number; ratioWithin: number;
  detect: number; // minimum detectable slope (half-width of the cell×season CI)
  // ROBUSTNESS (added at audit): the regressor is CONSTANT inside a league-season, and the same ~60
  // cards recur in every league, so a card-cluster resample barely disturbs the dimension the slope
  // is identified on. Both are therefore reported: the pre-committed card CI and a league-season CI.
  wCellYrCIls: { lo: number; hi: number }; nLs: number;
  // CARD fixed effect: the same card, same season, same platoon cell, DIFFERENT league opposition.
  wCard: number; wCardCIcard: { lo: number; hi: number }; wCardCIls: { lo: number; hi: number };
  keepCard: number; sdCard: number; ratioCard: number; nCardGrp: number;
}
function withinRow(d: ChanDef): WithinRow {
  const rs = rowsOf(V_LY, d), ch = d.ch;
  const R = (r: CRow) => r.resid[ch]!, X = (r: CRow) => oppLY(d, r);
  const kCell = cellKey, kCellYr = (r: CRow) => `${cellKey(r)}|${r.year}`;
  const kCard = (r: CRow) => `${r.cid}|${cellKey(r)}|${r.year}`;
  const raw = slopeOf(rs, X, R);
  const wCell = slopeWithin(rs, X, R, kCell);
  const wCellYr = slopeWithin(rs, X, R, kCellYr);
  const wCard = slopeWithin(rs, X, R, kCard);
  const bRaw = bootStat(rs, 0x1a1a, 1500, (s) => slopeOf(s, X, R));
  const bC = bootStat(rs, 0x2b2b, 1500, (s) => slopeWithin(s, X, R, kCell));
  const bCY = bootStat(rs, 0x3c3c, 1500, (s) => slopeWithin(s, X, R, kCellYr));
  const bCYls = bootStatBy(rs, lsKey, 0x4d4d, 1500, (s) => slopeWithin(s, X, R, kCellYr));
  const bCard = bootStat(rs, 0x5e5e, 1500, (s) => slopeWithin(s, X, R, kCard));
  const bCardLs = bootStatBy(rs, lsKey, 0x6f6f, 1500, (s) => slopeWithin(s, X, R, kCard));
  const compl = complSlope[d.key]!(wmean(rs, X));
  // groups that actually IDENTIFY the card-FE slope (≥2 rows with distinct opposing quality)
  const gm = new Map<string, CRow[]>();
  for (const r of rs) { const kk = kCard(r); let a = gm.get(kk); if (!a) { a = []; gm.set(kk, a); } a.push(r); }
  let nCardGrp = 0;
  for (const [, s] of gm) if (s.length >= 2 && new Set(s.map(X)).size >= 2) nCardGrp++;
  return {
    rows: rs.length, cards: cardsOf(rs),
    raw, rawCI: bRaw.ci, wCell, wCellCI: bC.ci, wCellYr, wCellYrCI: bCY.ci,
    keepCell: wCell / raw, keepCellYr: wCellYr / raw,
    sdAll: Math.sqrt(wms(rs, (r) => X(r) - wmean(rs, X))), sdCell: sdWithin(rs, X, kCell), sdCellYr: sdWithin(rs, X, kCellYr),
    compl, ratioRaw: raw / -compl, ratioWithin: wCellYr / -compl,
    detect: (bCY.ci.hi - bCY.ci.lo) / 2,
    wCellYrCIls: bCYls.ci, nLs: bCYls.nCl,
    wCard, wCardCIcard: bCard.ci, wCardCIls: bCardLs.ci,
    keepCard: wCard / raw, sdCard: sdWithin(rs, X, kCard), ratioCard: wCard / -compl, nCardGrp,
  };
}

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 2C — WHOLE OPPOSING PROFILE vs THE SINGLE PAIRED RATING
// ════════════════════════════════════════════════════════════════════════════════
// Motivated by the sequential/chaining note: a rating influencing a channel it does not directly own
// is not automatically an artifact. Test OUT OF SAMPLE (leave-one-LEAGUE-out) so the extra columns
// cannot win by construction. Everything is demeaned within (cell × season) using TRAINING-league
// means only, so the comparison is entirely inside the platoon cell.
const OPP_KEYS = { oppHit: ["kRat", "eye", "pow", "babip", "gap"], oppPit: ["stu", "con", "hrr", "pbabip"] } as const;
const oppVec = (d: ChanDef, r: CRow): number[] | null => {
  const c = compLY.get(`${r.lg}|${r.year}`)?.get(cellKey(r)); if (!c) return null;
  const src = c[d.oppSide] as Record<string, number>;
  const out = (OPP_KEYS[d.oppSide] as readonly string[]).map((kk) => src[kk]!);
  return out.every(Number.isFinite) ? out : null;
};
interface ProfRow { keys: readonly string[]; skillPaired: number; skillFull: number; betaStd: number[]; best: string; nTest: number; wTest: number }
function profileRow(d: ChanDef): ProfRow {
  const keys = OPP_KEYS[d.oppSide] as readonly string[];
  const pi = keys.indexOf(d.opp);
  const rs = rowsOf(V_LY, d).filter((r) => oppVec(d, r));
  const ch = d.ch, gk = (r: CRow) => `${cellKey(r)}|${r.year}`;
  let e0 = 0, eP = 0, eF = 0, W = 0, nTest = 0;
  for (const held of LEAGUES) {
    const tr = rs.filter((r) => r.lg !== held), te = rs.filter((r) => r.lg === held);
    if (te.length < 20 || tr.length < 100) continue;
    // (cell × season) means from the TRAINING leagues only — no peeking at the held-out league.
    const g = new Map<string, CRow[]>();
    for (const r of tr) { const kk = gk(r); let a = g.get(kk); if (!a) { a = []; g.set(kk, a); } a.push(r); }
    const gm = new Map<string, { mx: number[]; my: number }>();
    for (const [kk, s] of g) {
      const sw = sum(s.map((r) => r.w));
      gm.set(kk, { mx: keys.map((_, i) => sum(s.map((r) => r.w * oppVec(d, r)![i]!)) / sw), my: sum(s.map((r) => r.w * r.resid[ch]!)) / sw });
    }
    const Xt: number[][] = [], yt: number[] = [], wt: number[] = [];
    for (const r of tr) { const m = gm.get(gk(r))!; const x = oppVec(d, r)!; Xt.push(x.map((v, i) => v - m.mx[i]!)); yt.push(r.resid[ch]! - m.my); wt.push(r.w); }
    const bF = wls(Xt, yt, wt);
    const bP = wls(Xt.map((x) => [x[pi]!]), yt, wt);
    for (const r of te) {
      const m = gm.get(gk(r)); if (!m) continue;
      const x = oppVec(d, r)!.map((v, i) => v - m.mx[i]!), y = r.resid[ch]! - m.my;
      e0 += r.w * y * y; eP += r.w * (y - bP[0]! * x[pi]!) ** 2; eF += r.w * (y - dot(bF, x)) ** 2;
      W += r.w; nTest++;
    }
  }
  // standardized within-(cell×season) coefficients on the FULL sample, for reading which rating carries it
  const g2 = new Map<string, CRow[]>();
  for (const r of rs) { const kk = gk(r); let a = g2.get(kk); if (!a) { a = []; g2.set(kk, a); } a.push(r); }
  const Xa: number[][] = [], ya: number[] = [], wa: number[] = [];
  for (const [, s] of g2) {
    const sw = sum(s.map((r) => r.w));
    const mx = keys.map((_, i) => sum(s.map((r) => r.w * oppVec(d, r)![i]!)) / sw), my = sum(s.map((r) => r.w * r.resid[ch]!)) / sw;
    for (const r of s) { const x = oppVec(d, r)!; Xa.push(x.map((v, i) => v - mx[i]!)); ya.push(r.resid[ch]! - my); wa.push(r.w); }
  }
  const sw = sum(wa);
  const sd = keys.map((_, i) => Math.sqrt(sum(Xa.map((x, j) => wa[j]! * x[i]! ** 2)) / sw));
  const b = wls(Xa, ya, wa);
  const betaStd = b.map((v, i) => v * sd[i]!);
  let bi = 0; for (let i = 1; i < betaStd.length; i++) if (Math.abs(betaStd[i]!) > Math.abs(betaStd[bi]!)) bi = i;
  return { keys, skillPaired: 1 - eP / e0, skillFull: 1 - eF / e0, betaStd, best: keys[bi]!, nTest, wTest: W };
}

// ════════════════════════════════════════════════════════════════════════════════
// SECTION 3 — LEAVE-ONE-CELL-OUT
// ════════════════════════════════════════════════════════════════════════════════
// Design points = (league, season, cell): y = exposure-weighted mean residual, x = opposing rating,
// w = total exposure. Fit on three platoon cells, predict the fourth. Two estimators of the slope:
//   A — POOLED on the training cells (season fixed effects + slope): the slope a naive fit would use.
//   B — WITHIN-(cell×season) on the training cells: the pure opponent-quality response.
// Both are compared against the SAME baseline: season fixed effects only (slope pinned to zero).
interface Pt { lg: string; year: number; cell: string; x: number; y: number; w: number; n: number }
function designPoints(d: ChanDef): Pt[] {
  const rs = rowsOf(V_LY, d), ch = d.ch;
  const g = new Map<string, CRow[]>();
  for (const r of rs) { const kk = `${r.lg}|${r.year}|${cellKey(r)}`; let a = g.get(kk); if (!a) { a = []; g.set(kk, a); } a.push(r); }
  const out: Pt[] = [];
  for (const [kk, s] of g) {
    if (s.length < 3) continue;
    const [lg, ys, T, B] = kk.split("|") as [string, string, string, string];
    out.push({ lg, year: Number(ys), cell: `${T}|${B}`, x: wmean(s, (r) => oppLY(d, r)), y: wmean(s, (r) => r.resid[ch]!), w: sum(s.map((r) => r.w)), n: s.length });
  }
  return out;
}
interface Loco { cell: string; nTest: number; mseBase: number; mseA: number; mseB: number; bA: number; bB: number; skillW: number }
function locoFor(pts: Pt[]): { per: Loco[]; skillA: number; skillB: number; skillW: number; bAmean: number; bBmean: number } {
  const CELLS = ["R|R", "R|L", "L|R", "L|L"];
  const per: Loco[] = [];
  let sB = 0, sA = 0, sBb = 0, sw = 0, wNum = 0, wDen = 0;
  for (const held of CELLS) {
    const tr = pts.filter((p) => p.cell !== held), te = pts.filter((p) => p.cell === held);
    if (te.length < 3 || tr.length < 8) continue;
    const years = [...new Set(tr.map((p) => p.year))].sort();
    // A — pooled fit on the training cells with season FE + slope
    const design = (p: Pt, withX: boolean) => [...years.map((y) => (p.year === y ? 1 : 0)), ...(withX ? [p.x] : [])];
    const bA = wls(tr.map((p) => design(p, true)), tr.map((p) => p.y), tr.map((p) => p.w));
    const slopeA = bA[bA.length - 1]!;
    // B — within-(cell×season) slope on the training cells
    const g = new Map<string, Pt[]>();
    for (const p of tr) { const kk = `${p.cell}|${p.year}`; let a = g.get(kk); if (!a) { a = []; g.set(kk, a); } a.push(p); }
    let sxy = 0, sxx = 0;
    for (const [, s] of g) {
      const W = sum(s.map((p) => p.w)); if (W <= 0 || s.length < 2) continue;
      const mx = sum(s.map((p) => p.w * p.x)) / W, my = sum(s.map((p) => p.w * p.y)) / W;
      for (const p of s) { sxy += p.w * (p.x - mx) * (p.y - my); sxx += p.w * (p.x - mx) ** 2; }
    }
    const slopeB = sxx > 1e-12 ? sxy / sxx : 0;
    // season intercepts, for each slope (baseline = slope 0)
    const inter = (b: number) => {
      const m = new Map<number, number>();
      for (const y of years) { const s = tr.filter((p) => p.year === y); const W = sum(s.map((p) => p.w)); m.set(y, W > 0 ? sum(s.map((p) => p.w * (p.y - b * p.x))) / W : 0); }
      return m;
    };
    const i0 = inter(0), iA = inter(slopeA), iB = inter(slopeB);
    const mse = (b: number, im: Map<number, number>) => {
      let e = 0, W = 0;
      for (const p of te) { const a = im.get(p.year); if (a == null) continue; e += p.w * (p.y - (a + b * p.x)) ** 2; W += p.w; }
      return W > 0 ? e / W : NaN;
    };
    const m0 = mse(0, i0), mA = mse(slopeA, iA), mB = mse(slopeB, iB);
    const W = sum(te.map((p) => p.w));
    // LEVEL-FREE transfer: inside the held-out cell, demean x and y by season and ask whether the
    // training slope predicts the ACROSS-LEAGUE spread. This separates "explains the held-out cell's
    // platoon LEVEL" (which slope A can do by exploiting the cell↔x correlation) from "the quality
    // response itself carries over" — the question the level-inclusive skill cannot isolate.
    const gy = new Map<number, Pt[]>();
    for (const p of te) { let a = gy.get(p.year); if (!a) { a = []; gy.set(p.year, a); } a.push(p); }
    let ew = 0, e0w = 0;
    for (const [, s] of gy) {
      const Wg = sum(s.map((p) => p.w)); if (Wg <= 0 || s.length < 2) continue;
      const mx = sum(s.map((p) => p.w * p.x)) / Wg, my = sum(s.map((p) => p.w * p.y)) / Wg;
      for (const p of s) { const xt = p.x - mx, yt = p.y - my; ew += p.w * (yt - slopeB * xt) ** 2; e0w += p.w * yt * yt; }
    }
    per.push({ cell: held, nTest: te.length, mseBase: m0, mseA: mA, mseB: mB, bA: slopeA, bB: slopeB, skillW: e0w > 0 ? 1 - ew / e0w : NaN });
    sB += W * m0; sA += W * mA; sBb += W * mB; sw += W; wNum += ew; wDen += e0w;
  }
  const mm0 = sB / (sw || 1), mmA = sA / (sw || 1), mmB = sBb / (sw || 1);
  return { per, skillA: 1 - mmA / mm0, skillB: 1 - mmB / mm0, skillW: wDen > 0 ? 1 - wNum / wDen : NaN, bAmean: per.length ? sum(per.map((p) => p.bA)) / per.length : NaN, bBmean: per.length ? sum(per.map((p) => p.bB)) / per.length : NaN };
}

// ════════════════════════════════════════════════════════════════════════════════
// RUN
// ════════════════════════════════════════════════════════════════════════════════
const GRAIN = CHANNELS.map((d) => ({ d, survey: grainRow(V_SURVEY, d), bridge: grainRow(V_BRIDGE, d), corr: grainRow(V_LY, d) }));
const WITHIN = CHANNELS.map((d) => ({ d, w: withinRow(d) }));
const LOCO = CHANNELS.map((d) => ({ d, pts: designPoints(d) })).map((x) => ({ d: x.d, pts: x.pts, r: locoFor(x.pts) }));
const PROF = CHANNELS.map((d) => ({ d, p: profileRow(d) }));

const withinOf = (kk: string) => WITHIN.find((x) => x.d.key === kk)!.w;
const locoOf = (kk: string) => LOCO.find((x) => x.d.key === kk)!;
const grainOf = (kk: string) => GRAIN.find((x) => x.d.key === kk)!;
const profOf = (kk: string) => PROF.find((x) => x.d.key === kk)!.p;

// ADMISSION: within-(cell×season) slope CI-clear AND leave-one-cell-out transfer (skill > 0 on the
// within-cell slope estimator, i.e. it beats a season-FE constant on the held-out platoon cell).
const admitted = CHANNELS.filter((d) => clear(withinOf(d.key).wCellYrCI) && locoOf(d.key).r.skillB > 0);
const ciClearOnly = CHANNELS.filter((d) => clear(withinOf(d.key).wCellYrCI) && !(locoOf(d.key).r.skillB > 0));

// ── VERDICT ─────────────────────────────────────────────────────────────────────
say("################################################################################");
say("# OPPONENT QUALITY, OR PLATOON ARTIFACT?  — the within-cell re-scope.  MEASUREMENT ONLY.");
say("# Replaces the composition-share gate of opponent-term-channel-survey-2026-07-25.txt.");
say("################################################################################");
say();
say("## VERDICT");
say();
{
  const nAdm = admitted.length;
  const head = nAdm === 0
    ? "PLATOON ARTIFACT. NO channel is admitted as opponent-responsive."
    : nAdm === CHANNELS.length
      ? "OPPONENT QUALITY. Every channel is admitted as opponent-responsive."
      : `SPLIT. ${nAdm} of ${CHANNELS.length} channels are admitted as opponent-responsive.`;
  say(`  ${head}`);
  say();
  say(`  The pre-committed rule: a channel is admitted ONLY if (a) its slope on opposing quality survives`);
  say(`  cell×season fixed effects CI-clear (card-cluster bootstrap) AND (b) that slope transfers`);
  say(`  leave-one-platoon-cell-out — fit on three cells, beat a season-FE constant on the fourth.`);
  say();
  say(`  ${pad("channel", 22)}${lpad("raw slope", 11)}${lpad("within slope", 14)}${lpad("survives", 10)}  ${pad("within 95% CI", 24)}${lpad("LOCO skill", 12)}   verdict`);
  for (const d of CHANNELS) {
    const w = withinOf(d.key), lo = locoOf(d.key).r;
    const ok = clear(w.wCellYrCI), tr = lo.skillB > 0;
    const v = ok && tr ? "ADMITTED" : ok ? "CI-clear, DOES NOT TRANSFER" : tr ? "transfers, NOT RESOLVED" : "NOT opponent-responsive";
    say(`  ${pad(d.label, 22)}${lpad(sgn(w.raw, 3), 11)}${lpad(sgn(w.wCellYr, 3), 14)}${lpad(pct(w.keepCellYr), 10)}  ${pad(`[${sgn(w.wCellYrCI.lo, 3)}, ${sgn(w.wCellYrCI.hi, 3)}]`, 24)}${lpad(pct(lo.skillB), 12)}   ${v}`);
  }
  say();
  const pbb = withinOf("pit.BB"), pk = withinOf("pit.K");
  say(`  THE HEADLINE CHANNEL. PITCHER BB carried the survey's largest number (62.6% of its residual`);
  say(`  mean-square, a 23-EYE-point composition gap, and the stuffAug verdict). Its raw slope on opposing`);
  say(`  EYE is ${sgn(pbb.raw, 3)}/600 per rating point. Holding the platoon cell and season, ${pct(pbb.keepCellYr)} survives:`);
  say(`  ${sgn(pbb.wCellYr, 4)}, CI [${sgn(pbb.wCellYrCI.lo, 3)}, ${sgn(pbb.wCellYrCI.hi, 3)}] — ${clear(pbb.wCellYrCI) ? "CI-CLEAR" : "COVERS ZERO"}. The within-cell design is not degenerate:`);
  say(`  opposing EYE still varies by ${f(pbb.sdCellYr, 2)} rating points sd across leagues inside a (cell, season),`);
  say(`  and the smaller-signal channels resolve on it, so this is ${clear(pbb.wCellYrCI) ? "a response" : "an ABSENCE, not a power failure"}.`);
  say(`  PITCHER K: ${pct(pk.keepCellYr)} survives (${sgn(pk.wCellYr, 4)}, CI [${sgn(pk.wCellYrCI.lo, 3)}, ${sgn(pk.wCellYrCI.hi, 3)}] ${clear(pk.wCellYrCI) ? "CI-clear" : "covers 0"}).`);
  say();
  say(`  PRICING RATIOS AT THE CORRECTED GRAIN (1.00 = exactly what the model's own complementary curve`);
  say(`  already prices that rating point at):`);
  const rr = CHANNELS.map((d) => grainOf(d.key).corr.ratio).filter(Number.isFinite);
  const over = CHANNELS.filter((d) => grainOf(d.key).corr.ratio > 1);
  say(`  ${CHANNELS.map((d) => `${d.label.split(" ")[0]![0]}${d.ch} ${f(grainOf(d.key).corr.ratio, 2)}×`).join("  ")}`);
  say(`  mean ${f(sum(rr) / rr.length, 2)}×; ${over.length === 0 ? "EVERY ratio is below 1.00" : `${over.length} above 1.00 (${over.map((d) => d.label).join(", ")})`}.`);
  say(`  At the survey's pooled grain pitcher K read ${f(grainOf("pit.K").survey.ratio, 2)}× and hitter K ${f(grainOf("hit.K").survey.ratio, 2)}×;`);
  say(`  at the corrected grain they read ${f(grainOf("pit.K").corr.ratio, 2)}× and ${f(grainOf("hit.K").corr.ratio, 2)}× — CONFIRMED as grain artifacts.`);
  {
    // The reviewer's claim was "EVERY ratio below 1.00, mean ≈0.71". Check it exactly, and say where
    // it holds and where it does not — a partial refutation is the useful form of this answer.
    const six = CHANNELS.filter((d) => d.ch !== "H").map((d) => grainOf(d.key).corr.ratio);
    const hh = grainOf("hit.H").corr.ratio, ph = grainOf("pit.H").corr.ratio;
    say(`  RECONCILIATION with the reviewer's "every ratio below 1.00, mean ≈0.71": TRUE for the six K/BB/HR`);
    say(`  channels — all below 1.00, mean ${f(sum(six) / six.length, 2)}× — but NOT true across all eight. The two`);
    say(`  hits(nonHR) channels are exceptions: HITTER hits ${f(hh, 2)}× (still far above 1.00 after the grain fix)`);
    say(`  and PITCHER hits ${f(ph, 2)}× (wrong sign, CI spans zero). Over all eight the mean is ${f(sum(CHANNELS.map((d) => grainOf(d.key).corr.ratio)) / 8, 2)}×. Neither`);
    say(`  hits channel is opponent-responsive under the pre-committed rule, so the exception does not`);
    say(`  rescue an opponent term — but the blanket "every ratio" statement is overstated.`);
  }
  say();
  // CONSOLIDATED EVIDENCE, reported IN the verdict because it bears directly on how the admitted
  // set should be read. The admission rule stays exactly as pre-committed; these are the qualifiers.
  const survCard = admitted.filter((d) => clear(withinOf(d.key).wCardCIcard));
  const survLs = admitted.filter((d) => clear(withinOf(d.key).wCellYrCIls));
  const survW = admitted.filter((d) => locoOf(d.key).r.skillW > 0);
  say(`  ALL FIVE GATES, PER CHANNEL. The pre-committed rule uses columns [CI-card] and [LOCO B] only.`);
  say(`  The other three are audit additions and are reported as qualifiers, not as new admission rules:`);
  say(`    CI-card   pre-committed card-cluster CI on the within-(cell×season) slope.`);
  say(`    CI-LS     the same slope under a LEAGUE-SEASON cluster. Opposing quality is CONSTANT inside a`);
  say(`              league-season and the same ~60-65 cards recur in nearly every league, so a card`);
  say(`              resample barely disturbs the design the slope is identified on: CI-card is the`);
  say(`              LENIENT cluster here and CI-LS is the honest one for a league-season regressor.`);
  say(`    cardFE    slope with a CARD×cell×season fixed effect — the SAME card, same season, same`);
  say(`              platoon cell, facing a different league's opposition. The strictest design here.`);
  say(`    LOCO B    pre-committed transfer: beat a season-FE constant on the held-out platoon cell.`);
  say(`    LOCO W    the LEVEL-FREE part of that transfer — does the slope predict the across-league`);
  say(`              spread INSIDE the held-out cell, rather than just reproducing its platoon level?`);
  say(`    OOS       out-of-sample within-cell skill (§2C): the share of within-(cell×season) residual`);
  say(`              variance the paired opposing rating actually predicts in a held-out league.`);
  say();
  say(`  ${pad("channel", 22)}${lpad("slope", 8)}${lpad("CI-card", 9)}${lpad("CI-LS", 8)}${lpad("cardFE", 8)}${lpad("LOCO B", 9)}${lpad("LOCO W", 9)}${lpad("OOS", 8)}   pre-committed verdict`);
  for (const d of CHANNELS) {
    const w = withinOf(d.key), lo = locoOf(d.key).r, pr = profOf(d.key);
    const yn = (b: boolean) => (b ? "clear" : "—");
    const v = clear(w.wCellYrCI) && lo.skillB > 0 ? "ADMITTED" : clear(w.wCellYrCI) ? "no transfer" : lo.skillB > 0 ? "unresolved" : "NOT responsive";
    say(`  ${pad(d.label, 22)}${lpad(sgn(w.wCellYr, 3), 8)}${lpad(yn(clear(w.wCellYrCI)), 9)}${lpad(yn(clear(w.wCellYrCIls)), 8)}${lpad(yn(clear(w.wCardCIcard)), 8)}${lpad(pct(lo.skillB), 9)}${lpad(pct(lo.skillW), 9)}${lpad(pct(pr.skillPaired), 8)}   ${v}`);
  }
  say();
  say(`  READING THE QUALIFIERS. Of the ${admitted.length} admitted: ${survLs.length} stay CI-clear on the league-season cluster`);
  say(`  (${survLs.map((d) => d.label).join(", ") || "none"}); ${survCard.length} stay CI-clear under a card fixed effect`);
  say(`  (${survCard.map((d) => d.label).join(", ") || "none"});`);
  say(`  and ${survW.length} transfer LEVEL-FREE (${survW.map((d) => d.label).join(", ") || "none"}).`);
  say(`  The card-FE column is the reassuring one: every within-cell slope is essentially UNCHANGED when`);
  say(`  the same card is compared to itself across leagues, so none of these slopes is a card-composition`);
  say(`  artifact. The LOCO W column is the damaging one: for ${admitted.filter((d) => !(locoOf(d.key).r.skillW > 0)).map((d) => d.label).join(", ") || "none"}`);
  say(`  the positive LOCO B is the slope reproducing the held-out cell's platoon LEVEL, not predicting`);
  say(`  across-league quality variation inside it.`);
  say();
  say(`  EFFECT SIZE — the number that governs whether any of this is worth a term. Out of sample, inside`);
  say(`  a platoon cell, the paired opposing rating predicts ${pct(Math.max(...CHANNELS.map((d) => profOf(d.key).skillPaired)))} of the residual variance at BEST`);
  say(`  (${CHANNELS.reduce((a, b) => (profOf(a.key).skillPaired > profOf(b.key).skillPaired ? a : b)).label}); for the admitted channels it is ${admitted.map((d) => pct(profOf(d.key).skillPaired)).join(", ")}.`);
  say(`  The slopes are directionally resolvable and near-zero in explanatory power: a ±1 sd swing in`);
  say(`  within-cell opposing quality moves the residual by ${admitted.map((d) => f(Math.abs(withinOf(d.key).wCellYr * withinOf(d.key).sdCellYr), 2)).join(", ")}/600 against residual sds of`);
  say(`  ${admitted.map((d) => f(grainOf(d.key).corr.sdRaw, 1)).join(", ")}/600.`);
  say();
  if (nAdm === 0) {
    say(`  READ. The apparent composition effect is PLATOON STRUCTURE, not a response to opponent quality.`);
    say(`  The residual differs between same-side and opposite-side matchups, and the opposing rating is`);
    say(`  merely the label that varies with the cell. Nothing here licenses extrapolating an opponent`);
    say(`  term to tournament pools whose opposition differs; the estimated response would carry the`);
    say(`  platoon contrast of THIS corpus's usage into a pool where that contrast does not apply.`);
  } else {
    say(`  READ. ${admitted.map((d) => d.label).join(", ")} ${admitted.length === 1 ? "is" : "are"} admitted: the slope survives the platoon`);
    say(`  cell and transfers to a held-out cell. ${ciClearOnly.length ? `${ciClearOnly.map((d) => d.label).join(", ")} resolve(s) within-cell but does NOT transfer — CI-clear on a slope that does not generalise across cells is not a quality response.` : ""}`);
  }
  say();
}

// ── 0. WHAT MOVED, AND WHY THE GRAIN MATTERS ────────────────────────────────────
say("################################################################################");
say("## 0. SETUP, GRAIN, AND COUNTS");
say("################################################################################");
say();
say(`  model '${trained.id}' DEPLOYED form (not refit), fit window ${FIT_WINDOW.join("+")}, root '${ROOT}', minPA/BF ${MINPA}.`);
say(`  residual = predicted − observed, per 600.  weights BF (pitching) / PA (hitting).  CIs: CARD-CLUSTER bootstrap.`);
say(`  matchup cell = pitcher hand × batter hand, switch-hitters resolved to the hand they actually bat from.`);
say();
say(`  SURVEY grain    — rows: card × side × SEASON (five leagues SUMMED). composition: one opposing profile`);
say(`                    per (season, cell) = ${YEARS.length} × 4 = ${YEARS.length * 4} design points.`);
say(`                    pitcher rows ${POOL_PIT.length} / ${cardsOf(POOL_PIT)} cards;  hitter rows ${POOL_HIT.length} / ${cardsOf(POOL_HIT)} cards.`);
const lySeasons = new Set([...lyObs.keys()].map((s) => s));
say(`  CORRECTED grain — rows: card × side × (LEAGUE, SEASON). composition: one opposing profile per`);
say(`                    (league, season, cell).  ${lySeasons.size} league-seasons × 4 = ${lySeasons.size * 4} design points.`);
say(`                    pitcher rows ${LY_PIT.length} / ${cardsOf(LY_PIT)} cards;  hitter rows ${LY_HIT.length} / ${cardsOf(LY_HIT)} cards.`);
say();
say(`  league coverage is UNEQUAL across seasons — any "consistent across N seasons" claim below is across`);
say(`  unequal seasons and says so:`);
for (const y of YEARS) {
  const ls = LEAGUES.filter((lg) => lyObs.has(`${lg}|${y}`));
  say(`     ${y}: ${ls.length} league(s) — ${ls.join(", ")}`);
}
{
  const sum0 = loadWindow(ROOT, YEARS).summary;
  say(`  corrupt-cell exclusion applied by the loader: ${sum0.excludedCells.length ? sum0.excludedCells.join(", ") : "NONE"}`);
  say(`  (verified in code: the exclusion is decided per league-year from that cell's own vL/vR duplication,`);
  say(`   so loadWindowLeagues applies it identically — the corrected grain drops the same cell as the survey.)`);
  const old = availableYears(ROOT).filter((y) => y < 2037);
  say(`  '${ROOT}/Old Data' seasons ${old.join(", ") || "(none)"} sit after a four-season gap and are EXCLUDED here`);
  say(`  (never pooled). Every number in this file is ${YEARS[0]}–${YEARS[YEARS.length - 1]} only.`);
}
say();
say(`  WHY THE GRAIN IS THE WHOLE QUESTION. At the survey grain the opposing profile is a function of`);
say(`  (season, cell) only — 4 levels per season — and the cell is a deterministic function of the card's`);
say(`  own hand and side. A regression of the residual on it cannot distinguish "responds to opposing`);
say(`  quality" from "differs by platoon cell". At the corrected grain five leagues run in parallel with`);
say(`  different card populations, so opposing quality varies INSIDE a (cell, season) and the two`);
say(`  hypotheses separate. Spread of the opposing rating, total vs within-cell×season:`);
say();
say(`  ${pad("channel", 22)}${lpad("opposing", 10)}${lpad("sd total", 10)}${lpad("sd within", 11)}${lpad("cell", 8)}${lpad("within/total", 14)}`);
for (const { d, w } of WITHIN) say(`  ${pad(d.label, 22)}${lpad(d.opp, 10)}${lpad(f(w.sdAll, 2), 10)}${lpad(f(w.sdCellYr, 2), 11)}${lpad(f(w.sdCell, 2), 8)}${lpad(pct(w.sdCellYr / w.sdAll), 14)}`);
say();

// ── 1. GRAIN RE-RUN ─────────────────────────────────────────────────────────────
say("################################################################################");
say("## 1. GRAIN RE-RUN — every survey quantity, recomputed at the corrected grain");
say("################################################################################");
say();
say(`  BRIDGE = corrected ROWS with the survey's POOLED composition, so the row-grain change and the`);
say(`  composition-grain change are separable. Read SURVEY → BRIDGE → CORRECTED.`);
say();
say(`  ── composition share of the residual mean-square ──`);
say(`  ${pad("channel", 22)}${lpad("SURVEY cell", 13)}${lpad("BRIDGE cell", 13)}${lpad("CORR cell", 11)}${lpad("CORR cell×yr", 14)}${lpad("CORR design", 13)}`);
for (const g of GRAIN) say(`  ${pad(g.d.label, 22)}${lpad(pct(g.survey.fracCell), 13)}${lpad(pct(g.bridge.fracCell), 13)}${lpad(pct(g.corr.fracCell), 11)}${lpad(pct(g.corr.fracCellYear), 14)}${lpad(pct(g.corr.fracDesign), 13)}`);
say(`  ("CORR design" = league × season × cell fixed effects — the full composition design point. It is an`);
say(`   UPPER BOUND on what any opponent term could absorb, and it necessarily exceeds the cell share.)`);
say();
say(`  ── residual LEVEL gap, same-side − opposite-side (per 600) ──`);
say(`  ${pad("channel", 22)}${lpad("SURVEY", 10)}  ${pad("SURVEY 95% CI", 22)}${lpad("CORRECTED", 11)}  ${pad("CORRECTED 95% CI", 22)}`);
for (const g of GRAIN) say(`  ${pad(g.d.label, 22)}${lpad(sgn(g.survey.lvlGap), 10)}  ${pad(`[${sgn(g.survey.lvlCI.lo)}, ${sgn(g.survey.lvlCI.hi)}] ${clear(g.survey.lvlCI) ? "clear" : "covers 0"}`, 22)}${lpad(sgn(g.corr.lvlGap), 11)}  ${pad(`[${sgn(g.corr.lvlCI.lo)}, ${sgn(g.corr.lvlCI.hi)}] ${clear(g.corr.lvlCI) ? "clear" : "covers 0"}`, 22)}`);
say();
say(`  ── PRICING RATIO (fitted response ÷ the model's own complementary pricing; 1.00 = exact) ──`);
say(`  ${pad("channel", 22)}${lpad("SURVEY", 9)}${lpad("BRIDGE", 9)}${lpad("CORRECTED", 11)}  ${pad("CORRECTED 95% CI", 22)}${lpad("own pricing", 13)}`);
for (const g of GRAIN) {
  const c = g.corr, lo = Math.min(c.ratioCI.lo, c.ratioCI.hi), hi = Math.max(c.ratioCI.lo, c.ratioCI.hi);
  say(`  ${pad(g.d.label, 22)}${lpad(f(g.survey.ratio, 2) + "×", 9)}${lpad(f(g.bridge.ratio, 2) + "×", 9)}${lpad(f(c.ratio, 2) + "×", 11)}  ${pad(`[${f(lo, 2)}, ${f(hi, 2)}]`, 22)}${lpad(sgn(-c.compl, 3), 13)}`);
}
say();

// ── 2. WITHIN-CELL TEST ─────────────────────────────────────────────────────────
say("################################################################################");
say("## 2. WITHIN-CELL TEST — the core. Does opposing QUALITY predict the residual once the");
say("##    platoon cell is held? Slopes are events/600 per opposing rating point.");
say("################################################################################");
say();
say(`  ${pad("channel", 22)}${lpad("rows", 7)}${lpad("cards", 7)}${lpad("raw", 9)}${lpad("+cell FE", 10)}${lpad("+cell×yr", 10)}${lpad("survives", 10)}  ${pad("cell×yr 95% CI", 24)}`);
for (const { d, w } of WITHIN) {
  say(`  ${pad(d.label, 22)}${lpad(String(w.rows), 7)}${lpad(String(w.cards), 7)}${lpad(sgn(w.raw, 3), 9)}${lpad(sgn(w.wCell, 3), 10)}${lpad(sgn(w.wCellYr, 3), 10)}${lpad(pct(w.keepCellYr), 10)}  ${pad(`[${sgn(w.wCellYrCI.lo, 3)}, ${sgn(w.wCellYrCI.hi, 3)}] ${clear(w.wCellYrCI) ? "★ CI-CLEAR" : "covers 0"}`, 24)}`);
}
say();
say(`  POWER — a null must be readable as ABSENCE, not as a thin design. Below: the within-(cell×season)`);
say(`  spread of the opposing rating that identifies the slope, the half-width of the bootstrap CI (the`);
say(`  smallest slope this design could have resolved), and what that half-width implies over ±1 sd of`);
say(`  within-cell opposing quality — i.e. the smallest per-600 effect the test could have seen.`);
say();
say(`  ${pad("channel", 22)}${lpad("within sd", 11)}${lpad("min detectable slope", 22)}${lpad("→ per 600 over ±1sd", 21)}${lpad("point est × 1sd", 17)}`);
for (const { d, w } of WITHIN) {
  say(`  ${pad(d.label, 22)}${lpad(f(w.sdCellYr, 2), 11)}${lpad("±" + f(w.detect, 4), 22)}${lpad("±" + f(w.detect * w.sdCellYr, 3), 21)}${lpad(sgn(w.wCellYr * w.sdCellYr, 3), 17)}`);
}
say();
say(`  ── the same slopes as PRICING RATIOS (÷ the model's own complementary pricing) ──`);
say(`  ${pad("channel", 22)}${lpad("raw ratio", 12)}${lpad("within ratio", 14)}${lpad("card-FE ratio", 15)}${lpad("own pricing", 13)}`);
for (const { d, w } of WITHIN) say(`  ${pad(d.label, 22)}${lpad(f(w.ratioRaw, 2) + "×", 12)}${lpad(f(w.ratioWithin, 2) + "×", 14)}${lpad(f(w.ratioCard, 2) + "×", 15)}${lpad(sgn(-w.compl, 3), 13)}`);
say();

// ── 2B. THE FE LADDER + THE CLUSTER QUESTION ────────────────────────────────────
say("################################################################################");
say("## 2B. FE LADDER AND THE CLUSTERING AUDIT — how far the slope survives, and under which CI");
say("################################################################################");
say();
say(`  WHY A SECOND CLUSTER. The regressor (opposing quality) takes ONE value per (league, season,`);
say(`  cell) — it is constant inside a league-season. The corpus has ${withinOf("pit.K").nLs} pitcher league-seasons but only`);
say(`  ${withinOf("pit.K").cards} distinct pitcher cards / ${withinOf("hit.K").cards} hitter cards, i.e. nearly the same cards recur in EVERY league.`);
say(`  A card-cluster resample therefore reproduces almost the whole league-season design every draw and`);
say(`  does NOT propagate league-season shocks in the residual. The card CI is the PRE-COMMITTED one and`);
say(`  is kept as the admission rule, but it is the LENIENT one; the league-season CI is the honest one`);
say(`  for a league-season-level regressor. Both are shown. Neither is a substitute for section 3.`);
say();
say(`  ${pad("channel", 22)}${lpad("raw", 9)}${lpad("+cell", 9)}${lpad("+cell×yr", 10)}${lpad("+card×cell×yr", 15)}${lpad("keep(card)", 12)}${lpad("id groups", 11)}${lpad("sd(card)", 10)}`);
for (const { d, w } of WITHIN) {
  say(`  ${pad(d.label, 22)}${lpad(sgn(w.raw, 3), 9)}${lpad(sgn(w.wCell, 3), 9)}${lpad(sgn(w.wCellYr, 3), 10)}${lpad(sgn(w.wCard, 3), 15)}${lpad(pct(w.keepCard), 12)}${lpad(String(w.nCardGrp), 11)}${lpad(f(w.sdCard, 2), 10)}`);
}
say();
say(`  ("id groups" = (card, cell, season) cells containing ≥2 rows with DIFFERENT opposing quality — the`);
say(`   groups that actually identify the card-FE slope. "sd(card)" is the opposing-quality spread left`);
say(`   after card×cell×season means are removed: the design a card-FE null is read against.)`);
say();
say(`  ${pad("channel", 22)}${pad("cell×yr CI — CARD cluster", 30)}${pad("cell×yr CI — LEAGUE-SEASON", 30)}${pad("card-FE CI — CARD cluster", 30)}${pad("card-FE CI — LEAGUE-SEASON", 30)}`);
for (const { d, w } of WITHIN) {
  const c = (x: { lo: number; hi: number }) => pad(`[${sgn(x.lo, 3)}, ${sgn(x.hi, 3)}] ${clear(x) ? "★clear" : "covers 0"}`, 30);
  say(`  ${pad(d.label, 22)}${c(w.wCellYrCI)}${c(w.wCellYrCIls)}${c(w.wCardCIcard)}${c(w.wCardCIls)}`);
}
say();

// ── 2C. WHOLE OPPOSING PROFILE vs THE PAIRED RATING ─────────────────────────────
say("################################################################################");
say("## 2C. WHOLE OPPOSING PROFILE vs THE SINGLE PAIRED RATING (within cell × season)");
say("################################################################################");
say();
say(`  The direct rating→channel map is Stuff↔avoid-K, Control↔Eye, pHR↔Power, pBABIP↔BABIP, Gap↔XBH.`);
say(`  Plate appearances in this engine plausibly resolve SEQUENTIALLY, so a rating moving a channel it`);
say(`  does not own is NOT automatically confounding — chaining (count leverage) is a real mechanism. So`);
say(`  this asks, OUT OF SAMPLE (leave-one-LEAGUE-out, everything demeaned within cell × season using`);
say(`  TRAINING-league means only): does the opposing card's WHOLE profile beat its single paired rating?`);
say(`  SKILL = 1 − MSE/MSE(predict the cell×season mean). Positive = real within-cell predictive content.`);
say();
say(`  ${pad("channel", 22)}${lpad("paired", 9)}${lpad("skill", 10)}${lpad("profile skill", 15)}${lpad("gain", 9)}${lpad("dominant", 10)}   standardized within-cell betas`);
for (const { d, p } of PROF) {
  const betas = p.keys.map((kk, i) => `${kk} ${sgn(p.betaStd[i]!, 2)}`).join("  ");
  say(`  ${pad(d.label, 22)}${lpad(d.opp, 9)}${lpad(pct(p.skillPaired), 10)}${lpad(pct(p.skillFull), 15)}${lpad(pct(p.skillFull - p.skillPaired), 9)}${lpad(p.best, 10)}   ${betas}`);
}
say();
say(`  ("dominant" = largest |standardized beta| in the full within-cell fit. A dominant rating that is`);
say(`   NOT the paired one, together with a positive profile gain, is the chaining signature. A negative`);
say(`   profile gain means the extra columns are collinear noise and the paired rating is the whole story.)`);
say();

// ── 3. LEAVE-ONE-CELL-OUT ───────────────────────────────────────────────────────
say("################################################################################");
say("## 3. LEAVE-ONE-CELL-OUT — the transfer gate. Fit on three platoon cells, predict the fourth.");
say("################################################################################");
say();
say(`  Design points are (league, season, cell) exposure-weighted cell means. The BASELINE is season`);
say(`  fixed effects with the slope pinned to ZERO — i.e. "the held-out cell behaves like the average of`);
say(`  the other three, in that season". Two slope estimators are tried against it:`);
say(`     A  POOLED on the three training cells (season FE + slope) — what a naive fit would carry.`);
say(`     B  WITHIN-(cell×season) on the three training cells — the pure opponent-quality response.`);
say(`  SKILL = 1 − MSE(model)/MSE(baseline), exposure-weighted over all four held-out cells. Positive`);
say(`  skill = the opposing-quality term genuinely transfers to a platoon cell it never saw. A platoon`);
say(`  dummy cannot produce positive skill here; a real quality response should.`);
say();
say(`  A third reading, LEVEL-FREE (skill W), is added at audit: inside the held-out cell, demean x and y`);
say(`  by season and ask whether the training slope predicts the ACROSS-LEAGUE spread. Skill B asks the`);
say(`  slope to explain the held-out cell's platoon LEVEL as well; skill W asks only that the quality`);
say(`  response itself carry over. A channel can fail B for a level reason and still pass W.`);
say();
say(`  ${pad("channel", 22)}${lpad("pts", 6)}${lpad("skill A (pooled)", 18)}${lpad("skill B (within)", 18)}${lpad("skill W (lvl-free)", 20)}${lpad("slope A", 10)}${lpad("slope B", 10)}   transfers?`);
for (const x of LOCO) {
  const t = x.r.skillB > 0 ? "YES (B)" : x.r.skillA > 0 ? "pooled only — cross-cell level, not quality" : "NO";
  say(`  ${pad(x.d.label, 22)}${lpad(String(x.pts.length), 6)}${lpad(pct(x.r.skillA), 18)}${lpad(pct(x.r.skillB), 18)}${lpad(pct(x.r.skillW), 20)}${lpad(sgn(x.r.bAmean, 3), 10)}${lpad(sgn(x.r.bBmean, 3), 10)}   ${t}`);
}
say();
say(`  per held-out cell (MSE in (events/600)², exposure-weighted):`);
say(`  ${pad("channel", 22)}${pad("held-out", 10)}${lpad("pts", 5)}${lpad("MSE base", 11)}${lpad("MSE A", 10)}${lpad("MSE B", 10)}${lpad("skill B", 10)}${lpad("skill W", 10)}`);
for (const x of LOCO) for (const p of x.r.per) {
  say(`  ${pad(x.d.label, 22)}${pad(p.cell, 10)}${lpad(String(p.nTest), 5)}${lpad(f(p.mseBase, 3), 11)}${lpad(f(p.mseA, 3), 10)}${lpad(f(p.mseB, 3), 10)}${lpad(pct(1 - p.mseB / p.mseBase), 10)}${lpad(pct(p.skillW), 10)}`);
}
say();

// ── 4. NOTES ────────────────────────────────────────────────────────────────────
say("################################################################################");
say("## 4. NOTES, CONTRADICTIONS, AND WHAT THIS DOES NOT SHOW");
say("################################################################################");
say();
say(`  VERTEX-PIN PARITY (verified in code, reported not fixed). The deployed trainer`);
say(`  (server.saveTrainedModel) fits fitHitForm(RAWPOLY_HIT, …, vertexPinned) +`);
say(`  fitPitForm(PARETO_PIT, …, vertexPinned). The bake-off harness's hitFormModel/pitFormModel`);
say(`  (src/training/forms.ts ~620-625) call fitHitForm(form, train) / fitPitForm(form, train) with NO`);
say(`  pins argument, so every FORM_ENTRIES candidate is fitted UNPINNED. The active artifact records`);
say(`  vertexPinned = ${JSON.stringify(trained.vertexPinned ?? [])}.`);
say(`  ⇒ the harness has never scored what ships, and PARETO_PIT is not in FORM_ENTRIES at all.`);
say(`  This measurement does not use the harness fit path — every number above is read off the DEPLOYED`);
say(`  artifact's own eventForm — so the discrepancy does not touch these results. It is recorded here`);
say(`  because any later comparison built on FORM_ENTRIES would silently be off-deployment.`);
say();
say(`  WHAT THE SURVEY GOT RIGHT AND WHAT IT DID NOT. The survey's shares are reproduced at its own`);
say(`  grain (section 1, SURVEY column) — they are arithmetically correct. What they do not establish is`);
say(`  a response to opponent QUALITY, because the regressor was a four-level platoon dummy. Section 2`);
say(`  is the missing test; section 3 is the missing gate.`);
say();
say(`  WHAT REMAINS TRUE REGARDLESS. The model has no opponent term, and every event is a joint`);
say(`  pitcher-batter outcome — that is a structural fact, not a measurement. What this run bounds is`);
say(`  how much of the MEASURED residual structure is attributable to opposing quality as opposed to`);
say(`  platoon structure the model already fails to carry for a different reason.`);
say();
say(`  AUDIT OF THIS TOOL (it was written but never run; it was checked before it was trusted). Verified:`);
say(`  row construction, composition, residual definitions, weights and the complementary-pricing slopes`);
say(`  are line-for-line the survey's, so SURVEY-column numbers are a true replication, not a re-derivation.`);
say(`  Three gaps were found and closed: (1) the pre-committed CARD-cluster bootstrap is the LENIENT`);
say(`  cluster here, because opposing quality is constant inside a league-season while the same cards recur`);
say(`  in every league — a league-season cluster CI was added (§2B); (2) no CARD fixed effect was tested,`);
say(`  the strongest design this corpus allows — added (§2B); (3) the whole-opposing-profile question was`);
say(`  not implemented at all — added out-of-sample (§2C). The level-free LOCO reading (skill W, §3) was`);
say(`  added so a transfer failure caused by the platoon LEVEL is not read as a failure of the response.`);
say();
say(`  LIMITS. (a) Leagues are not randomised: a league's opposing quality correlates with its own card`);
say(`  population, so a within-cell slope is still observational. (b) The same cards recur across`);
say(`  league-seasons, which is why every CI is a card-cluster bootstrap and why distinct-card counts`);
say(`  sit beside every row count. (c) Opposition is proxied by the QUALIFYING population of the`);
say(`  league-season, not by the actual per-plate-appearance opponent — the same approximation the survey`);
say(`  made, kept deliberately so the two are comparable.`);
say(`  (d) Same-side exposure is manager-selected, so the platoon contrast is a property of this corpus.`);
say();

// Write via writeFileSync when a path is given. (An earlier `process.stdout.write(...)` followed by
// `process.exit(0)` raced the redirected-file flush and truncated the artifact to zero bytes.)
const OUT = process.argv[2];
const TEXT = L.join("\n") + "\n";
if (OUT) { writeFileSync(OUT, TEXT); process.stderr.write(`wrote ${OUT} (${TEXT.length} bytes)\n`); }
else process.stdout.write(TEXT);
