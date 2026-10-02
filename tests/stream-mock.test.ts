import { describe, it, expect, vi } from "vitest";

/**
 * Hermetic stream adapter smoke: verify mocked async iterator protocol
 * that our lazy kiro stream and providers rely on.
 */
describe("stream adapter mocks", () => {
  it("async iterator yields start then done", async () => {
    async function* fakeStream() {
      yield { type: "start" };
      yield { type: "text_delta", delta: "hi" };
      yield {
        type: "done",
        message: {
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        },
      };
    }

    const events: Array<{ type: string }> = [];
    for await (const ev of fakeStream()) events.push(ev);
    expect(events.map((e) => e.type)).toEqual(["start", "text_delta", "done"]);
    const done = events[2] as unknown as { message: { usage: { cacheRead: number; cacheWrite: number } } };
    expect(done.message.usage.cacheRead).toBe(0);
    expect(done.message.usage.cacheWrite).toBe(0);
  });

  it("lazy stream proxy forwards result()", async () => {
    const result = vi.fn(async () => ({ ok: true }));
    const streamPromise = Promise.resolve({
      async *[Symbol.asyncIterator]() {
        yield { type: "done" };
      },
      result,
      push() {},
      end() {},
    });
    const lazy = {
      async *[Symbol.asyncIterator]() {
        const s = await streamPromise;
        yield* s;
      },
      result: () => streamPromise.then((s) => s.result()),
    };
    expect(await lazy.result()).toEqual({ ok: true });
  });
});
