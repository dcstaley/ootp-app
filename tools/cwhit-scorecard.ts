// THE STANDING BENCHMARK SCORECARD (work-order P1d) — us vs cwhit-native vs observed, per
// channel × role × tier. Re-runnable; picks up new fixtures automatically.
//   run: node tools/cwhit-scorecard.ts
//
// WHY THIS SUPERSEDES tools/cwhit-triangulate.ts (v1). v1's headline was mean|pred−obs|, which
// CONFLATES level and shape — banned under the two-axis doctrine. Our known out-of-frame LEVEL
// biases live deliberately in the eval stack, not the scoring path, so a level "loss" to cwhit can
// merely restate a known, accepted gap. The M8-relevant number is per-card SHAPE after level
// alignment. This tool reports LEVEL / SHAPE / SPREAD separately, each with a CI, plus a paired
// bootstrap on the ours-minus-cwhit gap. It also fixes three v1 defects found while building it:
//   (1) v1 keyed the projected join on card TITLE ALONE while only ever building VLvl-0 predictions —
//       but 69 of the 100 projected bronze rows are VLvl 5. So v1 compared cwhit's VARIANT projection
//       against our BASE prediction and the BASE observed line. Since v5 boosts Stuff, that
//       mechanically inflates his predicted K — plausibly manufacturing v1's "cwhit runs hot on K
//       +1.2..1.4" headline. Here the join key is (title, VLvl) and we score the real variant.
//   (2) v1 never stated the WINDOW OVERLAP: cwhit's model is trained INSIDE the observed window we
//       judge on (semi-in-sample) while ours is honest OOS. Printed per table now.
//   (3) v1 never surfaced cwhit's rate CONVENTIONS (his hitter SO% is K/AB, not K/PA).
//
// DOCTRINE: cwhit's RAW OBSERVED events = ground truth. His PROJECTIONS = a competitor benchmark,
// weight ZERO as truth, NEVER a fitting target. His pwOBA column is never used as truth.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { resolveCoeffs, type Model } from "../src/config/coeff-resolve.ts";
import type { Era, Park, Tournament } from "../src/config/tournament.ts";
import {
  makeRawPolyModel, computeUnifiedFieldStats, buildPoolTransform, applyAffine, applyWobaWeights,
  type EventForm, type FieldStats, type PoolTransform, type RatingEnvelope, type WobaWeights,
} from "../src/scoring-core/index.ts";
import { parseCatalogCsv, type Card } from "../src/data/catalog.ts";
import { makeVariant } from "../src/data/variants.ts";
import { PIT_BIP_ADJ, HIT_BIP_ADJ } from "../src/model/curves.ts";
import { parseCwhitPit, parseCwhitHit, joinCwhit, type JoinCard, type JoinObs } from "../src/eval/cwhit/index.ts";
import { hitWobaFromRates, pitWobaFromChannels, type WobaWeights as WW } from "../src/eval/cwhit/audit.ts";
import {
  parseCwhitProjPit, parseCwhitProjHit, windowOverlap, agreement, duel, pearson, xbhNonHrPerPa,
  soPctPerAbToPerPa, abPerPa, per9NoiseVar, babipNoiseVar, pctNoiseVar, per600NoiseVar, BF_PER_9,
  type Agreement, type CwhitProjMeta,
} from "../src/eval/cwhit/scorecard.ts";

const OBS = "fixtures/cwhit", PROJ = "fixtures/cwhit-proj", FIELD_N = 50;
const MIN_IP = 1000, MIN_PA = 1000;   // "well-sampled" thresholds (v1 used IP≥1000; kept for continuity)
const QUICK = [{ tier: "iron", cap: 59 }, { tier: "bronze", cap: 69 }, { tier: "silver", cap: 79 }, { tier: "gold", cap: 89 }, { tier: "diamond", cap: 99 }];
const n_ = (v: unknown): number => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const handLetter = (c: number) => (c === 2 ? "L" : c === 3 ? "S" : "R");
const f = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "n/a");
const sgn = (x: number, d = 2) => (Number.isFinite(x) ? `${x >= 0 ? "+" : ""}${x.toFixed(d)}` : "n/a");

// ── deployed model + neutral env ─────────────────────────────────────────────
const repo = new Repository("data");
await seedDefaults(repo); await seedEras(repo); await seedAccounts(repo);
const state = (await repo.load<{ activeModelId?: string; catalogSourceId?: string }>("state", "app")) ?? {};
type TM = { id: string; eventForm?: EventForm; wobaWeights?: WobaWeights; ratingEnvelope?: RatingEnvelope; platoon?: { pit: { hand: string; vsRHB: number; vsLHB: number }[]; hit: { hand: string; vsRHP: number; vsLHP: number }[] } };
const trained = (await repo.loadAll<TM>("trained-models")).find((x) => x.id === state.activeModelId);
if (!trained?.eventForm || !trained.wobaWeights || !trained.platoon) throw new Error("active model missing eventForm/wobaWeights/platoon");
const rp = makeRawPolyModel(trained.eventForm);
const W = trained.wobaWeights as WW;
const envelope = trained.ratingEnvelope;
const model = (await repo.loadAll<Model>("models"))[0]!;
const eras = new Map((await repo.loadAll<Era>("eras")).map((e) => [e.id, e]));
const parks = new Map((await repo.loadAll<Park>("parks")).map((p) => [p.id, p]));
const bq = (await repo.loadAll<Tournament>("tournaments")).find((t) => t.id === "bronze-quick")!;   // neutral era/park
const coeffs = resolveCoeffs(model, eras.get(bq.eraId)!, parks.get(bq.parkId)!, bq.softcaps);
applyWobaWeights(coeffs, trained.wobaWeights);
const pitExp = new Map(trained.platoon.pit.map((p) => [p.hand, { wR: p.vsRHB, wL: p.vsLHB }]));
const hitExp = new Map(trained.platoon.hit.map((p) => [p.hand, { wR: p.vsRHP, wL: p.vsLHP }]));

const srcId = state.catalogSourceId ?? "cdmx";
const baseCards = parseCatalogCsv(readFileSync(`data/imports/${srcId}.csv`, "utf8")).cards.filter((c) => String(c["Variant"] ?? "").toUpperCase() !== "Y");
const isPit = (c: Card) => n_(c["Pitcher Role"]) > 0 || String(c["Position"]).trim() === "1";
const cardName = (c: Card) => `${(c["FirstName"] ?? "").trim()} ${(c["LastName"] ?? "").trim()}`.trim();
const ref: FieldStats = computeUnifiedFieldStats(baseCards, coeffs, rp, FIELD_N, true);

// ── our predicted lines (deployed own-gap path) ──────────────────────────────
/** Pitcher: combined own-gap line → per-9 channels + a proxy wOBAA on OUR weights. */
function ourPit(c: Card, pt: PoolTransform) {
  const { wR, wL } = pitExp.get(handLetter(n_(c["Throws"]))) ?? { wR: 0.5, wL: 0.5 };
  const side = (s: "R" | "L") => {
    const t = pt.pit[s === "R" ? "vR" : "vL"];
    return rp.predictPitching({ con: applyAffine(n_(c[`Control v${s}`]), t?.con), stu: applyAffine(n_(c[`Stuff v${s}`]), t?.stu), pbabip: applyAffine(n_(c[`pBABIP v${s}`]), t?.pbabip), hrr: applyAffine(n_(c[`pHR v${s}`]), t?.hrr) }, coeffs);
  };
  const eR = side("R"), eL = side("L");
  const BB = wR * eR.BB + wL * eL.BB, K = wR * eR.K + wL * eL.K, HR = wR * eR.HR + wL * eL.HR, nHH = wR * eR.nHH + wL * eL.nHH;
  const BIP = Math.max(600 - BB - K - HR - PIT_BIP_ADJ, 1);
  const per9 = BF_PER_9 / 600;
  const ch = { k9: K * per9, bb9: BB * per9, hr9: HR * per9, babip: nHH / BIP };
  return { ...ch, woba: pitWobaFromChannels(ch.k9, ch.bb9, ch.hr9, ch.babip, W), stuff: n_(c["Stuff vR"]) };
}
/** Hitter: combined own-gap line → per-PA channels + wOBA (BATTING-ONLY, to match cwhit's convention). */
function ourHit(c: Card, pt: PoolTransform) {
  const { wR, wL } = hitExp.get(handLetter(n_(c["Bats"]))) ?? { wR: 0.5, wL: 0.5 };
  const side = (s: "R" | "L") => {
    const t = pt.hit[s === "R" ? "vR" : "vL"];
    return rp.predictHitting({ eye: applyAffine(n_(c[`Eye v${s}`]), t?.eye), pow: applyAffine(n_(c[`Power v${s}`]), t?.pow), kRat: applyAffine(n_(c[`Avoid K v${s}`]), t?.kRat), babip: applyAffine(n_(c[`BABIP v${s}`]), t?.babip), gap: applyAffine(n_(c[`Gap v${s}`]), t?.gap), speed: n_(c["Speed"]), steal: n_(c["Steal Rate"]), run: n_(c["Baserunning"]) }, coeffs);
  };
  const eR = side("R"), eL = side("L");
  const BB = wR * eR.BB + wL * eL.BB, SO = wR * eR.SO + wL * eL.SO, HR = wR * eR.HR + wL * eL.HR, oneB = wR * eR.oneB + wL * eL.oneB, GAP = wR * eR.GAP + wL * eL.GAP;
  const BIP = Math.max(600 - BB - SO - HR - HIT_BIP_ADJ, 1);
  // Batting-only wOBA (NO baserunning) — cwhit's wOBA is batting-only, so this is the like-for-like metric.
  const woba = (W.bb * BB + W.hbp * 6 + W.b1 * oneB + W.xbh * GAP + W.hr * HR) / 600;
  return { bbPct: BB / 6, soPct: SO / 6, hr600: HR, babip: (oneB + GAP) / BIP, woba, pow: n_(c["Power vR"]) };
}

// ── fixture discovery (glob-driven; nothing hard-coded to bronze) ────────────
const obsFiles = existsSync(OBS) ? readdirSync(OBS) : [];
const projFiles = existsSync(PROJ) ? readdirSync(PROJ) : [];
const hasObs = (tier: string, role: "pit" | "hit") => obsFiles.includes(`cwhit-${tier}-${role}.tsv`);
const projFile = (tier: string, role: "pit" | "hit") => (projFiles.includes(`cwhit-${tier}-${role}-proj.tsv`) ? `${PROJ}/cwhit-${tier}-${role}-proj.tsv` : null);

type Chan = Record<string, number>;
interface Rec { tier: string; role: "pit" | "hit"; title: string; name: string; vlvl: number; sample: number; axis: number; ours: Chan; obs: Chan; proj?: Chan }
const recs: Rec[] = [];
const windows: { tier: string; role: string; w: ReturnType<typeof windowOverlap>; meta: CwhitProjMeta; conv: string[] }[] = [];
const notices: string[] = [];
const projUnjoined: string[] = [];

for (const { tier, cap } of QUICK) {
  const basePool = baseCards.filter((c) => n_(c["Card Value"]) <= cap);
  const pt = buildPoolTransform(ref, computeUnifiedFieldStats(basePool, coeffs, rp, FIELD_N, true), envelope);

  for (const role of ["pit", "hit"] as const) {
    if (!hasObs(tier, role)) { notices.push(`no observed fixture ${OBS}/cwhit-${tier}-${role}.tsv → tier×role skipped entirely`); continue; }

    // our side: base (VLvl 0) + v5 variant, keyed by (title, vlvl) — the projected join key.
    const cards: JoinCard[] = [];
    const byCid = new Map<string, { title: string; vlvl: number; ours: Chan; axis: number }>();
    for (const bc of baseCards) {
      for (const [vlvl, c] of [[0, bc], [5, makeVariant(bc)]] as const) {
        if (n_(c["Card Value"]) > cap) continue;
        if (role === "pit" ? !isPit(c) : isPit(c)) continue;
        const cid = `${bc["Card ID"]}|${vlvl}`;
        const p = role === "pit" ? ourPit(c, pt) : ourHit(c, pt);
        const fp = role === "pit"
          ? { primary: [Math.max(0, Math.min(1, (n_(c["Stamina"]) - 20) / 40)), (p as ReturnType<typeof ourPit>).babip], validate: [(p as ReturnType<typeof ourPit>).k9, (p as ReturnType<typeof ourPit>).bb9, (p as ReturnType<typeof ourPit>).hr9] }
          : { primary: [(p as ReturnType<typeof ourHit>).babip], validate: [(p as ReturnType<typeof ourHit>).bbPct, (p as ReturnType<typeof ourHit>).soPct, (p as ReturnType<typeof ourHit>).hr600] };
        cards.push({ cid, name: cardName(c), val: n_(c["Card Value"]), vlvl, hand: handLetter(n_(c[role === "pit" ? "Throws" : "Bats"])), ...fp });
        const all = p as Record<string, number>;
        const axisKey = role === "pit" ? "stuff" : "pow";
        const ours: Chan = {};
        for (const [k, v] of Object.entries(all)) if (k !== axisKey) ours[k] = v;
        byCid.set(cid, { title: String(bc["//Card Title"]), vlvl, ours, axis: all[axisKey]! });
      }
    }

    // projected side (optional): (title|vlvl) → his channels, in OUR units.
    const pf = projFile(tier, role);
    let projBy: Map<string, Chan> | null = null;
    if (!pf) { notices.push(`no projected fixture ${PROJ}/cwhit-${tier}-${role}-proj.tsv → ${tier} ${role} runs on the OBSERVED-ONLY axis (ours vs observed)`); }
    else {
      projBy = new Map();
      const conv: string[] = [];
      let meta: CwhitProjMeta;
      if (role === "pit") {
        const p = parseCwhitProjPit(readFileSync(pf, "utf8"), pf); meta = p.meta;
        conv.push(`K/BB/HR %-columns read as per-BATTER-FACED (per-PA), converted to per-9 with BF/9=${BF_PER_9.toFixed(1)} — the SAME constant our per-600 line uses, so the constant cancels in ours-vs-cwhit and touches only the vs-observed LEVEL`);
        for (const r of p.rows) projBy.set(`${r.title}|${r.vlvl}`, { k9: r.kPerPa * BF_PER_9, bb9: r.bbPerPa * BF_PER_9, hr9: r.hrPerPa * BF_PER_9, babip: r.babip, woba: pitWobaFromChannels(r.kPerPa * BF_PER_9, r.bbPerPa * BF_PER_9, r.hrPerPa * BF_PER_9, r.babip, W) });
      } else {
        const p = parseCwhitProjHit(readFileSync(pf, "utf8"), pf); meta = p.meta;
        if (p.rows[0]) { conv.push(`SO: ${p.rows[0].soConvention}`); conv.push(`HR: ${p.rows[0].hrConvention}`); conv.push(`XBH: ${p.rows[0].xbhConvention}`); }
        conv.push(`his pwOBA column NOT used as truth; wOBA recomputed from his projected events with OUR weights, BATTING-ONLY (no BsR) to match his convention and our woba_* metric — never our Offense score`);
        for (const r of p.rows) {
          const hrPa = r.hrPer600 / 600;
          const bip = Math.max(1 - r.bbPerPa - 0.008 - r.kPerPa - hrPa, 0.01);
          const nonHR = r.babip * bip, H = nonHR + hrPa;
          // Use HIS OWN XBHpct when present (convention measured, see xbhNonHrPerPa) rather than a
          // fixed share — a fixed share would erase exactly the card-to-card XBH variation that the
          // wOBA SHAPE verdict is supposed to be judging him on.
          const xbh = Number.isFinite(r.xbhPct) ? xbhNonHrPerPa(r.xbhPct, H, hrPa) : 0.30 * nonHR;
          projBy.set(`${r.title}|${r.vlvl}`, {
            bbPct: r.bbPerPa * 100, soPct: r.kPerPa * 100, hr600: r.hrPer600, babip: r.babip,
            woba: W.bb * r.bbPerPa + W.hbp * 0.008 + W.b1 * Math.max(nonHR - xbh, 0) + W.xbh * xbh + W.hr * hrPa,
          });
        }
      }
      const parsed = role === "pit" ? parseCwhitPit(readFileSync(`${OBS}/cwhit-${tier}-${role}.tsv`, "utf8")).meta : parseCwhitHit(readFileSync(`${OBS}/cwhit-${tier}-${role}.tsv`, "utf8")).meta;
      windows.push({ tier, role, meta, conv, w: windowOverlap(parsed.coverageFrom, parsed.coverageTo, meta.trainFrom, meta.trainTo) });
    }

    // observed → our cards (the EXISTING fingerprint join; not rebuilt).
    if (role === "pit") {
      const { rows } = parseCwhitPit(readFileSync(`${OBS}/cwhit-${tier}-pit.tsv`, "utf8"));
      const obs: JoinObs<typeof rows[0]>[] = rows.map((r) => ({ name: r.name, val: r.val, vlvl: r.vlvl, hand: r.hand, primary: [r.gsPer, r.babip], validate: [r.k9, r.bb9, r.hr9], sample: r.ip, row: r }));
      const j = joinCwhit(obs, cards);
      for (const m of j.matched) {
        const our = byCid.get(m.card.cid)!, o = m.obs.row;
        const key = `${our.title}|${our.vlvl}`;
        recs.push({ tier, role, title: our.title, name: o.name, vlvl: our.vlvl, sample: o.ip, axis: our.axis, ours: our.ours,
          obs: { k9: o.k9, bb9: o.bb9, hr9: o.hr9, babip: o.babip, woba: pitWobaFromChannels(o.k9, o.bb9, o.hr9, o.babip, W) },
          proj: projBy?.get(key) });
      }
      if (projBy) { const seen = new Set(recs.filter((r) => r.tier === tier && r.role === role).map((r) => `${r.title}|${r.vlvl}`)); for (const k of projBy.keys()) if (!seen.has(k)) projUnjoined.push(`${tier} ${role}: ${k}`); }
    } else {
      const { rows } = parseCwhitHit(readFileSync(`${OBS}/cwhit-${tier}-hit.tsv`, "utf8"));
      const obs: JoinObs<typeof rows[0]>[] = rows.map((r) => ({ name: r.name, val: r.val, vlvl: r.vlvl, hand: r.hand, primary: [r.babip], validate: [r.bbPct, r.soPct, r.hr600], sample: r.pa, row: r }));
      const j = joinCwhit(obs, cards);
      for (const m of j.matched) {
        const our = byCid.get(m.card.cid)!, o = m.obs.row;
        // cwhit's observed SO% is K/AB → convert to our K/PA convention before ANY comparison.
        const soPa = soPctPerAbToPerPa(o.soPct, o.avg, o.obp, o.bbPct);
        recs.push({ tier, role, title: our.title, name: o.name, vlvl: our.vlvl, sample: o.pa, axis: our.axis, ours: our.ours,
          obs: { bbPct: o.bbPct, soPct: soPa, hr600: o.hr600, babip: o.babip, woba: hitWobaFromRates({ ...o, soPct: soPa }, W) },
          proj: projBy?.get(`${our.title}|${our.vlvl}`) });
      }
      if (projBy) { const seen = new Set(recs.filter((r) => r.tier === tier && r.role === role).map((r) => `${r.title}|${r.vlvl}`)); for (const k of projBy.keys()) if (!seen.has(k)) projUnjoined.push(`${tier} ${role}: ${k}`); }
    }
  }
}

// ── noise variance of each observed value (for spread deconvolution) ─────────
function noiseOf(r: Rec, ch: string): number {
  if (r.role === "pit") {
    const bf = r.sample * 4.3;
    const bip = Math.max(bf - (r.obs.k9! + r.obs.bb9! + r.obs.hr9!) / BF_PER_9 * bf - 0.009 * bf, 1);
    if (ch === "babip") return babipNoiseVar(r.obs.babip!, bip);
    if (ch === "woba") return NaN;   // a composite; no clean binomial form
    return per9NoiseVar(r.obs[ch]!, r.sample);
  }
  const bip = Math.max(r.sample * (1 - r.obs.bbPct! / 100 - 0.008 - r.obs.soPct! / 100 - r.obs.hr600! / 600), 1);
  if (ch === "babip") return babipNoiseVar(r.obs.babip!, bip);
  if (ch === "hr600") return per600NoiseVar(r.obs.hr600!, r.sample);
  if (ch === "woba") return NaN;
  return pctNoiseVar(r.obs[ch]!, r.sample);
}

const CH: Record<"pit" | "hit", { key: string; lbl: string; d: number }[]> = {
  pit: [{ key: "k9", lbl: "K9", d: 2 }, { key: "bb9", lbl: "BB9", d: 2 }, { key: "hr9", lbl: "HR9", d: 2 }, { key: "babip", lbl: "BABIP", d: 3 }, { key: "woba", lbl: "wOBAA", d: 3 }],
  hit: [{ key: "bbPct", lbl: "BB%", d: 2 }, { key: "soPct", lbl: "SO%(PA)", d: 2 }, { key: "hr600", lbl: "HR600", d: 2 }, { key: "babip", lbl: "BABIP", d: 3 }, { key: "woba", lbl: "wOBA", d: 3 }],
};
const wellSampled = (r: Rec) => (r.role === "pit" ? r.sample >= MIN_IP : r.sample >= MIN_PA);

// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n╔════════════════════════════════════════════════════════════════════════════════════════════╗`);
console.log(`║  cwhit BENCHMARK SCORECARD — UNIVERSAL (ours) vs NATIVE (cwhit) vs OBSERVED                 ║`);
console.log(`╚════════════════════════════════════════════════════════════════════════════════════════════╝`);
console.log(`model '${trained.id}' | catalog '${srcId}' | neutral env (bronze-quick era/park) | own-gap pool transform ON`);
console.log(`join: observed→catalog = name+VAL+VLvl+Hand fingerprint (existing joinCwhit); projected→catalog = FULL //Card Title + VLvl (exact)\n`);

console.log(`── FIXTURES DISCOVERED (glob-driven; no tier hard-coded) ──`);
console.log(`  observed  (${OBS}):  ${obsFiles.filter((x) => x.endsWith(".tsv")).length} tables — Quick tiers used: ${QUICK.filter((q) => hasObs(q.tier, "pit") || hasObs(q.tier, "hit")).map((q) => q.tier).join(", ")}`);
console.log(`  projected (${PROJ}): ${projFiles.filter((x) => x.endsWith(".tsv")).length} tables — ${projFiles.filter((x) => x.endsWith(".tsv")).join(", ") || "(none)"}`);
console.log(`  NOTE: only the five QUICK tiers are scored (known VAL caps + neutral env). Daily/Cap formats in ${OBS} carry non-neutral era/park and are out of scope here.`);
for (const s of notices) console.log(`  · ${s}`);

console.log(`\n── WINDOW OVERLAP (per projected table) — MUST be read before any ours-vs-cwhit claim ──`);
if (!windows.length) console.log(`  (no projected tables ⇒ no three-way axis this run)`);
for (const { tier, role, w, meta, conv } of windows) {
  console.log(`  ${tier} ${role}:  observed coverage ${w.obsFrom ?? "?"}..${w.obsTo ?? "?"} (${w.obsDays}d)   |   cwhit model trained ${w.trainFrom ?? "?"}..${w.trainTo ?? "?"} (${w.trainDays}d)`);
  console.log(`      overlap ${w.overlapDays}d = ${f(w.overlapPctOfObs, 0)}% of the judging window  ⇒  ${w.verdict}`);
  if (meta.projectedOn) console.log(`      projections pulled ${meta.projectedOn}; source header: "${meta.headerLine}"`);
  for (const c of conv) console.log(`      convention: ${c}`);
}
{ // Projected coverage is UNEVEN across roles — say so, so the hitter read is never mistaken for a
  // full 5-tier gradient like the pitcher one.
  const pT = QUICK.filter((q) => projFile(q.tier, "pit")).map((q) => q.tier), hT = QUICK.filter((q) => projFile(q.tier, "hit")).map((q) => q.tier);
  console.log(`\n  PROJECTED COVERAGE IS UNEVEN BY ROLE — pitchers: ${pT.length}/5 tiers (${pT.join(", ") || "none"});  hitters: ${hT.length}/5 tiers (${hT.join(", ") || "none"}).`);
  if (hT.length && hT.length < QUICK.length) {
    console.log(`  ⇒ The HITTER three-way is a FRAME-EXTREMES CONTRAST (${hT.join(" vs ")}), NOT a tier gradient. No hitter trend across tiers can be estimated, and no hitter claim generalizes to ${QUICK.filter((q) => !hT.includes(q.tier)).map((q) => q.tier).join("/")}.`);
  }
}
console.log(`  cwhit's OBSERVED hitter SO% is K/AB (ours is K/PA) — converted per-row via the AVG/OBP identity before comparison.`);
console.log(`  (Verified: reconstructing his published BABIP from his own columns gives mean |err| 0.003 under K/AB vs 0.012 under K/PA, across 4 tiers × N=100.)`);

// ── sample-depth accounting (no silent caps) ────────────────────────────────
console.log(`\n── N + SAMPLE DEPTH (what is kept, what is dropped) ──`);
console.log(`tier      role  joined   well-sampled (IP≥${MIN_IP} / PA≥${MIN_PA})   dropped   median depth (kept)   also has cwhit projection`);
for (const { tier } of QUICK) for (const role of ["pit", "hit"] as const) {
  const all = recs.filter((r) => r.tier === tier && r.role === role); if (!all.length) continue;
  const kept = all.filter(wellSampled), med = kept.length ? [...kept.map((r) => r.sample)].sort((a, b) => a - b)[Math.floor(kept.length / 2)]! : NaN;
  console.log(`${tier.padEnd(9)} ${role}   ${String(all.length).padStart(4)}     ${String(kept.length).padStart(4)}                       ${String(all.length - kept.length).padStart(4)}      ${f(med, 0).padStart(7)}              ${String(kept.filter((r) => r.proj).length).padStart(4)}`);
}
if (projUnjoined.length) {
  console.log(`  ${projUnjoined.length} projected rows did NOT join to an observed+catalog record — excluded, not forced. Per tier×role:`);
  const by = new Map<string, number>();
  for (const s of projUnjoined) { const k = s.split(":")[0]!; by.set(k, (by.get(k) ?? 0) + 1); }
  for (const [k, n] of by) console.log(`      ${k.padEnd(14)} ${String(n).padStart(3)} unjoined`);
  console.log(`      CAUSE (structural, not a join defect): his projected table is the top-100 by pwOBA over the WHOLE format pool (e.g. 2402 diamond cards),`);
  console.log(`      while the observed table is the top-100 by IP. The two top-100s overlap only partly, so most of his projected rows have no observed line to be judged on.`);
}

// ═══ A. THREE-WAY ═══════════════════════════════════════════════════════════
console.log(`\n\n╔═══ A. THREE-WAY SCORECARD — ours vs cwhit-native, judged on observed ═══════════════════════╗`);
console.log(`LEVEL  = mean(pred−obs) ±95%CI. Our known out-of-frame level gaps live in the eval stack by design — a level loss here may restate an ACCEPTED gap, not a defect.`);
console.log(`SHAPE  = per-card agreement AFTER DE-MEANING both series (level removed; scale deliberately NOT rescaled — a full affine fit would absorb the spread defect SPREAD reports separately).`);
console.log(`         The SHAPE VERDICT is read off 'corr' ONLY, because corr is scale-free: it answers "who ORDERS the cards better", which is the M8 question. 'MAE' is a shape+spread composite.`);
console.log(`SPREAD = SD(pred)/SD(obs). Observed SD is noise-inflated ⇒ the raw ratio is LOW-biased against a noiseless predictor; 'dcv' deconvolves the binomial sampling variance (n/a for composites).`);
console.log(`slope  = OLS of de-meaned pred on de-meaned obs; 1.0 = right responsiveness, <1 = we under-react to the rating signal.`);

const MIN_N = 5;
const threeWayAll = QUICK.flatMap(({ tier }) => (["pit", "hit"] as const).map((role) => ({ tier, role, rows: recs.filter((r) => r.tier === tier && r.role === role && r.proj && wellSampled(r)) })));
const threeWay = threeWayAll.filter((x) => x.rows.length >= MIN_N);
// A tier×role that HAS a projected fixture but too few well-sampled joined cards must say so out
// loud — otherwise it vanishes from this section and reads as "not captured yet" (it is captured;
// it is DEAD for lack of observed depth, which is a finding, not an absence).
const starved = threeWayAll.filter((x) => x.rows.length > 0 && x.rows.length < MIN_N);
for (const { tier, role, rows } of starved) {
  console.log(`\n  ⚠ ${tier.toUpperCase()} ${role}: projected fixture EXISTS and joined, but only N=${rows.length} card(s) clear the well-sampled bar ⇒ NO THREE-WAY READ (need ≥${MIN_N}).`);
  console.log(`     This is a DEAD PREDICTION, not a missing capture: the tier's observed table is too thin (few tournament instances ⇒ low per-card IP), not a model or join failure.`);
}
if (!threeWay.length) console.log(`\n  (no tier×role has ≥${MIN_N} well-sampled cards with a cwhit projection — capture projected fixtures to populate this section)`);

const verdicts: { tier: string; role: string; ch: string; shape: string; spread: string; level: string; d: ReturnType<typeof duel> }[] = [];
for (const { tier, role, rows } of threeWay) {
  console.log(`\n─── ${tier.toUpperCase()} ${role === "pit" ? "PITCHERS" : "HITTERS"} — N=${rows.length} well-sampled cards with both predictions ───`);
  console.log(`                 ┌──────────── LEVEL: mean(pred−obs) ─────────────┐ ┌─────────── SHAPE (de-meaned) ────────────┐ ┌────── SPREAD SD(pred)/SD(obs) ──────┐`);
  console.log(`channel   who    bias        95% CI              obs mean          corr   [95% CI]      rho    MAE     slope    raw    dcv    noise%`);
  for (const { key, lbl, d } of CH[role]) {
    const obs = rows.map((r) => r.obs[key]!), nv = rows.map((r) => noiseOf(r, key));
    const useNv = nv.every((x) => Number.isFinite(x)) ? nv : undefined;
    const lines: [string, Agreement][] = [["OURS", agreement(rows.map((r) => r.ours[key]!), obs, useNv)], ["cwhit", agreement(rows.map((r) => r.proj![key]!), obs, useNv)]];
    for (const [who, a] of lines) {
      console.log(
        `${(who === "OURS" ? lbl : "").padEnd(9)} ${who.padEnd(6)} ${sgn(a.level.bias, d).padStart(7)}${a.level.sig ? "*" : " "}   [${sgn(a.level.ciLo, d)}, ${sgn(a.level.ciHi, d)}]`.padEnd(58) +
        `${f(rows.reduce((s, r) => s + r.obs[key]!, 0) / rows.length, d).padStart(6)}      ` +
        `${f(a.shape.corr, 3).padStart(5)}  [${f(a.shape.corrLo, 2)},${f(a.shape.corrHi, 2)}]  ${f(a.shape.spearman, 2).padStart(5)}  ${f(a.shape.mae, d).padStart(6)}  ${f(a.shape.slope, 2).padStart(5)}   ` +
        `${f(a.spread.ratio, 2).padStart(5)}  ${f(a.spread.ratioDeconv, 2).padStart(5)}  ${(Number.isFinite(a.spread.noiseShare) ? `${f(a.spread.noiseShare * 100, 0)}%` : "n/a").padStart(5)}`,
      );
    }
    // The DUEL — paired bootstrap on the ours-minus-cwhit gap (the only defensible "who wins").
    // Each verdict comes from ONE axis, never a blend:
    //   SHAPE  ← Δcorr ONLY. Correlation is SCALE-FREE, so a spread defect cannot masquerade as a
    //            discrimination defect. (Δshape-MAE is printed but is a shape+spread composite: it
    //            de-means without rescaling, so compressed spread inflates it even at identical corr.
    //            Bronze K9 is exactly this trap — corr 0.943 vs 0.945, yet MAE differs on spread alone.)
    //   SPREAD ← Δ|ln(SD ratio)|, i.e. who sits closer to 1.0× the observed spread.
    //   LEVEL  ← Δ|bias|.
    const dl = duel(rows.map((r) => r.ours[key]!), rows.map((r) => r.proj![key]!), obs);
    const V = (dd: { est: number; sig: boolean }) => (!dd.sig ? "TIE" : dd.est < 0 ? "OURS" : "CWHIT");
    const shapeV = !dl.corr.sig ? "TIE" : dl.corr.est > 0 ? "OURS" : "CWHIT";
    const spreadV = V(dl.spreadLog), levelV = V(dl.absLevel);
    console.log(`          DUEL   Δcorr ${sgn(dl.corr.est, 3)} [${sgn(dl.corr.lo, 2)},${sgn(dl.corr.hi, 2)}]${dl.corr.sig ? "*" : " "}  (Δshape-MAE ${sgn(dl.shapeMae.est, d)}${dl.shapeMae.sig ? "*" : " "} = shape+spread composite)  Δ|ln spread| ${sgn(dl.spreadLog.est, 2)}${dl.spreadLog.sig ? "*" : " "}  Δ|level| ${sgn(dl.absLevel.est, d)}${dl.absLevel.sig ? "*" : " "}`);
    console.log(`                 ⇒  SHAPE(ordering): ${shapeV}    SPREAD(scale): ${spreadV}    LEVEL: ${levelV}`);
    verdicts.push({ tier, role, ch: lbl, shape: shapeV, spread: spreadV, level: levelV, d: dl });
  }
  console.log(`  (* = 95% CI excludes 0. DUEL CIs are a 2000-rep PAIRED bootstrap over cards — paired because both models are scored on the SAME cards, so shared card difficulty cancels.)`);
}

// ═══ B. OBSERVED-ONLY (incl. the IRON GATE) ═════════════════════════════════
console.log(`\n\n╔═══ B. OBSERVED-ONLY AXIS — ours vs observed, EVERY tier (no cwhit projection needed) ═══════╗`);
console.log(`IRON GATE: our levels/spread/concordance at iron have never been tested (frame gaps k≈1.6–2.2). Iron appears here whether or not a projected table exists.`);
for (const role of ["pit", "hit"] as const) {
  const any = recs.some((r) => r.role === role); if (!any) continue;
  console.log(`\n─── ${role === "pit" ? "PITCHERS" : "HITTERS"} ───`);
  console.log(`tier      chan       N    LEVEL bias [95% CI]              corr    rho    SHAPE MAE   SPREAD raw / dcv`);
  for (const { tier } of QUICK) {
    const rows = recs.filter((r) => r.tier === tier && r.role === role && wellSampled(r));
    if (rows.length < 5) { if (rows.length) console.log(`${tier.padEnd(9)} (N=${rows.length} well-sampled — too few to report)`); continue; }
    for (const { key, lbl, d } of CH[role]) {
      const obs = rows.map((r) => r.obs[key]!), nv = rows.map((r) => noiseOf(r, key));
      const a = agreement(rows.map((r) => r.ours[key]!), obs, nv.every((x) => Number.isFinite(x)) ? nv : undefined);
      console.log(`${tier.padEnd(9)} ${lbl.padEnd(9)} ${String(a.n).padStart(3)}    ${sgn(a.level.bias, d).padStart(7)}${a.level.sig ? "*" : " "} [${sgn(a.level.ciLo, d)}, ${sgn(a.level.ciHi, d)}]`.padEnd(66) + `${f(a.shape.corr, 3).padStart(5)}  ${f(a.shape.spearman, 2).padStart(5)}   ${f(a.shape.mae, d).padStart(7)}     ${f(a.spread.ratio, 2)} / ${f(a.spread.ratioDeconv, 2)}`);
    }
  }
}

// ═══ C. WHERE UNIVERSAL BEATS NATIVE ════════════════════════════════════════
console.log(`\n\n╔═══ C. WHERE UNIVERSAL (ours) BEATS NATIVE (cwhit), AND WHERE IT DOES NOT ═══════════════════╗`);
if (!verdicts.length) console.log(`  (no three-way data this run)`);
else {
  const show = (title: string, pick: (v: typeof verdicts[0]) => boolean) => {
    const vs = verdicts.filter(pick);
    console.log(`\n  ${title}`);
    if (!vs.length) console.log(`    (none)`);
    for (const v of vs) console.log(`    ${v.tier.padEnd(9)} ${v.role}  ${v.ch.padEnd(8)} Δcorr ${sgn(v.d.corr.est, 3)}${v.d.corr.sig ? "*" : " "}  Δ|ln spread| ${sgn(v.d.spreadLog.est, 2)}${v.d.spreadLog.sig ? "*" : " "}  Δ|level| ${sgn(v.d.absLevel.est, 3)}${v.d.absLevel.sig ? "*" : " "}`);
  };
  console.log(`\n  ── ON SHAPE / ORDERING (the M8-relevant axis: per-card discrimination after level alignment; scale-free) ──`);
  show(`WE WIN on shape (CI-clear):`, (v) => v.shape === "OURS");
  show(`WE LOSE on shape (CI-clear) — the M8 case, IF it survives the window caveat:`, (v) => v.shape === "CWHIT");
  show(`TIE on shape (CI includes 0) — no evidence either model discriminates better:`, (v) => v.shape === "TIE");
  console.log(`\n  ── ON SPREAD / SCALE (who sits closer to 1.0× the observed card-to-card spread) ──`);
  show(`WE WIN on spread:`, (v) => v.spread === "OURS");
  show(`WE LOSE on spread:`, (v) => v.spread === "CWHIT");
  show(`TIE on spread:`, (v) => v.spread === "TIE");
  console.log(`\n  ── ON LEVEL (may restate a KNOWN, ACCEPTED out-of-frame gap — not automatically a defect) ──`);
  show(`WE WIN on level:`, (v) => v.level === "OURS");
  show(`WE LOSE on level:`, (v) => v.level === "CWHIT");
  show(`TIE on level:`, (v) => v.level === "TIE");
  const anyIn = windows.some((w) => w.w.overlapDays > 0);
  if (anyIn) console.log(`\n  ⚠ READ EVERY "WE LOSE" ROW AGAINST THE WINDOW OVERLAP ABOVE: cwhit's model saw part of the judging window; ours did not. His wins are an UPPER BOUND on his true edge; our wins are, if anything, understated.`);
}

// ═══ D. IS THE CONFOUND THE EXPLANATION? ════════════════════════════════════
// The overlap caveat above is qualitative and, alone, unfalsifiable — it can excuse any loss. This
// section makes it TESTABLE. If semi-in-sample fitting were what buys cwhit his edge, his edge must
// GROW WITH OVERLAP%. The tiers differ in overlap (bronze 60% .. silver/gold/diamond 100%), so the
// gradient across tiers is a natural experiment. NO gradient ⇒ the confound is NOT the driver and
// his level win is a REAL frame effect (he fits tournament data; we fit league data) — which is a
// far more actionable finding than "his number is inflated".
if (verdicts.length) {
  console.log(`\n\n╔═══ D. OVERLAP-CONFOUND PROBE — does cwhit's edge scale with how much of the judging window he was fit on? ═══╗`);
  console.log(`If his edge is an artifact of semi-in-sample fitting, it must RISE with overlap%. A flat/absent gradient falsifies the confound as the primary cause.`);
  // PER-CHANNEL, never averaged across channels: our K9 level edge (we win) and our BB9 level deficit
  // (we lose) are near-equal and OPPOSITE, so a tier-mean Δ|level| cancels to ~0 and would fake a
  // "no gradient" result for the wrong reason. The gradient is only readable WITHIN a channel.
  // Role-scoped: 'BABIP' is a channel label in BOTH CH.pit and CH.hit, so a tier+label lookup that
  // ignored role would silently cross the roles' verdicts.
  for (const role of ["pit", "hit"] as const) {
    const tiersByOv = QUICK.map(({ tier }) => ({ tier, w: windows.find((x) => x.tier === tier && x.role === role) }))
      .filter((x) => x.w && verdicts.some((v) => v.tier === x.tier && v.role === role))
      .map((x) => ({ tier: x.tier, ov: x.w!.w.overlapPctOfObs }))
      .sort((a, b) => a.ov - b.ov);
    if (!tiersByOv.length) continue;
    console.log(`\n\n  ══ ${role === "pit" ? "PITCHERS" : "HITTERS"} — tiers ordered by overlap% (LEAST in-sample first). Confound prediction: his edge RISES left→right. ══`);
    if (tiersByOv.length < 3) console.log(`  ⚠ only ${tiersByOv.length} tier(s) have a ${role} projection — NO gradient is computable. The cells are shown for completeness; draw no trend from them.`);
    const head = `channel   ` + tiersByOv.map((t) => `${t.tier}(${f(t.ov, 0)}%)`.padStart(14)).join("") + `     corr w/ overlap%`;
    const line = (lbl: string, get: (tier: string) => number | undefined, d: number) => {
      const vals = tiersByOv.map((t) => get(t.tier));
      const ok = vals.map((v, i) => [v, tiersByOv[i]!.ov] as const).filter((p): p is readonly [number, number] => Number.isFinite(p[0]));
      const r = ok.length >= 3 ? pearson(ok.map((p) => p[1]), ok.map((p) => p[0])) : NaN;
      console.log(`${lbl.padEnd(9)} ` + vals.map((v) => (v == null || !Number.isFinite(v) ? "n/a" : sgn(v, d)).padStart(14)).join("") + `     ${f(r, 2).padStart(6)}`);
    };
    const at = (t: string, lbl: string) => verdicts.find((v) => v.tier === t && v.role === role && v.ch === lbl);
    console.log(`\n  ── HIS LEVEL EDGE, Δ|level| = |ours| − |cwhit| (POSITIVE = we lose = his edge) ──`);
    console.log(head);
    for (const { lbl, d } of CH[role]) line(lbl, (t) => at(t, lbl)?.d.absLevel.est, d);
    console.log(`\n  ── HIS SHAPE EDGE, −Δcorr (POSITIVE = we lose = his edge; the M8 axis) ──`);
    console.log(head);
    for (const { lbl } of CH[role]) line(lbl, (t) => { const v = at(t, lbl); return v ? -v.d.corr.est : undefined; }, 3);
  }
  console.log(`\n  READ: a STRONGLY POSITIVE 'corr w/ overlap%' means his edge on that channel grows the more of the judging window he was fit on ⇒ CONFOUND REAL for that channel.`);
  console.log(`        Near-zero or NEGATIVE ⇒ in-sample fitting does NOT explain his edge there; the edge is a genuine FRAME effect (he fits tournament data, we fit league data).`);
  console.log(`        Bronze is the key cell (LEAST in-sample at 60%): an edge there as large as at the 100% tiers is, by itself, evidence against the confound.`);
  console.log(`        CAVEAT: only a handful of tiers, overlap is nearly constant (87–100%) outside bronze, and tier ALSO varies pool strength — this is a directional probe, NOT a controlled test or a significance claim.`);
}
console.log(``);
process.exit(0);
