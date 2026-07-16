// cwhit audit #1 — TRIANGULATION: OUR prediction vs cwhit's PROJECTION vs OBSERVED, per pitcher
// channel, for Bronze Quick. cwhit's projections are his own tournament-trained model (memory:
// weight ZERO as truth) — here used purely as a THIRD reference: where HIS model matches observed
// and OURS doesn't = our defect (his tournament-native model captured a frame effect we can't fit);
// where BOTH miss observed = engine/sample mystery. Directly informs the parked M8 question.
//   run: node tools/cwhit-triangulate.ts
// Join: projected rows carry the FULL card title (== our catalog //Card Title, exact) so
// projected→our-card is by title; observed→our-card is the existing name+VAL+VLvl+Hand join.
import { readFileSync } from "node:fs";
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { resolveCoeffs, type Model } from "../src/config/coeff-resolve.ts";
import type { Era, Park, Tournament } from "../src/config/tournament.ts";
import { makeRawPolyModel, computeUnifiedFieldStats, buildPoolTransform, applyAffine, applyWobaWeights, type EventForm, type FieldStats, type PoolTransform, type Coeffs, type WobaWeights, type RatingEnvelope } from "../src/scoring-core/index.ts";
import { parseCatalogCsv, type Card } from "../src/data/catalog.ts";
import { PIT_BIP_ADJ } from "../src/model/curves.ts";
import { parseCwhitPit } from "../src/eval/cwhit/index.ts";
import { joinCwhit, type JoinCard, type JoinObs } from "../src/eval/cwhit/index.ts";

const BF9 = 4.3 * 9, PER600_TO_9 = BF9 / 600;
const n = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const handLetter = (c: number) => (c === 2 ? "L" : c === 3 ? "S" : "R");
const fmt = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "n/a");
const FIELD_N = 50, CAP = 69;

const repo = new Repository("data");
await seedDefaults(repo); await seedEras(repo); await seedAccounts(repo);
const state = (await repo.load<{ activeModelId?: string; catalogSourceId?: string }>("state", "app")) ?? {};
type TM = { id: string; eventForm?: EventForm; wobaWeights?: WobaWeights; ratingEnvelope?: RatingEnvelope; platoon?: { pit: { hand: string; vsRHB: number; vsLHB: number }[] } };
const trained = (await repo.loadAll<TM>("trained-models")).find((x) => x.id === state.activeModelId)!;
const rp = makeRawPolyModel(trained.eventForm!);
const model = (await repo.loadAll<Model>("models"))[0]!;
const eras = new Map((await repo.loadAll<Era>("eras")).map((e) => [e.id, e]));
const parks = new Map((await repo.loadAll<Park>("parks")).map((p) => [p.id, p]));
const bq = (await repo.loadAll<Tournament>("tournaments")).find((t) => t.id === "bronze-quick")!; // neutral env
const coeffs = resolveCoeffs(model, eras.get(bq.eraId)!, parks.get(bq.parkId)!, bq.softcaps);
applyWobaWeights(coeffs, trained.wobaWeights!);
const pitExp = new Map(trained.platoon!.pit.map((p) => [p.hand, { wR: p.vsRHB, wL: p.vsLHB }]));

const catalog = parseCatalogCsv(readFileSync(`data/imports/${state.catalogSourceId ?? "cdmx"}.csv`, "utf8"));
const baseCards = catalog.cards.filter((c) => String(c["Variant"] ?? "").toUpperCase() !== "Y");
const isPit = (c: Card) => n(c["Pitcher Role"]) > 0 || String(c["Position"]).trim() === "1";
const cardName = (c: Card) => `${(c["FirstName"] ?? "").trim()} ${(c["LastName"] ?? "").trim()}`.trim();
const pr = (c: Card, k: string, s: "R" | "L") => n(c[`${k} v${s}`]);
const ref: FieldStats = computeUnifiedFieldStats(baseCards, coeffs, rp, FIELD_N, true);
const basePool = baseCards.filter((c) => n(c["Card Value"]) <= CAP);
const pt: PoolTransform = buildPoolTransform(ref, computeUnifiedFieldStats(basePool, coeffs, rp, FIELD_N, true), trained.ratingEnvelope);

/** Combined own-gap pitcher line → per-9 channels for a card (deployed path). */
function combinedPit(c: Card) {
  const { wR, wL } = pitExp.get(handLetter(n(c["Throws"]))) ?? { wR: 0.5, wL: 0.5 };
  const side = (s: "R" | "L") => { const t = pt.pit[s === "R" ? "vR" : "vL"]; return rp.predictPitching({ con: applyAffine(pr(c, "Control", s), t?.con), stu: applyAffine(pr(c, "Stuff", s), t?.stu), pbabip: applyAffine(pr(c, "pBABIP", s), t?.pbabip), hrr: applyAffine(pr(c, "pHR", s), t?.hrr) }, coeffs); };
  const eR = side("R"), eL = side("L");
  const BB = wR * eR.BB + wL * eL.BB, K = wR * eR.K + wL * eL.K, HR = wR * eR.HR + wL * eL.HR, nHH = wR * eR.nHH + wL * eL.nHH;
  const BIP = Math.max(600 - BB - K - HR - PIT_BIP_ADJ, 1);
  return { k9: K * PER600_TO_9, bb9: BB * PER600_TO_9, hr9: HR * PER600_TO_9, babip: nHH / BIP, stuff: pr(c, "Stuff", "R") };
}

// our-side JoinCards (fingerprint for the observed join) + a title→our-pred map for the projected join.
type Pred = { k9: number; bb9: number; hr9: number; babip: number; stuff: number };
const ourByTitle = new Map<string, Pred>();
const ourCards: JoinCard[] = [];
const starterProxy = (st: number) => Math.max(0, Math.min(1, (st - 20) / 40));
for (const c of baseCards) {
  if (!isPit(c) || n(c["Card Value"]) > CAP) continue;
  const p = combinedPit(c);
  ourByTitle.set(String(c["//Card Title"]), p);
  ourCards.push({ cid: String(c["Card ID"]), name: cardName(c), val: n(c["Card Value"]), vlvl: 0, hand: handLetter(n(c["Throws"])), primary: [starterProxy(n(c["Stamina"])), p.babip], validate: [p.k9, p.bb9, p.hr9] });
  // v5 variant is also eligible + appears in cwhit; include its title too (ratings boosted — but the
  // projected TSV keys by the same base title with VLvl 5, and our catalog title for v5 == base title,
  // so map the base title; the observed join keys vlvl separately). Keep it simple: base only here.
}

// PROJECTED: title → { kpct,bbpct,hrpct,babip } (his model). Convert %/PA to per-9 for comparison.
const projByTitle = new Map<string, { k9: number; bb9: number; hr9: number; babip: number }>();
for (const line of readFileSync("fixtures/cwhit-proj/cwhit-bronze-pit-proj.tsv", "utf8").split(/\r?\n/)) {
  if (!line || line.startsWith("#") || line.startsWith("Name\t")) continue;
  const c = line.split("\t"); if (c.length < 12) continue;
  const title = c[0]!, kpct = n(c[8]), bbpct = n(c[9]), hrpct = n(c[10]), babip = n(c[11]);
  projByTitle.set(title, { k9: kpct / 100 * BF9, bb9: bbpct / 100 * BF9, hr9: hrpct / 100 * BF9, babip });
}

// OBSERVED (cached) → join to our cards.
const { rows: obsRows } = parseCwhitPit(readFileSync("fixtures/cwhit/cwhit-bronze-pit.tsv", "utf8"));
const obs: JoinObs<typeof obsRows[0]>[] = obsRows.map((r) => ({ name: r.name, val: r.val, vlvl: r.vlvl, hand: r.hand, primary: [r.gsPer, r.babip], validate: [r.k9, r.bb9, r.hr9], sample: r.ip, row: r }));
const joined = joinCwhit(obs, ourCards);

// Triangulate: for each observed match with a projected entry (same card title), collect the trio.
type Trio = { title: string; stuff: number; ip: number; obs: Pred; ours: Pred; proj: { k9: number; bb9: number; hr9: number; babip: number } };
const trios: Trio[] = [];
const catById = new Map(baseCards.map((c) => [String(c["Card ID"]), c]));
for (const m of joined.matched) {
  const cat = catById.get(m.card.cid); if (!cat) continue;
  const title = String(cat["//Card Title"]);
  const proj = projByTitle.get(title); const ours = ourByTitle.get(title); if (!proj || !ours) continue;
  const o = m.obs.row;
  trios.push({ title, stuff: ours.stuff, ip: o.ip, obs: { k9: o.k9, bb9: o.bb9, hr9: o.hr9, babip: o.babip, stuff: ours.stuff }, ours, proj });
}
console.log(`[triangulate] Bronze Quick pit: ${joined.matched.length} observed matched to our cards; ${trios.length} of those ALSO have a cwhit projection.\n`);

const deep = trios.filter((t) => t.ip >= 1000); // well-sampled observed
const stats = (xs: number[]) => { const m = xs.reduce((a, b) => a + b, 0) / xs.length; return { m, sd: Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / xs.length) }; };
const corr = (xs: number[], ys: number[]) => { const n = xs.length, mx = stats(xs).m, my = stats(ys).m; let cv = 0, vx = 0, vy = 0; for (let i = 0; i < n; i++) { cv += (xs[i]! - mx) * (ys[i]! - my); vx += (xs[i]! - mx) ** 2; vy += (ys[i]! - my) ** 2; } return cv / Math.sqrt(vx * vy); };
const mad = (pred: number[], obs: number[]) => pred.reduce((a, p, i) => a + Math.abs(p - obs[i]!), 0) / pred.length; // mean abs error vs observed

console.log(`═══ WHO TRACKS OBSERVED BETTER? (well-sampled, IP≥1000, N=${deep.length}) — mean |pred−obs| and corr ═══`);
console.log(`channel   ours: MAE  corr   |  cwhit-proj: MAE  corr   |  winner (lower MAE)`);
for (const [ch, lbl] of [["k9", "K9"], ["bb9", "BB9"], ["hr9", "HR9"], ["babip", "BABIP"]] as const) {
  const ob = deep.map((t) => t.obs[ch]), ou = deep.map((t) => t.ours[ch]), pj = deep.map((t) => t.proj[ch]);
  const maeO = mad(ou, ob), maeP = mad(pj, ob), d = ch === "babip" ? 3 : 2;
  console.log(`${lbl.padEnd(8)}  ${fmt(maeO, d)}  ${fmt(corr(ou, ob), 2)}   |  ${fmt(maeP, d)}  ${fmt(corr(pj, ob), 2)}   |  ${maeP < maeO ? "CWHIT" : "OURS"} ${Math.abs(maeP - maeO) < (ch === "babip" ? 0.002 : 0.15) ? "(tie)" : ""}`);
}

console.log(`\n═══ THE STUFF/K QUESTION — K9 bias (pred − obs) by STUFF bin: does cwhit track high-stuff K where we don't? ═══`);
console.log(`stuff bin        N   obs K9   ours K9 (bias)   cwhit K9 (bias)`);
for (const [lbl, lo, hi] of [["low <75", 0, 75], ["mid 75-100", 75, 100], ["high 100+", 100, 999]] as const) {
  const b = deep.filter((t) => t.stuff >= lo && t.stuff < hi); if (!b.length) continue;
  const oK = stats(b.map((t) => t.obs.k9)).m, uK = stats(b.map((t) => t.ours.k9)).m, pK = stats(b.map((t) => t.proj.k9)).m;
  console.log(`${lbl.padEnd(14)} ${String(b.length).padStart(3)}  ${fmt(oK)}    ${fmt(uK)} (${uK - oK >= 0 ? "+" : ""}${fmt(uK - oK)})    ${fmt(pK)} (${pK - oK >= 0 ? "+" : ""}${fmt(pK - oK)})`);
}
console.log(`\n(ours own-gap-applied, deployed path; cwhit-proj = his tournament-trained model; obs = cwhit raw events.)`);
process.exit(0);
