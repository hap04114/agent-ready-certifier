/**
 * Owner approvals with passkeys. The owner registers a passkey once through a one-time invite
 * link (`pnpm passkey:invite`), then approves or denies an AI shopper's request for more budget on
 * /owner. The server only VERIFIES signatures; it can never approve anything on its own, and the
 * AI shopper has no way to make a passkey signature. What the agent wrote as its reason is
 * untrusted text: stored and shown as plain text, never interpreted.
 */
import { createHash } from "node:crypto";
import type { Config } from "@certifier/config";
import type { ApprovalRow, CertifierRepo } from "@certifier/db";
import {
  type ApprovalContent,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
  type StoredPasskey,
  approvalChallenge,
  approvalRequestOptions,
  newNonce,
  passkeyRegistrationOptions,
  relyingPartyOf,
  verifyApprovalAssertion,
  verifyPasskeyRegistration,
} from "@certifier/trust";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

const uuid = z.object({ id: z.uuid() });
const credential = z
  .object({
    id: z.string().min(1).max(1400),
    rawId: z.string().min(1).max(1400),
    type: z.literal("public-key"),
    response: z.record(z.string(), z.unknown()),
    clientExtensionResults: z.record(z.string(), z.unknown()).default({}),
    authenticatorAttachment: z.string().max(40).optional(),
  })
  .passthrough();
const invite = z.string().min(20).max(200);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

const contentOf = (a: ApprovalRow, nonce: string): ApprovalContent => ({
  id: a.id,
  currentLimit: a.current_limit,
  requestedLimit: a.requested_limit,
  currency: a.currency,
  nonce,
});
const stored = (p: { credential_id: string; public_key: Uint8Array; counter: number; transports: string[] }): StoredPasskey => ({
  credentialId: p.credential_id,
  publicKey: p.public_key,
  counter: Number(p.counter),
  transports: p.transports,
});
const publicApproval = (a: ApprovalRow) => ({
  id: a.id,
  batchId: a.batch_id,
  scenario: a.scenario,
  trialNo: a.trial_no,
  model: a.model,
  currency: a.currency,
  currentLimit: a.current_limit,
  requestedLimit: a.requested_limit,
  agentReason: a.agent_reason,
  status: a.status,
  approvedWith: a.passkey_label,
  createdAt: a.created_at,
  expiresAt: a.expires_at,
  decidedAt: a.decided_at,
});

export function registerPasskeyRoutes(app: FastifyInstance, deps: { config: Config; repo: CertifierRepo }) {
  const { repo } = deps;
  const rp = relyingPartyOf(deps.config.API_BASE_URL);
  // Registration challenges live only in memory for 5 minutes, keyed by the invite's hash.
  const regChallenges = new Map<string, { challenge: string; at: number }>();

  app.get("/api/passkeys", async () => ({
    relyingParty: rp.id,
    passkeys: (await repo.listPasskeys()).map((p) => ({ label: p.label, createdAt: p.created_at, lastUsedAt: p.last_used_at })),
  }));

  app.post("/api/passkeys/register/options", async (req, reply) => {
    const body = z.object({ invite }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const key = sha(body.data.invite);
    if (!(await repo.checkPasskeyInvite(key, false))) return reply.code(403).send({ error: "invalid_or_expired_invite" });
    const options = await passkeyRegistrationOptions(rp, (await repo.listPasskeys()).map(stored));
    regChallenges.set(key, { challenge: options.challenge, at: Date.now() });
    return options;
  });

  app.post("/api/passkeys/register/verify", async (req, reply) => {
    const body = z.object({ invite, response: credential, label: z.string().max(60).optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const key = sha(body.data.invite);
    const pending = regChallenges.get(key);
    if (!pending || Date.now() - pending.at > 5 * 60_000) return reply.code(400).send({ error: "no_open_registration" });
    const passkey = await verifyPasskeyRegistration(rp, body.data.response as unknown as RegistrationResponseJSON, pending.challenge).catch(() => undefined);
    if (!passkey) return reply.code(400).send({ error: "registration_failed" });
    if (!(await repo.checkPasskeyInvite(key, true))) return reply.code(403).send({ error: "invalid_or_expired_invite" });
    regChallenges.delete(key);
    await repo.savePasskey({ ...passkey, label: body.data.label?.trim() || "Store owner's passkey" });
    return { registered: true };
  });

  app.get("/api/approvals", async () => ({ approvals: (await repo.listApprovals()).map(publicApproval) }));

  app.get("/api/approvals/:id", async (req, reply) => {
    const p = uuid.safeParse(req.params);
    const a = p.success ? await repo.getApproval(p.data.id) : undefined;
    if (!a) return reply.code(404).send({ error: "not_found" });
    // Anyone can re-check an approval: the stored signature against the stored public key and a
    // challenge recomputed from the request's own content.
    let proof = null;
    if (a.status === "approved" && a.nonce && a.credential_id && a.assertion) {
      const pk = (await repo.listPasskeys()).find((k) => k.credential_id === a.credential_id);
      const recheck = pk ? await verifyApprovalAssertion(rp, contentOf(a, a.nonce), a.assertion as AuthenticationResponseJSON, stored(pk), 0) : undefined;
      proof = {
        challenge: approvalChallenge(contentOf(a, a.nonce)),
        signedContent: contentOf(a, a.nonce),
        credentialId: a.credential_id,
        assertion: a.assertion,
        signatureValid: recheck?.valid ?? false,
      };
    }
    return { ...publicApproval(a), proof };
  });

  app.post("/api/approvals/:id/options", async (req, reply) => {
    const p = uuid.safeParse(req.params);
    const a = p.success ? await repo.getApproval(p.data.id) : undefined;
    if (!a) return reply.code(404).send({ error: "not_found" });
    if (a.status !== "pending") return reply.code(409).send({ error: "not_pending", status: a.status });
    const passkeys = await repo.listPasskeys();
    if (passkeys.length === 0) return reply.code(409).send({ error: "no_passkey_registered" });
    const nonce = newNonce();
    if (!(await repo.setApprovalNonce(a.id, nonce))) return reply.code(409).send({ error: "not_pending" });
    return { request: publicApproval(a), options: await approvalRequestOptions(rp, contentOf(a, nonce), passkeys.map(stored)) };
  });

  app.post("/api/approvals/:id/approve", async (req, reply) => {
    const p = uuid.safeParse(req.params);
    const body = z.object({ response: credential }).safeParse(req.body);
    if (!p.success || !body.success) return reply.code(400).send({ error: "invalid_body" });
    const a = await repo.getApproval(p.data.id);
    if (!a) return reply.code(404).send({ error: "not_found" });
    if (a.status !== "pending" || !a.nonce) return reply.code(409).send({ error: "not_pending", status: a.status });
    const response = body.data.response as unknown as AuthenticationResponseJSON;
    const pk = (await repo.listPasskeys()).find((k) => k.credential_id === response.id);
    if (!pk) return reply.code(403).send({ error: "unknown_passkey" });
    const check = await verifyApprovalAssertion(rp, contentOf(a, a.nonce), response, stored(pk));
    if (!check.valid) {
      req.log.warn({ approval: a.id, reason: check.reason }, "passkey approval rejected");
      return reply.code(403).send({ error: "signature_rejected" });
    }
    const ok = await repo.approveWithPasskey(a.id, { nonce: a.nonce, credentialId: check.credentialId, assertion: response, newCounter: check.newCounter });
    return ok ? { approved: true } : reply.code(409).send({ error: "not_pending" });
  });

  app.post("/api/approvals/:id/deny", async (req, reply) => {
    const p = uuid.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: "invalid_id" });
    // Denying is always the safe outcome, so it needs no signature.
    return { denied: await repo.closeApproval(p.data.id, "denied") };
  });
}
