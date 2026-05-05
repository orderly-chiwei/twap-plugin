import WebSocket from "ws";
import { OrderlyAuth, signRequest } from "./auth.js";

const WS_PUBLIC_URL = "wss://ws-evm.orderly.org/ws/stream";
const WS_PRIVATE_URL =
  process.env.ORDERLY_WS_URL || "wss://testnet-ws-private-evm.orderly.org/v2/ws/private/stream";

type MessageHandler = (data: any) => void;

/**
 * Minimal WebSocket wrapper with auto-ping and topic subscription.
 */
function createWs(url: string, onMessage: MessageHandler): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let pingTimer: ReturnType<typeof setInterval>;

    ws.on("open", () => {
      // Orderly requires periodic pings to keep the connection alive
      pingTimer = setInterval(() => ws.send(JSON.stringify({ event: "ping" })), 10_000);
      resolve(ws);
    });

    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.event === "pong") return;
      onMessage(msg);
    });

    ws.on("close", () => clearInterval(pingTimer));
    ws.on("error", (err) => {
      clearInterval(pingTimer);
      reject(err);
    });
  });
}

// ─── Public: Orderbook ──────────────────────────────────────

export async function subscribeOrderbook(
  symbol: string,
  onUpdate: (data: { asks: [number, number][]; bids: [number, number][] }) => void
): Promise<WebSocket> {
  const ws = await createWs(WS_PUBLIC_URL, (msg) => {
    if (msg.topic === `${symbol}@orderbook`) {
      onUpdate(msg.data);
    }
  });
  ws.send(JSON.stringify({ event: "subscribe", topic: `${symbol}@orderbook` }));
  return ws;
}

// ─── Private: Execution Reports ─────────────────────────────

export interface ExecutionReport {
  symbol: string;
  clientOrderId: string;
  orderId: number;
  type: string;
  side: "BUY" | "SELL";
  quantity: number;
  price: number;
  status: string;
  executedQuantity: number;
  executedPrice: number;
  totalFee: number;
  orderTag: string;
  timestamp: number;
}

export async function subscribeExecutionReport(
  auth: OrderlyAuth,
  onReport: (report: ExecutionReport) => void
): Promise<WebSocket> {
  const url = new URL(WS_PRIVATE_URL);
  const headers = await signRequest(auth, "GET", url);

  const wsUrl = `${WS_PRIVATE_URL}/${auth.accountId}`;
  const ws = await createWs(wsUrl, (msg) => {
    if (msg.topic === "executionreport") {
      onReport(msg.data);
    }
  });

  // Authenticate the private connection
  ws.send(
    JSON.stringify({
      id: "auth",
      event: "auth",
      params: {
        orderly_key: auth.publicKey,
        sign: headers["orderly-signature"],
        timestamp: headers["orderly-timestamp"],
      },
    })
  );

  ws.send(JSON.stringify({ event: "subscribe", topic: "executionreport" }));
  return ws;
}
