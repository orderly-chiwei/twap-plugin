/**
 * TWAP Execution Engine
 *
 * Manages multiple concurrent TWAP tasks. Each task runs as an independent
 * async loop, sharing the Orderly API client.
 */

import { createAuth, OrderlyAuth } from "./auth.js";
import { placeOrder, cancelAllAfter, cancelAllOrders, getOrderbook, getMarkPrice, getSymbolInfo } from "./api.js";
import * as store from "./db.js";

// Active task handles (for cancellation)
const activeTasks = new Map<string, { abort: AbortController; auth: OrderlyAuth }>();

export interface CreateTwapParams {
  accountId: string;
  secretKey: string; // bs58-encoded
  symbol: string;
  side: "BUY" | "SELL";
  totalQty: number;
  durationSec: number;
  numSlices: number;
  priceOffsetBps?: number;
}

export async function startTwap(params: CreateTwapParams): Promise<store.TwapTask> {
  const id = `twap_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const auth = await createAuth(params.accountId, params.secretKey);

  const task = store.createTask({
    id,
    accountId: params.accountId,
    symbol: params.symbol,
    side: params.side,
    totalQty: params.totalQty,
    durationSec: params.durationSec,
    numSlices: params.numSlices,
    priceOffsetBps: params.priceOffsetBps ?? 5,
  });

  const abort = new AbortController();
  activeTasks.set(id, { abort, auth });

  // Fire and forget — runs in background
  executeTwap(id, auth, abort.signal).catch((err) => {
    console.error(`[engine] task ${id} fatal:`, err.message);
    store.updateTaskStatus(id, "error");
    activeTasks.delete(id);
  });

  return task;
}

export async function cancelTwap(taskId: string): Promise<boolean> {
  const task = store.getTask(taskId);
  if (!task) return false;
  if (task.status !== "running") return false;

  const handle = activeTasks.get(taskId);
  if (handle) {
    handle.abort.abort();
    // Cancel all open orders for this symbol under this user
    try {
      await cancelAllOrders(handle.auth, task.symbol);
    } catch {}
    activeTasks.delete(taskId);
  }

  // Always update DB — even if no in-memory handle (e.g. after restart)
  store.updateTaskStatus(taskId, "cancelled");
  return true;
}

export function getActiveTaskIds(): string[] {
  return [...activeTasks.keys()];
}

// ─── Execution Loop ─────────────────────────────────────────

async function executeTwap(taskId: string, auth: OrderlyAuth, signal: AbortSignal) {
  const task = store.getTask(taskId)!;

  // Fetch real step size from symbol info API
  const symbolInfo = await getSymbolInfo(task.symbol);
  const STEP_SIZE = symbolInfo.base_tick;
  const MIN_QTY = symbolInfo.base_min;
  console.log(`[engine] ${taskId} symbol info: base_tick=${STEP_SIZE}, base_min=${MIN_QTY}, min_notional=${symbolInfo.min_notional}`);

  const sliceQty = Math.floor((task.total_qty / task.num_slices) / STEP_SIZE) * STEP_SIZE;
  // Round to avoid floating point artifacts
  const sliceQtyRounded = +sliceQty.toFixed(String(STEP_SIZE).split('.')[1]?.length || 2);
  if (sliceQtyRounded < MIN_QTY) {
    console.error(`[engine] ${taskId} slice qty ${sliceQtyRounded} below min ${MIN_QTY} — aborting`);
    store.updateTaskStatus(taskId, "error");
    activeTasks.delete(taskId);
    return;
  }
  const intervalMs = (task.duration_sec / task.num_slices) * 1000;

  // Activate dead-man switch (non-fatal if it fails — key might not have permissions yet)
  try {
    await cancelAllAfter(auth, 60_000);
  } catch (err: any) {
    console.warn(`[engine] ${taskId} cancel_all_after failed (continuing): ${err.message}`);
  }
  console.log(`[engine] ${taskId} started — ${task.num_slices} slices over ${task.duration_sec}s`);

  let slicesPlaced = 0;
  let slicesFilled = 0;
  let totalFilledQty = 0;
  let totalFilledValue = 0;

  for (let i = 0; i < task.num_slices; i++) {
    if (signal.aborted) break;

    try {
      // Use mark price as reference (avoids wide-spread orderbook issues)
      const markPrice = await getMarkPrice(task.symbol);
      if (!markPrice) {
        console.log(`[engine] ${taskId} slice ${i}: no mark price, skipping`);
        continue;
      }

      const offset = markPrice * (task.price_offset_bps / 10_000);
      const priceDecimals = String(symbolInfo.quote_tick).split('.')[1]?.length || 2;
      const price =
        task.side === "BUY"
          ? +(markPrice + offset).toFixed(priceDecimals)
          : +(markPrice - offset).toFixed(priceDecimals);

      const clientOrderId = `${taskId}_${i}`;

      const result = await placeOrder(auth, {
        symbol: task.symbol,
        order_type: "IOC",
        side: task.side as "BUY" | "SELL",
        order_price: price,
        order_quantity: sliceQtyRounded,
        order_tag: "TWAP_DEMO",
        client_order_id: clientOrderId,
      });

      store.markSlicePlaced(taskId, i, result.order_id, clientOrderId, price);
      slicesPlaced++;

      // For demo: assume immediate fill at placed price (in production, use WS executionreport)
      // We'll update from WS fills if available, but track optimistic progress
      store.updateTaskProgress(
        taskId,
        slicesPlaced,
        slicesFilled,
        totalFilledQty,
        totalFilledQty > 0 ? totalFilledValue / totalFilledQty : 0
      );

      // Refresh dead-man switch (non-fatal)
      try { await cancelAllAfter(auth, 60_000); } catch {}

      console.log(
        `[engine] ${taskId} slice ${i + 1}/${task.num_slices}: ${task.side} ${sliceQty} @ ${price}`
      );
    } catch (err: any) {
      console.error(`[engine] ${taskId} slice ${i} error: ${err.message}`);
      // If auth fails persistently, stop the task
      if (
        err.message.includes("Unauthorized") ||
        err.message.includes("-1004") ||
        err.message.includes("-1003") ||
        err.message.includes("-1102") ||
        err.message.includes("-1104") ||
        err.message.includes("Invalid signature") ||
        err.message.includes("key not found") ||
        err.message.includes("step size") ||
        err.message.includes("order value should be greater")
      ) {
        console.error(`[engine] ${taskId} fatal error — stopping task: ${err.message}`);
        store.updateTaskStatus(taskId, "error");
        activeTasks.delete(taskId);
        return;
      }
      // For other errors (network, rate limit), continue to next slice
    }

    // Wait for next slice
    if (i < task.num_slices - 1 && !signal.aborted) {
      await sleep(intervalMs, signal);
    }
  }

  // Wind down
  if (!signal.aborted) {
    // Disable dead-man switch
    try { await cancelAllAfter(auth, 0); } catch {}
    store.updateTaskStatus(taskId, "completed");
    console.log(`[engine] ${taskId} completed — ${slicesPlaced} slices placed`);
  }

  activeTasks.delete(taskId);
}

/**
 * Handle execution report from WebSocket (called externally).
 * Updates slice fill status and task progress.
 */
export function handleExecutionReport(report: {
  orderId: number;
  status: string;
  executedQuantity: number;
  executedPrice: number;
}) {
  const slice = store.getSliceByOrderId(report.orderId);
  if (!slice) return;

  const fillStatus = report.status === "FILLED" ? "filled" : "partial";
  store.markSliceFilled(report.orderId, report.executedQuantity, report.executedPrice, fillStatus);

  // Recalculate task progress
  const slices = store.getSlices(slice.task_id);
  const placed = slices.filter((s) => s.status !== "pending").length;
  const filled = slices.filter((s) => s.status === "filled" || s.status === "partial").length;
  const totalQty = slices.reduce((sum, s) => sum + s.filled_qty, 0);
  const totalValue = slices.reduce((sum, s) => sum + s.filled_qty * s.filled_price, 0);
  const avgPrice = totalQty > 0 ? totalValue / totalQty : 0;

  store.updateTaskProgress(slice.task_id, placed, filled, totalQty, avgPrice);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
