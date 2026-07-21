// THE cwhit CORPUS REGISTRY — the ONE place that knows which cwhitstats formats exist, what each is
// called on the site, which old fixture slug it used to carry, and which tournament config states its
// RULES. Everything that needs "the list of captured formats" imports it from here.
//
// WHY THIS EXISTS: the format list was independently re-declared in at least five tools
// (`tools/cwhit-audit.ts`, `tools/realized-depth.ts`, `tools/hit-tail-bakeoff.ts`, `tools/hr-reconcile.ts`,
// `tools/park-hand-contrast.ts`), each with its own spelling of the same formats and its own idea of
// which ones have configs. That is the same drift failure CLAUDE.md bans for scoring math, one layer
// out. New formats previously required an edit in every one of those places; a missed edit is silent.
//
// SCOPE: this is MEASUREMENT plumbing. No scoring math, no value judgements, no windows invented here.
//
// ── THE RULE/OBSERVATION BOUNDARY (do not blur it) ──────────────────────────
// A capture header carries `obsval=<lo>-<hi>`. That is the VAL range of cards that HAPPENED TO PLAY,
// not the format's eligibility rule. `latebronze` pit reads `obsval=51-69` while `late-bronze.json`
// has `card_value_min: null` — the 51 is the lowest-VAL pitcher anyone used, and freezing it as a
// window would invent a rule the game does not have. Card VAL 40 is the game's floor
// (memory: card-value-floor-is-40), so a `*..69` window IS 40–69.
// ⇒ eligibility windows come from the TOURNAMENT CONFIG. `obsval` is recorded for provenance only.

/** One captured cwhitstats format. */
export interface CwhitFormat {
  /** Stable short key = the site's `tourney_key` stem, without the trailing date token. */
  key: string;
  /** The full capture key as it appears in the file name and the `# CAP key=` header
   *  (`<key>__<YYYYMMDD>`). The date token is the format's effective-from / version stamp as the site
   *  reports it — NOT the capture date (every 2026-07-21 capture covers 2026-07-05..2026-07-19).
   *  Corroborated by `diamondcapdaily__20260527`, whose label reads "Diamond Cap Daily (from
   *  2026-05-27)". Carried verbatim; nothing derives meaning from it. */
  captureKey: string;
  /** The site's dropdown label, verbatim from the capture header's `label=`. */
  label: string;
  /** The site's `type` token: Quick | Daily | Weekly. Verbatim. */
  type: string;
  /** The slug this format carried in the OLD top-100 fixtures (`fixtures/cwhit/cwhit-<slug>-<role>.tsv`),
   *  when it had one. Five 2026-07-21 formats are new and have no legacy fixture. */
  legacySlug?: string;
  /** `data/tournaments/<id>.json` — the authority for the eligibility window and the era/park env.
   *  Every captured format now has one: iron/silver/diamond-quick were created 2026-07-21 (Derek
   *  override of 2bac554, which had recorded them as deliberately configless because the scorecard
   *  derives those tiers from the QUICK ladder on the shared neutral env). Optional in the type only
   *  so a newly captured format can be registered before its config is written. */
  tournamentId?: string;
  /** True when the format runs on the neutral env (era-2010 / park-1) that `buildCwhitSample`'s single
   *  `coeffs` bag assumes. FALSE formats must be scored one-format-at-a-time under their own resolved
   *  coeffs (the `tools/park-hand-contrast.ts` pattern) — scoring them under the neutral bag is wrong,
   *  not merely imprecise. */
  neutralEnv: boolean;
}

/** The 14 formats captured 2026-07-21 at full depth. Config ids verified against `data/tournaments/`;
 *  `neutralEnv` reflects that config's eraId/parkId (era-2010 + park-1 ⇒ neutral). */
export const CWHIT_CORPUS: CwhitFormat[] = [
  // ── the five Quick tiers: the benchmark ladder, all neutral env ──
  { key: "ironquick", captureKey: "ironquick__20260313", label: "Iron Quick", type: "Quick", legacySlug: "iron", tournamentId: "iron-quick", neutralEnv: true },
  { key: "bronzequick", captureKey: "bronzequick__20260313", label: "Bronze Quick", type: "Quick", legacySlug: "bronze", tournamentId: "bronze-quick", neutralEnv: true },
  { key: "silverquick", captureKey: "silverquick__20260313", label: "Silver Quick", type: "Quick", legacySlug: "silver", tournamentId: "silver-quick", neutralEnv: true },
  { key: "goldquick", captureKey: "goldquick__20260313", label: "Gold Quick", type: "Quick", legacySlug: "gold", tournamentId: "gold-quick", neutralEnv: true },
  { key: "diamondquick", captureKey: "diamondquick__20260313", label: "Diamond Quick", type: "Quick", legacySlug: "diamond", tournamentId: "diamond-quick", neutralEnv: true },
  // ── non-neutral formats: each carries its own era/park ──
  { key: "bronzeheart", captureKey: "bronzeheart__20260330", label: "Bronze Heart", type: "Daily", legacySlug: "bronzeheartdaily", tournamentId: "bronze-heart", neutralEnv: false },
  { key: "earlygold", captureKey: "earlygold__20260314", label: "Early Gold", type: "Daily", legacySlug: "earlygolddaily", tournamentId: "early-gold", neutralEnv: false },
  { key: "diamondheart", captureKey: "diamondheart__20260331", label: "Diamond Heart", type: "Daily", tournamentId: "diamond-heart", neutralEnv: false },
  { key: "latebronze", captureKey: "latebronze__20260313", label: "Late Bronze", type: "Daily", tournamentId: "late-bronze", neutralEnv: false },
  { key: "diamondcapdaily", captureKey: "diamondcapdaily__20260527", label: "Diamond Cap Daily (from 2026-05-27)", type: "Daily", legacySlug: "diamondcapdaily", tournamentId: "diamond-cap-daily", neutralEnv: false },
  { key: "goldcapdaily", captureKey: "goldcapdaily__20260314", label: "Gold Cap Daily", type: "Daily", legacySlug: "goldcapdaily", tournamentId: "gold-cap", neutralEnv: false },
  // ── neutral env but a BUDGET (cap/slots), so out of the Quick ladder for a different reason ──
  { key: "bronzecapweekly", captureKey: "bronzecapweekly__20260314", label: "Saturday Bronze Cap", type: "Weekly", tournamentId: "bronze-cap-weekly", neutralEnv: true },
  { key: "goldslotsdaily", captureKey: "goldslotsdaily__20260314", label: "Gold Slots Daily", type: "Daily", tournamentId: "gold-slots", neutralEnv: true },
  { key: "liveopendaily", captureKey: "liveopendaily__20260313", label: "Live Open Daily", type: "Daily", tournamentId: "live-open-daily", neutralEnv: true },
];

export const CAPTURE_DIR_2026_07_21 = "fixtures/cwhit-capture-2026-07-21";

export const formatByKey = (key: string): CwhitFormat | undefined => CWHIT_CORPUS.find((f) => f.key === key);
export const formatByLegacySlug = (slug: string): CwhitFormat | undefined => CWHIT_CORPUS.find((f) => f.legacySlug === slug);

/** Capture file paths. Observed sit in the capture dir; projections in its `proj/` subdirectory. */
export const captureObsPath = (dir: string, f: CwhitFormat, role: "pit" | "hit"): string =>
  `${dir}/cap__${f.captureKey}__${role}.txt`;
export const captureProjPath = (dir: string, f: CwhitFormat, role: "pit" | "hit"): string =>
  `${dir}/proj/proj__${f.captureKey}__${role}.txt`;

// ── THE READ-TIME TOP-N DERIVED VIEW ────────────────────────────────────────
//
// ONE corpus on disk (full depth); the historical top-100 shape is reconstructed AT READ TIME so the
// depth contrast is a knob rather than a second set of files (Fable ruling, 2026-07-21).
//
// THE SORT KEY IS NOT ONE RULE — it differs by table AND by role, and getting it wrong silently
// selects the WRONG HUNDRED rather than failing:
//   · OBSERVED tables were "top 100 by IP" (pit) / "by PA" (hit) — a USAGE cut, descending.
//   · PROJECTED tables were "top 100 by pwOBA" — a QUALITY cut, and DIRECTIONAL: for hitters the best
//     cards are the HIGHEST pwOBA, for pitchers the LOWEST (it is wOBA *allowed*). Verified against the
//     captures' own arrival order: proj pit is sorted ascending, proj hit descending.
// Both are verified against the old fixture headers, which state their cut verbatim
// (`fixtures/cwhit/cwhit-bronze-pit.tsv:1` = "top 100 by IP";
//  `fixtures/cwhit-proj/cwhit-bronze-pit-proj.tsv:1` = "top 100 by pwOBA").
//
// NOT APPLIED TO THE POOL. `PoolDist` is built from OUR catalog, not from a cwhit table, and is
// deliberately the FULL pool — it is the reference the top-100 is selected FROM, which is the whole
// point of the selection test. Nothing here can reach it, and nothing here should be made to.
export const LEGACY_TOP_N = 100;

/** Sort DESCENDING by "better", so a top-N view is always `slice(0, n)`. */
export type CwhitTable = "obs" | "proj";

export function rankKey(table: CwhitTable, role: "pit" | "hit"): { field: string; desc: boolean } {
  if (table === "obs") return { field: role === "pit" ? "ip" : "pa", desc: true };
  // pwOBA allowed: lower is better for a pitcher, higher for a hitter.
  return { field: "pwoba", desc: role === "hit" };
}

/**
 * Reconstruct the historical top-N cut over already-parsed rows. Pure, stable, and non-mutating:
 * ties keep their original relative order, so a view of a full-depth table that is already sorted the
 * same way is exactly its prefix.
 *
 * `n === undefined` OR `n >= rows.length` ⇒ the IDENTITY: the same array reference, arrival order
 * untouched. "Full depth" must hand back the corpus exactly as captured, never a re-sorted copy.
 * When it DOES truncate, rows with a non-finite rank value lose to every parseable row — a missing IP
 * is a parse problem to surface, not a row to silently promote into the sample.
 */
export function topNView<R extends Record<string, unknown>>(
  rows: R[], table: CwhitTable, role: "pit" | "hit", n?: number,
): R[] {
  if (n === undefined || n >= rows.length) return rows;
  const { field, desc } = rankKey(table, role);
  const keyed = rows.map((r, i) => ({ r, i, v: Number(r[field]) }));
  keyed.sort((a, b) => {
    const av = Number.isFinite(a.v), bv = Number.isFinite(b.v);
    if (av !== bv) return av ? -1 : 1;          // finite first
    if (!av) return a.i - b.i;
    return a.v === b.v ? a.i - b.i : (desc ? b.v - a.v : a.v - b.v);
  });
  return keyed.slice(0, n).map((k) => k.r);
}
