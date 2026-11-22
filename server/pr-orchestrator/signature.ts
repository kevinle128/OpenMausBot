import { createHmac, timingSafeEqual } from "node:crypto";

const TIMESTAMP = /^\d{1,12}$/;
const SIGNATURE = /^sha256=[0-9a-f]{64}$/;

export type SignatureCheck = { ok: true } | { ok: false; reason: string };

function mac(key: Buffer, timestamp: string, body: Buffer): Buffer {
  return createHmac("sha256", key).update(Buffer.from(`${timestamp}.`)).update(body).digest();
}

/** The `X-Omb-Signature` value of a batch, as the hub's `omb` sink makes it. */
export function signBatch(key: Buffer, timestamp: string, body: Buffer): string {
  return `sha256=${mac(key, timestamp, body).toString("hex")}`;
}

/** Checks the header shapes and the clock only; it needs neither the body nor the key. */
export function checkSignatureHeaders(timestamp: string | undefined, signature: string | undefined, nowMs: number, toleranceSeconds: number): SignatureCheck {
  if (!timestamp || !TIMESTAMP.test(timestamp)) return { ok: false, reason: "missing or malformed timestamp" };
  if (!signature || !SIGNATURE.test(signature)) return { ok: false, reason: "missing or malformed signature" };
  if (Math.abs(nowMs / 1000 - Number(timestamp)) > toleranceSeconds) return { ok: false, reason: "timestamp outside the tolerance" };
  return { ok: true };
}

export function verifyBatchSignature(input: {
  key: Buffer; timestamp: string | undefined; signature: string | undefined; body: Buffer; nowMs: number; toleranceSeconds: number;
}): SignatureCheck {
  const headers = checkSignatureHeaders(input.timestamp, input.signature, input.nowMs, input.toleranceSeconds);
  if (!headers.ok) return headers;
  const expected = Buffer.from(signBatch(input.key, input.timestamp!, input.body));
  const given = Buffer.from(input.signature!);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { ok: false, reason: "signature does not match" };
  return { ok: true };
}
