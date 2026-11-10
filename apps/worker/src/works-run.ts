/**
 * `pnpm works:run` — run the Works pillar (W1–W6) against demo-store-good.
 *
 * The AI browser agent approves the three sandbox orders in a recorded Kernel cloud browser
 * (or a human does, with --manual). Everything after approval is automatic, and every
 * verdict comes from the truth checker (plain code), stored with its evidence.
 */
import { join } from "node:path";
import { type Recording, openKernelSession, runJourney } from "@certifier/browser-agent";
import { ConfigError, bootConfig, findRepoRoot, redact, requireConfig } from "@certifier/config";
import type { Provider } from "@certifier/llm";
import { TEST_HOOK_PATH, type TestHookCode, type StoreDelivery, deliveriesPath, statusPath, storeDeliveries, storeOrderStatus } from "@certifier/contract";
import { certifierRepo, createPgDb, migrateCertifier } from "@certifier/db";
import { PaypalCallError, SandboxPaypal, verifyWebhook, webhookHeadersFrom } from "@certifier/paypal";
import {
  type DeliverySnap,
  type DuplicateDelivery,
  type SignedEventSnap,
  type StoreRecordSnap,
  type Verdict,
  deliverySnap,
  judgeW1,
  judgeW2,
  judgeW3,
  judgeW4,
  judgeW5,
  judgeW6,
  orderSnap,
  refundSnap,
} from "@certifier/truth";
import { RunBudget, RunStopped } from "./budget.js";

const config = bootConfig("works:run");

let env: ReturnType<typeof requireEnv>;
function requireEnv() {
  return requireConfig(config, "works:run", [
    "PAYPAL_CLIENT_ID",
    "PAYPAL_CLIENT_SECRET",
    "DATABASE_URL",
    "PAYPAL_WEBHOOK_ID",
    "WEBHOOK_PUBLIC_URL",
    "DEMO_STORE_GOOD_WEBHOOK_ID",
    "DEMO_STORE_GOOD_STATUS_KEY",
  ]);
}
try {
  env = requireEnv();
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}

const storeUrl = config.DEMO_STORE_GOOD_URL.replace(/\/+$/, "");
const budget = new RunBudget(config.RUN_MAX_REQUESTS, config.RUN_MAX_MINUTES);

// The agent approves orders unless --manual is given (it then needs Kernel, an LLM and the buyer).
const useAgent = !process.argv.includes("--manual");
function requireAgentEnv() {
  return requireConfig(config, "the browser agent (or pass --manual)", [
    "KERNEL_API_KEY",
    "LLM_PROVIDER",
    "LLM_MODEL",
    "LLM_API_KEY",
    "PAYPAL_SANDBOX_BUYER_EMAIL",
    "PAYPAL_SANDBOX_BUYER_PASSWORD",
  ]);
}
let agentEnv: ReturnType<typeof requireAgentEnv> | undefined;
if (useAgent) {
  try {
    agentEnv = requireAgentEnv();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
}
let recording: Recording | undefined;

/** One recorded Kernel browser approves every order in turn. Returns the recording. */
async function approveWithAgent(links: [string, string, string | undefined][]): Promise<Recording | undefined> {
  const a = agentEnv!;
  let rec: Recording | undefined;
  const session = await openKernelSession(a.KERNEL_API_KEY);
  console.log(`AI buyer agent approving ${links.length} orders in Kernel browser ${session.sessionId} (recorded)…`);
  try {
    for (const [label, id, link] of links) {
      budget.check();
      if (!link) {
        console.log(`  ${label}: no approval link; skipped`);
        continue;
      }
      const result = await runJourney({
        context: session.context,
        startUrl: link,
        mission: `This is a PayPal sandbox checkout page for order ${id}, which already exists. Log in as the buyer if asked, then approve and complete the payment. Reply done as soon as you are back on the store and it shows any final result, including "Payment not completed" (some of these orders are meant to fail).`,
        llm: { provider: a.LLM_PROVIDER as Provider, model: a.LLM_MODEL, apiKey: a.LLM_API_KEY },
        buyer: { email: a.PAYPAL_SANDBOX_BUYER_EMAIL, password: a.PAYPAL_SANDBOX_BUYER_PASSWORD },
        scrub: (t) => redact(t, config),
        maxSteps: 20,
      });
      console.log(`  ${label}: agent finished in ${result.steps.length} steps (${result.outcome}; the agent's own report, not evidence)`);
    }
  } finally {
    rec = await session.close(join(findRepoRoot()!, "recordings"));
    console.log(rec ? `Recording saved: replay ${rec.replayId}` : "Recording: not available");
    notes.recording = rec ? { replayId: rec.replayId, file: rec.file ?? null } : null;
  }
  return rec;
}
process.on("SIGINT", () => {
  console.log("\nKill switch: stopping the run.");
  budget.kill();
});

const paypal = new SandboxPaypal(config, {
  // The audit sink is also where PayPal calls are counted against the budget.
  audit: (e) => console.log(`  [paypal] ${e.operation} ${e.ok ? "ok" : "FAILED"} ${e.resourceId ?? ""} ${e.resourceStatus ?? ""}${e.requestId ? ` request-id=${e.requestId}` : ""}`),
});
const pp = async <T>(fn: () => Promise<T>): Promise<T> => {
  budget.spend();
  return fn();
};

const db = createPgDb(env.DATABASE_URL);
const repo = certifierRepo(db);

// ---------------------------------------------------------------- store client (contract)
async function storeFetch(path: string, init: RequestInit = {}) {
  budget.spend();
  return fetch(new URL(path, storeUrl), { ...init, signal: AbortSignal.timeout(20_000) });
}
const keyHeader = { authorization: `Bearer ${env.DEMO_STORE_GOOD_STATUS_KEY}` };

async function storeCreateOrder(sku: string): Promise<string> {
  const res = await storeFetch("/api/orders", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sku, quantity: 1 }) });
  if (res.status !== 201) throw new Error(`store refused to create an order (HTTP ${res.status})`);
  return ((await res.json()) as { id: string }).id;
}

async function storeArm(paypalOrderId: string, mock: TestHookCode): Promise<boolean> {
  const res = await storeFetch(TEST_HOOK_PATH, {
    method: "POST",
    headers: { ...keyHeader, "content-type": "application/json" },
    body: JSON.stringify({ paypalOrderId, mock }),
  });
  return res.status === 204;
}

async function storeStatus(paypalOrderId: string): Promise<StoreRecordSnap | undefined> {
  const res = await storeFetch(statusPath(paypalOrderId), { headers: keyHeader });
  if (!res.ok) return undefined;
  const parsed = storeOrderStatus.safeParse(await res.json());
  return parsed.success ? parsed.data : undefined;
}

async function storeDeliveryLog(eventId: string): Promise<StoreDelivery[] | undefined> {
  const res = await storeFetch(deliveriesPath(eventId, RUN_STARTED), { headers: keyHeader });
  if (!res.ok) return undefined;
  const parsed = storeDeliveries.safeParse(await res.json());
  return parsed.success ? parsed.data.deliveries : undefined;
}

const toSigned = (e: Awaited<ReturnType<typeof repo.findSignedEvent>>): SignedEventSnap | undefined =>
  e
    ? { eventId: e.event_id, type: e.type, resourceId: e.resource_id ?? undefined, signatureValid: e.signature_valid, receivedAt: new Date(e.received_at).toISOString() }
    : undefined;

async function deliveryOf(eventId: string): Promise<DeliverySnap | undefined> {
  try {
    return deliverySnap(await pp(() => paypal.getWebhookEvent(eventId)));
  } catch (err) {
    if (err instanceof PaypalCallError) return undefined;
    throw err;
  }
}

// ---------------------------------------------------------------- the run
const WAIT = config.WEBHOOK_WAIT_SECONDS;
// Deliveries are requested only from this moment on (store contract: delivery log is per run).
const RUN_STARTED = new Date();
const verdicts: Verdict[] = [];
let runId: string | undefined;
const notes: Record<string, unknown> = {};

try {
  await migrateCertifier(db);
  runId = await repo.createRun({ storeUrl, budgetRequests: config.RUN_MAX_REQUESTS, timeLimitMin: config.RUN_MAX_MINUTES });
  console.log(`Run ${runId} against ${storeUrl} (budget ${config.RUN_MAX_REQUESTS} requests, ${config.RUN_MAX_MINUTES} min)\n`);

  // 1. Three orders through the store's own checkout API — or reuse the approved orders of an
  //    earlier run (`--resume <run id>`), so a human does not have to approve again.
  const resumeIdx = process.argv.indexOf("--resume");
  const resumeFrom = resumeIdx > 0 ? process.argv[resumeIdx + 1] : undefined;
  let A: string, B: string, C: string, hookB: boolean, hookC: boolean;
  if (resumeFrom) {
    const prev = (await repo.getRunNotes(resumeFrom)) as { orders?: { A: string; B: string; C: string }; hookB?: boolean; hookC?: boolean } | undefined;
    if (!prev?.orders) throw new Error(`run ${resumeFrom} has no recorded orders to resume`);
    ({ A, B, C } = prev.orders);
    hookB = prev.hookB === true;
    hookC = prev.hookC === true;
    console.log(`Resuming the orders of run ${resumeFrom}: A=${A} B=${B} C=${C}
`);
  } else {
    A = await storeCreateOrder("MUG-01"); // W1, W4, W5, W6
    B = await storeCreateOrder("NOTE-01"); // W2 decline
    C = await storeCreateOrder("LAMP-01"); // W3 server error
    hookB = await storeArm(B, "INSTRUMENT_DECLINED");
    hookC = await storeArm(C, "INTERNAL_SERVER_ERROR");
    // Demo store only: answer the first refund delivery for A with an error so PayPal retries it.
    const fa = await storeFetch("/__demo/fail-ack", {
      method: "POST",
      headers: { ...keyHeader, "content-type": "application/json" },
      body: JSON.stringify({ paypalOrderId: A, eventType: "PAYMENT.CAPTURE.REFUNDED" }),
    });
    notes.failAck = fa.status === 204;
  }
  Object.assign(notes, { orders: { A, B, C }, hookB, hookC, resumedFrom: resumeFrom ?? null });

  // 2. Buyer approval: the AI browser agent in a Kernel cloud browser (recorded), or a human
  //    with --manual. The agent's own "done" is not evidence; the store and PayPal records are.
  if (!resumeFrom) {
  const links: [string, string, string | undefined][] = [];
  for (const [label, id] of [["A (purchase, then refund)", A], ["B (will be declined)", B], ["C (server error)", C]] as const) {
    const order = await pp(() => paypal.getOrder(id));
    links.push([label, id, order.links?.find((l) => l.rel === "payer-action" || l.rel === "approve")?.href]);
  }
  if (useAgent) {
    recording = await approveWithAgent(links);
  } else {
    console.log("Approve these three sandbox orders as the sandbox BUYER (any order, one browser tab each):");
    for (const [label, , link] of links) console.log(`  ${label}: ${link ?? "(no approval link returned)"}`);
  }
  console.log(`\nWaiting for the store to finish each checkout (up to ${config.RUN_MAX_MINUTES} min)…`);
  const settled = async (id: string) => {
    const s = await storeStatus(id);
    return s && s.status !== "created" && s.status !== "capturing" ? s : undefined;
  };
  await budget.waitFor(async () => ((await settled(A)) && (await settled(B)) && (await settled(C)) ? true : undefined), {
    seconds: config.RUN_MAX_MINUTES * 60,
    everyMs: 5000,
  });
  }

  // 3. Order A: purchase, signed capture event, delivery to the store.
  const orderA = orderSnap(await pp(() => paypal.getOrder(A)));
  const storeA0 = await storeStatus(A);
  const capA = orderA.captures.find((c) => c.status === "COMPLETED")?.id;
  verdicts.push(judgeW1({ order: orderA, store: storeA0 }));

  let captureEvent: SignedEventSnap | undefined;
  let storeA1: StoreRecordSnap | undefined;
  if (capA) {
    console.log(`Waiting up to ${WAIT}s for PayPal's signed capture event…`);
    captureEvent = toSigned(await budget.waitFor(() => repo.findSignedEvent("PAYMENT.CAPTURE.COMPLETED", capA), { seconds: WAIT }));
    if (captureEvent) {
      const eid = captureEvent.eventId;
      storeA1 = await budget.waitFor(async () => {
        const s = await storeStatus(A);
        return s?.webhookEvents.some((e) => e.eventId === eid) ? s : undefined;
      }, { seconds: WAIT });
    }
  }
  const delivery1 = captureEvent ? await deliveryOf(captureEvent.eventId) : undefined;
  verdicts.push(judgeW5({ captureEvent, delivery: delivery1, certifierWebhookUrl: env.WEBHOOK_PUBLIC_URL, store: storeA1 ?? storeA0 }));

  // 4. W6 part 1 (no waiting): ask PayPal to re-send, then replay the store's own signed
  //    delivery byte for byte — only after verifying PayPal's signature on it ourselves.
  const duplicates: DuplicateDelivery[] = [];
  const dupNotes: string[] = [];
  const w6Before = storeA1;
  if (captureEvent && storeA1) {
    const eid = captureEvent.eventId;
    try {
      await pp(() => paypal.resendWebhookEvent(eid, [env.DEMO_STORE_GOOD_WEBHOOK_ID]));
      dupNotes.push(`PayPal accepted a re-send request for ${eid}; any PayPal delivery is checked at the end of the run.`);
    } catch (err) {
      if (!(err instanceof PaypalCallError)) throw err;
      dupNotes.push(`PayPal refused to re-send ${eid}: ${err.message}`);
    }
    const log = await storeDeliveryLog(eid);
    const original = log?.find((d) => d.responseStatus !== null && d.responseStatus >= 200 && d.responseStatus < 300) ?? log?.[0];
    if (!original) {
      dupNotes.push("Replay path not available: the store does not offer the optional delivery log (extended contract). W6 relied on PayPal's resend only.");
    } else {
      const raw = Buffer.from(original.bodyBase64, "base64");
      const check = await verifyWebhook({ headers: webhookHeadersFrom(original.headers), rawBody: raw, webhookId: env.DEMO_STORE_GOOD_WEBHOOK_ID });
      if (!check.valid) {
        dupNotes.push(`The store's copy of ${eid} did not verify as PayPal-signed (${check.reason}); not replayed.`);
      } else {
        budget.spend();
        const res = await fetch(new URL("/webhooks/paypal", storeUrl), {
          method: "POST",
          headers: { ...original.headers, "content-type": "application/json" },
          body: raw,
          signal: AbortSignal.timeout(20_000),
        });
        console.log(`Replayed the store's PayPal-signed delivery of ${eid}; store answered HTTP ${res.status}.`);
        duplicates.push({ eventId: eid, source: "certifier-replay", signatureVerified: true, transmissionId: original.transmissionId });
      }
    }
  }
  const storeA2 = (await storeStatus(A)) ?? storeA1;

  // 5. W4: refund A in PayPal; the store must learn it from the webhook.
  let refundEventId: string | undefined;
  const storeBeforeRefund = storeA2 ?? storeA1 ?? storeA0;
  let refundError: string | undefined;
  const refunded = capA && storeBeforeRefund?.status === "paid"
    ? await pp(() => paypal.refundCapture(capA)).catch((err: unknown) => {
        if (!(err instanceof PaypalCallError)) throw err;
        refundError = `PayPal refused the refund: ${err.message}`;
        return undefined;
      })
    : undefined;
  if (capA && refunded) {
    const { refund } = refunded;
    const refundId = refund.id!;
    const refundDone = await budget.waitFor(async () => {
      const r = await pp(() => paypal.getRefund(refundId));
      return r.status === "COMPLETED" || r.status === "FAILED" || r.status === "CANCELLED" ? r : undefined;
    }, { seconds: 60 });
    console.log(`Waiting up to ${WAIT}s for the signed refund event and the store's refund record…`);
    const refundEvent = toSigned(await budget.waitFor(() => repo.findSignedEvent("PAYMENT.CAPTURE.REFUNDED", refundId), { seconds: WAIT }));
    const storeA3 = (await budget.waitFor(async () => {
      const s = await storeStatus(A);
      return s?.status === "refunded" ? s : undefined;
    }, { seconds: refundEvent ? 30 : 5 })) ?? (await storeStatus(A));
    verdicts.push(judgeW4({ refund: refundSnap(refundDone ?? refund), refundEvent, store: storeA3 }));
    refundEventId = refundEvent?.eventId;
  } else {
    verdicts.push(judgeW4({ refundError: refundError ?? (storeBeforeRefund ? `Order A is "${storeBeforeRefund.status}" in the store, not "paid", so it was not refunded.` : undefined) }));
  }

  // 6. W2 / W3: forced errors on the store's own capture.
  verdicts.push(judgeW2({ hookSupported: hookB, order: orderSnap(await pp(() => paypal.getOrder(B))), store: await storeStatus(B) }));
  verdicts.push(judgeW3({ hookSupported: hookC, order: orderSnap(await pp(() => paypal.getOrder(C))), store: await storeStatus(C) }));

  // 7. W6 part 2 (no waiting): did PayPal itself deliver a duplicate during the run? Any
  //    delivery with a NEW transmission ID that verifies as PayPal-signed came from PayPal
  //    (a replay can only reuse the original transmission ID).
  for (const eid of [captureEvent?.eventId, refundEventId]) {
    if (!eid) continue;
    const log = (await storeDeliveryLog(eid)) ?? [];
    const firstTx = log[0]?.transmissionId;
    for (const d of log) {
      if (d.transmissionId === firstTx || duplicates.some((x) => x.source === "paypal" && x.transmissionId === d.transmissionId)) continue;
      const check = await verifyWebhook({ headers: webhookHeadersFrom(d.headers), rawBody: Buffer.from(d.bodyBase64, "base64"), webhookId: env.DEMO_STORE_GOOD_WEBHOOK_ID });
      if (check.valid) duplicates.push({ eventId: eid, source: "paypal", signatureVerified: true, transmissionId: d.transmissionId });
    }
  }
  verdicts.push(judgeW6({ duplicates, before: w6Before, after: await storeStatus(A), notes: dupNotes }));

  // The recording shows the buyer approvals behind W1–W4. It is our own record, labelled as such.
  if (recording) {
    for (const v of verdicts) {
      if (["W1", "W2", "W3", "W4"].includes(v.check)) {
        v.evidence.push({ kind: "video", id: recording.replayId, strength: "certifier-recorded", note: "Kernel recording of the AI buyer approving the orders" });
      }
    }
  }

  verdicts.sort((a, b) => a.check.localeCompare(b.check));
  for (const v of verdicts) await repo.saveVerdict(runId, "works", v);
  await repo.finishRun(runId, "judged", budget.used, notes);
  report();
} catch (err) {
  if (runId) await repo.finishRun(runId, err instanceof RunStopped ? "stopped" : "failed", budget.used, { ...notes, error: err instanceof Error ? err.message : "unknown" }).catch(() => {});
  if (verdicts.length) report();
  console.error(err instanceof RunStopped || err instanceof PaypalCallError ? err.message : `run failed: ${err instanceof Error ? err.message : "unknown error"}`);
  process.exitCode = 1;
} finally {
  await db.close();
}

function report() {
  console.log(`\n=== Works pillar — run ${runId} — ${budget.used}/${config.RUN_MAX_REQUESTS} requests ===`);
  for (const v of verdicts) {
    console.log(`${v.status.toUpperCase().padEnd(12)} ${v.check}  ${v.summary}`);
    for (const r of v.reasons) console.log(`               - ${r}`);
    for (const e of v.evidence) console.log(`               evidence: ${e.kind} ${e.id} [${e.strength}]${e.note ? ` ${e.note}` : ""}`);
  }
  const passed = verdicts.filter((v) => v.status === "pass").length;
  console.log(`\n${passed}/${verdicts.length} passed`);
}
