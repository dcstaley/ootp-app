// CAP-TIGHTNESS — a budget-structure property of a tournament, computed purely from
// its config fields + the catalog's Card Value price distribution.
//
// WHY: salary caps (and slot-tier limits) force rosters to carry cheap/bad cards, so the
// REALIZED playing pool in a capped format is wider and weaker than the eligible-window pool
// our spread machinery is computed from. This tool produces the CONDITIONING VARIABLE only —
// it tests nothing. It emits no scoring math (ONE SCORING CORE); this is pure price arithmetic.
//
// PROPERTIES, NOT IDENTITY: every number below is a function of config fields
// (card_value_min/max, total_cap, slot_counts, roster_size, hitters, pitchers, budget_mode)
// and catalog Card Values. No per-tournament constant is hard-coded anywhere.
//
// Usage:  node tools/cap-tightness.ts [--json]

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseCatalogCsv, type Card } from "../src/data/catalog.ts";
import { rowEligible } from "../src/config/eligibility.ts";
import { SLOT_TIERS } from "../src/optimizer/types.ts";
import { cumulativeSlotLimits } from "../src/optimizer/roster-lp.ts";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const TOURNEY_DIR = join(ROOT, "data", "tournaments");
const CATALOG = join(ROOT, "docs", "pt_card_list.csv");

const n = (v: unknown): number => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};

interface TConfig {
  id?: string; name?: string;
  card_value_min?: number | null; card_value_max?: number | null;
  variants_allowed?: boolean | null;
  eligibility?: { mode?: "ALL" | "ANY"; rules?: unknown[] } | null;
  total_cap?: number | null; roster_size?: number | null;
  hitters?: number | null; pitchers?: number | null;
  budget_mode?: string | null; slot_counts?: Record<string, number> | null;
  eraId?: string | null; parkId?: string | null;
}

/** Mirror of server.ts budgetMode(): explicit field, else slots > cap > none. */
function budgetMode(t: TConfig): "none" | "cap" | "slots" {
  if (t.budget_mode === "cap" || t.budget_mode === "slots" || t.budget_mode === "none") return t.budget_mode;
  if (t.slot_counts && Object.keys(t.slot_counts).length) return "slots";
  if (t.total_cap && t.total_cap > 0) return "cap";
  return "none";
}

/** Eligibility window test — same field & comparison as server.ts inValueRange(). */
function inWindow(v: number, lo: number | null | undefined, hi: number | null | undefined): boolean {
  return (lo == null || v >= lo) && (hi == null || v <= hi);
}

const quantile = (sorted: number[], q: number): number => {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
};

/** Share of the pool priced at or below x (a percentile rank in price space). */
const pctRank = (sortedAsc: number[], x: number): number => {
  if (!sortedAsc.length) return NaN;
  let c = 0;
  for (const v of sortedAsc) { if (v <= x) c++; else break; }
  return c / sortedAsc.length;
};

/**
 * SLOTS: the maximum total Card Value a legal roster can spend.
 * The slots constraint is (roster-lp.ts): for each tier threshold, at most `limit` rostered
 * cards may have cost >= threshold (cumulative, implied-iron absorbs leftovers). Because the
 * constraint set is a nested family of "at most k cards above price p", the max-spend roster
 * is obtained GREEDILY price-descending: take the next most expensive card iff every tier
 * whose threshold it clears still has room. That greedy is exact for nested-threshold limits.
 * The result is an IMPLIED CAP — directly comparable to a cap format's total_cap.
 */
function slotsImpliedCap(pricesDesc: number[], slotCounts: Record<string, number>, rosterSize: number): { impliedCap: number; taken: number[] } {
  const limits = cumulativeSlotLimits(slotCounts, rosterSize);
  const used = new Map<number, number>(limits.map((l) => [l.threshold, 0]));
  const taken: number[] = [];
  for (const p of pricesDesc) {
    if (taken.length >= rosterSize) break;
    const binding = limits.filter((l) => p >= l.threshold);
    if (binding.some((l) => (used.get(l.threshold) ?? 0) >= l.limit)) continue;
    for (const l of binding) used.set(l.threshold, (used.get(l.threshold) ?? 0) + 1);
    taken.push(p);
  }
  return { impliedCap: taken.reduce((s, x) => s + x, 0), taken };
}

interface Row {
  id: string; name: string; mode: "none" | "cap" | "slots";
  eraId: string; parkId: string;
  window: string; windowMin: number | null; windowMax: number | null;
  budgetLabel: string;
  totalCap: number | null;      // explicit cap, or the slots-implied cap
  capIsImplied: boolean;
  rosterSize: number;
  poolN: number;        // after value window AND the eligibility rule group
  windowN: number;      // after the value window alone
  ruleGated: boolean;   // config carries non-window eligibility rules / a variants gate
  price: { min: number; max: number; mean: number; median: number; deciles: number[] };
  unconstrainedCost: number;    // sum of the rosterSize most expensive eligible cards
  budgetRatio: number;          // total_cap / unconstrainedCost   (1 = unconstrained, →0 = binding)
  tightness: number;            // 1 - budgetRatio, clamped to [0,1]  ← PRIMARY, higher = tighter
  meanAffordable: number;       // total_cap / rosterSize
  meanAffordablePct: number;    // that value's percentile in the eligible price distribution
  forcedCheapFrac: number;      // fraction of the roster forced down to the pool's cheapest cards
  warnings: string[];
}

function analyze(t: TConfig, cards: Card[]): Row {
  const warnings: string[] = [];
  const mode = budgetMode(t);
  const id = String(t.id ?? "(no id)");

  const lo = t.card_value_min ?? null, hi = t.card_value_max ?? null;
  // The eligible pool is the FULL server-side gate: value window AND rowEligible (the
  // Card Type / Year rule group + the variants gate). 23 of the configs carry non-window
  // rules, and they move the pool a lot (e.g. a Card-Type restriction can halve it), so
  // window-only would misstate what the budget is actually competing for. Same evaluator
  // as server.ts:401 — no second copy of the eligibility logic.
  const windowOnly = cards.filter((c) => inWindow(n(c["Card Value"]), lo, hi));
  const eligible = windowOnly.filter((c) => rowEligible(c, { variants_allowed: t.variants_allowed ?? true, eligibility: (t.eligibility ?? undefined) as never }));
  const asc = eligible.map((c) => n(c["Card Value"])).sort((a, b) => a - b);
  const desc = [...asc].reverse();

  // roster_size is the budget denominator; fall back to hitters+pitchers (what server.ts does).
  let rosterSize = t.roster_size ?? 0;
  if (!rosterSize) {
    rosterSize = n(t.hitters) + n(t.pitchers);
    if (rosterSize > 0) warnings.push(`no roster_size; using hitters+pitchers=${rosterSize}`);
  }
  if (!rosterSize) { rosterSize = 0; warnings.push("no roster_size and no hitters/pitchers"); }
  if (t.roster_size != null && n(t.hitters) + n(t.pitchers) !== t.roster_size) {
    warnings.push(`roster_size=${t.roster_size} != hitters+pitchers=${n(t.hitters) + n(t.pitchers)}`);
  }
  if (!asc.length) warnings.push("eligible pool is EMPTY for this window");
  if (mode === "cap" && !(t.total_cap && t.total_cap > 0)) warnings.push("cap mode but total_cap missing/zero");
  if (mode === "slots" && !(t.slot_counts && Object.keys(t.slot_counts).length)) warnings.push("slots mode but slot_counts missing");
  if (mode === "none" && t.total_cap && t.total_cap > 0) warnings.push(`budget_mode=none but total_cap=${t.total_cap} is set (cap ignored)`);

  const price = {
    min: asc.length ? asc[0]! : NaN,
    max: asc.length ? asc[asc.length - 1]! : NaN,
    mean: asc.length ? asc.reduce((s, x) => s + x, 0) / asc.length : NaN,
    median: quantile(asc, 0.5),
    deciles: Array.from({ length: 9 }, (_, i) => quantile(asc, (i + 1) / 10)),
  };

  // The unconstrained "best roster" cost = the rosterSize most expensive eligible cards.
  // JUDGMENT CALL: price is used as the proxy for desirability. That is the standard OOTP
  // relationship (Card Value tracks card quality) but it is a proxy, not a scored ranking —
  // deliberately so, since bringing scores in here would import the scoring core.
  const topN = desc.slice(0, rosterSize);
  const unconstrainedCost = topN.reduce((s, x) => s + x, 0);

  let totalCap: number | null = null, capIsImplied = false, budgetLabel = "—";
  if (mode === "cap") {
    totalCap = t.total_cap ?? null;
    budgetLabel = `cap ${totalCap ?? "?"}`;
  } else if (mode === "slots") {
    const sc = t.slot_counts ?? {};
    const r = slotsImpliedCap(desc, sc, rosterSize);
    totalCap = r.impliedCap; capIsImplied = true;
    budgetLabel = SLOT_TIERS.map((s) => `${s.key[0]}${sc[s.key] ?? 0}`).join("/") + ` →${r.impliedCap}`;
  } else {
    // UNCAPPED: the no-constraint end of the axis. Budget = exactly what the best roster costs,
    // so budgetRatio = 1 and tightness = 0 by construction (not by special-casing the number).
    totalCap = unconstrainedCost;
    budgetLabel = "uncapped";
  }

  const budgetRatio = unconstrainedCost > 0 && totalCap != null ? totalCap / unconstrainedCost : NaN;
  // PRIMARY METRIC. tightness = 1 - budget/best-roster-cost. 0 = the budget buys the best roster
  // outright (no real constraint); →1 = the budget is a small fraction of it (severely binding).
  // Reported as 1-ratio rather than the raw ratio so that HIGHER = TIGHTER, which is the direction
  // the later fit wants (spread discrepancy predicted to INCREASE with tightness).
  // Clamped at 0: a cap larger than the best roster is still just "unconstrained".
  const tightness = Number.isFinite(budgetRatio) ? Math.max(0, Math.min(1, 1 - budgetRatio)) : NaN;

  // COMPLEMENTARY (a): the implied mean affordable card, located in the pool's own price
  // distribution. Answers "the average roster spot buys a card at what percentile of the pool?"
  // Insensitive to the top-N tail shape, which the primary metric is exposed to.
  const meanAffordable = rosterSize > 0 && totalCap != null ? totalCap / rosterSize : NaN;
  const meanAffordablePct = Number.isFinite(meanAffordable) ? pctRank(asc, meanAffordable) : NaN;

  // COMPLEMENTARY (b): "forced cheap fraction". Build the roster top-heavy: take the k most
  // expensive cards and fill the remaining (rosterSize-k) spots from the CHEAPEST end of the pool.
  // Find the largest feasible k; then (rosterSize-k)/rosterSize is the share of the roster the
  // budget forces down to the bottom of the price distribution. This is the metric that most
  // directly encodes the hypothesis's mechanism (caps forcing bad cards onto the roster).
  let forcedCheapFrac = NaN;
  if (rosterSize > 0 && asc.length >= rosterSize && totalCap != null) {
    let best = 0;
    for (let k = 0; k <= rosterSize; k++) {
      const top = desc.slice(0, k).reduce((s, x) => s + x, 0);
      const cheap = asc.slice(0, rosterSize - k).reduce((s, x) => s + x, 0);
      if (top + cheap <= totalCap) best = k;
    }
    forcedCheapFrac = (rosterSize - best) / rosterSize;
  } else if (rosterSize > 0 && asc.length < rosterSize) {
    warnings.push(`eligible pool (${asc.length}) smaller than roster_size (${rosterSize})`);
  }

  return {
    id, name: String(t.name ?? id), mode,
    eraId: String(t.eraId ?? "—"), parkId: String(t.parkId ?? "—"),
    window: `${lo ?? "*"}..${hi ?? "*"}`, windowMin: lo, windowMax: hi,
    budgetLabel, totalCap, capIsImplied, rosterSize,
    poolN: asc.length, windowN: windowOnly.length, ruleGated: eligible.length !== windowOnly.length,
    price, unconstrainedCost, budgetRatio, tightness,
    meanAffordable, meanAffordablePct, forcedCheapFrac, warnings,
  };
}

// ── main ─────────────────────────────────────────────────────────────────────
const catalog = parseCatalogCsv(readFileSync(CATALOG, "utf8"));
const files = readdirSync(TOURNEY_DIR).filter((f) => f.endsWith(".json")).sort();
const rows: Row[] = [];
for (const f of files) {
  const t = JSON.parse(readFileSync(join(TOURNEY_DIR, f), "utf8")) as TConfig;
  if (!t.id) t.id = f.replace(/\.json$/, "");
  rows.push(analyze(t, catalog.cards));
}
rows.sort((a, b) => (b.tightness - a.tightness) || a.id.localeCompare(b.id));

if (process.argv.includes("--json")) {
  process.stdout.write(JSON.stringify({ catalog: { path: "docs/pt_card_list.csv", cards: catalog.cards.length }, tournaments: rows }, null, 2) + "\n");
} else {
  const p2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : "—");
  const p3 = (x: number) => (Number.isFinite(x) ? x.toFixed(3) : "—");
  const cols: [string, number, (r: Row) => string][] = [
    ["id", 26, (r) => r.id],
    ["name", 24, (r) => r.name],
    ["mode", 6, (r) => r.mode],
    ["era", 9, (r) => r.eraId.replace(/^era-/, "")],
    ["window", 9, (r) => r.window],
    ["budget", 26, (r) => r.budgetLabel],
    ["ros", 4, (r) => String(r.rosterSize)],
    ["poolN", 6, (r) => String(r.poolN) + (r.ruleGated ? "*" : "")],
    ["bestCost", 9, (r) => String(r.unconstrainedCost)],
    ["ratio", 6, (r) => p3(r.budgetRatio)],
    ["TIGHT", 6, (r) => p3(r.tightness)],
    ["mAff", 6, (r) => p2(r.meanAffordable)],
    ["mAff%", 6, (r) => p3(r.meanAffordablePct)],
    ["cheap%", 7, (r) => p3(r.forcedCheapFrac)],
  ];
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(cols[i]![1])).join(" ").trimEnd();
  console.log(line(cols.map((c) => c[0])));
  console.log(cols.map((c) => "-".repeat(c[1])).join(" "));
  for (const r of rows) console.log(line(cols.map((c) => c[2](r))));

  console.log("\n  * poolN marked with * = config carries non-window eligibility rules (Card Type / Year)");
  console.log("    and/or a variants gate, so its pool is narrower than the bare value window.");

  console.log("\nPrice distribution of the eligible pool (deciles D1..D9), one line per distinct pool:");
  const seen = new Set<string>();
  for (const r of rows) {
    const key = `${r.window}|${r.poolN}`;
    if (seen.has(key)) continue;
    seen.add(key);
    console.log(`  ${r.id.padEnd(24)} window ${r.window.padEnd(9)} N=${String(r.poolN).padStart(5)} (window-only ${String(r.windowN).padStart(5)})  min=${r.price.min} max=${r.price.max} mean=${p2(r.price.mean)} med=${p2(r.price.median)}  D=[${r.price.deciles.map((d) => d.toFixed(0)).join(",")}]`);
  }

  const warned = rows.filter((r) => r.warnings.length);
  console.log(`\nData-quality flags (${warned.length}):`);
  for (const r of warned) console.log(`  ${r.id}: ${r.warnings.join("; ")}`);

  // Matched-pair sanity checks — pairs are looked up BY ID for reporting only; every number
  // printed comes from the property computation above, none is keyed to tournament identity.
  const by = new Map(rows.map((r) => [r.id, r]));
  const pairs: [string, string][] = [["bronze-cap-weekly", "bronze-quick"], ["gold-cap", "gold-quick"], ["nightmare-cap", "bronze-cap"]];
  console.log("\nMatched-pair sanity checks:");
  for (const [a, b] of pairs) {
    const ra = by.get(a), rb = by.get(b);
    if (!ra || !rb) { console.log(`  ${a} vs ${b}: MISSING (${!ra ? a : b})`); continue; }
    const cmp = ra.tightness > rb.tightness ? "TIGHTER than" : ra.tightness < rb.tightness ? "LOOSER than" : "EQUAL to";
    console.log(`  ${a} (era ${ra.eraId}, ${ra.window}, ${ra.budgetLabel}) TIGHT=${p3(ra.tightness)} cheap%=${p3(ra.forcedCheapFrac)}`);
    console.log(`  ${b} (era ${rb.eraId}, ${rb.window}, ${rb.budgetLabel}) TIGHT=${p3(rb.tightness)} cheap%=${p3(rb.forcedCheapFrac)}`);
    console.log(`    ⇒ ${a} is ${cmp} ${b}\n`);
  }
}
