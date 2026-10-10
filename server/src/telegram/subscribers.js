// Telegram broadcast subscribers.
// Anyone who taps Start on the bot is recorded in telegram_subscribers and
// then receives the same cumulative tips + booking-code message as the
// owner. /stop opts out. Telegram only lets bots message users who have
// started the bot, so this is the only legitimate way to grow the audience.
//
// A lightweight getUpdates poller runs every 30s (short-poll; no webhook
// needed). The update offset is persisted so restarts don't reprocess.

import { db } from "../db/database.js";
import { schedulePush } from "../db/turso-sync.js";

const log = (...a) => console.log("[Telegram][subscribers]", ...a);

const POLL_INTERVAL_MS = 30 * 1000;
let timer = null;
let polling = false;

function apiBase(token) {
  return `https://api.telegram.org/bot${token}`;
}

function getToken() {
  return process.env.TELEGRAM_BOT_TOKEN || "";
}

function getOffset() {
  try {
    const row = db
      .prepare("SELECT last_update_id FROM telegram_update_state WHERE id = 1")
      .get();
    return row ? Number(row.last_update_id) || 0 : 0;
  } catch {
    return 0;
  }
}

function setOffset(id) {
  try {
    db.prepare(
      "UPDATE telegram_update_state SET last_update_id = ? WHERE id = 1"
    ).run(Number(id) || 0);
  } catch (e) {
    log("offset persist failed:", e.message);
  }
}

export function subscribe(chatId, { username = null, firstName = null } = {}) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO telegram_subscribers
       (chat_id, username, first_name, subscribed_at, unsubscribed_at, is_active)
     VALUES (?, ?, ?, ?, NULL, 1)
     ON CONFLICT(chat_id) DO UPDATE SET
       username = excluded.username,
       first_name = excluded.first_name,
       unsubscribed_at = NULL,
       is_active = 1`
  ).run(String(chatId), username, firstName, now);
  // Back up immediately: a redeploy before the next 15-min push would
  // otherwise lose this subscriber (they got the welcome but no tips).
  try { schedulePush(db, 2000); } catch { /* best effort */ }
}

export function unsubscribe(chatId) {
  db.prepare(
    `UPDATE telegram_subscribers
     SET is_active = 0, unsubscribed_at = ?
     WHERE chat_id = ?`
  ).run(new Date().toISOString(), String(chatId));
  try { schedulePush(db, 2000); } catch { /* best effort */ }
}

export function deactivate(chatId) {
  // Bot was blocked/deleted: stop trying silently.
  try {
    db.prepare(
      `UPDATE telegram_subscribers SET is_active = 0 WHERE chat_id = ?`
    ).run(String(chatId));
  } catch { /* best effort */ }
}

export function subscriberCount() {
  try {
    const row = db
      .prepare(
        "SELECT COUNT(*) AS c FROM telegram_subscribers WHERE is_active = 1"
      )
      .get();
    return row ? Number(row.c) : 0;
  } catch {
    return 0;
  }
}

// Owner chat first, then every active subscriber, deduplicated.
export function getBroadcastChatIds(ownerChatId) {
  const ids = [];
  const seen = new Set();
  const add = (id) => {
    const s = String(id || "").trim();
    if (s && !seen.has(s)) {
      seen.add(s);
      ids.push(s);
    }
  };
  add(ownerChatId);
  try {
    const rows = db
      .prepare(
        "SELECT chat_id FROM telegram_subscribers WHERE is_active = 1 ORDER BY subscribed_at ASC"
      )
      .all();
    for (const r of rows) add(r.chat_id);
  } catch (e) {
    log("subscriber list failed:", e.message);
  }
  return ids;
}

async function sendRaw(token, chatId, text) {
  const res = await fetch(`${apiBase(token)}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
  });
  const body = await res.json().catch(() => ({}));
  return { res, body };
}

const WELCOME_TEXT = [
  "👋 Welcome to OBULU!",
  "",
  "You'll now receive OBULU's football tips here — predictions with a",
  "SportyBet booking code you can open and stake yourself.",
  "",
  "Messages arrive after each hourly scan, only when games qualify.",
  "Send /stop anytime to unsubscribe.",
].join("\n");

async function handleUpdate(token, update) {
  const msg = update.message;
  if (!msg || !msg.chat) return;
  const chatId = String(msg.chat.id);
  const text = String(msg.text || "").trim();
  if (!text.startsWith("/")) return; // only commands matter

  const cmd = text.split(/\s+/)[0].split("@")[0].toLowerCase();
  if (cmd === "/start") {
    subscribe(chatId, {
      username: msg.chat.username || null,
      firstName: msg.chat.first_name || null,
    });
    log(`new subscriber: ${chatId}`);
    try {
      await sendRaw(token, chatId, WELCOME_TEXT);
    } catch (e) {
      log(`welcome send failed for ${chatId}: ${e.message}`);
    }
  } else if (cmd === "/stop") {
    unsubscribe(chatId);
    log(`unsubscribed: ${chatId}`);
    try {
      await sendRaw(
        token,
        chatId,
        "You've been unsubscribed from OBULU tips. Send /start anytime to resubscribe."
      );
    } catch { /* best effort */ }
  }
}

export async function pollOnce() {
  const token = getToken();
  if (!token) return;
  if (polling) return;
  polling = true;
  try {
    const offset = getOffset();
    const url = `${apiBase(token)}/getUpdates?offset=${offset + 1}&timeout=20&allowed_updates=${encodeURIComponent(
      JSON.stringify(["message"])
    )}`;
    const res = await fetch(url);
    const data = await res.json().catch(() => ({}));
    if (!data.ok) {
      log(`getUpdates failed: ${data.description || `HTTP ${res.status}`}`);
      return;
    }
    for (const u of data.result || []) {
      try {
        await handleUpdate(token, u);
      } catch (e) {
        log(`update ${u.update_id} failed: ${e.message}`);
      }
      setOffset(u.update_id);
    }
  } catch (e) {
    log(`poll failed: ${e.message}`);
  } finally {
    polling = false;
  }
}

export function startSubscriberPoller() {
  if (timer) {
    log("subscriber poller already running");
    return true;
  }
  if (!getToken()) {
    log("subscriber poller not started: TELEGRAM_BOT_TOKEN unset");
    return false;
  }
  log("subscriber poller started: every 30s");
  // First poll soon after boot so /start works immediately.
  setTimeout(() => pollOnce().catch(() => {}), 5000);
  timer = setInterval(() => {
    pollOnce().catch(() => {});
  }, POLL_INTERVAL_MS);
  if (typeof timer.unref === "function") timer.unref();
  return true;
}

export function stopSubscriberPoller() {
  if (timer) {
    clearInterval(timer);
    timer = null;
    log("subscriber poller stopped");
  }
}

export function pollerStatus() {
  return { running: Boolean(timer) };
}
