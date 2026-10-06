// OBULU Chat routes — informational assistant only.
import express from "express";
import { chatReply, chatConfigured } from "../chat/assistant.js";

const router = express.Router();

// GET /api/chat/status — is the assistant configured?
router.get("/status", (_req, res) => {
  res.json({ configured: chatConfigured() });
});

// POST /api/chat — { message, history: [{role, text}] }
router.post("/", async (req, res) => {
  try {
    const ip =
      req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
      req.socket?.remoteAddress ||
      "unknown";
    const { reply, model } = await chatReply({
      message: req.body?.message,
      history: Array.isArray(req.body?.history) ? req.body.history : [],
      ip,
    });
    res.json({ reply, model, at: new Date().toISOString() });
  } catch (e) {
    if (e.code === "CHAT_NOT_CONFIGURED") {
      return res.status(503).json({
        error: "CHAT_NOT_CONFIGURED",
        message:
          "Chat is not set up yet — add a GEMINI_API_KEY in the server's environment to enable it.",
      });
    }
    if (e.code === "RATE_LIMITED") {
      return res
        .status(429)
        .json({ error: "RATE_LIMITED", message: "Too many messages — try again in a bit." });
    }
    if (e.code === "EMPTY_MESSAGE") {
      return res.status(400).json({ error: "EMPTY_MESSAGE", message: "Type a message first." });
    }
    console.error("[Chat]", e.message);
    res.status(502).json({ error: "CHAT_FAILED", message: "The assistant didn't respond — try again." });
  }
});

export default router;
