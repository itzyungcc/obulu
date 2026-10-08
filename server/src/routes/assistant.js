// OBULU AI streaming routes — Server-Sent Events.
// POST /api/assistant/stream  { message, history, context } ->
//   event: token  data: {"text":"..."}
//   event: done   data: {"model":"...","ms":1234}
//   event: error  data: {"code":"...","message":"..."}
// The Gemini key never leaves the server.
import express from "express";
import { assistantReplyStream, chatConfigured } from "../chat/assistant.js";

const router = express.Router();

function clientIp(req) {
  return (
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.socket?.remoteAddress ||
    "unknown"
  );
}

// Friendly, non-technical messages. Technical detail stays in server logs.
const FRIENDLY = {
  CHAT_NOT_CONFIGURED: "OBULU AI isn't connected yet. Please try again later.",
  RATE_LIMITED: "OBULU AI is currently busy. Please try again in a moment.",
  EMPTY_MESSAGE: "Type a message first.",
  TIMEOUT: "OBULU AI is taking too long to respond.",
  UPSTREAM: "OBULU AI is temporarily unavailable. Please try again.",
  EMPTY_RESPONSE: "OBULU AI couldn't generate a response this time. Please try again.",
  AUTH: "OBULU AI is temporarily unavailable. Please try again.",
  CANCELLED: "Response stopped.",
};

function sseSend(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

router.post("/stream", async (req, res) => {
  if (!chatConfigured()) {
    return res.status(503).json({ error: "CHAT_NOT_CONFIGURED", message: FRIENDLY.CHAT_NOT_CONFIGURED });
  }

  const message = req.body?.message;
  const history = Array.isArray(req.body?.history) ? req.body.history : [];
  const context = req.body?.context && typeof req.body.context === "object" ? req.body.context : null;
  const ip = clientIp(req);

  // SSE headers. Compression (if any) must not buffer event-stream responses.
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();

  const ctrl = new AbortController();
  let finished = false;
  // res "close" (not req "close": for a small buffered POST body the request
  // stream closes as soon as the body is consumed). If the client goes away
  // mid-stream, abort the Gemini request so we don't burn quota.
  res.on("close", () => {
    if (!finished) {
      finished = true;
      ctrl.abort();
    }
  });
  const finish = () => {
    finished = true;
  };

  const sendError = (code) => {
    if (res.writableEnded) return;
    sseSend(res, "error", { code, message: FRIENDLY[code] || FRIENDLY.UPSTREAM });
    res.end();
    finish();
  };

  try {
    // Validate synchronously so malformed requests fail fast with a clean error.
    const text = String(message || "").trim();
    if (!text) return sendError("EMPTY_MESSAGE");
    if (text.length > 1000) return sendError("EMPTY_MESSAGE");

    let fullText = "";
    const result = await assistantReplyStream({
      message: text,
      history,
      pageContext: context,
      ip,
      signal: ctrl.signal,
      onToken: (delta) => {
        if (res.writableEnded) return;
        fullText += delta;
        sseSend(res, "token", { text: delta });
      },
    });
    if (!res.writableEnded) {
      sseSend(res, "done", { model: result.model, ms: result.totalMs });
      res.end();
    }
  } catch (e) {
    const code = e.code || "UPSTREAM";
    if (code === "CANCELLED") {
      // Client went away or user stopped: just end the stream quietly.
      if (!res.writableEnded) res.end();
    } else {
      sendError(code);
    }
  } finally {
    finish();
  }
});

export default router;
