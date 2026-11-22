import { describe, expect, it } from "vitest";
import { parsePrUrl } from "./pr-url.ts";

const HOSTS = ["git.oceanlabs.dev"];

describe("parsePrUrl", () => {
  it("reads a GitHub PR and a GitLab MR on the configured host", () => {
    expect(parsePrUrl("https://github.com/Acme/Widgets/pull/42", HOSTS)).toEqual({ provider: "github", repo: "Acme/Widgets", number: 42, url: "https://github.com/Acme/Widgets/pull/42" });
    expect(parsePrUrl("https://github.com/acme/widgets/pull/7/files#diff", HOSTS)?.url).toBe("https://github.com/acme/widgets/pull/7");
    expect(parsePrUrl("https://git.oceanlabs.dev/team/sub/app/-/merge_requests/9?tab=notes", HOSTS)).toEqual({
      provider: "gitlab", repo: "team/sub/app", number: 9, url: "https://git.oceanlabs.dev/team/sub/app/-/merge_requests/9",
    });
  });

  it("ignores issues, other hosts and malformed numbers", () => {
    expect(parsePrUrl("https://github.com/acme/widgets/issues/3", HOSTS)).toBeNull();
    expect(parsePrUrl("https://evil.example/acme/widgets/pull/3", HOSTS)).toBeNull();
    expect(parsePrUrl("https://other.dev/team/app/-/merge_requests/3", HOSTS)).toBeNull();
    expect(parsePrUrl("https://github.com/acme/widgets/pull/0", HOSTS)).toBeNull();
    expect(parsePrUrl("https://github.com/acme/widgets/pull/abc", HOSTS)).toBeNull();
    expect(parsePrUrl("http://github.com/acme/widgets/pull/3", HOSTS)).toBeNull();
    expect(parsePrUrl("https://user:pw@github.com/acme/widgets/pull/3", HOSTS)).toBeNull();
    expect(parsePrUrl("not a url", HOSTS)).toBeNull();
  });
});
