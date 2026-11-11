// "How it works" page: reading progress bar and scroll-spy for the contents sidebar.
// Loaded in <head>; the page is complete without it. No content animations: this is documentation.
(() => {
  const ready = (fn) => (document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", fn) : fn());
  ready(() => {
    const bar = document.getElementById("progress");
    const onScroll = () => {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      if (bar) bar.style.width = `${max > 0 ? (window.scrollY / max) * 100 : 0}%`;
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    if (!("IntersectionObserver" in window)) return;

    // Highlight the section being read in the contents sidebar.
    const links = new Map([...document.querySelectorAll(".toc a[data-id]")].map((a) => [a.dataset.id, a]));
    const spy = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          for (const a of links.values()) a.classList.remove("on");
          const a = links.get(e.target.id);
          if (a) {
            a.classList.add("on");
            a.scrollIntoView({ block: "nearest" });
          }
        }
      },
      { rootMargin: "-20% 0px -70% 0px" },
    );
    for (const s of document.querySelectorAll("main [id]")) if (links.has(s.id)) spy.observe(s);
  });
})();
