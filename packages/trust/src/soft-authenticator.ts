/**
 * A software passkey for TESTS ONLY: makes real WebAuthn registration and assertion responses
 * (P-256, "none" attestation) so the verification code is exercised end to end without a device.
 */
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";

// Minimal CBOR encoder: unsigned/negative ints, byte strings, text strings, maps.
type Cbor = number | string | Uint8Array | CborMap | { [key: string]: Cbor };
interface CborMap extends Map<Cbor, Cbor> {}
function head(major: number, n: number): number[] {
  if (n < 24) return [(major << 5) | n];
  if (n < 256) return [(major << 5) | 24, n];
  if (n < 65536) return [(major << 5) | 25, n >> 8, n & 255];
  return [(major << 5) | 26, (n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function cbor(v: Cbor): number[] {
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === "string") {
    const b = Buffer.from(v, "utf8");
    return [...head(3, b.length), ...b];
  }
  if (v instanceof Uint8Array) return [...head(2, v.length), ...v];
  const entries = v instanceof Map ? [...v.entries()] : Object.entries(v);
  return [...head(5, entries.length), ...entries.flatMap(([k, x]) => [...cbor(k), ...cbor(x)])];
}

const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest();
const u32 = (n: number) => Buffer.from([(n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255]);

export function softAuthenticator(rp: { id: string; origin: string }) {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const credentialId = randomBytes(16);
  const id = credentialId.toString("base64url");
  let counter = 0;
  const flagsUpUv = 0x01 | 0x04;
  const clientData = (type: string, challenge: string, origin = rp.origin) =>
    Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }), "utf8");

  return {
    id,
    register(challenge: string): RegistrationResponseJSON {
      const cose = new Map<Cbor, Cbor>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, new Uint8Array(Buffer.from(jwk.x!, "base64url"))],
        [-3, new Uint8Array(Buffer.from(jwk.y!, "base64url"))],
      ]);
      const authData = Buffer.concat([
        sha256(rp.id),
        Buffer.from([flagsUpUv | 0x40]),
        u32(counter),
        Buffer.alloc(16),
        Buffer.from([credentialId.length >> 8, credentialId.length & 255]),
        credentialId,
        Buffer.from(cbor(cose)),
      ]);
      const attestationObject = Buffer.from(cbor({ fmt: "none", attStmt: new Map(), authData: new Uint8Array(authData) }));
      return {
        id,
        rawId: id,
        type: "public-key",
        clientExtensionResults: {},
        response: {
          clientDataJSON: clientData("webauthn.create", challenge).toString("base64url"),
          attestationObject: attestationObject.toString("base64url"),
          transports: ["internal"],
        },
      };
    },
    /** Sign an assertion. `origin` lets a test pretend to be a phishing site. */
    assert(challenge: string, origin?: string): AuthenticationResponseJSON {
      counter += 1;
      const authData = Buffer.concat([sha256(rp.id), Buffer.from([flagsUpUv]), u32(counter)]);
      const cd = clientData("webauthn.get", challenge, origin);
      const signature = sign("sha256", Buffer.concat([authData, sha256(cd)]), privateKey);
      return {
        id,
        rawId: id,
        type: "public-key",
        clientExtensionResults: {},
        response: {
          clientDataJSON: cd.toString("base64url"),
          authenticatorData: authData.toString("base64url"),
          signature: signature.toString("base64url"),
        },
      };
    },
  };
}
