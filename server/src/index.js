// OBULU API server entrypoint.
import express from "express";
import config from "./config.js";
import apiRouter from "./routes/api.js";
import automationRouter from "./routes/automation.js";
import jackpotRouter from "./routes/jackpot.js";
import sportybetRouter from "./routes/sportybet.js";
import chatRouter from "./routes/chat.js";
import assistantRouter from "./routes/assistant.js";
import calendarRouter from "./routes/calendar.js";
import liveRouter from "./routes/live.js";
import { startScheduler, stopScheduler } from "./automation/scheduler.js";
import { startResolver, stopResolver } from "./calendar/resolver.js";
import { startLiveEngine, stopLiveEngine } from "./live/engine.js";
import { closeDb, db } from "./db/database.js";
import { startSubscriberPoller, stopSubscriberPoller } from "./telegram/subscribers.js";
import { pushToTurso, stopPeriodicPush } from "./db/turso-sync.js";

const app = express();
app.use(express.json());

// Minimal CORS (single dependency: express).
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Admin-Key");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.get("/", (req, res) =>
  res.json({ ok: true, service: "obulu-api", docs: "see API.md" })
);

// Lightweight health probe for uptime monitors / keep-alive pings.
// Responds immediately: no football API calls, no prediction math,
// no large DB queries. (The richer /api/health also exists.)
app.get("/health", (req, res) =>
  res.json({ status: "ok", timestamp: new Date().toISOString() })
);

app.use("/api", apiRouter);
app.use("/api", automationRouter);
app.use("/api/jackpot", jackpotRouter);
app.use("/api/sportybet", sportybetRouter);
app.use("/api/chat", chatRouter);
app.use("/api/assistant", assistantRouter);
app.use("/api", calendarRouter);
app.use("/api", liveRouter);

// 404 for unknown API routes.
app.use("/api", (req, res) =>
  res.status(404).json({ error: "NOT_FOUND", message: "Unknown API endpoint." })
);

// Consistent error shape: upstream/provider failures -> 502, never fake data.
app.use((err, req, res, _next) => {
  console.error("request error:", err && err.message ? err.message : err);
  res.status(502).json({
    error: "PROVIDER_ERROR",
    message: (err && err.message) || "Upstream data provider request failed.",
  });
});

const server = app.listen(config.port, () => {
  console.log(`obulu-api listening on port ${config.port}`);
  startScheduler();
  startResolver();
  startLiveEngine();
  startSubscriberPoller();
});

function shutdown(signal) {
  console.log(`received ${signal}; shutting down`);
  stopScheduler();
  stopResolver();
  stopLiveEngine();
  stopSubscriberPoller();
  stopPeriodicPush();
  server.close(async () => {
    try {
      // Final cloud backup before the disk is wiped (cap: 4s).
      await Promise.race([
        pushToTurso(db),
        new Promise((r) => setTimeout(r, 4000)),
      ]);
    } catch { /* ignore */ }
    try { closeDb(); } catch { /* ignore */ }
    process.exit(0);
  });
  // Force exit if connections hang.
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
