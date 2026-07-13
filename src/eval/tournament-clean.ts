// Tournament ghost-cleaning — a reusable, data-shape-agnostic module.
//
// WHY: OOTP tournaments run a fixed team count (Bronze = 128, best-of-7). A manager who
// never submits a lineup is replaced by GHOST teams that play the bracket but DON'T export
// to the running CSV. The ghost loses every game by blowout (Bo7 → 4 games, 40+ runs each),
// so the ghost's real OPPONENT racks up a massively inflated combined stat line. The result:
//   (a) the running shows FEWER distinct teams than expected (each ghost = one missing team), and
//   (b) a handful of real teams carry absurd offensive totals from beating the ghosts.
//
// METHOD (validated on real Return-of-the-Bronze data, July 2026):
//   1. nGhosts = expectedTeams − distinctTeamCount   (a "team" = a distinct non-empty ORG).
//   2. Score every team by EXCESS OFFENSE = teamPA × (teamRate − poolRate), where `rate` is a
//      wOBA-proxy per PA. Excess (not raw wOBA) is used because raw rate throws false positives
//      on small-sample luck; multiplying by PA demands the inflation be BOTH large AND on volume.
//   3. The top-nGhosts teams by excess ARE the ghost opponents → remove all their rows.
//   Validation: July-7 flags "Portsmouth Wunderfunk" (excess≈193); July-5 flags
//   "DC Capital Giants" (≈178); a clean 128-team running (July-11) has nGhosts=0 and a smooth
//   top (max excess≈49) → removes nothing.
//
// Parse conventions mirror tools/tournament-kslope.ts: numeric fields via Number()||0; the
// batting columns are PA, ORG, BB, 1B_1, 2B_1, 3B_1, HR. Callers pass already-parsed row
// objects (a CSV read lives in the caller), keeping this module data-shape-agnostic.

// A parsed CSV row. String-keyed; values are whatever the CSV parser produced (usually string).
export type Row = Record<string, unknown>;

/** Numeric coercion identical to tools/tournament-kslope.ts (`Number()` with non-finite → 0). */
const num = (v: unknown): number => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};

/** wOBA-proxy numerator for one row (per-PA offensive value, un-normalized). */
const wobaNumerator = (r: Row): number =>
  0.7 * num(r.BB) +
  0.9 * num(r["1B_1"]) +
  1.25 * num(r["2B_1"]) +
  1.6 * num(r["3B_1"]) +
  2 * num(r.HR);

/** Team identity = the trimmed, non-empty ORG field. Empty ORG rows count toward the pool but form no team. */
const orgOf = (r: Row): string => String(r.ORG ?? "").trim();

export interface FlaggedTeam {
  org: string;
  /** Excess offense = teamPA × (teamRate − poolRate). Higher = more ghost-inflated. */
  excess: number;
  /** Total batting PA accumulated by the team across all its rows. */
  pa: number;
  /** The team's PA-weighted wOBA-proxy rate. */
  woba: number;
}

export interface DetectResult {
  /** expectedTeams − distinctTeamCount; the number of ghost opponents to remove (clamped ≥ 0). */
  nGhosts: number;
  /** The top-nGhosts teams by excess offense — the ghost opponents. Empty when nGhosts = 0. */
  flagged: FlaggedTeam[];
  /** PA-weighted pool mean wOBA-proxy rate across every row. */
  poolWoba: number;
  /** Distinct non-empty ORG count (for callers that want to report it). */
  distinctTeams: number;
}

/**
 * Detect ghost-opponent teams in a tournament running.
 *
 * @param rows          already-parsed CSV row objects (one per card line).
 * @param expectedTeams the tournament's fixed team count (Bronze = 128). A 16-team Bo5 "quicks"
 *                      running would pass 16 here, which recomputes both the ghost count AND the
 *                      clean ceiling (fewer teams → each ghost is a larger share of the field).
 */
export function detectGhostOpponents(rows: Row[], expectedTeams: number): DetectResult {
  let poolNum = 0;
  let poolPA = 0;
  const teams = new Map<string, { pa: number; n: number }>();

  for (const r of rows) {
    const pa = num(r.PA);
    const n = wobaNumerator(r);
    poolNum += n;
    poolPA += pa;
    const org = orgOf(r);
    if (!org) continue;
    let a = teams.get(org);
    if (!a) {
      a = { pa: 0, n: 0 };
      teams.set(org, a);
    }
    a.pa += pa;
    a.n += n;
  }

  const poolWoba = poolPA > 0 ? poolNum / poolPA : 0;
  const ranked: FlaggedTeam[] = [...teams.entries()]
    .map(([org, a]) => {
      const woba = a.pa > 0 ? a.n / a.pa : 0;
      return { org, excess: a.pa * (woba - poolWoba), pa: a.pa, woba };
    })
    .sort((x, y) => y.excess - x.excess);

  const distinctTeams = teams.size;
  const nGhosts = Math.max(0, expectedTeams - distinctTeams);
  return { nGhosts, flagged: ranked.slice(0, nGhosts), poolWoba, distinctTeams };
}

export interface CleanResult {
  /** All rows EXCEPT those belonging to a flagged ghost-opponent team (order preserved). */
  cleaned: Row[];
  /** The removed rows (belonging to flagged teams). */
  removed: Row[];
}

/**
 * Remove every row belonging to a detected ghost-opponent team.
 * When nGhosts = 0 (a clean running), `cleaned` equals `rows` and `removed` is empty.
 */
export function cleanTournamentRows(rows: Row[], expectedTeams: number): CleanResult {
  const { flagged } = detectGhostOpponents(rows, expectedTeams);
  const drop = new Set(flagged.map((f) => f.org));
  const cleaned: Row[] = [];
  const removed: Row[] = [];
  for (const r of rows) {
    if (drop.has(orgOf(r))) removed.push(r);
    else cleaned.push(r);
  }
  return { cleaned, removed };
}
