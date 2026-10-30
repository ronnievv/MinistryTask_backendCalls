import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * AES-256-GCM envelope for provider credentials at rest.
 * Format: v1:<keyId>:<iv b64url>:<tag b64url>:<ciphertext b64url>
 * `context` is bound as AAD (e.g. "<connectionId>:refresh_token"), so a ciphertext copied
 * into another row or column fails to decrypt instead of silently working.
 */
export class TokenCipher {
  private readonly keys = new Map<string, Buffer>();

  constructor(
    private readonly currentKeyId: string,
    currentKeyB64: string,
    previous?: { id: string; keyB64: string },
  ) {
    this.keys.set(currentKeyId, decodeKey(currentKeyB64));
    if (previous?.id && previous.keyB64) this.keys.set(previous.id, decodeKey(previous.keyB64));
  }

  get keyId(): string {
    return this.currentKeyId;
  }

  encrypt(plaintext: string, context: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.keys.get(this.currentKeyId)!, iv);
    cipher.setAAD(Buffer.from(context, "utf8"));
    const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return ["v1", this.currentKeyId, b64(iv), b64(cipher.getAuthTag()), b64(ct)].join(":");
  }

  decrypt(envelope: string, context: string): string {
    const [version, keyId, iv, tag, ct] = envelope.split(":");
    if (version !== "v1" || !keyId || !iv || !tag || ct === undefined) throw new Error("Malformed ciphertext");
    const key = this.keys.get(keyId);
    if (!key) throw new Error(`No decryption key loaded for key id "${keyId}"`);
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
    decipher.setAAD(Buffer.from(context, "utf8"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(ct, "base64url")), decipher.final()]).toString("utf8");
  }

  /** True if this envelope was written with a key other than the current one (re-encrypt it). */
  needsRotation(envelope: string): boolean {
    return envelope.split(":")[1] !== this.currentKeyId;
  }
}

function decodeKey(b64key: string): Buffer {
  const key = Buffer.from(b64key, "base64");
  if (key.length !== 32) throw new Error("Encryption key must be 32 bytes");
  return key;
}

const b64 = (b: Buffer) => b.toString("base64url");

export const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");

/** Constant-time string comparison (hashes first so lengths never leak). */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}

export const randomUrlToken = (bytes = 32) => randomBytes(bytes).toString("base64url");

/** RFC 7636 S256 code challenge. */
export const pkceChallenge = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");
