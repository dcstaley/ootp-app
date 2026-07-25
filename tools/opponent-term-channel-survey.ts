// OPPONENT-TERM CHANNEL SURVEY (2026-07-25). MEASUREMENT ONLY — nothing fit into production,
// no defaults touched, nothing wired, nothing committed.
//   run: node tools/opponent-term-channel-survey.ts > fixtures/opponent-term-channel-survey-2026-07-25.txt
//
// EXTENDS fixtures/REFUTATION-kcurve-hand-2026-07-25.txt, which established that the deployed
// model carries NO opponent term and that for the PITCHER K channel the missing term is 54% of
// the whole residual. Every event here is a joint pitcher-batter outcome, so the same hole is
// structurally present in every channel and in BOTH directions. This generalises the exact
// method that worked: matchup-cell resolution (switch-hitters resolved to the hand they bat
// from), card-cluster bootstraps, distinct-card + ESS reporting beside every estimate.
//
// GRAIN + WEIGHTS are inherited from the K work: card × side × SEASON rows (per-year loads,
// stacked), raw BF (pitching) / PA (hitting) weights, card-cluster bootstrap. The stuffAug
// refit section switches to the TRAINER's own weight (BF^0.75) so its coefficients are
// comparable to the deployed artifact.

import { existsSync } from "node:fs";
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { makeRawPolyModel, type EventForm } from "../src/scoring-core/index.ts";
import { loadWindow, loadWindowLeagues, availableYears, type TrainObs } from "../src/training/loader.ts";
import { PITCHER, HITTER } from "../src/training/bakeoff.ts";
import { rate, rateAux, hRate, ln1, PIT_BIP_ADJ } from "../src/model/curves.ts";

const L: string[] = [];
const HEAD: string[] = [];
const say = (s = "") => L.push(s);
const sayH = (s = "") => HEAD.push(s);
const f = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "n/a");
const sgn = (x: number, d = 2) => (Number.isFinite(x) ? `${x >= 0 ? "+" : ""}${x.toFixed(d)}` : "n/a");
const pad = (s: string, n: number) => s.padEnd(n);
const lpad = (s: string, n: number) => s.padStart(n);
const k = (x: number) => (Number.isFinite(x) ? Math.round(x).toLocaleString("en-US") : "n/a");
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const pct = (x: number) => `${x >= 0 ? "" : "-"}${f(Math.abs(100 * x), 1)}%`;

const repo = new Repository("data");
await seedDefaults(repo); await seedEras(repo); await seedAccounts(repo);
const state = (await repo.load<{ activeModelId?: string }>("state", "app")) ?? {};
type TM_ = { id: string; eventForm?: EventForm; window?: number[]; minPA?: number; includeVariants?: boolean };
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

// ── ROW MODEL ───────────────────────────────────────────────────────────────────
type H = "R" | "L";
interface CRow {
  cid: string; name: string; year: number; role: "pit" | "hit";
  T: H; B: H;                 // pitcher hand, batter hand ACTUALLY USED (switch resolved)
  w: number;                  // BF (pitching) or PA (hitting)
  own: Record<string, number>;   // own ratings
  resid: Record<string, number>; // per-channel residual (pred − obs) per 600
}
/** the hand a batter actually bats from against a pitcher of hand T (1=R 2=L 3=switch) */
const batsFrom = (bats: number, T: H): H | null => bats === 1 ? "R" : bats === 2 ? "L" : bats === 3 ? (T === "L" ? "R" : "L") : null;

function pitRows(obs: TrainObs[], year: number): CRow[] {
  const out: CRow[] = [];
  for (const o of obs.filter((x) => PITCHER.qualifies(x, MINPA))) {
    if (o.throws !== 1 && o.throws !== 2) continue;
    const bf = Math.max(o.pitch.BF, 1), r = o.ratings.pitch;
    const p = rp.predictPitching(r, {} as any);
    const ob = (v: number) => (v / bf) * 600;
    const resid = {
      K: p.K - ob(o.pitch.K),
      BB: p.BB - ob(Math.max(o.pitch.BB - o.pitch.IBB, 0)),
      HR: p.HR - ob(o.pitch.HR),
      H: p.nHH - ob(o.pitch.b1 + o.pitch.b2 + o.pitch.b3),
    };
    if (Object.values(resid).some((x) => !Number.isFinite(x))) continue;
    out.push({ cid: o.cid, name: o.name, year, role: "pit", T: o.throws === 1 ? "R" : "L", B: o.side as H, w: bf, own: { stu: r.stu, con: r.con, hrr: r.hrr, pbabip: r.pbabip }, resid });
  }
  return out;
}
function hitRows(obs: TrainObs[], year: number): CRow[] {
  const out: CRow[] = [];
  for (const o of obs.filter((x) => HITTER.qualifies(x, MINPA))) {
    const T = o.side as H, B = batsFrom(o.bats, T);
    if (!B) continue;
    const pa = Math.max(o.hit.PA, 1), r = o.ratings.hit;
    const p = rp.predictHitting(r, {} as any);
    const ob = (v: number) => (v / pa) * 600;
    const resid = {
      K: p.SO - ob(o.hit.K),
      BB: p.BB - ob(Math.max(o.hit.BB - o.hit.IBB, 0)),
      HR: p.HR - ob(o.hit.HR),
      H: (p.oneB + p.GAP) - ob(o.hit.H - o.hit.HR),
      XBH: p.GAP - ob(o.hit.b2 + o.hit.b3),
    };
    if (Object.values(resid).some((x) => !Number.isFinite(x))) continue;
    out.push({ cid: o.cid, name: o.name, year, role: "hit", T, B, w: pa, own: { kRat: r.kRat, eye: r.eye, pow: r.pow, babip: r.babip, gap: r.gap }, resid });
  }
  return out;
}

const obsCache = new Map<string, TrainObs[]>();
function obsOf(year: number, league?: string): TrainObs[] {
  const key = `${year}|${league ?? "*"}`;
  if (!obsCache.has(key)) obsCache.set(key, (league ? loadWindowLeagues(ROOT, [year], [league]) : loadWindow(ROOT, [year])).observations.filter(keepVar));
  return obsCache.get(key)!;
}

// ── OPPOSING COMPOSITION, per (year, cell) — the same construction the K work used ──
// For a PITCHER row in cell (T,B): the opposition is batters of hand B facing pitchers of
// hand T, i.e. hitter observations with side=T whose resolved bat-hand is B.
// For a HITTER row in cell (T,B): the opposition is pitchers of hand T facing batters of
// hand B, i.e. pitcher observations with side=B and throws=T.
interface Comp { oppHit: Record<string, number>; oppPit: Record<string, number>; hitPA: number; pitBF: number; nHit: number; nPit: number }
function composition(obs: TrainObs[]): Map<string, Comp> {
  const m = new Map<string, Comp>();
  const cell = (T: H, B: H) => { const kk = `${T}|${B}`; if (!m.has(kk)) m.set(kk, { oppHit: { kRat: 0, eye: 0, pow: 0, babip: 0, gap: 0 }, oppPit: { stu: 0, con: 0, hrr: 0, pbabip: 0 }, hitPA: 0, pitBF: 0, nHit: 0, nPit: 0 }); return m.get(kk)!; };
  for (const o of obs.filter((x) => HITTER.qualifies(x, MINPA))) {
    const T = o.side as H, B = batsFrom(o.bats, T); if (!B) continue;
    const c = cell(T, B), pa = o.hit.PA, r = o.ratings.hit;
    for (const kk of ["kRat", "eye", "pow", "babip", "gap"] as const) c.oppHit[kk] = (c.oppHit[kk] ?? 0) + pa * (r as any)[kk];
    c.hitPA += pa; c.nHit++;
  }
  for (const o of obs.filter((x) => PITCHER.qualifies(x, MINPA))) {
    if (o.throws !== 1 && o.throws !== 2) continue;
    const T: H = o.throws === 1 ? "R" : "L", B = o.side as H;
    const c = cell(T, B), bf = o.pitch.BF, r = o.ratings.pitch;
    for (const kk of ["stu", "con", "hrr", "pbabip"] as const) c.oppPit[kk] = (c.oppPit[kk] ?? 0) + bf * (r as any)[kk];
    c.pitBF += bf; c.nPit++;
  }
  for (const [, c] of m) {
    for (const kk of Object.keys(c.oppHit)) c.oppHit[kk]! /= c.hitPA || 1;
    for (const kk of Object.keys(c.oppPit)) c.oppPit[kk]! /= c.pitBF || 1;
  }
  return m;
}
const compYear = new Map<number, Map<string, Comp>>();
for (const y of YEARS) compYear.set(y, composition(obsOf(y)));

const PIT = YEARS.flatMap((y) => pitRows(obsOf(y), y));
const HIT = YEARS.flatMap((y) => hitRows(obsOf(y), y));

// ── shared machinery (identical to the refutation harness) ───────────────────────
const wmean = (rs: CRow[], g: (r: CRow) => number) => { const sw = sum(rs.map((r) => r.w)); return sw > 0 ? sum(rs.map((r) => r.w * g(r))) / sw : NaN; };
const wms = (rs: CRow[], g: (r: CRow) => number) => { const sw = sum(rs.map((r) => r.w)); return sw > 0 ? sum(rs.map((r) => r.w * g(r) ** 2)) / sw : NaN; };
const mkRnd = (seed: number) => { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
const q = (xs: number[], p: number) => { const v = [...xs].sort((x, y) => x - y); return v[Math.min(v.length - 1, Math.max(0, Math.floor(p * v.length)))]!; };
const ci = (xs: number[]) => ({ lo: q(xs, 0.025), hi: q(xs, 0.975) });
const clear = (c: { lo: number; hi: number }) => (c.lo > 0 && c.hi > 0) || (c.lo < 0 && c.hi < 0);
const kish = (ws: number[]) => { const s = sum(ws), s2 = sum(ws.map((w) => w * w)); return s2 > 0 ? (s * s) / s2 : 0; };
const cardsOf = (rs: CRow[]) => new Set(rs.map((r) => r.cid)).size;
function clusters(rs: CRow[]) { const m = new Map<string, CRow[]>(); for (const r of rs) (m.get(r.cid) ?? m.set(r.cid, []).get(r.cid)!).push(r); return [...m.values()]; }
function bootPaired(rs: CRow[], sel: (r: CRow) => "A" | "B", seed: number, B: number, stat: (s: CRow[]) => number) {
  const rnd = mkRnd(seed), cl = clusters(rs), d: number[] = [];
  for (let b = 0; b < B; b++) {
    const s: CRow[] = [];
    for (let i = 0; i < cl.length; i++) for (const r of cl[Math.floor(rnd() * cl.length)]!) s.push(r);
    const A = s.filter((r) => sel(r) === "A"), Bb = s.filter((r) => sel(r) === "B");
    if (A.length < 10 || Bb.length < 10) continue;
    const v = stat(A) - stat(Bb); if (Number.isFinite(v)) d.push(v);
  }
  const lo = d.filter((x) => x < 0).length / d.length;
  return { ci: ci(d), p: 2 * Math.min(lo, 1 - lo), n: d.length };
}
function bootStat(rs: CRow[], seed: number, B: number, stat: (s: CRow[]) => number) {
  const rnd = mkRnd(seed), cl = clusters(rs), d: number[] = [];
  for (let b = 0; b < B; b++) { const s: CRow[] = []; for (let i = 0; i < cl.length; i++) for (const r of cl[Math.floor(rnd() * cl.length)]!) s.push(r); const v = stat(s); if (Number.isFinite(v)) d.push(v); }
  const lo = d.filter((x) => x < 0).length / d.length;
  return { ci: ci(d), p: 2 * Math.min(lo, 1 - lo) };
}
/** weighted polynomial in a standardized covariate (the refutation harness's wpolyGen) */
function wpoly(rs: CRow[], deg: number, zf: (r: CRow) => number, yf: (r: CRow) => number, wf: (r: CRow) => number = (r) => r.w): number[] {
  const n = deg + 1, A = Array.from({ length: n }, () => new Array(n).fill(0)), b = new Array(n).fill(0);
  for (const r of rs) { const zz = zf(r), w = wf(r); const p: number[] = []; let acc = 1; for (let i = 0; i < n; i++) { p.push(acc); acc *= zz; } for (let i = 0; i < n; i++) { b[i] += w * p[i]! * yf(r); for (let j = 0; j < n; j++) A[i]![j] += w * p[i]! * p[j]!; } }
  for (let i = 0; i < n; i++) { let piv = i; for (let q2 = i + 1; q2 < n; q2++) if (Math.abs(A[q2]![i]!) > Math.abs(A[piv]![i]!)) piv = q2; [A[i], A[piv]] = [A[piv]!, A[i]!]; [b[i], b[piv]] = [b[piv], b[i]]; const d = A[i]![i]! || 1e-12; for (let q2 = i + 1; q2 < n; q2++) { const fct = A[q2]![i]! / d; for (let j = i; j < n; j++) A[q2]![j]! -= fct * A[i]![j]!; b[q2] -= fct * b[i]; } }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) { let s = b[i]; for (let j = i + 1; j < n; j++) s -= A[i]![j]! * x[j]; x[i] = s / (A[i]![i]! || 1e-12); }
  return x;
}
/** general weighted least squares on an explicit design */
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
const deMean = (rs: CRow[], ch: string, keyf: (r: CRow) => string): CRow[] => {
  const g = new Map<string, CRow[]>(); for (const r of rs) (g.get(keyf(r)) ?? g.set(keyf(r), []).get(keyf(r))!).push(r);
  const out: CRow[] = [];
  for (const [, s] of g) { const m = wmean(s, (r) => r.resid[ch]!); for (const r of s) out.push({ ...r, resid: { ...r.resid, [ch]: r.resid[ch]! - m } }); }
  return out;
};
const cellKey = (r: CRow) => `${r.T}|${r.B}`;
const isSame = (r: CRow) => r.T === r.B;

// ── complementary-role pricing: what the model's OWN curve for the other role says a
//    point of the opposing rating is worth (local slope at the observed mean) ──────
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

// ── the channel table ────────────────────────────────────────────────────────────
interface ChanDef { key: string; role: "pit" | "hit"; ch: string; label: string; own: string; opp: string; oppSide: "oppHit" | "oppPit" }
const CHANNELS: ChanDef[] = [
  { key: "pit.K", role: "pit", ch: "K", label: "PITCHER K", own: "stu", opp: "kRat", oppSide: "oppHit" },
  { key: "pit.BB", role: "pit", ch: "BB", label: "PITCHER BB", own: "con", opp: "eye", oppSide: "oppHit" },
  { key: "pit.HR", role: "pit", ch: "HR", label: "PITCHER HR", own: "hrr", opp: "pow", oppSide: "oppHit" },
  { key: "pit.H", role: "pit", ch: "H", label: "PITCHER hits(nonHR)", own: "pbabip", opp: "babip", oppSide: "oppHit" },
  { key: "hit.K", role: "hit", ch: "K", label: "HITTER K", own: "kRat", opp: "stu", oppSide: "oppPit" },
  { key: "hit.BB", role: "hit", ch: "BB", label: "HITTER BB", own: "eye", opp: "con", oppSide: "oppPit" },
  { key: "hit.HR", role: "hit", ch: "HR", label: "HITTER HR", own: "pow", opp: "hrr", oppSide: "oppPit" },
  { key: "hit.H", role: "hit", ch: "H", label: "HITTER hits(nonHR)", own: "babip", opp: "pbabip", oppSide: "oppPit" },
  { key: "hit.XBH", role: "hit", ch: "XBH", label: "HITTER XBH", own: "gap", opp: "—", oppSide: "oppPit" },
];
const rowsFor = (d: ChanDef) => (d.role === "pit" ? PIT : HIT);
const oppVal = (d: ChanDef, r: CRow) => { const c = compYear.get(r.year)!.get(cellKey(r)); return c ? (c as any)[d.oppSide][d.opp] as number : NaN; };

// ── per-(league,season) sign consistency ────────────────────────────────────────
interface LCell { lg: string; y: number; pit: CRow[]; hit: CRow[] }
const lgCells: LCell[] = [];
for (const y of YEARS) for (const lg of LEAGUES) {
  const o = obsOf(y, lg); if (!o.length) continue;
  const p = pitRows(o, y), h = hitRows(o, y);
  if (p.length + h.length >= 20) lgCells.push({ lg, y, pit: p, hit: h });
}

interface Result {
  d: ChanDef; rows: number; cards: number; wtot: number; ess: number;
  compGap: number; oppSame: number; oppOpp: number;
  lvlSame: number; lvlOpp: number; lvlGap: number; lvlCI: { lo: number; hi: number }; lvlP: number;
  slope: number; slopeCI: { lo: number; hi: number }; compl: number; ratio: number; ratioCI: { lo: number; hi: number };
  msRaw: number; msCell: number; msCellYear: number; fracCell: number; fracCellYear: number;
  sdRaw: number;
  cubRaw: number; cubCorr: number; cubRawCI: { lo: number; hi: number }; cubCorrCI: { lo: number; hi: number };
  signNeg: number; signTot: number;
}
function analyze(d: ChanDef): Result {
  const rs0 = rowsFor(d), ch = d.ch;
  const rs = d.opp === "—" ? rs0 : rs0.filter((r) => Number.isFinite(oppVal(d, r)));
  const same = rs.filter(isSame), opp = rs.filter((r) => !isSame(r));
  const R = (r: CRow) => r.resid[ch]!;
  const oppSame = d.opp === "—" ? NaN : wmean(same, (r) => oppVal(d, r));
  const oppOpp = d.opp === "—" ? NaN : wmean(opp, (r) => oppVal(d, r));
  const lvlSame = wmean(same, R), lvlOpp = wmean(opp, R);
  const bp = bootPaired(rs, (r) => (isSame(r) ? "A" : "B"), 0x51ee11, 4000, (s) => wmean(s, R));
  // slope of residual on the opposing paired rating (BF/PA weighted, one linear term)
  const slopeOf = (s: CRow[]) => { const mx = wmean(s, (r) => oppVal(d, r)), my = wmean(s, R); const sxy = sum(s.map((r) => r.w * (oppVal(d, r) - mx) * (R(r) - my))), sxx = sum(s.map((r) => r.w * (oppVal(d, r) - mx) ** 2)); return sxy / (sxx || 1e-12); };
  const slope = d.opp === "—" ? NaN : slopeOf(rs);
  const sb = d.opp === "—" ? { ci: { lo: NaN, hi: NaN }, p: NaN } : bootStat(rs, 0x7711, 3000, slopeOf);
  const x0 = d.opp === "—" ? NaN : wmean(rs, (r) => oppVal(d, r));
  const compl = complSlope[d.key] ? complSlope[d.key]!(x0) : NaN;
  const ratio = slope / (-compl);
  // variance decomposition
  const msRaw = wms(rs, R);
  const cellFE = deMean(rs, ch, cellKey), cellYFE = deMean(rs, ch, (r) => `${cellKey(r)}|${r.year}`);
  const msCell = wms(cellFE, R), msCellYear = wms(cellYFE, R);
  // own-rating shape, before/after correction (the K template: cubic partial on z(own))
  const mu = wmean(rs, (r) => r.own[d.own]!), sd = Math.sqrt(wmean(rs, (r) => (r.own[d.own]! - mu) ** 2)) || 1;
  const zf = (r: CRow) => (r.own[d.own]! - mu) / sd;
  const cubOf = (s: CRow[]) => wpoly(s, 3, zf, R)[3]!;
  const cubRaw = cubOf(rs), cubCorr = cubOf(cellFE);
  const cRaw = bootStat(rs, 0x2211, 2500, cubOf), cCorr = bootStat(cellFE, 0x2211, 2500, cubOf);
  // per-(league,season) sign consistency of the same−opposite level gap
  let neg = 0, tot = 0;
  for (const c of lgCells) {
    const s2 = (d.role === "pit" ? c.pit : c.hit).filter((r) => d.opp === "—" || Number.isFinite(oppVal(d, r)));
    const a = s2.filter(isSame), b = s2.filter((r) => !isSame(r));
    if (a.length < 5 || b.length < 5) continue;
    const g = wmean(a, R) - wmean(b, R); if (!Number.isFinite(g)) continue;
    tot++; if (g < 0) neg++;
  }
  return {
    d, rows: rs.length, cards: cardsOf(rs), wtot: sum(rs.map((r) => r.w)), ess: kish(rs.map((r) => r.w)),
    compGap: oppSame - oppOpp, oppSame, oppOpp,
    lvlSame, lvlOpp, lvlGap: lvlSame - lvlOpp, lvlCI: bp.ci, lvlP: bp.p,
    slope, slopeCI: sb.ci, compl, ratio, ratioCI: { lo: sb.ci.lo / -compl, hi: sb.ci.hi / -compl },
    msRaw, msCell, msCellYear, fracCell: 1 - msCell / msRaw, fracCellYear: 1 - msCellYear / msRaw,
    sdRaw: Math.sqrt(msRaw),
    cubRaw, cubCorr, cubRawCI: cRaw.ci, cubCorrCI: cCorr.ci,
    signNeg: neg, signTot: tot,
  };
}
const RES = CHANNELS.map(analyze);
const byKey = (kk: string) => RES.find((r) => r.d.key === kk)!;

// ════════════════════════════════════════════════════════════════════════════════
// THE RANKED TABLE
// ════════════════════════════════════════════════════════════════════════════════
const ranked = [...RES].sort((a, b) => b.fracCell - a.fracCell);
sayH("################################################################################");
sayH("# OPPONENT-TERM CHANNEL SURVEY — every channel, both roles.  MEASUREMENT ONLY.");
sayH("# Does the missing opponent term matter outside pitcher-K, and where?");
sayH("################################################################################");
sayH();
sayH(`  model '${trained.id}' DEPLOYED form (not refit), fit window ${FIT_WINDOW.join("+")}, root '${ROOT}'`);
sayH(`  grain: card × side × SEASON, ${YEARS[0]}–${YEARS[YEARS.length - 1]}.  weights BF (pitching) / PA (hitting).  CIs: CARD-CLUSTER bootstrap.`);
sayH(`  matchup cell = (pitcher hand × batter hand), switch-hitters resolved to the hand they`);
sayH(`  actually bat from (a switch-hitter bats RIGHT vs a LHP).  same-side = pitcher's platoon advantage.`);
sayH(`  pitcher rows ${PIT.length} / ${cardsOf(PIT)} cards;  hitter rows ${HIT.length} / ${cardsOf(HIT)} cards.`);
sayH();
sayH("################################################################################");
sayH("### RANKED — share of each channel's TOTAL residual mean-square explained by");
sayH("### opposing-matchup composition alone (4 cells, no other information)");
sayH("################################################################################");
sayH();
sayH(`  ${pad("channel", 22)}${lpad("own↔opp", 16)}${lpad("rows", 7)}${lpad("cards", 7)}${lpad("ESS", 8)}${lpad("resid sd", 10)}${lpad("cell", 8)}${lpad("cell×yr", 9)}   verdict`);
for (const r of ranked) {
  const v = !Number.isFinite(r.fracCell) ? "n/a"
    : r.fracCell >= 0.25 ? "NEEDS AN OPPONENT TERM"
    : r.fracCell >= 0.08 ? "material"
    : r.fracCell >= 0.03 ? "small"
    : "rounding error";
  sayH(`  ${pad(r.d.label, 22)}${lpad(`${r.d.own}↔${r.d.opp}`, 16)}${lpad(String(r.rows), 7)}${lpad(String(r.cards), 7)}${lpad(f(r.ess, 1), 8)}${lpad(f(r.sdRaw, 2), 10)}${lpad(pct(r.fracCell), 8)}${lpad(pct(r.fracCellYear), 9)}   ${v}`);
}
sayH();
sayH(`  "resid sd" = √(BF/PA-weighted mean square of the channel residual), in events per 600 — the`);
sayH(`  size of the thing being decomposed. A large SHARE of a tiny residual is not a large defect;`);
sayH(`  read the two columns together. Absolute mean-square REMOVED by the composition, per 600²:`);
sayH(`  ${pad("channel", 22)}${lpad("MS raw", 11)}${lpad("MS − cell", 11)}${lpad("removed", 11)}${lpad("√removed", 11)}`);
for (const r of ranked) sayH(`  ${pad(r.d.label, 22)}${lpad(f(r.msRaw, 2), 11)}${lpad(f(r.msCell, 2), 11)}${lpad(f(r.msRaw - r.msCell, 2), 11)}${lpad(f(Math.sqrt(Math.max(r.msRaw - r.msCell, 0)), 2), 11)}`);
sayH();

// ════════════════════════════════════════════════════════════════════════════════
// stuffAug
// ════════════════════════════════════════════════════════════════════════════════
// Refit the pitcher BB and HR events with the TRAINER's own design and weight (BF^0.75),
// with and without composition controls, and read the aux coefficient off each fit.
// This is a measurement refit inside this tool — nothing is written anywhere.
interface AuxFit { beta: number; ci: { lo: number; hi: number } }
function auxRefit(rows: CRow[], ch: "BB" | "HR", ownKey: "con" | "hrr", ctrl: "none" | "cell" | "opp" | "both", oppKey: "eye" | "pow", seed: number, B = 1500): AuxFit {
  const aux = ch === "BB" ? FORM.pit.bb.aux! : FORM.pit.hr.aux!;
  const curve = ch === "BB" ? FORM.pit.bb.curve : FORM.pit.hr.curve;
  const ownMu = ch === "BB" ? FORM.pit.bb.mu : FORM.pit.hr.mu, ownSd = ch === "BB" ? FORM.pit.bb.sd : FORM.pit.hr.sd;
  const compD = (r: CRow) => { const c = compYear.get(r.year)!.get(cellKey(r)); return c ? c.oppHit[oppKey]! : NaN; };
  const usable = rows.filter((r) => Number.isFinite(compD(r)));
  const cellsIdx = ["R|R", "R|L", "L|R"]; // 3 dummies, L|L is the reference
  const design = (r: CRow): number[] => {
    const v = r.own[ownKey]!;
    const own: number[] = curve.kind === "log" ? [1, ln1(v)] : [1, (v - ownMu) / ownSd, ((v - ownMu) / ownSd) ** 2];
    const a = (ln1(r.own.stu ?? 0) - aux.mu) / aux.sd;
    const ctrls: number[] = [];
    if (ctrl === "cell" || ctrl === "both") for (const c of cellsIdx) ctrls.push(cellKey(r) === c ? 1 : 0);
    if (ctrl === "opp" || ctrl === "both") ctrls.push(compD(r));
    return [...own, a, ...ctrls];
  };
  const auxIdx = (curve.kind === "log" ? 2 : 3);
  const target = (r: CRow) => {
    // observed rate = predicted − residual (the residual is pred − obs), so obs = pred − resid
    const pr = rp.predictPitching({ stu: r.own.stu!, con: r.own.con!, pbabip: r.own.pbabip!, hrr: r.own.hrr! } as any, {} as any);
    return (ch === "BB" ? pr.BB : pr.HR) - r.resid[ch]!;
  };
  const fitOn = (s: CRow[]) => { const X = s.map(design), y = s.map(target), w = s.map((r) => Math.pow(r.w, 0.75)); return wls(X, y, w)[auxIdx]!; };
  const beta = fitOn(usable);
  const rnd = mkRnd(seed), cl = clusters(usable), draws: number[] = [];
  for (let b = 0; b < B; b++) { const s: CRow[] = []; for (let i = 0; i < cl.length; i++) for (const r of cl[Math.floor(rnd() * cl.length)]!) s.push(r); const v = fitOn(s); if (Number.isFinite(v)) draws.push(v); }
  return { beta, ci: ci(draws) };
}
const PIT_FIT = PIT.filter((r) => FIT_WINDOW.includes(r.year));
const auxRuns = (["BB", "HR"] as const).map((ch) => {
  const ownKey = ch === "BB" ? "con" : "hrr", oppKey = ch === "BB" ? "eye" : "pow";
  const deployed = ch === "BB" ? FORM.pit.bb.aux!.beta : FORM.pit.hr.aux!.beta;
  const mk = (rows: CRow[], tag: string) => (["none", "cell", "opp", "both"] as const).map((c, i) => ({ tag, ctrl: c, ...auxRefit(rows, ch, ownKey as any, c, oppKey as any, 0x9911 + i) }));
  return { ch, deployed, fitWin: mk(PIT_FIT, "fit window 2042+2043"), full: mk(PIT, "full 2037–2043") };
});

sayH("################################################################################");
sayH("### stuffAug VERDICT");
sayH("################################################################################");
sayH();
sayH(`  Method: refit the pitcher BB / HR event with the TRAINER's own design and weight (BF^0.75),`);
sayH(`  with and without composition controls, and read the aux coefficient off each fit. The`);
sayH(`  uncontrolled refit is the reproduction check against the deployed coefficient. PRIMARY`);
sayH(`  READ = the FIT WINDOW ${FIT_WINDOW.join("+")}, because that is where the shipped number came from.`);
sayH();
for (const a of auxRuns) {
  const bF = a.fitWin.find((x) => x.ctrl === "none")!, bothF = a.fitWin.find((x) => x.ctrl === "both")!;
  const bA = a.full.find((x) => x.ctrl === "none")!, bothA = a.full.find((x) => x.ctrl === "both")!;
  const keepF = Math.abs(bothF.beta / bF.beta), keepA = Math.abs(bothA.beta / bA.beta);
  const v = !clear(bF.ci) ? "UNRESOLVED EVEN UNCONTROLLED — no aux to defend"
    : keepF >= 0.85 ? "SURVIVES — composition is a separate effect"
    : keepF >= 0.6 ? "PARTIAL — a minority is composition"
    : !clear(bothF.ci) ? "COLLAPSES on the fit window; PARTIAL on the wide window"
    : "PARTIAL — the majority is composition";
  sayH(`  ── pit.${a.ch} Stuff aux:  ${v}`);
  sayH(`     deployed beta ${sgn(a.deployed, 4)};  uncontrolled refit ${sgn(bF.beta, 4)} on the fit window (reproduces to ${f(100 * Math.abs(bF.beta / a.deployed - 1), 1)}%).`);
  sayH(`     ${pad("", 22)}${lpad("uncontrolled", 14)}${lpad("+ controls", 13)}  ${pad("controlled 95% CI", 22)}${lpad("composition share", 19)}`);
  sayH(`     ${pad(`fit window ${FIT_WINDOW.join("+")}`, 22)}${lpad(sgn(bF.beta, 4), 14)}${lpad(sgn(bothF.beta, 4), 13)}  ${pad(`[${sgn(bothF.ci.lo, 3)}, ${sgn(bothF.ci.hi, 3)}] ${clear(bothF.ci) ? "CI-clear" : "COVERS 0"}`, 22)}${lpad(pct(1 - keepF), 19)}`);
  sayH(`     ${pad(`full ${YEARS[0]}–${YEARS[YEARS.length - 1]}`, 22)}${lpad(sgn(bA.beta, 4), 14)}${lpad(sgn(bothA.beta, 4), 13)}  ${pad(`[${sgn(bothA.ci.lo, 3)}, ${sgn(bothA.ci.hi, 3)}] ${clear(bothA.ci) ? "CI-clear" : "COVERS 0"}`, 22)}${lpad(pct(1 - keepA), 19)}`);
  sayH();
}
{
  const bbF = auxRuns[0]!.fitWin, bbA = auxRuns[0]!.full;
  sayH(`  READ. The BB aux is substantially a proxy: the opposition a pitcher faces differs by 23`);
  sayH(`  EYE points between same- and opposite-side matchups (the largest composition gap in the`);
  sayH(`  whole survey), and that exposure is correlated with Stuff. Controlling it removes`);
  sayH(`  ${pct(1 - Math.abs(bbF.find((x) => x.ctrl === "both")!.beta / bbF.find((x) => x.ctrl === "none")!.beta))} of the coefficient on the window it was fitted on, and what survives there is no`);
  sayH(`  longer resolved. On the wider window ${pct(Math.abs(bbA.find((x) => x.ctrl === "both")!.beta / bbA.find((x) => x.ctrl === "none")!.beta))} survives and stays marginally CI-clear — so a real Stuff`);
  sayH(`  effect on walks is NOT ruled out, but roughly half to two-thirds of the shipped coefficient`);
  sayH(`  is exposure, and an opponent term would supersede that part. The HR aux is unaffected by`);
  sayH(`  the controls in either direction and stands on its own.`);
  sayH(`  NOTE the cell FE and the linear opposing-rating control agree closely in both channels,`);
  sayH(`  which is the sign that they are picking up the same thing rather than absorbing the aux`);
  sayH(`  by accident of specification.`);
  sayH(`  SEPARATE OBSERVATION, not a composition finding: the HR aux survives the controls but is`);
  sayH(`  itself weakly resolved — CI-clear on the fit window, covering zero on the wider one, and`);
  sayH(`  the coefficient is ${sgn(auxRuns[1]!.full.find((x) => x.ctrl === "none")!.beta, 4)} there vs ${sgn(auxRuns[1]!.deployed, 4)} deployed. That is a stability question for`);
  sayH(`  another pass; it is not the confound this task asked about.`);
  sayH();
}

// ════════════════════════════════════════════════════════════════════════════════
// BODY
// ════════════════════════════════════════════════════════════════════════════════
say("################################################################################");
say("## 1. THE MATCHUP CELLS — exposure and opposing profile");
say("################################################################################");
say();
say(`     BF / PA by matchup cell (pooled ${YEARS[0]}–${YEARS[YEARS.length - 1]}):`);
say(`     ${pad("cell", 22)}${lpad("pit rows", 10)}${lpad("pit BF", 12)}${lpad("hit rows", 10)}${lpad("hit PA", 12)}`);
for (const [T, B] of [["R", "R"], ["R", "L"], ["L", "R"], ["L", "L"]] as [H, H][]) {
  const p = PIT.filter((r) => r.T === T && r.B === B), h = HIT.filter((r) => r.T === T && r.B === B);
  say(`     ${pad(`${T}HP vs ${B}HB ${T === B ? "(same)" : "(opp)"}`, 22)}${lpad(String(p.length), 10)}${lpad(k(sum(p.map((r) => r.w))), 12)}${lpad(String(h.length), 10)}${lpad(k(sum(h.map((r) => r.w))), 12)}`);
}
say();
say(`     OPPOSING PROFILE by cell (PA/BF-weighted mean rating of the opposition actually faced,`);
say(`     averaged over the ${YEARS.length} seasons):`);
say(`     ${pad("cell", 16)}${["kRat", "eye", "pow", "babip", "gap"].map((s) => lpad(s, 8)).join("")}   ${["stu", "con", "hrr", "pbabip"].map((s) => lpad(s, 9)).join("")}`);
for (const [T, B] of [["R", "R"], ["R", "L"], ["L", "R"], ["L", "L"]] as [H, H][]) {
  const cs = YEARS.map((y) => compYear.get(y)!.get(`${T}|${B}`)).filter(Boolean) as Comp[];
  const mh = (kk: string) => sum(cs.map((c) => c.hitPA * c.oppHit[kk]!)) / sum(cs.map((c) => c.hitPA));
  const mp = (kk: string) => sum(cs.map((c) => c.pitBF * c.oppPit[kk]!)) / sum(cs.map((c) => c.pitBF));
  say(`     ${pad(`${T}HP/${B}HB ${T === B ? "same" : "opp "}`, 16)}${["kRat", "eye", "pow", "babip", "gap"].map((s) => lpad(f(mh(s), 1), 8)).join("")}   ${["stu", "con", "hrr", "pbabip"].map((s) => lpad(f(mp(s), 1), 9)).join("")}`);
}
say(`     (the hitter columns are the opposition a PITCHER in that cell faced; the pitcher columns`);
say(`      are the opposition a HITTER in that cell faced.)`);
say();

say("################################################################################");
say("## 2. PER-CHANNEL DETAIL — composition gap, level gap, response, and pricing ratio");
say("################################################################################");
say();
for (const r of ranked) {
  const d = r.d;
  say(`  ══ ${d.label}   (own ${d.own}, opposing ${d.opp}) ══`);
  say(`     ${r.rows} rows / ${r.cards} cards / ${k(r.wtot)} ${d.role === "pit" ? "BF" : "PA"} / Kish ESS ${f(r.ess, 1)}`);
  if (d.opp === "—") {
    say(`     NO COMPLEMENTARY RATING EXISTS. The pitcher side has no GAP analog — predictPitching`);
    say(`     hard-codes XBH = 0.25 × non-HR hits. So this channel cannot be given a paired opponent`);
    say(`     term at all without first giving pitchers an extra-base-suppression rating that the`);
    say(`     card data does not contain. Composition share is still measurable: cell ${pct(r.fracCell)},`);
    say(`     cell×season ${pct(r.fracCellYear)}; residual sd ${f(r.sdRaw, 2)}/600.`);
    say(`     level same−opp ${sgn(r.lvlGap)}/600, CI [${sgn(r.lvlCI.lo)}, ${sgn(r.lvlCI.hi)}], p=${f(r.lvlP, 3)} ${clear(r.lvlCI) ? "CI-clear" : "covers 0"}.`);
    say();
    continue;
  }
  say(`     1. composition gap (same − opposite) in ${d.opp}:  ${sgn(r.compGap, 2)} rating points`);
  say(`        (same-side faces ${f(r.oppSame, 1)}, opposite-side ${f(r.oppOpp, 1)})`);
  say(`     2. residual LEVEL gap (same − opposite): ${sgn(r.lvlGap)}/600  CI [${sgn(r.lvlCI.lo)}, ${sgn(r.lvlCI.hi)}]  p=${f(r.lvlP, 3)}  ${clear(r.lvlCI) ? "★ CI-CLEAR" : "covers 0"}`);
  say(`        same-side level ${sgn(r.lvlSame)}, opposite-side ${sgn(r.lvlOpp)};  sign consistency ${r.signNeg}/${r.signTot} league-seasons negative`);
  say(`     3. fitted response ${sgn(r.slope, 3)} events/600 per opposing rating point  CI [${sgn(r.slopeCI.lo, 3)}, ${sgn(r.slopeCI.hi, 3)}]`);
  say(`        the model's own complementary curve prices that point at ${sgn(-r.compl, 3)}`);
  say(`        ⇒ RATIO ${f(r.ratio, 2)}×  CI [${f(Math.min(r.ratioCI.lo, r.ratioCI.hi), 2)}, ${f(Math.max(r.ratioCI.lo, r.ratioCI.hi), 2)}]  (1.00 = exactly what the model itself says the opponent is worth)`);
  say(`     4. composition explains ${pct(r.fracCell)} of the channel's residual mean-square (cell), ${pct(r.fracCellYear)} (cell×season)`);
  say(`        residual sd ${f(r.sdRaw, 2)}/600 → ${f(Math.sqrt(Math.max(r.msRaw - r.msCell, 0)), 2)}/600 of it is composition`);
  say(`     5. own-rating SHAPE (cubic partial on z(${d.own})), before → after removing the cell level:`);
  say(`        raw ${sgn(r.cubRaw, 4)} [${sgn(r.cubRawCI.lo, 3)}, ${sgn(r.cubRawCI.hi, 3)}] ${clear(r.cubRawCI) ? "CI-clear" : "covers 0"}  →  corrected ${sgn(r.cubCorr, 4)} [${sgn(r.cubCorrCI.lo, 3)}, ${sgn(r.cubCorrCI.hi, 3)}] ${clear(r.cubCorrCI) ? "CI-clear" : "covers 0"}`);
  const dir = Math.abs(r.cubCorr) > Math.abs(r.cubRaw) * 1.1 ? "STRENGTHENS" : Math.abs(r.cubCorr) < Math.abs(r.cubRaw) * 0.9 ? "WEAKENS" : "unchanged";
  say(`        ⇒ removing composition ${dir} this channel's own-rating shape structure.`);
  say();
}

say("################################################################################");
say("## 3. stuffAug — the shipped Stuff aux on pitcher BB and HR, under composition control");
say("################################################################################");
say();
say(`     The aux is a linear z(ln Stuff) term added to the pitcher BB and HR fits, on the rationale`);
say(`     that "high Stuff suppresses walks and homers beyond Control/HRR". It was fitted on data`);
say(`     where opposing-batter composition varies strongly ACROSS the Stuff range and was unmodelled.`);
say();
{
  const srt = [...PIT].sort((a, b) => a.own.stu! - b.own.stu!);
  const parts: string[] = [], eyeParts: string[] = [], powParts: string[] = [];
  for (let i = 0; i < 5; i++) {
    const s = srt.slice(Math.floor((i / 5) * srt.length), Math.floor(((i + 1) / 5) * srt.length));
    const sm = s.filter(isSame);
    parts.push(`Q${i + 1} ${f(100 * sum(sm.map((r) => r.w)) / sum(s.map((r) => r.w)), 0)}%`);
    const ov = (kk: "eye" | "pow") => { const t = s.filter((r) => Number.isFinite(compYear.get(r.year)!.get(cellKey(r))?.oppHit[kk] ?? NaN)); return sum(t.map((r) => r.w * compYear.get(r.year)!.get(cellKey(r))!.oppHit[kk]!)) / sum(t.map((r) => r.w)); };
    eyeParts.push(`Q${i + 1} ${f(ov("eye"), 1)}`); powParts.push(`Q${i + 1} ${f(ov("pow"), 1)}`);
  }
  say(`     same-side BF share by Stuff quintile:      ${parts.join("   ")}`);
  say(`     opposing EYE faced, by Stuff quintile:     ${eyeParts.join("  ")}`);
  say(`     opposing POW faced, by Stuff quintile:     ${powParts.join("  ")}`);
  say(`     ⇒ the confound is present: the opposition a pitcher faces is NOT independent of his Stuff.`);
}
say();
for (const a of auxRuns) {
  say(`  ── pit.${a.ch} aux (deployed beta ${sgn(a.deployed, 4)}) ──`);
  say(`     ${pad("window", 24)}${pad("control", 34)}${lpad("aux beta", 11)}  ${pad("95% CI (card cluster)", 24)}${lpad("% of uncontrolled", 19)}`);
  for (const set of [a.fitWin, a.full]) {
    const base = set.find((x) => x.ctrl === "none")!;
    for (const x of set) {
      const lbl = x.ctrl === "none" ? "none (reproduces the fit)" : x.ctrl === "cell" ? "matchup-cell fixed effects" : x.ctrl === "opp" ? `linear opposing ${a.ch === "BB" ? "eye" : "pow"}` : "cell FE + opposing rating";
      say(`     ${pad(x.tag, 24)}${pad(lbl, 34)}${lpad(sgn(x.beta, 4), 11)}  ${pad(`[${sgn(x.ci.lo, 3)}, ${sgn(x.ci.hi, 3)}]`, 24)}${lpad(f(100 * x.beta / base.beta, 0) + "%", 19)}`);
    }
  }
  say();
}

say("################################################################################");
say("## 4. RATING SHAPE — is the paired opposing rating enough, or is the whole profile moving?");
say("################################################################################");
say();
say(`     The doctrine is that a card's quality is never inferrable from ONE rating. If an opponent`);
say(`     term is built as "residual ~ the single paired opposing rating", that assumption is being`);
say(`     made implicitly. Test it on the design points the composition actually supplies: the`);
say(`     ${YEARS.length} seasons × 4 matchup cells = ${YEARS.length * 4} distinct opposing-profile vectors.`);
say();
const cellPts = YEARS.flatMap((y) => (["R|R", "R|L", "L|R", "L|L"] as const).map((c) => ({ y, c, comp: compYear.get(y)!.get(c)! })).filter((x) => x.comp));
const corr = (xs: number[], ys: number[]) => { const n = xs.length, mx = sum(xs) / n, my = sum(ys) / n; return sum(xs.map((x, i) => (x - mx) * (ys[i]! - my))) / (Math.sqrt(sum(xs.map((x) => (x - mx) ** 2)) * sum(ys.map((y) => (y - my) ** 2))) || 1e-12); };
for (const [tag, side, keys] of [["opposing HITTER profile", "oppHit", ["kRat", "eye", "pow", "babip", "gap"]], ["opposing PITCHER profile", "oppPit", ["stu", "con", "hrr", "pbabip"]]] as const) {
  say(`     correlation matrix of the ${tag} across the ${cellPts.length} (season × cell) design points:`);
  say(`        ${pad("", 10)}${keys.map((s) => lpad(s, 9)).join("")}`);
  for (const a of keys) say(`        ${pad(a, 10)}${keys.map((b) => lpad(sgn(corr(cellPts.map((p) => (p.comp as any)[side][a]), cellPts.map((p) => (p.comp as any)[side][b])), 2), 9)).join("")}`);
  const mean = keys.flatMap((a, i) => keys.slice(i + 1).map((b) => Math.abs(corr(cellPts.map((p) => (p.comp as any)[side][a]), cellPts.map((p) => (p.comp as any)[side][b])))));
  say(`        mean |off-diagonal correlation| = ${f(sum(mean) / mean.length, 2)}`);
  say();
}
say(`     PREDICTING THE CELL-MEAN RESIDUAL: paired rating alone vs the whole opposing profile.`);
say(`     Leave-one-(season×cell)-out prediction error, weighted by cell exposure. If the profile`);
say(`     version does not beat the paired-rating version, the single-rating pairing is adequate`);
say(`     HERE; if the paired rating is not even the best single predictor, it is not.`);
say(`     ${pad("channel", 22)}${lpad("paired LOO", 12)}${lpad("profile LOO", 13)}${lpad("best single", 13)}${lpad("winner", 12)}`);
for (const r of ranked) {
  const d = r.d; if (d.opp === "—") continue;
  const side = d.oppSide, keys = side === "oppHit" ? ["kRat", "eye", "pow", "babip", "gap"] : ["stu", "con", "hrr", "pbabip"];
  const rs = rowsFor(d).filter((x) => Number.isFinite(oppVal(d, x)));
  const pts = cellPts.map((p) => {
    const s = rs.filter((x) => x.year === p.y && cellKey(x) === p.c);
    return { w: sum(s.map((x) => x.w)), y: wmean(s, (x) => x.resid[d.ch]!), x: keys.map((kk) => (p.comp as any)[side][kk] as number) };
  }).filter((p) => p.w > 0 && Number.isFinite(p.y));
  const loo = (cols: number[]) => {
    let se = 0, sw = 0;
    for (let i = 0; i < pts.length; i++) {
      const tr = pts.filter((_, j) => j !== i);
      if (tr.length <= cols.length + 1) continue;
      const X = tr.map((p) => [1, ...cols.map((c) => p.x[c]!)]), b = wls(X, tr.map((p) => p.y), tr.map((p) => p.w));
      const xi = [1, ...cols.map((c) => pts[i]!.x[c]!)];
      const e = pts[i]!.y - b.reduce((s, bb, j) => s + bb * xi[j]!, 0);
      se += pts[i]!.w * e * e; sw += pts[i]!.w;
    }
    return sw > 0 ? se / sw : NaN;
  };
  const pi = keys.indexOf(d.opp);
  const lPaired = loo([pi]), lProfile = loo(keys.map((_, i) => i));
  const singles = keys.map((kk, i) => ({ kk, v: loo([i]) })).sort((a, b) => a.v - b.v);
  const win = lProfile < lPaired * 0.9 ? "PROFILE" : singles[0]!.kk !== d.opp ? `${singles[0]!.kk} (!)` : "paired ok";
  say(`     ${pad(d.label, 22)}${lpad(f(lPaired, 2), 12)}${lpad(f(lProfile, 2), 13)}${lpad(singles[0]!.kk, 13)}${lpad(win, 12)}`);
}
say();
say(`     READ, with the caveat stated first: ${cellPts.length} design points against 4–5 predictors is thin, and`);
say(`     LOO on 28 points is itself noisy — treat this as a DIRECTIONAL warning, not a measurement.`);
say(`     Directionally it is one-sided: the full opposing PROFILE beats the single paired rating on`);
say(`     7 of 8 channels, and for PITCHER hits the best single predictor of the residual is the`);
say(`     opposing kRat — NOT its own pair (babip). The opposing ratings are not independent`);
say(`     (mean |r| 0.45 on the hitter side, 0.35 on the pitcher side), so "the paired rating" is`);
say(`     partly standing in for a correlated bundle. DESIGN CONSTRAINT: an opponent term should be`);
say(`     specified over the opposing card's PROFILE, not its single paired rating — consistent with`);
say(`     the rating-shape doctrine. A single-rating pairing is a modelling assumption this data`);
say(`     does not support, and it is cheapest to avoid making it now.`);
say();

say("################################################################################");
say("## 5. WHAT THIS IMPLIES — per-channel or model-wide?");
say("################################################################################");
say();
const need = ranked.filter((r) => r.fracCell >= 0.25), material = ranked.filter((r) => r.fracCell >= 0.08 && r.fracCell < 0.25), rounding = ranked.filter((r) => r.fracCell < 0.08);
say(`  MODEL-WIDE, NOT PER-CHANNEL — but the payoff is concentrated. The hole is structural: no`);
say(`  channel in either role has an opponent term, and the four count channels that carry the`);
say(`  wOBA weight (K and BB in both roles) are exactly the four where composition is largest:`);
say(`     ${need.map((r) => `${r.d.label} ${pct(r.fracCell)}`).join(",  ")}`);
say(`  Those four alone account for ${f(sum(need.map((r) => r.msRaw - r.msCell)), 1)} of the ${f(sum(RES.map((r) => r.msRaw - r.msCell)), 1)} total mean-square the composition removes`);
say(`  across all nine channels — ${pct(sum(need.map((r) => r.msRaw - r.msCell)) / sum(RES.map((r) => r.msRaw - r.msCell)))} of the whole prize. Building the term for K and BB in both`);
say(`  roles captures nearly all of it; the power and BIP channels are follow-on, not motivation.`);
say();
say(`  MATERIAL BUT SECONDARY: ${material.map((r) => `${r.d.label} ${pct(r.fracCell)} (resid sd only ${f(r.sdRaw, 2)}/600)`).join("; ")}.`);
say(`  ROUNDING ERROR: ${rounding.map((r) => `${r.d.label} ${pct(r.fracCell)}`).join("; ")}.`);
say();
say(`  THE PRICING RATIOS SAY THE TERM IS ALREADY SPECIFIED, NOT INVENTED. Across the four big`);
say(`  channels the residual moves with the opposing rating at ${need.map((r) => `${r.d.label.split(" ")[0]!.toLowerCase()} ${r.d.ch} ${f(r.ratio, 2)}×`).join(", ")}`);
say(`  what the model's own complementary curve already prices that rating point at (1.00 = exact).`);
say(`  The model contains the number; it`);
say(`  simply never applies it to the opponent. That is an argument for a SYMMETRIC term derived`);
say(`  from the existing curves rather than a new free-parameter block.`);
say();
say(`  WHERE THE EVIDENCE IS TOO THIN TO SAY — flagged explicitly:`);
say(`   • PITCHER hits(nonHR): composition share ${pct(byKey("pit.H").fracCell)}, level gap ${sgn(byKey("pit.H").lvlGap)}/600 covering 0 (p=${f(byKey("pit.H").lvlP, 3)}),`);
say(`     sign consistency only ${byKey("pit.H").signNeg}/${byKey("pit.H").signTot}, and a pricing ratio of ${f(byKey("pit.H").ratio, 2)}× whose CI spans zero and the wrong`);
say(`     sign. This channel shows NO usable opponent signal on the paired rating. Do not build one`);
say(`     for it on this evidence.`);
say(`   • HITTER hits(nonHR): the composition GAP is ${sgn(byKey("hit.H").compGap, 2)} rating points — essentially nothing — yet`);
say(`     the fitted response is ${f(byKey("hit.H").ratio, 2)}× the model's own pricing. A slope that large off a gap that`);
say(`     small is identified by season drift, not by the matchup, so it is not evidence for a`);
say(`     matchup opponent term. Treat the ${pct(byKey("hit.H").fracCell)} share as an upper bound.`);
say(`   • HITTER XBH: unpairable. There is no pitcher GAP rating; predictPitching hard-codes the`);
say(`     0.25 XBH share. Any opponent term here needs a rating the card data does not carry.`);
say(`   • Both HR channels: shares of ~10–12% but on residual sds of ~1.2/600. Real, tiny, and the`);
say(`     ${byKey("pit.HR").signNeg}/${byKey("pit.HR").signTot} and ${byKey("hit.HR").signNeg}/${byKey("hit.HR").signTot} league-season sign counts are not the near-unanimity the K and BB channels show.`);
say();
say(`  A CAVEAT THAT APPLIES TO EVERY NUMBER ABOVE. Same-side exposure is MANAGER-SELECTED — a`);
say(`  pitcher gets platoon-advantage batters because someone chose the matchup. For PREDICTION`);
say(`  that distinction does not matter (the term models who was actually faced), but the SIZE of`);
say(`  the effect is a property of this corpus's usage patterns. Tournament rosters and usage`);
say(`  differ, so the coefficient should be re-measured there before it is trusted out of frame.`);
say(`  And this survey does not establish the FORM of an opponent term — only that the hole is`);
say(`  real, where it is largest, and that the model already contains the pricing it would need.`);
say();

process.stdout.write(HEAD.concat(L).join("\n") + "\n");
process.exit(0);
