/**
 * The certifier's evidence store (Postgres schema `certifier`).
 * Webhook payloads are stored as untrusted data; only plain code reads structured fields.
 */
import { createHash } from "node:crypto";
import { type Db, type Migration, migrate } from "./index.js";

export const CERTIFIER_SCHEMA = "certifier";

export const CERTIFIER_MIGRATIONS: Migration[] = [
  {
    id: "001_runs_checks_evidence_webhooks",
    sql: `
      CREATE TABLE runs (
        id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        store_url       text NOT NULL,
        status          text NOT NULL,
        started_at      timestamptz NOT NULL DEFAULT now(),
        finished_at     timestamptz,
        budget_requests int  NOT NULL,
        requests_used   int  NOT NULL DEFAULT 0,
        time_limit_min  int  NOT NULL,
        notes           jsonb NOT NULL DEFAULT '{}'::jsonb
      );

      CREATE TABLE checks (
        id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        run_id    uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        pillar    text NOT NULL,
        code      text NOT NULL,
        status    text NOT NULL CHECK (status IN ('pass','fail','inconclusive')),
        summary   text NOT NULL,
        reasons   jsonb NOT NULL DEFAULT '[]'::jsonb,
        judged_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (run_id, code)
      );

      CREATE TABLE evidence (
        id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        check_id   uuid NOT NULL REFERENCES checks(id) ON DELETE CASCADE,
        kind       text NOT NULL,
        paypal_id  text NOT NULL,
        strength   text NOT NULL CHECK (strength IN ('paypal-signed','paypal-api','store-reported')),
        note       text,
        created_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE webhook_events (
        id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        event_id         text,
        transmission_id  text,
        type             text,
        resource_id      text,
        related_order_id text,
        signature_valid  boolean NOT NULL,
        verify_reason    text,
        chain_verified   boolean,
        body_sha256      text NOT NULL,
        payload          jsonb,
        received_at      timestamptz NOT NULL DEFAULT now(),
        UNIQUE (event_id, transmission_id)
      );
      CREATE INDEX webhook_events_resource ON webhook_events (resource_id);
    `,
  },
  {
    id: "002_certifier_recorded_evidence",
    sql: `
      ALTER TABLE evidence DROP CONSTRAINT IF EXISTS evidence_strength_check;
      ALTER TABLE evidence ADD CONSTRAINT evidence_strength_check
        CHECK (strength IN ('paypal-signed','paypal-api','store-reported','certifier-recorded'));
    `,
  },
];

export const migrateCertifier = (db: Db) => migrate(db, CERTIFIER_SCHEMA, CERTIFIER_MIGRATIONS);

const S = CERTIFIER_SCHEMA;

export interface StoredEvent {
  event_id: string;
  type: string;
  resource_id: string | null;
  related_order_id: string | null;
  signature_valid: boolean;
  received_at: Date | string;
}

export function certifierRepo(db: Db) {
  return {
    /** Record one delivery to the certifier's listener (valid or not). Duplicate transmissions are ignored. */
    async recordWebhook(e: {
      eventId?: string;
      transmissionId?: string;
      type?: string;
      resourceId?: string;
      relatedOrderId?: string;
      signatureValid: boolean;
      verifyReason?: string;
      chainVerified?: boolean;
      rawBody: Buffer;
      payload?: unknown;
    }): Promise<void> {
      await db.query(
        `INSERT INTO ${S}.webhook_events (event_id, transmission_id, type, resource_id, related_order_id, signature_valid, verify_reason, chain_verified, body_sha256, payload)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (event_id, transmission_id) DO NOTHING`,
        [
          e.eventId ?? null,
          e.transmissionId ?? null,
          e.type ?? null,
          e.resourceId ?? null,
          e.relatedOrderId ?? null,
          e.signatureValid,
          e.verifyReason ?? null,
          e.chainVerified ?? null,
          createHash("sha256").update(e.rawBody).digest("hex"),
          e.payload === undefined ? null : JSON.stringify(e.payload),
        ],
      );
    },

    /** The first verified event of `type` about `resourceId` (e.g. a capture or refund ID). */
    async findSignedEvent(type: string, resourceId: string): Promise<StoredEvent | undefined> {
      return (
        await db.query<StoredEvent>(
          `SELECT event_id, type, resource_id, related_order_id, signature_valid, received_at FROM ${S}.webhook_events
           WHERE type = $1 AND resource_id = $2 AND signature_valid ORDER BY received_at LIMIT 1`,
          [type, resourceId],
        )
      ).rows[0];
    },

    async createRun(r: { storeUrl: string; budgetRequests: number; timeLimitMin: number }): Promise<string> {
      return (
        await db.query<{ id: string }>(`INSERT INTO ${S}.runs (store_url, status, budget_requests, time_limit_min) VALUES ($1,'running',$2,$3) RETURNING id`, [
          r.storeUrl,
          r.budgetRequests,
          r.timeLimitMin,
        ])
      ).rows[0]!.id;
    },

    async getRunNotes(id: string): Promise<Record<string, unknown> | undefined> {
      return (await db.query<{ notes: Record<string, unknown> }>(`SELECT notes FROM ${S}.runs WHERE id = $1`, [id])).rows[0]?.notes;
    },

    async finishRun(id: string, status: "judged" | "stopped" | "failed", requestsUsed: number, notes: Record<string, unknown> = {}) {
      await db.query(`UPDATE ${S}.runs SET status=$2, finished_at=now(), requests_used=$3, notes=$4 WHERE id=$1`, [id, status, requestsUsed, JSON.stringify(notes)]);
    },

    /** Store a verdict and every piece of evidence it relied on. */
    async saveVerdict(
      runId: string,
      pillar: string,
      v: { check: string; status: string; summary: string; reasons: string[]; evidence: { kind: string; id: string; strength: string; note?: string }[] },
    ): Promise<void> {
      await db.transaction(async (tx) => {
        const checkId = (
          await tx.query<{ id: string }>(
            `INSERT INTO ${S}.checks (run_id, pillar, code, status, summary, reasons) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
            [runId, pillar, v.check, v.status, v.summary, JSON.stringify(v.reasons)],
          )
        ).rows[0]!.id;
        for (const e of v.evidence) {
          await tx.query(`INSERT INTO ${S}.evidence (check_id, kind, paypal_id, strength, note) VALUES ($1,$2,$3,$4,$5)`, [
            checkId,
            e.kind,
            e.id,
            e.strength,
            e.note ?? null,
          ]);
        }
      });
    },
  };
}

export type CertifierRepo = ReturnType<typeof certifierRepo>;
