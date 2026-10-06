// OBULU Automation Agent — scheduler.
// Runs the automation pipeline on a configurable interval. Default 30 min.
// The runner's lock (in-memory + DB) guarantees no overlapping runs.

import { loadEffectiveConfig } from "./automationConfig.js";
import { runAutomation } from "./runner.js";
import { db } from "../db/database.js";

const log = (...a) => console.log("[Automation][scheduler]", ...a);

let timer = null;

export function startScheduler() {
  const config = loadEffectiveConfig(db);
  if (!config.enabled) {
    log("scheduler not started: AUTOMATION_ENABLED is false");
    return false;
  }
  if (timer) {
    log("scheduler already running");
    return true;
  }
  const ms = Math.max(5, config.intervalMinutes) * 60 * 1000;
  log(`scheduler started: every ${config.intervalMinutes} min${config.dryRun ? " (dry-run)" : ""}`);
  timer = setInterval(async () => {
    try {
      await runAutomation();
    } catch (e) {
      log("scheduled run threw:", e.message);
    }
  }, ms);
  // Do not keep the process alive solely for the scheduler.
  if (typeof timer.unref === "function") timer.unref();
  return true;
}

export function stopScheduler() {
  if (timer) {
    clearInterval(timer);
    timer = null;
    log("scheduler stopped");
  }
}

export function schedulerStatus() {
  return { running: Boolean(timer) };
}
