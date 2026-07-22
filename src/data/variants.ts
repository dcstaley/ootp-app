// M2c — variants (D6), v5-only (see decision: drop old levels 1-4 + the vlvl
// selector). A variant is the v5-boosted copy of a base card. Variant and base
// share a Card ID but the variant row carries Variant="Y"; they are mutually
// exclusive on a roster (enforced at selection, M4).

import type { Card } from "./catalog.ts";
import { cardId } from "./catalog.ts";

// Rating fields boosted by a variant (ported verbatim from old dataset.tsx
// VARIANT_RATING_FIELDS). Non-rating fields are copied unchanged.
export const VARIANT_RATING_FIELDS = [
  "BABIP vR", "BABIP vL", "Eye vR", "Eye vL", "Avoid K vR", "Avoid K vL",
  "Gap vR", "Gap vL", "Power vR", "Power vL",
  "BABIP", "Eye", "Gap", "Avoid Ks",
  "Stuff vR", "Stuff vL", "Control vR", "Control vL", "pBABIP vR", "pBABIP vL", "pHR vR", "pHR vL",
  "Speed", "Steal Rate", "Stealing", "Baserunning", "Hold",
  "DP", "Infield Range", "Infield Error", "Infield Arm", "CatcherAbil", "CatcherFrame", "Catcher Arm",
  "Pos Rating C", "Pos Rating 1B", "Pos Rating 2B", "Pos Rating 3B", "Pos Rating SS",
  "Pos Rating LF", "Pos Rating CF", "Pos Rating RF", "OF Range", "OF Error", "OF Arm",
] as const;

/** v5 boost — the old applyVariantBoost(row, 5) per-field formula. */
export function variantBoost(v: number): number {
  return v + Math.floor((5 * v + 40) / 80) + 2;
}

/** Produce a card's v5 variant row (boosted ratings, Variant="Y"). */
export function makeVariant(base: Card): Card {
  const out: Card = { ...base };
  for (const k of VARIANT_RATING_FIELDS) {
    const raw = base[k];
    const n = raw === "" || raw === undefined || raw === null ? NaN : Number(raw);
    if (Number.isFinite(n)) out[k] = String(variantBoost(n));
  }
  out["Variant"] = "Y";
  out["//Card Title"] = `★ ${base["//Card Title"] ?? ""} v5`;
  return out;
}

export const isVariant = (c: Card): boolean => String(c["Variant"] ?? "").trim().toUpperCase() === "Y";

/** Distinguishes a variant row from its base while sharing the Card ID. */
export const variantKey = (c: Card): string => `${cardId(c)}${isVariant(c) ? "#V" : ""}`;

// ═══ VARIANT ELIGIBILITY — WHICH CARDS CAN HAVE A v5 AT ALL ═══════════════════
//
// Derek, 2026-07-22: not every card can be a variant. Live, LE, PTMS, Clubhouse, Mission Edition,
// PTCS and PTWC cannot — with ONE exception class, below. Nothing in the codebase encoded this, and
// `Card Type` / `Card Sub Type` / `Card Badge` were read nowhere in src/ or web/.
//
// Full derivation, per-rule counts and the empirical evidence: docs/CARD_VARIANT_ELIGIBILITY.md.
// Verdicts are backed by the 2026-07-21 capture corpus: each forbidden class was observed at VLvl 5
// exactly ZERO times across its played members (Live 0-of-717, Clubhouse 0-of-106, LE 0-of-81,
// Mission Edition 0-of-37, PTCS 0-of-20, PTMS 0-of-7).
//
// WHERE THIS APPLIES, AND WHERE IT MUST NOT. Production never invents a variant — it materialises
// only what the user declares (`account.ts` variantCardIds, `server.ts` variants_allowed), so this
// predicate is not a production gate and adding one would change nothing. It exists for code that
// constructs HYPOTHETICAL variants to model a field. That code must not fabricate a v5 for a card
// which cannot have one.
//
// IT MUST NOT GATE A JOIN CANDIDATE SET. `buildCwhitSample` and `opponentSet` enumerate base+v5 as
// candidates for matching OBSERVED rows. An observed v5 row is proof a variant exists, and the
// override list below is INCOMPLETE BY CONSTRUCTION (see below) — so gating the candidate set could
// drop a real observed variant and would fail silently. Enumerate permissively, weight by eligibility.

/** The forbidden classes, each a named rule. Mutually disjoint on the 2026-07-21 catalog; the union
 *  is 1610 of 3669 cards (43.9%), and 51.4% of the iron window. */
const FORBIDDEN: ReadonlyArray<readonly [string, (c: Card) => boolean]> = [
  ["Live", (c) => String(c["Card Type"] ?? "").trim() === "1"],
  ["LE", (c) => String(c["Card Sub Type"] ?? "").trim() === "LE"],
  ["PTMS", (c) => String(c["Card Sub Type"] ?? "").trim() === "PTMS"],
  ["Clubhouse", (c) => String(c["Card Badge"] ?? "").trim() === "CS"],
  ["MissionEdition", (c) => String(c["Card Badge"] ?? "").trim() === "ME"],
  ["PTCS", (c) => String(c["Card Badge"] ?? "").trim() === "PTCS"],
  ["IconPreOrder", (c) => String(c["Card Series"] ?? "").trim() === "Icon Pre-Orders"],
  // THE ONE FRAGILE RULE: PTWC carries no badge, no distinguishing type and no sub-type — only this
  // title prefix. A title-format change silently re-admits these cards, so it is pinned in
  // tests/variant-eligibility.test.ts rather than trusted.
  ["PTWC", (c) => String(c["//Card Title"] ?? "").startsWith("PTWC ")],
];

/** DEV OVERRIDES — cards whose class forbids a variant but which have one anyway.
 *
 *  Derek: "the game devs can manually override this and add those cards as variants (ex: we now have
 *  variant Tris Speaker even though he's a mission edition)". So the class rule is a DEFAULT, never
 *  an authority, and THIS LIST IS INCOMPLETE BY CONSTRUCTION: it cannot be derived from the catalog,
 *  and the capture corpus cannot reveal most of it (Tris Speaker is VAL 100, outside all five Quick
 *  windows, so no amount of tournament data would show him). It grows only when an override is
 *  observed or supplied. Any consumer that treats the class rule as complete is silently wrong on
 *  every exception. */
export const VARIANT_OVERRIDES: ReadonlySet<string> = new Set<string>([
  "83846", // Tris Speaker BOS 1910 — badge ME (Derek, 2026-07-22)
  "82762", // Roy Campanella BRO 1951 — series Icon Pre-Orders. NOT supplied by hand: the detector
           // below found it in the league exports (VAR=Y) the moment the Icon Pre-Orders rule
           // landed, which is the mechanism working exactly as intended.
]);

/** The forbidden class a card falls in, or null if none. Null does NOT mean "has a variant" — only
 *  that nothing forbids one. Returns the FIRST matching rule; the rules are disjoint, so first-match
 *  and only-match coincide (pinned). */
export function variantForbiddenClass(c: Card): string | null {
  for (const [name, test] of FORBIDDEN) if (test(c)) return name;
  return null;
}

/** CAN this card have a v5? Class default, overridden by the explicit dev-override list. */
export const canHaveVariant = (c: Card): boolean =>
  VARIANT_OVERRIDES.has(cardId(c)) || variantForbiddenClass(c) === null;

/** THE STANDING DETECTOR (Derek, 2026-07-22: "ensure we have a mechanism for detecting these as they
 *  come up"). Given observed variant sightings — a league export row with `VAR=Y`, or a cwhit capture
 *  row at `VLvl 5` — return the ones our class rule says are IMPOSSIBLE.
 *
 *  A non-empty result means exactly one of two things, and both need a human:
 *    · a NEW DEV OVERRIDE — add the card id to VARIANT_OVERRIDES; or
 *    · OUR CLASS RULE IS WRONG OR INCOMPLETE — a class we have not encoded, or one we encoded badly.
 *  It can never mean "noise": an observed variant is proof a variant exists.
 *
 *  This is the only way the override list can grow, because it cannot be derived from the catalog —
 *  the catalog records no variant rows at all. Run it wherever observed data enters: model training
 *  (league `VAR` column) and each cwhit capture pull (`VLvl` column). `tests/variant-eligibility.test.ts`
 *  runs it over both corpora on every suite run, so new data trips it without anyone remembering to look. */
export function unexpectedVariantSightings<T extends { cardId: string; source: string }>(
  sightings: Iterable<T>, cardOf: (id: string) => Card | undefined,
): Array<T & { forbiddenClass: string; title: string }> {
  const out: Array<T & { forbiddenClass: string; title: string }> = [];
  const seen = new Set<string>();
  for (const s of sightings) {
    if (seen.has(s.cardId)) continue;
    const c = cardOf(s.cardId);
    if (!c) continue;                                   // not in this catalog snapshot — not our call
    if (VARIANT_OVERRIDES.has(s.cardId)) continue;      // already a known, recorded exception
    const forbiddenClass = variantForbiddenClass(c);
    if (!forbiddenClass) continue;
    seen.add(s.cardId);
    out.push({ ...s, forbiddenClass, title: String(c["//Card Title"] ?? "") });
  }
  return out;
}

/** The rule names, for reporting and for the pin. */
export const VARIANT_FORBIDDEN_RULES: readonly string[] = FORBIDDEN.map(([n]) => n);

// ═══ PRESENCE-WEIGHTED POOL CONSTRUCTION (C2' of the 2026-07-22 constants event) ══
//
// Fable ruling (o)/(t): arm C — "fields variant-inclusive everywhere" — was REFUTED and replaced by
// EMPIRICAL COMPARABILITY. Both legs of a comparison must be unbiased estimates of real populations
// in the same units. Arm C failed that: it gave every eligible card a v5, so the pool field came out
// 84-96% variant against a training leg that is 2.5% variant by qualifying pitcher usage — an ~85
// point mismatch where the status quo's was ~2.5.
//
// The replacement weights an eligible card's v5 at `p` and its base at `1-p`, with p the measured
// CONDITIONAL presence (v5 usage / ELIGIBLE-CLASS usage, so ineligible-class play cannot sit in the
// denominator). Ineligible cards contribute their base at weight 1 — they have no v5 to weight.
//
// EXACT, NOT APPROXIMATED. A mixture cannot be handed to `computeUnifiedFieldStats`, which takes a
// plain card array and an integer top-N. For rational p = k/m it is exactly representable by INTEGER
// REPLICATION: emit each ineligible card m times, and each eligible card as (m-k) base copies plus k
// v5 copies, then ask for top-N × m. Duplicates carry identical predicted value, so the top-(N·m) of
// the replicated population IS the weighted top-N of the mixture and its moments ARE the weighted
// moments. The shared core computes all of it — no weighted-moment variant exists anywhere, which
// would have been a second copy of scoring maths.

/** Replication denominator. 10 resolves p to 0.1 steps, which covers the ruled 0.30 and its
 *  0.25/0.35 sensitivity re-checks exactly (0.25 needs m=20; see `presenceMixture`). */
export const PRESENCE_M = 20;

/** THE SHIPPED PRESENCE PRIOR — the fraction of an eligible card's field weight carried by its v5.
 *
 *  0.30 is the centre of the MEASURED conditional band (pitchers 25.7-42.6%, hitters 21.8-42.3%
 *  across the ten format×role cells; league 5.2%/17.4%), recorded by Fable ruling (t) as a
 *  DELIBERATE SIMPLIFICATION of a proxy coordinate rather than a claim that p is constant — it is
 *  not: conditioning WIDENED the spread rather than collapsing it. The justification is the proxy
 *  principle: the gap is an x-axis needing CONSISTENCY, SPREAD and EX-ANTE COMPUTABILITY, not truth,
 *  and the empirical fit absorbs the level and scale of any consistent coordinate.
 *
 *  Property-conditioning was REJECTED: the natural conditioner (a format's eligible-usage share) is
 *  REALIZED, so conditioning on it would put a non-ex-ante quantity into a coordinate that must be
 *  computable before a tournament is played.
 *
 *  UNDER A STANDING TRIPWIRE (drift doctrine): every capture re-pull recomputes realized conditional
 *  presence and compares it here. Inside 0.25-0.35 ⇒ no action. Outside ⇒ a p-update is flagged for
 *  the next refit event, retrain-coupled exactly like FIELD_N, because the ramp is fit AT this p and
 *  the gap is NOT monotone in it (measured: iron 23.64/21.22/22.15/21.59/19.06 across p=0..1). A
 *  ramp may never be rescaled from another p — it must be re-derived. */
export const PRESENCE_P = 0.30;

/** The mixture population at presence `p`, exact by integer replication. Pass `topN * PRESENCE_M`
 *  to any top-N consumer, or the cohort silently shrinks by a factor of m. */
export function presenceMixture(pool: Card[], p: number = PRESENCE_P, m: number = PRESENCE_M): Card[] {
  const k = Math.round(p * m);
  if (Math.abs(p * m - k) > 1e-9) throw new Error(`presence p=${p} is not representable at m=${m} — it would be silently rounded`);
  const out: Card[] = [];
  for (const c of pool) {
    if (!canHaveVariant(c)) { for (let i = 0; i < m; i++) out.push(c); continue; }
    const v = k > 0 ? makeVariant(c) : null;
    for (let i = 0; i < m - k; i++) out.push(c);
    for (let i = 0; i < k; i++) out.push(v!);
  }
  return out;
}
