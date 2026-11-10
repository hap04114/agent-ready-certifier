// One run's report: four pillars, every check with its reasons, business impact and evidence.
(async () => {
  const { get, state, fmtDate, badge, esc, PILLARS } = window.ARC;
  const id = new URLSearchParams(location.search).get("id");
  const run = id ? await get("run", id) : undefined;
  const summary = document.getElementById("summary");
  if (!run) {
    summary.textContent = "Run not found.";
    return;
  }
  if (state.mode === "recorded") {
    document.getElementById("mode-tag").textContent = "recorded demo data";
    document.getElementById("back").href = "/?demo=1";
    const b = document.getElementById("banner");
    b.hidden = false;
    b.textContent = `Recorded real run (exported ${fmtDate(state.exportedAt)}). The PayPal IDs came from the PayPal sandbox during this run.`;
  }

  const count = (checks, s) => checks.filter((c) => c.status === s).length;
  const dur = run.finished_at ? Math.round((new Date(run.finished_at) - new Date(run.started_at)) / 1000) : null;
  summary.innerHTML = `
    <div class="line" style="display:flex;gap:12px;flex-wrap:wrap;align-items:baseline">
      <h2 style="margin:0;font-size:18px">${esc(run.store_url)}</h2> ${badge(run.status)}
    </div>
    <p class="muted" style="margin:6px 0 0">Run <code>${esc(run.id)}</code> · started ${esc(fmtDate(run.started_at))}${dur !== null ? ` · ${dur}s` : ""} ·
      ${run.requests_used}/${run.budget_requests} requests (budget) ·
      <b>${count(run.checks, "pass")}</b> passed, <b>${count(run.checks, "fail")}</b> failed, <b>${count(run.checks, "inconclusive")}</b> inconclusive</p>
    ${run.recording ? `<p class="muted" style="margin:6px 0 0">Browser recording: Kernel replay <code>${esc(run.recording.replayId)}</code> (attached as evidence to the browser-based checks)</p>` : ""}
    ${run.error ? `<p class="muted" style="margin:6px 0 0">Run note: ${esc(run.error)}</p>` : ""}`;

  const byPillar = {};
  for (const c of run.checks) byPillar[c.pillar] = [...(byPillar[c.pillar] || []), c];
  const order = ["works", "current", "secure", "agent-ready"];
  document.getElementById("pillars").innerHTML = order
    .map((p) => {
      const cs = byPillar[p] || [];
      const meta = PILLARS[p];
      return `<div class="pillar"><h3>${meta.title}</h3><div class="q">${esc(meta.q)}</div>
        <div class="counts">${cs.length ? `<span class="badge pass">${count(cs, "pass")} pass</span><span class="badge fail">${count(cs, "fail")} fail</span><span class="badge inconclusive">${count(cs, "inconclusive")} inconclusive</span>` : '<span class="badge neutral">not run</span>'}</div></div>`;
    })
    .join("");

  document.getElementById("sections").innerHTML = order
    .filter((p) => byPillar[p])
    .map(
      (p) => `<section class="card"><div class="head"><div><h2>${PILLARS[p].title}</h2><p>${esc(PILLARS[p].q)}</p></div></div><div class="body">
        ${byPillar[p]
          .map(
            (c) => `<div class="check">
              <div class="line"><span class="code">${esc(c.code)}</span>${badge(c.status)}<span class="sum">${esc(c.summary)}</span></div>
              ${c.reasons?.length ? `<ul class="reasons">${c.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>` : ""}
              ${c.businessImpact ? `<div class="impact"><b>Business impact:</b> ${esc(c.businessImpact)}</div>` : ""}
              <div class="ev">${c.evidence.map((e) => `<div><span class="chip ${esc(e.strength)}">${esc(e.strength)}</span>${esc(e.kind)} <code>${esc(e.id)}</code>${e.note ? ` — ${esc(e.note)}` : ""}</div>`).join("")}</div>
            </div>`,
          )
          .join("")}
      </div></section>`,
    )
    .join("");

  document.getElementById("log").textContent = (run.log || []).join("\n") || "No log was recorded for this run (runs before the recorded-log feature).";
})();
