import { createSign } from "node:crypto";
import { generate } from "selfsigned";
import { beforeAll, describe, expect, it } from "vitest";
import {
  checkChain,
  isAllowedCertUrl,
  parsePemChain,
  signedMessage,
  verifyWebhook,
  webhookHeadersFrom,
  type WebhookHeaders,
} from "./webhook-verify.js";

const CERT_URL = "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42-fca2a594-test";
const WEBHOOK_ID = "WH-TEST-0001";
const body = Buffer.from(JSON.stringify({ id: "WH-EVT-1", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: "CAP1" } }));

let paypalCert: string;
let paypalKey: string;
let otherCert: string;

async function makeCert(cn: string) {
  const now = Date.now();
  return generate([{ name: "commonName", value: cn }], {
    keySize: 2048,
    algorithm: "sha256",
    notBeforeDate: new Date(now - 86_400_000),
    notAfterDate: new Date(now + 86_400_000 * 365),
  });
}

function sign(message: string, key: string) {
  return createSign("sha256").update(message).sign(key, "base64");
}

function headersFor(sig: string, overrides: Partial<WebhookHeaders> = {}): WebhookHeaders {
  return {
    transmissionId: "tx-1",
    transmissionTime: "2026-11-06T20:00:00Z",
    transmissionSig: sig,
    certUrl: CERT_URL,
    authAlgo: "SHA256withRSA",
    ...overrides,
  };
}

beforeAll(async () => {
  const pp = await makeCert("messageverificationcerts.sandbox.paypal.com");
  paypalCert = pp.cert;
  paypalKey = pp.private;
  otherCert = (await makeCert("evil.example.com")).cert;
}, 30_000);

describe("isAllowedCertUrl", () => {
  it.each([
    [CERT_URL, true],
    ["https://api-m.sandbox.paypal.com/v1/notifications/certs/CERT-1", true],
    ["http://api.sandbox.paypal.com/v1/notifications/certs/CERT-1", false],
    ["https://api.paypal.com/v1/notifications/certs/CERT-1", false], // live host: sandbox only
    ["https://api.sandbox.paypal.com.evil.example/v1/notifications/certs/CERT-1", false],
    ["https://evil.example/v1/notifications/certs/CERT-1?api.sandbox.paypal.com", false],
    ["https://user@api.sandbox.paypal.com/v1/notifications/certs/CERT-1", false],
    ["https://api.sandbox.paypal.com:8443/v1/notifications/certs/CERT-1", false],
    ["https://api.sandbox.paypal.com/other/path", false],
    ["not a url", false],
    [undefined, false],
  ])("%s -> %s", (url, expected) => {
    expect(isAllowedCertUrl(url)).toBe(expected);
  });
});

describe("signedMessage", () => {
  it("uses the unsigned CRC32 of the raw body", () => {
    // CRC32("hello") = 907060870 (0x3610a686)
    expect(signedMessage("t", "time", "wh", Buffer.from("hello"))).toBe("t|time|wh|907060870");
  });
});

describe("webhookHeadersFrom", () => {
  it("reads headers case-insensitively", () => {
    expect(webhookHeadersFrom({ "PAYPAL-TRANSMISSION-ID": "a", "paypal-cert-url": ["u"] })).toMatchObject({ transmissionId: "a", certUrl: "u" });
  });
});

describe("verifyWebhook", () => {
  const fetcher = async () => paypalCert;

  it("accepts a correctly signed delivery", async () => {
    const sig = sign(signedMessage("tx-1", "2026-11-06T20:00:00Z", WEBHOOK_ID, body), paypalKey);
    const result = await verifyWebhook({ headers: headersFor(sig), rawBody: body, webhookId: WEBHOOK_ID, fetcher });
    expect(result).toEqual({ valid: true, chainVerified: false });
  });

  it("rejects a delivery signed for a different webhook ID", async () => {
    const sig = sign(signedMessage("tx-1", "2026-11-06T20:00:00Z", "WH-SOMEONE-ELSE", body), paypalKey);
    expect(await verifyWebhook({ headers: headersFor(sig), rawBody: body, webhookId: WEBHOOK_ID, fetcher })).toEqual({ valid: false, reason: "bad_signature" });
  });

  it("rejects a tampered body", async () => {
    const sig = sign(signedMessage("tx-1", "2026-11-06T20:00:00Z", WEBHOOK_ID, body), paypalKey);
    const tampered = Buffer.from(body.toString().replace("CAP1", "CAP2"));
    expect((await verifyWebhook({ headers: headersFor(sig), rawBody: tampered, webhookId: WEBHOOK_ID, fetcher })).reason).toBe("bad_signature");
  });

  it("rejects unsigned and garbage-signed deliveries (S2 shape)", async () => {
    expect((await verifyWebhook({ headers: {}, rawBody: body, webhookId: WEBHOOK_ID, fetcher })).reason).toBe("missing_headers");
    expect((await verifyWebhook({ headers: headersFor("bm90LWEtc2ln"), rawBody: body, webhookId: WEBHOOK_ID, fetcher })).reason).toBe("bad_signature");
  });

  it("never fetches a certificate from a non-PayPal URL", async () => {
    let fetched = false;
    const spy = async () => {
      fetched = true;
      return paypalCert;
    };
    const sig = sign(signedMessage("tx-1", "2026-11-06T20:00:00Z", WEBHOOK_ID, body), paypalKey);
    const result = await verifyWebhook({ headers: headersFor(sig, { certUrl: "https://evil.example/cert.pem" }), rawBody: body, webhookId: WEBHOOK_ID, fetcher: spy });
    expect(result.reason).toBe("cert_url_not_allowed");
    expect(fetched).toBe(false);
  });

  it("rejects a certificate that does not name PayPal", async () => {
    const result = await verifyWebhook({ headers: headersFor("x"), rawBody: body, webhookId: WEBHOOK_ID, fetcher: async () => otherCert });
    expect(result.reason).toBe("cert_not_paypal");
  });

  it("rejects an expired certificate", async () => {
    const sig = sign(signedMessage("tx-1", "2026-11-06T20:00:00Z", WEBHOOK_ID, body), paypalKey);
    const later = new Date(Date.now() + 86_400_000 * 400);
    expect((await verifyWebhook({ headers: headersFor(sig), rawBody: body, webhookId: WEBHOOK_ID, fetcher, now: later })).reason).toBe("cert_expired");
  });

  it("rejects other algorithms and failed fetches", async () => {
    expect((await verifyWebhook({ headers: headersFor("x", { authAlgo: "SHA1withRSA" }), rawBody: body, webhookId: WEBHOOK_ID, fetcher })).reason).toBe("unsupported_algorithm");
    const failing = async () => {
      throw new Error("down");
    };
    expect((await verifyWebhook({ headers: headersFor("x"), rawBody: body, webhookId: WEBHOOK_ID, fetcher: failing })).reason).toBe("cert_fetch_failed");
  });
});

describe("checkChain", () => {
  it("rejects a two-cert chain where the parent did not issue the child", () => {
    const chain = parsePemChain(paypalCert + otherCert);
    expect(checkChain(chain)).toMatchObject({ ok: false, reason: "cert_chain_invalid" });
  });
});
