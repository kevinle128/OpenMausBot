import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];

vi.mock("./connection.ts", () => ({
  PaseoConnection: class {
    on() {}
    start() {
      calls.push("connection start");
    }
    async stop() {
      calls.push("connection stop");
    }
  },
}));
vi.mock("./gatekeeper.ts", () => ({
  startPaseoGatekeeper: () => {
    calls.push("gatekeeper start");
    return () => calls.push("gatekeeper stop");
  },
}));
vi.mock("./dispatcher-wake.ts", () => ({
  startDispatcherWake: () => {
    calls.push("wake start");
    return () => calls.push("wake stop");
  },
}));
vi.mock("../ak/start.ts", () => ({
  startAkBridge: () => {
    calls.push("ak start");
    return () => calls.push("ak stop");
  },
}));

const { startPaseoBridge } = await import("./bridge.ts");

const wiring = { store: {}, approvals: {}, decider: {}, notify: () => {}, screenLocked: async () => false, ak: { vault: {}, dataDir: "/tmp" }, dispatcher: { store: {}, wake: () => {} } } as never;

describe("startPaseoBridge", () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it("is off unless OMB_PASEO_BRIDGE is 1", () => {
    expect(startPaseoBridge({}, wiring)).toBeNull();
    expect(calls).toEqual([]);
  });

  it("stops every listener it started, then the connection, and only once", async () => {
    const bridge = startPaseoBridge({ OMB_PASEO_BRIDGE: "1" }, wiring)!;
    expect(calls).toEqual(["gatekeeper start", "wake start", "ak start", "connection start"]);
    calls.length = 0;
    await bridge.stop();
    expect(calls).toEqual(["ak stop", "wake stop", "gatekeeper stop", "connection stop"]);
    calls.length = 0;
    await bridge.stop();
    expect(calls).toEqual(["connection stop"]);
  });

  it("starts only the gatekeeper when no ak or Dispatcher wiring is given", async () => {
    const bridge = startPaseoBridge({ OMB_PASEO_BRIDGE: "1" }, { ...(wiring as object), ak: undefined, dispatcher: undefined } as never)!;
    expect(calls).toEqual(["gatekeeper start", "connection start"]);
    await bridge.stop();
    expect(calls.at(-1)).toBe("connection stop");
  });
});
