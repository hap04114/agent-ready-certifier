// Owner approvals page. All text from the API is set with textContent (the agent's reason is
// untrusted). The invite token stays in this page's memory and is never stored.
(() => {
  const W = window.SimpleWebAuthnBrowser;
  const params = new URLSearchParams(location.search);
  const invite = params.get("invite");
  const focusId = params.get("id");
  // Drop the one-time invite from the address bar so it does not linger in history.
  if (invite) history.replaceState(null, "", focusId ? `/owner?id=${encodeURIComponent(focusId)}` : "/owner");

  const $ = (id) => document.getElementById(id);
  const el = (tag, props = {}, ...kids) => {
    const n = Object.assign(document.createElement(tag), props);
    for (const k of kids) n.append(k);
    return n;
  };
  const when = (s) => (s ? new Date(s).toLocaleString() : "—");
  const banner = (msg) => {
    $("banner").hidden = !msg;
    $("banner").textContent = msg || "";
  };
  const api = async (path, body) => {
    const r = await fetch(path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const json = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(json.error || `HTTP ${r.status}`);
    return json;
  };
  const supported = () => W?.browserSupportsWebAuthn();
  const BADGE = { pending: "inconclusive", approved: "pass", denied: "fail", expired: "neutral" };

  async function register() {
    const status = $("register-status");
    if (!supported()) {
      status.textContent = "This browser does not support passkeys.";
      return;
    }
    try {
      status.textContent = "Follow your device's prompt…";
      const options = await api("/api/passkeys/register/options", { invite });
      const response = await W.startRegistration({ optionsJSON: options });
      await api("/api/passkeys/register/verify", { invite, response, label: "Store owner's passkey" });
      status.textContent = "Passkey registered. You can now approve requests on this page.";
      $("register").disabled = true;
      loadPasskeys();
    } catch (e) {
      status.textContent = `Registration did not complete: ${e.message}`;
    }
  }

  async function decide(id, approve) {
    const out = $(`status-${id}`) || $("banner");
    try {
      if (!approve) {
        await api(`/api/approvals/${id}/deny`, {});
      } else {
        if (!supported()) throw new Error("this browser does not support passkeys");
        out.textContent = "Follow your device's prompt…";
        const { options } = await api(`/api/approvals/${id}/options`, {});
        const response = await W.startAuthentication({ optionsJSON: options });
        await api(`/api/approvals/${id}/approve`, { response });
      }
      out.textContent = approve ? "Approved with your passkey. The certifier verified the signature." : "Denied.";
      load();
    } catch (e) {
      out.textContent = `Not approved: ${e.message}`;
    }
  }

  function requestView(a) {
    const box = el("div", { className: "detail" });
    box.append(
      el("h3", {}, `${a.model} · ${a.scenario} trial ${a.trialNo} `, el("span", { className: `badge ${BADGE[a.status] || "neutral"}`, textContent: a.status })),
      el("p", {}, "Raise the spending limit from ", el("b", { textContent: `$${a.currentLimit}` }), " to ", el("b", { textContent: `$${a.requestedLimit} ${a.currency}` }), " for this one trial."),
      el("p", { className: "muted" }, "The agent's reason (written by the AI, untrusted): ", el("q", { textContent: a.agentReason || "(none given)" })),
      el("p", { className: "muted", textContent: `Requested ${when(a.createdAt)} · expires ${when(a.expiresAt)}${a.decidedAt ? ` · decided ${when(a.decidedAt)}` : ""}${a.approvedWith ? ` · signed with: ${a.approvedWith}` : ""}` }),
    );
    if (a.status === "pending") {
      const approve = el("button", { className: "btn primary", type: "button", textContent: "Approve with passkey" });
      const deny = el("button", { className: "btn", type: "button", textContent: "Deny" });
      approve.onclick = () => decide(a.id, true);
      deny.onclick = () => decide(a.id, false);
      box.append(el("div", { className: "actions" }, approve, deny));
    }
    if (a.status === "approved") {
      box.append(el("p", {}, el("a", { href: `/api/approvals/${a.id}`, textContent: "Signature proof (re-checked on every request)" })));
    }
    box.append(el("p", { className: "muted", id: `status-${a.id}`, ariaLive: "polite" }));
    return box;
  }

  async function load() {
    try {
      const { approvals } = await api("/api/approvals");
      const focus = focusId && approvals.find((a) => a.id === focusId);
      $("request-card").hidden = !focus;
      if (focus) $("request").replaceChildren(requestView(focus));
      const others = approvals.filter((a) => a !== focus);
      $("list").replaceChildren(...(others.length ? others.map(requestView) : [el("p", { className: "muted", textContent: "No other requests." })]));
    } catch (e) {
      $("list").textContent = `Could not load requests: ${e.message}`;
    }
  }

  async function loadPasskeys() {
    try {
      const { passkeys, relyingParty } = await api("/api/passkeys");
      $("passkeys").replaceChildren(
        passkeys.length
          ? el("ul", {}, ...passkeys.map((p) => el("li", { textContent: `${p.label} — registered ${when(p.createdAt)}, last used ${when(p.lastUsedAt)}` })))
          : el("p", { className: "muted", textContent: "None yet. Run pnpm passkey:invite to get a one-time registration link." }),
        el("p", { className: "muted", textContent: `Passkeys are bound to ${relyingParty}; a lookalike site cannot use them.` }),
      );
    } catch (e) {
      $("passkeys").textContent = `Could not load passkeys: ${e.message}`;
    }
  }

  if (invite) {
    $("register-card").hidden = false;
    $("register").onclick = register;
  }
  if (!W) banner("The passkey helper script did not load, so approving is unavailable on this page.");
  load();
  loadPasskeys();
  // Keep pending requests fresh while a trial waits for the owner.
  setInterval(load, 10_000);
})();
