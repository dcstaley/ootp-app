// VERIFICATION DEBT B.4 — direction-aware monotone-gate status per quad channel, AT POOL EXTREMES.
// B.1/B.2 found the WINNER's pitcher BB (rawquad) is the ONE non-monotone channel; the cap rescues it
// at scoring, but the cap is production-critical (four quad channels = four extrapolation surfaces).
// This locates each quad channel's VERTEX in rating units, asks whether the turn-over sits INSIDE the
// region tournament pools actually occupy (where the cap is load-bearing), and confirms the capped
// curve is sane (flat past the vertex, never reversing) across the full rating span the ladder spans.
//   run: node tools/phase1c-b4-monotone.ts
import { readFileSync, existsSync } from "node:fs";
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { type Model } from "../src/config/coeff-resolve.ts";
import { loadWindow, type TrainObs } from "../src/training/loader.ts";
import { PITCHER, HITTER } from "../src/training/bakeoff.ts";
import { fitPitForm, fitHitForm, RAWPOLY_HIT, STUFFAUG_PIT, type PitForm } from "../src/training/forms.ts";
import { rate, rateRaw, hRate, type FittedEvent } from "../src/model/curves.ts";
import { loadTournamentOutcomes, type TournamentObs } from "../src/training/tournament-eval.ts";
import { cleanTournamentRows } from "../src/eval/tournament-clean.ts";

const R2 = { kind: "rawpoly", degree: 2 } as const, LOGc = { kind: "log" } as const;
const MINN = 1000;
const repo = new Repository("data");
await seedDefaults(repo); await seedEras(repo); await seedAccounts(repo);
const state: any = (await repo.load<any>("state", "app")) ?? {};
const trained = (await repo.loadAll<any>("trained-models")).find((x) => x.id === state.activeModelId);
const win: number[] = Array.isArray(trained.window) && trained.window.length ? trained.window : [2041, 2042];
const lgObs = loadWindow("League Files", win).observations.filter((o: TrainObs) => (trained.includeVariants ?? true) || !o.variant);

const WINNER: PitForm = { ...(STUFFAUG_PIT as PitForm), name: "rawquad+aux", bb: R2, k: R2, hr: R2, h: R2, stuffAug: true };
const PARETO: PitForm = { ...(STUFFAUG_PIT as PitForm), name: "{HR,K,H} pareto", bb: LOGc, k: R2, hr: R2, h: R2, stuffAug: true };
const pit = fitPitForm(WINNER, lgObs);
const hit = fitHitForm(RAWPOLY_HIT, lgObs);

// Tournament-pool rating extremes per pit channel (where the cap must behave) across the ladder.
const poolRange: Record<string, [number, number]> = {};
for (const [dir] of [["Tournament Data/Quicks - Gold"], ["Tournament Data/Early Gold"], ["Tournament Data/Return of the Bronze"]] as const) {
  if (!existsSync(dir)) continue;
  const obs = loadTournamentOutcomes(dir, { clean: (rows) => cleanTournamentRows(rows).cleaned });
  for (const o of obs.filter((x: TournamentObs) => x.bf >= 100)) {
    for (const side of ["vR", "vL"] as const) for (const ch of ["con", "stu", "hrr", "pbabip"] as const) {
      const v = (o.ratings.pit[side] as any)[ch] as number; if (!(v > 0)) continue;
      const r = poolRange[ch] ?? [Infinity, -Infinity]; poolRange[ch] = [Math.min(r[0], v), Math.max(r[1], v)];
    }
  }
}

const domainRating = (e: FittedEvent): [number, number] => [e.mu + (e.uMin ?? 0) * e.sd, e.mu + (e.uMax ?? 0) * e.sd];
function report(name: string, e: FittedEvent, poolCh: string) {
  if (e.curve.kind !== "rawpoly" || e.curve.degree !== 2) { console.log(`  ${name.padEnd(12)} ${e.curve.kind} — monotone by construction`); return; }
  const b1 = e.beta[1] ?? 0, b2 = e.beta[2] ?? 0;
  const vertexU = Math.abs(b2) < 1e-12 ? Infinity : -b1 / (2 * b2);
  const vertexR = e.mu + vertexU * e.sd;
  const [dLo, dHi] = domainRating(e);
  const inDomain = vertexR > Math.min(dLo, dHi) && vertexR < Math.max(dLo, dHi);
  const pr = poolRange[poolCh];
  // Sample the CAPPED curve over the full ladder span + margin; flag any reversal (should be none).
  const lo = Math.min(dLo, dHi, pr ? pr[0] : dLo) - 5, hi = Math.max(dLo, dHi, pr ? pr[1] : dHi) + 10;
  let dir = 0, prev = rate(e, lo), capReverses = false, capEngageR = Infinity;
  for (let i = 1; i <= 300; i++) {
    const r = lo + ((hi - lo) * i) / 300, c = rate(e, r), u = rateRaw(e, r);
    if (Math.abs(c - u) > 1e-9 && r < capEngageR) capEngageR = r;
    const d = c - prev; if (Math.abs(d) > 1e-9) { const s = d > 0 ? 1 : -1; if (dir === 0) dir = s; else if (s !== dir) capReverses = true; }
    prev = c;
  }
  const dirWord = b2 < 0 ? "∩ rises→falls" : "∪ falls→rises";
  console.log(`  ${name.padEnd(12)} vertex≈${vertexR.toFixed(0)} (${dirWord}) domain[${dLo.toFixed(0)},${dHi.toFixed(0)}] vertex-in-domain=${inDomain}`);
  console.log(`  ${"".padEnd(12)} pool ${poolCh} range=[${pr ? pr[0].toFixed(0) + "," + pr[1].toFixed(0) : "n/a"}]  cap engages at rating≈${Number.isFinite(capEngageR) ? capEngageR.toFixed(0) : "never"}  capped-curve-reverses=${capReverses}`);
  if (pr) {
    const vertexInPool = vertexR > pr[0] && vertexR < pr[1];
    console.log(`  ${"".padEnd(12)} → vertex ${vertexInPool ? "INSIDE" : "outside"} the pool region; cap ${capEngageR < pr[1] ? "ACTIVE within pool span" : "engages only past pool max"}`);
  }
}

console.log(`B.4 MONOTONE-GATE at pool extremes — WINNER (rawquad+aux). Which quad channels turn over, and where?\n`);
console.log(`PITCHER quad channels (driven by: bb←con, k←stu, hr←hrr, h←pbabip):`);
report("bb (←con)", pit.bb, "con");
report("k  (←stu)", pit.k, "stu");
report("hr (←hrr)", pit.hr, "hrr");
// H is a FittedH (rating curve + separable BIP); sample the H-rate over the pbabip domain at a
// typical BIP=450, flag any reversal of the capped curve across the pool span + margin.
{
  const h = pit.h, pr = poolRange["pbabip"];
  if (h.rating.curve.kind !== "rawpoly" || h.rating.curve.degree !== 2) {
    console.log(`  h  (←pbabip) ${h.rating.curve.kind} — monotone by construction`);
  } else {
    const b1 = h.beta[1] ?? 0, b2 = h.beta[2] ?? 0, vU = Math.abs(b2) < 1e-12 ? Infinity : -b1 / (2 * b2);
    const vR = h.rating.mu + vU * h.rating.sd;
    const lo = (pr ? pr[0] : 20) - 5, hi = (pr ? pr[1] : 180) + 10;
    let dir = 0, prev = hRate(h, lo, 450), rev = false;
    for (let i = 1; i <= 300; i++) { const r = lo + ((hi - lo) * i) / 300, c = hRate(h, r, 450), d = c - prev; if (Math.abs(d) > 1e-9) { const s = d > 0 ? 1 : -1; if (dir === 0) dir = s; else if (s !== dir) rev = true; } prev = c; }
    const vertexInPool = pr ? vR > pr[0] && vR < pr[1] : false;
    console.log(`  h  (←pbabip) vertex≈${vR.toFixed(0)} (${b2 < 0 ? "∩" : "∪"}) pool pbabip=[${pr ? pr[0].toFixed(0) + "," + pr[1].toFixed(0) : "n/a"}] vertex-in-pool=${vertexInPool} capped-curve-reverses=${rev}`);
  }
}
console.log(`\nHITTER quad channel (HR←pow, production form RAWPOLY_HIT):`);
report("hr (←pow)", hit.hr, "");
console.log(`\nRead: a vertex OUTSIDE the pool region + cap engaging only past pool max = the quad is monotone where`);
console.log(`real cards live (cap is a pure tail-guard). A vertex INSIDE the pool region = the cap is load-bearing in`);
console.log(`production; capped-curve-reverses MUST be false (the cap flattens, never re-reverses). BB is the B.1/B.2 offender.`);
process.exit(0);
