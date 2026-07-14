// cwhitstats eval join layer (Batch-1 item 4) — public surface. Parser (raw event tables → typed
// rows) + the catalog join (unique-key + rating-fingerprint disambiguation). The Batch-2 audit
// consumes this; the driver (tools/cwhit-join.ts) supplies the fingerprints from the live catalog.
export * from "./parse.ts";
export * from "./join.ts";
