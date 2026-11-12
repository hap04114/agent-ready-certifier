// Landing page motion and interaction: scroll reveals and progress, count-ups, the certificate
// "run" loop, a cursor glow, 3D tilt on the certificate, magnetic buttons, hero parallax and the
// interactive "flip the approval design" demo. Loaded in <head> so the "js" class is set before
// first paint. All content is visible without this script; with reduced motion there is no motion.
(() => {
  const root = document.documentElement;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const finePointer = window.matchMedia("(pointer: fine)").matches;
  const canObserve = "IntersectionObserver" in window;
  if (!reduce && canObserve) root.classList.add("js");

  const ready = (fn) => (document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", fn) : fn());
  ready(() => {
    const $ = (id) => document.getElementById(id);
    const nav = $("nav");
    const bar = $("scrollbar");
    const hero = document.querySelector(".hero .in");
    const visual = document.querySelector(".visual");

    // Scroll: nav background, progress bar, gentle hero parallax.
    let ticking = false;
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        const y = window.scrollY;
        nav?.classList.toggle("scrolled", y > 8);
        const max = document.documentElement.scrollHeight - window.innerHeight;
        if (bar) bar.style.transform = `scaleX(${max > 0 ? y / max : 0})`;
        if (!reduce && visual && y < 900) {
          visual.style.translate = `0 ${y * 0.12}px`;
          if (hero?.firstElementChild) hero.firstElementChild.style.translate = `0 ${y * 0.05}px`;
        }
        ticking = false;
      });
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });

    // The interactive approval-design demo (works with or without motion).
    const flip = $("flip");
    const TEXT = {
      code: ["finds the approval code", "accepted: limit $20 → $200", "PayPal captures it", "Bypass · FAIL", "real capture 9V410190V1343380H"],
      passkey: ["the old code is still there", "refused: only the owner's passkey works", "declined: over the $20 limit", "Safe · PASS", "0 bypasses in 36 passkey trials"],
    };
    let flipTimers = [];
    const playFlip = (mode) => {
      if (!flip) return;
      for (const t of flipTimers) clearTimeout(t);
      flipTimers = [];
      flip.classList.remove("code", "passkey");
      flip.classList.add(mode);
      for (const b of flip.querySelectorAll(".seg button")) b.setAttribute("aria-pressed", String(b.dataset.mode === mode));
      for (const el of flip.querySelectorAll("[data-t]")) el.textContent = TEXT[mode][Number(el.dataset.t)];
      const steps = [...flip.querySelectorAll(".flow-mini li")];
      for (const s of steps) s.classList.remove("on");
      steps.forEach((s, i) => {
        if (reduce) s.classList.add("on");
        else flipTimers.push(setTimeout(() => s.classList.add("on"), 250 + i * 650));
      });
    };
    if (flip) {
      let mode = "code";
      for (const b of flip.querySelectorAll(".seg button")) {
        b.addEventListener("click", () => {
          mode = b.dataset.mode;
          playFlip(mode);
        });
      }
      $("flip-play")?.addEventListener("click", () => playFlip(mode));
      playFlip(mode);
    }

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

    // Sections fade and rise in; the flip demo replays when it scrolls into view.
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          e.target.classList.add("in");
          for (const c of e.target.querySelectorAll("[data-count]")) countUp(c);
          if (flip && e.target.contains(flip)) playFlip(flip.classList.contains("passkey") ? "passkey" : "code");
          io.unobserve(e.target);
        }
      },
      { threshold: 0.16 },
    );
    for (const el of document.querySelectorAll(".reveal")) io.observe(el);

    // The hero certificate "runs": rows fill in, ticks pop, the seal stamps; then it replays.
    const cert = $("cert");
    if (cert) {
      const run = () => {
        cert.classList.remove("run");
        void cert.offsetWidth;
        cert.classList.add("run");
      };
      run();
      setInterval(run, 7500);
    }

    if (!finePointer) return;

    // A soft glow follows the cursor.
    const glow = $("glow");
    let gx = window.innerWidth / 2;
    let gy = window.innerHeight / 3;
    let tx = gx;
    let ty = gy;
    const follow = () => {
      gx += (tx - gx) * 0.12;
      gy += (ty - gy) * 0.12;
      if (glow) glow.style.transform = `translate(${gx}px, ${gy}px)`;
      requestAnimationFrame(follow);
    };
    window.addEventListener("pointermove", (ev) => {
      tx = ev.clientX;
      ty = ev.clientY;
      glow?.classList.add("on");
    });
    document.addEventListener("pointerleave", () => glow?.classList.remove("on"));
    requestAnimationFrame(follow);

    // The certificate tilts towards the pointer, with a soft glare.
    const tilt = $("tilt");
    if (tilt && visual) {
      visual.addEventListener("pointermove", (ev) => {
        const r = tilt.getBoundingClientRect();
        const px = (ev.clientX - r.left) / r.width - 0.5;
        const py = (ev.clientY - r.top) / r.height - 0.5;
        tilt.style.setProperty("--ry", `${(px * 14).toFixed(2)}deg`);
        tilt.style.setProperty("--rx", `${(-py * 12).toFixed(2)}deg`);
        tilt.style.setProperty("--gx", `${((px + 0.5) * 100).toFixed(1)}%`);
        tilt.style.setProperty("--gy", `${((py + 0.5) * 100).toFixed(1)}%`);
        tilt.classList.add("hover");
      });
      visual.addEventListener("pointerleave", () => {
        tilt.style.setProperty("--rx", "0deg");
        tilt.style.setProperty("--ry", "0deg");
        tilt.classList.remove("hover");
      });
    }

    // Primary buttons lean towards the pointer.
    for (const btn of document.querySelectorAll(".btn.primary:not(.sm)")) {
      btn.addEventListener("pointermove", (ev) => {
        const r = btn.getBoundingClientRect();
        btn.style.transform = `translate(${((ev.clientX - r.left) / r.width - 0.5) * 10}px, ${((ev.clientY - r.top) / r.height - 0.5) * 8 - 2}px)`;
      });
      btn.addEventListener("pointerleave", () => {
        btn.style.transform = "";
      });
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
