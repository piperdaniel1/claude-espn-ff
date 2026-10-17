import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export function base64url(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf.toString("base64url");
}

export function fromBase64url(input: string): Buffer {
  return Buffer.from(input, "base64url");
}

export function sha256Base64url(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("base64url");
}

export function hmacBase64url(secret: string, data: string): string {
  return createHmac("sha256", secret).update(data, "utf8").digest("base64url");
}

export function randomId(bytes = 16): string {
  return randomBytes(bytes).toString("base64url");
}

export function timingSafeEqualString(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) {
    // Compare against self to keep timing roughly constant, then fail.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/**
 * Compact signed token: base64url(JSON payload) + "." + base64url(HMAC-SHA256).
 * Stateless, so a serverless function can verify it without a database.
 */
export function signPayload(secret: string, payload: Record<string, unknown>): string {
  const body = base64url(JSON.stringify(payload));
  return `${body}.${hmacBase64url(secret, body)}`;
}

export function verifyPayload<T = Record<string, unknown>>(secret: string, token: string): T | null {
  if (typeof token !== "string") return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!/^[A-Za-z0-9_-]+$/.test(body) || !/^[A-Za-z0-9_-]+$/.test(sig)) return null;
  const expected = hmacBase64url(secret, body);
  if (!timingSafeEqualString(expected, sig)) return null;
  try {
    const parsed: unknown = JSON.parse(fromBase64url(body).toString("utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as T;
  } catch {
    return null;
  }
}
