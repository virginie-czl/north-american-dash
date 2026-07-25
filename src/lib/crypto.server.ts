/**
 * Authenticated symmetric encryption for credentials at rest (server-only).
 *
 * Google refresh tokens are long-lived keys to a person's mailbox, so they are
 * never stored in clear text: a database dump alone must not grant mailbox access.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;

function key(): Buffer {
  const secret = process.env.TOKEN_ENCRYPTION_KEY;
  if (!secret) {
    throw new Error(
      "TOKEN_ENCRYPTION_KEY is not set — required to store Gmail credentials. " +
        "Generate one with: openssl rand -base64 32",
    );
  }
  // Accept any passphrase length; derive a fixed 32-byte key from it.
  return createHash("sha256").update(secret).digest();
}

/** Returns "iv.ciphertext.tag", all base64url. */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [iv, enc, cipher.getAuthTag()].map((b) => b.toString("base64url")).join(".");
}

export function decryptSecret(payload: string): string {
  const [ivB64, dataB64, tagB64] = payload.split(".");
  if (!ivB64 || !dataB64 || !tagB64) throw new Error("Malformed encrypted payload");
  const decipher = createDecipheriv(ALGORITHM, key(), Buffer.from(ivB64, "base64url"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
