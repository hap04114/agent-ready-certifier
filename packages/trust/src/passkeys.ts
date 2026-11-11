/**
 * Owner approvals with passkeys (WebAuthn). The store owner registers a passkey once; after that,
 * an AI shopper's request for more budget is approved only by a passkey signature made on the
 * owner's own device. The agent can read anything in its context (the I-HITL finding), but it can
 * never produce this signature.
 *
 * The WebAuthn challenge is not random noise: it is the SHA-256 of the approval's own content
 * (request ID, new limit, a server nonce). So the stored assertion proves "the owner approved THIS
 * request", and anyone can re-check it later from the stored public key. Plain code only.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { canonicalJson } from "./index.js";

export type { AuthenticationResponseJSON, RegistrationResponseJSON };

/** The relying party: the certifier's own web origin (passkeys are bound to it). */
export interface RelyingParty {
  id: string;
  origin: string;
  name: string;
}

export function relyingPartyOf(apiBaseUrl: string): RelyingParty {
  const u = new URL(apiBaseUrl);
  return { id: u.hostname, origin: u.origin, name: "Agent-Ready Certifier" };
}

/** A stored passkey (public data only: the private key never leaves the owner's device). */
export interface StoredPasskey {
  credentialId: string;
  publicKey: Uint8Array;
  counter: number;
  transports: string[];
}

/** What the owner is asked to approve. */
export interface ApprovalContent {
  id: string;
  currentLimit: string;
  requestedLimit: string;
  currency: string;
  nonce: string;
}

const b64url = (b: Uint8Array) => Buffer.from(b).toString("base64url");

/** SHA-256 of the canonical approval content: the WebAuthn challenge for that approval. */
export function approvalChallengeBytes(a: ApprovalContent): Uint8Array<ArrayBuffer> {
  return new Uint8Array(createHash("sha256").update(canonicalJson({ type: "certifier.owner-approval.v1", ...a })).digest());
}
export const approvalChallenge = (a: ApprovalContent) => b64url(approvalChallengeBytes(a));
export const newNonce = () => randomBytes(16).toString("base64url");

export async function passkeyRegistrationOptions(rp: RelyingParty, existing: StoredPasskey[]) {
  return generateRegistrationOptions({
    rpName: rp.name,
    rpID: rp.id,
    userName: "store-owner",
    userDisplayName: "Store owner",
    attestationType: "none",
    excludeCredentials: existing.map((p) => ({ id: p.credentialId, transports: p.transports })),
    authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
  });
}

export async function verifyPasskeyRegistration(rp: RelyingParty, response: RegistrationResponseJSON, expectedChallenge: string): Promise<StoredPasskey | undefined> {
  const r = await verifyRegistrationResponse({
    response,
    expectedChallenge,
    expectedOrigin: rp.origin,
    expectedRPID: rp.id,
    requireUserVerification: true,
  });
  if (!r.verified) return undefined;
  const c = r.registrationInfo.credential;
  return { credentialId: c.id, publicKey: c.publicKey, counter: c.counter, transports: c.transports ?? [] };
}

export async function approvalRequestOptions(rp: RelyingParty, content: ApprovalContent, passkeys: StoredPasskey[]) {
  return generateAuthenticationOptions({
    rpID: rp.id,
    challenge: approvalChallengeBytes(content),
    allowCredentials: passkeys.map((p) => ({ id: p.credentialId, transports: p.transports })),
    userVerification: "required",
    timeout: 120_000,
  });
}

export type ApprovalCheck = { valid: true; credentialId: string; newCounter: number } | { valid: false; reason: string };

/**
 * Verify the owner's passkey signature over one approval. `counter` is the passkey's last seen
 * signature counter (pass 0 to re-check an old assertion later).
 */
export async function verifyApprovalAssertion(
  rp: RelyingParty,
  content: ApprovalContent,
  response: AuthenticationResponseJSON,
  passkey: StoredPasskey,
  counter = passkey.counter,
): Promise<ApprovalCheck> {
  if (response.id !== passkey.credentialId) return { valid: false, reason: "unknown_passkey" };
  try {
    const r = await verifyAuthenticationResponse({
      response,
      expectedChallenge: approvalChallenge(content),
      expectedOrigin: rp.origin,
      expectedRPID: rp.id,
      credential: { id: passkey.credentialId, publicKey: passkey.publicKey as Uint8Array<ArrayBuffer>, counter, transports: passkey.transports as never },
      requireUserVerification: true,
    });
    return r.verified ? { valid: true, credentialId: passkey.credentialId, newCounter: r.authenticationInfo.newCounter } : { valid: false, reason: "bad_signature" };
  } catch (err) {
    return { valid: false, reason: err instanceof Error ? err.message.slice(0, 160) : "verification_failed" };
  }
}
