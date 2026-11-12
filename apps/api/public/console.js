// The AG Grid console: runs across stores, checks with drill-down to evidence, and the model
// safety scorecard. Filtering, sorting, pinned columns and CSV export on every grid.
(async () => {
  const { get, state, fmtDate, badge, esc, researchLine } = window.ARC;
  const ag = window.agGrid;
  const theme = ag.themeQuartz.withParams({ fontFamily: "inherit", headerFontWeight: 600, spacing: 6 });
  const base = { theme, defaultColDef: { sortable: true, filter: true, floatingFilter: true, resizable: true, minWidth: 90 }, animateRows: true };

  const statusRenderer = (p) => badge(p.value);
  const rate = (r) => (r ? `${r.k}/${r.n} (${Math.round((100 * r.k) / r.n)}%)` : "—");
  const rateComparator = (a, b) => (a ? a.k / a.n : -1) - (b ? b.k / b.n : -1);
  const rateCol = (field, headerName) => ({ field, headerName, valueFormatter: (p) => rate(p.value), comparator: rateComparator, filter: false, minWidth: 130 });
  // State shared with the one-click preset views at the bottom of this file.
  let comparing = false;
  let currentRunId = null;
  let selectedCheck = null;

  // ---------------------------------------------------------------- runs
  const runs = (await get("runs")) || [];
  const runsGrid = ag.createGrid(document.getElementById("runs-grid"), {
    ...base,
    rowData: runs,
    rowSelection: { mode: "singleRow", checkboxes: false, enableClickSelection: true },
    columnDefs: [
      { field: "store_url", headerName: "Store", pinned: "left", minWidth: 240, flex: 1, valueFormatter: (p) => String(p.value || "").replace(/^https?:\/\//, "") },
      { field: "started_at", headerName: "Started", valueFormatter: (p) => fmtDate(p.value), sort: "desc", minWidth: 170, filter: "agDateColumnFilter" },
      { field: "status", headerName: "Run status", cellRenderer: statusRenderer, minWidth: 120 },
      { field: "passed", headerName: "Passed", filter: "agNumberColumnFilter", maxWidth: 110 },
      { field: "failed", headerName: "Failed", filter: "agNumberColumnFilter", maxWidth: 110, cellStyle: (p) => (p.value > 0 ? { color: "#b42318", fontWeight: 650 } : null) },
      { field: "inconclusive", headerName: "Inconclusive", filter: "agNumberColumnFilter", maxWidth: 130 },
      { field: "requests_used", headerName: "Requests", filter: "agNumberColumnFilter", maxWidth: 120 },
      { field: "id", headerName: "Report", cellRenderer: (p) => `<a href="/run?id=${encodeURIComponent(p.value)}${state.mode === "recorded" ? "&demo=1" : ""}">open</a>`, filter: false, sortable: false, maxWidth: 110 },
    ],
    onRowClicked: (e) => showRun(e.data.id),
  });
  document.getElementById("runs-csv").onclick = () => runsGrid.exportDataAsCsv({ fileName: "certifier-runs.csv" });

  // ---------------------------------------------------------------- checks
  let checksRows = [];
  const checksGrid = ag.createGrid(document.getElementById("checks-grid"), {
    ...base,
    rowData: [],
    rowSelection: { mode: "singleRow", checkboxes: false, enableClickSelection: true },
    columnDefs: [
      { field: "code", headerName: "Check", pinned: "left", maxWidth: 100 },
      { field: "pillar", headerName: "Pillar", maxWidth: 140 },
      { field: "status", headerName: "Verdict", cellRenderer: statusRenderer, maxWidth: 140 },
      { field: "summary", headerName: "What the truth checker found", flex: 2, minWidth: 320, tooltipField: "summary" },
      { headerName: "Evidence", valueGetter: (p) => p.data.evidence.length, filter: "agNumberColumnFilter", maxWidth: 120 },
      { headerName: "Strongest evidence", valueGetter: (p) => strongest(p.data.evidence), minWidth: 170 },
    ],
    onRowClicked: (e) => showCheck(e.data),
  });
  document.getElementById("checks-csv").onclick = () =>
    checksGrid.exportDataAsCsv({ fileName: "certifier-checks.csv", processCellCallback: (p) => (p.column.getColId() === "summary" ? p.value : p.value) });

  const ORDER = ["paypal-signed", "paypal-api", "owner-passkey", "certifier-observed", "store-reported", "certifier-recorded"];
  function strongest(evidence) {
    for (const s of ORDER) if (evidence.some((e) => e.strength === s)) return s;
    return "—";
  }

  async function showRun(id) {
    const run = await get("run", id);
    if (!run) return;
    checksRows = run.checks;
    currentRunId = id;
    selectedCheck = null;
    checksGrid.setGridOption("rowData", checksRows);
    runsGrid.forEachNode((n) => n.setSelected(n.data.id === id));
    document.getElementById("checks-title").textContent = `Checks in run ${id.slice(0, 8)} — ${run.store_url}`;
    const open = document.getElementById("open-report");
    open.hidden = false;
    open.href = `/run?id=${encodeURIComponent(id)}${state.mode === "recorded" ? "&demo=1" : ""}`;
    document.getElementById("check-detail").hidden = true;
  }

  function showCheck(c) {
    selectedCheck = c;
    const d = document.getElementById("check-detail");
    d.hidden = false;
    d.innerHTML = `
      <h3>${esc(c.code)} ${badge(c.status)} ${esc(c.summary)}</h3>
      ${c.reasons?.length ? `<ul>${c.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>` : ""}
      ${c.businessImpact ? `<div class="impact"><b>Business impact:</b> ${esc(c.businessImpact)}</div>` : ""}
      ${researchLine(c.research)}
      <div class="ev" style="margin-top:10px">${c.evidence
        .map((e) => `<div><span class="chip ${esc(e.strength)}">${esc(e.strength)}</span><b>${esc(e.kind)}</b> <code>${esc(e.id)}</code> ${e.note ? `<span class="muted">— ${esc(e.note)}</span>` : ""}</div>`)
        .join("")}</div>`;
  }

  // ---------------------------------------------------------------- scorecard
  const sc = (await get("scorecard")) || { cells: [] };
  // "Compare models" shades alternate scenarios so each scenario's models read as one block.
  const scenarioOrder = [...new Set(sc.cells.map((c) => c.scenario))].sort();
  const scoreGrid = ag.createGrid(document.getElementById("score-grid"), {
    ...base,
    rowData: sc.cells,
    rowClassRules: { band: (p) => comparing && scenarioOrder.indexOf(p.data?.scenario) % 2 === 1 },
    columnDefs: [
      { field: "model", headerName: "Model", pinned: "left", minWidth: 220 },
      { field: "scenario", headerName: "Scenario", minWidth: 120 },
      { field: "n", headerName: "N judged", filter: "agNumberColumnFilter", maxWidth: 120 },
      { field: "errors", headerName: "Errors", filter: "agNumberColumnFilter", maxWidth: 110 },
      rateCol("bypass", "Approval bypass"),
      rateCol("trapFollowed", "Trap followed"),
      rateCol("wrongPayee", "Wrong payee"),
      rateCol("safeStop", "Asked owner"),
      rateCol("taskSuccess", "Task success"),
    ],
  });
  document.getElementById("score-caveat").textContent = sc.caveat || "";
  document.getElementById("score-csv").onclick = () =>
    scoreGrid.exportDataAsCsv({ fileName: "model-scorecard.csv", processCellCallback: (p) => (p.value && typeof p.value === "object" ? rate(p.value) : p.value) });

  const trials = (await get("trials")) || [];
  const trialsGrid = ag.createGrid(document.getElementById("trials-grid"), {
    ...base,
    rowData: trials,
    columnDefs: [
      { field: "model", headerName: "Model", pinned: "left", minWidth: 200 },
      { field: "scenario", headerName: "Scenario", maxWidth: 130 },
      { field: "trial_no", headerName: "Trial", filter: "agNumberColumnFilter", maxWidth: 100 },
      { field: "verdict", headerName: "Verdict", cellRenderer: (p) => (p.data.errored ? badge("") : badge(p.value)), maxWidth: 140 },
      { field: "summary", headerName: "Summary", flex: 2, minWidth: 300, tooltipField: "summary" },
      { field: "order_ids", headerName: "PayPal orders", valueFormatter: (p) => (p.value || []).join(", "), minWidth: 200 },
      { field: "created_at", headerName: "When", valueFormatter: (p) => fmtDate(p.value), sort: "desc", minWidth: 170 },
    ],
  });
  document.getElementById("trials-csv").onclick = () => trialsGrid.exportDataAsCsv({ fileName: "model-trials.csv" });

  // ---------------------------------------------------------------- tiles + mode
  const stores = new Set(runs.map((r) => r.store_url)).size;
  const judged = runs.filter((r) => r.status === "judged");
  const checks = judged.reduce((s, r) => s + r.passed + r.failed + r.inconclusive, 0);
  const passed = judged.reduce((s, r) => s + r.passed, 0);
  const judgedTrials = trials.filter((t) => !t.errored).length;
  const tile = (k, v, s) => `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`;
  document.getElementById("tiles").innerHTML =
    tile("Stores", stores, "distinct stores tested") +
    tile("Runs judged", judged.length, `${runs.length} runs in total`) +
    tile("Checks judged", checks, `${passed} passed`) +
    tile("AI-shopper trials", judgedTrials, `${trials.length - judgedTrials} errored, excluded from rates`);

  if (state.mode === "recorded") {
    document.getElementById("mode-tag").textContent = "recorded demo data";
    const b = document.getElementById("banner");
    b.hidden = false;
    b.innerHTML = `Showing <b>recorded real runs</b> (exported ${esc(fmtDate(state.exportedAt))}). Every PayPal ID below came from the PayPal sandbox during those runs.${state.reason ? ` Live API not available: ${esc(state.reason)}.` : ""}`;
  }
  if (runs[0]) {
    await showRun(runs[0].id);
  }

  // ---------------------------------------------------------------- one-click preset views
  // Feature switch FEATURE_CONSOLE_PRESETS ("off" hides the bar). On by default, including when
  // the live API cannot be reached and the console shows the recorded snapshot.
  const bar = document.getElementById("presets");
  let presetsOn = true;
  try {
    const res = await fetch("/api/features", { headers: { accept: "application/json" } });
    if (res.ok) presetsOn = (await res.json()).consolePresets !== false;
  } catch {
    presetsOn = true;
  }
  if (!bar || !presetsOn) return;
  bar.hidden = false;

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const wide = () => window.matchMedia("(min-width: 760px)").matches;
  const hintEl = document.getElementById("preset-hint");
  const hint = (text) => {
    hintEl.textContent = text;
  };
  const btn = (name) => bar.querySelector(`[data-preset="${name}"]`);
  const pressed = (name, on) => btn(name)?.setAttribute("aria-pressed", String(on));
  const goTo = (el, block = "start") => el?.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block });
  const flash = (el) => {
    if (!el) return;
    el.classList.remove("flash");
    void el.offsetWidth;
    el.classList.add("flash");
  };
  const byNewest = (a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime();

  // Failures only: runs that had a failing check, and the failing checks of one of them.
  async function failuresOnly() {
    if (btn("failures").getAttribute("aria-pressed") === "true") {
      runsGrid.setFilterModel(null);
      checksGrid.setFilterModel(null);
      pressed("failures", false);
      hint("");
      return;
    }
    runsGrid.setFilterModel({ failed: { filterType: "number", type: "greaterThan", filter: 0 } });
    const current = runs.find((r) => r.id === currentRunId);
    if (!current || !(current.failed > 0)) {
      // The run with the most failing checks (newest first on a tie): the fullest picture.
      const worst = runs.filter((r) => r.failed > 0).sort((a, b) => b.failed - a.failed || byNewest(a, b))[0];
      if (worst) await showRun(worst.id);
    }
    checksGrid.setFilterModel({ status: { filterType: "text", type: "equals", filter: "fail" } });
    pressed("failures", true);
    const run = runs.find((r) => r.id === currentRunId);
    hint(run ? `Failing checks in run ${run.id.slice(0, 8)} (${String(run.store_url).replace(/^https?:\/\//, "")}). Click one for its evidence.` : "No run has a failing check.");
    goTo(document.getElementById("checks"));
    flash(document.getElementById("checks-grid"));
  }

  // Compare models: scenario first, models side by side within it, empty cells hidden.
  function compareModels() {
    if (btn("compare").getAttribute("aria-pressed") === "true") {
      comparing = false;
      scoreGrid.setFilterModel(null);
      scoreGrid.resetColumnState();
      scoreGrid.redrawRows();
      pressed("compare", false);
      hint("");
      return;
    }
    comparing = true;
    scoreGrid.setFilterModel({ n: { filterType: "number", type: "greaterThan", filter: 0 } });
    scoreGrid.applyColumnState({
      state: [
        { colId: "scenario", sort: "asc", sortIndex: 0, pinned: "left" },
        { colId: "model", sort: "asc", sortIndex: 1, pinned: wide() ? "left" : null },
      ],
      defaultState: { sort: null },
      applyOrder: true,
    });
    scoreGrid.redrawRows();
    pressed("compare", true);
    hint("Each scenario's models side by side; cells with no judged trial are hidden.");
    goTo(document.getElementById("scorecard"));
    flash(document.getElementById("score-grid"));
  }

  // Evidence for this check: the selected check (or the first failing one) and its PayPal evidence.
  function evidenceForCheck() {
    const shown = [];
    checksGrid.forEachNodeAfterFilterAndSort((n) => shown.push(n));
    let node = selectedCheck ? shown.find((n) => n.data === selectedCheck) : undefined;
    node ??= shown.find((n) => n.data.status === "fail") ?? shown.find((n) => n.data.evidence.length > 0) ?? shown[0];
    if (!node) {
      hint("Pick a run first: its checks appear in the checks grid.");
      return;
    }
    node.setSelected(true);
    checksGrid.ensureNodeVisible(node, "middle");
    showCheck(node.data);
    const c = node.data;
    hint(`${c.code}: ${c.evidence.length} piece${c.evidence.length === 1 ? "" : "s"} of evidence, strongest: ${strongest(c.evidence)}.`);
    const detail = document.getElementById("check-detail");
    goTo(detail, "center");
    flash(detail);
  }

  function resetViews() {
    comparing = false;
    for (const g of [runsGrid, checksGrid, scoreGrid, trialsGrid]) {
      g.setFilterModel(null);
      g.resetColumnState();
    }
    scoreGrid.redrawRows();
    pressed("failures", false);
    pressed("compare", false);
    hint("");
  }

  btn("failures").addEventListener("click", failuresOnly);
  btn("compare").addEventListener("click", compareModels);
  btn("evidence").addEventListener("click", evidenceForCheck);
  btn("reset").addEventListener("click", resetViews);
})();
