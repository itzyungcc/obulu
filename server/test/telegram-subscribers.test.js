// Telegram broadcast subscriber tests — plain node asserts, run with `npm test`.
// Covers: /start subscribes (+welcome), /stop unsubscribes, broadcast list
// (owner first, deduped, actives only), blocked-user deactivation, offset
// persistence, and notifyRun fan-out to owner + subscribers.
// No live network: global fetch is stubbed; scratch DB only.
import assert from "node:assert";
import fs from "node:fs";

const DB_FILE = "/tmp/obulu-telegram-subscribers-test.db";
try { fs.unlinkSync(DB_FILE); } catch { /* fresh start */ }
process.env.DB_PATH = DB_FILE;
process.env.TELEGRAM_BOT_TOKEN = "test-token";

await import("../src/db/database.js"); // applies telegram-schema.sql migration
const subs = await import("../src/telegram/subscribers.js");
const { notifyRun } = await import("../src/automation/notifier.js");
const { db } = await import("../src/db/database.js");

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

// ------------------------------------------------------- stubbed fetch ---
const sentMessages = []; // { chatId, text }
let updatesQueue = []; // updates returned by the next getUpdates call
let blockedChatIds = new Set();

globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes("/getUpdates")) {
    const batch = updatesQueue;
    updatesQueue = [];
    return { ok: true, status: 200, json: async () => ({ ok: true, result: batch }) };
  }
  if (u.includes("/sendMessage")) {
    const body = JSON.parse(opts.body);
    const chatId = String(body.chat_id);
    if (blockedChatIds.has(chatId)) {
      return {
        ok: true, status: 200,
        json: async () => ({ ok: false, description: "Forbidden: bot was blocked by the user" }),
      };
    }
    sentMessages.push({ chatId, text: body.text });
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 1 } }) };
  }
  throw new Error(`unexpected fetch: ${u}`);
};

const reset = () => {
  db.prepare("DELETE FROM telegram_subscribers").run();
  db.prepare("UPDATE telegram_update_state SET last_update_id = 0 WHERE id = 1").run();
  sentMessages.length = 0;
  updatesQueue = [];
  blockedChatIds = new Set();
};

// ---------------------------------------------------------------- tests ---
await check("subscribe + getBroadcastChatIds: owner first, deduped, actives only", () => {
  reset();
  subs.subscribe("111", { username: "alice", firstName: "Alice" });
  subs.subscribe("222", { username: "bob", firstName: "Bob" });
  subs.subscribe("111", { username: "alice2", firstName: "Alice" }); // re-subscribe: still one row
  subs.unsubscribe("222");
  const ids = subs.getBroadcastChatIds("999");
  assert.deepStrictEqual(ids, ["999", "111"], "owner first, inactive excluded, no dupes");
  assert.strictEqual(subs.subscriberCount(), 1);
});

await check("getBroadcastChatIds: owner who also subscribed appears once", () => {
  reset();
  subs.subscribe("999", { username: "owner" });
  assert.deepStrictEqual(subs.getBroadcastChatIds("999"), ["999"]);
});

await check("pollOnce: /start subscribes and sends welcome, offset persisted", async () => {
  reset();
  updatesQueue = [
    { update_id: 41, message: { chat: { id: 777, username: "carol", first_name: "Carol" }, text: "/start" } },
    { update_id: 42, message: { chat: { id: 778 }, text: "hello (ignored)" } },
  ];
  await subs.pollOnce();
  const ids = subs.getBroadcastChatIds("999");
  assert.ok(ids.includes("777"), "starter subscribed");
  assert.ok(!ids.includes("778"), "non-command chatter not subscribed");
  const welcome = sentMessages.find((m) => m.chatId === "777");
  assert.ok(welcome && welcome.text.includes("Welcome to OBULU"), "welcome message sent");
  const off = db.prepare("SELECT last_update_id FROM telegram_update_state WHERE id = 1").get();
  assert.strictEqual(Number(off.last_update_id), 42, "offset advanced past processed updates");
});

await check("pollOnce: /stop unsubscribes", async () => {
  reset();
  subs.subscribe("777", {});
  updatesQueue = [
    { update_id: 43, message: { chat: { id: 777 }, text: "/stop" } },
  ];
  await subs.pollOnce();
  assert.deepStrictEqual(subs.getBroadcastChatIds("999"), ["999"], "stopper removed from broadcast");
  assert.strictEqual(subs.subscriberCount(), 0);
});

await check("notifyRun: fans out to owner + subscribers in one call", async () => {
  reset();
  subs.subscribe("111", {});
  subs.subscribe("222", {});
  const games = [
    {
      match: { home: { name: "Arsenal" }, away: { name: "Chelsea" }, kickoff: new Date(Date.now() + 864e5).toISOString() },
      prediction: { predictedOutcome: "home", homeWin: 60, draw: 22, awayWin: 18, confidence: 70 },
    },
  ];
  const r = await notifyRun({
    config: { telegramBotToken: "test-token", telegramChatId: "999" },
    games,
    booking: { shareCode: "ABC123", shareURL: "https://x/y", deadline: null },
  });
  const recipients = sentMessages.map((m) => m.chatId).sort();
  assert.deepStrictEqual(recipients, ["111", "222", "999"], "owner + all subscribers got the message");
  assert.ok(sentMessages[0].text.includes("OBULU TIPS (1 game)"), "cumulative message body");
  assert.ok(sentMessages[0].text.includes("ABC123"), "booking code in broadcast");
  assert.strictEqual(r.telegram.sent, 3);
  assert.strictEqual(r.telegram.failed, 0);
});

await check("notifyRun: blocked subscriber is deactivated and skipped next time", async () => {
  reset();
  subs.subscribe("111", {});
  subs.subscribe("222", {});
  blockedChatIds.add("222");
  const games = [
    {
      match: { home: { name: "A" }, away: { name: "B" } },
      prediction: { predictedOutcome: "draw", homeWin: 30, draw: 40, awayWin: 30, confidence: 60 },
    },
  ];
  const cfg = { telegramBotToken: "test-token", telegramChatId: "999" };
  await notifyRun({ config: cfg, games, booking: null });
  assert.deepStrictEqual(subs.getBroadcastChatIds("999"), ["999", "111"], "blocked chat deactivated");
  // Second run: no attempt to the deactivated chat.
  sentMessages.length = 0;
  await notifyRun({ config: cfg, games, booking: null });
  const recipients = sentMessages.map((m) => m.chatId).sort();
  assert.deepStrictEqual(recipients, ["111", "999"]);
});

await check("notifyRun: no token -> skipped, never throws", async () => {
  reset();
  const r = await notifyRun({
    config: { telegramBotToken: "", telegramChatId: "999" },
    games: [],
    booking: null,
  });
  assert.ok(r.telegram.skipped, "skipped without token");
  assert.strictEqual(sentMessages.length, 0, "nothing sent");
});

console.log(`\ntelegram-subscribers: ${passed} checks passed${process.exitCode ? " (with failures)" : ""}.`);
