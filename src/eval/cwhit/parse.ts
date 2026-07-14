// cwhitstats snapshot PARSER (Batch-1 item 4, part 1 of the join layer). Turns a scraped tier
// table (TSV, one `#`-prefixed provenance header + a column-name row + data rows) into typed rows.
// Pure + position-independent (keys by column NAME) so a re-scrape with reordered/added columns
// still parses. Ground-truth discipline (memory cwhitstats-external-data): these are cwhit's RAW
// EVENT aggregates — trustworthy box-score rates — NOT his model columns; his wOBA column is his
// own construction (we reconstruct wOBA from the events with OUR weights, so it is not surfaced as
// truth here, only carried through for reference).

/** cwhit shows only IP for pitchers; BF (batters faced) ≈ IP × 4.3 (league-typical PA/inning,
 *  ±~5%, immaterial at thousands of IP) — the bridge to our ≥250/≥500 BF eval thresholds. */
export const IP_TO_BF = 4.3;

export type CwhitRole = "pit" | "hit";

export interface CwhitMeta {
  role: CwhitRole;
  format: string;            // e.g. "Bronze Quick", "Gold Cap Daily" — the tier/format label
  coverageFrom?: string;     // ISO date (inclusive)
  coverageTo?: string;
  instances?: number;        // tournaments in the window that contributed
  totalInstances?: number;   // total tournaments of this format on the site
  topN?: number;             // the table was capped to the top-N by IP/PA
  headerLine: string;        // the raw provenance line, verbatim
}

/** One pitcher row — cwhit RAW rates (per-9 native) + a derived BF from IP. */
export interface CwhitPitRow {
  name: string; val: number; vlvl: number; hand: string;
  ip: number; gsPer: number; ipPerGame: number;
  ra9: number; era: number; wobaa: number;   // wobaa = cwhit's site-computed wOBA-against (reference only)
  k9: number; bb9: number; hr9: number; babip: number;
  bf: number;                                 // = ip × IP_TO_BF
}

/** One hitter row — cwhit RAW rates; full event breakdown ⇒ wOBA reconstructable downstream. */
export interface CwhitHitRow {
  name: string; pos: string; val: number; vlvl: number; hand: string;
  pa: number; avg: number; obp: number; slg: number; woba: number; // woba = site-computed (reference only)
  bbPct: number; soPct: number; hr600: number; babip: number; xbhPct: number; tripleXbh: number;
  wsb600: number; ubr600: number; war600: number;
}

const num = (v: string | undefined): number => { const x = Number(v); return Number.isFinite(x) ? x : NaN; };

/** Split a captured TSV into its provenance header line, the column-name row, and data rows. */
function split(tsv: string): { headerLine: string; cols: string[]; dataRows: string[][] } {
  const lines = tsv.split(/\r?\n/).filter((l) => l.length > 0);
  const headerLine = lines[0]?.startsWith("#") ? lines.shift()! : "";
  const cols = (lines.shift() ?? "").split("\t");
  const dataRows = lines.map((l) => l.split("\t"));
  return { headerLine, cols, dataRows };
}

/** Parse the `#`-provenance line: "<Format> <role-word> | coverage A to B | N of M <Format> tournaments | top K by IP". */
export function parseCwhitMeta(headerLine: string, role: CwhitRole): CwhitMeta {
  const meta: CwhitMeta = { role, format: "", headerLine };
  const body = headerLine.replace(/^#\s*/, "");
  const parts = body.split("|").map((s) => s.trim());
  if (parts[0]) meta.format = parts[0].replace(/\s+(pitchers|hitters)\s*$/i, "").trim();
  for (const p of parts.slice(1)) {
    let m: RegExpMatchArray | null;
    if ((m = p.match(/coverage\s+(\d{4}-\d{2}-\d{2})\s+to\s+(\d{4}-\d{2}-\d{2})/i))) { meta.coverageFrom = m[1]; meta.coverageTo = m[2]; }
    else if ((m = p.match(/(\d+)\s+of\s+(\d+)/))) { meta.instances = Number(m[1]); meta.totalInstances = Number(m[2]); }
    else if ((m = p.match(/top\s+(\d+)/i))) { meta.topN = Number(m[1]); }
  }
  return meta;
}

/** Build a NAME→index resolver over the column row so parsing is position-independent. */
function indexer(cols: string[]): (name: string) => number {
  const map = new Map(cols.map((c, i) => [c.trim().toLowerCase(), i]));
  return (name: string) => map.get(name.trim().toLowerCase()) ?? -1;
}
const cell = (row: string[], i: number | undefined): string | undefined => (i != null && i >= 0 ? row[i] : undefined);

export function parseCwhitPit(tsv: string): { meta: CwhitMeta; rows: CwhitPitRow[] } {
  const { headerLine, cols, dataRows } = split(tsv);
  const meta = parseCwhitMeta(headerLine, "pit");
  const at = indexer(cols);
  const [iName, iVal, iVlvl, iHand, iIp, iGs, iIpg, iRa9, iEra, iWobaa, iK9, iBb9, iHr9, iBabip] =
    ["Name", "VAL", "VLvl", "Hand", "IP", "GSper", "IPpergame", "RA9", "ERA", "wOBAA", "K9", "BB9", "HR9", "BABIP"].map(at);
  const rows = dataRows.filter((r) => cell(r, iName)).map((r): CwhitPitRow => {
    const ip = num(cell(r, iIp));
    return {
      name: (cell(r, iName) ?? "").trim(), val: num(cell(r, iVal)), vlvl: num(cell(r, iVlvl)), hand: (cell(r, iHand) ?? "").trim(),
      ip, gsPer: num(cell(r, iGs)), ipPerGame: num(cell(r, iIpg)),
      ra9: num(cell(r, iRa9)), era: num(cell(r, iEra)), wobaa: num(cell(r, iWobaa)),
      k9: num(cell(r, iK9)), bb9: num(cell(r, iBb9)), hr9: num(cell(r, iHr9)), babip: num(cell(r, iBabip)),
      bf: ip * IP_TO_BF,
    };
  });
  return { meta, rows };
}

export function parseCwhitHit(tsv: string): { meta: CwhitMeta; rows: CwhitHitRow[] } {
  const { headerLine, cols, dataRows } = split(tsv);
  const meta = parseCwhitMeta(headerLine, "hit");
  const at = indexer(cols);
  const [iName, iPos, iVal, iVlvl, iHand, iPa, iAvg, iObp, iSlg, iWoba, iBb, iSo, iHr, iBabip, iXbh, iT3, iWsb, iUbr, iWar] =
    ["Name", "POS", "VAL", "VLvl", "Hand", "PA", "AVG", "OBP", "SLG", "wOBA", "BBpct", "SOpct", "HR600", "BABIP", "XBHpct", "3B/XBH", "wSB600", "UBR600", "WAR600"].map(at);
  const rows = dataRows.filter((r) => cell(r, iName)).map((r): CwhitHitRow => ({
    name: (cell(r, iName) ?? "").trim(), pos: (cell(r, iPos) ?? "").trim(), val: num(cell(r, iVal)), vlvl: num(cell(r, iVlvl)), hand: (cell(r, iHand) ?? "").trim(),
    pa: num(cell(r, iPa)), avg: num(cell(r, iAvg)), obp: num(cell(r, iObp)), slg: num(cell(r, iSlg)), woba: num(cell(r, iWoba)),
    bbPct: num(cell(r, iBb)), soPct: num(cell(r, iSo)), hr600: num(cell(r, iHr)), babip: num(cell(r, iBabip)),
    xbhPct: num(cell(r, iXbh)), tripleXbh: num(cell(r, iT3)), wsb600: num(cell(r, iWsb)), ubr600: num(cell(r, iUbr)), war600: num(cell(r, iWar)),
  }));
  return { meta, rows };
}
