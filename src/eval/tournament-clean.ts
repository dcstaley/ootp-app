// Tournament ghost-cleaning — a reusable, data-shape-agnostic module.
//
// WHY (the PA−BF LEDGER, the decisive ghost test — 2026-07-13 forensics, roadmap Batch 1):
// A tournament running is a CLOSED system: every batting plate appearance (PA) is simultaneously
// one batter-faced (BF) on the pitching side, so a COMPLETE export satisfies ΣPA == ΣBF EXACTLY
// (validated: Return-of-the-Bronze July-11, a known-clean 128-team running, has ΣPA−ΣBF = 0 to the
// unit). Contamination = a ONE-SIDED / PARTIAL export: an org (or a ghosted manager's opponent)
// whose batting lines export but whose pitching lines don't (or vice-versa). That org carries
// PA ≫ BF, and the pool ledger ΣPA−ΣBF opens up by exactly that org's imbalance.
//
// This SUPERSEDES the earlier excess-offense heuristic (`PA × (rate − poolRate)`), which was
// retired because it TRUNCATES REAL WINNERS and manufactures a fake offense-suppression signal
// (roadmap Batch 1.1d). The ledger is name-independent, deterministic, and needs no external
// team-count assumption.
//
// DETECTOR (tuned on Return-of-the-Bronze ground truth; reproduces its validated cleaning EXACTLY):
//   1. ledger L = ΣPA − ΣBF over every row in the running.
//   2. |L| ≤ tol  ⇒  status "clean", remove nothing.
//   3. Otherwise, CULPRITS = orgs whose per-org imbalance (PA − BF) shares L's SIGN and whose own
//      |asymmetry| = |PA − BF| / (PA + BF) exceeds `asymFloor`. Sign-matching is essential: it
//      excludes opposite-sign orgs (e.g. Bronze July-7's Oslo Royals, −15.9% asym, a blown-out
//      team, NOT a partial exporter) that a bare asymmetry threshold would false-positive.
//   4. Remove the largest-|imbalance| culprits GREEDILY (each only if it moves the ledger toward 0)
//      until |residual| ≤ tol (status "cleaned") or culprits run out (status "unreliable").
//
// VALIDATION (matches Derek's in-game ground truth, byte-for-byte with the prior validated output):
//   • Bronze July-11: L=0 → clean, removes nothing.
//   • Bronze July-5:  L=+405 → removes DC Capital Giants (imb +314, asym 16.2%) → residual +91.
//   • Bronze July-7:  L=+360 → removes Portsmouth Wunderfunk (imb +401, asym 13.7%) → residual −41.
//     Note Portsmouth is only 13.7% asym — a flat >15% rule would MISS the real culprit and instead
//     flag the opposite-sign Oslo Royals. Clean orgs top out at ~4–8% asym, culprits at ≥13.7%, so
//     `asymFloor` sits in that gap (default 0.10).
//   • Early Gold (all 7 runnings): L=+228..+855 → removes 1–4 partial-export orgs each (asym 17–38%),
//     reconciling every ledger to |residual| ≤ 40.
//
// Parse conventions mirror tools/tournament-kslope.ts: numeric fields via Number() with non-finite
// → 0. Callers pass already-parsed row objects (a CSV read lives in the caller), keeping this module
// data-shape-agnostic. The batting-PA column is `PA`, the pitching batters-faced column is `BF`.

// A parsed CSV row. String-keyed; values are whatever the CSV parser produced (usually string).
export type Row = Record<string, unknown>;

/** Numeric coercion identical to tools/tournament-kslope.ts (`Number()` with non-finite → 0). */
const num = (v: unknown): number => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};

/** Team identity = the trimmed, non-empty ORG field. Empty ORG rows count toward the pool ledger
 *  (PA/BF still sum) but form no removable team. */
const orgOf = (r: Row): string => String(r.ORG ?? "").trim();

export interface DetectOptions {
  /** Absolute ledger tolerance (|ledger| below this ⇒ clean / reconciled). Overrides relTol/minTol. */
  tol?: number;
  /** Relative tolerance as a fraction of ΣPA (default 0.0035). Effective tol = max(minTol, relTol·ΣPA). */
  relTol?: number;
  /** Absolute floor for the derived tolerance (default 150). */
  minTol?: number;
  /** Per-org |asymmetry| gate for culprit eligibility (default 0.10). Clean orgs sit ≤~0.08; the
   *  lowest real culprit measured (Bronze Portsmouth) is 0.137 — 0.10 sits safely in the gap. */
  asymFloor?: number;
  /** Rows-per-entry divisor for the roster-volume entry estimate (default 26). */
  entriesPerTeam?: number;
}

/** Per-org ledger record. */
export interface OrgLedger {
  org: string;
  pa: number;
  bf: number;
  /** PA − BF. Positive = batting over-represented (partial pitching export / ghost opponent). */
  imb: number;
  /** (PA − BF) / (PA + BF); signed. |asym| is the partial-export magnitude. */
  asym: number;
  /** Row count for this org. */
  rows: number;
  /** Roster-volume entry estimate = round(rows / entriesPerTeam). >1 ⇒ a multi-entry org (one ORG
   *  string fielding several teams, e.g. the quicks case) — a roster-volume count, NEVER a name count. */
  entries: number;
}

export type DatasetStatus = "clean" | "cleaned" | "unreliable";

export interface ContaminationReport {
  /** clean = ledger already balanced; cleaned = flagged orgs removed, ledger reconciled; unreliable
   *  = ledger imbalanced but no cliff-safe set of culprits reconciles it (serve with a loud warning). */
  status: DatasetStatus;
  /** ΣPA − ΣBF over the original rows. */
  ledger: number;
  /** ΣPA − ΣBF after removing the flagged orgs (equals `ledger` when nothing is flagged). */
  residual: number;
  /** The tolerance actually applied. */
  tol: number;
  sPA: number;
  sBF: number;
  distinctOrgs: number;
  /** round(nRows / entriesPerTeam) — pool-wide roster-volume entry estimate. */
  entriesEst: number;
  /** Orgs to remove (empty when status = clean, or unreliable with no eligible culprits). */
  flagged: OrgLedger[];
  /** Every org, sorted by |imb| desc — for reporting / inspection. */
  orgs: OrgLedger[];
}

/**
 * Run the PA−BF ledger diagnostic on one tournament running and identify the partial-export orgs to
 * remove. Pure and deterministic; performs no I/O. See the module header for the method + validation.
 */
export function detectContamination(rows: Row[], opts: DetectOptions = {}): ContaminationReport {
  const asymFloor = opts.asymFloor ?? 0.1;
  const entriesPerTeam = opts.entriesPerTeam ?? 26;

  let sPA = 0;
  let sBF = 0;
  const teams = new Map<string, { pa: number; bf: number; rows: number }>();
  for (const r of rows) {
    const pa = num(r.PA);
    const bf = num(r.BF);
    sPA += pa;
    sBF += bf;
    const org = orgOf(r);
    if (!org) continue;
    let a = teams.get(org);
    if (!a) {
      a = { pa: 0, bf: 0, rows: 0 };
      teams.set(org, a);
    }
    a.pa += pa;
    a.bf += bf;
    a.rows += 1;
  }

  const orgs: OrgLedger[] = [...teams.entries()]
    .map(([org, a]) => {
      const imb = a.pa - a.bf;
      const denom = a.pa + a.bf;
      return {
        org,
        pa: a.pa,
        bf: a.bf,
        imb,
        asym: denom > 0 ? imb / denom : 0,
        rows: a.rows,
        entries: Math.max(1, Math.round(a.rows / entriesPerTeam)),
      };
    })
    .sort((x, y) => Math.abs(y.imb) - Math.abs(x.imb));

  const ledger = sPA - sBF;
  const tol = opts.tol ?? Math.max(opts.minTol ?? 150, (opts.relTol ?? 0.0035) * sPA);
  const entriesEst = Math.round(rows.length / entriesPerTeam);
  const base = {
    ledger,
    tol,
    sPA,
    sBF,
    distinctOrgs: teams.size,
    entriesEst,
    orgs,
  };

  if (Math.abs(ledger) <= tol) {
    return { ...base, status: "clean", residual: ledger, flagged: [] };
  }

  // Greedy sign-matched reconciliation: remove the largest same-sign, sufficiently-asymmetric orgs
  // until the residual ledger is within tolerance. Each removal must move the ledger TOWARD zero
  // (guards against a single over-large org overshooting into a bigger opposite imbalance).
  const sign = ledger > 0 ? 1 : -1;
  const candidates = orgs.filter((o) => Math.sign(o.imb) === sign && Math.abs(o.asym) >= asymFloor);
  const flagged: OrgLedger[] = [];
  let residual = ledger;
  for (const c of candidates) {
    if (Math.abs(residual) <= tol) break;
    if (Math.abs(residual - c.imb) >= Math.abs(residual)) continue; // removal would not help
    flagged.push(c);
    residual -= c.imb;
  }

  const status: DatasetStatus = Math.abs(residual) <= tol ? "cleaned" : "unreliable";
  return { ...base, status, residual, flagged };
}

export interface CleanResult {
  /** All rows EXCEPT those belonging to a flagged org (order preserved). */
  cleaned: Row[];
  /** The removed rows (belonging to flagged orgs). */
  removed: Row[];
  /** The full ledger diagnostic (status, ledger before/after, flagged orgs). */
  report: ContaminationReport;
}

/**
 * Remove every row belonging to a detected partial-export org. When the running is clean (or
 * unreliable with no eligible culprits), `cleaned` equals `rows` and `removed` is empty. The
 * `report.status` distinguishes clean (nothing to do) from unreliable (imbalance persists — the
 * caller should warn when serving it).
 */
export function cleanTournamentRows(rows: Row[], opts: DetectOptions = {}): CleanResult {
  const report = detectContamination(rows, opts);
  const drop = new Set(report.flagged.map((f) => f.org));
  const cleaned: Row[] = [];
  const removed: Row[] = [];
  for (const r of rows) {
    if (drop.has(orgOf(r))) removed.push(r);
    else cleaned.push(r);
  }
  return { cleaned, removed, report };
}
