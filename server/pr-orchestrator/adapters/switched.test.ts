import { describe, expect, it } from "vitest";
import { orchestratorConfigSchema } from "../config.ts";
import { NotInstalledError, PortUnavailableError, type ForgePort, type NotifierPort, type OwnerResolver } from "../ports.ts";
import { creation, fakeRuntime, FAKE_OWNER } from "../testing/fake-runtime.ts";
import { recordingPorts } from "../testing/recording-ports.ts";
import { noneAttached, switchedPorts, type AttachedAdapters } from "./switched.ts";

function rig() {
  let doc: Record<string, unknown> = { enabled: true };
  let attached: AttachedAdapters = noneAttached();
  const recording = recordingPorts();
  const ports = switchedPorts(() => orchestratorConfigSchema.parse(doc), () => attached);
  return {
    ports, recording,
    config: (next: Record<string, unknown>) => { doc = { enabled: true, ...next }; },
    attach: (next: Partial<AttachedAdapters>) => { attached = { ...noneAttached(), ...next }; },
  };
}
const PR = { key: "github:acme/web#1", provider: "github", repo: "acme/web", number: 1, url: null, headSha: null, branch: null, baseRef: null } as const;

describe("switched ports", () => {
  it("uses the stub while a switch is off and the adapter once it is on, without a restart", async () => {
    const r = rig();
    const github: ForgePort = r.recording.ports.forge.github;
    const notifier: NotifierPort = r.recording.ports.notifier;
    const runtime = fakeRuntime();
    r.attach({ forge: { github }, notifier, runtime: runtime.port });

    expect(() => r.ports.forge.github.details(PR)).toThrow(NotInstalledError);
    expect(() => r.ports.notifier.notice("merged", "t", { key: PR.key, pr: PR, label: "l" })).toThrow(NotInstalledError);
    expect(() => r.ports.runtime.send(FAKE_OWNER, "m", { messageId: "i" })).toThrow(NotInstalledError);
    expect(r.ports.installed.forge("github")).toBe(false);
    expect(r.ports.installed.notifier).toBe(false);
    expect(r.ports.installed.runtime).toBe(false);

    r.config({ adapters: { forge: { github: { enabled: true } }, notifier: { enabled: true }, runtime: { enabled: true } } });
    await r.ports.forge.github.details(PR);
    await r.ports.notifier.notice("merged", "t", { key: PR.key, pr: PR, label: "l" });
    expect(await r.ports.runtime.send(FAKE_OWNER, "m", { messageId: "i" })).toBe("delivered");
    expect(r.recording.calls.map(call => `${call.port}.${call.method}`)).toEqual(["forge.github.details", "notifier.notice"]);
    expect(r.ports.installed.forge("github")).toBe(true);
    expect(r.ports.installed.forge("gitlab")).toBe(false);
    expect(r.ports.installed.notifier).toBe(true);
    expect(r.ports.installed.runtime).toBe(true);

    r.config({});
    expect(() => r.ports.forge.github.details(PR)).toThrow(NotInstalledError);
  });

  it("throws port unavailable while a switch is on and nothing is attached", async () => {
    const r = rig();
    r.config({ adapters: { forge: { github: { enabled: true }, gitlab: { enabled: true } }, notifier: { enabled: true }, runtime: { enabled: true } } });
    expect(() => r.ports.forge.github.details(PR)).toThrow(new PortUnavailableError("the GitHub adapter is not attached yet"));
    expect(() => r.ports.forge.gitlab.merge(PR, { method: "squash", expectedHeadSha: "a", deleteBranch: false })).toThrow(PortUnavailableError);
    expect(() => r.ports.notifier.card("decision", { subject: { key: PR.key, pr: PR, label: "l" }, title: "t", body: "b", decisionId: "d" }, [])).toThrow(PortUnavailableError);
    expect(() => r.ports.runtime.isAlive(FAKE_OWNER)).toThrow(PortUnavailableError);
    expect(r.ports.notifier.adopt?.("card", { kind: "decision", decisionId: "d", subject: { key: PR.key, pr: PR, label: "l" }, answers: [] })).toBe(false);
    expect(() => r.ports.notifier.reconcile?.(new Set())).not.toThrow();
  });

  it("hands the optional notifier methods to the attached notifier while its switch is on", () => {
    const r = rig();
    const adopted: string[] = [];
    const reconciled: string[][] = [];
    r.attach({ notifier: { ...r.recording.ports.notifier, adopt: cardId => { adopted.push(cardId); return true; }, reconcile: ids => { reconciled.push([...ids]); } } });
    const card: Parameters<NonNullable<NotifierPort["adopt"]>>[1] = { kind: "decision", decisionId: "d", subject: { key: PR.key, pr: PR, label: "l" }, answers: [] };
    expect(r.ports.notifier.adopt?.("c1", card)).toBe(false);
    r.config({ adapters: { notifier: { enabled: true } } });
    expect(r.ports.notifier.adopt?.("c1", card)).toBe(true);
    r.ports.notifier.reconcile?.(new Set(["d"]));
    expect(adopted).toEqual(["c1"]);
    expect(reconciled).toEqual([["d"]]);
  });

  it("gives no resolvers while the runtime switch is off", () => {
    const r = rig();
    const link: OwnerResolver = { name: "link", resolve: async () => "next" };
    r.attach({ resolvers: [link] });
    expect(r.ports.resolvers).toEqual([]);
    r.config({ adapters: { runtime: { enabled: true } } });
    expect(r.ports.resolvers).toEqual([link]);
  });

  it("drops creation reports while binding is off", () => {
    const r = rig();
    const runtime = fakeRuntime();
    r.attach({ runtime: runtime.port });
    const reports: string[] = [];
    const stop = r.ports.runtime.watchCreations(created => reports.push(created.pr.repo));
    expect(runtime.subscribers()).toBe(1);

    runtime.create(creation("github", "acme/off", 1));
    r.config({ adapters: { runtime: { enabled: true } } });
    runtime.create(creation("github", "acme/on", 2));
    r.config({ adapters: { runtime: { enabled: true, bindOwners: false } } });
    runtime.create(creation("github", "acme/binding-off", 3));
    r.config({ adapters: { runtime: { enabled: true, bindOwners: true } } });
    runtime.create(creation("github", "acme/on-again", 4));
    expect(reports).toEqual(["acme/on", "acme/on-again"]);

    stop();
    expect(runtime.subscribers()).toBe(0);
  });

  it("keeps the workflow and interpreter ports as stubs", () => {
    const r = rig();
    r.config({ adapters: { runtime: { enabled: true } } });
    expect(() => r.ports.workflows.cancel("run")).toThrow(NotInstalledError);
    expect(r.ports.interpreters).toEqual([]);
  });
});
