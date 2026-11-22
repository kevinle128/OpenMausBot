import { describe, expect, it } from "vitest";
import { anyGlob, globMatch } from "./glob.ts";

describe("globMatch", () => {
  it("stops a single star at a slash and lets a double star cross it", () => {
    expect(globMatch("acme/*", "acme/widgets")).toBe(true);
    expect(globMatch("acme/*", "acme/team/widgets")).toBe(false);
    expect(globMatch("acme/**", "acme/team/widgets")).toBe(true);
    expect(globMatch("**/widgets", "acme/team/widgets")).toBe(true);
  });

  it("ignores case", () => {
    expect(globMatch("Acme/Widgets", "acme/widgets")).toBe(true);
    expect(globMatch("acme/widgets", "ACME/WIDGETS")).toBe(true);
  });

  it("reads brackets and other regex characters as literal text", () => {
    expect(globMatch("*[bot]", "ocr-serve[bot]")).toBe(true);
    expect(globMatch("*[bot]", "ocr-bot")).toBe(false);
    expect(globMatch("a.b", "axb")).toBe(false);
    expect(globMatch("a+b", "a+b")).toBe(true);
    expect(globMatch("(a|b)", "a")).toBe(false);
  });

  it("matches the whole text only", () => {
    expect(globMatch("acme", "acme/widgets")).toBe(false);
    expect(globMatch("widgets", "acme/widgets")).toBe(false);
  });
});

describe("anyGlob", () => {
  it("is true when one pattern matches and false for an empty list", () => {
    expect(anyGlob(["other/*", "acme/*"], "acme/widgets")).toBe(true);
    expect(anyGlob(["other/*"], "acme/widgets")).toBe(false);
    expect(anyGlob([], "acme/widgets")).toBe(false);
  });
});
