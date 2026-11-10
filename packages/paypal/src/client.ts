import { randomUUID } from "node:crypto";
import {
  ApiError,
  type CapturedPayment,
  CheckoutPaymentIntent,
  Client,
  Environment,
  type OAuthToken,
  type Order,
  OrdersController,
  PaymentsController,
  VaultController,
  type Refund,
} from "@paypal/paypal-server-sdk";
import { ConfigError, SANDBOX_API_BASE, redact, requireConfig, type Config } from "@certifier/config";

/** Negative-testing codes we use (PayPal-Mock-Response header). Sandbox only. */
export type MockCode = "INSTRUMENT_DECLINED" | "INTERNAL_SERVER_ERROR" | (string & {});

export type PaypalOperation =
  | "orders.create"
  | "orders.get"
  | "orders.capture"
  | "payments.getCapture"
  | "payments.refund"
  | "payments.getRefund"
  | "webhooks.getEvent"
  | "webhooks.resendEvent"
  | "webhooks.list"
  | "vault.createSetupToken"
  | "vault.createPaymentToken"
  | "webhooks.create";

/**
 * One audit-log line per PayPal call. IDs and outcomes only: never headers, tokens or bodies.
 * Writes carry `requestId` (the PayPal-Request-Id sent to PayPal). Every call, read or write,
 * carries a `correlationId` that exists only in our own logs.
 */
export interface PaypalAuditEntry {
  at: string;
  operation: PaypalOperation;
  correlationId: string;
  requestId?: string;
  mock?: MockCode;
  ok: boolean;
  statusCode?: number;
  /** The main PayPal ID the call returned (order, capture, refund or event). */
  resourceId?: string;
  resourceStatus?: string;
  captureIds?: string[];
  debugId?: string;
  issues?: string[];
  durationMs: number;
}
export type AuditSink = (entry: PaypalAuditEntry) => void;

/** A PayPal call failed. Carries only safe fields: status, debug ID and PayPal issue names. */
export class PaypalCallError extends Error {
  constructor(
    readonly operation: PaypalOperation,
    readonly statusCode: number | undefined,
    readonly debugId: string | undefined,
    readonly issues: string[],
  ) {
    super(
      `PayPal ${operation} failed${statusCode ? ` with HTTP ${statusCode}` : ""}${issues.length ? `: ${issues.join(", ")}` : ""}${debugId ? ` (debug id ${debugId})` : ""}`,
    );
    this.name = "PaypalCallError";
  }
}

/** Subsets of the SDK controllers we use. Lets tests run without network. */
export type OrdersApi = Pick<OrdersController, "createOrder" | "getOrder" | "captureOrder">;
export type PaymentsApi = Pick<PaymentsController, "getCapturedPayment" | "refundCapturedPayment" | "getRefund">;
export type VaultApi = Pick<VaultController, "createSetupToken" | "createPaymentToken">;

/**
 * Raw REST for the Notifications API, which the Server SDK does not cover.
 * `path` must start with /v1/notifications/. The host is always the sandbox.
 */
export type RestCall = (
  method: "GET" | "POST",
  path: string,
  options: { body?: unknown; requestId?: string },
) => Promise<{ status: number; headers: Record<string, string>; json: unknown }>;

export interface Money {
  currencyCode: string;
  /** Decimal string, e.g. "24.00". */
  value: string;
}

export interface CreateOrderInput {
  amount: Money;
  items?: { name: string; sku?: string; quantity: number; unitAmount: Money }[];
  /** The store's own order or cart reference. */
  referenceId?: string;
  /** Where PayPal sends the buyer after approving via a link (not used by the popup flow). */
  returnUrl?: string;
  cancelUrl?: string;
  /** Reuse a request ID only to test idempotency (S7) or to retry safely. Otherwise generated. */
  requestId?: string;
  mock?: MockCode;
  /** Pay from the buyer's saved PayPal wallet (vault payment token): no approval popup. */
  vaultId?: string;
  /** Send the money to another sandbox merchant (used only by the A3 lookalike trap). */
  payeeEmail?: string;
}

export interface CallOptions {
  requestId?: string;
  mock?: MockCode;
}

/** A webhook event as returned by GET /v1/notifications/webhooks-events/{id}. Only fields we read. */
export interface WebhookEventDetail {
  id: string;
  event_type?: string;
  resource_type?: string;
  create_time?: string;
  resource?: { id?: string; status?: string } & Record<string, unknown>;
  transmissions?: { webhook_url?: string; http_status?: number; status?: string; transmission_id?: string; time?: string }[];
}

export interface SandboxPaypalOptions {
  audit?: AuditSink;
  /** Inject fakes for tests. Production code lets these default to the real SDK / REST. */
  orders?: OrdersApi;
  payments?: PaymentsApi;
  vault?: VaultApi;
  rest?: RestCall;
  timeoutMs?: number;
}

const mockHeader = (code: MockCode | undefined) =>
  code === undefined ? undefined : JSON.stringify({ mock_application_codes: code });

/**
 * The only way this codebase talks to PayPal.
 * - Sandbox is hard-coded: the SDK is constructed with Environment.Sandbox, REST calls use
 *   SANDBOX_API_BASE, and the config must also say sandbox, or construction fails.
 * - Every write (create, capture, refund, resend) sends a PayPal-Request-Id.
 * - Every call is written to the audit sink without secrets.
 */
export class SandboxPaypal {
  private readonly orders: OrdersApi;
  private readonly payments: PaymentsApi;
  private readonly vault: VaultApi;
  private readonly rest: RestCall;
  private readonly audit: AuditSink;

  constructor(
    private readonly config: Config,
    options: SandboxPaypalOptions = {},
  ) {
    if (config.PAYPAL_ENV !== "sandbox" || config.PAYPAL_API_BASE !== SANDBOX_API_BASE) {
      throw new ConfigError("Refusing to create a PayPal client.", ["PayPal client is sandbox-only"]);
    }
    this.audit = options.audit ?? (() => {});

    let client: Client | undefined;
    const sdk = () => {
      if (!client) {
        const creds = requireConfig(config, "the PayPal client", ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET"]);
        client = new Client({
          environment: Environment.Sandbox,
          timeout: options.timeoutMs ?? 30_000,
          clientCredentialsAuthCredentials: {
            oAuthClientId: creds.PAYPAL_CLIENT_ID,
            oAuthClientSecret: creds.PAYPAL_CLIENT_SECRET,
          },
        });
      }
      return client;
    };
    // Fail fast on missing credentials unless every dependency is injected.
    if (!options.orders || !options.payments || !options.rest || !options.vault) sdk();

    this.orders = options.orders ?? new OrdersController(sdk());
    this.payments = options.payments ?? new PaymentsController(sdk());
    this.vault = options.vault ?? new VaultController(sdk());
    this.rest = options.rest ?? sandboxRest(sdk, options.timeoutMs ?? 30_000);
  }

  async createOrder(input: CreateOrderInput): Promise<{ order: Order; requestId: string }> {
    const requestId = input.requestId ?? randomUUID();
    const order = await this.call("orders.create", { requestId, mock: input.mock }, summarizeOrder, async () => {
      const res = await this.orders.createOrder({
        paypalRequestId: requestId,
        paypalMockResponse: mockHeader(input.mock),
        prefer: "return=representation",
        body: {
          intent: CheckoutPaymentIntent.Capture,
          purchaseUnits: [
            {
              referenceId: input.referenceId,
              payee: input.payeeEmail ? { emailAddress: input.payeeEmail } : undefined,
              amount: {
                currencyCode: input.amount.currencyCode,
                value: input.amount.value,
                breakdown: input.items ? { itemTotal: input.amount } : undefined,
              },
              items: input.items?.map((i) => ({ name: i.name, sku: i.sku, quantity: String(i.quantity), unitAmount: i.unitAmount })),
            },
          ],
          paymentSource: input.vaultId
            ? { paypal: { vaultId: input.vaultId } }
            : input.returnUrl || input.cancelUrl
              ? { paypal: { experienceContext: { returnUrl: input.returnUrl, cancelUrl: input.cancelUrl } } }
              : undefined,
        },
      });
      return res.result;
    });
    return { order, requestId };
  }

  /** Reads are naturally idempotent and carry no PayPal-Request-Id (correlation ID in logs only). */
  async getOrder(id: string, options: Pick<CallOptions, "mock"> = {}): Promise<Order> {
    return this.call("orders.get", { mock: options.mock }, summarizeOrder, async () => {
      const res = await this.orders.getOrder({ id, paypalMockResponse: mockHeader(options.mock) });
      return res.result;
    });
  }

  async captureOrder(id: string, options: CallOptions = {}): Promise<{ order: Order; requestId: string }> {
    const requestId = options.requestId ?? randomUUID();
    const order = await this.call("orders.capture", { requestId, mock: options.mock }, summarizeOrder, async () => {
      const res = await this.orders.captureOrder({
        id,
        paypalRequestId: requestId,
        paypalMockResponse: mockHeader(options.mock),
        prefer: "return=representation",
      });
      return res.result;
    });
    return { order, requestId };
  }

  async getCapture(captureId: string): Promise<CapturedPayment> {
    return this.call("payments.getCapture", {}, summarizeSimple, async () => {
      const res = await this.payments.getCapturedPayment({ captureId });
      return res.result;
    });
  }

  /** Full refund of a capture (or partial when `amount` is given). */
  async refundCapture(captureId: string, options: CallOptions & { amount?: Money } = {}): Promise<{ refund: Refund; requestId: string }> {
    const requestId = options.requestId ?? randomUUID();
    const refund = await this.call("payments.refund", { requestId, mock: options.mock }, summarizeSimple, async () => {
      const res = await this.payments.refundCapturedPayment({
        captureId,
        paypalRequestId: requestId,
        paypalMockResponse: mockHeader(options.mock),
        prefer: "return=representation",
        body: options.amount ? { amount: options.amount } : {},
      });
      return res.result;
    });
    return { refund, requestId };
  }

  async getRefund(refundId: string): Promise<Refund> {
    return this.call("payments.getRefund", {}, summarizeSimple, async () => {
      const res = await this.payments.getRefund({ refundId });
      return res.result;
    });
  }

  /** Event detail, including delivery attempts per webhook URL when PayPal reports them. */
  async getWebhookEvent(eventId: string): Promise<WebhookEventDetail> {
    return this.call("webhooks.getEvent", {}, (e) => ({ resourceId: e.id, resourceStatus: e.event_type }), async () => {
      const res = await this.rest("GET", `/v1/notifications/webhooks-events/${encodeURIComponent(eventId)}`, {});
      return res.json as WebhookEventDetail;
    });
  }

  /**
   * Start saving the buyer's PayPal wallet (vault). Returns the setup token and the link the
   * buyer opens once to approve. Needs "Save payment methods" enabled on the sandbox app.
   */
  async createVaultSetupToken(urls: { returnUrl: string; cancelUrl: string }): Promise<{ id: string; approveUrl?: string; status?: string }> {
    const requestId = randomUUID();
    return this.call("vault.createSetupToken", { requestId }, (t) => ({ resourceId: t.id, resourceStatus: t.status }), async () => {
      const res = await this.vault.createSetupToken({
        paypalRequestId: requestId,
        body: {
          paymentSource: {
            paypal: {
              usageType: "MERCHANT" as never,
              usagePattern: "IMMEDIATE" as never,
              experienceContext: { returnUrl: urls.returnUrl, cancelUrl: urls.cancelUrl },
            },
          },
        },
      });
      const r = res.result;
      return { id: r.id ?? "", status: r.status, approveUrl: r.links?.find((l) => l.rel === "approve")?.href };
    });
  }

  /** Turn an approved setup token into a reusable payment token (the vault ID). */
  async createVaultPaymentToken(setupTokenId: string): Promise<{ id: string }> {
    const requestId = randomUUID();
    return this.call("vault.createPaymentToken", { requestId }, (t) => ({ resourceId: t.id }), async () => {
      const res = await this.vault.createPaymentToken({
        paypalRequestId: requestId,
        body: { paymentSource: { token: { id: setupTokenId, type: "SETUP_TOKEN" as never } } },
      });
      return { id: res.result.id ?? "" };
    });
  }

  /** The app's webhook subscriptions (ID and URL), for wiring IDs into config. */
  async listWebhooks(): Promise<{ id: string; url: string }[]> {
    return this.call("webhooks.list", {}, () => ({}), async () => {
      const res = await this.rest("GET", "/v1/notifications/webhooks", {});
      const hooks = (res.json as { webhooks?: { id?: string; url?: string }[] }).webhooks ?? [];
      return hooks.filter((h) => h.id && h.url).map((h) => ({ id: h.id!, url: h.url! }));
    });
  }

  /** Register a webhook URL on this app for the given event types. Returns PayPal's webhook ID. */
  async createWebhook(url: string, eventTypes: string[]): Promise<{ id: string }> {
    const requestId = randomUUID();
    return this.call("webhooks.create", { requestId }, (w) => ({ resourceId: w.id }), async () => {
      const res = await this.rest("POST", "/v1/notifications/webhooks", {
        body: { url, event_types: eventTypes.map((name) => ({ name })) },
        requestId,
      });
      const id = (res.json as { id?: string }).id;
      if (!id) throw new Error("PayPal returned no webhook ID");
      return { id };
    });
  }

  /** Ask PayPal to deliver an event again (a genuine, signed duplicate delivery for W6 / S3). */
  async resendWebhookEvent(eventId: string, webhookIds: string[]): Promise<{ requestId: string }> {
    const requestId = randomUUID();
    await this.call("webhooks.resendEvent", { requestId }, () => ({ resourceId: eventId }), async () => {
      const res = await this.rest("POST", `/v1/notifications/webhooks-events/${encodeURIComponent(eventId)}/resend`, {
        body: { webhook_ids: webhookIds },
        requestId,
      });
      return res.json;
    });
    return { requestId };
  }

  private async call<T>(
    operation: PaypalOperation,
    meta: { requestId?: string; mock?: MockCode },
    summarize: (result: T) => Pick<PaypalAuditEntry, "resourceId" | "resourceStatus" | "captureIds">,
    fn: () => Promise<T>,
  ): Promise<T> {
    const started = Date.now();
    const base = { at: new Date(started).toISOString(), operation, correlationId: randomUUID(), ...meta };
    try {
      const result = await fn();
      this.audit({ ...base, ok: true, ...summarize(result), durationMs: Date.now() - started });
      return result;
    } catch (err) {
      const safe = toSafeError(operation, err, this.config);
      this.audit({
        ...base,
        ok: false,
        statusCode: safe.statusCode,
        debugId: safe.debugId,
        issues: safe.issues,
        durationMs: Date.now() - started,
      });
      throw safe;
    }
  }
}

const summarizeOrder = (order: Order) => ({ resourceId: order.id, resourceStatus: order.status, captureIds: captureIdsOf(order) });
const summarizeSimple = (r: { id?: string; status?: string }) => ({ resourceId: r.id, resourceStatus: r.status });

export function captureIdsOf(order: Order): string[] {
  return (order.purchaseUnits ?? []).flatMap((pu) => (pu.payments?.captures ?? []).map((c) => c.id).filter((id): id is string => !!id));
}

/** Thrown by sandboxRest for non-2xx responses; converted to PaypalCallError by toSafeError. */
class RestError extends Error {
  constructor(
    readonly statusCode: number,
    readonly headers: Record<string, string>,
    readonly body: unknown,
  ) {
    super(`HTTP ${statusCode}`);
  }
}

/** REST helper for endpoints the SDK lacks. Sandbox host only; reuses the SDK's OAuth token. */
function sandboxRest(sdk: () => Client, timeoutMs: number): RestCall {
  let token: OAuthToken | undefined;
  return async (method, path, options) => {
    if (!path.startsWith("/v1/notifications/")) throw new Error("sandboxRest only serves the Notifications API");
    const manager = sdk().clientCredentialsAuthManager;
    if (!token || !manager.isValid(token) || manager.isExpired(token)) token = await manager.updateToken();
    const headers: Record<string, string> = {
      authorization: `Bearer ${token.accessToken}`,
      "content-type": "application/json",
    };
    if (options.requestId) headers["paypal-request-id"] = options.requestId;
    const res = await fetch(`${SANDBOX_API_BASE}${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    const json: unknown = text ? JSON.parse(text) : undefined;
    const outHeaders = Object.fromEntries(res.headers.entries());
    if (!res.ok) throw new RestError(res.status, outHeaders, json);
    return { status: res.status, headers: outHeaders, json };
  };
}

/**
 * Convert any SDK or REST error into a PaypalCallError. The SDK's ApiError holds the original
 * request (including the Authorization header), so it must never be logged or rethrown.
 */
export function toSafeError(operation: PaypalOperation, err: unknown, config: Config): PaypalCallError {
  if (err instanceof ApiError || err instanceof RestError) {
    const headers = Object.fromEntries(Object.entries(err.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const body = (err instanceof ApiError ? err.result : err.body) ?? {};
    const result = body as { name?: string; details?: { issue?: string }[]; debug_id?: string; debugId?: string };
    const issues = [result.name, ...(result.details ?? []).map((d) => d.issue)]
      .filter((x): x is string => typeof x === "string")
      .map((x) => redact(x, config));
    return new PaypalCallError(operation, err.statusCode, headers["paypal-debug-id"] ?? result.debug_id ?? result.debugId, issues);
  }
  // Network failures, timeouts and anything else: keep the error kind, drop the details.
  const kind = err instanceof Error ? err.name : "UnknownError";
  return new PaypalCallError(operation, undefined, undefined, [kind]);
}
