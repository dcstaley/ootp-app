// BATCH 3 FIX #1 candidate — baserunning value, FIT ON OUR LEAGUE DATA (trust hierarchy: fit on
// league exports; cwhit only confirms). The deployed model weights baserunning at ZERO
// (w_speed/steal/run=0, adv_* unset) yet the cwhit audit showed Speed/Stealing/Baserunning predict
// observed wSB/UBR at corr up to 0.93. Baserunning is NOT a platoon-split stat, so the vL/vR training
// files carry the columns but they're EMPTY; the "ALL" (unsplit season-total) league exports carry
// them populated. This fits the wOBA-equivalent value of the three ratings from the ALL-file wSB/UBR.
//   run: node tools/baserunning-fit.ts
import { readFileSync } from "node:fs";
import { globSync } from "node:fs";
import Papa from "papaparse";
import { wls } from "../src/training/fit.ts";

const WOBA_SCALE = 1.25;                                    // runs per wOBA point (standard)
const RUNS600_TO_MWOBA = (WOBA_SCALE / 600) * 1000;        // 2.083 mwOBA per run/600
const num = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const fmt = (x: number, d = 3) => (Number.isFinite(x) ? x.toFixed(d) : "n/a");
const sd = (xs: number[]) => { const m = xs.reduce((a, b) => a + b, 0) / xs.length; return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / xs.length); };
const corr = (xs: number[], ys: number[]) => { const nn = xs.length, mx = xs.reduce((a, b) => a + b, 0) / nn, my = ys.reduce((a, b) => a + b, 0) / nn; let cv = 0, vx = 0, vy = 0; for (let i = 0; i < nn; i++) { cv += (xs[i]! - mx) * (ys[i]! - my); vx += (xs[i]! - mx) ** 2; vy += (ys[i]! - my) ** 2; } return cv / Math.sqrt(vx * vy); };

const files = globSync("League Files/**/*ALL*.csv");
console.log(`[baserunning-fit] ${files.length} ALL (unsplit) league files: ${files.map((f) => f.split(/[\\/]/).pop()).join(", ")}\n`);
type Row = { pa: number; wSB: number; UBR: number; SB: number; CS: number; spe: number; stl: number; run: number; pos: string };
const rows: Row[] = [];
for (const f of files) {
  const parsed = Papa.parse<Record<string, string>>(readFileSync(f, "utf8"), { header: true, skipEmptyLines: true });
  for (const r of parsed.data ?? []) {
    if (!r || r["PA"] == null) continue;
    rows.push({ pa: num(r["PA"]), wSB: num(r["wSB"]), UBR: num(r["UBR"]), SB: num(r["SB"]), CS: num(r["CS"]), spe: num(r["SPE"]), stl: num(r["STE"]), run: num(r["RUN"]), pos: String(r["POS"] ?? "") });
  }
}
// Hitters with real PT (drop pitchers hitting + tiny samples).
const hit = rows.filter((r) => r.pa >= 300 && r.pos.toUpperCase() !== "P" && r.pos !== "1");
const per600 = (v: number, pa: number) => (v / Math.max(pa, 1)) * 600;
const spe = hit.map((r) => r.spe), stl = hit.map((r) => r.stl), run = hit.map((r) => r.run);
const wsb = hit.map((r) => per600(r.wSB, r.pa)), ubr = hit.map((r) => per600(r.UBR, r.pa)), tot = hit.map((_, i) => wsb[i]! + ubr[i]!);
const w = hit.map((r) => r.pa);
console.log(`N=${hit.length} hitter-seasons (PA≥300, non-P). Observed runs/600: wSB mean ${fmt(wsb.reduce((a, b) => a + b, 0) / hit.length, 2)} SD ${fmt(sd(wsb), 2)} | UBR mean ${fmt(ubr.reduce((a, b) => a + b, 0) / hit.length, 2)} SD ${fmt(sd(ubr), 2)} | total SD ${fmt(sd(tot), 2)}`);
console.log(`Rating→outcome corr: Stealing→wSB ${fmt(corr(stl, wsb), 3)}  Speed→wSB ${fmt(corr(spe, wsb), 3)}  Baserunning→UBR ${fmt(corr(run, ubr), 3)}  Speed→UBR ${fmt(corr(spe, ubr), 3)}\n`);

// ── FIT: total baserunning runs/600 ~ speed + steal + run (PA-weighted OLS, centered) ──
const mu = { spe: spe.reduce((a, b) => a + b, 0) / hit.length, stl: stl.reduce((a, b) => a + b, 0) / hit.length, run: run.reduce((a, b) => a + b, 0) / hit.length };
const X = hit.map((_, i) => [1, spe[i]! - mu.spe, stl[i]! - mu.stl, run[i]! - mu.run]);
const beta = wls(X, tot, w);
const yhat = X.map((xr) => xr.reduce((s, v, j) => s + v * beta[j]!, 0));
console.log(`FIT total(wSB+UBR)/600 ~ speed+steal+run (PA-weighted, centered at spe ${fmt(mu.spe, 0)}/ste ${fmt(mu.stl, 0)}/run ${fmt(mu.run, 0)}):`);
console.log(`  intercept ${fmt(beta[0]!, 3)} runs/600  |  β_speed ${fmt(beta[1]!, 4)}  β_steal ${fmt(beta[2]!, 4)}  β_run ${fmt(beta[3]!, 4)}  (runs/600 per rating pt)`);
console.log(`  fit corr(pred, obs) = ${fmt(corr(yhat, tot), 3)}  |  pred SD ${fmt(sd(yhat), 2)} vs obs SD ${fmt(sd(tot), 2)} runs/600 (rest = single-season noise)`);

// ── adv_* coeffs for woba.ts (adds adv_*·rating to per-PA wOBA). The intercept is DROPPED: a constant
//    baserunning level shifts all hitters equally (no ranking effect) and the anchor absorbs it. ──
const adv = { speed: beta[1]! * (WOBA_SCALE / 600), steal: beta[2]! * (WOBA_SCALE / 600), run: beta[3]! * (WOBA_SCALE / 600) };
console.log(`\nadv_* (wOBA per rating pt, for woba.ts; intercept dropped):`);
console.log(`  adv_speed ${fmt(adv.speed, 6)}  adv_steal ${fmt(adv.steal, 6)}  adv_run ${fmt(adv.run, 6)}`);
console.log(`  value SPREAD added: pred baserunning SD ${fmt(sd(yhat) * RUNS600_TO_MWOBA, 1)} mwOBA; range ${fmt((Math.max(...yhat) - Math.min(...yhat)) * RUNS600_TO_MWOBA, 1)} mwOBA top-to-bottom.`);

// ── EXTERNAL CONFIRMATION vs cwhit (tools/cwhit-audit-deployed-hit.ts): obs total SD ≈ 2.93 runs/600;
//    Baserunning→UBR 0.93, Speed→UBR 0.89, Stealing→wSB 0.52. ──
console.log(`\nEXTERNAL (cwhit deep PA≥2000): obs total SD ≈ 2.93 runs/600; Baserunning→UBR 0.93, Speed→UBR 0.89, Stealing→wSB 0.52.`);
console.log(`League(2042 ALL) obs total SD ${fmt(sd(tot), 2)} runs/600 — ${Math.abs(sd(tot) - 2.93) < 1.2 ? "CONSISTENT with cwhit magnitude ✓" : "differs from cwhit — CHECK"}.`);
process.exit(0);
