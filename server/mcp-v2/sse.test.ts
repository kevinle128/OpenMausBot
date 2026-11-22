import { expect, it } from "vitest";
import { readSseFrames, type SseFrame } from "./sse.ts";

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect(chunks: string[]): Promise<SseFrame[]> {
  const frames: SseFrame[] = [];
  for await (const frame of readSseFrames(streamOf(chunks))) frames.push(frame);
  return frames;
}

it("parses frames split across chunks and ignores comment lines", async () => {
  const frames = await collect([": keep-alive\n\nda", "ta: {\"a\":1}\n\nevent: ping\r", "\ndata: one\ndata: two\r\n\r\n", "data: unfinished"]);
  expect(frames).toEqual([
    { event: null, data: '{"a":1}' },
    { event: "ping", data: "one\ntwo" },
  ]);
});

it("splits a multi-byte character that spans two chunks", async () => {
  const bytes = new TextEncoder().encode("data: xin chào\n\n");
  const cut = bytes.indexOf(0xc3) + 1;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.slice(0, cut));
      controller.enqueue(bytes.slice(cut));
      controller.close();
    },
  });
  const frames: SseFrame[] = [];
  for await (const frame of readSseFrames(stream)) frames.push(frame);
  expect(frames).toEqual([{ event: null, data: "xin chào" }]);
});
