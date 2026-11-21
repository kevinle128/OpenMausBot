import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";

type Frame = { type: string; message?: { type: string; requestId?: string; cwd?: string; path?: string } };

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

/** A daemon that completes the hello handshake and answers `fs.path.inspect.request` with `reply`. */
async function startDaemon(reply: (request: NonNullable<Frame["message"]>) => unknown) {
  const received: Array<NonNullable<Frame["message"]>> = [];
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  server.on("connection", (socket: WebSocket) => {
    socket.on("message", (raw) => {
      const frame = JSON.parse(String(raw)) as Frame;
      if (frame.type === "hello") {
        socket.send(JSON.stringify({ type: "session", message: { type: "status", payload: { status: "server_info", serverId: "fake-daemon", hostname: "fake" } } }));
      } else if (frame.type === "session" && frame.message?.type === "fs.path.inspect.request") {
        received.push(frame.message);
        socket.send(JSON.stringify({ type: "session", message: reply(frame.message) }));
      }
    });
  });
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws`;
  const client = new DaemonClient({ url, clientId: "omb-test", clientType: "cli", reconnect: { enabled: false } });
  closers.push(async () => {
    await client.close();
    server.clients.forEach((socket) => socket.terminate());
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  await client.connect();
  return { client, received };
}

const answer = (request: NonNullable<Frame["message"]>, fields: Record<string, unknown>) => ({
  type: "fs.path.inspect.response",
  payload: { cwd: request.cwd, path: request.path, exists: true, kind: "file", size: 12, error: null, requestId: request.requestId, ...fields },
});

describe("DaemonClient.inspectPath (patched @getpaseo/client)", () => {
  it("sends fs.path.inspect.request with the cwd and path and resolves with the daemon's answer", async () => {
    const { client, received } = await startDaemon((request) => answer(request, { kind: "symlink", size: null }));
    const result = await client.inspectPath("/work/app", "keys/server.pem", { timeout: 2_000 });
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ type: "fs.path.inspect.request", cwd: "/work/app", path: "keys/server.pem" });
    expect(received[0]?.requestId).toEqual(expect.any(String));
    expect(result).toEqual({ cwd: "/work/app", path: "keys/server.pem", exists: true, kind: "symlink", size: null, error: null, requestId: received[0]?.requestId });
  });

  it("reports a missing path", async () => {
    const { client } = await startDaemon((request) => answer(request, { exists: false, kind: null, size: null }));
    await expect(client.inspectPath("/work/app", "gone.txt", { timeout: 2_000 })).resolves.toMatchObject({ exists: false, kind: null });
  });

  it("rejects an answer that does not match the response shape", async () => {
    const { client } = await startDaemon((request) => answer(request, { kind: "socket" }));
    await expect(client.inspectPath("/work/app", "x", { timeout: 2_000 })).rejects.toThrow();
  });

  it("rejects when the daemon does not answer in time", async () => {
    const { client } = await startDaemon(() => ({ type: "pong" }));
    await expect(client.inspectPath("/work/app", "x", { timeout: 150 })).rejects.toThrow();
  });
});
