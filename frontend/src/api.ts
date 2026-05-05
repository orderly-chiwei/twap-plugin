/**
 * TWAP Service API client.
 * Communicates with the TWAP backend service.
 */

const SERVICE_URL =
  (typeof window !== "undefined" && (window as any).__TWAP_SERVICE_URL__) ||
  "http://localhost:3100";

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
}

export interface CreateTwapRequest {
  accountId: string;
  secretKey: string;
  symbol: string;
  side: "BUY" | "SELL";
  totalQty: number;
  durationSec: number;
  numSlices: number;
  priceOffsetBps?: number;
}

export async function createTwap(params: CreateTwapRequest): Promise<TwapTask> {
  const res = await fetch(`${SERVICE_URL}/twap`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || data.details?.join(", ") || "Failed to create TWAP");
  return data.task;
}

export async function fetchTasks(accountId: string): Promise<TwapTask[]> {
  const res = await fetch(`${SERVICE_URL}/twap?accountId=${encodeURIComponent(accountId)}`);
  const data = await res.json();
  return data.tasks || [];
}

export async function cancelTask(taskId: string): Promise<void> {
  await fetch(`${SERVICE_URL}/twap/${encodeURIComponent(taskId)}`, { method: "DELETE" });
}
