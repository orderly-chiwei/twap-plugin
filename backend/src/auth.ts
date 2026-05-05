import { signAsync, getPublicKeyAsync } from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";
import * as ed from "@noble/ed25519";
import bs58 from "bs58";

// ed25519 requires sha512 sync setup
ed.etc.sha512Sync = (...m) => {
  const h = sha512.create();
  for (const msg of m) h.update(msg);
  return h.digest();
};

export interface OrderlyAuth {
  accountId: string;
  publicKey: string; // "ed25519:..."
  privateKeyHex: string;
}

/**
 * Create auth from user-provided credentials.
 */
export async function createAuth(accountId: string, secretKeyRaw: string): Promise<OrderlyAuth> {
  // Accept both "ed25519:xxxxx" and plain bs58 formats
  const secretKeyBs58 = secretKeyRaw.replace(/^ed25519:/, "");
  const privateKeyBytes = bs58.decode(secretKeyBs58);
  const privateKeyHex = Buffer.from(privateKeyBytes).toString("hex");
  const pubKeyBytes = await getPublicKeyAsync(privateKeyHex);
  const publicKey = `ed25519:${bs58.encode(pubKeyBytes)}`;

  return { accountId, publicKey, privateKeyHex };
}

/**
 * Sign an HTTP request and return the required Orderly headers.
 *
 * Message format: `{timestamp}{METHOD}{path}{search}{body}`
 */
export async function signRequest(
  auth: OrderlyAuth,
  method: string,
  url: URL,
  body?: string
): Promise<Record<string, string>> {
  const timestamp = Date.now();
  let message = `${timestamp}${method}${url.pathname}${url.search}`;
  if (body) message += body;

  const encoded = new TextEncoder().encode(message);
  const signature = await signAsync(encoded, auth.privateKeyHex);
  const signatureBase64 = Buffer.from(signature).toString("base64url");

  return {
    "Content-Type":
      method === "GET" || method === "DELETE"
        ? "application/x-www-form-urlencoded"
        : "application/json",
    "orderly-timestamp": String(timestamp),
    "orderly-account-id": auth.accountId,
    "orderly-key": auth.publicKey,
    "orderly-signature": signatureBase64,
  };
}
