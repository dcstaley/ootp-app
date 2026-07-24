// K-RESIDUAL vs STUFF, IN-FRAME (Fable pre-step, 2026-07-23). MEASUREMENT ONLY; nothing wired.
//   run: node tools/kresidual-stuff-inframe.ts > fixtures/kresidual-stuff-inframe-2026-07-23.txt
//
// THE UNIFICATION HYPOTHESIS under test: three instruments (the anchor audit's Stuff-sloped wOBAA
// bias, centerpiece #2's surviving K curvature, the (c)/battery pitcher-side K-spread verdict) point
// at ONE pitcher-side mechanism — a TOO-SHALLOW K-response to Stuff in the DEPLOYED curve. If it is a
// CURVE-FORM defect (not a frame effect), it must show IN-FRAME, on the league training data, under
// the DEPLOYED form. Expected signature: K under-predicted at high Stuff, over-predicted at low.
//
// THE INSTRUMENT SUBTLETY, stated because it changes what "the shape" means: the deployed K curve is a
// raw-QUAD fit on this same league data, so by least-squares orthogonality its residual's LINEAR slope
// on Stuff is ~0 BY CONSTRUCTION — a flat linear slope is NOT evidence of no defect. The informative
// signal is HIGHER-ORDER: does the residual bend where a quad cannot (a monotone tail, or a cubic
// S-shape)? So this reports the quartile pattern AND a curvature read (cubic partial), not just a line.
//
// GRAIN: ROW grain — each observation is one (card × deployment side × season) row from the loader,
// weighted by BF. NOT card-grain; a two-sided two-season pitcher contributes up to four rows. Stated
// per the standing rule. NOISE-WEIGHTED by BF (the per-600 K rate's precision scales with BF).
// DEPLOYED FORM: makeRawPolyModel(trained.eventForm) — the shipped curve, not a refit.

import { existsSync } from "node:fs";
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { makeRawPolyModel, type EventForm } from "../src/scoring-core/index.ts";
import { loadWindow, type TrainObs } from "../src/training/loader.ts";
import { PITCHER } from "../src/training/bakeoff.ts";

const L: string[] = [];
const say = (s = "") => L.push(s);
const f = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "n/a");
const sgn = (x: number, d = 2) => (Number.isFinite(x) ? `${x >= 0 ? "+" : ""}${x.toFixed(d)}` : "n/a");
const pad = (s: string, n: number) => s.padEnd(n);

const repo = new Repository("data");
await seedDefaults(repo); await seedEras(repo); await seedAccounts(repo);
const state = (await repo.load<{ activeModelId?: string }>("state", "app")) ?? {};
type TM_ = { id: string; eventForm?: EventForm; window?: number[]; minPA?: number; includeVariants?: boolean };
const trained = (await repo.loadAll<TM_>("trained-models")).find((x) => x.id === state.activeModelId);
if (!trained?.eventForm) throw new Error("active model has no eventForm");
const rp = makeRawPolyModel(trained.eventForm);      // THE DEPLOYED FORM
const TRAIN = ["League Files", "Model 2037 and 2038"].find((d) => existsSync(d))!;
const win: number[] = Array.isArray(trained.window) && trained.window.length ? trained.window : [];
const obs = loadWindow(TRAIN, win.length ? win : undefined).observations.filter((o: TrainObs) => (trained.includeVariants ?? true) || !o.variant);
const minPA = Math.max(0, Number(trained.minPA ?? 1000) || 1000);
const pitQ = obs.filter((o) => PITCHER.qualifies(o, minPA));

// per-card K residual (deployed pred − obs), per 600 BF, weighted by BF
interface Row { stu: number; resid: number; w: number; side: string }
const rows: Row[] = [];
for (const o of pitQ) {
  const bf = Math.max(o.pitch.BF, 1);
  const obsK = (o.pitch.K / bf) * 600;
  const predK = rp.predictPitching(o.ratings.pitch, {} as any).K;   // deployed form, per 600
  if (!Number.isFinite(obsK) || !Number.isFinite(predK)) continue;
  rows.push({ stu: o.ratings.pitch.stu, resid: predK - obsK, w: bf, side: String(o.side) });
}

const wmean = (rs: Row[], get: (r: Row) => number) => { const sw = rs.reduce((a, r) => a + r.w, 0); return sw > 0 ? rs.reduce((a, r) => a + r.w * get(r), 0) / sw : NaN; };
// weighted polynomial partials via normal equations up to cubic, on standardized stu
const mu = wmean(rows, (r) => r.stu), sd = Math.sqrt(wmean(rows, (r) => (r.stu - mu) ** 2)) || 1;
const z = (s: number) => (s - mu) / sd;
function wpoly(rs: Row[], deg: number): number[] {
  // design [1, z, z^2, z^3][:deg+1]; solve weighted normal equations (small, Gaussian elimination)
  const n = deg + 1;
  const A = Array.from({ length: n }, () => new Array(n).fill(0)), b = new Array(n).fill(0);
  for (const r of rs) {
    const zz = z(r.stu), p = [1, zz, zz * zz, zz * zz * zz].slice(0, n);
    for (let i = 0; i < n; i++) { b[i] += r.w * p[i]! * r.resid; for (let j = 0; j < n; j++) A[i]![j] += r.w * p[i]! * p[j]!; }
  }
  for (let i = 0; i < n; i++) { let piv = i; for (let k = i + 1; k < n; k++) if (Math.abs(A[k]![i]!) > Math.abs(A[piv]![i]!)) piv = k; [A[i], A[piv]] = [A[piv]!, A[i]!]; [b[i], b[piv]] = [b[piv], b[i]]; const d = A[i]![i]! || 1e-12; for (let k = i + 1; k < n; k++) { const fct = A[k]![i]! / d; for (let j = i; j < n; j++) A[k]![j]! -= fct * A[i]![j]!; b[k] -= fct * b[i]; } }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) { let s = b[i]; for (let j = i + 1; j < n; j++) s -= A[i]![j]! * x[j]; x[i] = s / (A[i]![i]! || 1e-12); }
  return x;
}
let a = 20260723 >>> 0; const rnd = () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const ci = (xs: number[]) => { const v = [...xs].sort((p, q) => p - q); return { lo: v[Math.floor(0.025 * v.length)]!, hi: v[Math.floor(0.975 * v.length)]! }; };
const clear = (c: { lo: number; hi: number }) => (c.lo > 0 && c.hi > 0) || (c.lo < 0 && c.hi < 0);

// full read for one row-set: level, quintile shape, linear + cubic partials with bootstrap CIs
function analyze(rs: Row[]) {
  const bLin: number[] = [], bCub: number[] = [];
  for (let b = 0; b < 2000; b++) {
    const bs = rs.map(() => rs[Math.floor(rnd() * rs.length)]!);
    bLin.push(wpoly(bs, 1)[1]!);          // linear coeff
    bCub.push(wpoly(bs, 3)[3]!);          // cubic coeff (curvature the quad cannot fit)
  }
  const srt = [...rs].sort((p, q) => p.stu - q.stu);
  const quints = [0, 1, 2, 3, 4].map((i) => {
    const s = srt.slice(Math.floor((i / 5) * srt.length), Math.floor(((i + 1) / 5) * srt.length));
    return { lo: s[0]?.stu ?? 0, hi: s[s.length - 1]?.stu ?? 0, resid: wmean(s, (r) => r.resid), n: s.length };
  });
  return { n: rs.length, level: wmean(rs, (r) => r.resid), quints, lin: wpoly(rs, 1)[1]!, linCI: ci(bLin), cub: wpoly(rs, 3)[3]!, cubCI: ci(bCub) };
}
type An = ReturnType<typeof analyze>;
function emit(a: An, label: string) {
  say(`  ── ${label}  (N=${a.n} rows, level ${sgn(a.level)}/600) ──`);
  say(`     stu quintile        mean K resid      n`);
  for (const q of a.quints) say(`     ${pad(`[${f(q.lo, 0)}-${f(q.hi, 0)}]`, 16)} ${sgn(q.resid).padStart(8)}       ${q.n}`);
  say(`     LINEAR partial: ${sgn(a.lin, 3)} [${sgn(a.linCI.lo, 3)}, ${sgn(a.linCI.hi, 3)}] ${clear(a.linCI) ? "CI-clear" : "covers 0"}   (≈0 BY CONSTRUCTION — not evidence)`);
  say(`     CUBIC  partial: ${sgn(a.cub, 4)} [${sgn(a.cubCI.lo, 4)}, ${sgn(a.cubCI.hi, 4)}] ${clear(a.cubCI) ? "★ CI-CLEAR — the quad mis-fits the Stuff→K shape" : "covers 0 — no cubic misfit"}`);
  say();
}
const all = analyze(rows);
const bySide = [{ code: "R", tag: "vR" }, { code: "L", tag: "vL" }].map(({ code, tag }) => ({ s: tag, rows: rows.filter((r) => r.side === code) })).filter((x) => x.rows.length > 30).map((x) => ({ s: x.s, a: analyze(x.rows) }));
const cub = all.cub, cubCI = all.cubCI, quints = all.quints;

say("################################################################################");
say("# K-RESIDUAL vs STUFF, IN-FRAME (deployed form).  MEASUREMENT ONLY — nothing wired.");
say("# The unification pre-step: is the Stuff→K mechanism a CURVE-FORM defect, present in-frame?");
say("################################################################################");
say();
say(`  model '${trained.id}'  DEPLOYED form  window ${win.join("+") || "all"}  N=${rows.length} ROWS (card×side×season, BF-weighted)`);
say(`  residual = deployed pred K/600 − observed K/600.  Positive = OVER-predict K (⇒ under-rate the`);
say(`  pitcher's wOBAA the K feeds); negative = UNDER-predict K.`);
say();
say(`  overall in-frame K bias: ${sgn(wmean(rows, (r) => r.resid))}/600  (≈0 expected — the form was fit here)`);
say();
say(`  THE SHAPE IS THE SIGNAL. Pooled first, then per HAND — Fable's amendment makes the hand-split`);
say(`  LEVEL read load-bearing (the pitcher-side verdict cleared pooled SPREAD, never hand-split LEVEL).`);
say();
emit(all, "POOLED (both hands)");
for (const { s, a } of bySide) emit(a, s === "vR" ? "vs RHB (vR)" : "vs LHB (vL)");
// hand-split LEVEL gap: the specific dimension the K verdict never cleared
const lvl = Object.fromEntries(bySide.map(({ s, a }) => [s, a.level]));
const handGap = bySide.length === 2 ? (lvl["vR"]! - lvl["vL"]!) : NaN;
if (bySide.length === 2) say(`  HAND-SPLIT LEVEL gap (vR − vL): ${sgn(handGap)}/600 — a non-trivial gap means the deployed K`);
if (bySide.length === 2) say(`  curve carries a hand-LEVEL error the pooled read hides (the amendment's flagged dimension).`);
say();
say("### VERDICT");
say();
const hiResid = quints[quints.length - 1]!.resid, loResid = quints[0]!.resid;
const signatureMatch = hiResid < loResid;  // under-predict high (neg) vs over low (pos) ⇒ hi < lo
const cubClear = clear(cubCI);
const handLevel = bySide.length === 2 && Math.abs(handGap) >= 0.5;
if (cubClear || signatureMatch || handLevel) {
  say(`  A stu-correlated in-frame K residual IS present: the pooled quintile pattern runs ${sgn(loResid)} (low`);
  say(`  stu) → ${sgn(hiResid)} (high stu)${cubClear ? ", CI-clear cubic partial" : ""}${handLevel ? `, and a ${sgn(handGap)}/600 hand-split LEVEL gap` : ""}. ${signatureMatch ? "Matches the hypothesis's" : "Direction differs from the naive"} signature.`);
  say(`  The deployed K curve leaves a systematic Stuff-shaped residual IN-FRAME ⇒ the mechanism is a`);
  say(`  CURVE-FORM defect, not purely a frame effect. ${handLevel ? "The hand-LEVEL gap in particular is a curve\n  defect the pooled fit cannot express — it is the amendment's flagged dimension, confirmed. " : ""}A form-level`);
  say(`  K-curve fix proposal is warranted (returns to Fable for ruling — NOT fit here).`);
} else {
  say(`  The in-frame K residual is FLAT across Stuff (linear ~0 by construction, cubic covers 0, quintile`);
  say(`  pattern ${sgn(loResid)}→${sgn(hiResid)} within noise, hand-split LEVEL gap ${sgn(handGap)}/600 negligible). No curve-form`);
  say(`  Stuff→K misfit is detected in-frame ⇒ the Stuff mechanism is a FRAME/population effect, not a`);
  say(`  fittable curve defect — the K-class coordinate work stands as the composition layer's job.`);
}
say();
say("(end of artifact — K-residual vs Stuff in-frame)");
process.stdout.write(L.join("\n") + "\n");
process.exit(0);
