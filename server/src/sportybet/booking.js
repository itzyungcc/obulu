// SportyBet share-booking creation.
//
// Creates a SportyBet booking code (slip reservation ONLY — no money moves,
// nothing is staked; the user opens the code in SportyBet and stakes
// manually). Added 2026-10-07 under explicit user authorization: OBULU may
// create share bookings, but must never place bets, stake funds, or promote
// betting.
//
// Unofficial endpoint (https://www.sportybet.com/api/ng/orders/share), no
// login required. Same browser-mimicking headers as the events fetcher.
// SportyBet may change, rate-limit, or block it at any time — treat every
// failure as a clean error, NEVER synthesize or fabricate a code.

import { SPORTYBET_HEADERS } from "./client.js";

const SPORTYBET_BASE = "https://www.sportybet.com";
const SHARE_PATH = "/api/ng/orders/share";

// Create a share booking from one or more 1X2 selections.
// selections: [{ eventId, marketId: "1", outcomeId: "1"|"2"|"3" }]
//   (outcome ids follow the events fetcher: "1" = home, "2" = draw, "3" = away)
// Returns { shareCode, shareURL, deadline }.
// Throws a clean Error on invalid input, a non-2xx status, a non-JSON body,
// or a response that carries no shareCode.
export async function createBooking(selections) {
  const items = Array.isArray(selections) ? selections : [];
  if (!items.length) {
    throw new Error("createBooking: selections are required");
  }
  const invalid = items.some((s) => !s || !s.eventId || !s.marketId || !s.outcomeId);
  if (invalid) {
    throw new Error(
      "createBooking: each selection requires eventId, marketId and outcomeId"
    );
  }

  const body = {
    selections: items.map((s) => ({
      eventId: String(s.eventId),
      marketId: String(s.marketId),
      specifier: s.specifier == null ? null : String(s.specifier),
      outcomeId: String(s.outcomeId),
    })),
  };

  let response;
  try {
    response = await fetch(`${SPORTYBET_BASE}${SHARE_PATH}`, {
      method: "POST",
      headers: SPORTYBET_HEADERS,
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new Error(`SportyBet booking request failed: ${e.message}`);
  }

  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error(`SportyBet booking returned non-JSON (HTTP ${response.status})`);
  }

  if (!response.ok) {
    throw new Error(`SportyBet booking HTTP ${response.status}`);
  }

  const booking = data?.data;
  if (!booking || !booking.shareCode) {
    throw new Error("SportyBet did not return a booking code");
  }

  return {
    shareCode: String(booking.shareCode),
    shareURL: booking.shareURL ? String(booking.shareURL) : null,
    deadline: booking.deadline != null ? String(booking.deadline) : null,
  };
}
