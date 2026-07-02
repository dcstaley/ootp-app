// App shell: a left sidebar (app title, global Tournament + Account selectors,
// page nav) + a routed main content area. Hash routing (no server route config —
// the server already falls back to index.html). Global selectors scope every page
// and live in the sidebar; per-page state lives in the pages.

import { useEffect, useState } from "react";
import { AppDataProvider, useAppData } from "./state.tsx";
import { C, inputStyle } from "./shared.ts";
import { CardsPage } from "./CardsPage.tsx";
import { AccountsPage } from "./AccountsPage.tsx";
import { RosterPage } from "./RosterPage.tsx";
import { TournamentsPage } from "./TournamentsPage.tsx";
import { ErasParksPage } from "./ErasParksPage.tsx";
import { ModelTrainingPage } from "./ModelTrainingPage.tsx";

interface Route { id: string; label: string; group: string; element: () => JSX.Element }

function Placeholder({ title, note }: { title: string; note: string }) {
  return (
    <div style={{ maxWidth: 620 }}>
      <h2 style={{ margin: "0 0 8px" }}>{title}</h2>
      <p style={{ color: C.sub, fontSize: 14, lineHeight: 1.5 }}>{note}</p>
    </div>
  );
}

const ROUTES: Route[] = [
  { id: "cards", label: "Cards", group: "Build", element: CardsPage },
  { id: "roster", label: "Roster & Lineups", group: "Build", element: RosterPage },
  { id: "single-player", label: "Single Player", group: "Build", element: () => <Placeholder title="Single Player" note="Single-Player mode (M7): import an SP Export.csv, map its columns to the standard names, and score it through the same core — including current vs potential ratings. Account features don't apply to SP." /> },
  { id: "accounts", label: "Accounts", group: "Setup", element: AccountsPage },
  { id: "tournaments", label: "Tournaments", group: "Setup", element: TournamentsPage },
  { id: "eras", label: "Eras & Parks", group: "Setup", element: ErasParksPage },
  { id: "training", label: "Model Training", group: "Setup", element: ModelTrainingPage },
];
const ROUTE_IDS = new Set(ROUTES.map((r) => r.id));

function useHashRoute(): [string, (id: string) => void] {
  const read = () => (window.location.hash.replace(/^#\/?/, "") || "cards");
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => setRoute(read());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const go = (id: string) => { window.location.hash = `#/${id}`; };
  return [ROUTE_IDS.has(route) ? route : "cards", go];
}

function Sidebar({ route, go }: { route: string; go: (id: string) => void }) {
  const { tournaments, tournamentId, chooseTournament, accounts, accountId, chooseAccount, busy, loading } = useAppData();
  const groups = [...new Set(ROUTES.map((r) => r.group))];
  const labelStyle: React.CSSProperties = { fontSize: 11, color: C.sub, textTransform: "uppercase", letterSpacing: 0.5, margin: "0 0 4px" };

  return (
    <aside style={{ width: 230, flex: "0 0 230px", background: C.sidebar, borderRight: `1px solid ${C.border}`, height: "100vh", position: "sticky", top: 0, overflow: "auto", padding: 14, boxSizing: "border-box" }}>
      <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 14 }}>OOTP Optimizer</div>

      <div style={{ marginBottom: 6 }}>
        <div style={labelStyle}>Tournament</div>
        <select value={tournamentId} onChange={(e) => chooseTournament(e.target.value)} disabled={!tournaments.length}
          style={{ ...inputStyle, width: "100%", cursor: "pointer" }}>
          {[...tournaments].sort((a, b) => a.name.localeCompare(b.name)).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </div>
      <div style={{ marginBottom: 14 }}>
        <div style={labelStyle}>Account</div>
        <select value={accountId} onChange={(e) => chooseAccount(e.target.value)} disabled={!accounts.length}
          style={{ ...inputStyle, width: "100%", cursor: "pointer" }}>
          {!accounts.length && <option value="">(no accounts)</option>}
          {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        {(loading || busy) && <div style={{ fontSize: 11, color: C.sub, marginTop: 4 }}>{busy === "upload" ? "importing…" : busy === "variant" ? "updating variants…" : busy === "rename" ? "saving…" : "scoring…"}</div>}
      </div>

      {groups.map((g) => (
        <div key={g} style={{ marginBottom: 12 }}>
          <div style={labelStyle}>{g}</div>
          {ROUTES.filter((r) => r.group === g).map((r) => (
            <a key={r.id} onClick={() => go(r.id)}
              style={{ display: "block", padding: "6px 8px", borderRadius: 6, cursor: "pointer", fontSize: 13, marginBottom: 2,
                background: route === r.id ? C.navActive : "transparent", color: route === r.id ? C.text : C.sub, fontWeight: route === r.id ? 600 : 400 }}>
              {r.label}
            </a>
          ))}
        </div>
      ))}
    </aside>
  );
}

function Shell() {
  const [route, go] = useHashRoute();
  const { err } = useAppData();
  const Active = (ROUTES.find((r) => r.id === route) ?? ROUTES[0]!).element;
  return (
    <div style={{ display: "flex", fontFamily: "system-ui, sans-serif", color: C.text, background: C.bg, minHeight: "100vh" }}>
      <Sidebar route={route} go={go} />
      <main style={{ flex: 1, padding: 16, minWidth: 0 }}>
        {err && <p style={{ color: "#f87171" }}>Failed to load: {err} — is the server running?</p>}
        <Active />
      </main>
    </div>
  );
}

export function App() {
  return (
    <AppDataProvider>
      <Shell />
    </AppDataProvider>
  );
}
