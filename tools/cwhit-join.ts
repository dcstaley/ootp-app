// DRIVER for the cwhitstats join layer (Batch-1 item 4). Wires the LIVE catalog + the ACTIVE
// trained model to the pure parse/join modules and prints a per-table match report — the first
// readout of how much of each cwhit tier we can line up against our predictions (the input the
// Batch-2 audit needs). Reads the committed snapshot in fixtures/cwhit; writes a JSON summary to
// the scratchpad. EVAL-ONLY, read-only on the repo.
//   run: node tools/cwhit-join.ts
//
// Fingerprint discipline (memory cwhitstats-external-data): the disambiguation PRIMARY axes are
// role + BABIP (near-orthogonal to the audited value channels); K/BB/HR are VALIDATE-only, so a
// collision is never resolved using the very channels the audit grades. Our `starterProxy` maps
// stamina → [0,1] purely as a SEPARATOR comparable to cwhit's observed start fraction; it is a
// coarse usage proxy (our ratings can't predict a manager's SP/RP choice) and is never an audit value.
// The predicted lines here are a vR-based COARSE fingerprint for the join + first-look, NOT the
// audit's per-hand comparison (Batch 2 does vL/vR properly).

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { Repository } from "../src/persistence/repository.ts";
import { seedDefaults, seedEras } from "../src/config/seed.ts";
import { seedAccounts } from "../src/data/account-seed.ts";
import { makeRawPolyModel } from "../src/scoring-core/index.ts";
import { parseCatalogCsv, type Card } from "../src/data/catalog.ts";
import { makeVariant } from "../src/data/variants.ts";
import { PIT_BIP_ADJ, type EventForm } from "../src/model/curves.ts";
import type { Coeffs } from "../src/config/types.ts";
import { parseCwhitPit, parseCwhitHit, IP_TO_BF } from "../src/eval/cwhit/index.ts";
import { joinCwhit, type JoinCard, type JoinObs } from "../src/eval/cwhit/index.ts";

const SCRATCH = "C:/Users/dstal/AppData/Local/Temp/claude/C--dev-ootp-app/3424c376-236e-4105-b460-f5fcc1109c7f/scratchpad";
const FIX = "fixtures/cwhit";
const PER600BF_TO_PER9 = (IP_TO_BF * 9) / 600; // per-600-BF rate → per-9-innings
const n = (v: unknown): number => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const handLetter = (code: number): string => (code === 2 ? "L" : code === 3 ? "S" : "R"); // catalog 1=R 2=L 3=S
const starterProxy = (stamina: number) => clamp01((stamina - 20) / 40); // coarse SP/RP separator in [0,1]

const repo = new Repository("data");
await seedDefaults(repo); await seedEras(repo); await seedAccounts(repo);
const state = (await repo.load<{ activeModelId?: string; catalogSourceId?: string }>("state", "app")) ?? {};
const trained = (await repo.loadAll<{ id: string; eventForm?: EventForm }>("trained-models")).find((x) => x.id === state.activeModelId);
if (!trained?.eventForm) throw new Error(`active model '${state.activeModelId}' has no eventForm — activate a formatVersion-4 pareto artifact first`);
const rp = makeRawPolyModel(trained.eventForm);
const C = {} as Coeffs; // raw-poly ignores coeffs (event rates are curve-only)
const srcId = state.catalogSourceId ?? "cdmx";
const catalog = parseCatalogCsv(readFileSync(`data/imports/${srcId}.csv`, "utf8"));
const baseCards = catalog.cards.filter((c) => String(c["Variant"] ?? "").toUpperCase() !== "Y");
console.log(`[cwhit-join] model '${trained.id}' | catalog '${srcId}' (${baseCards.length} base cards)\n`);

// ── our-side fingerprints ──────────────────────────────────────────────────────
const isPitcher = (c: Card) => n(c["Pitcher Role"]) > 0 || String(c["Position"]).trim() === "1";
const isHitter = (c: Card) => String(c["Position"]).trim() !== "1";
const cardName = (c: Card) => `${(c["FirstName"] ?? "").trim()} ${(c["LastName"] ?? "").trim()}`.trim();

function pitFinger(c: Card): { primary: number[]; validate: number[] } {
  const e = rp.predictPitching({ con: n(c["Control vR"]), stu: n(c["Stuff vR"]), pbabip: n(c["pBABIP vR"]), hrr: n(c["pHR vR"]) }, C);
  const bip = Math.max(600 - e.BB - e.K - e.HR - PIT_BIP_ADJ, 1);
  const babip = e.nHH / bip;
  return { primary: [starterProxy(n(c["Stamina"])), babip], validate: [e.K * PER600BF_TO_PER9, e.BB * PER600BF_TO_PER9, e.HR * PER600BF_TO_PER9] };
}
function hitFinger(c: Card): { primary: number[]; validate: number[] } {
  const e = rp.predictHitting({ eye: n(c["Eye vR"]), pow: n(c["Power vR"]), kRat: n(c["Avoid K vR"]), babip: n(c["BABIP vR"]), gap: n(c["Gap vR"]), speed: n(c["Speed"]), steal: n(c["Steal Rate"]), run: n(c["Baserunning"]) }, C);
  const babip = (e.oneB + e.GAP) / Math.max(e.BIP, 1);
  return { primary: [babip], validate: [e.BB / 6, e.SO / 6, e.HR] }; // bbPct, soPct, hr600
}

/** Build our-side JoinCards for a role over base + v5-variant, matched to cwhit's shown hand. */
function ourCards(role: "pit" | "hit"): JoinCard[] {
  const out: JoinCard[] = [];
  const emit = (c: Card, vlvl: number) => {
    const val = n(c["Card Value"]);
    if (role === "pit") { if (!isPitcher(c)) return; const fp = pitFinger(c); out.push({ cid: `${c["Card ID"]}${vlvl ? "#V" : ""}`, name: cardName(c), val, vlvl, hand: handLetter(n(c["Throws"])), ...fp }); }
    else { if (!isHitter(c)) return; const fp = hitFinger(c); out.push({ cid: `${c["Card ID"]}${vlvl ? "#V" : ""}`, name: cardName(c), val, vlvl, hand: handLetter(n(c["Bats"])), ...fp }); }
  };
  for (const c of baseCards) { emit(c, 0); emit(makeVariant(c), 5); }
  return out;
}
const ourPit = ourCards("pit"), ourHit = ourCards("hit");
console.log(`[cwhit-join] our-side fingerprints: ${ourPit.length} pit (base+v5), ${ourHit.length} hit\n`);

// ── join each cached table ──────────────────────────────────────────────────────
const summary: Record<string, unknown>[] = [];
for (const f of readdirSync(FIX).filter((x) => x.endsWith(".tsv")).sort()) {
  const tsv = readFileSync(`${FIX}/${f}`, "utf8");
  if (f.includes("-pit")) {
    const { meta, rows } = parseCwhitPit(tsv);
    const obs: JoinObs<unknown>[] = rows.map((r) => ({ name: r.name, val: r.val, vlvl: r.vlvl, hand: r.hand, primary: [r.gsPer, r.babip], validate: [r.k9, r.bb9, r.hr9], sample: r.ip, row: r }));
    const res = joinCwhit(obs, ourPit);
    report(meta.format + " (pit)", res.stats, res.unmatched.slice(0, 5).map((o) => o.name));
    summary.push({ table: f, ...res.stats });
  } else {
    const { meta, rows } = parseCwhitHit(tsv);
    const obs: JoinObs<unknown>[] = rows.map((r) => ({ name: r.name, val: r.val, vlvl: r.vlvl, hand: r.hand, primary: [r.babip], validate: [r.bbPct, r.soPct, r.hr600], sample: r.pa, row: r }));
    const res = joinCwhit(obs, ourHit);
    report(meta.format + " (hit)", res.stats, res.unmatched.slice(0, 5).map((o) => o.name));
    summary.push({ table: f, ...res.stats });
  }
}
writeFileSync(`${SCRATCH}/cwhit-join-summary.json`, JSON.stringify(summary, null, 2));
console.log(`\n[cwhit-join] summary → ${SCRATCH}/cwhit-join-summary.json`);

function report(label: string, s: { total: number; matchedUnique: number; matchedFingerprint: number; unmatched: number; droppedRows: number; collisionKeys: number; collisionLossPct: number }, unmatchedSample: string[]) {
  const matched = s.matchedUnique + s.matchedFingerprint;
  console.log(`${label.padEnd(26)} matched ${String(matched).padStart(3)}/${s.total} (uniq ${s.matchedUnique}, fp ${s.matchedFingerprint})  unmatched ${String(s.unmatched).padStart(3)}  collide ${s.collisionKeys}k/${s.droppedRows}r (${s.collisionLossPct.toFixed(1)}%)`);
  if (unmatchedSample.length) console.log(`   unmatched e.g.: ${unmatchedSample.join(", ")}`);
}
process.exit(0);
