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

/** Ask ContextMatic one question, adapting to the tool's input schema. */
export async function askContextMatic(session: ContextMaticSession & { schemas?: Record<string, { properties?: Record<string, unknown>; required?: string[] }> }, question: string) {
  const tool = session.tools.find((t) => t === "ask") ?? session.tools.find((t) => /ask|search|query/i.test(t));
  if (!tool) return undefined;
  const schema = session.schemas?.[tool];
  const props = Object.keys(schema?.properties ?? {});
  const args: Record<string, unknown> = {};
  const textProp = props.find((p) => /question|query|prompt|text|message|q$/i.test(p)) ?? props[0] ?? "question";
  args[textProp] = question;
  for (const p of props) {
    if (/language|lang/i.test(p)) args[p] = "typescript";
    else if (/api|sdk|product|plugin/i.test(p) && p !== textProp) args[p] = "paypal";
  }
  const text = await session.call(tool, args);
  return { tool, text };
}

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
  const lower = reference.toLowerCase();
  const inRef = (m: string) => {
    const name = m.split(/[.#(]/).filter(Boolean).pop() ?? m;
    return lower.includes(name.toLowerCase());
  };
  return {
    ...out,
    code: input.code,
    verifiedSdkMethods: input.context ? out.sdkMethods.filter(inRef) : [],
    unverifiedSdkMethods: input.context ? out.sdkMethods.filter((m) => !inRef(m)) : out.sdkMethods,
    source: input.context ? "contextmatic" : "none",
    contextTool: input.context?.tool,
  };
}
