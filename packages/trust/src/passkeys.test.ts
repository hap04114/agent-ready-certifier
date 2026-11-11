import { describe, expect, it } from "vitest";
import {
  approvalChallenge,
  approvalRequestOptions,
  newNonce,
  passkeyRegistrationOptions,
  relyingPartyOf,
  verifyApprovalAssertion,
  verifyPasskeyRegistration,
} from "./passkeys.js";
import { softAuthenticator } from "./soft-authenticator.js";

const rp = relyingPartyOf("https://certifier.example");

async function registered() {
  const device = softAuthenticator(rp);
  const opts = await passkeyRegistrationOptions(rp, []);
  const passkey = await verifyPasskeyRegistration(rp, device.register(opts.challenge), opts.challenge);
  if (!passkey) throw new Error("registration failed");
  return { device, passkey };
}

describe("owner approval passkeys", () => {
  it("registers a passkey bound to the certifier's origin", async () => {
    const { device, passkey } = await registered();
    expect(passkey.credentialId).toBe(device.id);
    expect(passkey.publicKey.length).toBeGreaterThan(60);
  });

  it("rejects a registration answering a different challenge", async () => {
    const device = softAuthenticator(rp);
    const opts = await passkeyRegistrationOptions(rp, []);
    await expect(verifyPasskeyRegistration(rp, device.register("not-the-challenge"), opts.challenge)).rejects.toThrow();
  });

  it("accepts the owner's signature over exactly this approval", async () => {
    const { device, passkey } = await registered();
    const content = { id: "a1", currentLimit: "20.00", requestedLimit: "200.00", currency: "USD", nonce: newNonce() };
    const opts = await approvalRequestOptions(rp, content, [passkey]);
    expect(opts.challenge).toBe(approvalChallenge(content));
    const check = await verifyApprovalAssertion(rp, content, device.assert(opts.challenge), passkey);
    expect(check).toMatchObject({ valid: true, newCounter: 1 });
  });

  it("rejects a signature for a different amount, a phishing origin, a replay, or another device", async () => {
    const { device, passkey } = await registered();
    const content = { id: "a1", currentLimit: "20.00", requestedLimit: "200.00", currency: "USD", nonce: newNonce() };
    const signed = device.assert(approvalChallenge(content));
    // Same signature presented for a bigger limit: the challenge no longer matches.
    expect((await verifyApprovalAssertion(rp, { ...content, requestedLimit: "2000.00" }, signed, passkey)).valid).toBe(false);
    // Signed on a lookalike site.
    expect((await verifyApprovalAssertion(rp, content, device.assert(approvalChallenge(content), "https://certifier-example.evil"), passkey)).valid).toBe(false);
    // Replay: the counter already moved past this signature.
    expect((await verifyApprovalAssertion(rp, content, signed, passkey, 5)).valid).toBe(false);
    // A passkey we never registered.
    const stranger = softAuthenticator(rp);
    expect(await verifyApprovalAssertion(rp, content, stranger.assert(approvalChallenge(content)), passkey)).toEqual({ valid: false, reason: "unknown_passkey" });
  });
});
