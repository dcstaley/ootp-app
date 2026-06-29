// Compute per-year Era records from a Baseball-Reference league-batting CSV
// (leagues/majors/bat.shtml export). Every year is a run-environment MODIFIER
// relative to the baseline (2010 = the game's default run environment), so the
// 2010 row comes out all-1.0 (≡ neutral). Values in the CSV are per-team-game
// averages, so per-PA rates = stat/PA (the per-game scaling cancels in the ratio).
//
// Consumed by scoring: bb, k, avg(H), hr, gap. Stored-only: hbp + raw rates (so a
// future per-event recompute / baseline change needs no re-fetch). thr is a
// per-tournament knob, not an era property → always off here.
//
// bip: a BIP modifier was intentionally REMOVED from scoring (it caused problems and
//   is likely conceptually wrong), so we do NOT carry a bip modifier — it's pinned to
//   neutral 1. The raw BIP rate is still kept in `rates` for reference only.
// gap: ⚠ TEMPORARY (user 2026-06-29, pending the full gap-vs-2B/3B review) — gap = the
//   frequency-weighted average of the 2B-factor and 3B-factor = (2B+3B rate this era) /
//   (2B+3B rate 2010), i.e. the combined per-PA XBH rate ratio. (Weighting each factor by
//   its 2010 frequency collapses to this combined-rate ratio; 2B dominates.) Replaces the
//   old "XBH share of non-HR hits vs 2010" definition (kept as `gapShare` for reference).

import Papa from "papaparse";
import type { Era } from "../config/tournament.ts";

// Blank / "--" → NaN (so the ratio falls back to neutral), NOT 0 — Number("") is 0.
const num = (v: unknown): number => {
  const s = String(v ?? "").trim();
  if (s === "" || s === "--") return NaN;
  const x = Number(s);
  return Number.isFinite(x) ? x : NaN;
};
const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
const r5 = (x: number) => Math.round(x * 1e5) / 1e5;
/** Ratio guarded against missing/invalid source data → neutral 1. */
const ratio = (cur: number, base: number) => (Number.isFinite(cur) && Number.isFinite(base) && base > 0 && cur >= 0 ? cur / base : 1);

interface Rates { bb: number; k: number; hr: number; h: number; b2: number; b3: number; hbp: number; bip: number; gapShare: number }
const ratesOf = (r: Record<string, string>): Rates => {
  const pa = num(r["PA"]);
  const h = num(r["H"]), hr = num(r["HR"]), b2 = num(r["2B"]), b3 = num(r["3B"]);
  return {
    bb: num(r["BB"]) / pa, k: num(r["SO"]) / pa, hr: hr / pa, h: h / pa,
    b2: b2 / pa, b3: b3 / pa, hbp: num(r["HBP"]) / pa, bip: num(r["BIP"]) / pa,
    gapShare: (b2 + b3) / (h - hr), // XBH share of non-HR hits (what era_gap scales)
  };
};

export function computeEras(text: string, baselineYear = 2010): Era[] {
  const parsed = Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: true });
  const rows = (parsed.data ?? []).filter((r) => r && r["Year"] && num(r["PA"]) > 0);
  const baseRow = rows.find((r) => Number(r["Year"]) === baselineYear);
  if (!baseRow) throw new Error(`baseline year ${baselineYear} not found in CSV`);
  const b = ratesOf(baseRow);

  return rows.map((r) => {
    const year = Number(r["Year"]);
    const c = ratesOf(r);
    return {
      id: `era-${year}`, name: String(year),
      bb: r6(ratio(c.bb, b.bb)), k: r6(ratio(c.k, b.k)), avg: r6(ratio(c.h, b.h)),
      hr: r6(ratio(c.hr, b.hr)), gap: r6(ratio(c.b2 + c.b3, b.b2 + b.b3)), bip: 1, // gap = temp 2B+3B weighted rate; bip pinned neutral
      thr_toggle: false, thr: 1,
      year, hbp: r6(ratio(c.hbp, b.hbp)),
      rates: { bb: r5(c.bb), k: r5(c.k), hr: r5(c.hr), h: r5(c.h), b2: r5(c.b2), b3: r5(c.b3), hbp: r5(c.hbp), bip: r5(c.bip) },
    } satisfies Era;
  });
}
