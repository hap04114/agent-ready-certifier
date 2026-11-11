/**
 * The diagnosis agent: explains a FAILED check and proposes a fix grounded in current PayPal
 * Server SDK context from APIMatic ContextMatic. It never decides a verdict, never sees page
 * text or webhook payloads (only the check code, our own reason strings and IDs), and returns
 * schema-validated JSON. SDK methods it names are cross-checked against the ContextMatic text.
 */
import { z } from "zod";
import { type LlmConfig, askJson } from "@certifier/llm";
import type { ContextMaticSession } from "./contextmatic.js";

/** What to ask ContextMatic for each check (PayPal Server SDK, TypeScript). */
export const FIX_TOPICS: Record<string, string> = {
  W1: "How do I capture an approved order with the PayPal Server SDK for TypeScript (OrdersController captureOrder) and confirm the capture status before marking an order paid?",
  W2: "How do I handle an INSTRUMENT_DECLINED error from OrdersController captureOrder in the PayPal Server SDK for TypeScript?",
  W3: "How do I retry OrdersController captureOrder safely after a server error using the same paypalRequestId in the PayPal Server SDK for TypeScript?",
  W4: "In the PayPal Server SDK for TypeScript, how do I look up a captured payment and its refunds (PaymentsController getCapturedPayment, getRefund) to record a PAYMENT.CAPTURE.REFUNDED webhook?",
  W5: "How should a server receive and verify PayPal webhooks and acknowledge them with a 2xx response?",
  W6: "How do I make PayPal webhook handling idempotent by event ID?",
  S1: "With the PayPal Server SDK for TypeScript OrdersController createOrder, how do I build purchaseUnits amounts and items from server-side prices?",
  S2: "How do I verify a PayPal webhook signature (verify-webhook-signature) before trusting a payment event?",
  S3: "How do I prevent replayed PayPal webhook events from being processed twice?",
  S4: "How do I prevent capturing the same PayPal order twice with OrdersController captureOrder?",
  S5: "With the PayPal Server SDK for TypeScript, how do I configure clientCredentialsAuthCredentials on the server so the client secret never reaches the browser?",
  S6: "How do I configure the PayPal Server SDK for TypeScript Client with Environment.Sandbox for staging?",
  S7: "How do I pass paypalRequestId to OrdersController createOrder in the PayPal Server SDK for TypeScript so retries do not create duplicate orders?",
  S8: "Which Content-Security-Policy directives does the PayPal JavaScript SDK need, and how should a checkout page set Strict-Transport-Security?",
  C1: "How do I migrate a PayPal checkout from checkout.js to the current PayPal JavaScript SDK?",
  C2: "How do I add PayPal Pay Later messaging with the JavaScript SDK messages component?",
  C3: "Where should the PayPal button be placed on a checkout page for best conversion?",
};

export const finding = z.object({
  explanation: z.string().max(900),
  fixSteps: z.array(z.string().max(300)).max(6),
  codeSnippet: z.string().max(2000),
  sdkMethods: z.array(z.string().max(80)).max(8),
});
export type Finding = z.infer<typeof finding>;

export interface Diagnosis extends Finding {
  code: string;
  /** SDK method names that appear verbatim in the ContextMatic reference. */
  verifiedSdkMethods: string[];
  unverifiedSdkMethods: string[];
  /** Where the SDK context came from. */
  source: "contextmatic" | "none";
  /** The ContextMatic tool used, for the audit trail. */
  contextTool?: string;
}

/** Strip anything that is not plain reason text (reasons can quote store-reported strings). */
export const sanitize = (s: string) => s.replace(/[^\w\s.,:;$%()/'"@#+=-]/g, "").slice(0, 300);

/** ContextMatic addresses an SDK by language + API key (the key `fetch_api` lists for PayPal). */
export const CONTEXTMATIC_SDK = { language: "typescript", key: "paypal" } as const;

/** Ask ContextMatic's `ask` tool one question about the PayPal Server SDK for TypeScript. */
export async function askContextMatic(session: ContextMaticSession, question: string) {
  if (!session.tools.includes("ask")) return undefined;
  const text = await session.call("ask", { ...CONTEXTMATIC_SDK, query: question });
  return { tool: "ask", text };
}

/**
 * Look each SDK method up in ContextMatic's endpoint index (`endpoint_search`), independently of
 * the prose answer. The search is fuzzy (an unknown name still returns the closest endpoints), so
 * a method counts only when an endpoint heading names it exactly (`## CreateOrder` for
 * `createOrder`) or a code sample calls it (`.createOrder(`).
 */
export async function lookUpSdkMethods(session: ContextMaticSession, methods: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  if (!session.tools.includes("endpoint_search")) return found;
  for (const m of methods) {
    const name = methodName(m);
    if (!/^[A-Za-z_]\w{1,60}$/.test(name)) continue;
    const text = await session.call("endpoint_search", { ...CONTEXTMATIC_SDK, query: name }).catch(() => "");
    if (endpointNamed(text, name)) found.add(m);
  }
  return found;
}

/** True when an endpoint_search result names `name` exactly (heading or call), not just a near match. */
export const endpointNamed = (text: string, name: string) =>
  new RegExp(`^##\\s+${name}\\s*$`, "im").test(text) || new RegExp(`\\.${name}\\(`).test(text);

/** `OrdersController.createOrder(...)` → `createOrder`. */
export const methodName = (m: string) => m.split(/[.#(]/).filter(Boolean).pop()?.trim() ?? m;

const SYSTEM = `You are a senior PayPal integration engineer writing a short finding for a merchant's developer.
A deterministic certifier already decided that a check FAILED; you do not judge, you explain and propose a fix.
Use ONLY PayPal SDK classes and methods that appear in <reference>. If the reference does not cover something, say so plainly.
Reply with ONE JSON object: {"explanation": "...", "fixSteps": ["..."], "codeSnippet": "...", "sdkMethods": ["ClassName.methodName", ...]}.`;

export async function diagnose(input: {
  llm: LlmConfig;
  code: string;
  summary: string;
  reasons: string[];
  businessImpact?: string;
  context?: { tool: string; text: string };
  /** Independent lookup of SDK method names (ContextMatic endpoint_search). */
  lookUp?: (methods: string[]) => Promise<Set<string>>;
  ask?: typeof askJson;
}): Promise<Diagnosis> {
  const reference = input.context?.text ?? "No PayPal SDK reference was available for this finding.";
  const user = [
    `Check ${input.code} failed: ${sanitize(input.summary)}`,
    input.reasons.length ? `Reasons (from the certifier):\n${input.reasons.map((r) => `- ${sanitize(r)}`).join("\n")}` : "",
    input.businessImpact ? `Business impact: ${input.businessImpact}` : "",
    `<reference source="${input.context ? "APIMatic ContextMatic" : "none"}">\n${reference}\n</reference>`,
    "Write the finding as JSON.",
  ]
    .filter(Boolean)
    .join("\n\n");
  const out = await (input.ask ?? askJson)(input.llm, [
    { role: "system", content: SYSTEM },
    { role: "user", content: user },
  ], finding);
  // A method is verified when ContextMatic's answer names it exactly or its endpoint index has it.
  const inRef = (m: string) => {
    const name = methodName(m);
    return /^\w+$/.test(name) && new RegExp(`\\b${name}\\b`).test(reference);
  };
  const indexed = input.context && input.lookUp ? await input.lookUp(out.sdkMethods.filter((m) => !inRef(m))).catch(() => new Set<string>()) : new Set<string>();
  const ok = (m: string) => inRef(m) || indexed.has(m);
  return {
    ...out,
    code: input.code,
    verifiedSdkMethods: input.context ? out.sdkMethods.filter(ok) : [],
    unverifiedSdkMethods: input.context ? out.sdkMethods.filter((m) => !ok(m)) : out.sdkMethods,
    source: input.context ? "contextmatic" : "none",
    contextTool: input.context?.tool,
  };
}
