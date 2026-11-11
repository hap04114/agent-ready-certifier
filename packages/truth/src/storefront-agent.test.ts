import { describe, expect, it } from "vitest";
import { type ControlFacts, accessibleName, judgeA4, judgeA5 } from "./storefront-agent.js";

const url = "https://store.example/";
const usd = (value: string) => ({ currencyCode: "USD", value });

describe("A4 agent-visible price", () => {
  const charged = [
    { orderId: "ORDER-A", sku: "MUG-01", name: "Mug", unit: usd("24.00") },
    { orderId: "ORDER-B", sku: "NOTE-01", name: "Notebook", unit: usd("12.50") },
  ];

  it("passes when the structured price equals what PayPal charged", () => {
    const r = judgeA4({ url, fetched: true, offers: [{ sku: "MUG-01", price: "24.00", currency: "USD" }, { sku: "note-01", price: "12.5", currency: "usd" }], charged });
    expect(r.status).toBe("pass");
    expect(r.evidence.filter((e) => e.strength === "paypal-api")).toHaveLength(2);
  });

  it("fails when agents read a different price than PayPal charges", () => {
    const r = judgeA4({ url, fetched: true, offers: [{ sku: "MUG-01", price: "21.60", currency: "USD" }], charged });
    expect(r.status).toBe("fail");
    expect(r.reasons[0]).toBe("MUG-01: structured data says 21.60 USD, PayPal order ORDER-A charged 24.00 USD.");
  });

  it("reports (inconclusive, not fail) a store that publishes no machine-readable price", () => {
    // Whether AI agents rely on JSON-LD is disputed, so absence is not proof of a defect.
    expect(judgeA4({ url, fetched: true, offers: [{ sku: "MUG-01" }], charged }).status).toBe("inconclusive");
    expect(judgeA4({ url, fetched: true, offers: [], charged }).status).toBe("inconclusive");
  });

  it("matches by exact name when there is no SKU, and treats a currency mismatch as a mismatch", () => {
    const r = judgeA4({ url, fetched: true, offers: [{ name: "mug", price: "24.00", currency: "EUR" }], charged });
    expect(r.status).toBe("fail");
  });

  it("is inconclusive, never a pass, when nothing can be compared", () => {
    expect(judgeA4({ url, fetched: false, offers: [], charged }).status).toBe("inconclusive");
    expect(judgeA4({ url, fetched: true, offers: [{ sku: "X", price: "1.00", currency: "USD" }], charged }).status).toBe("inconclusive");
    expect(judgeA4({ url, fetched: true, offers: [{ sku: "MUG-01", price: "24.00", currency: "USD" }], charged: [{ orderId: "O", sku: "MUG-01" }] }).status).toBe("inconclusive");
  });
});

describe("A5 agent-operable checkout", () => {
  const named: ControlFacts = { tag: "select", labelText: "Product", hint: "select#sku" };

  it("computes names in accessible-name order", () => {
    expect(accessibleName({ tag: "button", ariaLabel: "  Add to  cart ", text: "+", hint: "b" })).toBe("Add to cart");
    expect(accessibleName({ tag: "button", innerImgName: "Cart", hint: "b" })).toBe("Cart");
    expect(accessibleName({ tag: "input", placeholder: "Email", hint: "i" })).toBe("Email");
    expect(accessibleName({ tag: "input", type: "number", hint: "input#qty" })).toBe("");
  });

  it("passes when every control has a name", () => {
    expect(judgeA5({ url, controls: [named, { tag: "input", labelText: "Quantity", hint: "input#qty" }] }).status).toBe("pass");
  });

  it("fails and names each unlabeled control", () => {
    const r = judgeA5({ url, controls: [named, { tag: "input", type: "number", hint: "input#qty" }, { tag: "button", text: " ", hint: "button.cart" }] });
    expect(r.status).toBe("fail");
    expect(r.reasons).toEqual(["input#qty: no label, aria-label or visible text.", "button.cart: no label, aria-label or visible text."]);
  });

  it("is inconclusive without a browser measurement or controls", () => {
    expect(judgeA5({ url }).status).toBe("inconclusive");
    expect(judgeA5({ url, controls: [] }).status).toBe("inconclusive");
  });
});
