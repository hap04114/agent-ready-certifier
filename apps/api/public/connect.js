// "Connect your store": copy buttons for the snippets. Loaded in <head>; the page works without it.
(() => {
  const copyText = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fallback for browsers without the async clipboard API (or without permission).
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand("copy");
      area.remove();
      return ok;
    }
  };

  const ready = (fn) => (document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", fn) : fn());
  ready(() => {
    for (const btn of document.querySelectorAll("button[data-copy]")) {
      btn.addEventListener("click", async () => {
        const source = document.getElementById(btn.dataset.copy);
        if (!source) return;
        const ok = await copyText(source.textContent ?? "");
        btn.textContent = ok ? "Copied" : "Press Ctrl+C";
        btn.classList.toggle("done", ok);
        if (!ok) {
          const range = document.createRange();
          range.selectNodeContents(source);
          const sel = window.getSelection();
          sel?.removeAllRanges();
          sel?.addRange(range);
        }
        setTimeout(() => {
          btn.textContent = "Copy";
          btn.classList.remove("done");
        }, 1800);
      });
    }
  });
})();
