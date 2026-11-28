/**
 * Embed request retry behavior: transient connection errors (ECONNRESET)
 * get more attempts than HTTP error statuses, requests no longer force a
 * Connection header, and the run still fails once attempts run out.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { RemoteLLM } from "./llm.js";

let originalFetch: typeof globalThis.fetch;
let fetchBehavior: (call: number) => Response | Promise<Response>;
let calls: number;
let sentConnection: string | null;

beforeEach(() => {
  calls = 0;
  sentConnection = null;
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    calls += 1;
    sentConnection = new Headers(init?.headers).get("connection");
    return fetchBehavior(calls);
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function embedLLM() {
  return new RemoteLLM({
    rerankProvider: "openai",
    embedProvider: "openai",
    openai: { apiKey: "sk-test", baseUrl: "https://emrank.tech/v1" },
  });
}

const embeddingsOk = () =>
  new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const econnreset = () =>
  Promise.reject(new Error("ECONNRESET: The socket connection was closed unexpectedly"));

describe("embed fetch retry", () => {
  test("transient ECONNRESET is retried and embed still succeeds", async () => {
    fetchBehavior = (n) => (n <= 3 ? econnreset() : embeddingsOk());

    const out = await embedLLM().embed("hello");

    expect(calls).toBe(4);
    expect(out?.embedding).toEqual([0.1, 0.2, 0.3]);
  }, 20_000);

  test("persistent ECONNRESET fails after 5 fetch attempts", async () => {
    fetchBehavior = econnreset;

    await expect(embedLLM().embed("hello")).rejects.toThrow("ECONNRESET");
    expect(calls).toBe(5);
  }, 20_000);

  test("embed requests do not force a Connection header", async () => {
    fetchBehavior = embeddingsOk;

    await embedLLM().embed("hello");

    expect(sentConnection).toBeNull();
  });
});
