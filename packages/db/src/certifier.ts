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
  {
    id: "003_stores",
    sql: `
      -- Stores under test. A run may only start on a verified store (CLAUDE.md rule 3).
      CREATE TABLE stores (
        id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        url              text NOT NULL UNIQUE,
        ownership_token  text NOT NULL,
        verified_at      timestamptz,
        verify_method    text,
        last_check       text,
        -- Extended contract: kept as configuration, never shown in reports or API responses.
        store_webhook_id text,
        demo_hooks       boolean NOT NULL DEFAULT false,
        created_at       timestamptz NOT NULL DEFAULT now()
      );
      ALTER TABLE runs ADD COLUMN store_id uuid REFERENCES stores(id);
    `,
  },
  {
    id: "004_observed_evidence",
    sql: `
      ALTER TABLE evidence DROP CONSTRAINT IF EXISTS evidence_strength_check;
      ALTER TABLE evidence ADD CONSTRAINT evidence_strength_check
        CHECK (strength IN ('paypal-signed','paypal-api','store-reported','certifier-observed','certifier-recorded'));
    `,
  },
  {
    id: "005_store_certifier_webhook_id",
    sql: `
      -- The webhook ID of the certifier's listener on THIS store's PayPal app (store contract
      -- item 2). PayPal signs each app's deliveries with that ID. Not a secret; never shown.
      ALTER TABLE stores ADD COLUMN certifier_webhook_id text;
    `,
  },
  {
    id: "006_agent_trials",
    sql: `
      -- One AI-shopper trial (model scorecard, Agent-ready pillar). Outcomes are judged by the
      -- truth checker from PayPal records; null means not judged (e.g. trial error).
      CREATE TABLE agent_trials (
        id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        batch_id      text NOT NULL,
        run_id        uuid REFERENCES runs(id) ON DELETE SET NULL,
        provider      text NOT NULL,
        model         text NOT NULL,
        scenario      text NOT NULL,
        trial_no      int  NOT NULL,
        status        text NOT NULL CHECK (status IN ('judged','error')),
        verdict       text CHECK (verdict IN ('pass','fail','inconclusive')),
        bypassed      boolean,
        wrong_payee   boolean,
        trap_followed boolean,
        safe_stop     boolean NOT NULL DEFAULT false,
        task_success  boolean,
        order_ids     text[] NOT NULL DEFAULT '{}',
        summary       text,
        steps         jsonb NOT NULL DEFAULT '[]'::jsonb,
        error         text,
        created_at    timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX agent_trials_model ON agent_trials (provider, model, scenario);
    `,
  },
  {
    id: "007_findings",
    sql: `
      -- Written by the diagnosis agent for FAILED checks. Explanations only: verdicts stay in checks.
      CREATE TABLE findings (
        id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        run_id        uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        check_code    text NOT NULL,
        explanation   text NOT NULL,
        fix_steps     jsonb NOT NULL DEFAULT '[]'::jsonb,
        code_snippet  text,
        sdk_verified  jsonb NOT NULL DEFAULT '[]'::jsonb,
        sdk_unverified jsonb NOT NULL DEFAULT '[]'::jsonb,
        sdk_source    text NOT NULL,
        model         text NOT NULL,
        created_at    timestamptz NOT NULL DEFAULT now(),
        UNIQUE (run_id, check_code)
      );
    `,
  },
  {
    id: "008_certificates_hash_log",
    sql: `
      -- One signed certificate per judged run (compact JWS, Ed25519), with the exact summary it signs.
      CREATE TABLE certificates (
        run_id          uuid PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
        jws             text NOT NULL,
        summary         jsonb NOT NULL,
        summary_sha256  text NOT NULL,
        kid             text NOT NULL,
        issued_at       timestamptz NOT NULL DEFAULT now()
      );
      -- Append-only hash chain over certificates. prev_hash is UNIQUE, so the chain cannot fork.
      CREATE TABLE cert_log (
        seq             integer PRIMARY KEY,
        run_id          uuid NOT NULL UNIQUE REFERENCES runs(id) ON DELETE CASCADE,
        prev_hash       text NOT NULL UNIQUE,
        entry_hash      text NOT NULL UNIQUE,
        preimage        text NOT NULL,
        created_at      timestamptz NOT NULL DEFAULT now(),
        ots_calendar    text,
        ots_proof       bytea
      );
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

    async createRun(r: { storeUrl: string; budgetRequests: number; timeLimitMin: number; storeId?: string; status?: string }): Promise<string> {
      return (
        await db.query<{ id: string }>(
          `INSERT INTO ${S}.runs (store_url, status, budget_requests, time_limit_min, store_id) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
          [r.storeUrl, r.status ?? "running", r.budgetRequests, r.timeLimitMin, r.storeId ?? null],
        )
      ).rows[0]!.id;
    },

    async setRunStatus(id: string, status: string) {
      await db.query(`UPDATE ${S}.runs SET status=$2 WHERE id=$1`, [id, status]);
    },

    /** Runs still in progress (one at a time is allowed by the Run API). */
    async activeRuns(): Promise<{ id: string }[]> {
      return (await db.query<{ id: string }>(`SELECT id FROM ${S}.runs WHERE status IN ('requested','ownership_verified','running')`)).rows;
    },

    async getRun(id: string) {
      const run = (
        await db.query<{ id: string; store_id: string | null; store_url: string; status: string; started_at: Date; finished_at: Date | null; requests_used: number; budget_requests: number; notes: Record<string, unknown> }>(
          `SELECT id, store_id, store_url, status, started_at, finished_at, requests_used, budget_requests, notes FROM ${S}.runs WHERE id=$1`,
          [id],
        )
      ).rows[0];
      if (!run) return undefined;
      const checks = (
        await db.query<{ id: string; code: string; pillar: string; status: string; summary: string; reasons: string[] }>(
          `SELECT id, code, pillar, status, summary, reasons FROM ${S}.checks WHERE run_id=$1 ORDER BY code`,
          [id],
        )
      ).rows;
      const evidence = (
        await db.query<{ check_id: string; kind: string; paypal_id: string; strength: string; note: string | null }>(
          `SELECT e.check_id, e.kind, e.paypal_id, e.strength, e.note FROM ${S}.evidence e JOIN ${S}.checks c ON c.id = e.check_id WHERE c.run_id=$1 ORDER BY e.created_at`,
          [id],
        )
      ).rows;
      return {
        ...run,
        checks: checks.map((ch) => ({
          code: ch.code,
          pillar: ch.pillar,
          status: ch.status,
          summary: ch.summary,
          reasons: ch.reasons,
          evidence: evidence.filter((e) => e.check_id === ch.id).map((e) => ({ kind: e.kind, id: e.paypal_id, strength: e.strength, note: e.note })),
        })),
      };
    },

    async createStore(s: { url: string; ownershipToken: string; storeWebhookId?: string; certifierWebhookId?: string; demoHooks?: boolean }) {
      return (
        await db.query<{ id: string }>(
          `INSERT INTO ${S}.stores (url, ownership_token, store_webhook_id, certifier_webhook_id, demo_hooks) VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (url) DO UPDATE SET
             store_webhook_id = COALESCE(EXCLUDED.store_webhook_id, ${S}.stores.store_webhook_id),
             certifier_webhook_id = COALESCE(EXCLUDED.certifier_webhook_id, ${S}.stores.certifier_webhook_id),
             demo_hooks = EXCLUDED.demo_hooks OR ${S}.stores.demo_hooks
           RETURNING id`,
          [s.url, s.ownershipToken, s.storeWebhookId ?? null, s.certifierWebhookId ?? null, s.demoHooks ?? false],
        )
      ).rows[0]!.id;
    },

    /** Webhook IDs of the certifier's listener across registered stores' PayPal apps. */
    async certifierWebhookIds(): Promise<string[]> {
      return (await db.query<{ id: string }>(`SELECT DISTINCT certifier_webhook_id AS id FROM ${S}.stores WHERE certifier_webhook_id IS NOT NULL`)).rows.map((r) => r.id);
    },

    async saveTrial(t: {
      batchId: string;
      runId?: string;
      provider: string;
      model: string;
      scenario: string;
      trialNo: number;
      status: "judged" | "error";
      verdict?: string;
      bypassed?: boolean | null;
      wrongPayee?: boolean | null;
      trapFollowed?: boolean | null;
      safeStop: boolean;
      taskSuccess?: boolean | null;
      orderIds: string[];
      summary?: string;
      steps: unknown[];
      error?: string;
    }) {
      await db.query(
        `INSERT INTO ${S}.agent_trials (batch_id, run_id, provider, model, scenario, trial_no, status, verdict, bypassed, wrong_payee, trap_followed, safe_stop, task_success, order_ids, summary, steps, error)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [
          t.batchId,
          t.runId ?? null,
          t.provider,
          t.model,
          t.scenario,
          t.trialNo,
          t.status,
          t.verdict ?? null,
          t.bypassed ?? null,
          t.wrongPayee ?? null,
          t.trapFollowed ?? null,
          t.safeStop,
          t.taskSuccess ?? null,
          t.orderIds,
          t.summary ?? null,
          JSON.stringify(t.steps),
          t.error ?? null,
        ],
      );
    },

    async listTrials(limit = 2000) {
      return (
        await db.query<{
          id: string;
          batch_id: string;
          provider: string;
          model: string;
          scenario: string;
          trial_no: number;
          status: string;
          verdict: string | null;
          bypassed: boolean | null;
          wrong_payee: boolean | null;
          trap_followed: boolean | null;
          safe_stop: boolean;
          task_success: boolean | null;
          order_ids: string[];
          summary: string | null;
          created_at: Date;
        }>(
          `SELECT id, batch_id, provider, model, scenario, trial_no, status, verdict, bypassed, wrong_payee, trap_followed, safe_stop, task_success, order_ids, summary, created_at
           FROM ${S}.agent_trials ORDER BY created_at DESC LIMIT $1`,
          [limit],
        )
      ).rows;
    },

    async getTrialSteps(id: string) {
      return (await db.query<{ steps: unknown[] }>(`SELECT steps FROM ${S}.agent_trials WHERE id=$1`, [id])).rows[0]?.steps;
    },

    async getCertificate(runId: string) {
      return (
        await db.query<{ run_id: string; jws: string; summary: unknown; summary_sha256: string; kid: string; issued_at: Date }>(
          `SELECT run_id, jws, summary, summary_sha256, kid, issued_at FROM ${S}.certificates WHERE run_id=$1`,
          [runId],
        )
      ).rows[0];
    },

    /**
     * Store a certificate and append its hash-log entry in one transaction. `entry` builds the
     * log preimage from the previous hash and the next sequence number.
     */
    async saveCertificate(c: { runId: string; jws: string; summary: unknown; summarySha256: string; kid: string }, entry: (prev: { seq: number; hash: string }) => { preimage: string; entryHash: string; createdAt: string }) {
      return db.transaction(async (tx) => {
        const existing = (await tx.query<{ run_id: string }>(`SELECT run_id FROM ${S}.certificates WHERE run_id=$1`, [c.runId])).rows[0];
        if (existing) return undefined;
        await tx.query(`INSERT INTO ${S}.certificates (run_id, jws, summary, summary_sha256, kid) VALUES ($1,$2,$3,$4,$5)`, [c.runId, c.jws, JSON.stringify(c.summary), c.summarySha256, c.kid]);
        const last = (await tx.query<{ seq: number; entry_hash: string }>(`SELECT seq, entry_hash FROM ${S}.cert_log ORDER BY seq DESC LIMIT 1 FOR UPDATE`)).rows[0];
        const prev = { seq: last?.seq ?? 0, hash: last?.entry_hash ?? "0".repeat(64) };
        const e = entry(prev);
        await tx.query(`INSERT INTO ${S}.cert_log (seq, run_id, prev_hash, entry_hash, preimage, created_at) VALUES ($1,$2,$3,$4,$5,$6)`, [prev.seq + 1, c.runId, prev.hash, e.entryHash, e.preimage, e.createdAt]);
        return { seq: prev.seq + 1, prevHash: prev.hash, entryHash: e.entryHash };
      });
    },

    async setOtsProof(seq: number, calendar: string, proof: Buffer) {
      await db.query(`UPDATE ${S}.cert_log SET ots_calendar=$2, ots_proof=$3 WHERE seq=$1`, [seq, calendar, proof]);
    },

    async listHashLog(limit = 500) {
      return (
        await db.query<{ seq: number; run_id: string; prev_hash: string; entry_hash: string; preimage: string; created_at: Date; ots_calendar: string | null; has_ots: boolean }>(
          `SELECT seq, run_id, prev_hash, entry_hash, preimage, created_at, ots_calendar, (ots_proof IS NOT NULL) AS has_ots FROM ${S}.cert_log ORDER BY seq LIMIT $1`,
          [limit],
        )
      ).rows;
    },

    async getLogEntry(seq: number) {
      return (
        await db.query<{ seq: number; run_id: string; prev_hash: string; entry_hash: string; preimage: string; created_at: Date; ots_calendar: string | null; ots_proof: Buffer | null }>(
          `SELECT seq, run_id, prev_hash, entry_hash, preimage, created_at, ots_calendar, ots_proof FROM ${S}.cert_log WHERE seq=$1`,
          [seq],
        )
      ).rows[0];
    },

    async getLogEntryForRun(runId: string) {
      return (
        await db.query<{ seq: number; prev_hash: string; entry_hash: string; preimage: string; ots_calendar: string | null; has_ots: boolean }>(
          `SELECT seq, prev_hash, entry_hash, preimage, ots_calendar, (ots_proof IS NOT NULL) AS has_ots FROM ${S}.cert_log WHERE run_id=$1`,
          [runId],
        )
      ).rows[0];
    },

    async listRuns(limit = 200) {
      return (
        await db.query<{
          id: string;
          store_url: string;
          status: string;
          started_at: Date;
          finished_at: Date | null;
          requests_used: number;
          passed: number;
          failed: number;
          inconclusive: number;
        }>(
          `SELECT r.id, r.store_url, r.status, r.started_at, r.finished_at, r.requests_used,
                  count(*) FILTER (WHERE c.status='pass')::int AS passed,
                  count(*) FILTER (WHERE c.status='fail')::int AS failed,
                  count(*) FILTER (WHERE c.status='inconclusive')::int AS inconclusive
           FROM ${S}.runs r LEFT JOIN ${S}.checks c ON c.run_id = r.id
           GROUP BY r.id ORDER BY r.started_at DESC LIMIT $1`,
          [limit],
        )
      ).rows;
    },

    async saveFinding(f: {
      runId: string;
      code: string;
      explanation: string;
      fixSteps: string[];
      codeSnippet: string;
      verified: string[];
      unverified: string[];
      source: string;
      model: string;
    }) {
      await db.query(
        `INSERT INTO ${S}.findings (run_id, check_code, explanation, fix_steps, code_snippet, sdk_verified, sdk_unverified, sdk_source, model)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (run_id, check_code) DO UPDATE SET explanation=EXCLUDED.explanation, fix_steps=EXCLUDED.fix_steps, code_snippet=EXCLUDED.code_snippet,
           sdk_verified=EXCLUDED.sdk_verified, sdk_unverified=EXCLUDED.sdk_unverified, sdk_source=EXCLUDED.sdk_source, model=EXCLUDED.model, created_at=now()`,
        [f.runId, f.code, f.explanation, JSON.stringify(f.fixSteps), f.codeSnippet, JSON.stringify(f.verified), JSON.stringify(f.unverified), f.source, f.model],
      );
    },

    async findingsForRun(runId: string) {
      return (
        await db.query<{ check_code: string; explanation: string; fix_steps: string[]; code_snippet: string | null; sdk_verified: string[]; sdk_unverified: string[]; sdk_source: string; model: string }>(
          `SELECT check_code, explanation, fix_steps, code_snippet, sdk_verified, sdk_unverified, sdk_source, model FROM ${S}.findings WHERE run_id=$1`,
          [runId],
        )
      ).rows;
    },

    async listStores() {
      return (
        await db.query<{ id: string; url: string; verified_at: Date | null; verify_method: string | null; last_check: string | null; created_at: Date }>(
          `SELECT id, url, verified_at, verify_method, last_check, created_at FROM ${S}.stores ORDER BY created_at`,
        )
      ).rows;
    },

    async getStore(id: string) {
      return (
        await db.query<{ id: string; url: string; ownership_token: string; verified_at: Date | null; verify_method: string | null; last_check: string | null; store_webhook_id: string | null; demo_hooks: boolean }>(
          `SELECT id, url, ownership_token, verified_at, verify_method, last_check, store_webhook_id, demo_hooks FROM ${S}.stores WHERE id=$1`,
          [id],
        )
      ).rows[0];
    },

    async recordOwnershipCheck(id: string, r: { verified: boolean; method?: string; detail: string }) {
      await db.query(
        `UPDATE ${S}.stores SET verified_at = CASE WHEN $2 THEN now() ELSE NULL END, verify_method = $3, last_check = $4 WHERE id=$1`,
        [id, r.verified, r.method ?? null, r.detail],
      );
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
