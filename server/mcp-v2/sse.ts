export interface SseFrame {
  event: string | null;
  data: string;
}

/** Splits an SSE byte stream into frames. Comment lines and frames without data are dropped; a frame the stream ends in the middle of is dropped too. */
export async function* readSseFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<SseFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let event: string | null = null;
  let data: string[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      pending += decoder.decode(value, { stream: true });
      let newline = pending.search(/\r\n|\n|\r/);
      while (newline !== -1) {
        const lineEnd = pending[newline] === "\r" && pending[newline + 1] === "\n" ? newline + 2 : newline + 1;
        if (pending[newline] === "\r" && lineEnd === pending.length) break;
        const line = pending.slice(0, newline);
        pending = pending.slice(lineEnd);
        if (line === "") {
          if (data.length > 0) yield { event, data: data.join("\n") };
          event = null;
          data = [];
        } else if (!line.startsWith(":")) {
          const colon = line.indexOf(":");
          const field = colon === -1 ? line : line.slice(0, colon);
          const raw = colon === -1 ? "" : line.slice(colon + 1);
          const content = raw.startsWith(" ") ? raw.slice(1) : raw;
          if (field === "data") data.push(content);
          else if (field === "event") event = content;
        }
        newline = pending.search(/\r\n|\n|\r/);
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
