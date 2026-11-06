/**
 * demo-store-good persistence (Postgres schema `demo_store_good`).
 * The store is a separate merchant system, so it keeps its own schema.
 */
import { type Db, type Migration, migrate } from "@certifier/db";
import type { StoreOrderStatus, TestHookCode } from "@certifier/contract";
import { centsToValue } from "./catalog.js";

export const SCHEMA = "demo_store_good";

export const MIGRATIONS: Migration[] = [
  {
    id: "001_orders_and_webhooks",
    sql: `
      CREATE TABLE orders (
        paypal_order_id   text PRIMARY KEY,
        sku               text NOT NULL,
        quantity          int  NOT NULL CHECK (quantity > 0),
        amount_cents      int  NOT NULL CHECK (amount_cents >= 0),
        currency          text NOT NULL,
        status            text NOT NULL CHECK (status IN ('created','capturing','paid','capture_failed','refunded')),
        capture_id        text,
        capture_request_id text,
        refund_id         text,
        fulfilment_count  int  NOT NULL DEFAULT 0,
        armed_mock        text,
        created_at        timestamptz NOT NULL DEFAULT now(),
        updated_at        timestamptz NOT NULL DEFAULT now(),
        paid_at           timestamptz,
        refunded_at       timestamptz
      );
      CREATE UNIQUE INDEX orders_capture_id ON orders (capture_id) WHERE capture_id IS NOT NULL;

      CREATE TABLE webhook_events (
        event_id          text PRIMARY KEY,
        type              text NOT NULL,
        resource_id       text,
        paypal_order_id   text,
        deliveries        int  NOT NULL DEFAULT 1,
        processed         int  NOT NULL DEFAULT 0,
        first_received_at timestamptz NOT NULL DEFAULT now(),
        last_received_at  timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX webhook_events_order ON webhook_events (paypal_order_id);
    `,
  },
];

export const migrateStore = (db: Db) => migrate(db, SCHEMA, MIGRATIONS);

export interface OrderRow {
  paypal_order_id: string;
  sku: string;
  quantity: number;
  amount_cents: number;
  currency: string;
  status: "created" | "capturing" | "paid" | "capture_failed" | "refunded";
  capture_id: string | null;
  capture_request_id: string | null;
  refund_id: string | null;
  fulfilment_count: number;
  armed_mock: TestHookCode | null;
  updated_at: Date | string;
}

const T = `${SCHEMA}.orders`;
const W = `${SCHEMA}.webhook_events`;

export function storeRepo(db: Db) {
  return {
    async insertOrder(o: { paypalOrderId: string; sku: string; quantity: number; amountCents: number; currency: string }) {
      await db.query(`INSERT INTO ${T} (paypal_order_id, sku, quantity, amount_cents, currency, status) VALUES ($1,$2,$3,$4,$5,'created')`, [
        o.paypalOrderId,
        o.sku,
        o.quantity,
        o.amountCents,
        o.currency,
      ]);
    },

    async getOrder(id: string): Promise<OrderRow | undefined> {
      return (await db.query<OrderRow>(`SELECT * FROM ${T} WHERE paypal_order_id = $1`, [id])).rows[0];
    },

    async findByCapture(captureId: string): Promise<OrderRow | undefined> {
      return (await db.query<OrderRow>(`SELECT * FROM ${T} WHERE capture_id = $1`, [captureId])).rows[0];
    },

    /**
     * Atomically claim an order for capture and consume any armed test-hook code.
     * Returns undefined if the order is not in a capturable state.
     */
    async claimForCapture(id: string, requestId: string): Promise<{ row: OrderRow; mock: TestHookCode | null } | undefined> {
      return db.transaction(async (tx) => {
        const row = (await tx.query<OrderRow>(`SELECT * FROM ${T} WHERE paypal_order_id = $1 FOR UPDATE`, [id])).rows[0];
        if (!row || (row.status !== "created" && row.status !== "capture_failed")) return undefined;
        // Reuse the request ID of an earlier attempt so a retry can never capture twice.
        const reqId = row.capture_request_id ?? requestId;
        const updated = (
          await tx.query<OrderRow>(
            `UPDATE ${T} SET status='capturing', armed_mock=NULL, capture_request_id=$2, updated_at=now() WHERE paypal_order_id=$1 RETURNING *`,
            [id, reqId],
          )
        ).rows[0]!;
        return { row: updated, mock: row.armed_mock };
      });
    },

    /** Idempotent: fulfils exactly once, on the first transition to paid. */
    async markPaid(id: string, captureId: string): Promise<boolean> {
      const res = await db.query(
        `UPDATE ${T} SET status='paid', capture_id=$2, paid_at=now(), updated_at=now(), fulfilment_count = fulfilment_count + 1
         WHERE paypal_order_id=$1 AND status IN ('created','capturing','capture_failed') RETURNING paypal_order_id`,
        [id, captureId],
      );
      return res.rows.length === 1;
    },

    async markCaptureFailed(id: string, opts: { keepRequestId: boolean }) {
      await db.query(
        `UPDATE ${T} SET status='capture_failed', updated_at=now(), capture_request_id = CASE WHEN $2 THEN capture_request_id ELSE NULL END
         WHERE paypal_order_id=$1 AND status='capturing'`,
        [id, opts.keepRequestId],
      );
    },

    async markRefunded(id: string, refundId: string): Promise<boolean> {
      const res = await db.query(
        `UPDATE ${T} SET status='refunded', refund_id=$2, refunded_at=now(), updated_at=now() WHERE paypal_order_id=$1 AND status='paid' RETURNING paypal_order_id`,
        [id, refundId],
      );
      return res.rows.length === 1;
    },

    async armTestHook(id: string, mock: TestHookCode): Promise<boolean> {
      const res = await db.query(`UPDATE ${T} SET armed_mock=$2, updated_at=now() WHERE paypal_order_id=$1 AND status='created' RETURNING paypal_order_id`, [id, mock]);
      return res.rows.length === 1;
    },

    /**
     * Record one delivery and, if this event was never processed, run `process` in the same
     * transaction. The row lock from the upsert makes concurrent duplicates wait, so an event
     * is processed at most once.
     */
    async handleDelivery(
      e: { eventId: string; type: string; resourceId?: string; paypalOrderId?: string },
      process: (tx: Db) => Promise<void>,
    ): Promise<"processed" | "duplicate"> {
      return db.transaction(async (tx) => {
        const row = (
          await tx.query<{ processed: number }>(
            `INSERT INTO ${W} (event_id, type, resource_id, paypal_order_id) VALUES ($1,$2,$3,$4)
             ON CONFLICT (event_id) DO UPDATE SET deliveries = ${W}.deliveries + 1, last_received_at = now()
             RETURNING processed`,
            [e.eventId, e.type, e.resourceId ?? null, e.paypalOrderId ?? null],
          )
        ).rows[0]!;
        if (row.processed > 0) return "duplicate";
        await process(tx);
        await tx.query(`UPDATE ${W} SET processed = processed + 1 WHERE event_id = $1`, [e.eventId]);
        return "processed";
      });
    },

    async setEventOrder(eventId: string, paypalOrderId: string) {
      await db.query(`UPDATE ${W} SET paypal_order_id=$2 WHERE event_id=$1 AND paypal_order_id IS NULL`, [eventId, paypalOrderId]);
    },

    /** The contract's status record for one order. */
    async status(id: string): Promise<StoreOrderStatus | undefined> {
      const o = await this.getOrder(id);
      if (!o) return undefined;
      const events = (
        await db.query<{ event_id: string; type: string; deliveries: number; processed: number }>(
          `SELECT event_id, type, deliveries, processed FROM ${W} WHERE paypal_order_id=$1 ORDER BY first_received_at`,
          [id],
        )
      ).rows;
      return {
        paypalOrderId: o.paypal_order_id,
        status: o.status,
        amount: { currencyCode: o.currency, value: centsToValue(o.amount_cents) },
        captureIds: o.capture_id ? [o.capture_id] : [],
        refundIds: o.refund_id ? [o.refund_id] : [],
        fulfilmentCount: o.fulfilment_count,
        webhookEvents: events.map((e) => ({ eventId: e.event_id, type: e.type, deliveries: e.deliveries, processed: e.processed })),
        updatedAt: new Date(o.updated_at).toISOString(),
      };
    },
  };
}

export type StoreRepo = ReturnType<typeof storeRepo>;
