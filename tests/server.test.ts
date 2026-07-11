// Q-2 — server smoke tests for the S-5 hardening batch. Spins up the REAL server
// (node src/server/server.ts) on a free port against an isolated temp copy of data/,
// then exercises the acceptance list over HTTP:
//   • a malformed JSON body → 4xx/5xx, NEVER a process crash (top-level try/catch)
//   • a path-traversal ?id= on models/delete → 400
//   • an account import missing required catalog columns → 400
//   • a name-slug-collision import preserves the existing account's variant flags
//   • a same-catalog re-upload succeeds and the derived caches stay serviceable
//
// The server is heavy to boot (loads the catalog + scores the default tournament), so
// one instance is shared across the file. Skipped if the seed fixtures aren't present.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HAVE_DATA = existsSync("data/state/app.json") && existsSync("docs/pt_card_list.csv");

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, () => {
      const addr = s.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      s.close(() => (port ? resolve(port) : reject(new Error("no port"))));
    });
    s.on("error", reject);
  });
}

let child: ChildProcess | null = null;
let base = "";
let tmp = "";

async function boot(port: number, dataRoot: string): Promise<void> {
  child = spawn(process.execPath, ["src/server/server.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), DATA_ROOT: dataRoot },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise<void>((resolve, reject) => {
    const to = setTimeout(() => reject(new Error("server boot timeout")), 45_000);
    const onData = (buf: Buffer) => {
      if (buf.toString().includes(`http://localhost:${port}`)) { clearTimeout(to); resolve(); }
    };
    child!.stdout!.on("data", onData);
    child!.stderr!.on("data", (b: Buffer) => { if (/Error|EADDRINUSE/.test(b.toString())) { clearTimeout(to); reject(new Error(b.toString())); } });
    child!.on("exit", (code) => { clearTimeout(to); reject(new Error(`server exited early (${code})`)); });
  });
}

describe.skipIf(!HAVE_DATA)("Q-2 — server hardening smoke", () => {
  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "ootp-srv-"));
    cpSync("data", join(tmp, "data"), { recursive: true });
    const port = await freePort();
    base = `http://localhost:${port}`;
    await boot(port, join(tmp, "data"));
  }, 60_000);

  afterAll(() => {
    child?.kill();
    if (tmp) try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it("a malformed JSON body returns an error, not a crash — and the server survives", async () => {
    const bad = await fetch(`${base}/api/tournaments/save`, { method: "POST", body: "{not json" });
    expect(bad.status).toBeGreaterThanOrEqual(400); // 400/500, handled
    // server is still alive and serving
    const ok = await fetch(`${base}/api/tournaments`);
    expect(ok.status).toBe(200);
    const body = await ok.json() as { tournaments: unknown[] };
    expect(Array.isArray(body.tournaments)).toBe(true);
  });

  it("a path-traversal model id is rejected with 400", async () => {
    const r = await fetch(`${base}/api/training/models/delete?id=${encodeURIComponent("../../state/app")}`, { method: "POST" });
    expect(r.status).toBe(400);
    // the state file must still be there (nothing deleted / escaped the collection)
    expect(existsSync(join(tmp, "data", "state", "app.json"))).toBe(true);
  });

  it("an account import missing required columns is rejected with 400", async () => {
    const r = await fetch(`${base}/api/accounts/import?name=BadCsv`, { method: "POST", body: "Card ID,Foo\n1,2\n" });
    expect(r.status).toBe(400);
    const body = await r.json() as { error: string };
    expect(String(body.error)).toMatch(/missing required columns/i);
  });

  it("a name-slug-collision import preserves the existing account's variants", async () => {
    const csv = readCatalog();
    // create a fresh account
    let r = await fetch(`${base}/api/accounts/import?name=SmokeAcct`, { method: "POST", body: csv });
    expect(r.status).toBe(200);
    // flag a variant on it (pick a Card ID present in the catalog)
    const cardId = firstCardId(csv);
    r = await fetch(`${base}/api/accounts/variants/toggle`, { method: "POST", body: JSON.stringify({ id: "smokeacct", cardId, on: true }) });
    expect(r.status).toBe(200);
    let summary = await r.json() as { accounts: { id: string; variantCount: number }[] };
    expect(summary.accounts.find((a) => a.id === "smokeacct")?.variantCount).toBe(1);
    // re-import as a "new" account with the SAME name (slugs to smokeacct) → must NOT wipe variants
    r = await fetch(`${base}/api/accounts/import?name=SmokeAcct`, { method: "POST", body: csv });
    expect(r.status).toBe(200);
    summary = await r.json() as { accounts: { id: string; variantCount: number }[] };
    expect(summary.accounts.find((a) => a.id === "smokeacct")?.variantCount).toBe(1);
  });

  it("a same-catalog re-upload succeeds and derived endpoints stay serviceable", async () => {
    const csv = readCatalog();
    const before = await (await fetch(`${base}/api/debug/scaling?t=gold-quick`)).json() as { tournament: string };
    const r = await fetch(`${base}/api/accounts/import?name=SmokeAcct`, { method: "POST", body: csv });
    expect(r.status).toBe(200);
    const after = await fetch(`${base}/api/debug/scaling?t=gold-quick`);
    expect(after.status).toBe(200); // caches were invalidated + rebuilt without crashing
    const body = await after.json() as { tournament: string };
    expect(body.tournament).toBe(before.tournament);
  });
});

// ── helpers that read the committed catalog once ─────────────────────────────
import { readFileSync } from "node:fs";
let _csv: string | null = null;
function readCatalog(): string { return (_csv ??= readFileSync("docs/pt_card_list.csv", "utf8")); }
function firstCardId(csv: string): string {
  const lines = csv.split(/\r?\n/);
  const header = lines[0]!.split(",");
  const idCol = header.indexOf("Card ID");
  return lines[1]!.split(",")[idCol]!;
}
