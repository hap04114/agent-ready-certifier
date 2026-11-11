// Landing page motion: scroll reveals, count-ups, the certificate "run" loop and the card spotlight.
// Loaded in <head> so the "js" class is set before first paint. All content is visible without
// this script; it only adds motion, and none at all for visitors who prefer reduced motion.
(() => {
  const root = document.documentElement;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const canObserve = "IntersectionObserver" in window;
  if (!reduce && canObserve) root.classList.add("js");

  const ready = (fn) => (document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", fn) : fn());
  ready(() => {
    const nav = document.getElementById("nav");
    const onScroll = () => nav?.classList.toggle("scrolled", window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    if (reduce || !canObserve) return;

    // Numbers count up the first time they scroll into view.
    const countUp = (el) => {
      const target = Number(el.dataset.count);
      if (!Number.isFinite(target)) return;
      const start = performance.now();
      const step = (now) => {
        const p = Math.min(1, (now - start) / 1300);
        el.textContent = String(Math.round(target * (1 - (1 - p) ** 3)));
        if (p < 1) requestAnimationFrame(step);
      };
      el.textContent = "0";
      requestAnimationFrame(step);
    };

    // Sections fade and rise in as they enter the viewport.
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          e.target.classList.add("in");
          for (const c of e.target.querySelectorAll("[data-count]")) countUp(c);
          io.unobserve(e.target);
        }
      },
      { threshold: 0.16 },
    );
    for (const el of document.querySelectorAll(".reveal")) io.observe(el);

    // The hero certificate "runs": rows fill in, ticks pop, the seal stamps; then it replays.
    const cert = document.getElementById("cert");
    if (cert) {
      const run = () => {
        cert.classList.remove("run");
        void cert.offsetWidth;
        cert.classList.add("run");
      };
      run();
      setInterval(run, 7500);
    }

    // A soft light follows the pointer across the cards.
    for (const card of document.querySelectorAll(".card")) {
      card.addEventListener("pointermove", (ev) => {
        const r = card.getBoundingClientRect();
        card.style.setProperty("--mx", `${ev.clientX - r.left}px`);
        card.style.setProperty("--my", `${ev.clientY - r.top}px`);
      });
    }
  });
})();
