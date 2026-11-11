/**
 * Plain-language business impact of a FAILED check. Fixed wording per check, written for a
 * merchant. No dollar figures are invented; the evidence (PayPal IDs, amounts) carries the facts.
 */
export const BUSINESS_IMPACT: Record<string, string> = {
  W1: "Paid orders may not be recorded, so customers who paid might not get their goods.",
  W2: "A declined payment may be treated as paid: unpaid orders could ship.",
  W3: "A PayPal outage may leave orders in the wrong state or charge a customer twice.",
  W4: "Refund missed: the store still shows refunded orders as paid, so stock and accounts drift from PayPal.",
  W5: "Payment notifications are not reaching the store, so order updates depend on luck.",
  W6: "Double fulfilment: one payment can ship twice when PayPal delivers an event again.",
  C1: "Outdated integration: the store misses current PayPal features such as Pay Later, Venmo and saved methods.",
  C2: "Lost conversion: shoppers are not told they can pay over time with Pay Later.",
  C3: "Lost conversion: shoppers must scroll to find the PayPal button.",
  C4: "Returning buyers must re-enter details instead of using their saved PayPal method.",
  C5: "Venmo shoppers are not offered their preferred way to pay.",
  S1: "Underpayment: a shopper can change the price in the browser and pay less than the real price.",
  S2: "Unpaid order shipped: anyone can send a fake 'payment completed' message and the store believes it.",
  S3: "Replay attack: an old, genuine payment message can trigger a second shipment.",
  S4: "Order replay: one payment could be turned into two fulfilments.",
  S5: "Account takeover risk: anyone visiting the site can use the leaked secret to act as the merchant on PayPal.",
  S6: "Staging and live are mixed: test orders could hit live PayPal, or live customers could be sent to the sandbox.",
  S7: "Duplicate orders: a network retry can create two PayPal orders for one checkout.",
  S8: "The checkout page is easier to tamper with (injected scripts, downgraded connections).",
  R1: "AI shoppers cannot complete a purchase on this store.",
  A1: "AI shoppers can be steered by text hidden in product listings into buying the wrong thing.",
  A2: "AI shoppers can approve their own over-limit purchases when the approval code is reachable.",
  A3: "AI shoppers can be tricked into paying a lookalike merchant.",
  A4: "The price the store publishes for machines differs from what PayPal charges: wrong quotes to agents and shopping surfaces, and Google Merchant Center can disapprove products whose prices don't match.",
  A5: "AI agents (and screen-reader users) can't tell what unlabeled checkout controls do, so they get stuck before paying.",
  A6: "The store's own AI support agent can be talked into refunding orders that are not the customer's: direct loss.",
  R2: "The store's AI support agent can't complete genuine refunds, so customers wait and escalate.",
};

export const impactOf = (code: string): string | undefined => BUSINESS_IMPACT[code];
