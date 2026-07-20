/* ============================================================================
 * cwhitstats CAPTURE EXTRACTOR — paste into the app.cwhitstats.com console.
 * Proven end-to-end 2026-07-21 (Bronze Quick pitchers, 357 rows, full depth).
 * ----------------------------------------------------------------------------
 * THE SITE IS AN R SHINY APP. Key facts the extractor depends on:
 *   · The stats UI lives at app.cwhitstats.com/stats/ (the cwhitstats.com home
 *     page embeds it in a CROSS-ORIGIN iframe — you must be ON the app origin,
 *     parent-page JS cannot reach the iframe).
 *   · Tables are DataTables in SERVER-SIDE mode: the DOM holds only the current
 *     page (25 rows). recordsTotal is the real row count. To pull everything,
 *     set page length high and .draw() — Shiny returns the full set in ONE POST.
 *   · Shiny RE-RENDERS the table on any control change, so the table's element
 *     id CHANGES (DataTables_Table_2 -> _7 -> _8 ...). NEVER select by id.
 *     Find it by its COLUMN SIGNATURE instead (done below).
 *   · The Name column is HTML: <span data-player-card-name="...">. Strip it.
 *   · Values come at FULL precision (wOBAA 0.30395..., not 0.302) — keep it.
 *
 * CONTROLS (left sidebar, on the Pitchers/Hitters tab) and their DEFAULTS:
 *   · overall_val_min = 40  — THE GAME'S CARD-VALUE FLOOR. No card is < 40, ever.
 *                             LEAVE IT ALONE. Setting it to 0 removes nothing.
 *   · overall_val_max       — the tier cap (bronze 69, etc.). Matches the config.
 *   · pitcher_min_ip = 10   — default usage floor. (Programmatic changes to this
 *                             did NOT reliably propagate to the Shiny server in
 *                             testing — see the 2026-07-21 note; capture at the
 *                             default and apply IP>=150 / PA>=500 floors OURS-side.)
 *   · date range, data_environment (current), variant_mode (all_cards), role.
 *
 * USAGE, per table:
 *   1. Select Tournament type + Tournament in the sidebar; click Pitchers (or
 *      Hitters). Wait for the table to populate.
 *   2. Paste this whole file, then call:  await capture('pit')   // or 'hit'
 *   3. It downloads cap_<tourney>_<role>.tsv AND returns the provenance object.
 *      The download lands in the Downloads folder (may appear as a *.tmp during
 *      write) — move it into fixtures/cwhit/ and rename to the fixture slug.
 *   4. PROVENANCE: the returned object carries tourneyLabel, dates, val window,
 *      minIp, variants, env, role, recordsTotal. Put it in the fixture's leading
 *      "# ..." comment line so window-overlap + selection-intensity stay recorded.
 * ========================================================================== */
window.capture = async function capture(role /* 'pit' | 'hit' */) {
  const $ = window.jQuery;
  const sig = role === "pit"
    ? ["Name", "VAL", "VLvl", "Hand", "IP"]
    : ["Name", "VAL", "VLvl", "Hand", "PA"];
  const tb = [...document.querySelectorAll("table.dataTable")]
    .filter((t) => t.id && $.fn.DataTable.isDataTable(t))
    .find((t) => {
      const h = [...t.querySelectorAll("thead th")].map((x) => x.textContent.trim());
      return sig.every((s, i) => h[i] === s);
    });
  if (!tb) throw new Error(`${role} table not found — is the ${role === "pit" ? "Pitchers" : "Hitters"} tab active and loaded?`);
  const dt = $(tb).DataTable();
  dt.page.len(5000).draw();
  await new Promise((r) => setTimeout(r, 10000));           // let Shiny return the full set

  const hdr = dt.columns().header().toArray().map((h) => h.textContent.trim());
  const strip = (v) => {
    if (typeof v !== "string") return v;
    const m = v.match(/data-player-card-name="([^"]+)"/);
    if (m) return m[1];
    const d = document.createElement("div"); d.innerHTML = v; return d.textContent.trim();
  };
  const data = dt.rows().data();
  const lines = [hdr.join("\t")];
  for (let i = 0; i < data.length; i++) lines.push(data[i].map(strip).join("\t"));
  const tsv = lines.join("\n");

  const g = (id) => { const e = document.getElementById(id); return e ? e.value : null; };
  const dates = [...document.querySelectorAll("input.form-control")]
    .filter((i) => /^\d{4}-\d{2}-\d{2}$/.test(i.value)).map((i) => i.value);
  const prov = {
    role, tourneyType: g("tourney_cat"), tourneyKey: g("tourney_key"),
    tourneyLabel: (document.getElementById("tourney_key") || {}).selectedOptions?.[0]?.text || null,
    env: g("data_environment"), variants: g("variant_mode"),
    valMin: g("overall_val_min"), valMax: g("overall_val_max"),
    minIp: g("pitcher_min_ip"), minPa: g("hitter_min_pa"),
    dateStart: dates[0], dateEnd: dates[1],
    recordsTotal: dt.page.info().recordsTotal, rows: data.length,
  };

  const slug = (prov.tourneyKey || "table").replace(/[^a-z0-9]+/gi, "").toLowerCase();
  const blob = new Blob([tsv], { type: "text/tab-separated-values" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = `cap_${slug}_${role}.tsv`;
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  return prov;
};
