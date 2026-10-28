/**
 * Query-expansion routing: an explicit "none" must really mean off.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createLLMService } from "./app/services/llm-service.js";
import { RemoteLLM } from "./llm.js";
import { expandQuery as storeExpandQuery } from "./store.js";

const ENV_KEYS = [
  "QMD_SILICONFLOW_API_KEY",
  "QMD_SILICONFLOW_BASE_URL",
  "QMD_OPENAI_API_KEY",
  "QMD_OPENAI_MODEL",
  "QMD_OPENAI_BASE_URL",
  "QMD_GEMINI_API_KEY",
  "QMD_DASHSCOPE_API_KEY",
  "QMD_QUERY_EXPANSION_PROVIDER",
  "QMD_RERANK_MODE",
] as const;

let savedEnv: Record<string, string | undefined> = {};
let originalFetch: typeof globalThis.fetch;
let calls: { url: string; body: any }[] = [];

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  calls = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "lex: a b\nvec: c d\nhyde: e" } }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe("query expansion provider selection", () => {
  test("provider=none keeps expansion lexical even with a SiliconFlow key", async () => {
    process.env.QMD_SILICONFLOW_API_KEY = "sk-test";
    process.env.QMD_QUERY_EXPANSION_PROVIDER = "none";

    const llm = createLLMService();
    const out = await llm.expandQuery("find my notes", { includeLexical: true });

    expect(out).toEqual([{ type: "lex", text: "find my notes" }]);
    expect(calls.length).toBe(0);
  });

  test("a SiliconFlow key alone routes expansion to the GLM fallback model", async () => {
    process.env.QMD_SILICONFLOW_API_KEY = "sk-test";

    const llm = createLLMService();
    await llm.expandQuery("find my notes", { includeLexical: true });

    expect(calls.length).toBe(1);
    expect(calls[0]?.body.model).toBe("zai-org/GLM-4.5-Air");
  });

  test("provider=openai with QMD_OPENAI_MODEL sends that model instead", async () => {
    process.env.QMD_SILICONFLOW_API_KEY = "sk-test";
    process.env.QMD_OPENAI_API_KEY = "sk-test";
    process.env.QMD_QUERY_EXPANSION_PROVIDER = "openai";
    process.env.QMD_OPENAI_MODEL = "Qwen/Qwen3-8B";

    const llm = createLLMService();
    await llm.expandQuery("find my notes", { includeLexical: true });

    expect(calls.length).toBe(1);
    expect(calls[0]?.body.model).toBe("Qwen/Qwen3-8B");
  });

  test("an unknown provider value counts as none and makes no call", async () => {
    process.env.QMD_SILICONFLOW_API_KEY = "sk-test";
    process.env.QMD_QUERY_EXPANSION_PROVIDER = "silicoflow";

    const llm = createLLMService();
    const out = await llm.expandQuery("find my notes", { includeLexical: true });

    expect(out).toEqual([{ type: "lex", text: "find my notes" }]);
    expect(calls.length).toBe(0);
  });

  test("a blank provider value counts as off, not as unset", async () => {
    process.env.QMD_SILICONFLOW_API_KEY = "sk-test";
    process.env.QMD_QUERY_EXPANSION_PROVIDER = "   ";

    const llm = createLLMService();
    const out = await llm.expandQuery("find my notes", { includeLexical: true });

    expect(out).toEqual([{ type: "lex", text: "find my notes" }]);
    expect(calls.length).toBe(0);
  });

  test("an absent provider variable still auto-picks from the key", async () => {
    process.env.QMD_SILICONFLOW_API_KEY = "sk-test";
    delete process.env.QMD_QUERY_EXPANSION_PROVIDER;

    const llm = createLLMService();
    await llm.expandQuery("find my notes", { includeLexical: true });

    expect(calls.length).toBe(1);
    expect(calls[0]?.body.model).toBe("zai-org/GLM-4.5-Air");
  });

  test("the store path skips its cache when expansion is off, not just the network", async () => {
    process.env.QMD_QUERY_EXPANSION_PROVIDER = "none";
    // A bare database has no llm_cache table, so reading the cache would throw.
    const db = new Database(":memory:");

    const out = await storeExpandQuery("find my notes", undefined, db);

    expect(out).toEqual(["find my notes"]);
    db.close();
  });

  test("RemoteLLM honours the disable flag itself, so the store path stays lexical", async () => {
    const remote = new RemoteLLM({
      rerankProvider: "siliconflow",
      queryExpansionDisabled: true,
      siliconflow: { apiKey: "sk-test" },
    });

    const out = await remote.expandQuery("find my notes", { includeLexical: true });

    expect(out).toEqual([{ type: "lex", text: "find my notes" }]);
    expect(calls.length).toBe(0);
  });
});
