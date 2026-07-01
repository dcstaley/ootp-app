// Dev launcher: starts the api server (8787, the scoring core) and, once it is
// listening, the Vite dev server (5173, live-reload UI that proxies /api → 8787).
// Exposed as `npm run dev` and the first launch.json config, so Claude's "Start
// preview" button opens the live-reload UI (5173) with the api already up behind
// it — not the static build on 8787.
//
// Both children are spawned as plain node processes (no shell wrapper) so they
// are real PIDs we can reliably kill on shutdown (avoids orphans on Windows).

import { spawn, type ChildProcess } from "node:child_process";

const node = process.execPath;
const children: ChildProcess[] = [];
const start = (args: string[], env?: NodeJS.ProcessEnv) => {
  const c = spawn(node, args, { stdio: "inherit", env: { ...process.env, ...env } });
  children.push(c);
  return c;
};
const shutdown = () => { for (const c of children) { try { c.kill(); } catch { /* ignore */ } } process.exit(0); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Pin the api to 8787 even though the launcher itself may inherit PORT=5173 from
// the preview harness (Vite owns 5173 and proxies /api here).
start(["src/server/server.ts"], { PORT: "8787" });

// Wait for the api to answer before starting Vite, so the first page load's
// /api calls don't hit a not-yet-ready proxy target.
for (let i = 0; i < 120; i++) {
  try { if ((await fetch("http://localhost:8787/api/meta")).ok) break; } catch { /* not up yet */ }
  await new Promise((r) => setTimeout(r, 500));
}

start(["node_modules/vite/bin/vite.js", "--config", "web/vite.config.ts"]);
for (const c of children) c.on("exit", shutdown);

// Packaged double-click launcher: open the browser once the UI (Vite, 5173) is ready.
// Gated by LAUNCH_OPEN so a plain `npm run dev` (dev workflow) doesn't spawn a browser tab.
if (process.env.LAUNCH_OPEN === "1") {
  const url = "http://localhost:5173/";
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(url)).ok) break; } catch { /* Vite not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  try {
    if (process.platform === "win32") spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true }).unref();
    else if (process.platform === "darwin") spawn("open", [url], { stdio: "ignore", detached: true }).unref();
    else spawn("xdg-open", [url], { stdio: "ignore", detached: true }).unref();
  } catch { /* best-effort; the console shows the URL regardless */ }
  console.log(`[launcher] app ready — opening ${url}`);
}
