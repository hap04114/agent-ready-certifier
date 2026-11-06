import { randomUUID } from "node:crypto";
import { ApiError, CheckoutPaymentIntent, Client, Environment, OrdersController, type Order } from "@paypal/paypal-server-sdk";
import { ConfigError, SANDBOX_API_BASE, redact, requireConfig, type Config } from "@certifier/config";

/** Negative-testing codes we use (PayPal-Mock-Response header). Sandbox only. */
export type MockCode = "INSTRUMENT_DECLINED" | "INTERNAL_SERVER_ERROR" | (string & {});

/** One audit-log line per PayPal call. Holds IDs and outcomes only: never headers, tokens or bodies. */
export interface PaypalAuditEntry {
  at: string;
  operation: "orders.create" | "orders.get" | "orders.capture";
  requestId?: string;
  mock?: MockCode;
  ok: boolean;
  statusCode?: number;
  orderId?: string;
  orderStatus?: string;
  captureIds?: string[];
  debugId?: string;
  issues?: string[];
  durationMs: number;
}
export type AuditSink = (entry: PaypalAuditEntry) => void;

/** A PayPal call failed. Carries only safe fields: status, debug ID and PayPal issue names. */
export class PaypalCallError extends Error {
  constructor(
    readonly operation: PaypalAuditEntry["operation"],
    readonly statusCode: number | undefined,
    readonly debugId: string | undefined,
    readonly issues: string[],
  ) {
    super(`PayPal ${operation} failed${statusCode ? ` with HTTP ${statusCode}` : ""}${issues.length ? `: ${issues.join(", ")}` : ""}${debugId ? ` (debug id ${debugId})` : ""}`);
    this.name = "PaypalCallError";
  }
}

/** The subset of the SDK's OrdersController we use. Lets tests run without network. */
export type OrdersApi = Pick<OrdersController, "createOrder" | "getOrder" | "captureOrder">;

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
  /** Reuse a request ID only to test idempotency (S7). Otherwise one is generated. */
  requestId?: string;
  mock?: MockCode;
}

export interface CallOptions {
  requestId?: string;
  mock?: MockCode;
}

export interface SandboxPaypalOptions {
  audit?: AuditSink;
  /** Inject a fake for tests. Production code lets this default to the real SDK. */
  orders?: OrdersApi;
  timeoutMs?: number;
}

const mockHeader = (code: MockCode | undefined) =>
  code === undefined ? undefined : JSON.stringify({ mock_application_codes: code });

/**
 * The only way this codebase talks to PayPal.
 * - Sandbox is hard-coded: the SDK is constructed with Environment.Sandbox, and the
 *   config must also say sandbox, or construction fails.
 * - Every create and capture sends a PayPal-Request-Id.
 * - Every call is written to the audit sink without secrets.
 */
export class SandboxPaypal {
  private readonly orders: OrdersApi;
  private readonly audit: AuditSink;

  constructor(
    private readonly config: Config,
    options: SandboxPaypalOptions = {},
  ) {
    if (config.PAYPAL_ENV !== "sandbox" || config.PAYPAL_API_BASE !== SANDBOX_API_BASE) {
      throw new ConfigError("Refusing to create a PayPal client.", ["PayPal client is sandbox-only"]);
    }
    this.audit = options.audit ?? (() => {});
    if (options.orders) {
      this.orders = options.orders;
    } else {
      const creds = requireConfig(config, "the PayPal client", ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET"]);
      const client = new Client({
        environment: Environment.Sandbox,
        timeout: options.timeoutMs ?? 30_000,
        clientCredentialsAuthCredentials: {
          oAuthClientId: creds.PAYPAL_CLIENT_ID,
          oAuthClientSecret: creds.PAYPAL_CLIENT_SECRET,
        },
      });
      this.orders = new OrdersController(client);
    }
  }

  async createOrder(input: CreateOrderInput): Promise<{ order: Order; requestId: string }> {
    const requestId = input.requestId ?? randomUUID();
    const order = await this.call("orders.create", { requestId, mock: input.mock }, async () => {
      const res = await this.orders.createOrder({
        paypalRequestId: requestId,
        paypalMockResponse: mockHeader(input.mock),
        prefer: "return=representation",
        body: {
          intent: CheckoutPaymentIntent.Capture,
          purchaseUnits: [
            {
              referenceId: input.referenceId,
              amount: {
                currencyCode: input.amount.currencyCode,
                value: input.amount.value,
                breakdown: input.items ? { itemTotal: input.amount } : undefined,
              },
              items: input.items?.map((i) => ({ name: i.name, sku: i.sku, quantity: String(i.quantity), unitAmount: i.unitAmount })),
            },
          ],
        },
      });
      return res.result;
    });
    return { order, requestId };
  }

  /** GET is naturally idempotent; the SDK's getOrder takes no PayPal-Request-Id. */
  async getOrder(id: string, options: Pick<CallOptions, "mock"> = {}): Promise<Order> {
    return this.call("orders.get", { mock: options.mock }, async () => {
      const res = await this.orders.getOrder({ id, paypalMockResponse: mockHeader(options.mock) });
      return res.result;
    });
  }

  async captureOrder(id: string, options: CallOptions = {}): Promise<{ order: Order; requestId: string }> {
    const requestId = options.requestId ?? randomUUID();
    const order = await this.call("orders.capture", { requestId, mock: options.mock }, async () => {
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

  private async call(
    operation: PaypalAuditEntry["operation"],
    meta: { requestId?: string; mock?: MockCode },
    fn: () => Promise<Order>,
  ): Promise<Order> {
    const started = Date.now();
    const base = { at: new Date(started).toISOString(), operation, ...meta };
    try {
      const order = await fn();
      this.audit({
        ...base,
        ok: true,
        orderId: order.id,
        orderStatus: order.status,
        captureIds: captureIdsOf(order),
        durationMs: Date.now() - started,
      });
      return order;
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

export function captureIdsOf(order: Order): string[] {
  return (order.purchaseUnits ?? []).flatMap((pu) => (pu.payments?.captures ?? []).map((c) => c.id).filter((id): id is string => !!id));
}

/**
 * Convert any SDK error into a PaypalCallError. The SDK's ApiError holds the original
 * request (including the Authorization header), so it must never be logged or rethrown.
 */
export function toSafeError(operation: PaypalAuditEntry["operation"], err: unknown, config: Config): PaypalCallError {
  if (err instanceof ApiError) {
    const headers = Object.fromEntries(Object.entries(err.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const result = (err.result ?? {}) as { name?: string; details?: { issue?: string }[]; debug_id?: string; debugId?: string };
    const issues = [result.name, ...(result.details ?? []).map((d) => d.issue)]
      .filter((x): x is string => typeof x === "string")
      .map((x) => redact(x, config));
    return new PaypalCallError(operation, err.statusCode, headers["paypal-debug-id"] ?? result.debug_id ?? result.debugId, issues);
  }
  // Network failures, timeouts and anything else: keep the error kind, drop the details.
  const kind = err instanceof Error ? err.name : "UnknownError";
  return new PaypalCallError(operation, undefined, undefined, [kind]);
}
