/**
 * The Works pillar (W1–W6) as a reusable function, used by both the CLI (`pnpm works:run`) and
 * the Run API's in-process worker.
 *
 * The AI browser agent approves the three sandbox orders in a recorded Kernel cloud browser
 * (or a human does, when `agent` is not given). Everything after approval is automatic, and
 * every verdict comes from the truth checker (plain code), stored with its evidence.
 */
import { join } from "node:path";
import { type Recording, openKernelSession, runJourney, withTimeout } from "@certifier/browser-agent";
import { type Config, findRepoRoot, redact } from "@certifier/config";
import {
  TEST_HOOK_PATH,
  type StoreDelivery,
  type TestHookCode,
  deliveriesPath,
  deriveOwnershipToken,
  statusPath,
  storeDeliveries,
  storeOrderStatus,
  verifyOwnership,
} from "@certifier/contract";
import type { CertifierRepo } from "@certifier/db";
import type { Provider } from "@certifier/llm";
import { PaypalCallError, type PaypalAuditEntry, SandboxPaypal, verifyWebhook, webhookHeadersFrom } from "@certifier/paypal";
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
import {
  catalog as storeCatalog,
  createOrder as storeCreateRaw,
  findLiveHosts,
  findSecrets,
  measureStorefront,
  observe,
  probeS1,
  probeS2,
  probeS4,
  probeS7,
  scanStorefront,
  structuredOffers,
} from "@certifier/probes";
import type { StorefrontObservation } from "@certifier/truth";
import { chargedItems, judgeA4, judgeA5, judgeC1, judgeC2, judgeC3, judgeC4, judgeC5, judgeS1, judgeS2, judgeS3, judgeS4, judgeS5, judgeS6, judgeS7, judgeS8 } from "@certifier/truth";
import { type RunBudget, RunStopped } from "./budget.js";

export const pillarOf = (code: string) => (code.startsWith("W") ? "works" : code.startsWith("C") ? "current" : code.startsWith("S") ? "secure" : "agent-ready");

export interface AgentSettings {
  kernelApiKey: string;
  llm: { provider: Provider; model: string; apiKey: string };
  buyer: { email: string; password: string };
}

export interface WorksRunOptions {
  config: Config;
  repo: CertifierRepo;
  budget: RunBudget;
  store: {
    url: string;
    /** Private status key (store contract). */
    statusKey: string;
    /** Store webhook ID (extended contract). Without it, the replay path is not available. */
    webhookId?: string;
    /** Our demo stores also offer the demo-only fail-ack hook. */
    demoHooks?: boolean;
  };
  /** The certifier's own listener URL, to tell its deliveries apart from the store's. */
  certifierWebhookUrl?: string;
  /** Without it, a human approves the printed links. */
  agent?: AgentSettings;
  /**
   * The store's own sandbox app credentials (store contract item 5), for reading its orders,
   * refunding and resending events. Defaults to PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET.
   */
  paypalCredentials?: { clientId: string; clientSecret: string };
  /** Reuse the approved orders of an earlier run (development convenience). */
  resumeFrom?: string;
  /** Use an existing run row (the Run API creates it); otherwise one is created. */
  runId?: string;
  log?: (line: string) => void;
  paypalAudit?: (e: PaypalAuditEntry) => void;
}

export interface WorksRunResult {
  runId: string;
  status: "judged" | "stopped" | "failed";
  verdicts: Verdict[];
  error?: string;
}

export async function runWorksPillar(opts: WorksRunOptions): Promise<WorksRunResult> {
  const { config, repo, budget } = opts;
  const notes: Record<string, unknown> = {};
  const runLog: string[] = [];
  notes.log = runLog;
  const outer = opts.log ?? (() => {});
  // Every line is also kept with the run (capped), so a judge can replay what happened.
  const log = (line: string) => {
    const clean = redact(line, config);
    if (runLog.length < 600) runLog.push(`${new Date().toISOString().slice(11, 19)} ${clean}`);
    outer(clean);
  };
  const storeUrl = opts.store.url.replace(/\/+$/, "");
  const WAIT = config.WEBHOOK_WAIT_SECONDS;
  // Deliveries are requested only from this moment on (store contract: delivery log is per run).
  const RUN_STARTED = new Date();
  const verdicts: Verdict[] = [];
  let recording: Recording | undefined;

  const paypal = new SandboxPaypal(
    opts.paypalCredentials ? { ...config, PAYPAL_CLIENT_ID: opts.paypalCredentials.clientId, PAYPAL_CLIENT_SECRET: opts.paypalCredentials.clientSecret } : config,
    { audit: opts.paypalAudit },
  );
  const pp = async <T>(fn: () => Promise<T>): Promise<T> => {
    budget.spend();
    return fn();
  };

  // ------------------------------------------------------------ store client (contract)
  const keyHeader = { authorization: `Bearer ${opts.store.statusKey}` };
  const storeFetch = async (path: string, init: RequestInit = {}) => {
    budget.spend();
    return fetch(new URL(path, storeUrl), { ...init, signal: AbortSignal.timeout(20_000) });
  };
  const storeCreateOrder = async (sku: string): Promise<string> => {
    const res = await storeFetch("/api/orders", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sku, quantity: 1 }) });
    if (res.status !== 201) throw new Error(`store refused to create an order (HTTP ${res.status})`);
    return ((await res.json()) as { id: string }).id;
  };
  const storeArm = async (paypalOrderId: string, mock: TestHookCode): Promise<boolean> => {
    const res = await storeFetch(TEST_HOOK_PATH, {
      method: "POST",
      headers: { ...keyHeader, "content-type": "application/json" },
      body: JSON.stringify({ paypalOrderId, mock }),
    });
    return res.status === 204;
  };
  const storeStatus = async (paypalOrderId: string): Promise<StoreRecordSnap | undefined> => {
    const res = await storeFetch(statusPath(paypalOrderId), { headers: keyHeader });
    if (!res.ok) return undefined;
    const parsed = storeOrderStatus.safeParse(await res.json());
    return parsed.success ? parsed.data : undefined;
  };
  const storeDeliveryLog = async (eventId: string): Promise<StoreDelivery[] | undefined> => {
    const res = await storeFetch(deliveriesPath(eventId, RUN_STARTED), { headers: keyHeader });
    if (!res.ok) return undefined;
    const parsed = storeDeliveries.safeParse(await res.json());
    return parsed.success ? parsed.data.deliveries : undefined;
  };
  const toSigned = (e: Awaited<ReturnType<CertifierRepo["findSignedEvent"]>>): SignedEventSnap | undefined =>
    e
      ? { eventId: e.event_id, type: e.type, resourceId: e.resource_id ?? undefined, signatureValid: e.signature_valid, receivedAt: new Date(e.received_at).toISOString() }
      : undefined;
  const deliveryOf = async (eventId: string): Promise<DeliverySnap | undefined> => {
    try {
      return deliverySnap(await pp(() => paypal.getWebhookEvent(eventId)));
    } catch (err) {
      if (err instanceof PaypalCallError) return undefined;
      throw err;
    }
  };

  /** One recorded Kernel browser approves every order in turn. */
  const approveWithAgent = async (agent: AgentSettings, links: [string, string, string | undefined][]): Promise<Recording | undefined> => {
    let rec: Recording | undefined;
    let session = await openKernelSession(agent.kernelApiKey);
    const recordingsDir = join(findRepoRoot() ?? process.cwd(), "recordings");
    log(`AI buyer agent approving ${links.length} orders in Kernel browser ${session.sessionId} (recorded)…`);
    try {
      try {
        rendered = await measureStorefront(session.context, storeUrl);
        log(`Storefront measured: PayPal button ${rendered.paypalButton ? `at ${Math.round(rendered.paypalButton.top)}px` : "not found"}, Pay Later rendered: ${rendered.payLaterMessageRendered}, Venmo rendered: ${rendered.venmoButtonRendered}`);
      } catch {
        log("Storefront measurement failed; C3 will be inconclusive.");
      }
      let reopened = false;
      for (const [label, id, link] of links) {
        budget.check();
        if (!link) {
          log(`  ${label}: no approval link; skipped`);
          continue;
        }
        // Hard cap per order (20 steps normally take 1-4 minutes), so a frozen page can't stall the run.
        const journey = () =>
          withTimeout(
            runJourney({
            context: session.context,
            startUrl: link,
            mission: `This is a PayPal sandbox checkout page for order ${id}, which already exists. Log in as the buyer if asked, then approve and complete the payment. Reply done as soon as you are back on the store and it shows any final result, including "Payment not completed" (some of these orders are meant to fail).`,
            llm: agent.llm,
            buyer: agent.buyer,
            scrub: (t) => redact(t, config),
            maxSteps: 20,
            log: (line) => log(`  ${line.trim()}`),
            }),
            6 * 60_000,
          ).catch((err): Awaited<ReturnType<typeof runJourney>> => ({ outcome: "error", steps: [], paypalOrderIds: [], error: err instanceof Error ? err.message : "journey failed" }));
        let result = await journey();
        // A cloud browser that died mid-journey gets ONE fresh replacement for the rest of the run.
        if (result.outcome === "error" && /closed|disconnected|crashed|timed out/i.test(result.error ?? "") && !reopened) {
          reopened = true;
          budget.check();
          log(`  ${label}: the cloud browser closed (${result.error}); opening a fresh one and retrying this order once`);
          const old = await session.close(recordingsDir);
          if (old) log(`  Recording of the closed browser saved: replay ${old.replayId}`);
          session = await openKernelSession(agent.kernelApiKey);
          result = await journey();
        }
        log(`  ${label}: agent finished in ${result.steps.length} steps (${result.outcome}${result.error ? `: ${result.error.slice(0, 160)}` : ""}; the agent's own report, not evidence)`);
      }
    } finally {
      rec = await session.close(recordingsDir);
      log(rec ? `Recording saved: replay ${rec.replayId}` : "Recording: not available");
      notes.recording = rec ? { replayId: rec.replayId, file: rec.file ?? null } : null;
    }
    return rec;
  };

  let rendered: StorefrontObservation["rendered"];

  // ------------------------------------------------------------ the run
  const runId = opts.runId ?? (await repo.createRun({ storeUrl, budgetRequests: budget.maxRequests, timeLimitMin: config.RUN_MAX_MINUTES }));
  log(`Run ${runId} against ${storeUrl} (budget ${budget.maxRequests} requests, ${config.RUN_MAX_MINUTES} min)`);
  try {
    // Rule 3: no probe runs until the store serves its ownership token. Checked here as well as
    // in the Run API, so every entry point (CLI, benchmark, API) enforces it.
    if (!config.OWNERSHIP_TOKEN_SECRET) throw new Error("OWNERSHIP_TOKEN_SECRET is not set: cannot verify store ownership");
    const own = await verifyOwnership(storeUrl, deriveOwnershipToken(config.OWNERSHIP_TOKEN_SECRET, storeUrl));
    if (!own.verified) {
      log(`Ownership NOT verified (${own.reason}); no tests were run.`);
      await repo.finishRun(runId, "stopped", budget.used, { ...notes, stoppedBecause: "ownership not verified", detail: own.reason });
      return { runId, status: "stopped", verdicts, error: `ownership not verified: ${own.reason}` };
    }
    log(`Ownership verified via ${own.method}.`);
    await repo.setRunStatus(runId, "running");

    // 0. Read-only storefront scan (Current pillar and front-end Secure checks).
    const scan = await scanStorefront(`${storeUrl}/`, { spend: () => budget.spend() });
    log(`Storefront scanned: HTTP ${scan.status ?? "?"}, ${scan.files.length} public file(s)${scan.error ? ` (${scan.error})` : ""}`);
    const storeTarget = { url: storeUrl, statusKey: opts.store.statusKey };
    const probeDeps = { spend: () => budget.spend() };

    // 1. Three orders through the store's own checkout API (or an earlier run's orders).
    let A: string, B: string, C: string, hookB: boolean, hookC: boolean;
    if (opts.resumeFrom) {
      const prev = (await repo.getRunNotes(opts.resumeFrom)) as { orders?: { A: string; B: string; C: string }; hookB?: boolean; hookC?: boolean } | undefined;
      if (!prev?.orders) throw new Error(`run ${opts.resumeFrom} has no recorded orders to resume`);
      ({ A, B, C } = prev.orders);
      hookB = prev.hookB === true;
      hookC = prev.hookC === true;
      log(`Resuming the orders of run ${opts.resumeFrom}: A=${A} B=${B} C=${C}`);
    } else {
      A = await storeCreateOrder("MUG-01"); // W1, W4, W5, W6
      B = await storeCreateOrder("NOTE-01"); // W2 decline
      C = await storeCreateOrder("LAMP-01"); // W3 server error
      hookB = await storeArm(B, "INSTRUMENT_DECLINED");
      hookC = await storeArm(C, "INTERNAL_SERVER_ERROR");
      if (opts.store.demoHooks) {
        // Demo store only: answer the first refund delivery for A with an error so PayPal retries it.
        const fa = await storeFetch("/__demo/fail-ack", {
          method: "POST",
          headers: { ...keyHeader, "content-type": "application/json" },
          body: JSON.stringify({ paypalOrderId: A, eventType: "PAYMENT.CAPTURE.REFUNDED" }),
        });
        notes.failAck = fa.status === 204;
      }
    }
    Object.assign(notes, { orders: { A, B, C }, hookB, hookC, resumedFrom: opts.resumeFrom ?? null });

    // 2. Buyer approval. The agent's own "done" is not evidence; store and PayPal records are.
    if (!opts.resumeFrom) {
      const links: [string, string, string | undefined][] = [];
      for (const [label, id] of [["A (purchase, then refund)", A], ["B (will be declined)", B], ["C (server error)", C]] as const) {
        const order = await pp(() => paypal.getOrder(id));
        links.push([label, id, order.links?.find((l) => l.rel === "payer-action" || l.rel === "approve")?.href]);
      }
      if (opts.agent) {
        recording = await approveWithAgent(opts.agent, links);
      } else {
        log("Approve these three sandbox orders as the sandbox BUYER (any order, one browser tab each):");
        for (const [label, , link] of links) log(`  ${label}: ${link ?? "(no approval link returned)"}`);
      }
      log(`Waiting for the store to finish each checkout (up to ${config.RUN_MAX_MINUTES} min)…`);
      const settled = async (id: string) => {
        const s = await storeStatus(id);
        return s && s.status !== "created" && s.status !== "capturing" ? s : undefined;
      };
      // Bounded: if the buyer journey failed, the run still judges what it can (an unapproved
      // order is "inconclusive", never blamed on the store) instead of waiting out the time limit.
      const allSettled = await budget.waitFor(async () => ((await settled(A)) && (await settled(B)) && (await settled(C)) ? true : undefined), {
        seconds: opts.agent ? 180 : Math.min(config.RUN_MAX_MINUTES * 60, 900),
        everyMs: 5000,
      });
      if (!allSettled) log("Not every checkout finished; continuing so the checks that can be judged are judged.");
    }

    // 3. Order A: purchase, signed capture event, delivery to the store.
    const orderA = orderSnap(await pp(() => paypal.getOrder(A)));
    const storeA0 = await storeStatus(A);
    const capA = orderA.captures.find((c) => c.status === "COMPLETED")?.id;
    verdicts.push(judgeW1({ order: orderA, store: storeA0 }));

    let captureEvent: SignedEventSnap | undefined;
    let storeA1: StoreRecordSnap | undefined;
    if (capA) {
      log(`Waiting up to ${WAIT}s for PayPal's signed capture event…`);
      captureEvent = toSigned(await budget.waitFor(() => repo.findSignedEvent("PAYMENT.CAPTURE.COMPLETED", capA), { seconds: WAIT }));
      if (captureEvent) {
        const eid = captureEvent.eventId;
        storeA1 = await budget.waitFor(
          async () => {
            const s = await storeStatus(A);
            return s?.webhookEvents.some((e) => e.eventId === eid) ? s : undefined;
          },
          { seconds: WAIT },
        );
      }
    }
    const delivery1 = captureEvent ? await deliveryOf(captureEvent.eventId) : undefined;
    verdicts.push(judgeW5({ captureEvent, delivery: delivery1, certifierWebhookUrl: opts.certifierWebhookUrl, store: storeA1 ?? storeA0 }));

    // S4 Order replay: ask the store to capture order A a second time.
    if (capA) {
      const s4Before = (await storeStatus(A)) ?? storeA1 ?? storeA0;
      const s4 = await probeS4(storeTarget, probeDeps, A);
      const s4After = await storeStatus(A);
      verdicts.push(judgeS4({ secondCaptureHttpStatus: s4.secondCaptureHttpStatus, order: orderSnap(await pp(() => paypal.getOrder(A))), before: s4Before, after: s4After }));
    } else {
      verdicts.push(judgeS4({}));
    }

    // 4. W6 part 1 (no waiting): ask PayPal to re-send, then replay the store's own signed
    //    delivery byte for byte — only after verifying PayPal's signature on it ourselves.
    const duplicates: DuplicateDelivery[] = [];
    const dupNotes: string[] = [];
    const w6Before = storeA1;
    const storeWebhookId = opts.store.webhookId;
    if (captureEvent && storeA1) {
      const eid = captureEvent.eventId;
      if (storeWebhookId) {
        try {
          await pp(() => paypal.resendWebhookEvent(eid, [storeWebhookId]));
          dupNotes.push(`PayPal accepted a re-send request for ${eid}; any PayPal delivery is checked at the end of the run.`);
        } catch (err) {
          if (!(err instanceof PaypalCallError)) throw err;
          dupNotes.push(`PayPal refused to re-send ${eid}: ${err.message}`);
        }
      }
      const deliveryLog = storeWebhookId ? await storeDeliveryLog(eid) : undefined;
      const original = deliveryLog?.find((d) => d.responseStatus !== null && d.responseStatus >= 200 && d.responseStatus < 300) ?? deliveryLog?.[0];
      if (!original || !storeWebhookId) {
        dupNotes.push("Replay path not available: the store does not offer the optional extended contract (delivery log and store webhook ID). W6 relied on PayPal's resend only.");
      } else {
        const raw = Buffer.from(original.bodyBase64, "base64");
        const check = await verifyWebhook({ headers: webhookHeadersFrom(original.headers), rawBody: raw, webhookId: storeWebhookId });
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
          log(`Replayed the store's PayPal-signed delivery of ${eid}; store answered HTTP ${res.status}.`);
          duplicates.push({ eventId: eid, source: "certifier-replay", signatureVerified: true, transmissionId: original.transmissionId });
        }
      }
    }
    const storeA2 = (await storeStatus(A)) ?? storeA1;

    // 5. W4: refund A in PayPal; the store must learn it from the webhook.
    let refundEventId: string | undefined;
    const storeBeforeRefund = storeA2 ?? storeA1 ?? storeA0;
    let refundError: string | undefined;
    const refunded =
      capA && storeBeforeRefund?.status === "paid"
        ? await pp(() => paypal.refundCapture(capA)).catch((err: unknown) => {
            if (!(err instanceof PaypalCallError)) throw err;
            refundError = `PayPal refused the refund: ${err.message}`;
            return undefined;
          })
        : undefined;
    if (capA && refunded) {
      const refundId = refunded.refund.id!;
      const refundDone = await budget.waitFor(
        async () => {
          const r = await pp(() => paypal.getRefund(refundId));
          return r.status === "COMPLETED" || r.status === "FAILED" || r.status === "CANCELLED" ? r : undefined;
        },
        { seconds: 60 },
      );
      log(`Waiting up to ${WAIT}s for the signed refund event and the store's refund record…`);
      const refundEvent = toSigned(await budget.waitFor(() => repo.findSignedEvent("PAYMENT.CAPTURE.REFUNDED", refundId), { seconds: WAIT }));
      const storeA3 =
        (await budget.waitFor(
          async () => {
            const s = await storeStatus(A);
            return s?.status === "refunded" ? s : undefined;
          },
          { seconds: refundEvent ? 30 : 5 },
        )) ?? (await storeStatus(A));
      verdicts.push(judgeW4({ refund: refundSnap(refundDone ?? refunded.refund), refundEvent, store: storeA3 }));
      refundEventId = refundEvent?.eventId;
    } else {
      verdicts.push(
        judgeW4({ refundError: refundError ?? (storeBeforeRefund ? `Order A is "${storeBeforeRefund.status}" in the store, not "paid", so it was not refunded.` : undefined) }),
      );
    }

    // 6. W2 / W3: forced errors on the store's own capture.
    verdicts.push(judgeW2({ hookSupported: hookB, order: orderSnap(await pp(() => paypal.getOrder(B))), store: await storeStatus(B) }));
    verdicts.push(judgeW3({ hookSupported: hookC, order: orderSnap(await pp(() => paypal.getOrder(C))), store: await storeStatus(C) }));

    // 7. W6 part 2 (no waiting): any delivery with a NEW transmission ID that verifies as
    //    PayPal-signed came from PayPal (a replay can only reuse the original transmission ID).
    if (storeWebhookId) {
      for (const eid of [captureEvent?.eventId, refundEventId]) {
        if (!eid) continue;
        const deliveryLog = (await storeDeliveryLog(eid)) ?? [];
        const firstTx = deliveryLog[0]?.transmissionId;
        for (const d of deliveryLog) {
          if (d.transmissionId === firstTx || duplicates.some((x) => x.source === "paypal" && x.transmissionId === d.transmissionId)) continue;
          const check = await verifyWebhook({ headers: webhookHeadersFrom(d.headers), rawBody: Buffer.from(d.bodyBase64, "base64"), webhookId: storeWebhookId });
          if (check.valid) duplicates.push({ eventId: eid, source: "paypal", signatureVerified: true, transmissionId: d.transmissionId });
        }
      }
    }
    const w6After = await storeStatus(A);
    verdicts.push(judgeW6({ duplicates, before: w6Before, after: w6After, notes: dupNotes }));
    verdicts.push(judgeS3({ duplicates, before: w6Before, after: w6After, notes: dupNotes }));

    // S1 Price tampering: the most expensive item, every common price field set to 1.00.
    const items = await storeCatalog(storeTarget, probeDeps);
    const priciest = [...items].sort((a, b) => Number(b.price) - Number(a.price))[0];
    if (priciest) {
      const s1 = await probeS1(storeTarget, probeDeps, priciest);
      const s1Order = s1.id ? orderSnap(await pp(() => paypal.getOrder(s1.id!))) : undefined;
      verdicts.push(
        judgeS1({ serverPrice: { currencyCode: priciest.currency, value: priciest.price }, tamperedValue: s1.tamperedValue, tamperedFields: s1.tamperedFields, order: s1Order, storeRejected: s1.rejected }),
      );
    } else {
      verdicts.push(judgeS1({ tamperedValue: "1.00", tamperedFields: [] }));
    }

    // S2 Forged webhook: an unsigned "payment completed" for a fresh, unpaid order.
    const s2Item = items[0];
    const s2Created = s2Item ? await storeCreateRaw(storeTarget, probeDeps, { sku: s2Item.sku, quantity: 1 }) : undefined;
    if (s2Created?.id && s2Item) {
      const s2Before = await storeStatus(s2Created.id);
      const s2 = await probeS2(storeTarget, probeDeps, s2Created.id, { currencyCode: s2Item.currency, value: s2Item.price });
      await new Promise((r) => setTimeout(r, 1500));
      const s2After = await storeStatus(s2Created.id);
      verdicts.push(judgeS2({ ...s2, before: s2Before, after: s2After, order: orderSnap(await pp(() => paypal.getOrder(s2Created.id!))) }));
    } else {
      verdicts.push(judgeS2({ sent: false }));
    }

    // S7 Retry safety: the store's test hook makes its next checkout retry order creation.
    if (s2Item) {
      const s7 = await probeS7(storeTarget, probeDeps, s2Item);
      const resolved = [];
      for (const id of [...new Set(s7.hookSupported ? (s7.createAttempts ?? []) : [])]) {
        try {
          resolved.push(orderSnap(await pp(() => paypal.getOrder(id))));
        } catch (err) {
          if (!(err instanceof PaypalCallError)) throw err;
        }
      }
      verdicts.push(judgeS7({ hookSupported: s7.hookSupported, createAttempts: s7.hookSupported ? s7.createAttempts : undefined, resolved }));
    } else {
      verdicts.push(judgeS7({ hookSupported: false }));
    }

    // Page-level checks from the scan (and the browser measurement, when there was one).
    const page: StorefrontObservation = { ...observe(scan), rendered };
    const scanned = scan.files.map((x) => x.url);
    verdicts.push(judgeC1(page), judgeC2(page), judgeC3(page), judgeC4({ configured: false, url: page.url }), judgeC5(page));
    verdicts.push(judgeS5({ scanned, findings: findSecrets(scan.files) }));
    verdicts.push(judgeS6({ scanned, liveHostHits: findLiveHosts(scan.files), sandboxOrderId: orderA.id || undefined, sandboxOrderResolved: orderA.id ? true : undefined }));
    verdicts.push(judgeS8({ url: `${storeUrl}/`, status: scan.status, csp: scan.headers["content-security-policy"], hsts: scan.headers["strict-transport-security"] }));

    // Agent-ready checks on the store itself. A4: the price agents read (Schema.org JSON-LD) vs
    // what PayPal recorded for the line items of the orders we placed (A, B, C exist at PayPal
    // whether or not they were approved). A5: accessible names of the store's own controls.
    const charged = [];
    for (const id of [A, B, C]) {
      try {
        charged.push(...chargedItems(await pp(() => paypal.getOrder(id))));
      } catch (err) {
        if (!(err instanceof PaypalCallError)) throw err;
      }
    }
    verdicts.push(judgeA4({ url: page.url, fetched: page.fetched, offers: structuredOffers(scan.html), charged }));
    verdicts.push(judgeA5({ url: page.url, controls: rendered?.controls }));

    // The recording shows the buyer approvals behind W1–W4. It is our own record, labelled as such.
    if (recording) {
      for (const v of verdicts) {
        if (["W1", "W2", "W3", "W4"].includes(v.check)) {
          v.evidence.push({ kind: "video", id: recording.replayId, strength: "certifier-recorded", note: "Kernel recording of the AI buyer approving the orders" });
        }
      }
    }

    const order = ["works", "current", "secure", "agent-ready"];
    verdicts.sort((a, b) => order.indexOf(pillarOf(a.check)) - order.indexOf(pillarOf(b.check)) || a.check.localeCompare(b.check));
    for (const v of verdicts) await repo.saveVerdict(runId, pillarOf(v.check), v);
    await repo.finishRun(runId, "judged", budget.used, notes);
    return { runId, status: "judged", verdicts };
  } catch (err) {
    const status = err instanceof RunStopped ? "stopped" : "failed";
    const message = err instanceof Error ? redact(err.message, config) : "unknown error";
    await repo.finishRun(runId, status, budget.used, { ...notes, error: message }).catch(() => {});
    return { runId, status, verdicts, error: message };
  }
}
