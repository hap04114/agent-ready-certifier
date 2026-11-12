// Light / dark theme for the landing, simulator and How-it-works pages.
// Loaded in <head> so the theme is set before first paint. Follows the system setting until the
// visitor picks one; the choice is remembered on this device only. Switching plays a circular
// reveal from the button where the browser supports view transitions (none with reduced motion).
(() => {
  const root = document.documentElement;
  const KEY = "arc-theme";
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let chosen = null;
  try {
    const v = localStorage.getItem(KEY);
    if (v === "dark" || v === "light") chosen = v;
  } catch {
    // Storage can be blocked (private mode); the theme then simply follows the system.
  }
  const label = (t) => {
    for (const b of document.querySelectorAll("[data-theme-toggle]")) {
      b.setAttribute("aria-label", t === "dark" ? "Switch to light mode" : "Switch to dark mode");
      b.setAttribute("aria-pressed", String(t === "dark"));
    }
  };
  const apply = (t) => {
    root.dataset.theme = t;
    root.style.colorScheme = t;
    label(t);
  };
  apply(chosen ?? (media.matches ? "dark" : "light"));
  media.addEventListener?.("change", (e) => {
    if (!chosen) apply(e.matches ? "dark" : "light");
  });

  const ready = (fn) => (document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", fn) : fn());
  ready(() => {
    label(root.dataset.theme);
    for (const btn of document.querySelectorAll("[data-theme-toggle]")) {
      btn.addEventListener("click", () => {
        const next = root.dataset.theme === "dark" ? "light" : "dark";
        chosen = next;
        try {
          localStorage.setItem(KEY, next);
        } catch {
          // Not remembered, but the switch still works for this page view.
        }
        if (!document.startViewTransition || reduce) {
          apply(next);
          return;
        }
        const r = btn.getBoundingClientRect();
        const x = r.left + r.width / 2;
        const y = r.top + r.height / 2;
        const end = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
        const t = document.startViewTransition(() => apply(next));
        t.ready
          .then(() =>
            root.animate(
              { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${end}px at ${x}px ${y}px)`] },
              { duration: 600, easing: "cubic-bezier(.2,.7,.2,1)", pseudoElement: "::view-transition-new(root)" },
            ),
          )
          .catch(() => {});
      });
    }
  });
})();
