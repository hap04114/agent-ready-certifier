// Browser side of demo-store-good. Sends only SKU and quantity; the server sets the price.
(() => {
  var sku = document.getElementById("sku");
  var qty = document.getElementById("qty");
  var total = document.getElementById("total");
  var paylater = document.getElementById("paylater");
  var result = document.getElementById("result");

  function currentTotal() {
    var price = Number(sku.options[sku.selectedIndex].dataset.price);
    var q = Math.max(1, Math.min(10, parseInt(qty.value, 10) || 1));
    return (Math.round(price * 100) * q / 100).toFixed(2);
  }
  function refresh() {
    var t = currentTotal();
    total.textContent = t;
    paylater.setAttribute("data-pp-amount", t);
  }
  function show(kind, text) {
    result.className = kind;
    result.textContent = text;
  }
  sku.addEventListener("change", refresh);
  qty.addEventListener("input", refresh);

  if (!window.paypal) {
    show("err", "PayPal SDK did not load.");
    return;
  }

  window.paypal
    .Buttons({
      createOrder: () => fetch("/api/orders", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            Object.assign(
              { sku: sku.value, quantity: parseInt(qty.value, 10) || 1 },
              window.STORE_CONFIG?.sendPrice ? { price: sku.options[sku.selectedIndex].dataset.price } : {},
            ),
          ),
        })
          .then((r) => r.json().then((d) => { if (!r.ok) throw new Error(d.error || "create failed"); return d.id; })),
      onApprove: (data) => fetch(`/api/orders/${encodeURIComponent(data.orderID)}/capture`, { method: "POST" })
          .then((r) => r.json().then((d) => ({ ok: r.ok, d: d })))
          .then((res) => {
            if (res.ok) show("ok", `Paid. PayPal order ${res.d.id}, capture ${res.d.captureId}.`);
            else show("err", `Payment not completed: ${res.d.error || "unknown error"}`);
          }),
      onError: () => {
        show("err", "PayPal reported an error. Nothing was charged.");
      },
    })
    .render("#paypal-buttons");
})();
