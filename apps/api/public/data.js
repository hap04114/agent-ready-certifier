// Data access for the console and report. Live API first; if the API has no database or is
// unreachable (or ?demo=1), fall back to the recorded snapshot of REAL past runs that ships with
// the app (demo mode, no keys needed). The page says which one it is showing.
(() => {
  const params = new URLSearchParams(location.search);
  const forceDemo = params.get("demo") === "1";
  let snapshot;

  async function loadSnapshot() {
    if (!snapshot) {
      const res = await fetch("/assets/demo-snapshot.json");
      if (!res.ok) throw new Error("no recorded snapshot");
      snapshot = await res.json();
    }
    return snapshot;
  }

  async function live(path) {
    const res = await fetch(path, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    return res.json();
  }

  const state = { mode: forceDemo ? "recorded" : "live", exportedAt: null };

  async function get(kind, id) {
    if (state.mode === "live") {
      try {
        if (kind === "runs") return (await live("/api/runs")).runs;
        if (kind === "run") return await live(`/api/runs/${encodeURIComponent(id)}`);
        if (kind === "scorecard") return await live("/api/scorecard");
        if (kind === "trials") return (await live("/api/trials")).trials;
      } catch (err) {
        state.mode = "recorded";
        state.reason = String(err.message || err);
      }
    }
    const snap = await loadSnapshot();
    state.exportedAt = snap.exportedAt;
    if (kind === "runs") return snap.runs;
    if (kind === "run") return snap.runDetails[id];
    if (kind === "scorecard") return snap.scorecard;
    if (kind === "trials") return snap.trials;
  }

  const fmtDate = (v) => (v ? new Date(v).toLocaleString() : "");
  const BADGE = { pass: "pass", fail: "fail", inconclusive: "inconclusive", judged: "pass", stopped: "inconclusive", failed: "fail", running: "neutral" };
  const badge = (status) => `<span class="badge ${BADGE[status] || "neutral"}">${status || "—"}</span>`;
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const PILLARS = {
    works: { title: "Works", q: "Does a real purchase succeed end to end, including declines, refunds and webhooks?" },
    current: { title: "Current", q: "Does the store follow PayPal's growth playbook?" },
    secure: { title: "Secure", q: "Are common payment-integration flaws absent?" },
    "agent-ready": { title: "Agent-ready", q: "Can an AI shopper buy correctly, and can it be tricked?" },
  };
  window.ARC = { get, state, fmtDate, badge, esc, PILLARS };
})();
