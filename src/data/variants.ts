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
  "83846", // Tris Speaker BOS 1910 — badge ME, VAL 100 (Derek, 2026-07-22)
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

/** The rule names, for reporting and for the pin. */
export const VARIANT_FORBIDDEN_RULES: readonly string[] = FORBIDDEN.map(([n]) => n);
