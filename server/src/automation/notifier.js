// OBULU Automation Agent — notification service.
// Abstraction over notification channels. v1 ships two providers:
//   - telegram: Telegram Bot API (requires TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID)
//   - in_app:   persisted alert record, surfaced in the web app / APK
// New providers (email, push, discord, sms) plug in by adding a sender.
// Never logs secrets. Never includes betting language.

const log = (...a) => console.log("[Automation][notifier]", ...a);

function mask(s) {
  if (!s) return "(unset)";
  const str = String(s);
  return str.length <= 8 ? "***" : str.slice(0, 4) + "***" + str.slice(-4);
}

// Cumulative run message: every qualified tip from the run in ONE Telegram
// message, plus the single combined SportyBet booking code when one was
// created. The code is a slip reservation only — never worded as a placed
// bet and never instructs the user to bet.
export function formatRunMessage({ games, booking }) {
  const list = Array.isArray(games) ? games : [];
  const lines = [
    "━━━━━━━━━━━━━━━━━━━━",
    `🔔 OBULU TIPS (${list.length} game${list.length === 1 ? "" : "s"})`,
    "━━━━━━━━━━━━━━━━━━━━",
    "",
  ];
  list.forEach((g, i) => {
    const match = g.match || {};
    const prediction = g.prediction || {};
    const pick = String(prediction.predictedOutcome || "").toUpperCase();
    const pickName =
      pick === "HOME"
        ? match.home?.name
        : pick === "AWAY"
          ? match.away?.name
          : "Draw";
    lines.push(`${i + 1}. ⚽ ${match.home?.name} vs ${match.away?.name}`);
    const league = match.league?.name || match.league;
    if (league) lines.push(`   🏆 ${league}`);
    lines.push(
      `   🧠 Pick: ${pick} (${pickName}) · 🎯 ${Number(prediction.confidence || 0).toFixed(0)}%`
    );
    lines.push(
      `   📊 ${Number(prediction.homeWin || 0).toFixed(0)}% / ${Number(prediction.draw || 0).toFixed(0)}% / ${Number(prediction.awayWin || 0).toFixed(0)}%`
    );
    if (match.kickoff) lines.push(`   ⏰ Kickoff: ${formatKickoff(match.kickoff)}`);
    lines.push("");
  });
  lines.push("━━━━━━━━━━━━━━━━━━━━");
  if (booking && booking.shareCode) {
    lines.push(`🎫 SportyBet booking code: ${booking.shareCode}`);
    if (booking.shareURL) lines.push(String(booking.shareURL));
    if (booking.deadline) lines.push(`(code valid until ${formatDeadline(booking.deadline)})`);
    lines.push("Slip reservation only — no bet was placed.");
  } else {
    lines.push("(no booking code this run)");
  }
  lines.push("━━━━━━━━━━━━━━━━━━━━");
  lines.push("OBULU analysis only.");
  lines.push("Final decision remains with the user.");
  lines.push("━━━━━━━━━━━━━━━━━━━━");
  return lines.join("\n");
}

function formatKickoff(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleString("en-GB", {
      weekday: "short",
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  } catch {
    return String(iso);
  }
}

// Booking-code deadline rendered in Africa/Lagos local time.
function formatDeadline(v) {
  try {
    const d = typeof v === "number" ? new Date(v) : new Date(String(v));
    if (!Number.isFinite(d.getTime())) return String(v);
    return d.toLocaleString("en-GB", {
      timeZone: "Africa/Lagos",
      weekday: "short",
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  } catch {
    return String(v);
  }
}

async function sendTelegram({ botToken, chatId, text }) {
  if (!botToken || !chatId) {
    return { ok: false, skipped: true, reason: "telegram not configured" };
  }
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.ok === false) {
    return { ok: false, reason: body.description || `HTTP ${res.status}` };
  }
  return { ok: true, messageId: body.result?.message_id };
}

// Sends the cumulative run message (all tips + the one booking code) via
// Telegram. Telegram-only by design; the per-game details already live in
// the in-app feed.
export async function notifyRun({ config, games, booking }) {
  const text = formatRunMessage({ games, booking });
  const results = {};
  results.telegram = await sendTelegram({
    botToken: config.telegramBotToken,
    chatId: config.telegramChatId,
    text: text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
  }).catch((e) => ({ ok: false, reason: e.message }));
  if (!results.telegram.ok && !results.telegram.skipped) {
    log(`run telegram send failed (token ${mask(config.telegramBotToken)}): ${results.telegram.reason}`);
  }
  return results;
}
