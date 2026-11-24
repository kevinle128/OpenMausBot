import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readConnectorSecret, writeConnectorSecret } from "./connector-secrets.ts";

const dirs: string[] = [];
const tempPath = () => {
  const dir = mkdtempSync(join(tmpdir(), "omb-conn-secrets-"));
  dirs.push(dir);
  return join(dir, "pr-orchestrator-secrets.json");
};

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("connector-secrets", () => {
  it("stores, trims, isolates, and deletes secrets with 0600 permissions", () => {
    const file = tempPath();
    expect(readConnectorSecret(file, "github-event")).toBeNull();

    writeConnectorSecret(file, "github-event", "  secret-one  ");
    writeConnectorSecret(file, "gitlab-event", "secret-two");
    expect(readConnectorSecret(file, "github-event")).toBe("secret-one");
    expect(readConnectorSecret(file, "gitlab-event")).toBe("secret-two");
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);

    writeConnectorSecret(file, "github-event", "");
    expect(readConnectorSecret(file, "github-event")).toBeNull();
    expect(readConnectorSecret(file, "gitlab-event")).toBe("secret-two");
  });

  it("returns null on malformed file", () => {
    const file = tempPath();
    writeFileSync(file, "{not json", "utf8");
    expect(readConnectorSecret(file, "github-event")).toBeNull();
  });
});
