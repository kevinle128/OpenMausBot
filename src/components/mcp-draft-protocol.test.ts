import { describe, expect, it } from "vitest";

import { draftBody, draftFor, emptyDraft, secretRow, soleKey, type McpServerListing } from "./mcp-draft";

const listing = (extra: Record<string, unknown> = {}): McpServerListing => ({
  name: "archon", type: "http", url: "https://archon.example.com/mcp", headerKeys: [], enabled: true, ...extra,
}) as McpServerListing;

describe("the protocol of a connection in the editor", () => {
  it("keeps a legacy entry's body unchanged", () => {
    const draft = { ...draftFor(listing()), headers: [secretRow({ name: "Authorization", value: "Bearer k" })] };
    const body = draftBody(draft, listing());
    expect(body).toEqual({ ok: true, body: { type: "http", url: "https://archon.example.com/mcp", headers: { Authorization: "Bearer k" } } });
  });

  it("saves a v2 entry as streamable HTTP with no sign-in", () => {
    const draft = { ...emptyDraft(), name: "archon", url: "https://archon.example.com/mcp", type: "sse" as const, protocol: "v2" as const, oauthClientId: "abc" };
    const body = draftBody(draft, undefined);
    expect(body).toEqual({ ok: true, body: { type: "http", protocol: "v2", url: "https://archon.example.com/mcp", headers: {} } });
    expect(soleKey({ ...draft, headers: [secretRow({ name: "Authorization", value: "Bearer k" })] })).toBeNull();
  });

  it("says legacy when a saved v2 entry goes back to Standard", () => {
    const saved = listing({ protocol: "v2", ombOnly: true });
    const draft = { ...draftFor(saved), protocol: "legacy" as const };
    expect(draftFor(saved).protocol).toBe("v2");
    expect(draftBody(draft, saved)).toEqual({ ok: true, body: { type: "http", protocol: "legacy", url: "https://archon.example.com/mcp", headers: {} } });
  });
});
