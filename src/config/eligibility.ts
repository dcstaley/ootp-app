// M2b — tournament eligibility + pool construction. Faithful port of the old
// `rowEligible` (tournament.tsx ~315-384): variants gate + ALL/ANY rule group.
// Quirk preserved: incomplete rules are PERMISSIVE (e.g. num_ge with no operand
// returns true) — flagged in the roadmap as worth making explicit later.
//
// Card-value range is applied SEPARATELY from the rule group (as in the old
// frontend), inside buildEligiblePool.

import type { Card } from "../data/catalog.ts";
import type { EligibilityRule, EligibilityGroup, Tournament } from "./tournament.ts";

const s = (v: unknown): string => String(v ?? "");
const num = (v: unknown): number | null => {
  if (v === null || v === undefined || s(v).trim() === "") return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
};

type EligibilityCtx = Pick<Tournament, "variants_allowed" | "eligibility">;

export function rowEligible(card: Card, t: EligibilityCtx | null): boolean {
  if (!t) return true;

  const v = s(card["Variant"]).trim().toUpperCase();
  if (!t.variants_allowed && v === "Y") return false;

  const group: EligibilityGroup | undefined = t.eligibility;
  const mode = group?.mode ?? "ALL";
  const rules = Array.isArray(group?.rules) ? group.rules : [];
  if (!rules.length) return true;

  const evalRule = (r: EligibilityRule): boolean => {
    const col = r.column;
    if (!col) return true;
    const val = card[col];

    if (r.op === "is_blank") return !s(val).trim();
    if (r.op === "is_not_blank") return !!s(val).trim();

    if (r.op.startsWith("num_")) {
      const x = num(val);
      const a = num(r.a);
      const b = num(r.b);
      if (x === null) return false;
      switch (r.op) {
        case "num_between": return a === null || b === null ? true : x >= a && x <= b;
        case "num_ge": return a === null ? true : x >= a;
        case "num_gt": return a === null ? true : x > a;
        case "num_le": return a === null ? true : x <= a;
        case "num_lt": return a === null ? true : x < a;
        case "num_eq": return a === null ? true : x === a;
        default: return true;
      }
    }

    if (r.op === "set_in" || r.op === "set_not_in") {
      const vals = (r.values ?? []).map((x) => String(x));
      if (!vals.length) return true;
      const hit = vals.includes(s(val).trim());
      return r.op === "set_in" ? hit : !hit;
    }

    if (r.op === "text_contains" || r.op === "text_equals") {
      const q = s(r.a).trim();
      if (!q) return true;
      const vv = s(val);
      return r.op === "text_equals" ? vv.toLowerCase() === q.toLowerCase() : vv.toLowerCase().includes(q.toLowerCase());
    }

    return true;
  };

  return mode === "ANY" ? rules.some(evalRule) : rules.every(evalRule);
}

export interface PoolOptions {
  /** Apply the owned filter (owned > 0). The CALIBRATION pool must NOT (false);
   *  the generation/optimization pool may (true), per the active account (D6). */
  ownedOnly?: boolean;
}

/**
 * The tournament-eligible pool: card-value range + rowEligible. ownedOnly is OFF
 * by default so calibration is stable regardless of ownership (the calibration
 * pool deliberately ignores owned).
 */
export function buildEligiblePool(cards: Card[], t: Tournament, opts: PoolOptions = {}): Card[] {
  const min = t.card_value_min ?? null;
  const max = t.card_value_max ?? null;
  return cards.filter((c) => {
    const val = num(c["Card Value"]) ?? 0;
    if (min != null && val < min) return false;
    if (max != null && val > max) return false;
    if (opts.ownedOnly && (num(c["owned"]) ?? 0) <= 0) return false;
    return rowEligible(c, t);
  });
}
