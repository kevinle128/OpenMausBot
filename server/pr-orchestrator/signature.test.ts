import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { checkSignatureHeaders, signBatch, verifyBatchSignature } from "./signature.ts";

const key = Buffer.from("fake-signature-key-for-tests-only");
const body = Buffer.from('{"v":1,"events":[]}');
const nowMs = 1_800_000_000_000;
const ts = String(nowMs / 1000);
const verify = (over: Partial<Parameters<typeof verifyBatchSignature>[0]> = {}) =>
  verifyBatchSignature({ key, timestamp: ts, signature: signBatch(key, ts, body), body, nowMs, toleranceSeconds: 300, ...over });

describe("batch signature", () => {
  it("accepts the signature the hub's sink makes", () => {
    const hubSignature = `sha256=${createHmac("sha256", key).update(`${ts}.${body.toString()}`).digest("hex")}`;
    expect(signBatch(key, ts, body)).toBe(hubSignature);
    expect(verify({ signature: hubSignature })).toEqual({ ok: true });
  });

  it("refuses a signature over a body that differs by one byte", () => {
    const changed = Buffer.from('{"v":1,"events":[ ]}');
    expect(verify({ body: changed }).ok).toBe(false);
    expect(verify({ key: Buffer.from("another-fake-key-for-tests-only!") }).ok).toBe(false);
  });

  it("refuses a timestamp outside the tolerance in either direction", () => {
    for (const offset of [-301, 301]) {
      const stamp = String(nowMs / 1000 + offset);
      expect(verify({ timestamp: stamp, signature: signBatch(key, stamp, body) })).toEqual({ ok: false, reason: "timestamp outside the tolerance" });
    }
    const edge = String(nowMs / 1000 - 300);
    expect(verify({ timestamp: edge, signature: signBatch(key, edge, body) })).toEqual({ ok: true });
  });

  it("refuses missing headers, upper-case hex and a malformed timestamp", () => {
    const good = signBatch(key, ts, body);
    expect(checkSignatureHeaders(undefined, good, nowMs, 300).ok).toBe(false);
    expect(checkSignatureHeaders(ts, undefined, nowMs, 300).ok).toBe(false);
    expect(checkSignatureHeaders(ts, `sha256=${good.slice(7).toUpperCase()}`, nowMs, 300).ok).toBe(false);
    expect(checkSignatureHeaders(ts, good.slice(7), nowMs, 300).ok).toBe(false);
    for (const stamp of ["", "-1", "1.5", "1e9", "1234567890123", " 1"]) expect(checkSignatureHeaders(stamp, good, nowMs, 300).ok).toBe(false);
  });
});
