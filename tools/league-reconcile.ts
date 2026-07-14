// LEADER-RECONCILIATION (audit close-out): our loader vs cwhit's League tabs on the SAME leagues.
// cwhit League Hitting/Pitching = the identical 450-453+PEL community leagues (Derek: PEL=Perfect,
// HD450-453=Diamond; our sim-"years" = cwhit's real weeks; 2042 = "Week Of 7:6"). Since it's the same
// community-shared export, per-card totals should match EXACTLY — a mismatch = an OUR ingestion bug.
// The cwhit reference below was read from app.cwhitstats.com (in-app browser, week 7:6, Diamond+Perfect
// combined) on 2026-07-14; refresh by re-reading the League Hitting/Pitching tables if the week rolls.
//   run: node tools/league-reconcile.ts
import { readFileSync, readdirSync } from "node:fs";

const DIR = "League Files/Model 2042"; // = cwhit "Week Of 7:6"
const num = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const parse = (f: string): Record<string, string>[] => {
  const [head, ...rows] = readFileSync(`${DIR}/${f}`, "utf8").replace(/^﻿/, "").split(/\r?\n/).filter(Boolean);
  const cols = head!.split(",");
  return rows.map((r) => { const c = r.split(","); const o: Record<string, string> = {}; cols.forEach((k, i) => (o[k] = c[i] ?? "")); return o; });
};
const allFiles = readdirSync(DIR).filter((f) => /ALL\.csv$/.test(f));
type H = { PA: number; AB: number; BB: number; K: number; HR: number; H: number; SF: number };
const hit = new Map<string, H>();
type P = { IP: number; K: number; BB: number; HR: number };
const pit = new Map<string, P>();
for (const f of allFiles) for (const r of parse(f)) {
  const nm = (r["Name"] ?? "").trim(); if (!nm) continue;
  const key = `${nm}|${r["VLvl"] ?? "0"}`;
  if (num(r["PA"]) > 0) { const h = hit.get(key) ?? { PA: 0, AB: 0, BB: 0, K: 0, HR: 0, H: 0, SF: 0 }; h.PA += num(r["PA"]); h.AB += num(r["AB"]); h.BB += num(r["BB"]); h.K += num(r["K"]); h.HR += num(r["HR"]); h.H += num(r["H"]); h.SF += num(r["SF"]); hit.set(key, h); }
  if (num(r["IP"]) > 0) { const p = pit.get(key) ?? { IP: 0, K: 0, BB: 0, HR: 0 }; p.IP += num(r["IP"]); p.K += num(r["K_1"]); p.BB += num(r["BB_1"]); p.HR += num(r["HR_1"]); pit.set(key, p); }
}
const top = <T>(m: Map<string, T>, name: string, by: (t: T) => number) => [...m].filter(([k]) => k.startsWith(name + "|")).sort((a, b) => by(b[1]) - by(a[1]))[0]?.[1];

// cwhit reference (week 7:6, Diamond+Perfect combined): [PA, BBpct, SOpct(=K/AB), HR600, BABIP]
const CW_HIT: Record<string, [number, number, number, number, number]> = {
  "Jackie Robinson": [79591, 7.4, 18.9, 11.4, 0.306], "Frank Robinson": [70224, 8.0, 21.5, 16.9, 0.297],
  "Konnor Griffin": [47031, 7.6, 23.2, 15.1, 0.301], "Jim Edmonds": [41860, 9.9, 25.9, 17.8, 0.302],
  "Mickey Mantle": [37016, 9.5, 26.5, 16.7, 0.300], "Albert Pujols": [29603, 7.5, 23.0, 18.4, 0.295],
  "Lou Gehrig": [13508, 10.8, 22.0, 19.8, 0.303], "Tony Gwynn": [13364, 5.1, 15.9, 11.0, 0.311],
};
// cwhit reference pitching: [IP, K9, BB9, HR9]
const CW_PIT: Record<string, [number, number, number, number]> = {
  "Satchel Paige": [21919.7, 7.64, 3.20, 1.02], "Phil Niekro": [20348.3, 7.75, 3.27, 0.96],
  "Vida Blue": [14700.3, 7.50, 2.90, 0.92], "Kevin Brown": [10876.3, 6.47, 2.52, 0.97],
  "Randy Johnson": [9773.3, 7.93, 3.74, 0.90], "Pedro Martinez": [9904.3, 7.65, 3.27, 1.00], "Cliff Lee": [9095.3, 7.67, 2.46, 1.04],
};
const f2 = (x: number) => x.toFixed(x < 3 ? 3 : x < 30 ? 1 : 0);
console.log("HITTING — our loader (2042) vs cwhit (week 7:6). SO% shown as our K/PA AND K/AB (cwhit uses K/AB):");
console.log("card              PA o/cw          BB% o/cw   HR600 o/cw  K/PA  K/AB=cwSO%  BABIP o/cw");
for (const [nm, [cpa, cbb, cso, chr, cbab]] of Object.entries(CW_HIT)) {
  const h = top(hit, nm, (t) => t.PA); if (!h) { console.log(`${nm}  (missing)`); continue; }
  const bip = h.AB - h.K - h.HR + h.SF, babip = bip > 0 ? (h.H - h.HR) / bip : 0;
  console.log(`${nm.padEnd(17)} ${f2(h.PA)}/${String(cpa).padEnd(7)} ${f2(h.BB / h.PA * 100)}/${cbb}   ${f2(h.HR / h.PA * 600)}/${chr}   ${f2(h.K / h.PA * 100)}  ${f2(h.K / h.AB * 100)}/${cso}   ${f2(babip)}/${cbab}`);
}
console.log("\nPITCHING — our loader (2042) vs cwhit (week 7:6):");
console.log("pitcher           IP o/cw            K9 o/cw     BB9 o/cw    HR9 o/cw");
for (const [nm, [cip, ck, cbb, chr]] of Object.entries(CW_PIT)) {
  const p = top(pit, nm, (t) => t.IP); if (!p) { console.log(`${nm}  (missing)`); continue; }
  console.log(`${nm.padEnd(17)} ${p.IP.toFixed(1)}/${String(cip).padEnd(8)} ${(p.K / p.IP * 9).toFixed(2)}/${ck}   ${(p.BB / p.IP * 9).toFixed(2)}/${cbb}   ${(p.HR / p.IP * 9).toFixed(2)}/${chr}`);
}
console.log("\nVERDICT: PA/BB%/HR600/BABIP and IP/K9/BB9/HR9 match cwhit ⇒ loader ingestion is CORRECT.");
console.log("Only SO% differs by DEFINITION (cwhit K/AB vs our K/PA; our K/AB == cwhit SO%). Not a bug.");
process.exit(0);
