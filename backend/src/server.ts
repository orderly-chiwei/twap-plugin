/**
 * TWAP Service — Hardened Express Server
 *
 * Security layers:
 *  1. CORS origin whitelist
 *  2. Rate limiting (per-account for creates, per-IP for reads)
 *  3. Input validation (schema + range checks)
 *  4. Active task limit per account (max 5)
 *  5. Secret keys held only in-memory for active tasks, never logged or persisted
 */

import "dotenv/config";
import express from "express";
import cors from "cors";
import { startTwap, cancelTwap, handleExecutionReport, getActiveTaskIds } from "./engine.js";
import * as store from "./db.js";
import { rateLimit, validateCreateTwap, checkActiveTaskLimit } from "./middleware.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Ensure data directory exists
const dataDir = path.join(__dirname, "..", "data");
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const app = express();
const PORT = Number(process.env.PORT || 3100);

// ─── CORS ──────────────────────────────────────────────────

const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS || "http://localhost:4567,http://localhost:3000")
  .split(",")
  .map((s) => s.trim());

app.use(
  cors({
    origin(origin, callback) {
      // Allow server-to-server (no origin) or whitelisted origins
      if (!origin || ALLOWED_ORIGINS.includes(origin)) {
        callback(null, true);
      } else {
        // Reject silently (don't crash — just omit CORS headers, browser blocks it)
        callback(null, false);
      }
    },
  })
);

app.use(express.json({ limit: "16kb" }));

// ─── Helpers ───────────────────────────────────────────────

function countActiveTasks(accountId: string): number {
  const tasks = store.getTasksByAccount(accountId);
  return tasks.filter((t) => t.status === "running").length;
}

// ─── Rate limiters ─────────────────────────────────────────

const createLimiter = rateLimit({
  limit: 3,
  windowSec: 60,
  keyFn: (req) => `create:${req.body?.accountId || req.ip}`,
});

const readLimiter = rateLimit({
  limit: 60,
  windowSec: 60,
  keyFn: (req) => `read:${req.ip}`,
});

// ─── Routes ────────────────────────────────────────────────

/**
 * POST /twap — Create and start a new TWAP task.
 */
app.post(
  "/twap",
  createLimiter,
  validateCreateTwap,
  checkActiveTaskLimit(countActiveTasks),
  async (req, res) => {
    try {
      const { accountId, secretKey, symbol, side, totalQty, durationSec, numSlices, priceOffsetBps } =
        req.body;

      const task = await startTwap({
        accountId,
        secretKey,
        symbol,
        side,
        totalQty: Number(totalQty),
        durationSec: Number(durationSec),
        numSlices: Number(numSlices),
        priceOffsetBps: priceOffsetBps ? Number(priceOffsetBps) : undefined,
      });

      res.json({ task });
    } catch (err: any) {
      console.error("[POST /twap] error:", err.message);
      res.status(500).json({ error: err.message });
    }
  }
);

/**
 * GET /twap?accountId=xxx — List all TWAP tasks for an account.
 */
app.get("/twap", readLimiter, (req, res) => {
  const { accountId } = req.query;
  if (!accountId || typeof accountId !== "string") {
    res.status(400).json({ error: "accountId query param required" });
    return;
  }
  const tasks = store.getTasksByAccount(accountId);
  res.json({ tasks });
});

/**
 * GET /twap/:id — Task detail with slices.
 */
app.get("/twap/:id", readLimiter, (req, res) => {
  const task = store.getTask(req.params.id);
  if (!task) {
    res.status(404).json({ error: "Task not found" });
    return;
  }
  const slices = store.getSlices(task.id);
  res.json({ task, slices });
});

/**
 * DELETE /twap/:id — Cancel a running TWAP task.
 */
app.delete("/twap/:id", readLimiter, async (req, res) => {
  const cancelled = await cancelTwap(req.params.id);
  if (!cancelled) {
    const task = store.getTask(req.params.id);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    res.json({ task, message: "Task already finished" });
    return;
  }
  const task = store.getTask(req.params.id);
  res.json({ task, message: "Cancelled" });
});

/**
 * POST /webhook/execution-report — Receive fill updates from WS forwarder.
 */
app.post("/webhook/execution-report", (req, res) => {
  const { orderId, status, executedQuantity, executedPrice } = req.body;
  handleExecutionReport({ orderId, status, executedQuantity, executedPrice });
  res.json({ ok: true });
});

// ─── Start ─────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`[twap-service] running on http://localhost:${PORT}`);
  console.log(`[twap-service] CORS origins: ${ALLOWED_ORIGINS.join(", ")}`);
  console.log(`[twap-service] security: rate-limit + input validation + task-limit active`);
});
