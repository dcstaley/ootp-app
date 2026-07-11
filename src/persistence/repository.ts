// M2d — file-based persistence (D7). One app folder is the single home for all
// libraries + the working session: JSON files per entity in per-type folders,
// plus raw CSV imports. No IndexedDB/localStorage/sessionStorage sprawl. Account
// overlays are first-class (their own collection).
//
//   <root>/
//     tournaments/<id>.json   eras/<id>.json   parks/<id>.json
//     models/<id>.json        accounts/<id>.json
//     imports/<name>.csv      (raw pt_card_list.csv imports, per account)
//
// A thin, typed-by-caller repository: list / load / loadAll / save / delete per
// collection, plus CSV read/write. Async (fs/promises) for the local server.

import { readFile, writeFile, readdir, mkdir, rm, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseCatalogCsv, type Catalog } from "../data/catalog.ts";

// Safe entity/import id: letters, digits, dot, underscore, hyphen — and never a `..`
// traversal segment. Guards every path built from a caller-supplied id so a raw `?id=`
// like `../../secret` can't escape the collection folder. Covers all collections since
// every file path funnels through `file()` / the import helpers.
const SAFE_ID = /^[A-Za-z0-9._-]+$/;
export function isSafeId(id: string): boolean { return SAFE_ID.test(id) && !id.includes(".."); }
function assertSafeId(id: string): void {
  if (!isSafeId(id)) throw new Error(`unsafe id: ${JSON.stringify(id)}`);
}

export const COLLECTIONS = {
  tournaments: "tournaments",
  eras: "eras",
  parks: "parks",
  models: "models",
  accounts: "accounts",
  // No saved-rosters collection: rosters are regenerated per request (Derek's decision).
} as const;
export type Collection = (typeof COLLECTIONS)[keyof typeof COLLECTIONS] | (string & {});

export class Repository {
  // NB: explicit field (not a TS parameter property) — Node's type-strip mode,
  // which runs the server, doesn't support parameter properties.
  private readonly root: string;
  constructor(root: string) { this.root = root; }

  private dir(collection: string): string { return join(this.root, collection); }
  private file(collection: string, id: string): string { assertSafeId(id); return join(this.dir(collection), `${id}.json`); }

  /** Save an entity as <root>/<collection>/<id>.json (pretty-printed). Atomic:
   *  write a temp file then rename, so a crash mid-write never leaves a truncated
   *  JSON file that would break the next boot. */
  async save<T>(collection: Collection, id: string, obj: T): Promise<void> {
    await mkdir(this.dir(collection), { recursive: true });
    const f = this.file(collection, id);
    const tmp = `${f}.tmp`;
    await writeFile(tmp, JSON.stringify(obj, null, 2), "utf8");
    await rename(tmp, f);
  }

  /** Load one entity, or null if absent. Throws (with the file named) on a parse
   *  error so callers can decide to skip-and-warn vs. fall back to defaults. */
  async load<T>(collection: Collection, id: string): Promise<T | null> {
    const f = this.file(collection, id);
    if (!existsSync(f)) return null;
    try {
      return JSON.parse(await readFile(f, "utf8")) as T;
    } catch (e) {
      throw new Error(`corrupt ${collection}/${id}.json: ${(e as Error).message}`);
    }
  }

  /** Ids present in a collection. */
  async list(collection: Collection): Promise<string[]> {
    const d = this.dir(collection);
    if (!existsSync(d)) return [];
    return (await readdir(d)).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -".json".length)).sort();
  }

  /** Load every entity in a collection. A single corrupt file is skipped-and-warned
   *  (a library collection stays usable) rather than aborting the whole boot. */
  async loadAll<T>(collection: Collection): Promise<T[]> {
    const out: T[] = [];
    for (const id of await this.list(collection)) {
      try {
        const v = await this.load<T>(collection, id);
        if (v != null) out.push(v);
      } catch (e) {
        console.warn(`[repo] skipping ${(e as Error).message}`);
      }
    }
    return out;
  }

  /** Delete one entity (no-op if absent). */
  async delete(collection: Collection, id: string): Promise<void> {
    const f = this.file(collection, id);
    if (existsSync(f)) await rm(f);
  }

  // ── CSV imports ────────────────────────────────────────────────────────────
  async saveImport(name: string, csvText: string): Promise<void> {
    assertSafeId(name);
    await mkdir(join(this.root, "imports"), { recursive: true });
    const f = join(this.root, "imports", `${name}.csv`);
    const tmp = `${f}.tmp`;
    await writeFile(tmp, csvText, "utf8");
    await rename(tmp, f);
  }

  async loadImport(name: string): Promise<Catalog | null> {
    assertSafeId(name);
    const f = join(this.root, "imports", `${name}.csv`);
    if (!existsSync(f)) return null;
    return parseCatalogCsv(await readFile(f, "utf8"));
  }

  async listImports(): Promise<string[]> {
    const d = join(this.root, "imports");
    if (!existsSync(d)) return [];
    return (await readdir(d)).filter((f) => f.endsWith(".csv")).map((f) => f.slice(0, -".csv".length)).sort();
  }
}
