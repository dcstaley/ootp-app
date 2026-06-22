// App-wide state + actions, shared by the shell (global selectors) and the pages
// (Cards grid, Accounts management). Scoring is server-side; this just fetches the
// active (tournament, account) view and exposes the mutations.

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Card, Meta, TournamentOpt, AccountOpt } from "./shared.ts";

interface ImportResult { ok: boolean; error?: string; matched?: number; unmatched?: number; column?: string; newId?: string }

interface AppData {
  tournaments: TournamentOpt[]; tournamentId: string; chooseTournament: (id: string) => void;
  accounts: AccountOpt[]; accountId: string; chooseAccount: (id: string) => void;
  activeAccount: AccountOpt | undefined;
  cards: Card[]; meta: Meta | null; loading: boolean; busy: string | null; err: string | null;
  reloadView: () => Promise<void>;
  loadAccounts: () => Promise<unknown>;
  renameAccount: (id: string, name: string) => Promise<void>;
  importOwnership: (args: { id?: string; name?: string; text: string }) => Promise<ImportResult>;
  toggleVariant: (cardId: string, on: boolean) => Promise<void>;
  importVariants: (text: string) => Promise<ImportResult>;
  clearVariants: () => Promise<void>;
}

const Ctx = createContext<AppData | null>(null);
export const useAppData = (): AppData => {
  const c = useContext(Ctx);
  if (!c) throw new Error("useAppData must be used within AppDataProvider");
  return c;
};

const post = (url: string, body: unknown, json = true) =>
  fetch(url, { method: "POST", headers: { "Content-Type": json ? "application/json" : "text/csv" }, body: json ? JSON.stringify(body) : (body as string) });

export function AppDataProvider({ children }: { children: ReactNode }) {
  const [tournaments, setTournaments] = useState<TournamentOpt[]>([]);
  const [tournamentId, setTournamentId] = useState("");
  const [accounts, setAccounts] = useState<AccountOpt[]>([]);
  const [accountId, setAccountId] = useState("");
  const [cards, setCards] = useState<Card[]>([]);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const loadAccounts = () =>
    fetch("/api/accounts").then((r) => r.json()).then((d: { accounts: AccountOpt[]; activeId: string | null }) => {
      setAccounts(d.accounts);
      setAccountId((cur) => cur || d.activeId || d.accounts[0]?.id || "");
      return d;
    });

  useEffect(() => {
    fetch("/api/tournaments").then((r) => r.json())
      .then((d: { tournaments: TournamentOpt[]; defaultId: string }) => {
        setTournaments(d.tournaments);
        setTournamentId(d.defaultId || d.tournaments[0]?.id || "");
      }).catch((e) => setErr(String(e)));
    loadAccounts().catch((e) => setErr(String(e)));
  }, []);

  const view = (tid: string, aid: string) =>
    `?tournament=${encodeURIComponent(tid)}${aid ? `&account=${encodeURIComponent(aid)}` : ""}`;

  // Tournament drives scoring (server resolves era/park/softcaps + re-calibrates);
  // account scopes owned + variants. The pages just read the result.
  useEffect(() => {
    if (!tournamentId) return;
    const q = view(tournamentId, accountId);
    setLoading(true);
    Promise.all([fetch("/api/meta" + q).then((r) => r.json()), fetch("/api/cards" + q).then((r) => r.json())])
      .then(([m, c]) => { setMeta(m); setCards(c); }).catch((e) => setErr(String(e))).finally(() => setLoading(false));
  }, [tournamentId, accountId]);

  const reloadView = () => {
    if (!tournamentId) return Promise.resolve();
    const q = view(tournamentId, accountId);
    return Promise.all([fetch("/api/meta" + q).then((r) => r.json()), fetch("/api/cards" + q).then((r) => r.json())])
      .then(([m, c]) => { setMeta(m); setCards(c); });
  };

  const persist = (patch: Record<string, string>) => post("/api/state", patch).catch(() => {});
  const chooseTournament = (id: string) => { setTournamentId(id); persist({ activeTournamentId: id }); };
  const chooseAccount = (id: string) => { setAccountId(id); persist({ activeAccountId: id }); };

  const renameAccount = async (id: string, name: string) => {
    setBusy("rename");
    await post("/api/accounts/rename", { id, name });
    await loadAccounts();
    setBusy(null);
  };

  const importOwnership = async ({ id, name, text }: { id?: string; name?: string; text: string }): Promise<ImportResult> => {
    setBusy("upload");
    const qs = id ? `?id=${encodeURIComponent(id)}` : `?name=${encodeURIComponent(name ?? "Account")}`;
    const r = await post("/api/accounts/import" + qs, text, false);
    const d = await r.json().catch(() => null);
    if (!r.ok) { setErr(d?.error || "import failed"); setBusy(null); return { ok: false, error: d?.error }; }
    await loadAccounts();
    const newId = !id && d?.accounts?.length ? d.accounts[d.accounts.length - 1].id : undefined;
    if (newId) chooseAccount(newId); else await reloadView(); // catalog changed → refresh
    setBusy(null);
    return { ok: true, newId };
  };

  const toggleVariant = async (cardId: string, on: boolean) => {
    if (!accountId) return;
    setBusy("variant");
    await post("/api/accounts/variants/toggle", { id: accountId, cardId, on });
    await loadAccounts();
    await reloadView();
    setBusy(null);
  };

  const importVariants = async (text: string): Promise<ImportResult> => {
    if (!accountId) return { ok: false, error: "no active account" };
    setBusy("variant");
    const r = await post("/api/accounts/variants/import?id=" + encodeURIComponent(accountId), text, false);
    const d = await r.json().catch(() => null);
    if (!r.ok) { setErr(d?.error || "variant import failed"); setBusy(null); return { ok: false, error: d?.error }; }
    await loadAccounts();
    await reloadView();
    setBusy(null);
    return { ok: true, matched: d.matched, unmatched: d.unmatched, column: d.column };
  };

  const clearVariants = async () => { await importVariants("CID\n"); };

  const value: AppData = {
    tournaments, tournamentId, chooseTournament,
    accounts, accountId, chooseAccount, activeAccount: accounts.find((a) => a.id === accountId),
    cards, meta, loading, busy, err,
    reloadView, loadAccounts, renameAccount, importOwnership, toggleVariant, importVariants, clearVariants,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
