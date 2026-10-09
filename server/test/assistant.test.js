// OBULU AI assistant tests — plain node asserts, run with `npm test`.
// Gemini's HTTP layer is mocked; no network, no API key needed.
import assert from "node:assert";

process.env.GEMINI_API_KEY = "test-key";
process.env.GEMINI_MODEL = "test-model-a,test-model-b";

const {
  chatReplyStream,
  chatReply,
  buildSystemData,
  assistantModels,
  chatConfigured,
} = await import("../src/chat/assistant.js");

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (e) {
    console.error(`FAIL - ${name}: ${e.message}`);
    process.exitCode = 1;
  }
}

// --- Mock fetch ------------------------------------------------------------

const realFetch = globalThis.fetch;
let mockHandler = null;
globalThis.fetch = async (...args) => {
  if (!mockHandler) throw new Error("fetch not mocked");
  return mockHandler(...args);
};

function sseResponse(chunks, { splitEvery = 0 } = {}) {
  // chunks: array of SSE "data: {...}" payload strings (without the prefix).
  const text = chunks.map((c) => `data: ${c}\n\n`).join("");
  const bytes = new TextEncoder().encode(text);
  // Optionally split the byte stream into awkward pieces to test buffering.
  const pieces = [];
  if (splitEvery > 0) {
    for (let i = 0; i < bytes.length; i += splitEvery) {
      pieces.push(bytes.slice(i, i + splitEvery));
    }
  } else {
    pieces.push(bytes);
  }
  let i = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (i < pieces.length) controller.enqueue(pieces[i++]);
      else controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

const geminiChunk = (text) =>
  JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] });

const neverBody = new ReadableStream({
  start() {
    /* never produces: simulates a hang */
  },
});

// ---------------------------------------------------------------------------

await check("streams tokens progressively, even split across chunks", async () => {
  const seen = [];
  mockHandler = async () => sseResponse([geminiChunk("Hello "), geminiChunk("world")], { splitEvery: 7 });
  const r = await chatReplyStream({
    systemData: "DATA",
    history: [],
    userMessage: "hi",
    onToken: (d) => seen.push(d),
  });
  assert.strictEqual(r.text, "Hello world");
  assert.strictEqual(r.model, "test-model-a");
  assert.ok(seen.join("") === "Hello world", "tokens arrive progressively");
  assert.ok(typeof r.firstTokenMs === "number" && typeof r.totalMs === "number");
});

await check("falls back to next model on 404", async () => {
  let calls = 0;
  mockHandler = async (url) => {
    calls++;
    if (String(url).includes("test-model-a")) {
      return new Response("not found", { status: 404 });
    }
    return sseResponse([geminiChunk("from-b")]);
  };
  const r = await chatReplyStream({ systemData: "D", history: [], userMessage: "hi", onToken: () => {} });
  assert.strictEqual(r.text, "from-b");
  assert.strictEqual(r.model, "test-model-b");
  assert.strictEqual(calls, 2);
});

await check("retries transient 500 then succeeds (1 retry)", async () => {
  let calls = 0;
  mockHandler = async () => {
    calls++;
    if (calls < 2) return new Response("boom", { status: 500 });
    return sseResponse([geminiChunk("recovered")]);
  };
  const r = await chatReplyStream({ systemData: "D", history: [], userMessage: "hi", onToken: () => {} });
  assert.strictEqual(r.text, "recovered");
  assert.strictEqual(calls, 2, "1 initial + 1 retry");
});

await check("gives up after 2 attempts on persistent 500", async () => {
  let calls = 0;
  mockHandler = async () => {
    calls++;
    return new Response("boom", { status: 500 });
  };
  await assert.rejects(
    chatReplyStream({ systemData: "D", history: [], userMessage: "hi", onToken: () => {} }),
    (e) => e.code === "UPSTREAM"
  );
  assert.strictEqual(calls, 2);
});

await check("first-token timeout produces TIMEOUT", async () => {
  // A hanging stream that respects the abort signal, like real fetch does.
  mockHandler = async (_url, opts) => {
    const stream = new ReadableStream({
      start(c) {
        opts.signal?.addEventListener("abort", () => {
          try {
            c.error(new DOMException("Aborted", "AbortError"));
          } catch { /* ignore */ }
        });
      },
    });
    return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  };
  await assert.rejects(
    chatReplyStream({
      systemData: "D",
      history: [],
      userMessage: "hi",
      onToken: () => {},
      timeouts: { firstTokenMs: 50, totalMs: 5000 },
    }),
    (e) => e.code === "TIMEOUT"
  );
});

await check("empty stream produces EMPTY_RESPONSE", async () => {
  mockHandler = async () => sseResponse([]);
  await assert.rejects(
    chatReplyStream({ systemData: "D", history: [], userMessage: "hi", onToken: () => {} }),
    (e) => e.code === "EMPTY_RESPONSE"
  );
});

await check("abort signal produces CANCELLED", async () => {
  mockHandler = async (_url, opts) => {
    const stream = new ReadableStream({
      start(c) {
        opts.signal?.addEventListener("abort", () => {
          try {
            c.error(new DOMException("Aborted", "AbortError"));
          } catch { /* ignore */ }
        });
      },
    });
    return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  };
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 50);
  await assert.rejects(
    chatReplyStream({ systemData: "D", history: [], userMessage: "hi", onToken: () => {}, signal: ctrl.signal }),
    (e) => e.code === "CANCELLED"
  );
});

await check("429 maps to RATE_LIMITED", async () => {
  mockHandler = async () => new Response("slow down", { status: 429 });
  await assert.rejects(
    chatReplyStream({ systemData: "D", history: [], userMessage: "hi", onToken: () => {} }),
    (e) => e.code === "RATE_LIMITED"
  );
});

await check("per-IP rate limit trips after 20 messages", async () => {
  mockHandler = async () => sseResponse([geminiChunk("ok")]);
  const { assistantReplyStream } = await import("../src/chat/assistant.js");
  for (let i = 0; i < 20; i++) {
    await assistantReplyStream({ message: `m${i}`, history: [], ip: "rate-test-ip", onToken: () => {} });
  }
  await assert.rejects(
    assistantReplyStream({ message: "one more", history: [], ip: "rate-test-ip", onToken: () => {} }),
    (e) => e.code === "RATE_LIMITED"
  );
});

await check("page context injects real match data, skips fixtures fetch", async () => {
  const data = await buildSystemData({
    page: "match",
    match: {
      home: "Arsenal",
      away: "Chelsea",
      league: "Premier League",
      kickoff: "2026-10-10T14:00:00Z",
      prediction: { homeWin: 55, draw: 25, awayWin: 20, outcome: "HOME", confidence: 72, confidenceLabel: "High" },
      factors: ["Strong home form", "Chelsea concede away"],
    },
  });
  assert.ok(data.includes("Arsenal vs Chelsea"), "match present");
  assert.ok(data.includes("55%"), "probabilities present");
  assert.ok(data.includes("Strong home form"), "factors present");
  assert.ok(!data.includes("UPCOMING FIXTURES"), "fixtures fetch skipped");
});

await check("chatReply (non-streaming) collects tokens", async () => {
  mockHandler = async () => sseResponse([geminiChunk("Hel"), geminiChunk("lo")]);
  const { reply, model } = await chatReply({ message: "hi", history: [], ip: "chat-reply-ip" });
  assert.strictEqual(reply, "Hello");
  assert.strictEqual(model, "test-model-a");
});

await check("models are configurable via GEMINI_MODEL", async () => {
  assert.deepStrictEqual(assistantModels(), ["test-model-a", "test-model-b"]);
  assert.strictEqual(chatConfigured(), true);
});

await check("API key never appears in request payload sent to Gemini", async () => {
  let seenBody = "";
  mockHandler = async (_url, opts) => {
    seenBody = opts.body;
    return sseResponse([geminiChunk("ok")]);
  };
  await chatReplyStream({ systemData: "D", history: [], userMessage: "hi", onToken: () => {} });
  assert.ok(!seenBody.includes("test-key"), "key must not be in the JSON body");
});

await check("thinking config: 2.5 model gets budget, others get level", async () => {
  const { thinkingConfigFor } = await import("../src/chat/assistant.js");
  assert.deepStrictEqual(thinkingConfigFor("gemini-2.5-flash"), { thinkingBudget: 256 });
  assert.deepStrictEqual(thinkingConfigFor("gemini-flash-latest"), { thinkingLevel: "low" });
  assert.deepStrictEqual(thinkingConfigFor("gemini-3.5-flash"), { thinkingLevel: "low" });
  // And the payload actually carries it:
  const bodies = {};
  mockHandler = async (url, opts) => {
    bodies[String(url)] = JSON.parse(opts.body);
    return sseResponse([geminiChunk("ok")]);
  };
  await chatReplyStream({ systemData: "D", history: [], userMessage: "hi", onToken: () => {} });
  const urlA = Object.keys(bodies).find((u) => u.includes("test-model-a"));
  assert.deepStrictEqual(bodies[urlA].generationConfig.thinkingConfig, { thinkingLevel: "low" });
});

await check("400 on thinking field retries the SAME model without it", async () => {
  let calls = 0;
  const bodies = [];
  mockHandler = async (_url, opts) => {
    calls++;
    bodies.push(JSON.parse(opts.body));
    if (calls === 1) return new Response("invalid argument", { status: 400 });
    return sseResponse([geminiChunk("recovered")]);
  };
  const r = await chatReplyStream({ systemData: "D", history: [], userMessage: "hi", onToken: () => {} });
  assert.strictEqual(r.text, "recovered");
  assert.strictEqual(calls, 2, "same model retried once");
  assert.ok(bodies[0].generationConfig.thinkingConfig, "first attempt had thinking config");
  assert.ok(!bodies[1].generationConfig.thinkingConfig, "retry dropped the thinking field");
  assert.strictEqual(r.model, "test-model-a", "did not burn the retry on model fallback");
});

await check("smalltalk skips the fixtures fetch", async () => {
  const withHello = await buildSystemData(null, "hello");
  assert.ok(!withHello.includes("UPCOMING FIXTURES"), "no fixtures section for greetings");
  assert.ok(withHello.includes("RECENT OBULU PREDICTIONS"), "cheap DB context still included");
  const withQuestion = await buildSystemData(null, "which fixtures are upcoming this weekend?");
  assert.ok(withQuestion.includes("UPCOMING FIXTURES"), "fixtures included for fixture questions");
});

await check("diagnostics exposes models + attempt metadata, no secrets", async () => {
  const { getAssistantDiagnostics } = await import("../src/chat/assistant.js");
  mockHandler = async () => sseResponse([geminiChunk("ok")]);
  await chatReplyStream({ systemData: "D", history: [], userMessage: "hi", onToken: () => {} });
  const d = getAssistantDiagnostics();
  assert.deepStrictEqual(d.models, ["test-model-a", "test-model-b"]);
  assert.ok(Array.isArray(d.recentAttempts) && d.recentAttempts.length > 0, "attempts logged");
  const a = d.recentAttempts[0];
  assert.ok(a.model && a.outcome, "metadata present");
  assert.ok(!JSON.stringify(d).includes("test-key"), "no API key leaked");
});

globalThis.fetch = realFetch;
console.log(`\nassistant: ${passed} checks passed.`);
