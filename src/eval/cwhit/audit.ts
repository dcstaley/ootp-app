// cwhitstats CALIBRATION AUDIT core (Batch 2). Pure predicted-vs-observed machinery: per-channel
// bias with card-level CIs, 1-D and 2-D rating-bin tables, and a ranked defect list in mwOBA.
// GROUND-TRUTH DISCIPLINE (memory cwhitstats-external-data): the OBSERVED side is cwhit's RAW
// EVENT rates (trustworthy box-score aggregates); his wOBA/projection columns are NOT truth.
//
// wOBA reconstruction: cwhit's PITCHER table has no 1B/2B/3B split, so an observed pitcher wOBAA
// cannot be rebuilt exactly — we assemble a PROXY wOBAA from (K9,BB9,HR9,BABIP) with a fixed XBH
// share, applied IDENTICALLY to the predicted and observed lines, so the wOBAA bias is fully
// attributable to those four channels (and each channel's own bias is reported alongside). This is
// a MEASUREMENT reconstruction of observed events, not card scoring — the scoring core is untouched.
// The HITTER table carries the full breakdown, so hitter wOBA is reconstructed exactly (the recon
// that validated at corr 0.986 vs cwhit's column).

export interface WobaWeights { bb: number; hbp: number; b1: number; xbh: number; hr: number }

/** BF per 9 IP (IP_TO_BF × 9) → the per-600-BF ⇄ per-9 bridge. 600/38.7 ≈ 15.5 nine-IP units / 600 BF. */
export const BF_PER9 = 4.3 * 9;                 // 38.7
export const PER9_TO_PER600 = 600 / BF_PER9;    // 15.50 — multiply a per-9 rate to get per-600-BF
const PIT_HBP_PER600 = 6;                        // model's fixed pitcher HBP allotment (PIT_BIP_ADJ)

/** Proxy wOBA-against from a pitcher's four observed/predicted per-9 channels + BABIP. Same assembly
 *  both sides ⇒ the bias is channel-attributable. `xbhShare` = fraction of non-HR hits that go for
 *  extra bases (the model uses a fixed 0.25 for pitchers). */
export function pitWobaFromChannels(k9: number, bb9: number, hr9: number, babip: number, w: WobaWeights, xbhShare = 0.25): number {
  const BB = bb9 * PER9_TO_PER600, K = k9 * PER9_TO_PER600, HR = hr9 * PER9_TO_PER600;
  const BIP = Math.max(600 - BB - K - HR - PIT_HBP_PER600, 1);
  const nHH = babip * BIP, XBH = xbhShare * nHH, oneB = nHH - XBH;
  return (w.bb * BB + w.hbp * PIT_HBP_PER600 + w.b1 * oneB + w.xbh * XBH + w.hr * HR) / 600;
}

/** Reconstruct a HITTER's wOBA from cwhit's full rate breakdown (per-PA). `hbpRate` = HBP per PA
 *  (cwhit omits HBP; a small fixed rate). Mirrors the corr-0.986-validated recon. */
export function hitWobaFromRates(r: { bbPct: number; soPct: number; hr600: number; babip: number; avg: number; slg: number; tripleXbh: number }, w: WobaWeights, hbpRate = 0.008): number {
  const bb = r.bbPct / 100, k = r.soPct / 100, hr = r.hr600 / 600;
  const bip = Math.max(1 - bb - hbpRate - k - hr, 0);
  const hNonHR = r.babip * bip, H = hNonHR + hr;
  const basesPerHit = r.avg > 0 ? r.slg / r.avg : 1;
  const nonHRbases = basesPerHit * H - 4 * hr;
  const r3 = r.tripleXbh / 100;                            // triples as a fraction of XBH(=2B+3B)
  const xbh = Math.max((nonHRbases - hNonHR) / (1 + r3), 0);
  const oneB = Math.max(hNonHR - xbh, 0);
  return w.bb * bb + w.hbp * hbpRate + w.b1 * oneB + w.xbh * xbh + w.hr * hr;
}

// ── binning + CI ─────────────────────────────────────────────────────────────
/** One audited card: its rating axes + the matched predicted & observed channel values. */
export interface AuditRow {
  cid: string; name: string; tier: string; role: "pit" | "hit";
  sample: number;                       // IP or PA
  ratings: Record<string, number>;      // e.g. { con, stu, hrr, pbabip } or { eye, pow, kRat, babip, gap }
  pred: Record<string, number>;         // predicted channel values (incl. a "woba" key)
  obs: Record<string, number>;          // observed channel values (incl. a "woba" key)
}

export interface BinStat {
  label: string; channel: string;
  n: number; sample: number;
  meanPred: number; meanObs: number;
  bias: number;                         // meanPred − meanObs (card-level mean)
  sd: number; se: number; ciLo: number; ciHi: number;  // 95% CI on the mean bias (card-level)
}

/** Card-level mean bias (pred − obs) for one channel over a set of rows, with a normal 95% CI. Cards
 *  are the unit (each is a ~0-noise huge-sample observation); the spread is real card-to-card variation. */
export function channelBias(rows: AuditRow[], channel: string, label = "all"): BinStat {
  const ds = rows.map((r) => (r.pred[channel] ?? NaN) - (r.obs[channel] ?? NaN)).filter((x) => Number.isFinite(x));
  const n = ds.length;
  const mean = n ? ds.reduce((a, b) => a + b, 0) / n : NaN;
  const sd = n > 1 ? Math.sqrt(ds.reduce((a, d) => a + (d - mean) ** 2, 0) / (n - 1)) : 0;
  const se = n ? sd / Math.sqrt(n) : NaN;
  const mp = mean_(rows, (r) => r.pred[channel]), mo = mean_(rows, (r) => r.obs[channel]);
  return { label, channel, n, sample: rows.reduce((a, r) => a + r.sample, 0), meanPred: mp, meanObs: mo, bias: mean, sd, se, ciLo: mean - 1.96 * se, ciHi: mean + 1.96 * se };
}
const mean_ = (rows: AuditRow[], get: (r: AuditRow) => number | undefined): number => {
  const xs = rows.map(get).filter((x): x is number => Number.isFinite(x as number));
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
};

/** Assign each row to a bin by `axis` rating and edges (e.g. [40,55,70,85]); returns bin bias stats. */
export function biasByBin(rows: AuditRow[], channel: string, axis: string, edges: number[]): BinStat[] {
  const labels = binLabels(edges);
  return labels.map((label, i) => {
    const lo = i === 0 ? -Infinity : edges[i - 1]!, hi = i === labels.length - 1 ? Infinity : edges[i]!;
    const inBin = rows.filter((r) => { const v = r.ratings[axis]; return v != null && v >= lo && v < hi; });
    return { ...channelBias(inBin, channel, label), label };
  });
}

/** 2-D bins (e.g. con × stu): a grid of channel-bias cells. */
export function bias2D(rows: AuditRow[], channel: string, axisX: string, edgesX: number[], axisY: string, edgesY: number[]): { x: string; y: string; stat: BinStat }[] {
  const lx = binLabels(edgesX), ly = binLabels(edgesY);
  const out: { x: string; y: string; stat: BinStat }[] = [];
  lx.forEach((xl, xi) => {
    const xlo = xi === 0 ? -Infinity : edgesX[xi - 1]!, xhi = xi === lx.length - 1 ? Infinity : edgesX[xi]!;
    ly.forEach((yl, yi) => {
      const ylo = yi === 0 ? -Infinity : edgesY[yi - 1]!, yhi = yi === ly.length - 1 ? Infinity : edgesY[yi]!;
      const cell = rows.filter((r) => { const a = r.ratings[axisX], b = r.ratings[axisY]; return a != null && b != null && a >= xlo && a < xhi && b >= ylo && b < yhi; });
      out.push({ x: xl, y: yl, stat: channelBias(cell, channel, `${xl}×${yl}`) });
    });
  });
  return out;
}

function binLabels(edges: number[]): string[] {
  if (!edges.length) return ["all"];
  const out = [`<${edges[0]}`];
  for (let i = 1; i < edges.length; i++) out.push(`${edges[i - 1]}–${edges[i]}`);
  out.push(`≥${edges[edges.length - 1]}`);
  return out;
}

/** A ranked defect = a channel/bin whose |bias| is significant (CI excludes 0), scored by effect ×
 *  prevalence. `effectMwoba` is the caller's per-channel mwOBA translation of the bias; `prevalence`
 *  = the share of pool sample the bin covers. Sorted by |effect×prevalence| desc. */
export interface Defect { key: string; channel: string; biasMwoba: number; ciLoMwoba: number; ciHiMwoba: number; n: number; prevalence: number; score: number; significant: boolean }
export function rankDefects(defects: Omit<Defect, "score" | "significant">[]): Defect[] {
  return defects
    .map((d) => ({ ...d, significant: d.ciLoMwoba * d.ciHiMwoba > 0, score: Math.abs(d.biasMwoba) * d.prevalence }))
    .sort((a, b) => b.score - a.score);
}

/** Population SD of a channel's values across rows — for the elite-tail spread comparison. */
export const spread = (rows: AuditRow[], get: (r: AuditRow) => number): number => {
  const xs = rows.map(get).filter((x) => Number.isFinite(x));
  if (xs.length < 2) return 0;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / xs.length);
};
