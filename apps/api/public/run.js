// One run's report: four pillars, every check with its reasons, business impact and evidence.
(async () => {
  const { get, state, fmtDate, badge, esc, PILLARS, researchLine } = window.ARC;

  /** Load our own bundled copy of Bryntum Scheduler (Community, MIT) only when a timeline exists. */
  const loadBryntum = () =>
    window.BryntumScheduler
      ? Promise.resolve()
      : new Promise((resolve, reject) => {
          for (const href of ["/assets/bryntum-scheduler.css", "/assets/bryntum-theme.css"]) {
            const l = document.createElement("link");
            l.rel = "stylesheet";
            l.href = href;
            document.head.appendChild(l);
          }
          const s = document.createElement("script");
          s.src = "/assets/bryntum-scheduler.js";
          s.onload = () => resolve();
          s.onerror = reject;
          document.head.appendChild(s);
        });

  /** The run's signed certificate (issued on first request), with verification status and proofs. */
  async function renderCertificate(runId) {
    const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/certificate`);
    if (!res.ok) return; // signing not configured, or run not judged: no card
    const c = await res.json();
    const status = c.verified === true ? badge("pass").replace(">pass<", ">signature verified<") : c.verified === false ? badge("fail").replace(">fail<", ">signature INVALID<") : badge("inconclusive").replace(">inconclusive<", ">not checked<");
    const log = c.hashLog;
    document.getElementById("cert-card").hidden = false;
    document.getElementById("cert").innerHTML = `
      <p>${status} <b>${esc(c.payload?.statement ?? "")}</b></p>
      <ul class="reasons">
        <li>Store: <code>${esc(c.payload?.sub ?? "")}</code> · run <code>${esc(c.payload?.jti ?? "")}</code> · issued ${esc(fmtDate(c.issuedAt))}</li>
        <li>Summary SHA-256: <code>${esc(c.summarySha256)}</code></li>
        ${log ? `<li>Hash log entry #${esc(log.seq)}: <code>${esc(log.entryHash)}</code> (previous <code>${esc(String(log.prevHash).slice(0, 16))}…</code>)</li>` : ""}
      </ul>
      <p class="small">
        <a href="/api/runs/${encodeURIComponent(runId)}/certificate" target="_blank" rel="noopener">Certificate (JSON)</a> ·
        <a href="/.well-known/certifier/jwks.json" target="_blank" rel="noopener">Public key</a> ·
        <a href="/api/hashlog" target="_blank" rel="noopener">Hash log</a>
        ${log ? ` · <a href="/api/hashlog/${esc(log.seq)}/entry.txt">Log entry text</a>` : ""}
        ${log?.openTimestamps ? ` · <a href="/api/hashlog/${esc(log.seq)}/proof.ots">OpenTimestamps proof (.ots)</a>` : ""}
      </p>`;
  }

  const KIND_COLOR = { setup: "blue", agent: "purple", wait: "gray", webhook: "orange", attack: "red", judge: "green" };
  async function renderTimeline(steps) {
    document.getElementById("timeline-card").hidden = false;
    const hooks = steps.filter((s) => s.kind === "webhook");
    document.getElementById("timeline-summary").textContent = hooks.length
      ? `PayPal webhook waits: ${hooks.map((h) => `${h.name.replace(/ \(.*\)$/, "")} ${Math.round(h.end - h.start)} s (${h.note ?? "done"})`).join("; ")}.`
      : "No webhook waits in this run.";
    await loadBryntum();
    const base = new Date(2026, 0, 1, 0, 0, 0);
    const at = (sec) => new Date(base.getTime() + sec * 1000);
    const total = Math.max(...steps.map((s) => s.end)) + 5;
    // Header shows time since the run started ("+1 min", "+30 s"), not a clock time.
    const rel = (d) => Math.round((d.getTime() - base.getTime()) / 1000);
    new window.BryntumScheduler({
      appendTo: "timeline",
      height: Math.min(70 + steps.length * 40, 720),
      rowHeight: 38,
      readOnly: true,
      startDate: base,
      endDate: at(total),
      viewPreset: {
        base: total > 600 ? "minuteAndHour" : "secondAndMinute",
        headers: [
          { unit: "minute", increment: 1, renderer: (start) => `+${Math.floor(rel(start) / 60)} min` },
          { unit: "second", increment: total > 600 ? 60 : 10, renderer: (start) => `${rel(start) % 60} s` },
        ],
      },
      columns: [{ text: "Step", field: "name", width: 300 }],
      resources: steps.map((s, i) => ({ id: i + 1, name: s.name })),
      events: steps.map((s, i) => ({
        id: i + 1,
        resourceId: i + 1,
        name: `${Math.max(1, Math.round(s.end - s.start))} s${s.note ? ` · ${s.note}` : ""}`,
        startDate: at(s.start),
        endDate: at(Math.max(s.end, s.start + 0.5)),
        eventColor: KIND_COLOR[s.kind] ?? "gray",
      })),
      features: { eventDrag: false, eventResize: false, eventDragCreate: false, eventEdit: false, eventMenu: false, scheduleMenu: false, cellEdit: false },
    });
  }
  const id = new URLSearchParams(location.search).get("id");
  const run = id ? await get("run", id) : undefined;
  const summary = document.getElementById("summary");
  if (!run) {
    summary.textContent = "Run not found.";
    return;
  }
  if (state.mode === "recorded") {
    document.getElementById("mode-tag").textContent = "recorded demo data";
    document.getElementById("back").href = "/console?demo=1";
    const b = document.getElementById("banner");
    b.hidden = false;
    b.textContent = `Recorded real run (exported ${fmtDate(state.exportedAt)}). The PayPal IDs came from the PayPal sandbox during this run.`;
  }

  const count = (checks, s) => checks.filter((c) => c.status === s).length;
  const diag = (d) => `<div class="diag"><div class="diag-h">Suggested fix <span class="muted">(AI explanation, ${esc(d.model)}; the verdict above is rule-based)</span></div>
    <p class="diag-text">${esc(d.explanation)}</p>
    ${d.fixSteps?.length ? `<ol>${d.fixSteps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>` : ""}
    ${d.codeSnippet ? `<pre class="codeblock">${esc(d.codeSnippet)}</pre>` : ""}
    <div class="muted">PayPal SDK context: ${d.source === "contextmatic" ? "APIMatic ContextMatic" : "none available"}.
      ${d.sdkVerified?.length ? `Verified against ContextMatic: ${d.sdkVerified.map((m) => `<code>${esc(m)}</code>`).join(", ")}.` : ""}
      ${d.sdkUnverified?.length ? `Not found in the SDK context (check before using): ${d.sdkUnverified.map((m) => `<code>${esc(m)}</code>`).join(", ")}.` : ""}</div></div>`;
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
              ${researchLine(c.research)}
              ${c.diagnosis ? diag(c.diagnosis) : ""}
              <div class="ev">${c.evidence.map((e) => `<div><span class="chip ${esc(e.strength)}">${esc(e.strength)}</span>${esc(e.kind)} <code>${esc(e.id)}</code>${e.note ? ` — ${esc(e.note)}` : ""}</div>`).join("")}</div>
            </div>`,
          )
          .join("")}
      </div></section>`,
    )
    .join("");

  if (Array.isArray(run.timeline) && run.timeline.length) renderTimeline(run.timeline).catch(() => {});
  if (run.status === "judged" && state.mode !== "recorded") renderCertificate(run.id).catch(() => {});

  document.getElementById("log").textContent = (run.log || []).join("\n") || "No log was recorded for this run (runs before the recorded-log feature).";
})();
