import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = vi.hoisted(() => vi.fn());
vi.mock("@/state/store", () => ({ api: apiMock }));

const { parseEnv, revealSecret } = await import("./vault");

beforeEach(() => { apiMock.mockReset(); });

describe("a pasted .env file", () => {
  it("keeps each NAME=value line, dropping export, quotes, comments and empty values; a later line wins", () => {
    expect(parseEnv([
      "# Stripe",
      "export STRIPE_SECRET_KEY=sk_test_fake-1   # test mode",
      "NOTION_TOKEN=\"fake \\\"two\\\"\\nline\"",
      "SINGLE='a # b'",
      "EMPTY=",
      "not a line",
      "  SPACED = fake-3  ",
      "STRIPE_SECRET_KEY=sk_test_fake-4",
    ].join("\r\n"))).toEqual([
      { name: "STRIPE_SECRET_KEY", value: "sk_test_fake-4" },
      { name: "NOTION_TOKEN", value: "fake \"two\"\nline" },
      { name: "SINGLE", value: "a # b" },
      { name: "SPACED", value: "fake-3" },
    ]);
  });
});

describe("revealSecret", () => {
  it("posts to the id-scoped vault reveal route and returns the secret value", async () => {
    apiMock.mockResolvedValueOnce({ value: "sk_live_fake" });
    await expect(revealSecret("sec/1")).resolves.toBe("sk_live_fake");
    expect(apiMock).toHaveBeenCalledWith("/api/vault/secrets/sec%2F1/reveal", { method: "POST", body: "{}" });
  });

  it("throws when the server answer has no string value", async () => {
    apiMock.mockResolvedValueOnce({});
    await expect(revealSecret("s1")).rejects.toThrow("Could not read secret");
  });
});
