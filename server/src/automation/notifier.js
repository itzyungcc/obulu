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

export function formatAlertMessage({ match, prediction, modelVersion, qualification, booking }) {
  const outcomeLabel = String(prediction.predictedOutcome || "").toUpperCase();
  const lines = [
    "━━━━━━━━━━━━━━━━━━━━",
    "🔔 OBULU QUALIFIED MATCH",
    "━━━━━━━━━━━━━━━━━━━━",
    "",
    `⚽ ${match.home.name} vs ${match.away.name}`,
    "",
    `🏆 Competition: ${match.league?.name || match.league || "—"}`,
    "",
    "🧠 OBULU Prediction:",
    outcomeLabel,
    "",
    "📊 Probabilities:",
    `Home: ${prediction.homeWin.toFixed(0)}%`,
    `Draw: ${prediction.draw.toFixed(0)}%`,
    `Away: ${prediction.awayWin.toFixed(0)}%`,
    "",
    "🎯 Model confidence:",
    `${prediction.confidence.toFixed(0)}%`,
    "",
    "📦 Data completeness:",
    `${prediction.dataCompleteness.toFixed(0)}%`,
    "",
  ];
  if (
    Number.isFinite(prediction.expectedHomeGoals) &&
    Number.isFinite(prediction.expectedAwayGoals)
  ) {
    lines.push("⚽ Expected goals:");
    lines.push(
      `${prediction.expectedHomeGoals.toFixed(2)} - ${prediction.expectedAwayGoals.toFixed(2)}`
    );
    lines.push("");
  }
  lines.push(`⏰ Kickoff: ${formatKickoff(match.kickoff)}`);
  lines.push("");
  lines.push("✅ Qualification: passed all configured criteria");
  lines.push("");
  lines.push(`🤖 Model: poisson-dixon-coles ${modelVersion}`);
  lines.push("");
  if (booking && booking.shareCode) {
    // Share-booking block: a slip reservation only. Never worded as a placed
    // bet and never instructs the user to bet.
    lines.push(`🎫 SportyBet booking code: ${booking.shareCode}`);
    if (booking.shareURL) lines.push(String(booking.shareURL));
    if (booking.deadline) lines.push(`(code valid until ${formatDeadline(booking.deadline)})`);
    lines.push("Slip reservation only — no bet was placed.");
    lines.push("");
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

// Sends through all configured channels. Returns per-channel results.
// The caller persists alert rows; telegram failures never block in-app.
export async function notify({ config, payload }) {
  const text = formatAlertMessage(payload);
  const results = {};

  results.telegram = await sendTelegram({
    botToken: config.telegramBotToken,
    chatId: config.telegramChatId,
    text: text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
  }).catch((e) => ({ ok: false, reason: e.message }));

  if (!results.telegram.ok && !results.telegram.skipped) {
    log(`telegram send failed (token ${mask(config.telegramBotToken)}): ${results.telegram.reason}`);
  }

  // In-app is always recorded by the caller as an alert row.
  results.in_app = { ok: true };

  return results;
}
