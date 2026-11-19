// Fixtures for the omb command line tests: a local HTTP stub standing in for the OpenMausBot server, a fake process
// table for the identity walk, and in-memory output streams.
import { createServer, type IncomingHttpHeaders } from "node:http";
import { Writable } from "node:stream";

import type { Deps } from "../../bin/omb.mjs";

export interface StubRequest { method: string; path: string; headers: IncomingHttpHeaders; body: any }
export interface StubAnswer { status?: number; json?: unknown; text?: string }
export type StubHandler = (request: StubRequest, all: StubRequest[]) => StubAnswer | Promise<StubAnswer>;

export async function startStub(handler: StubHandler): Promise<{ url: string; requests: StubRequest[]; close: () => Promise<void> }> {
  const requests: StubRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", async () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: any = raw;
      try { body = raw ? JSON.parse(raw) : undefined; } catch { /* kept as text */ }
      const request = { method: req.method ?? "", path: req.url ?? "", headers: req.headers, body };
      requests.push(request);
      const answer = await handler(request, requests);
      res.writeHead(answer.status ?? 200, { "content-type": "application/json" });
      res.end(answer.text ?? JSON.stringify(answer.json ?? {}));
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`, requests,
    close: () => new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()); }),
  };
}

export const envelope = (kind: string, data: unknown) => ({ schema_version: 1, kind, data });
export const failure = (exit_code: number, error_code: string, error: string) => ({ schema_version: 1, error, error_code, exit_code });

export function memoryOutput() {
  const chunks: Buffer[] = [];
  const stream = new Writable({ write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); } });
  return { stream, text: () => Buffer.concat(chunks).toString("utf8"), bytes: () => Buffer.concat(chunks) };
}

export interface FakeProcess { ppid: number; comm: string; args?: string }

/** The `ps` of a process table: `ps -o ppid=,comm= -p N` and `ps -ww -o args= -p N`. */
export function fakePs(table: Record<number, FakeProcess>): Deps["ps"] {
  return async (args) => {
    const pid = Number(args[args.length - 1]);
    const row = table[pid];
    if (!row) throw new Error("no such process");
    return args.includes("args=") ? `${row.args ?? row.comm}\n` : ` ${row.ppid} ${row.comm}\n`;
  };
}
