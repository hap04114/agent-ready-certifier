/**
 * `pnpm works:run` — run the Works pillar (W1–W6) against demo-store-good.
 *
 * Milestone 2 runner. Until the browser agent exists (Milestone 3), a human approves the
 * three sandbox orders using the printed links. Everything after approval is automatic,
 * and every verdict comes from the truth checker (plain code), stored with its evidence.
 */
import { ConfigError, bootConfig, requireConfig } from "@certifier/config";
import { TEST_HOOK_PATH, type TestHookCode, statusPath, storeOrderStatus } from "@certifier/contract";
import { certifierRepo, createPgDb, migrateCertifier } from "@certifier/db";
import { PaypalCallError, SandboxPaypal } from "@certifier/paypal";
import {
  type DeliverySnap,
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
  }
  Object.assign(notes, { orders: { A, B, C }, hookB, hookC, resumedFrom: resumeFrom ?? null });

  // 2. Human approval (until the browser agent exists).
  if (!resumeFrom) {
  console.log("Approve these three sandbox orders as the sandbox BUYER (any order, one browser tab each):");
  for (const [label, id] of [["A (purchase, then refund)", A], ["B (will be declined)", B], ["C (server error)", C]] as const) {
    const order = await pp(() => paypal.getOrder(id));
    const link = order.links?.find((l) => l.rel === "payer-action" || l.rel === "approve")?.href;
    console.log(`  ${label}: ${link ?? "(no approval link returned)"}`);
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

  // 4. W6: PayPal re-sends the same event to the store's webhook.
  let resendRequested = false;
  let resendError: string | undefined;
  let storeA2: StoreRecordSnap | undefined;
  let delivery2: DeliverySnap | undefined;
  if (captureEvent && storeA1) {
    const eid = captureEvent.eventId;
    try {
      await pp(() => paypal.resendWebhookEvent(eid, [env.DEMO_STORE_GOOD_WEBHOOK_ID]));
      resendRequested = true;
    } catch (err) {
      if (!(err instanceof PaypalCallError)) throw err;
      resendError = `PayPal refused to re-send event ${eid}: ${err.message}`;
    }
  }
  if (captureEvent && storeA1 && resendRequested) {
    const eid = captureEvent.eventId;
    console.log("Asked PayPal to re-send the capture event to the store; waiting…");
    storeA2 = await budget.waitFor(async () => {
      const s = await storeStatus(A);
      return (s?.webhookEvents.find((e) => e.eventId === eid)?.deliveries ?? 0) >= 2 ? s : undefined;
    }, { seconds: WAIT });
    storeA2 ??= await storeStatus(A);
    delivery2 = await deliveryOf(eid);
  }
  verdicts.push(
    judgeW6({ eventId: captureEvent?.eventId, resendRequested, resendError, before: storeA1, after: storeA2 ?? storeA1, delivery: delivery2, certifierWebhookUrl: env.WEBHOOK_PUBLIC_URL }),
  );

  // 5. W4: refund A in PayPal; the store must learn it from the webhook.
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
  } else {
    verdicts.push(judgeW4({ refundError: refundError ?? (storeBeforeRefund ? `Order A is "${storeBeforeRefund.status}" in the store, not "paid", so it was not refunded.` : undefined) }));
  }

  // 6. W2 / W3: forced errors on the store's own capture.
  verdicts.push(judgeW2({ hookSupported: hookB, order: orderSnap(await pp(() => paypal.getOrder(B))), store: await storeStatus(B) }));
  verdicts.push(judgeW3({ hookSupported: hookC, order: orderSnap(await pp(() => paypal.getOrder(C))), store: await storeStatus(C) }));

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
