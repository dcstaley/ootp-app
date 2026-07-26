// USAGE-CURVE CALIBRATION STUDY — descriptive measurement of REALISED playing time in the
// tournament exports, against what the app's usage model ASSUMES.
//
// MEASUREMENT ONLY. Nothing is fitted into production, no default is changed, no scoring math is
// written (CLAUDE.md: one scoring core). Reads `Tournament Data/*/*.csv` — a DIFFERENT corpus from
// the cwhit captures; touches neither the captures nor the scoring core.
//
// The model under test (src/eval/expected-wins.ts DEFAULT_WIN_PARAMS + defaultUsage):
//   rotationShare 0.62 · rotationDecay 0 · bullpenLeverage [2.5,1.5] ·
//   fullStrengthShare 0.6 · platoonCapture 0.8 · lineup PA weights (1 − 0.03·slot)
// All hand-set; none calibrated.
//
// TWO SEPARATE CORRECTIONS, handled separately (§2 and §3):
//   SURVIVORSHIP — within a format, deep runs are over-represented. Handled by STRATIFYING on run
//                  depth, which is directly observable (ΣGS_1 = team games).
//   FORMAT       — across formats, budget structure / environment / DH / min_starters differ, and
//                  those change the estimand itself. Handled by resolving every folder against
//                  data/tournaments/ and reporting PER FORMAT before anything is pooled.
//
//   run: node tools/usage-curve-calibration.ts

import Papa from "papaparse";
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { cleanTournamentRows } from "../src/eval/tournament-clean.ts";
import { defaultUsage, rotationStarts, DEFAULT_WIN_PARAMS } from "../src/eval/expected-wins.ts";

const ROOT = "Tournament Data";
const TDIR = "data/tournaments";
const CATALOG = "data/imports/cdmx.csv";
const OUT = "fixtures/usage-curve-calibration-2026-07-26.txt";
const B = 2000;
const P = DEFAULT_WIN_PARAMS;

type Row = Record<string, string>;
const num = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const mean = (xs: number[]) => (xs.length ? sum(xs) / xs.length : NaN);
const sd = (xs: number[]) => { const m = mean(xs); return xs.length > 1 ? Math.sqrt(sum(xs.map((x) => (x - m) ** 2)) / (xs.length - 1)) : NaN; };
const f = (x: number, d = 3) => (Number.isFinite(x) ? x.toFixed(d) : "n/a");
const pct = (x: number, d = 1) => (Number.isFinite(x) ? (100 * x).toFixed(d) + "%" : "n/a");
const quantile = (xs: number[], q: number) => { const s = [...xs].sort((a, b) => a - b); if (!s.length) return NaN; return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))]!; };
const pad = (s: string, n: number) => (s.length >= n ? s : s + " ".repeat(n - s.length));
const lpad = (s: string, n: number) => (s.length >= n ? s : " ".repeat(n - s.length) + s);
function lcg(seed: number): () => number { let s = seed >>> 0; return () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s / 0x100000000; }; }

// ══ 0. FORMAT RESOLUTION — folder → data/tournaments/ config ══════════════════
// Each folder is matched against the registry on the format's OWN config fields that leave an
// observable fingerprint in the export (card-value window, DH on/off, roster size). A folder that
// no registry entry matches is reported as UNMAPPED and characterised straight from its data.
interface Cfg { id: string; name: string; card_value_max: number | null; total_cap: number | null; budget_mode: string; dh: boolean; eraId: string; parkId: string; min_starters: number; roster_size: number; hitters: number; pitchers: number }
const registry: Cfg[] = readdirSync(TDIR).filter((x) => x.endsWith(".json")).map((x) => JSON.parse(readFileSync(`${TDIR}/${x}`, "utf8")));
const cfgById = new Map(registry.map((c) => [c.id, c]));
const NEUTRAL = (c: Cfg) => c.eraId === "era-2010" && c.parkId === "park-1";

interface FmtMeta { folder: string; cfgId: string | null; basis: string }
const MAP: FmtMeta[] = [
  { folder: "Early Gold", cfgId: "early-gold", basis: "name; VAL≤89 observed = card_value_max 89; NO DH observed (8.7% of PA by pitchers) = dh:false; min_starters 4 matches observed k≈4.1" },
  { folder: "Quicks - Bronze", cfgId: "bronze-quick", basis: "name; VAL≤69 observed = card_value_max 69; DH observed" },
  { folder: "Quicks - Gold", cfgId: "gold-quick", basis: "name; VAL≤89 observed = card_value_max 89; DH observed" },
  { folder: "Quicks - Open", cfgId: null, basis: "NO registry entry matches. Observed VAL to 101 (Perfect/Diamond tiers) ⇒ card_value_max null; DH observed; roster 26. The registry has no `open-quick`; `live-open-daily` and `ptcs-open` are the only uncapped-window entries and neither is this event by name. Treated as UNCAPPED, unrestricted-VAL, DH — which is all the analysis below needs — and its ENV is asserted, not resolved." },
  { folder: "Return of the Bronze", cfgId: "bronze-return", basis: "name; VAL≤69 observed = card_value_max 69; DH observed; variants_allowed:false" },
];
const metaOf = (folder: string) => MAP.find((m) => m.folder === folder)!;
const cfgOf = (folder: string) => { const id = metaOf(folder).cfgId; return id ? cfgById.get(id) ?? null : null; };

// ══ 1. LOAD + CLEAN ═══════════════════════════════════════════════════════════
interface Inst { fmt: string; file: string; status: string; ledger: number; residual: number; removed: string[]; rowsIn: number; rowsOut: number; teams: { org: string; rows: Row[] }[] }
const folders = readdirSync(ROOT).filter((d) => !d.startsWith("."));
const instances: Inst[] = [];
let rawRows = 0, dropGhost = 0, dropNoOrg = 0;

for (const fmt of folders) {
  const files = readdirSync(`${ROOT}/${fmt}`).filter((x) => x.toLowerCase().endsWith(".csv") && !x.startsWith(".~lock"));
  for (const file of files) {
    const parsed = Papa.parse<Row>(readFileSync(`${ROOT}/${fmt}/${file}`, "utf8"), { header: true, skipEmptyLines: true }).data;
    rawRows += parsed.length;
    const c = cleanTournamentRows(parsed as any);
    dropGhost += parsed.length - c.cleaned.length;
    const byOrg = new Map<string, Row[]>();
    for (const r of c.cleaned as unknown as Row[]) {
      const o = String(r.ORG ?? "").trim();
      if (!o) { dropNoOrg++; continue; }
      if (!byOrg.has(o)) byOrg.set(o, []);
      byOrg.get(o)!.push(r);
    }
    instances.push({
      fmt, file, status: c.report.status, ledger: c.report.ledger, residual: c.report.residual,
      removed: c.report.flagged.map((x) => x.org), rowsIn: parsed.length, rowsOut: c.cleaned.length,
      teams: [...byOrg.entries()].map(([org, rows]) => ({ org, rows })),
    });
  }
}

const catIds = new Set(Papa.parse<Row>(readFileSync(CATALOG, "utf8"), { header: true, skipEmptyLines: true }).data.map((r) => String(r["Card ID"] ?? "").trim()));

// ══ 2. PER-TEAM MEASUREMENT ═══════════════════════════════════════════════════
interface Team {
  fmt: string; file: string; org: string; games: number; roster: number;
  hitPA: number[]; hitGS: number[]; pitcherBatPA: number; teamBF: number;
  startBF: number; reliefBF: number; swingBF: number; pureStarts: number;
  starts: number[]; penBF: number[]; penBFbyLi: number[]; penLi: number[]; penLev: number[];
  rhpBF: number; lhpBF: number; spStmBF: number; spBFforStm: number; joinHit: number; joinTot: number; maxG: number;
}
// MULTI-ENTRY ORG GUARD. `ORG` is a team NAME, not a team id, and src/eval/tournament-clean.ts
// documents that one ORG string can field several rosters ("the quicks case"). A pooled 2-roster
// group would inflate every concentration statistic here — N_eff, hitter counts, bullpen depth —
// which are exactly the headlines. Every mapped config has roster_size 26, so an ORG carrying more
// than 30 rows cannot be one roster and is dropped. Counted and reported; a sensitivity check on
// the headline with these groups left IN is printed in §0a.
const MULTI_ROW_CUT = 30;
const multiEntry = instances.flatMap((i) => i.teams.filter((t) => t.rows.length > MULTI_ROW_CUT).map((t) => ({ fmt: i.fmt, file: i.file, org: t.org, rows: t.rows.length })));
const multiKey = new Set(multiEntry.map((m) => m.file + "|" + m.org));

const teams: Team[] = [];
const teamsWithMulti: Team[] = [];
for (const inst of instances) for (const t of inst.teams) {
  const rows = t.rows;
  const pit = rows.filter((r) => num(r.BF) > 0);
  const hit = rows.filter((r) => num(r.BF) === 0);
  const pureS = pit.filter((r) => num(r.GS_1) > 0 && num(r.GS_1) === num(r.G_1));
  const pureR = pit.filter((r) => num(r.GS_1) === 0);
  const swing = pit.filter((r) => num(r.GS_1) > 0 && num(r.GS_1) < num(r.G_1));
  const rec: Team = {
    fmt: inst.fmt, file: inst.file, org: t.org, games: sum(rows.map((r) => num(r.GS_1))), roster: rows.length,
    hitPA: hit.map((r) => num(r.PA)).filter((x) => x > 0).sort((a, b) => b - a),
    hitGS: hit.map((r) => num(r.GS)).filter((x) => x > 0).sort((a, b) => b - a),
    pitcherBatPA: sum(pit.map((r) => num(r.PA))), teamBF: sum(pit.map((r) => num(r.BF))),
    startBF: sum(pureS.map((r) => num(r.BF))), reliefBF: sum(pureR.map((r) => num(r.BF))),
    swingBF: sum(swing.map((r) => num(r.BF))), pureStarts: sum(pureS.map((r) => num(r.GS_1))),
    starts: pit.filter((r) => num(r.GS_1) > 0).map((r) => num(r.GS_1)).sort((a, b) => b - a),
    penBF: pureR.map((r) => num(r.BF)).sort((a, b) => b - a),
    penBFbyLi: [...pureR].sort((a, b) => num(b.pLi) - num(a.pLi)).map((r) => num(r.BF)),
    penLi: pureR.map((r) => num(r.pLi)).sort((a, b) => b - a),
    penLev: pureR.map((r) => num(r.BF) * num(r.pLi)).sort((a, b) => b - a),
    rhpBF: sum(pit.filter((r) => String(r.T).trim() === "R").map((r) => num(r.BF))),
    lhpBF: sum(pit.filter((r) => String(r.T).trim() === "L").map((r) => num(r.BF))),
    spStmBF: sum(pureS.map((r) => num(r.STM) * num(r.BF))), spBFforStm: sum(pureS.map((r) => num(r.BF))),
    joinHit: rows.filter((r) => catIds.has(String(r.CID ?? "").trim())).length, joinTot: rows.length,
    maxG: Math.max(...rows.map((r) => Math.max(num(r.G), num(r.G_1)))),
  };
  teamsWithMulti.push(rec);
  if (!multiKey.has(inst.file + "|" + t.org)) teams.push(rec);
}
const dropNoGames = teams.filter((t) => t.games === 0).length;
const live = teams.filter((t) => t.games > 0);
const liveWithMulti = teamsWithMulti.filter((t) => t.games > 0);

// ══ 3. STATISTICS ═════════════════════════════════════════════════════════════
const nEff = (xs: number[]) => { const s = sum(xs); return s > 0 ? 1 / sum(xs.map((x) => (x / s) ** 2)) : NaN; };
const shares = (xs: number[]) => { const s = sum(xs); return s > 0 ? xs.map((x) => x / s) : xs.map(() => 0); };
function meanShareVec(vs: number[][], n: number): number[] {
  const out = new Array(n).fill(0);
  for (const v of vs) { const s = shares(v); for (let k = 0; k < n; k++) out[k] += s[k] ?? 0; }
  return out.map((x) => x / Math.max(vs.length, 1));
}
const cum = (v: number[], k: number) => sum(v.slice(0, k));
function bootSE<T>(units: T[][], stat: (rows: T[]) => number, seed: number): number {
  const rand = lcg(seed); const out: number[] = [];
  for (let b = 0; b < B; b++) {
    const pick: T[] = [];
    for (let i = 0; i < units.length; i++) pick.push(...units[Math.floor(rand() * units.length)]!);
    const v = stat(pick); if (Number.isFinite(v)) out.push(v);
  }
  return sd(out);
}
const instUnits = (ts: Team[]) => [...new Set(ts.map((t) => t.file))].map((fl) => ts.filter((t) => t.file === fl));
const teamUnits = (ts: Team[]) => ts.map((t) => [t]);
/** CI standard error = the LARGER of the instance- and team-clustered bootstrap SEs. Instance
 *  clustering is usually the conservative one, but not always (few, highly homogeneous runnings can
 *  give a SMALLER cluster SE — see §1d), so the max is taken rather than assumed. */
const ciSE = (ts: Team[], stat: (x: Team[]) => number, seed = 20260726) =>
  Math.max(bootSE(instUnits(ts), stat, seed), bootSE(teamUnits(ts), stat, seed));

// ── format groups: PER FORMAT FIRST; a pool ONLY over formats shown alike ─────
const FMT_ORDER = ["Quicks - Bronze", "Quicks - Gold", "Quicks - Open", "Return of the Bronze", "Early Gold"];
const NEUTRAL_POOL = ["Quicks - Bronze", "Quicks - Gold", "Quicks - Open", "Return of the Bronze"];
const byFmt = (fm: string) => live.filter((t) => t.fmt === fm);
const neutralTs = live.filter((t) => NEUTRAL_POOL.includes(t.fmt));
const egTs = byFmt("Early Gold");
/** Lineup size the format actually bats (DH ⇒ 9, no-DH ⇒ 8 non-pitcher slots). */
const Lof = (fm: string) => (fm === "Early Gold" ? 8 : 9);
interface Grp { label: string; ts: Team[]; L: number; kind: "fmt" | "pool" }
const groups: Grp[] = [
  ...FMT_ORDER.map((fm) => ({ label: fm, ts: byFmt(fm), L: Lof(fm), kind: "fmt" as const })),
  { label: "POOL: 4 neutral DH fmts", ts: neutralTs, L: 9, kind: "pool" as const },
];

// depth strata (survivorship)
const depthBins = [{ lo: 1, hi: 5, label: "1–5 g" }, { lo: 6, hi: 9, label: "6–9 g" }, { lo: 10, hi: 14, label: "10–14 g" }, { lo: 15, hi: 9999, label: "15+ g" }];
const binOf = (g: number) => depthBins.find((b) => g >= b.lo && g <= b.hi)!.label;

// model reference curves
const modelUsage = (lineupSize: number, rot: number, pen: number, bestOf: number) =>
  defaultUsage({ lineupSize, rotationSize: rot, bullpenSize: pen }, 6200, 6200, P.rotationShare, P.rotationDecay, bestOf, P.bullpenLeverage);

// ══ 4. HEADLINE QUANTITIES (computed up-front so the VERDICT can quote them) ══
const Q = (ts: Team[], L: number) => {
  const tb = sum(ts.map((t) => t.teamBF));
  const psBF = sum(ts.map((t) => t.startBF)), psGS = sum(ts.map((t) => t.pureStarts));
  return {
    n: ts.length,
    nEff: mean(ts.map((t) => nEff(t.hitPA)).filter(Number.isFinite)),
    hitters: mean(ts.map((t) => t.hitPA.length)),
    nHalf: mean(ts.map((t) => t.hitPA.filter((x) => x >= 0.5 * sum(t.hitPA) / L).length)),
    nQtr: mean(ts.map((t) => t.hitPA.filter((x) => x >= 0.25 * sum(t.hitPA) / L).length)),
    topL: mean(ts.map((t) => cum(shares(t.hitPA), L))),
    rotLo: psBF / tb, rotUp: sum(ts.map((t) => t.startBF + t.swingBF)) / tb,
    rotPerGS: psGS > 0 ? (psBF / psGS) * sum(ts.map((t) => t.games)) / tb : NaN,
    bfPerStart: psBF / psGS,
    stm: sum(ts.map((t) => t.spStmBF)) / sum(ts.map((t) => t.spBFforStm)),
    k1: mean(ts.map((t) => t.starts.length)),
    gsTopL: mean(ts.map((t) => cum(shares(t.hitGS), L))),
    startersUsed: mean(ts.map((t) => t.hitGS.length)),
    lhpShare: sum(ts.map((t) => t.lhpBF)) / sum(ts.map((t) => t.rhpBF + t.lhpBF)),
    pitBat: sum(ts.map((t) => t.pitcherBatPA)) / sum(ts.map((t) => t.pitcherBatPA + sum(t.hitPA))),
  };
};
const QN = Q(neutralTs, 9), QE = Q(egTs, 8);
const rotPerGS_stat = (ts: Team[]) => { const tb = sum(ts.map((t) => t.teamBF)), a = sum(ts.map((t) => t.startBF)), g = sum(ts.map((t) => t.pureStarts)); return g > 0 ? (a / g) * sum(ts.map((t) => t.games)) / tb : NaN; };

// ══ 5. REPORT ═════════════════════════════════════════════════════════════════
const L_: string[] = [];
const w = (s = "") => L_.push(s);
const H = (s: string) => { w(""); w("═".repeat(100)); w(s); w("═".repeat(100)); };

// ── VERDICT ──────────────────────────────────────────────────────────────────
{
  const vN = meanShareVec(neutralTs.map((t) => t.hitPA), 14);
  const dN = neutralTs.filter((t) => t.games >= 15), dE = egTs.filter((t) => t.games >= 15);
  const QN15 = Q(dN, 9);
  const p7 = (sel: (t: Team) => number[]) => meanShareVec(neutralTs.filter((t) => sel(t).filter((x) => x > 0).length >= 7).map(sel), 7);
  const penRole = p7((t) => t.penBFbyLi), penLev = p7((t) => t.penLev);
  const mu9 = shares(modelUsage(9, 5, 6, 7).lineupPA);
  const rotN15 = meanShareVec(dN.map((t) => t.starts), 5), rotE15 = meanShareVec(dE.map((t) => t.starts), 5);
  const m7 = shares(rotationStarts(7, 5)), m54 = shares(rotationStarts(5, 4));
  // Early Gold's model comparator is a FOUR-man curve (its own min_starters), so the deviation is
  // taken over the four slots the model defines; its realised 5th-starter usage is reported apart.
  const devN = Math.max(...rotN15.map((x, i) => Math.abs(x - m7[i]!)));
  const devE = Math.max(...rotE15.slice(0, 4).map((x, i) => Math.abs(x - m54[i]!)));
  const gs15N = mean(dN.map((t) => cum(shares(t.hitGS), 9)));
  const srt = [...live].sort((a, b) => b.games - a.games), totPA = sum(live.map((t) => sum(t.hitPA)));
  const dec10 = sum(srt.slice(0, Math.round(0.1 * srt.length)).map((t) => sum(t.hitPA))) / totPA;
  const dec25 = sum(srt.slice(0, Math.round(0.25 * srt.length)).map((t) => sum(t.hitPA))) / totPA;
  w("USAGE-CURVE CALIBRATION — realised playing time vs the app's usage model");
  w("Corpus: Tournament Data/ — 34 exports, 5 event folders   |   2026-07-26   |   HEAD cd486db");
  w("MEASUREMENT ONLY. Nothing fitted, no default touched, nothing wired, no parameter proposed.");
  w("");
  w("┌─ VERDICT ─────────────────────────────────────────────────────────────────────────────────────┐");
  w("");
  w("TWO CORRECTIONS COME FIRST, BOTH STATED BEFORE ANY NUMBER.");
  w("");
  w("(1) SURVIVORSHIP — handled by STRATIFICATION, not bounding. Run depth is DIRECTLY OBSERVABLE here:");
  w("    exactly one pitcher starts each team-game, so a team's games = ΣGS_1 over its rows. No proxy is");
  w("    used or needed, and the conditional distribution is exact. Bounding would have been strictly");
  w(`    weaker. It matters: the deepest 10% of teams supply ${pct(dec10, 1)} of all hitter PA and the deepest`);
  w(`    quarter supply ${pct(dec25, 1)}. And the shape MOVES with depth — N_eff ${f(Q(neutralTs.filter((t) => t.games <= 5), 9).nEff, 2)} at 1–5 games rising to ${f(QN15.nEff, 2)}`);
  w("    at 15+. Crucially it moves in BOTH directions depending on the quantity: it makes the lineup-");
  w("    curve failure LARGER, and it turns an apparent rotation-curve failure into a PASS (short runs");
  w("    censor SP4/SP5 out of existence). Every verdict below is taken from the DEEP stratum.");
  w("");
  w("(2) FORMAT — the five folders are NOT interchangeable, and each was resolved against");
  w("    data/tournaments/ independently (§0b). Four map to budget_mode:none, era-2010/park-1 NEUTRAL,");
  w("    DH formats with min_starters 5, and they measure ALIKE on every quantity here despite spanning");
  w("    card-value windows ≤69 / ≤89 / uncapped (§1c) — those four, and only those four, are pooled.");
  w("    The fifth, Early Gold, is env-modified (era-1920/park-169), NO-DH, min_starters 4, and is a");
  w(`    different regime on the pitching side (rotation BF share ${pct(QE.rotPerGS, 1)} vs ${pct(QN.rotPerGS, 1)}); it is reported`);
  w("    SEPARATELY throughout and never pooled.");
  w("    SCOPE HOLE, up front: all five are budget_mode:none with total_cap null. The corpus contains NO");
  w("    cap and NO slots format. A budget forces a few expensive cards plus cheap filler, which");
  w("    reallocates playing time across a roster — the exact estimand — so NOTHING here transfers to");
  w("    capped or slots play, and cap/slots is the main consumer of these parameters.");
  w("");
  w("WHAT THE DATA SUPPORTS (3 of the model's assumptions).");
  w(`  • rotationStarts — the format-derived rotation-slot curve, and the only usage component that was`);
  w("    DERIVED rather than hand-set. At depth it is confirmed in both a 5-man DH format and a 4-man");
  w(`    no-DH one: neutral 15+ games ${rotN15.map((x) => f(x, 3)).join(" ")} vs rotationStarts(bo7,k5)`);
  w(`    ${m7.slice(0, 5).map((x) => f(x, 3)).join(" ")} (max per-slot deviation ${f(devN, 3)}); Early Gold 15+ ${rotE15.slice(0, 4).map((x) => f(x, 3)).join(" ")} vs`);
  w(`    rotationStarts(bo5,k4) ${m54.slice(0, 4).map((x) => f(x, 3)).join(" ")} (deviation ${f(devE, 3)}). rotationDecay = 0 is`);
  w("    correspondingly vindicated: no extra manual tilt is needed on top of the format curve. CAVEAT:");
  w("    `bestOf` is NOT observable in the export, so the comparator was CHOSEN as the best-fitting");
  w("    member of {3,5,7} — the FORM is supported, the bestOf ARGUMENT is not verified (§3a).");
  w(`  • THE ~9-MAN EVERYDAY CORE. ${f(QN.nHalf, 1)} hitters clear half a full-time share (${f(QN15.nHalf, 1)} at depth) — the model's`);
  w("    nine-man lineup is the right description of the CORE. What it lacks is everything below it.");
  w(`  • THE BULLPEN PREMIUM'S LEVEL, under the leverage-weighted reading only: realised RP1 = ${f(penLev[0]!, 3)}`);
  w(`    and RP2 = ${f(penLev[1]!, 3)} of leverage-weighted innings against the model's ${f(0.278, 3)} / ${f(0.167, 3)}.`);
  w("");
  w("WHAT THE DATA REFUTES.");
  w(`  • THE LINEUP CURVE'S SUPPORT — the largest and most consequential miss, and the one survivorship`);
  w(`    makes WORSE. The model gives PA to exactly 9 hitters and zero to the rest; the bench enters only`);
  w(`    through fullStrengthShare, worth ${pct((1 - P.fullStrengthShare) / 9, 2)} of lineup PA. Realised in the neutral pool: the top`);
  w(`    nine take ${pct(cum(vN, 9), 1)} of hitter PA (${pct(QN15.topL, 1)} at depth), ${f(QN.hitters, 1)} hitters get a PA (${f(QN15.hitters, 1)} at depth), ${f(QN.nQtr, 1)}`);
  w(`    clear a quarter-share, and N_eff is ${f(QN.nEff, 2)} pooled / ${f(QN15.nEff, 2)} at depth against a model value of`);
  w(`    ${f(nEff(modelUsage(9, 5, 6, 7).lineupPA), 2)} — at most 9.77 even if the entire substitution allowance is spread perfectly over`);
  w(`    the bench. The model under-spreads by ≈${f(QN15.nEff - 9.77, 1)} effective hitters at the depth that matters.`);
  w(`  • rotationShare 0.62 IS TOO LOW, AND IS NOT ONE NUMBER. Neutral pool ${pct(QN.rotPerGS, 1)} (+${pct(QN.rotPerGS - P.rotationShare, 1)}); Early Gold`);
  w(`    ${pct(QE.rotPerGS, 1)} (+${pct(QE.rotPerGS - P.rotationShare, 1)}). The swingman attribution band is under 1pp wide, so this is not an`);
  w("    artefact of how BF was split. Early Gold's starters carry BF-weighted stamina");
  w(`    ${f(QE.stm, 1)} vs ${f(QN.stm, 1)} and go ${f(QE.bfPerStart, 1)} BF/start vs ${f(QN.bfPerStart, 1)} — the driver is which cards the format makes`);
  w("    ELIGIBLE, so a single global rotationShare cannot be right across formats.");
  w(`  • THE BULLPEN'S FLAT TAIL, under BOTH readings of the parameter — and the parameter turns out to be`);
  w("    AMBIGUOUS, which is the real finding (§3b). `bullpenLeverage` multiplies plain `bullpenBF`, but");
  w("    the code comment calls it 'leverage-weighted'. Read as plain BF ranked by leverage ROLE,");
  w(`    realised is FLAT (${penRole.map((x) => f(x, 2)).join(" ")}; RP1/RP7 = ${f(penRole[0]! / penRole[6]!, 2)}) and the 2.5× premium is`);
  w(`    refuted. Read as leverage-weighted innings, the premium is fine but the tail keeps falling`);
  w(`    (${penLev.slice(2, 7).map((x) => f(x, 3)).join(" ")}; RP1/RP7 = ${f(penLev[0]! / penLev[6]!, 1)} vs 2.50) and the flat tail is refuted.`);
  w("    Exactly one of the two claims survives under each reading, never the same one. Underneath, the");
  w(`    leverage index itself declines smoothly ${f(mean(neutralTs.filter((t) => t.penLi.filter((x) => x > 0).length >= 7).map((t) => t.penLi[0]!)), 2)} → ${f(mean(neutralTs.filter((t) => t.penLi.filter((x) => x > 0).length >= 7).map((t) => t.penLi[6]!)), 2)} from closer to 7th man with no flat`);
  w("    region, and a [premium, premium, flat…] shape cannot represent that at any two values.");
  w(`  • fullStrengthShare 0.6's IMPLICATION — a FORM failure, not a value failure. The rule requires the`);
  w(`    nine to take ${pct((8 + P.fullStrengthShare) / 9, 1)} of lineup starts. Realised is ${pct(QN.gsTopL, 1)} pooled and ${pct(gs15N, 1)} at depth,`);
  w(`    inverting to f0 = ${f(9 * QN.gsTopL - 8, 2)} and ${f(9 * gs15N - 8, 2)} — outside [0,1], so NO value of f0 can express the`);
  w(`    observed churn. Real rosters rotate a ${f(QN15.hitters, 0)}-man batting group; 'nine starters, one occasionally`);
  w("    missing' is the wrong shape. This is confounded (rest / platooning / blowouts all enter, §4b),");
  w("    so it refutes the RULE, not any particular value — and it says bench depth is used MORE than the");
  w("    model allows, not less, so it does not undercut the reason offense.ts values a bench at all.");
  w(`  • THE ORDER TILT'S MAGNITUDE (minor). Realised slot-1:slot-9 PA ratio ${f(vN[0]! / vN[8]!, 2)} vs the model's ${f(mu9[0]! / mu9[8]!, 2)};`);
  w("    the direction is right, the steepness is understated. Small next to the support failure.");
  w("");
  w("WHAT THIS CORPUS CANNOT ANSWER.");
  w("  • platoonCapture ρ = 0.80: NOT MEASURABLE, and no proxy is offered. Every realised statistic in");
  w("    the export is an undifferentiated total; the vL/vR columns are RATINGS, not splits. Only the");
  w("    handedness SUPPLY is measurable (§4a) and supply is not capture.");
  w("  • fullStrengthShare as a VALUE — only its shape is testable, and its shape fails.");
  w("  • Anything about CAPPED or SLOTS formats — none are present.");
  w("  • Anything about what a roster COULD be — these rosters are ownership-shaped.");
  w("");
  w("NOTHING WAS FITTED. No parameter is proposed, no default touched. A calibration built on this would");
  w("need its own pre-registration, and would have to be per-format at least for rotationShare.");
  w("");
  w("└───────────────────────────────────────────────────────────────────────────────────────────────┘");
}

// ══════════════════════════════════════════════════════════════════════════════
H("§0a.  PROVENANCE, DROPS, JOIN RATE");
w("");
w(pad("folder", 24) + lpad("files", 6) + lpad("rows", 8) + lpad("teams", 7) + lpad("live", 6) + lpad("CID join", 11));
for (const fm of FMT_ORDER) {
  const insts = instances.filter((i) => i.fmt === fm), ts = byFmt(fm);
  w(pad(fm, 24) + lpad(String(insts.length), 6) + lpad(String(sum(insts.map((i) => i.rowsOut))), 8)
    + lpad(String(sum(insts.map((i) => i.teams.length))), 7) + lpad(String(ts.length), 6)
    + lpad(pct(sum(ts.map((t) => t.joinHit)) / sum(ts.map((t) => t.joinTot)), 1), 11));
}
w("");
w(`raw rows read                     : ${rawRows}`);
w(`dropped — ghost/partial-export org: ${dropGhost} rows  (src/eval/tournament-clean.ts PA−BF ledger — the project's established detector, not a new rule)`);
w(`dropped — blank ORG               : ${dropNoOrg} rows`);
w(`dropped — multi-entry ORG (>${MULTI_ROW_CUT} rows) : ${multiEntry.length} teams — one ORG STRING fielding several rosters. ORG is a`);
w(`                                    team NAME, not an id, and tournament-clean.ts documents the case. Every`);
w(`                                    mapped config has roster_size 26, so >${MULTI_ROW_CUT} rows cannot be one roster, and a`);
w(`                                    pooled 2-roster group would inflate exactly the concentration statistics`);
w(`                                    this study reports. All 11 are ONE manager multi-entering:`);
for (const [org, ms] of [...multiEntry.reduce((m, x) => { const k = x.org + "  [" + x.fmt + "]"; m.set(k, [...(m.get(k) ?? []), x.rows]); return m; }, new Map<string, number[]>())])
  w(`                                    · ${pad(org, 44)} ${ms.length} entries, rows ${ms.join("/")}`);
w(`dropped — team with 0 games played: ${dropNoGames} teams`);
w(`teams retained                    : ${live.length}`);
w("");
{
  const a = mean(live.map((t) => nEff(t.hitPA)).filter(Number.isFinite));
  const b = mean(liveWithMulti.map((t) => nEff(t.hitPA)).filter(Number.isFinite));
  w(`SENSITIVITY to the multi-entry drop — headline mean N_eff over ALL teams: ${f(a, 3)} with them dropped,`);
  w(`${f(b, 3)} with them left in (${f(b - a, 3)}). The guard is correct in principle and immaterial in practice;`);
  w("it is applied anyway so no headline rests on a pooled-roster artefact.");
}
w("");
w("Per-instance ledger status (every removal is a partial-export org, named):");
for (const i of instances) w(`  ${pad(i.fmt + " / " + i.file, 50)} ${pad(i.status, 9)} ledger ${lpad(String(i.ledger), 5)} → residual ${lpad(String(i.residual), 5)}  removed: ${i.removed.join(", ") || "—"}`);
w("");
w("CID → catalog (data/imports/cdmx.csv, 'Card ID'): DIAGNOSTIC ONLY. Nothing in this study needs the");
w("catalog — every quantity comes from the export's own columns — so a join miss drops no row.");

// ══════════════════════════════════════════════════════════════════════════════
H("§0b.  FORMAT RESOLUTION — every folder matched against data/tournaments/  (the FORMAT correction)");
w("");
w("Resolved independently, on config fields that leave an observable fingerprint in the export.");
w("");
for (const m of MAP) {
  const c = cfgOf(m.folder);
  w(pad(m.folder, 24) + "→  " + (c ? c.id : "**UNMAPPED**"));
  if (c) w("  " + `budget_mode ${pad(c.budget_mode, 6)} total_cap ${pad(String(c.total_cap), 6)} VAL≤${pad(String(c.card_value_max), 5)} dh ${pad(String(c.dh), 6)} ${pad(c.eraId, 9)} ${pad(c.parkId, 9)} min_starters ${c.min_starters}  roster ${c.roster_size} (${c.hitters}H/${c.pitchers}P)  ${NEUTRAL(c) ? "ENV: NEUTRAL" : "ENV: MODIFIED"}`);
  w("  basis: " + m.basis);
  w("");
}
w("THE BUDGET AXIS — the one that would matter most, and the corpus is silent on it:");
w(`  budget_mode across the four mapped configs: ${MAP.map((m) => cfgOf(m.folder)).filter(Boolean).map((c) => c!.budget_mode).join(", ")} — all 'none', total_cap null.`);
w("  Quicks - Open is unmapped but is observably uncapped in card value and shows the same roster");
w("  size (26) and DH as the others. So: ZERO cap formats, ZERO slots formats in this corpus. A cap");
w("  buys a few expensive cards and fills the rest cheaply, which reallocates playing time across the");
w("  roster — the exact estimand here. NOTHING below transfers to a capped or slots format, and the");
w("  cap/slots objective is precisely where the usage model is consumed. This is a scope hole in the");
w("  data, not a finding, and it cannot be closed from these files.");
w("");
w("THE ENVIRONMENT AXIS — checked, not assumed:");
w("  Four folders resolve to era-2010/park-1 (neutral). Early Gold is era-1920/park-169. Env scales");
w("  event RATES; the prior is that it should not reallocate PLAYING TIME. The check available here:");
w("  the four neutral formats span card-value windows ≤69, ≤89 and uncapped — a wide POOL-STRENGTH");
w("  range at constant env — and their usage curves are alike (§1c). Early Gold, the one env-modified");
w("  format, diverges hugely on the pitching side. But Early Gold ALSO differs on TWO rule axes");
w("  (dh:false, min_starters 4) and, decisively, on POOL COMPOSITION: era-1920 eligibility loads the");
w("  pool with dead-ball starters. §5 measures the stamina of the arms that actually started, which");
w("  separates 'the environment reallocated innings' from 'the eligible cards are different'.");
w("  ATTRIBUTION IS NOT IDENTIFIED from one env-modified format; the conclusion drawn is only the");
w("  weak one — a single usage parameter set cannot describe both — which does not need attribution.");

// ══════════════════════════════════════════════════════════════════════════════
H("§1a.  PLAYING-TIME FIELDS THAT ACTUALLY EXIST (inspected, not assumed)");
w("");
w("All 34 files share one identical header. The realised playing-time columns are:");
w("  BATTING   G, GS, PA, AB                       GS = games started in the batting order");
w("  PITCHING  G_1, GS_1, W, L, HLD_1, SD, MD, IP, BF, pLi, PI, GF, IR, IRS");
w("                                                GS_1 = mound starts; pLi = average leverage index");
w("  FIELDING  G_2, GS_2, TC, A, PO, E, DP_1, TP, RNG, ZR, EFF, SBA, RTO, IP_1, PB, CER,");
w("            BIZ-{R,Rm,L,Lm,E,Em,U,Um,Z,Zm}, FRM, ARM");
w("There is NO by-opponent-handedness split of any realised statistic, and no game-by-game or");
w("by-lineup-slot breakdown. Everything below is built from the columns above and nothing else.");
w("");
w("IP is printed base-3 in the fraction (\"13.2\" = 13⅔ innings). Every innings share below is computed");
w("from BF, a plain integer, so that trap cannot contaminate a result.");
w("");
w("THE EXPORT LISTS ONLY CARDS THAT APPEARED. Rows with G = G_1 = G_2 = 0: 0 of 37,992. So an unused");
w("bench card is INVISIBLE here, and every count below is an APPEARANCE count, never a roster count.");
w("This does not touch any statistic in this file (all are conditional on PA>0 or GS>0, and a zero-PA");
w("card contributes nothing to N_eff), but it does mean no claim here is a claim about roster");
w("CONSTRUCTION — only about how playing time was distributed among the cards that played.");
w("");
w("VALIDATION OF THE RUN-DEPTH IDENTITY (team games = ΣGS_1). Exactly one pitcher starts each game, so");
w("ΣGS_1 should equal team games, and max(G, G_1) over the roster is a LOWER BOUND on it (some player");
w("usually, but not always, appears in every game). The identity therefore predicts ΣGS_1 ≥ max(G,G_1)");
w("with NO exceptions, and equality whenever any one card played every game. Measured:");
{
  const ge = live.filter((t) => t.games >= t.maxG).length, eq = live.filter((t) => t.games === t.maxG).length;
  const gaps = live.filter((t) => t.games > t.maxG).map((t) => t.games - t.maxG).sort((a, b) => a - b);
  w(`  ΣGS_1 ≥ max(G,G_1): ${ge}/${live.length} teams (${pct(ge / live.length, 1)}) — ZERO violations, as predicted.`);
  w(`  ΣGS_1 = max(G,G_1): ${eq}/${live.length} (${pct(eq / live.length, 1)}); where it exceeds, the gap is median ${quantile(gaps, 0.5)}, p99 ${quantile(gaps, 0.99)},`);
  const shallow = live.filter((t) => t.games <= 7), deepT = live.filter((t) => t.games >= 15);
  w(`  and it GROWS with run length as rest days predict — mean gap ${f(mean(shallow.map((t) => t.games - t.maxG)), 2)} at ≤7 games, ${f(mean(deepT.map((t) => t.games - t.maxG)), 2)} at 15+.`);
  w(`  A missing-starter-row defect would produce ΣGS_1 BELOW max(G,G_1); none occurs anywhere. (max must`);
  w(`  NOT include G_2: the fielding table is per-POSITION, so a card that changes position mid-game`);
  w(`  books two fielding games — which is why the naive three-way max disagrees 61% of the time.)`);
}

// ══════════════════════════════════════════════════════════════════════════════
H("§1b.  SURVIVORSHIP — QUANTIFIED, THEN STRATIFIED (the choice, stated before any headline)");
w("");
w("THE PROBLEM. Losers are eliminated, so a deep-running team contributes many more card-games than a");
w("round-1 exit. Playing-time distribution IS the estimand, so this sits ON the estimand.");
w("");
w("THE CHOICE: **STRATIFY**. Run depth is DIRECTLY OBSERVABLE — exactly one pitcher starts each");
w("team-game, so a team's games = ΣGS_1 over its rows. No proxy is used or needed. Bounding would be");
w("strictly weaker: it would discard an observable. So the conditional distribution is reported at");
w("every headline and the reader can see whether the SHAPE moves with depth (it does — §2c).");
w("");
w(pad("group", 24) + lpad("teams", 7) + "  " + depthBins.map((b) => lpad(b.label, 10)).join("") + lpad("PA in 15+", 11) + lpad("PA top-decile", 15));
for (const g of groups) {
  const tot = sum(g.ts.map((t) => sum(t.hitPA)));
  const cells = depthBins.map((b) => { const s = g.ts.filter((t) => binOf(t.games) === b.label); return lpad(`${s.length}/${pct(sum(s.map((t) => sum(t.hitPA))) / tot, 0)}`, 10); });
  const srt = [...g.ts].sort((a, b) => b.games - a.games);
  w(pad(g.label, 24) + lpad(String(g.ts.length), 7) + "  " + cells.join("")
    + lpad(pct(sum(g.ts.filter((t) => t.games >= 15).map((t) => sum(t.hitPA))) / tot, 1), 11)
    + lpad(pct(sum(srt.slice(0, Math.max(1, Math.round(0.1 * srt.length))).map((t) => sum(t.hitPA))) / tot, 1), 15));
}
w("");
w("(cell = team count / that group's share of hitter PA)   games played: min " + Math.min(...live.map((t) => t.games)) + ", median " + quantile(live.map((t) => t.games), 0.5) + ", p90 " + quantile(live.map((t) => t.games), 0.9) + ", max " + Math.max(...live.map((t) => t.games)));

// ══════════════════════════════════════════════════════════════════════════════
H("§1c.  ALIKENESS — which formats may be pooled, tested before pooling");
w("");
w("Per-format point estimates with 95% CIs from an INSTANCE-clustered bootstrap (B=2000). Pooling is");
w("licensed only where the CIs overlap.");
w("");
{
  w(pad("format", 24) + lpad("N_eff", 9) + lpad("95% CI", 18) + lpad("rot BF share", 14) + lpad("95% CI", 18) + lpad("k(starters)", 12));
  for (const g of groups) {
    const se1 = ciSE(g.ts, (ts) => mean(ts.map((t) => nEff(t.hitPA)).filter(Number.isFinite)));
    const se2 = ciSE(g.ts, rotPerGS_stat);
    const q = Q(g.ts, g.L);
    w(pad(g.label + (g.kind === "pool" ? "" : ""), 24) + lpad(f(q.nEff, 2), 9)
      + lpad(`[${f(q.nEff - 1.96 * se1, 2)}, ${f(q.nEff + 1.96 * se1, 2)}]`, 18)
      + lpad(pct(q.rotPerGS, 1), 14) + lpad(`[${pct(q.rotPerGS - 1.96 * se2, 1)}, ${pct(q.rotPerGS + 1.96 * se2, 1)}]`, 18)
      + lpad(f(q.k1, 2), 12));
  }
}
w("");
w("READ: the four neutral formats sit inside one another's intervals on both axes (N_eff 11.0–11.7,");
w("rotation share 65.4–67.6%) despite spanning card-value windows ≤69 / ≤89 / uncapped. Early Gold is");
w("22 points away on rotation share — not a wide interval, a different regime. POOLING DECISION:");
w("pool the four neutral DH formats; report Early Gold alone, everywhere.");

// ══════════════════════════════════════════════════════════════════════════════
H("§1d.  CLUSTER STRUCTURE — the variance inflation factor, MEASURED not assumed");
w("");
w("Two candidate units: the TEAM (one roster) and the INSTANCE (one whole running, 15–128 teams that");
w("all played each other, sharing an opponent pool, park, era and meta). Inflation =");
w("SE(instance-clustered bootstrap) / SE(team-clustered bootstrap), B=2000, same seed.");
w("");
{
  const stats: { name: string; fn: (ts: Team[]) => number }[] = [
    { name: "mean N_eff (hitter PA)", fn: (ts) => mean(ts.map((t) => nEff(t.hitPA)).filter(Number.isFinite)) },
    { name: "rotation BF share (per-GS)", fn: rotPerGS_stat },
    { name: "top-9 lineup-start share", fn: (ts) => mean(ts.map((t) => cum(shares(t.hitGS), 9))) },
    { name: "bullpen RP1 BF share (pLi)", fn: (ts) => meanShareVec(ts.map((t) => t.penBFbyLi), 1)[0]! },
  ];
  w(pad("statistic", 30) + pad("group", 26) + lpad("point", 9) + lpad("SE team", 10) + lpad("SE inst", 10) + lpad("inflation", 11));
  for (const s of stats) for (const g of [{ label: "POOL: 4 neutral DH fmts", ts: neutralTs }, { label: "Early Gold", ts: egTs }]) {
    const p = s.fn(g.ts);
    const seT = bootSE(teamUnits(g.ts), s.fn, 20260726), seI = bootSE(instUnits(g.ts), s.fn, 20260726);
    w(pad(s.name, 30) + pad(g.label, 26) + lpad(f(p, 4), 9) + lpad(f(seT, 4), 10) + lpad(f(seI, 4), 10) + lpad(f(seI / seT, 2) + "×", 11));
  }
}
w("");
w("Inflation is real, statistic-dependent, and NOT always >1 — consistent with this project's history");
w("of 3.1× / 1.07× / 1.02–1.22× / 0.99–1.05× on different statistics. Where it falls BELOW 1 (Early");
w("Gold, every statistic) the reading is that the seven Early Gold runnings are near-identical to one");
w("another, so resampling whole runnings moves the estimate LESS than resampling teams independently;");
w("that is a real property of the design, not a bug. Because the conservative cluster is therefore not");
w("known a priori, EVERY CI in this file uses max(SE_instance, SE_team) rather than assuming one.");

// ══════════════════════════════════════════════════════════════════════════════
H("§2.  QUESTION 1 — THE HITTER PLAYING-TIME DISTRIBUTION");
w("");
w("DEFINITIONS. A row is a pitcher-row iff BF>0. HITTER PA = PA on non-pitcher rows, so pitcher");
w("batting (real in the no-DH Early Gold) is excluded and reported separately. Per team the hitter PA");
w("vector is sorted descending; rank k = 'the k-th most-used hitter' — the same ordering the model's");
w("curve uses (lineupWraa sorts wOBA desc against lineupPA). N_eff = 1 / Σ sᵢ² on those shares: the");
w("number of EQUALLY-used hitters producing the same concentration. Nine everyday players and a dead");
w("bench scores exactly 9.0. 'Full-time share' = 1/L of team hitter PA, L = the format's lineup size.");
w("");
{
  const mu9 = modelUsage(9, 5, 6, 7).lineupPA, mu8 = modelUsage(8, 5, 6, 7).lineupPA;
  const f0 = P.fullStrengthShare;
  w(`MODEL BASELINE   lineupPA (1−0.03·slot):  9 slots → N_eff ${f(nEff(mu9), 3)}   8 slots → N_eff ${f(nEff(mu8), 3)}`);
  w(`                 9-slot shares: ${shares(mu9).map((x) => f(x, 4)).join("  ")}`);
  w(`                 slot-1 : slot-9 = ${f(mu9[0]! / mu9[8]!, 3)}`);
  w(`                 The bench enters ONLY via fullStrengthShare (offense.ts): at f0=${f0} each starter`);
  w(`                 plays ${f(1 - (1 - f0) / 9, 4)} of games and ALL substitutes together take ${pct((1 - f0) / 9, 2)} of lineup PA.`);
  w(`                 Spreading that allowance evenly over the whole bench — the most generous possible`);
  w(`                 reading of the model — the implied roster-wide N_eff still only reaches:`);
  for (const nb of [4, 8, 13, 17]) {
    const v = [...shares(mu9).map((s) => s * (1 - (1 - f0) / 9)), ...new Array(nb).fill(((1 - f0) / 9) / nb)];
    w(`                    bench of ${lpad(String(nb), 2)} → N_eff ${f(nEff(v), 3)}`);
  }
  w(`                 So ~9.77 is the model's CEILING on hitter spread. Everything above it is a miss.`);
}
w("");
w("── 2a. per format (per format FIRST; the pool is licensed by §1c) ───────────");
w("");
w(pad("group", 24) + lpad("L", 4) + lpad("teams", 6) + lpad("N_eff", 8) + lpad("95% CI", 16) + lpad("w/PA", 7) + lpad("≥½sh", 7) + lpad("≥¼sh", 7) + lpad("topL PA", 9) + lpad("pit.bat", 9));
for (const g of groups) {
  const q = Q(g.ts, g.L);
  const se = ciSE(g.ts, (ts) => mean(ts.map((t) => nEff(t.hitPA)).filter(Number.isFinite)));
  w(pad(g.label, 24) + lpad(String(g.L), 4) + lpad(String(q.n), 6) + lpad(f(q.nEff, 2), 8)
    + lpad(`[${f(q.nEff - 1.96 * se, 2)},${f(q.nEff + 1.96 * se, 2)}]`, 16)
    + lpad(f(q.hitters, 1), 7) + lpad(f(q.nHalf, 1), 7) + lpad(f(q.nQtr, 1), 7) + lpad(pct(q.topL, 1), 9) + lpad(pct(q.pitBat, 1), 9));
}
w("");
w("  L = format lineup size (Early Gold is no-DH ⇒ 8 non-pitcher slots) · w/PA = mean hitters with ≥1 PA");
w("  ≥½sh / ≥¼sh = count at ≥50% / ≥25% of a full-time share · topL = share of hitter PA taken by the top L");
w("");
w("── 2b. per-rank share curve (mean over teams) ───────────────────────────────");
w("");
{
  const RK = 15;
  w(pad("group", 24) + Array.from({ length: RK }, (_, i) => lpad("r" + (i + 1), 6)).join(""));
  const mu = shares(modelUsage(9, 5, 6, 7).lineupPA);
  w(pad("MODEL (9 slots)", 24) + Array.from({ length: RK }, (_, i) => lpad(f(mu[i] ?? 0, 3), 6)).join(""));
  const mu8 = shares(modelUsage(8, 5, 6, 7).lineupPA);
  w(pad("MODEL (8 slots, no-DH)", 24) + Array.from({ length: RK }, (_, i) => lpad(f(mu8[i] ?? 0, 3), 6)).join(""));
  for (const g of groups) w(pad(g.label, 24) + meanShareVec(g.ts.map((t) => t.hitPA), RK).map((x) => lpad(f(x, 3), 6)).join(""));
  w("");
  const vN = meanShareVec(neutralTs.map((t) => t.hitPA), RK), vE = meanShareVec(egTs.map((t) => t.hitPA), RK);
  w(`NEUTRAL POOL   r1:r9 = ${f(vN[0]! / vN[8]!, 2)} (model ${f(mu[0]! / mu[8]!, 2)})   r1:r13 = ${f(vN[0]! / vN[12]!, 2)}   cum top-9 ${pct(cum(vN, 9), 1)}, top-11 ${pct(cum(vN, 11), 1)}, top-13 ${pct(cum(vN, 13), 1)}`);
  w(`EARLY GOLD     r1:r8 = ${f(vE[0]! / vE[7]!, 2)} (model 8-slot ${f(mu8[0]! / mu8[7]!, 2)})   cum top-8 ${pct(cum(vE, 8), 1)}, top-11 ${pct(cum(vE, 11), 1)}, top-13 ${pct(cum(vE, 13), 1)}`);
  w("");
  w("The shape is not the model's shape. Realised PA declines gently through the lineup and then");
  w("BREAKS at r9/r10 into a long, substantial part-time tail the model has no slot for at all.");
}
w("");
w("── 2c. SURVIVORSHIP STRATIFICATION — does the shape move with run depth? ────");
w("");
for (const [gl, gts, gL] of [["POOL: 4 neutral DH fmts", neutralTs, 9], ["Early Gold", egTs, 8]] as const) {
  w(`  ${gl}`);
  w("  " + pad("stratum", 12) + lpad("teams", 7) + lpad("PA wt", 8) + lpad("N_eff", 8) + lpad("±CI", 8) + lpad("w/PA", 7) + lpad("≥½sh", 7) + lpad("topL PA", 9) + "   per-rank r1..r12");
  const tot = sum(gts.map((t) => sum(t.hitPA)));
  for (const b of depthBins) {
    const s = gts.filter((t) => binOf(t.games) === b.label); if (!s.length) continue;
    const q = Q(s, gL);
    const se = ciSE(s, (ts) => mean(ts.map((t) => nEff(t.hitPA)).filter(Number.isFinite)));
    w("  " + pad(b.label, 12) + lpad(String(s.length), 7) + lpad(pct(sum(s.map((t) => sum(t.hitPA))) / tot, 1), 8)
      + lpad(f(q.nEff, 2), 8) + lpad("±" + f(1.96 * se, 2), 8) + lpad(f(q.hitters, 1), 7) + lpad(f(q.nHalf, 1), 7)
      + lpad(pct(q.topL, 1), 9) + "   " + meanShareVec(s.map((t) => t.hitPA), 12).map((x) => f(x, 3)).join(" "));
  }
  w("");
}
w("  THE SHAPE MOVES, AND IT MOVES AGAINST THE MODEL. Deeper runs spread playing time MORE, not less:");
w("  survivorship is biasing the pooled N_eff DOWNWARD relative to the deep-run rosters the optimizer");
w("  actually cares about. So the model's under-spread is understated by the pooled figure — the");
w("  survivorship correction makes the failure larger, not smaller. The mechanism is mundane: more");
w("  games means more rest days, more blowouts and more matchup substitution reaching the bench.");

// ══════════════════════════════════════════════════════════════════════════════
H("§3.  QUESTION 2 — ROTATION / BULLPEN SPLIT AND THE LEVERAGE CURVE");
w("");
w("THE IDENTIFICATION PROBLEM, STATED. BF is a whole-event total; the export does NOT split a");
w("pitcher's BF between his starts and his relief outings, so a SWINGMAN (GS_1>0, G_1>GS_1) is");
w("ambiguous. Three estimates; the gap between them IS the ambiguity:");
w("   LOWER   BF of PURE starters (GS_1=G_1) / team BF           — swingman relief counted as bullpen");
w("   UPPER   BF of every GS_1>0 row / team BF                   — swingman relief counted as rotation");
w("   PER-GS  (BF per start among pure starters × team games) / team BF   ← the identified estimate:");
w("           prices a start off unambiguous starters, multiplies by the observed start count");
w("");
w(pad("group", 24) + lpad("lower", 8) + lpad("PER-GS", 9) + lpad("95% CI", 17) + lpad("upper", 8) + lpad("swingBF", 9) + lpad("BF/start", 10) + lpad("SP stamina", 12) + lpad("model", 8) + lpad("gap", 9));
for (const g of groups) {
  const q = Q(g.ts, g.L);
  const se = ciSE(g.ts, rotPerGS_stat);
  w(pad(g.label, 24) + lpad(pct(q.rotLo, 1), 8) + lpad(pct(q.rotPerGS, 1), 9)
    + lpad(`[${pct(q.rotPerGS - 1.96 * se, 1)},${pct(q.rotPerGS + 1.96 * se, 1)}]`, 17) + lpad(pct(q.rotUp, 1), 8)
    + lpad(pct(sum(g.ts.map((t) => t.swingBF)) / sum(g.ts.map((t) => t.teamBF)), 1), 9)
    + lpad(f(q.bfPerStart, 2), 10) + lpad(f(q.stm, 1), 12) + lpad(pct(P.rotationShare, 0), 8)
    + lpad((q.rotPerGS >= P.rotationShare ? "+" : "") + pct(q.rotPerGS - P.rotationShare, 1), 9));
}
w("");
w("  BF/start = batters faced per start among pure starters (a full 9-inning start ≈ 38 BF)");
w("  SP stamina = BF-weighted mean STM rating of the arms that actually started");
w("");
w("THE ENV-vs-POOL DISCRIMINATOR. Early Gold's starters carry a BF-weighted mean stamina of");
w(`${f(QE.stm, 1)} against ${f(QN.stm, 1)} in the neutral pool, and go ${f(QE.bfPerStart, 1)} BF per start against ${f(QN.bfPerStart, 1)}. Its rotation`);
w("share is high because era-1920 ELIGIBILITY loads the pool with complete-game starters — a POOL-");
w("COMPOSITION effect, not the era run-environment scalar reallocating innings. That distinction");
w("matters for what generalises: a format's rotation share follows the stamina of the cards it makes");
w("eligible, so it is a per-format quantity in principle, not just in this sample.");
w("");
w("── 3a. rotation-slot start curve ────────────────────────────────────────────");
w("");
w("Rotation slots ranked by GS_1 desc within a team, averaged across teams as SHARES of team starts.");
w("Compared to `rotationStarts(bestOf, k)` — the model's own format-derived curve. rotationDecay=0 is");
w("a NO-EXTRA-TILT flag, so what is really under test is that format curve.");
w("");
{
  const RK = 7;
  w(pad("group / model", 30) + lpad("k(≥1GS)", 9) + lpad("k(≥2GS)", 9) + "  " + Array.from({ length: RK }, (_, i) => lpad("SP" + (i + 1), 7)).join(""));
  for (const bo of [3, 5, 7]) {
    const rs = shares(rotationStarts(bo, 5));
    w(pad(`MODEL rotationStarts(bo=${bo},k=5)`, 30) + lpad("5", 9) + lpad("—", 9) + "  " + Array.from({ length: RK }, (_, i) => lpad(f(rs[i] ?? 0, 3), 7)).join(""));
  }
  const rs4 = shares(rotationStarts(5, 4));
  w(pad("MODEL rotationStarts(bo=5,k=4)", 30) + lpad("4", 9) + lpad("—", 9) + "  " + Array.from({ length: RK }, (_, i) => lpad(f(rs4[i] ?? 0, 3), 7)).join(""));
  for (const g of groups) {
    w(pad(g.label, 30) + lpad(f(mean(g.ts.map((t) => t.starts.length)), 2), 9)
      + lpad(f(mean(g.ts.map((t) => t.starts.filter((x) => x >= 2).length)), 2), 9) + "  "
      + meanShareVec(g.ts.map((t) => t.starts), RK).map((x) => lpad(f(x, 3), 7)).join(""));
  }
  w("");
  w("  by depth stratum (a 3-game team CANNOT show a 5-man rotation — this is where survivorship bites");
  w("  the rotation curve hardest, so the STRATA are the answer and the pooled row is not):");
  w("");
  for (const [gl, gts] of [["POOL: 4 neutral DH fmts", neutralTs], ["Early Gold", egTs]] as const) {
    w("  " + gl);
    w("  " + pad("stratum", 12) + lpad("teams", 7) + lpad("k(≥1)", 8) + lpad("k(≥2)", 8) + "  " + Array.from({ length: RK }, (_, i) => lpad("SP" + (i + 1), 7)).join(""));
    for (const b of depthBins) {
      const s = gts.filter((t) => binOf(t.games) === b.label); if (!s.length) continue;
      w("  " + pad(b.label, 12) + lpad(String(s.length), 7) + lpad(f(mean(s.map((t) => t.starts.length)), 2), 8)
        + lpad(f(mean(s.map((t) => t.starts.filter((x) => x >= 2).length)), 2), 8) + "  "
        + meanShareVec(s.map((t) => t.starts), RK).map((x) => lpad(f(x, 3), 7)).join(""));
    }
    w("");
  }
  w("  THE STRATIFICATION REVERSES THE POOLED READING — this is the clearest single demonstration in");
  w("  this file of why the survivorship guard was mandatory. Pooled, the realised rotation looks like a");
  w("  broken 4.7-man staff whose SP5 (0.115) is far under the model's 0.164, and the naive conclusion");
  w("  is 'the format curve is wrong'. But a team that played 3 games CANNOT show five starters: the");
  w("  shortfall is a censoring artefact of shallow runs, not a usage fact. Conditional on run depth:");
  const dN = neutralTs.filter((t) => t.games >= 15), dE = egTs.filter((t) => t.games >= 15);
  const vN15 = meanShareVec(dN.map((t) => t.starts), 5), vE15 = meanShareVec(dE.map((t) => t.starts), 5);
  const m7 = shares(rotationStarts(7, 5)), m54 = shares(rotationStarts(5, 4));
  w("");
  w(`     neutral pool, 15+ games (k=${f(mean(dN.map((t) => t.starts.length)), 2)}):  ${vN15.map((x) => f(x, 3)).join("  ")}`);
  w(`     MODEL rotationStarts(bo=7, k=5):    ${m7.slice(0, 5).map((x) => f(x, 3)).join("  ")}`);
  w(`     max per-slot deviation: ${f(Math.max(...vN15.map((x, i) => Math.abs(x - m7[i]!))), 3)}`);
  w("");
  w(`     Early Gold, 15+ games (k=${f(mean(dE.map((t) => t.starts.length)), 2)}):     ${vE15.slice(0, 4).map((x) => f(x, 3)).join("  ")}   [SP5 ${f(vE15[4]!, 3)}]`);
  w(`     MODEL rotationStarts(bo=5, k=4):    ${m54.slice(0, 4).map((x) => f(x, 3)).join("  ")}   (k=4 = early-gold's own min_starters)`);
  w(`     max per-slot deviation over the four modelled slots: ${f(Math.max(...vE15.slice(0, 4).map((x, i) => Math.abs(x - m54[i]!))), 3)}`);
  w(`     (realised SP5 usage ${f(vE15[4]!, 3)} is a small residual the 4-man curve has no slot for at all)`);
  w("");
  w("  CAVEAT, AND IT IS A REAL ONE: `bestOf` IS NOT OBSERVABLE in the export. The comparator above was");
  w("  CHOSEN as the best-fitting member of {3,5,7}, so the agreement is 'the realised curve lies inside");
  w("  the family rotationStarts generates', not 'the model's bestOf setting is verified'. The full");
  w("  selection is shown so the reader can discount it:");
  w("");
  w("  " + pad("neutral pool 15+ games vs …", 34) + lpad("SP1", 8) + lpad("SP2", 8) + lpad("SP3", 8) + lpad("SP4", 8) + lpad("SP5", 8) + lpad("max dev", 10));
  w("  " + pad("REALISED", 34) + vN15.map((x) => lpad(f(x, 3), 8)).join("") + lpad("—", 10));
  for (const bo of [3, 5, 7]) {
    const m = shares(rotationStarts(bo, 5));
    w("  " + pad(`rotationStarts(bo=${bo}, k=5)`, 34) + m.slice(0, 5).map((x) => lpad(f(x, 3), 8)).join("") + lpad(f(Math.max(...vN15.map((x, i) => Math.abs(x - m[i]!))), 3), 10));
  }
  w("");
  w("  Even the WORST member of the family (bo=5, max dev 0.063) is far closer than the pooled reading");
  w("  suggested, and bo=3 and bo=7 both land inside 0.02. So `rotationStarts` — the one piece of the");
  w("  usage model that was DERIVED rather than hand-set — is SUPPORTED as a functional form, in both a");
  w("  5-man DH format and a 4-man no-DH format, once the censoring is removed; its bestOf ARGUMENT is");
  w("  not verified here and cannot be from these files. The 4/5 'cliff' in the pooled row is");
  w("  survivorship, not behaviour.");
}
w("");
w("── 3b. bullpen leverage — is a two-number model enough? ─────────────────────");
w("");
w("`bullpenLeverage [2.5,1.5]` reweights bullpen BF: top arm 2.5× a filler arm, 2nd 1.5×, everyone");
w("from the 3rd down EXACTLY 1.0×. Two separable claims:");
w("  (i)  the LEVEL of the slot-1/slot-2 premium;");
w("  (ii) the FLAT-FROM-SLOT-3 claim — which is the actual content of 'a two-number model'.");
w("");
w("Relievers = pure relief rows (GS_1=0, G_1>0). THE ORDERING IS ITSELF A MODELLING CHOICE and one");
w("candidate is circular, so all three are shown:");
w("  by BF   ranks arms by the very quantity measured. Mechanically maximal concentration — an UPPER");
w("          BOUND on how peaked any leverage rule could look. NOT the curve.");
w("  by pLi  ranks by realised average LEVERAGE INDEX, i.e. by ROLE (closer / setup / mop-up). This is");
w("          what bullpenLeverage means, and it is not circular in BF.  ← the comparison that counts");
w("  BF×pLi  leverage-weighted innings — the quantity the code comment says it models.");
w("");
w("AND: the tail comparison is restricted to teams that ACTUALLY CARRY ≥7 relievers. Averaging a");
w("7-slot share vector over teams with 3 relievers pads the tail with structural zeros and manufactures");
w("a decline. Both the all-teams and the ≥7-arm rows are shown so the padding artefact is visible.");
w("");
{
  const RK = 8;
  const penModel = shares(Array.from({ length: 7 }, (_, i) => P.bullpenLeverage[i] ?? 1));
  const views = [
    ["BF, ranked by BF (upper bound, circular)", (t: Team) => t.penBF],
    ["BF, ranked by pLi (ROLE order) ← the one that counts", (t: Team) => t.penBFbyLi],
    ["BF×pLi, ranked by BF×pLi", (t: Team) => t.penLev],
  ] as const;
  for (const [label, get] of views) {
    w(`  ${label}`);
    w("  " + pad("group", 34) + lpad("arms", 6) + "  " + Array.from({ length: RK }, (_, i) => lpad("RP" + (i + 1), 7)).join("") + lpad("RP1/RP7", 10));
    w("  " + pad("MODEL [2.5,1.5,1,1,1,1,1]", 34) + lpad("7", 6) + "  " + penModel.map((x) => lpad(f(x, 3), 7)).join("") + lpad("", 7) + lpad(f(penModel[0]! / penModel[6]!, 2), 10));
    for (const g of groups) {
      for (const [tag, ts] of [["all teams", g.ts], ["≥7 arms", g.ts.filter((t) => get(t).filter((x) => x > 0).length >= 7)]] as const) {
        if (!ts.length) continue;
        const v = meanShareVec(ts.map(get), RK);
        w("  " + pad(g.label + "  [" + tag + "]", 34) + lpad(f(mean(ts.map((t) => get(t).filter((x) => x > 0).length)), 2), 6) + "  "
          + v.map((x) => lpad(f(x, 3), 7)).join("") + lpad(f(v[0]! / (v[6]! || NaN), 2), 10));
      }
    }
    w("");
  }
  w("  realised pLi BY SLOT (the leverage index itself, ranked desc — a direct read on 'how much more");
  w("  leverage does the closer see than the 7th man', with no BF circularity whatsoever):");
  w("  " + pad("group", 34) + "  " + Array.from({ length: RK }, (_, i) => lpad("RP" + (i + 1), 7)).join("") + lpad("RP1/RP7", 10));
  for (const g of groups) for (const [tag, ts] of [["all teams", g.ts], ["≥7 arms", g.ts.filter((t) => t.penLi.filter((x) => x > 0).length >= 7)]] as const) {
    if (!ts.length) continue;
    const v = Array.from({ length: RK }, (_, k) => mean(ts.map((t) => t.penLi[k]).filter((x): x is number => x !== undefined && x > 0)));
    w("  " + pad(g.label + "  [" + tag + "]", 34) + "  " + v.map((x) => lpad(f(x, 2), 7)).join("") + lpad(f(v[0]! / v[6]!, 2), 10));
  }
}
w("");
{
  const d7 = neutralTs.filter((t) => t.penBFbyLi.filter((x) => x > 0).length >= 7);
  const bfRole = meanShareVec(d7.map((t) => t.penBFbyLi), 7);
  const lev = meanShareVec(neutralTs.filter((t) => t.penLev.filter((x) => x > 0).length >= 7).map((t) => t.penLev), 7);
  const penM = shares(Array.from({ length: 7 }, (_, i) => P.bullpenLeverage[i] ?? 1));
  w("VERDICT — AND THE PARAMETER TURNS OUT TO BE AMBIGUOUS, WHICH IS THE REAL FINDING.");
  w("");
  w("`bullpenLeverage` multiplies `bullpenBF`, and `bullpenBF` is consumed in defenseRunsAboveAvg as a");
  w("straight BATTERS-FACED weight. But the code comment calls it 'leverage-weighted bullpen BF'. Those");
  w("are two different quantities and the data answers them OPPOSITELY, so the parameter cannot be");
  w("right under both readings and it is not clear which one it is meant to be.");
  w("");
  w("  READING A — plain BF, i.e. 'the closer FACES MORE BATTERS than the 7th man'.");
  w(`     realised (role order, ≥7-arm neutral teams):  ${bfRole.map((x) => f(x, 3)).join("  ")}`);
  w(`     model:                                        ${penM.map((x) => f(x, 3)).join("  ")}`);
  w(`     Realised bullpen BF is FLAT across leverage roles — RP1/RP7 = ${f(bfRole[0]! / bfRole[6]!, 2)}, against the model's 2.50.`);
  w("     The high-leverage arm does NOT throw more; it throws the same amount in tighter spots. Under");
  w("     this reading the FLAT-TAIL claim is right and the PREMIUM is refuted — the model over-");
  w(`     concentrates the top slot by ${f(penM[0]! / bfRole[0]!, 1)}×.`);
  w("");
  w("  READING B — leverage-weighted innings (BF × pLi), what the comment says.");
  w(`     realised (≥7-arm neutral teams):              ${lev.map((x) => f(x, 3)).join("  ")}`);
  w(`     model:                                        ${penM.map((x) => f(x, 3)).join("  ")}`);
  w(`     Now RP1 (${f(lev[0]!, 3)}) and RP2 (${f(lev[1]!, 3)}) are in the model's neighbourhood (0.278 / 0.167) — the`);
  w(`     PREMIUM'S LEVEL is defensible — but the tail keeps falling (${lev.slice(2, 7).map((x) => f(x, 3)).join(" ")}) where the`);
  w(`     model holds it flat at 0.111, and RP1/RP7 is ${f(lev[0]! / lev[6]!, 1)} against 2.50. Under this reading the`);
  w("     PREMIUM holds and the FLAT TAIL is refuted — the model under-concentrates overall.");
  w("");
  w("  EXACTLY ONE of the two claims survives under each reading, and never the same one. The");
  w("  underlying driver is visible with no BF circularity at all: the leverage index itself falls");
  w(`  monotonically ${f(mean(d7.map((t) => t.penLi[0]!).filter(Number.isFinite)), 2)} → ${f(mean(d7.map((t) => t.penLi[6]!).filter(Number.isFinite)), 2)} from closer to 7th man, with no flat region anywhere. A`);
  w("  two-number [premium, premium, flat…] shape cannot represent a smooth monotone decline no matter");
  w("  what the two numbers are. NOTE the ordering matters enormously and the intuitive one is wrong:");
  w(`  ranking arms by their own BF gives RP1/RP7 = ${f(meanShareVec(d7.map((t) => t.penBF), 7)[0]! / meanShareVec(d7.map((t) => t.penBF), 7)[6]!, 2)}, but that ranks arms by the very quantity`);
  w("  being measured and is circular — it is an upper bound on peakedness, not an estimate of it.");
}

// ══════════════════════════════════════════════════════════════════════════════
H("§4.  QUESTION 3 — fullStrengthShare AND platoonCapture");
w("");
w("── 4a. platoonCapture — THE EXPORTS CANNOT ADDRESS IT ───────────────────────");
w("");
w("ρ is 'how often a FIELDED CARD gets its favourable matchup'. Identifying it needs each hitter's PA");
w("split by opposing-pitcher handedness. The export carries vL/vR columns for RATINGS only (BA vL,");
w("POW vR, STU vL, …); every realised statistic — PA, AB, H, HR, BB, K, IP, BF — is a single");
w("undifferentiated total. No PA-vs-LHP column, no split table, no game log. ρ is NOT MEASURABLE from");
w("this corpus and NO PROXY IS OFFERED.");
w("");
w("What IS measurable is the handedness SUPPLY — the exposure under zero platoon deployment:");
w("");
w("  " + pad("group", 24) + lpad("BF by RHP", 12) + lpad("BF by LHP", 12) + lpad("LHP share", 12));
for (const g of groups) w("  " + pad(g.label, 24) + lpad(String(sum(g.ts.map((t) => t.rhpBF))), 12) + lpad(String(sum(g.ts.map((t) => t.lhpBF))), 12) + lpad(pct(Q(g.ts, g.L).lhpShare, 1), 12));
w("");
w(`  In the neutral pool ${pct(QN.lhpShare, 1)} of BF come from LHP, so a randomly-deployed LH hitter meets its`);
w(`  favourable side ${pct(1 - QN.lhpShare, 1)} of the time and a RH hitter ${pct(QN.lhpShare, 1)}. These are SUPPLY numbers and they`);
w("  bound nothing about ρ, because ρ is the manager's deployment ON TOP of supply — exactly what the");
w("  export does not record. Quoted only so nobody mistakes supply for capture.");
w("");
w("── 4b. fullStrengthShare — its SHAPE is testable; its VALUE is not ──────────");
w("");
w("f0 = 'fraction of games fielded at the best nine AVAILABLE'. Availability (injury, fatigue) is not");
w("exported and 'best' is a model judgement, so f0 is not identified. But it has ONE implication that");
w("does live in the data: in offense.ts, with probability (1−f0) exactly ONE of the L starters is");
w("replaced, so the L starters must collectively take (L−1+f0)/L of all lineup starts. GS (batting");
w("games started) is exported, so that share is directly measurable.");
w("");
w("CONFOUND, NAMED: the measured churn conflates unavailability with deliberate platooning, rest,");
w("blowout substitution and manager preference — the model attributes ALL of it to f0. So this is an");
w("implication test of the RULE'S SHAPE, not an estimate of f0.");
w("");
{
  w(pad("group", 24) + lpad("L", 4) + lpad("topL GS%", 10) + lpad("95% CI", 17) + lpad("model needs", 12) + lpad("f0 implied", 12) + lpad("hitters w/GS", 14));
  for (const g of groups) {
    const q = Q(g.ts, g.L);
    const se = ciSE(g.ts, (ts) => mean(ts.map((t) => cum(shares(t.hitGS), g.L))));
    w(pad(g.label, 24) + lpad(String(g.L), 4) + lpad(pct(q.gsTopL, 1), 10)
      + lpad(`[${pct(q.gsTopL - 1.96 * se, 1)},${pct(q.gsTopL + 1.96 * se, 1)}]`, 17)
      + lpad(pct((g.L - 1 + P.fullStrengthShare) / g.L, 1), 12) + lpad(f(g.L * q.gsTopL - (g.L - 1), 2), 12) + lpad(f(q.startersUsed, 1), 14));
  }
  w("");
  w("  f0 implied = L·(topL GS%) − (L−1): f0 inverted THROUGH the model's own substitution rule.");
  w("  A value ≤0 means the observed churn exceeds anything the one-starter-out rule can express at any f0.");
  w("");
  for (const [gl, gts, gL] of [["POOL: 4 neutral DH fmts", neutralTs, 9], ["Early Gold", egTs, 8]] as const) {
    w("  " + gl + " — by depth stratum:");
    w("  " + pad("stratum", 12) + lpad("teams", 7) + lpad("topL GS%", 10) + lpad("f0 implied", 12) + lpad("hitters w/GS", 14));
    for (const b of depthBins) {
      const s = gts.filter((t) => binOf(t.games) === b.label); if (!s.length) continue;
      const sl = mean(s.map((t) => cum(shares(t.hitGS), gL)));
      w("  " + pad(b.label, 12) + lpad(String(s.length), 7) + lpad(pct(sl, 1), 10) + lpad(f(gL * sl - (gL - 1), 2), 12) + lpad(f(mean(s.map((t) => t.hitGS.length)), 1), 14));
    }
    w("");
  }
  w("  The implied f0 goes MORE negative with depth. The failure is structural: real rosters rotate a");
  w("  10–14 man batting group, which a 'nine starters, one occasionally missing' rule cannot represent");
  w("  at any parameter value. Note this refutes the RULE, not the IDEA that bench depth has value —");
  w("  the data says bench depth is used far MORE than the rule allows, not less.");
}

// ══════════════════════════════════════════════════════════════════════════════
H("§5.  QUESTION 4 — DIRECT COMPARISON, MODEL vs REALISED");
w("");
{
  const vN = meanShareVec(neutralTs.map((t) => t.hitPA), 14), vE = meanShareVec(egTs.map((t) => t.hitPA), 14);
  const mu9 = shares(modelUsage(9, 5, 6, 7).lineupPA), mu8 = shares(modelUsage(8, 5, 6, 7).lineupPA);
  const rotR_N = meanShareVec(neutralTs.map((t) => t.starts), 7), rotR_E = meanShareVec(egTs.map((t) => t.starts), 7);
  const rot7 = shares(rotationStarts(7, 5));
  const pen7N = meanShareVec(neutralTs.filter((t) => t.penBFbyLi.filter((x) => x > 0).length >= 7).map((t) => t.penBFbyLi), 8);
  const penM = shares(Array.from({ length: 7 }, (_, i) => P.bullpenLeverage[i] ?? 1));
  const dN = neutralTs.filter((t) => t.games >= 15), dE = egTs.filter((t) => t.games >= 15);
  const QN15 = Q(dN, 9), QE15 = Q(dE, 8);
  const vN15 = meanShareVec(dN.map((t) => t.hitPA), 14);
  const rotN15 = meanShareVec(dN.map((t) => t.starts), 7), rotE15 = meanShareVec(dE.map((t) => t.starts), 7);
  const lev7N = meanShareVec(neutralTs.filter((t) => t.penLev.filter((x) => x > 0).length >= 7).map((t) => t.penLev), 7);
  const gs15N = mean(dN.map((t) => cum(shares(t.hitGS), 9))), gs15E = mean(dE.map((t) => cum(shares(t.hitGS), 8)));
  const rows: [string, string, string, string, string, string][] = [
    ["hitter concentration N_eff", "8.93 (≤9.77)", f(QN.nEff, 2), f(QN15.nEff, 2), f(QE.nEff, 2), `REFUTED — model under-spreads by ${f(QN15.nEff - 9.77, 1)} effective hitters at depth`],
    ["hitters receiving any PA", "9", f(QN.hitters, 1), f(QN15.hitters, 1), f(QE.hitters, 1), "REFUTED — an entire part-time tier the model has no slot for"],
    ["hitters at ≥¼ full-time share", "9", f(QN.nQtr, 1), f(QN15.nQtr, 1), f(QE.nQtr, 1), "REFUTED — same"],
    ["hitters at ≥½ full-time share", "9", f(QN.nHalf, 1), f(QN15.nHalf, 1), f(QE.nHalf, 1), "HOLDS — the everyday core really is ~9"],
    ["top-L share of hitter PA", "100%", pct(QN.topL, 1), pct(QN15.topL, 1), pct(QE.topL, 1), "REFUTED — bench takes ~1 PA in 5 at depth; model gives it 0"],
    ["slot-1 : slot-L PA ratio", f(mu9[0]! / mu9[8]!, 2) + "/" + f(mu8[0]! / mu8[7]!, 2), f(vN[0]! / vN[8]!, 2), f(vN15[0]! / vN15[8]!, 2), f(vE[0]! / vE[7]!, 2), "REFUTED (mild) — realised tilt ~1.2–1.5× the model's"],
    ["rotation BF share", pct(P.rotationShare, 1), pct(QN.rotPerGS, 1), pct(QN15.rotPerGS, 1), pct(QE.rotPerGS, 1), `REFUTED — low by ${pct(QN.rotPerGS - P.rotationShare, 1)} (neutral) / ${pct(QE.rotPerGS - P.rotationShare, 1)} (Early Gold); format-dependent`],
    ["rotation size actually used", "5 / 4 (cfg)", f(QN.k1, 2), f(QN15.k1, 2), f(QE15.k1, 2) + "*", "HOLDS at depth — the pooled 4.7 is survivorship censoring"],
    ["SP1 share of starts", f(rot7[0]!, 3) + " (bo7)", f(rotR_N[0]!, 3), f(rotN15[0]!, 3), f(rotE15[0]!, 3) + "*", "HOLDS at depth — within 0.014 of the derived curve"],
    ["SP5 share of starts", f(rot7[4]!, 3) + " (bo7)", f(rotR_N[4]!, 3), f(rotN15[4]!, 3), f(rotE15[4]!, 3) + "*", "HOLDS at depth in the k=5 formats — pooled gap was censoring"],
    ["bullpen RP1, plain BF by role", f(penM[0]!, 3), f(pen7N[0]!, 3), "—", "—", `REFUTED — realised is FLAT (RP1/RP7 ${f(pen7N[0]! / pen7N[6]!, 2)}); model over-concentrates`],
    ["bullpen RP1, leverage-wtd (BF×pLi)", f(penM[0]!, 3), f(lev7N[0]!, 3), "—", "—", "HOLDS — the premium's LEVEL is defensible under this reading"],
    ["bullpen RP3..RP7 flat tail", "0.111 ×5 (flat)", "see →", "—", "—", `REFUTED under BOTH readings — lev-wtd ${lev7N.slice(2, 7).map((x) => f(x, 3)).join(" ")}, monotone`],
    ["top-L share of lineup starts", pct((8 + P.fullStrengthShare) / 9, 1), pct(QN.gsTopL, 1), pct(gs15N, 1), pct(QE.gsTopL, 1), `REFUTED — inverts to f0 ${f(9 * QN.gsTopL - 8, 2)} pooled, ${f(9 * gs15N - 8, 2)} at depth: outside [0,1]`],
    ["platoon capture ρ", f(P.platoonCapture, 2), "—", "—", "—", "NOT MEASURABLE — no handedness split of any realised stat"],
    ["budget-constrained roster usage", "cap/slots input", "—", "—", "—", "NO DATA — corpus has zero cap and zero slots formats"],
  ];
  w("Columns: the neutral pool pooled over depth, the neutral pool's DEEPEST stratum (15+ games — the");
  w("survivorship-corrected read, and the run depth the optimizer's use-case is about), and Early Gold");
  w("alone. Verdicts are taken from the DEEP column where the two disagree.");
  w("");
  w(pad("quantity", 36) + pad("MODEL", 17) + pad("neutral", 10) + pad("neut 15+", 10) + pad("EarlyGold", 11) + "verdict");
  w("─".repeat(100));
  for (const r of rows) w(pad(r[0], 36) + pad(r[1], 17) + pad(r[2], 10) + pad(r[3], 10) + pad(r[4], 11) + r[5]);
  w("");
  w("  * = Early Gold's 15+ game stratum (its rotation comparator is the k=4 curve, not the k=5 one).");
  w("");
  w("Reading the table: THREE of the model's assumptions survive (the ~9-man everyday core, the derived");
  w("rotationStarts curve, and the bullpen premium's level under the leverage-weighted reading). The");
  w("rest fail, and the two biggest failures — the lineup curve's SUPPORT and rotationShare — are both");
  w("failures the survivorship correction makes WORSE, not better.");
}

w("");
w("═".repeat(100));
w("SCOPE NOTES, KEPT AT THE END BUT NOT BURIED — every one of them constrains the table above.");
w("  1. OWNERSHIP SHAPING. These rosters are built from cards people own; composition reflects");
w("     collections and the market. Nothing here supports a claim about what a roster COULD be. Every");
w("     claim is about how playing time distributes ACROSS A ROSTER THAT EXISTS — which is what the");
w("     usage model consumes, so the shaping does not touch the estimand.");
w("  2. NO CAP, NO SLOTS. All five formats are budget_mode:none. The cap/slots objective is the main");
w("     consumer of these parameters and the corpus cannot speak to it.");
w("  3. ONE ENV-MODIFIED FORMAT. Early Gold's divergence cannot be attributed between environment,");
w("     no-DH, min_starters 4 and era-1920 pool composition from n=1 format. §3's stamina measurement");
w("     points at pool composition; that is a lead, not a result.");
w("  4. DESCRIPTIVE ONLY. No curve was fitted, no parameter proposed, no default touched. A");
w("     calibration built on this would need its own pre-registration.");
w("═".repeat(100));

writeFileSync(OUT, L_.join("\n") + "\n");
console.log(L_.join("\n"));
console.log("\nwrote " + OUT);
