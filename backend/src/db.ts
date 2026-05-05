import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, "..", "data");
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const DB_PATH = path.join(dataDir, "twap.db");

export const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent read performance
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS twap_tasks (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    symbol TEXT NOT NULL,
    side TEXT NOT NULL,
    total_qty REAL NOT NULL,
    duration_sec INTEGER NOT NULL,
    num_slices INTEGER NOT NULL,
    price_offset_bps REAL NOT NULL DEFAULT 5,
    status TEXT NOT NULL DEFAULT 'running',
    slices_placed INTEGER NOT NULL DEFAULT 0,
    slices_filled INTEGER NOT NULL DEFAULT 0,
    total_filled_qty REAL NOT NULL DEFAULT 0,
    avg_fill_price REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS twap_slices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL REFERENCES twap_tasks(id),
    slice_index INTEGER NOT NULL,
    order_id INTEGER,
    client_order_id TEXT,
    price REAL,
    quantity REAL NOT NULL,
    filled_qty REAL NOT NULL DEFAULT 0,
    filled_price REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    placed_at TEXT,
    filled_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_slices_task ON twap_slices(task_id);
  CREATE INDEX IF NOT EXISTS idx_slices_order ON twap_slices(order_id);
  CREATE INDEX IF NOT EXISTS idx_tasks_account ON twap_tasks(account_id);
`);

// ─── Queries ────────────────────────────────────────────────

export interface TwapTask {
  id: string;
  account_id: string;
  symbol: string;
  side: "BUY" | "SELL";
  total_qty: number;
  duration_sec: number;
  num_slices: number;
  price_offset_bps: number;
  status: "running" | "completed" | "cancelled" | "error";
  slices_placed: number;
  slices_filled: number;
  total_filled_qty: number;
  avg_fill_price: number;
  created_at: string;
  updated_at: string;
}

export interface TwapSlice {
  id: number;
  task_id: string;
  slice_index: number;
  order_id: number | null;
  client_order_id: string | null;
  price: number | null;
  quantity: number;
  filled_qty: number;
  filled_price: number;
  status: "pending" | "placed" | "filled" | "partial" | "cancelled";
  placed_at: string | null;
  filled_at: string | null;
}

const stmts = {
  insertTask: db.prepare(`
    INSERT INTO twap_tasks (id, account_id, symbol, side, total_qty, duration_sec, num_slices, price_offset_bps)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `),
  insertSlice: db.prepare(`
    INSERT INTO twap_slices (task_id, slice_index, quantity)
    VALUES (?, ?, ?)
  `),
  getTask: db.prepare(`SELECT * FROM twap_tasks WHERE id = ?`),
  getTasksByAccount: db.prepare(`SELECT * FROM twap_tasks WHERE account_id = ? ORDER BY created_at DESC`),
  getSlices: db.prepare(`SELECT * FROM twap_slices WHERE task_id = ? ORDER BY slice_index`),
  getSliceByOrder: db.prepare(`SELECT * FROM twap_slices WHERE order_id = ?`),
  updateTaskStatus: db.prepare(`UPDATE twap_tasks SET status = ?, updated_at = datetime('now') WHERE id = ?`),
  updateTaskProgress: db.prepare(`
    UPDATE twap_tasks
    SET slices_placed = ?, slices_filled = ?, total_filled_qty = ?, avg_fill_price = ?, updated_at = datetime('now')
    WHERE id = ?
  `),
  updateSlicePlaced: db.prepare(`
    UPDATE twap_slices SET order_id = ?, client_order_id = ?, price = ?, status = 'placed', placed_at = datetime('now')
    WHERE task_id = ? AND slice_index = ?
  `),
  updateSliceFilled: db.prepare(`
    UPDATE twap_slices SET filled_qty = ?, filled_price = ?, status = ?, filled_at = datetime('now')
    WHERE order_id = ?
  `),
};

export function createTask(task: {
  id: string;
  accountId: string;
  symbol: string;
  side: "BUY" | "SELL";
  totalQty: number;
  durationSec: number;
  numSlices: number;
  priceOffsetBps: number;
}): TwapTask {
  const sliceQty = task.totalQty / task.numSlices;

  const insertAll = db.transaction(() => {
    stmts.insertTask.run(
      task.id, task.accountId, task.symbol, task.side,
      task.totalQty, task.durationSec, task.numSlices, task.priceOffsetBps
    );
    for (let i = 0; i < task.numSlices; i++) {
      stmts.insertSlice.run(task.id, i, sliceQty);
    }
  });
  insertAll();

  return stmts.getTask.get(task.id) as TwapTask;
}

export function getTask(id: string): TwapTask | undefined {
  return stmts.getTask.get(id) as TwapTask | undefined;
}

export function getTasksByAccount(accountId: string): TwapTask[] {
  return stmts.getTasksByAccount.all(accountId) as TwapTask[];
}

export function getSlices(taskId: string): TwapSlice[] {
  return stmts.getSlices.all(taskId) as TwapSlice[];
}

export function getSliceByOrderId(orderId: number): TwapSlice | undefined {
  return stmts.getSliceByOrder.get(orderId) as TwapSlice | undefined;
}

export function updateTaskStatus(id: string, status: TwapTask["status"]) {
  stmts.updateTaskStatus.run(status, id);
}

export function updateTaskProgress(
  id: string,
  slicesPlaced: number,
  slicesFilled: number,
  totalFilledQty: number,
  avgFillPrice: number
) {
  stmts.updateTaskProgress.run(slicesPlaced, slicesFilled, totalFilledQty, avgFillPrice, id);
}

export function markSlicePlaced(
  taskId: string,
  sliceIndex: number,
  orderId: number,
  clientOrderId: string,
  price: number
) {
  stmts.updateSlicePlaced.run(orderId, clientOrderId, price, taskId, sliceIndex);
}

export function markSliceFilled(orderId: number, filledQty: number, filledPrice: number, status: "filled" | "partial") {
  stmts.updateSliceFilled.run(filledQty, filledPrice, status, orderId);
}
