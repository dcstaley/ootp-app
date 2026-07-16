// SP-4/SP-6 spike (THROWAWAY): prove HiGHS-WASM can solve a realistic roster +
// dual-lineup assignment MILP in-process, on the real scored pool, fast enough.
// This is the combinatorial core of M4: select N hitters AND assign each of the
// 9 lineup positions for BOTH the vL and vR lineups, maximizing total scoring
// value, with position eligibility from Learn flags. (Pitchers are a simpler
// pick-top-N-with-role-weights problem; not the bottleneck — excluded here.)
//
// Run: node tools/spike-highs.ts        Not app code; never imported by src/.

import { readFileSync } from "node:fs";
import highsLoader from "highs";
import { parseCatalogCsv, type Card } from "../src/data/catalog.ts";
import { buildEligiblePool } from "../src/config/eligibility.ts";
import { scoreCard, calibrate, computeDerived, type Coeffs } from "../src/scoring-core/index.ts";
import type { Tournament } from "../src/config/tournament.ts";

const TOURNAMENT: Tournament = {
  id: "spike", name: "spike", card_value_min: 60, card_value_max: 89, total_cap: 1858,
  roster_size: 26, hitters: 13, pitchers: 13, min_starters: 5, min_starter_stamina: 70, min_pitch_types: 3, dh: true,
  variants_allowed: true, max_variants_on_roster: 5,
  eraId: "", parkId: "", softcaps: {} as Tournament["softcaps"], eligibility: { mode: "ALL", rules: [] },
};

const POS: [string, string][] = [
  ["C", "LearnC"], ["1B", "Learn1B"], ["2B", "Learn2B"], ["3B", "Learn3B"],
  ["SS", "LearnSS"], ["LF", "LearnLF"], ["CF", "LearnCF"], ["RF", "LearnRF"],
];
const N_HITTERS = 13;
const n = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };

function loadCoeffs(): Coeffs {
  for (const c of ["real-parkera", "real-thr", "real-neutral", "_synthetic"]) {
    try { return JSON.parse(readFileSync(`fixtures/captures/${c}.json`, "utf8")).coeffs; } catch { /* next */ }
  }
  throw new Error("no capture found");
}

// Eligible positions for a card: each Learn{pos}===1, plus DH (open to all hitters).
function eligiblePositions(c: Card): string[] {
  const ps = POS.filter(([, col]) => n(c[col]) === 1).map(([p]) => p);
  return [...ps, "DH"];
}

interface Scored { id: string; vL: number; vR: number; pos: string[] }

function buildLp(pool: Scored[], nHitters: number): { lp: string; vars: number; cons: number } {
  const positions = [...POS.map(([p]) => p), "DH"];
  const objTerms: string[] = [];
  const yVars: string[] = [];
  const rosterVars = pool.map((c) => `r_${c.id}`);
  const perCardSide: Record<string, string[]> = {}; // key c|side -> y names
  const perPosSide: Record<string, string[]> = {};   // key pos|side -> y names

  for (const c of pool) {
    for (const side of ["L", "R"] as const) {
      const val = side === "L" ? c.vL : c.vR;
      for (const p of c.pos) {
        const y = `y_${c.id}_${p}_v${side}`;
        yVars.push(y);
        objTerms.push(`${val.toFixed(6)} ${y}`);
        (perCardSide[`${c.id}|${side}`] ??= []).push(y);
        (perPosSide[`${p}|${side}`] ??= []).push(y);
      }
    }
  }

  const cons: string[] = [];
  // Each position filled by exactly one card, each side.
  for (const side of ["L", "R"]) for (const p of positions) {
    const terms = perPosSide[`${p}|${side}`];
    if (terms?.length) cons.push(` fill_${p}_v${side}: ${terms.join(" + ")} = 1`);
  }
  // A card plays at most one position per side, and only if rostered.
  for (const c of pool) for (const side of ["L", "R"]) {
    const terms = perCardSide[`${c.id}|${side}`];
    if (terms?.length) cons.push(` cap_${c.id}_v${side}: ${terms.join(" + ")} - r_${c.id} <= 0`);
  }
  // Roster size (hitters).
  cons.push(` rsize: ${rosterVars.join(" + ")} = ${nHitters}`);
  // Backup catcher: at least two rostered cards can play C (coverage depth).
  const catchers = pool.filter((c) => c.pos.includes("C")).map((c) => `r_${c.id}`);
  if (catchers.length >= 2) cons.push(` backupC: ${catchers.join(" + ")} >= 2`);

  const lp = [
    "Maximize", ` obj: ${objTerms.join(" + ")}`,
    "Subject To", ...cons,
    "Binaries", ` ${[...yVars, ...rosterVars].join(" ")}`,
    "End",
  ].join("\n");
  return { lp, vars: yVars.length + rosterVars.length, cons: cons.length };
}

async function main() {
  const t0 = Date.now();
  const highs = await highsLoader({ locateFile: (f) => "node_modules/highs/build/" + f });
  console.log(`HiGHS-WASM loaded in ${Date.now() - t0}ms\n`);

  const coeffs = loadCoeffs();
  const derived = computeDerived(coeffs);
  const catalog = parseCatalogCsv(readFileSync("docs/pt_card_list.csv", "utf8"));
  const pool = buildEligiblePool(catalog.cards, TOURNAMENT);
  const calScales = calibrate(pool, { coeffs, derived });
  const cfg = { coeffs, derived, calScales };

  // Hitters = eligible cards that can field at least one non-DH position.
  const hitters: Scored[] = pool
    .map((c) => ({ card: c, posns: eligiblePositions(c) }))
    .filter((x) => x.posns.length > 1) // >1 means has a real position beyond DH
    .map(({ card, posns }) => {
      const s = scoreCard(card, cfg);
      return { id: String(s.cardId), vL: s.hit.offense_vL, vR: s.hit.offense_vR, pos: posns };
    });
  console.log(`Eligible fielding hitters: ${hitters.length}`);

  const scenarios: [string, Scored[]][] = [
    ["FULL eligible pool", hitters],
    ["decomposed: top 150 by value", [...hitters].sort((a, b) => Math.max(b.vL, b.vR) - Math.max(a.vL, a.vR)).slice(0, 150)],
    ["decomposed: top 60 by value", [...hitters].sort((a, b) => Math.max(b.vL, b.vR) - Math.max(a.vL, a.vR)).slice(0, 60)],
  ];

  for (const [label, p] of scenarios) {
    const { lp, vars, cons } = buildLp(p, N_HITTERS);
    const runs: number[] = [];
    let sol: ReturnType<typeof highs.solve> | null = null;
    for (let i = 0; i < 3; i++) { const s = Date.now(); sol = highs.solve(lp); runs.push(Date.now() - s); }
    const best = Math.min(...runs);
    const chosen = Object.entries(sol!.Columns).filter(([k, v]) => k.startsWith("r_") && (v as { Primal: number }).Primal > 0.5).length;
    console.log(`\n[${label}] pool=${p.length}  vars=${vars}  constraints=${cons}`);
    console.log(`  status=${sol!.Status}  objective=${(sol!.ObjectiveValue as number).toFixed(4)}  rostered=${chosen}`);
    console.log(`  solve times: ${runs.map((r) => r + "ms").join(", ")}  (best ${best}ms)`);
  }
}

main();
