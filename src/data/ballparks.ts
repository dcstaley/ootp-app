// Parse OOTP's pt_ballparks.txt (CSV) into our Park records. The file's BA/HR/2B/3B
// factors are RAW park multipliers (~1.0) — exactly what we store (scoring applies
// cp() compression downstream). pt_id is the only unique key; park names + paths
// repeat across years, so duplicate names are disambiguated by year.
//
// Mapping: avg_l/r ← BA LH/RH · hr_l/r ← HR LH/RH · gap ← 2B Overall (+ per-hand
// gap_l/r ← 2B LH/RH and triples 3B stored for a future scoring upgrade) · metadata
// year/league/team/ptLevel for the library UI.

import Papa from "papaparse";
import type { Park } from "../config/tournament.ts";

/** A park factor: positive multiplier, else neutral (1). Guards 0/blank. */
const fac = (v: unknown): number => { const x = Number(v); return Number.isFinite(x) && x > 0 ? x : 1; };

export function parseBallparks(text: string): Park[] {
  const parsed = Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: true });
  const rows = (parsed.data ?? []).filter((r) => r && r["pt_id"]);
  const nameCount = new Map<string, number>();
  for (const r of rows) nameCount.set(r["park name"]!, (nameCount.get(r["park name"]!) ?? 0) + 1);

  return rows.map((r) => {
    const dup = (nameCount.get(r["park name"]!) ?? 0) > 1;
    const year = Number(r["year"]);
    const lvl = Number(r["pt_level"]);
    return {
      id: `park-${r["pt_id"]}`,
      name: dup && Number.isFinite(year) ? `${r["park name"]} (${r["year"]})` : String(r["park name"] ?? ""),
      avg_l: fac(r["BA LH"]), avg_r: fac(r["BA RH"]),
      hr_l: fac(r["HR LH"]), hr_r: fac(r["HR RH"]),
      gap: fac(r["2B Overall"]), gap_l: fac(r["2B LH"]), gap_r: fac(r["2B RH"]),
      triple: fac(r["3B Overall"]), triple_l: fac(r["3B LH"]), triple_r: fac(r["3B RH"]),
      year: Number.isFinite(year) ? year : undefined,
      league: r["lgID"] || undefined,
      team: r["team name"] || undefined,
      ptLevel: Number.isFinite(lvl) ? lvl : undefined,
    } satisfies Park;
  });
}
