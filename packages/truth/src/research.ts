/**
 * The research or official guidance behind each check, shown next to the check in reports.
 * Every entry was checked against its source on Nov 10-11, 2026. Types are labelled honestly:
 * peer-reviewed research, preprint, official documentation, industry report, or news.
 */
export type SourceType = "peer-reviewed" | "preprint" | "official docs" | "industry report" | "news" | "standard";

export interface ResearchNote {
  /** One line, worded as the source states it. */
  finding: string;
  source: string;
  type: SourceType;
  url: string;
}

const PAYPAL_NEGATIVE = "https://developer.paypal.com/tools/sandbox/negative-testing/request-headers/";
const PAYPAL_WEBHOOKS = "https://developer.paypal.com/api/rest/webhooks/rest";
const HOOKDECK = "https://hookdeck.com/webhooks/platforms/guide-to-paypal-webhooks-features-and-best-practices";
const PAYPAL_Q3 = "https://www.investing.com/news/company-news/paypal-q3-2026-slides-profit-beats-revenue-misses-expectations-93CH-4975781";
const OWASP_API = "https://owasp.org/API-Security/";
const WASP = "https://arxiv.org/abs/2504.18575";
const MAGENTIC = "https://arxiv.org/abs/2510.25779";

export const RESEARCH: Record<string, ResearchNote> = {
  W2: { finding: "PayPal's sandbox can force errors such as INSTRUMENT_DECLINED with the PayPal-Mock-Response header.", source: "PayPal Developer: negative testing", type: "official docs", url: PAYPAL_NEGATIVE },
  W3: { finding: "PayPal's sandbox can force INTERNAL_SERVER_ERROR responses with the PayPal-Mock-Response header.", source: "PayPal Developer: negative testing", type: "official docs", url: PAYPAL_NEGATIVE },
  W4: { finding: "Developers report PayPal webhooks not firing, capture events never generated and events stuck as pending.", source: "Hookdeck guide to PayPal webhooks", type: "industry report", url: HOOKDECK },
  W5: { finding: "PayPal webhook messages must be verified against PayPal's signature before they are trusted.", source: "PayPal Developer: webhook integration and verification", type: "official docs", url: PAYPAL_WEBHOOKS },
  C2: { finding: "Earlier Pay Later messaging is part of the playbook that grew branded checkout where deployed.", source: "PayPal Q3 2026 results, as summarized by Investing.com", type: "news", url: PAYPAL_Q3 },
  C4: { finding: "Saved payment methods are part of the playbook that grew branded checkout where deployed.", source: "PayPal Q3 2026 results, as summarized by Investing.com", type: "news", url: PAYPAL_Q3 },
  S1: { finding: "Unrestricted access to sensitive business flows (business-logic abuse) is an OWASP API Top 10 risk.", source: "OWASP API Security Top 10 (2023)", type: "standard", url: OWASP_API },
  S2: { finding: "PayPal documents how to verify each webhook message's signature before trusting it.", source: "PayPal Developer: webhook integration and verification", type: "official docs", url: PAYPAL_WEBHOOKS },
  S4: { finding: "Unrestricted access to sensitive business flows (business-logic abuse) is an OWASP API Top 10 risk.", source: "OWASP API Security Top 10 (2023)", type: "standard", url: OWASP_API },
  S5: { finding: "Security misconfiguration, including exposed credentials, is an OWASP API Top 10 risk.", source: "OWASP API Security Top 10 (2023)", type: "standard", url: OWASP_API },
  S6: { finding: "Security misconfiguration (mixed environments) is an OWASP API Top 10 risk.", source: "OWASP API Security Top 10 (2023)", type: "standard", url: OWASP_API },
  S7: { finding: "Without the PayPal-Request-Id header, PayPal processes a retried POST again as a new request.", source: "PayPal Developer: idempotency", type: "official docs", url: "https://developer.paypal.com/api/rest/reference/idempotency" },
  S8: { finding: "Security misconfiguration (missing security headers) is an OWASP API Top 10 risk.", source: "OWASP API Security Top 10 (2023)", type: "standard", url: OWASP_API },
  R1: { finding: "Some agents look safe only because they fail the task, so task success must be reported next to safety.", source: "WASP, Meta FAIR (arXiv 2504.18575)", type: "preprint", url: WASP },
  A1: { finding: "Low-effort prompt injections can hijack web agents.", source: "WASP, Meta FAIR (arXiv 2504.18575)", type: "preprint", url: WASP },
  A2: {
    finding: "9 of 10 AI models raised their own spending limit at least once by reading the owner's emailed approval codes.",
    source: "I-HITL study, Cornell Tech and Yale (2026), as reported by CoinDesk",
    type: "news",
    url: "https://www.coindesk.com/tech/2026/11/01/ai-agents-bypassed-crypto-spending-limits-without-human-approval-researchers-find-in-a-new-test",
  },
  A3: { finding: "In a simulated marketplace, prompt injection redirected all payments for some models.", source: "Magentic Marketplace, Microsoft Research (arXiv 2510.25779)", type: "preprint", url: MAGENTIC },
  A4: {
    finding: "Google uses structured data to understand landing-page prices; prices must match exactly, and mismatches can get products disapproved.",
    source: "Google Merchant Center Help: price",
    type: "official docs",
    url: "https://support.google.com/merchants/answer/12159029",
  },
  A5: {
    finding: "ChatGPT Atlas uses ARIA tags, the same labels and roles that support screen readers, to interpret page structure and interactive elements.",
    source: "OpenAI Publishers and Developers FAQ",
    type: "official docs",
    url: "https://help.openai.com/en/articles/12627856-publishers-and-developers-faq",
  },
};

RESEARCH.A6 = {
  finding: "Prompt injection and excessive agency (an LLM taking harmful actions through its tools) are top risks for LLM applications.",
  source: "OWASP Top 10 for LLM Applications",
  type: "standard",
  url: "https://genai.owasp.org/",
};

export const researchOf = (code: string): ResearchNote | undefined => RESEARCH[code];
