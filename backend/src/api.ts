import { OrderlyAuth, signRequest } from "./auth.js";

const BASE_URL = process.env.ORDERLY_API_URL || "https://testnet-api-evm.orderly.org";

async function request(
  auth: OrderlyAuth,
  method: string,
  path: string,
  body?: Record<string, unknown>
): Promise<any> {
  const url = new URL(path, BASE_URL);
  const bodyStr = body ? JSON.stringify(body) : undefined;
  const headers = await signRequest(auth, method, url, bodyStr);

  const res = await fetch(url, { method, headers, body: bodyStr });
  const json = await res.json();

  if (!res.ok || !json.success) {
    throw new Error(`API ${method} ${path} failed: ${JSON.stringify(json)}`);
  }
  return json.data;
}

// ─── Order Endpoints ────────────────────────────────────────

export interface PlaceOrderParams {
  symbol: string;
  order_type: "LIMIT" | "MARKET" | "IOC" | "FOK" | "POST_ONLY" | "ASK" | "BID";
  side: "BUY" | "SELL";
  order_price?: number;
  order_quantity: number;
  order_tag?: string;
  client_order_id?: string;
}

export function placeOrder(auth: OrderlyAuth, params: PlaceOrderParams) {
  return request(auth, "POST", "/v1/order", params as any);
}

export function cancelOrder(auth: OrderlyAuth, symbol: string, orderId: number) {
  return request(auth, "DELETE", `/v1/order?order_id=${orderId}&symbol=${symbol}`);
}

export function cancelAllOrders(auth: OrderlyAuth, symbol: string) {
  return request(auth, "DELETE", `/v1/orders?symbol=${symbol}`);
}

// ─── Safety: Dead Man Switch ────────────────────────────────

/**
 * Cancel all open orders if no heartbeat received within `ms` milliseconds.
 * Set ms=0 to disable. Valid range: 5000–900000.
 */
export function cancelAllAfter(auth: OrderlyAuth, ms: number) {
  return request(auth, "POST", "/v1/order/cancel_all_after", {
    trigger_after: ms,
  });
}

// ─── Market Data ────────────────────────────────────────────

export async function getOrderbook(
  auth: OrderlyAuth,
  symbol: string,
  maxLevel = 5
): Promise<{ asks: [number, number][]; bids: [number, number][] }> {
  return request(auth, "GET", `/v1/orderbook/${symbol}?max_level=${maxLevel}`);
}

export async function getMarkPrice(symbol: string): Promise<number> {
  const url = new URL(`/v1/public/futures/${symbol}`, BASE_URL);
  const res = await fetch(url);
  const json = await res.json();
  return json.data?.mark_price ?? 0;
}

// ─── Symbol Info ───────────────────────────────────────────

export interface SymbolInfo {
  base_tick: number;   // e.g. 0.0001 for ETH
  base_min: number;    // minimum base quantity
  min_notional: number; // minimum order value in USDC
  quote_tick: number;  // price tick size
}

const symbolInfoCache = new Map<string, { info: SymbolInfo; ts: number }>();

export async function getSymbolInfo(symbol: string): Promise<SymbolInfo> {
  const cached = symbolInfoCache.get(symbol);
  if (cached && Date.now() - cached.ts < 300_000) return cached.info;

  const url = new URL(`/v1/public/info/${symbol}`, BASE_URL);
  const res = await fetch(url);
  const json = await res.json();
  const row = json.data?.rows?.[0] || json.data;
  const info: SymbolInfo = {
    base_tick: row?.base_tick ?? 0.01,
    base_min: row?.base_min ?? 0.01,
    min_notional: row?.min_notional ?? 10,
    quote_tick: row?.quote_tick ?? 0.01,
  };
  symbolInfoCache.set(symbol, { info, ts: Date.now() });
  return info;
}

// ─── Account ────────────────────────────────────────────────

export function getAccountInfo(auth: OrderlyAuth) {
  return request(auth, "GET", "/v1/client/info");
}
