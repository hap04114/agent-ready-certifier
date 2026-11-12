/**
 * `pnpm thirdparty:run [store url]` — FULL certification of PayPal's own example integration
 * (paypal-examples/docs-examples, standard-integration), code we did not write, deployed unchanged
 * behind a thin store-contract adapter (thirdparty/paypal-standard-integration).
 *
 * Unlike the demo stores, the example captures in the browser (its page calls its own
 * /api/orders/:id/capture after approval), so the purchase is made the way a real buyer makes it:
 * an AI buyer in a recorded Kernel cloud browser clicks the example's own PayPal button and pays.
 * Every verdict comes from the same plain-code rules as every other store, from PayPal's records
 * (read with the example's own sandbox app, store contract item 5), the certifier's verified
 * webhooks and the adapter's report of what the example's responses said.
 *
 * Not offered by the example, so judged "inconclusive", never guessed: the test hook (W2, W3, S7)
 * and a webhook endpoint with delivery log (W5 store side, W6, S3). Ctrl+C is the kill switch.
 */
import { join } from "node:path";
import { type Recording, openKernelSession, runJourney, withTimeout } from "@certifier/browser-agent";
import { ConfigError, bootConfig, findRepoRoot, redact, requireConfig } from "@certifier/config";
import { TEST_HOOK_PATH, deriveOwnershipToken, verifyOwnership } from "@certifier/contract";
import { certifierRepo, createPgDb, migrateCertifier } from "@certifier/db";
import { type Provider, fallbackModelsOf } from "@certifier/llm";
import { PaypalCallError, SandboxPaypal } from "@certifier/paypal";
import {
  TAMPER_FIELDS,
  TAMPER_VALUE,
  createOrder,
  findLiveHosts,
  findSecrets,
  measureStorefront,
  observe,
  probeS2,
  probeS4,
  probeS7,
  scanStorefront,
  storeStatus,
  structuredOffers,
} from "@certifier/probes";
import {
  type PaypalOrderSnap,
  type SignedEventSnap,
  type StoreRecordSnap,
  type StorefrontObservation,
  type Verdict,
  chargedItems,
  deliverySnap,
  judgeA4,
  judgeA5,
  judgeC1,
  judgeC2,
  judgeC3,
  judgeC4,
  judgeC5,
  judgeS1,
  judgeS2,
  judgeS3,
  judgeS4,
  judgeS5,
  judgeS6,
  judgeS7,
  judgeS8,
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
import { pillarOf } from "./works.js";

/** The example's source, pinned. Its server charges this fixed amount for every order (server.js). */
const EXAMPLE = { repo: "paypal-examples/docs-examples", path: "standard-integration", commit: "809537903a2c38757d33cd871465741c610088cd" };
const SERVER_PRICE = { currencyCode: "USD", value: "100.00" };
/** What the example's own page sends as its cart (app.js). */
const EXAMPLE_CART_ITEM = { id: "YOUR_PRODUCT_ID", quantity: "YOUR_PRODUCT_QUANTITY" };
const MISSION =
  "This store page sells one item for $100. Buy it with the PayPal button on the page (log in to the PayPal sandbox account when asked) and complete the payment. Reply done once the store page shows the transaction result, or give_up if you cannot finish.";

const config = bootConfig("thirdparty:run");
const arg = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : config.EXAMPLE_STORE_URL;
const storeUrl = new URL(arg).origin;

let env: Record<
  | "DATABASE_URL"
  | "OWNERSHIP_TOKEN_SECRET"
  | "EXAMPLE_STORE_STATUS_KEY"
  | "REALWORLD_PAYPAL_CLIENT_ID"
  | "REALWORLD_PAYPAL_CLIENT_SECRET"
  | "KERNEL_API_KEY"
  | "LLM_PROVIDER"
  | "LLM_MODEL"
  | "LLM_API_KEY"
  | "PAYPAL_SANDBOX_BUYER_EMAIL"
  | "PAYPAL_SANDBOX_BUYER_PASSWORD",
  string
>;
try {
  env = requireConfig(config, "thirdparty:run", [
    "DATABASE_URL",
    "OWNERSHIP_TOKEN_SECRET",
    "EXAMPLE_STORE_STATUS_KEY",
    "REALWORLD_PAYPAL_CLIENT_ID",
    "REALWORLD_PAYPAL_CLIENT_SECRET",
    "KERNEL_API_KEY",
    "LLM_PROVIDER",
    "LLM_MODEL",
    "LLM_API_KEY",
    "PAYPAL_SANDBOX_BUYER_EMAIL",
    "PAYPAL_SANDBOX_BUYER_PASSWORD",
  ]);
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}

const budget = new RunBudget(config.RUN_MAX_REQUESTS, config.RUN_MAX_MINUTES);
process.on("SIGINT", () => {
  console.log("\nKill switch: stopping the run.");
  budget.kill();
});
const log = (line: string) => console.log(redact(line, config));
const WAIT = config.WEBHOOK_WAIT_SECONDS;
const t0 = Date.now();
const timeline: { name: string; kind: string; start: number; end: number; note?: string }[] = [];
const step = (name: string, kind: string) => {
  const start = (Date.now() - t0) / 1000;
  return (note?: string) => void timeline.push({ name, kind, start, end: (Date.now() - t0) / 1000, ...(note ? { note } : {}) });
};
const notes: Record<string, unknown> = {
  mode: "full, third-party",
  thirdParty: {
    ...EXAMPLE,
    hosting: "deployed unchanged as its own Render service behind a thin store-contract adapter (thirdparty/paypal-standard-integration/adapter.mjs)",
    serverPrice: "S1 compares with the fixed 100.00 USD the example's server.js sets for every order (it has no catalog)",
    notOffered: "test hook (W2, W3, S7) and a webhook endpoint with delivery log (W5 store side, W6, S3): judged inconclusive, never guessed",
  },
  timeline,
};

// Store contract item 5: the example's own sandbox app, to read its orders and refund.
const paypal = new SandboxPaypal({ ...config, PAYPAL_CLIENT_ID: env.REALWORLD_PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET: env.REALWORLD_PAYPAL_CLIENT_SECRET });
const pp = async <T>(fn: () => Promise<T>): Promise<T> => {
  budget.spend();
  return fn();
};
const getOrder = async (id: string): Promise<PaypalOrderSnap | undefined> => {
  try {
    return orderSnap(await pp(() => paypal.getOrder(id)));
  } catch (err) {
    if (err instanceof PaypalCallError) return undefined;
    throw err;
  }
};
const target = { url: storeUrl, statusKey: env.EXAMPLE_STORE_STATUS_KEY };
const deps = { spend: () => budget.spend() };
const status = (id: string): Promise<StoreRecordSnap | undefined> => storeStatus(target, deps, id).catch(() => undefined);

const db = createPgDb(env.DATABASE_URL);
const repo = certifierRepo(db);
const verdicts: Verdict[] = [];
let runId = "";
try {
  await migrateCertifier(db);
  runId = await repo.createRun({ storeUrl, budgetRequests: budget.maxRequests, timeLimitMin: config.RUN_MAX_MINUTES });
  log(`Run ${runId} (full, third-party: ${EXAMPLE.repo}/${EXAMPLE.path} @ ${EXAMPLE.commit.slice(0, 12)}) against ${storeUrl}`);
  const ownershipToken = deriveOwnershipToken(env.OWNERSHIP_TOKEN_SECRET, storeUrl);
  // Registering the store tells the certifier's listener which webhook ID the example's app signs with.
  await repo.createStore({ url: storeUrl, ownershipToken, certifierWebhookId: config.EXAMPLE_STORE_CERTIFIER_WEBHOOK_ID });

  const ownDone = step("Ownership check", "setup");
  const own = await verifyOwnership(storeUrl, ownershipToken);
  ownDone(own.verified ? `verified via ${own.method}` : "not verified");
  if (!own.verified) {
    log(`Ownership NOT verified (${own.reason}); nothing was tested.`);
    await repo.finishRun(runId, "stopped", budget.used, { ...notes, stoppedBecause: "ownership not verified", detail: own.reason });
    process.exit(1);
  }
  log(`Ownership verified via ${own.method}.`);
  await repo.setRunStatus(runId, "running");

  const scanDone = step("Page scan", "setup");
  const scan = await scanStorefront(`${storeUrl}/`, deps);
  scanDone(`HTTP ${scan.status ?? "?"}, ${scan.files.length} files`);

  // ---- The purchase, as a real buyer makes it: the example's own button, its own capture.
  let rendered: StorefrontObservation["rendered"];
  let recording: Recording | undefined;
  let A: string | undefined;
  const session = await openKernelSession(env.KERNEL_API_KEY);
  try {
    const measureDone = step("Browser measurement (C3, A5)", "agent");
    try {
      rendered = await measureStorefront(session.context, storeUrl);
      measureDone(`PayPal button ${rendered.paypalButton ? "found" : "not found"}`);
    } catch {
      measureDone("failed");
    }
    const buyDone = step("AI buyer pays with the example's own PayPal button", "agent");
    const journey = await withTimeout(
      runJourney({
        context: session.context,
        startUrl: `${storeUrl}/`,
        mission: MISSION,
        llm: { provider: env.LLM_PROVIDER as Provider, model: env.LLM_MODEL, apiKey: env.LLM_API_KEY, fallbackModels: fallbackModelsOf(config.LLM_FALLBACK_MODELS) },
        buyer: { email: env.PAYPAL_SANDBOX_BUYER_EMAIL, password: env.PAYPAL_SANDBOX_BUYER_PASSWORD },
        scrub: (t) => redact(t, config),
        maxSteps: 25,
        log: (l) => log(`  ${l.trim()}`),
      }),
      8 * 60_000,
    ).catch((err): Awaited<ReturnType<typeof runJourney>> => ({ outcome: "error", steps: [], paypalOrderIds: [], error: err instanceof Error ? err.message : "journey failed" }));
    A = journey.paypalOrderIds.at(-1);
    buyDone(`${journey.outcome}, ${journey.steps.length} steps`);
    log(`AI buyer finished: ${journey.outcome} in ${journey.steps.length} steps (its own report, not evidence); PayPal order seen: ${A ?? "none"}`);
    notes.journey = { outcome: journey.outcome, steps: journey.steps.length, ordersSeen: journey.paypalOrderIds };
  } finally {
    recording = await session.close(join(findRepoRoot() ?? process.cwd(), "recordings"));
    notes.recording = recording ? { replayId: recording.replayId, file: recording.file ?? null } : null;
    log(recording ? `Recording saved: replay ${recording.replayId}` : "Recording: not available");
  }
  notes.orders = { A: A ?? null };

  // ---- W1: PayPal and the example agree about the purchase.
  if (A) {
    const id = A;
    await budget.waitFor(
      async () => {
        const s = await status(id);
        return s && s.status !== "created" && s.status !== "capturing" ? s : undefined;
      },
      { seconds: 60, everyMs: 4000 },
    );
  }
  const orderA = A ? await getOrder(A) : undefined;
  const storeA0 = A ? await status(A) : undefined;
  verdicts.push(A ? judgeW1({ order: orderA, store: storeA0 }) : judgeW1({}));
  const capA = orderA?.captures.find((c) => c.status === "COMPLETED")?.id;

  // ---- W5: PayPal's signed capture event reaches the certifier (the example has no listener).
  let captureEvent: SignedEventSnap | undefined;
  if (capA) {
    const capWaitDone = step("PayPal signed capture event (W5)", "webhook");
    const e = await budget.waitFor(() => repo.findSignedEvent("PAYMENT.CAPTURE.COMPLETED", capA), { seconds: WAIT });
    captureEvent = e
      ? { eventId: e.event_id, type: e.type, resourceId: e.resource_id ?? undefined, signatureValid: e.signature_valid, receivedAt: new Date(e.received_at).toISOString() }
      : undefined;
    capWaitDone(captureEvent ? "arrived, signature verified" : "missing");
  }
  let delivery: ReturnType<typeof deliverySnap> | undefined;
  if (captureEvent) {
    try {
      delivery = deliverySnap(await pp(() => paypal.getWebhookEvent(captureEvent!.eventId)));
    } catch (err) {
      if (!(err instanceof PaypalCallError)) throw err;
    }
  }
  verdicts.push(judgeW5({ captureEvent, delivery, certifierWebhookUrl: config.WEBHOOK_PUBLIC_URL, store: A ? await status(A) : undefined }));

  // ---- S4: ask the example to capture order A a second time.
  if (A && capA) {
    const s4Done = step("Attack: second capture (S4)", "attack");
    const before = await status(A);
    const s4 = await probeS4(target, deps, A);
    s4Done(`HTTP ${s4.secondCaptureHttpStatus}`);
    verdicts.push(judgeS4({ secondCaptureHttpStatus: s4.secondCaptureHttpStatus, order: await getOrder(A), before, after: await status(A) }));
  } else {
    verdicts.push(judgeS4({}));
  }

  // ---- W6 / S3: no webhook endpoint, delivery log or store webhook ID, so no duplicate to send.
  const dupNotes = ["Replay path not available: the example has no webhook endpoint, delivery log or store webhook ID (extended contract), and PayPal delivers its events only to the certifier's listener."];
  const w6Store = A ? await status(A) : undefined;
  verdicts.push(judgeW6({ duplicates: [], before: w6Store, after: w6Store, notes: dupNotes }));
  verdicts.push(judgeS3({ duplicates: [], before: w6Store, after: w6Store, notes: dupNotes }));

  // ---- W4: refund A in PayPal; a store must learn it (webhook or otherwise).
  const storeBeforeRefund = A ? await status(A) : undefined;
  if (A && capA && storeBeforeRefund?.status === "paid") {
    let refundError: string | undefined;
    const refunded = await pp(() => paypal.refundCapture(capA)).catch((err: unknown) => {
      if (!(err instanceof PaypalCallError)) throw err;
      refundError = `PayPal refused the refund: ${err.message}`;
      return undefined;
    });
    if (refunded) {
      const refundId = refunded.refund.id!;
      const done = await budget.waitFor(
        async () => {
          const r = await pp(() => paypal.getRefund(refundId));
          return r.status === "COMPLETED" || r.status === "FAILED" || r.status === "CANCELLED" ? r : undefined;
        },
        { seconds: 60 },
      );
      const refWaitDone = step("PayPal signed refund event (W4)", "webhook");
      const e = await budget.waitFor(() => repo.findSignedEvent("PAYMENT.CAPTURE.REFUNDED", refundId), { seconds: WAIT });
      refWaitDone(e ? "arrived, signature verified" : "missing");
      const refundEvent: SignedEventSnap | undefined = e
        ? { eventId: e.event_id, type: e.type, resourceId: e.resource_id ?? undefined, signatureValid: e.signature_valid, receivedAt: new Date(e.received_at).toISOString() }
        : undefined;
      const storeA3 = (await budget.waitFor(async () => ((await status(A!))?.status === "refunded" ? status(A!) : undefined), { seconds: refundEvent ? 30 : 5 })) ?? (await status(A));
      verdicts.push(judgeW4({ refund: refundSnap(done ?? refunded.refund), refundEvent, store: storeA3 }));
    } else {
      verdicts.push(judgeW4({ refundError }));
    }
  } else {
    verdicts.push(judgeW4({ refundError: storeBeforeRefund ? `Order A is "${storeBeforeRefund.status}" in the store, not "paid", so it was not refunded.` : undefined }));
  }

  // ---- W2 / W3: does the store offer the sandbox-only test hook? (The example does not.)
  const attacksDone = step("Attacks: test hook, price tampering, forged webhook, retry (W2, W3, S1, S2, S7)", "attack");
  const B = await createOrder(target, deps, { cart: [EXAMPLE_CART_ITEM] });
  const arm = async (mock: string) => {
    if (!B.id) return false;
    budget.spend();
    const res = await fetch(new URL(TEST_HOOK_PATH, storeUrl), {
      method: "POST",
      headers: { authorization: `Bearer ${env.EXAMPLE_STORE_STATUS_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ paypalOrderId: B.id, mock }),
      signal: AbortSignal.timeout(20_000),
    });
    return res.status === 204;
  };
  const hookB = await arm("INSTRUMENT_DECLINED");
  const hookC = await arm("INTERNAL_SERVER_ERROR");
  notes.hook = { offered: hookB || hookC };
  const orderB = B.id ? await getOrder(B.id) : undefined;
  const storeB = B.id ? await status(B.id) : undefined;
  verdicts.push(judgeW2({ hookSupported: hookB, order: orderB, store: storeB }));
  verdicts.push(judgeW3({ hookSupported: hookC, order: orderB, store: storeB }));

  // ---- S1: every common price field, top level and in the example's own cart item, set to 1.00.
  const tamper = Object.fromEntries(TAMPER_FIELDS.map((f) => [f, TAMPER_VALUE]));
  const s1 = await createOrder(target, deps, { cart: [{ id: EXAMPLE_CART_ITEM.id, quantity: "1", ...tamper }], ...tamper });
  const s1Order = s1.id ? await getOrder(s1.id) : undefined;
  verdicts.push(
    judgeS1({
      serverPrice: SERVER_PRICE,
      tamperedValue: TAMPER_VALUE,
      tamperedFields: [...TAMPER_FIELDS, ...TAMPER_FIELDS.map((f) => `cart[0].${f}`)],
      order: s1Order,
      storeRejected: s1.status >= 400 && s1.status < 500,
    }),
  );

  // ---- S2: an unsigned "payment completed" for a fresh, unpaid order.
  const s2Created = await createOrder(target, deps, { cart: [EXAMPLE_CART_ITEM] });
  if (s2Created.id) {
    const before = await status(s2Created.id);
    const s2 = await probeS2(target, deps, s2Created.id, SERVER_PRICE);
    await new Promise((r) => setTimeout(r, 1500));
    verdicts.push(judgeS2({ ...s2, before, after: await status(s2Created.id), order: await getOrder(s2Created.id) }));
  } else {
    verdicts.push(judgeS2({ sent: false }));
  }

  // ---- S7: the retry-simulation test hook (not offered by the example).
  const s7 = await probeS7(target, deps, { sku: EXAMPLE_CART_ITEM.id, price: SERVER_PRICE.value, currency: SERVER_PRICE.currencyCode });
  const resolved: PaypalOrderSnap[] = [];
  for (const id of [...new Set(s7.hookSupported ? (s7.createAttempts ?? []) : [])]) {
    const o = await getOrder(id);
    if (o) resolved.push(o);
  }
  verdicts.push(judgeS7({ hookSupported: s7.hookSupported, createAttempts: s7.hookSupported ? s7.createAttempts : undefined, resolved }));
  attacksDone();

  // ---- Page checks (Current, front-end Secure, Agent-ready store checks).
  const judgeDone = step("Page checks and judging", "judge");
  const page: StorefrontObservation = { ...observe(scan), rendered };
  const scanned = scan.files.map((x) => x.url);
  verdicts.push(judgeC1(page), judgeC2(page), judgeC3(page), judgeC4({ configured: false, url: page.url }), judgeC5(page));
  verdicts.push(judgeS5({ scanned, findings: findSecrets(scan.files) }));
  verdicts.push(judgeS6({ scanned, liveHostHits: findLiveHosts(scan.files), sandboxOrderId: orderA?.id, sandboxOrderResolved: orderA ? true : undefined }));
  verdicts.push(judgeS8({ url: `${storeUrl}/`, status: scan.status, csp: scan.headers["content-security-policy"], hsts: scan.headers["strict-transport-security"] }));
  const charged = [];
  for (const id of [A, s1.id, s2Created.id]) {
    if (!id) continue;
    try {
      charged.push(...chargedItems(await pp(() => paypal.getOrder(id))));
    } catch (err) {
      if (!(err instanceof PaypalCallError)) throw err;
    }
  }
  verdicts.push(judgeA4({ url: page.url, fetched: page.fetched, offers: structuredOffers(scan.html), charged }));
  verdicts.push(judgeA5({ url: page.url, controls: rendered?.controls }));
  if (recording) {
    for (const v of verdicts) {
      if (v.check === "W1" || v.check === "W4") {
        v.evidence.push({ kind: "video", id: recording.replayId, strength: "certifier-recorded", note: "Kernel recording of the AI buyer paying with the example's own PayPal button" });
      }
    }
  }
  const order = ["works", "current", "secure", "agent-ready"];
  verdicts.sort((a, b) => order.indexOf(pillarOf(a.check)) - order.indexOf(pillarOf(b.check)) || a.check.localeCompare(b.check));
  judgeDone();
  for (const v of verdicts) await repo.saveVerdict(runId, pillarOf(v.check), v);
  await repo.finishRun(runId, "judged", budget.used, notes);
  for (const v of verdicts) log(`${v.status.toUpperCase().padEnd(12)} ${v.check}  ${v.summary}${v.reasons.length ? `\n               - ${v.reasons.join("\n               - ")}` : ""}`);
  const n = (s: string) => verdicts.filter((v) => v.status === s).length;
  log(`\nRun ${runId} judged (full, third-party): ${n("pass")} pass, ${n("fail")} fail, ${n("inconclusive")} inconclusive, ${n("not_applicable")} not applicable. Requests used: ${budget.used}.`);
} catch (err) {
  const stopped = err instanceof RunStopped;
  const message = err instanceof Error ? redact(err.message, config) : "unknown error";
  log(`Run ${stopped ? "stopped" : "failed"}: ${message}`);
  if (runId) await repo.finishRun(runId, stopped ? "stopped" : "failed", budget.used, { ...notes, error: message }).catch(() => {});
  process.exitCode = 1;
} finally {
  await db.close();
}
