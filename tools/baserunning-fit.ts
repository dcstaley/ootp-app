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
type Row = { pa: number; wSB: number; UBR: number; SB: number; CS: number; spe: number; sr: number; stl: number; run: number; pos: string };
const rows: Row[] = [];
for (const f of files) {
  const parsed = Papa.parse<Record<string, string>>(readFileSync(f, "utf8"), { header: true, skipEmptyLines: true });
  for (const r of parsed.data ?? []) {
    if (!r || r["PA"] == null) continue;
    // Ratings: SPE=Speed, SR=Steal Rate (TENDENCY), STE=Stealing (ABILITY), RUN=Baserunning.
    rows.push({ pa: num(r["PA"]), wSB: num(r["wSB"]), UBR: num(r["UBR"]), SB: num(r["SB"]), CS: num(r["CS"]), spe: num(r["SPE"]), sr: num(r["SR"]), stl: num(r["STE"]), run: num(r["RUN"]), pos: String(r["POS"] ?? "") });
  }
}
// Hitters with real PT (drop pitchers hitting + tiny samples).
const hit = rows.filter((r) => r.pa >= 300 && r.pos.toUpperCase() !== "P" && r.pos !== "1");
const per600 = (v: number, pa: number) => (v / Math.max(pa, 1)) * 600;
const col = (g: (r: Row) => number) => hit.map(g);
const spe = col((r) => r.spe), sr = col((r) => r.sr), stl = col((r) => r.stl), run = col((r) => r.run);
const wsb = hit.map((r) => per600(r.wSB, r.pa)), ubr = hit.map((r) => per600(r.UBR, r.pa)), tot = hit.map((_, i) => wsb[i]! + ubr[i]!);
const w = hit.map((r) => r.pa);
console.log(`N=${hit.length} hitter-seasons (PA≥300, non-P). Observed runs/600: wSB mean ${fmt(wsb.reduce((a, b) => a + b, 0) / hit.length, 2)} SD ${fmt(sd(wsb), 2)} | UBR mean ${fmt(ubr.reduce((a, b) => a + b, 0) / hit.length, 2)} SD ${fmt(sd(ubr), 2)} | total SD ${fmt(sd(tot), 2)}`);
console.log(`Rating→wSB corr: StealRate/tendency→wSB ${fmt(corr(sr, wsb), 3)}  Stealing/ability→wSB ${fmt(corr(stl, wsb), 3)}  Speed→wSB ${fmt(corr(spe, wsb), 3)}`);
console.log(`Rating→UBR corr: Baserunning→UBR ${fmt(corr(run, ubr), 3)}  Speed→UBR ${fmt(corr(spe, ubr), 3)}  StealRate→UBR ${fmt(corr(sr, ubr), 3)}\n`);

const meanOf = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const mu = { spe: meanOf(spe), sr: meanOf(sr), stl: meanOf(stl), run: meanOf(run) };
const cen = { spe: spe.map((x) => x - mu.spe), sr: sr.map((x) => x - mu.sr), stl: stl.map((x) => x - mu.stl), run: run.map((x) => x - mu.run) };
const report = (label: string, y: number[], cols: { name: string; x: number[] }[]) => {
  const X = hit.map((_, i) => [1, ...cols.map((c) => c.x[i]!)]);
  const beta = wls(X, y, w);
  const yhat = X.map((xr) => xr.reduce((s, v, j) => s + v * beta[j]!, 0));
  console.log(`  ${label}: ` + cols.map((c, j) => `β_${c.name} ${fmt(beta[j + 1]!, 4)}`).join("  ") + `  | fit r ${fmt(corr(yhat, y), 3)}  predSD ${fmt(sd(yhat), 2)}`);
  return beta;
};
// ── wSB (steal value): tendency × ability is the real driver — test the interaction ──
console.log(`FIT wSB/600 (steal runs) — is it tendency, ability, or their interaction?`);
report("speed+tendency+ability     ", wsb, [{ name: "spe", x: cen.spe }, { name: "srTend", x: cen.sr }, { name: "stlAbil", x: cen.stl }]);
const inter = hit.map((_, i) => cen.sr[i]! * cen.stl[i]!);
report("+ tendency×ability         ", wsb, [{ name: "spe", x: cen.spe }, { name: "srTend", x: cen.sr }, { name: "stlAbil", x: cen.stl }, { name: "tend×abil", x: inter }]);

// ── RAW-SPACE steal model for WIRING (uncentered, so coeffs apply to raw ratings in woba.ts). The
//    product SR·STE/100 IS the tendency×ability driver; test whether raw main effects add anything. ──
console.log(`RAW-SPACE wSB/600 for wiring (product SR·STE/100 = tendency×ability):`);
const prod = hit.map((r, i) => (sr[i]! * stl[i]!) / 100);
const rawFit = (label: string, cols: { name: string; x: number[] }[]) => {
  const X = hit.map((_, i) => [1, ...cols.map((c) => c.x[i]!)]);
  const beta = wls(X, wsb, w);
  const yhat = X.map((xr) => xr.reduce((s, v, j) => s + v * beta[j]!, 0));
  console.log(`  ${label}: b0 ${fmt(beta[0]!, 3)}  ` + cols.map((c, j) => `b_${c.name} ${fmt(beta[j + 1]!, 5)}`).join("  ") + `  | r ${fmt(corr(yhat, wsb), 3)}`);
  return beta;
};
rawFit("speed + SR·STE/100        ", [{ name: "spe", x: spe }, { name: "prod", x: prod }]);
rawFit("speed + SR + SR·STE/100   ", [{ name: "spe", x: spe }, { name: "sr", x: sr }, { name: "prod", x: prod }]);
// WIRED FORM (speed drops out ≈0 — it already feeds UBR): steal value = b_sr·SR + b_int·(SR·STE/100).
const bSteal = rawFit("SR + SR·STE/100 (WIRED)   ", [{ name: "sr", x: sr }, { name: "prod", x: prod }]);
const stealVal = (srr: number, ste: number) => bSteal[1]! * srr + bSteal[2]! * (srr * ste / 100);
console.log(`  archetypes (runs/600, intercept dropped): high-tend high-abil(180/180) ${fmt(stealVal(180, 180), 2)}  |  high-tend LOW-abil(180/40) ${fmt(stealVal(180, 40), 2)}  |  low-tend high-abil(40/180) ${fmt(stealVal(40, 180), 2)}`);
console.log(`  breakeven ability STE = ${fmt(-bSteal[1]! / (bSteal[2]! / 100), 0)} (below ⇒ stealing LOSES value); a high-tend/LOW-abil runner nets negative.`);
console.log(`  WIRE → adv_stealRate ${fmt(bSteal[1]! * (WOBA_SCALE / 600), 7)}  adv_stealInt ${fmt(bSteal[2]! * (WOBA_SCALE / 600), 7)}  (× sbFreq·runVal at resolve)`);
// ── UBR (other baserunning) ──
console.log(`FIT UBR/600 (other baserunning):`);
report("speed+baserunning          ", ubr, [{ name: "spe", x: cen.spe }, { name: "run", x: cen.run }]);
// ── TOTAL with all four ratings (the value the model should carry) ──
console.log(`FIT total(wSB+UBR)/600 with ALL four ratings:`);
const betaTot = report("spe+tend+abil+run          ", tot, [{ name: "spe", x: cen.spe }, { name: "srTend", x: cen.sr }, { name: "stlAbil", x: cen.stl }, { name: "run", x: cen.run }]);
const yhatTot = hit.map((_, i) => betaTot[1]! * cen.spe[i]! + betaTot[2]! * cen.sr[i]! + betaTot[3]! * cen.stl[i]! + betaTot[4]! * cen.run[i]!);

// ── coeffs for scoring (runs/600 per rating pt → wOBA per rating pt). NOTE: STEAL VALUE needs BOTH
//    tendency (SR) and ability (STE); the current scoring model has only ONE steal input ("Stealing"
//    =ability) — a tendency term (adv_stealRate + w_stealRate) must be ADDED for a faithful fit. ──
const toWoba = (b: number) => b * (WOBA_SCALE / 600);
console.log(`\nSCORING COEFFS (runs/600 per pt → adv_* wOBA/pt; basic w_* = runs/600 per pt):`);
console.log(`  Speed:      β ${fmt(betaTot[1]!, 4)}  adv ${fmt(toWoba(betaTot[1]!), 6)}`);
console.log(`  StealRate:  β ${fmt(betaTot[2]!, 4)}  adv ${fmt(toWoba(betaTot[2]!), 6)}   ← TENDENCY (no scoring input today)`);
console.log(`  Stealing:   β ${fmt(betaTot[3]!, 4)}  adv ${fmt(toWoba(betaTot[3]!), 6)}   ← ability (current adv_steal)`);
console.log(`  Baserunning:β ${fmt(betaTot[4]!, 4)}  adv ${fmt(toWoba(betaTot[4]!), 6)}`);
console.log(`  value SPREAD added: pred baserunning SD ${fmt(sd(yhatTot) * RUNS600_TO_MWOBA, 1)} mwOBA; range ${fmt((Math.max(...yhatTot) - Math.min(...yhatTot)) * RUNS600_TO_MWOBA, 1)} mwOBA top-to-bottom.`);

// ── EXTERNAL CONFIRMATION vs cwhit (tools/cwhit-audit-deployed-hit.ts): obs total SD ≈ 2.93 runs/600;
//    Baserunning→UBR 0.93, Speed→UBR 0.89, Stealing→wSB 0.52. ──
console.log(`\nEXTERNAL (cwhit deep PA≥2000): obs total SD ≈ 2.93 runs/600; Baserunning→UBR 0.93, Speed→UBR 0.89, Stealing→wSB 0.52.`);
console.log(`League(2042 ALL) obs total SD ${fmt(sd(tot), 2)} runs/600 — ${Math.abs(sd(tot) - 2.93) < 1.2 ? "CONSISTENT with cwhit magnitude ✓" : "differs from cwhit — CHECK"}.`);
process.exit(0);
