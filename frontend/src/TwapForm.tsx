/**
 * Full TWAP order form — replaces the standard order entry when TWAP mode is active.
 * Inspired by Hyperliquid and Lighter TWAP UIs.
 */

import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useKeyStore, useAccount } from "@orderly.network/hooks";
import { createTwap, fetchTasks, cancelTask, type TwapTask } from "./api";

interface SymbolRules {
  baseTick: number;   // step size for base qty (e.g. 0.0001 for ETH)
  baseMin: number;    // minimum base qty per order
  minNotional: number; // minimum order value in USDC (e.g. 10)
  quoteTick: number;  // price tick
}

interface TwapFormProps {
  symbol: string;
  onBack: () => void;
}

export function TwapForm({ symbol, onBack }: TwapFormProps) {
  const [side, setSide] = useState<"BUY" | "SELL">("BUY");
  const [totalQty, setTotalQty] = useState("");
  const [inputInQuote, setInputInQuote] = useState(true); // default: input in USDC
  const [hours, setHours] = useState(0);
  const [minutes, setMinutes] = useState(30);
  const [randomize, setRandomize] = useState(false);
  const [reduceOnly, setReduceOnly] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tasks, setTasks] = useState<TwapTask[]>([]);
  const [markPrice, setMarkPrice] = useState(0);
  const [symbolRules, setSymbolRules] = useState<SymbolRules | null>(null);

  const keyStore = useKeyStore();
  const { account, state } = useAccount();
  const address = keyStore.getAddress();
  const accountId = address ? keyStore.getAccountId(address) : null;
  const isConnected = state?.status === 5; // AccountStatusEnum.EnableTrading

  // Parse symbol: PERP_ETH_USDC → base=ETH, quote=USDC
  const parts = symbol.replace("PERP_", "").split("_");
  const baseCurrency = parts[0] || "ETH";
  const quoteCurrency = parts[1] || "USDC";
  const pairName = `${baseCurrency}/${quoteCurrency}`;
  const displayCurrency = inputInQuote ? quoteCurrency : baseCurrency;

  // Fetch mark price for quote→base conversion
  useEffect(() => {
    async function fetchPrice() {
      try {
        const res = await fetch(`https://testnet-api.orderly.org/v1/public/futures/${symbol}`);
        const json = await res.json();
        if (json.data?.mark_price) setMarkPrice(json.data.mark_price);
      } catch {}
    }
    fetchPrice();
    const iv = setInterval(fetchPrice, 10_000);
    return () => clearInterval(iv);
  }, [symbol]);

  // Fetch symbol rules (base_tick, base_min, min_notional)
  useEffect(() => {
    async function fetchSymbolInfo() {
      try {
        const res = await fetch(`https://testnet-api.orderly.org/v1/public/info/${symbol}`);
        const json = await res.json();
        const row = json.data?.rows?.[0] || json.data;
        if (row) {
          setSymbolRules({
            baseTick: row.base_tick ?? 0.01,
            baseMin: row.base_min ?? 0.01,
            minNotional: row.min_notional ?? 10,
            quoteTick: row.quote_tick ?? 0.01,
          });
        }
      } catch {}
    }
    fetchSymbolInfo();
  }, [symbol]);

  // Convert input to base quantity for the API
  const baseQty = useMemo(() => {
    const raw = Number(totalQty);
    if (!raw || raw <= 0) return 0;
    if (!inputInQuote) return raw; // already in base
    if (markPrice <= 0) return 0;
    return raw / markPrice;
  }, [totalQty, inputInQuote, markPrice]);

  const durationSec = hours * 3600 + minutes * 60;

  // Use real symbol rules or conservative defaults
  const minOrderQty = symbolRules?.baseMin ?? 0.01;
  const minNotional = symbolRules?.minNotional ?? 10;
  const baseTick = symbolRules?.baseTick ?? 0.01;

  // Min per-order qty: max of baseMin and minNotional/markPrice (with 10% buffer for price drift)
  const minQtyByNotional = markPrice > 0 ? (minNotional * 1.1) / markPrice : 0;
  const effectiveMinQty = Math.max(minOrderQty, minQtyByNotional);

  const maxOrdersByQty = baseQty > 0 ? Math.floor(baseQty / effectiveMinQty) : 0;
  const maxOrdersByTime = durationSec > 0 ? Math.floor(durationSec / 30) : 0;
  const numOrders = Math.max(1, Math.min(maxOrdersByTime, maxOrdersByQty || maxOrdersByTime));

  const frequency = numOrders > 0 ? Math.floor(durationSec / numOrders) : 0;
  const sizePerOrder = numOrders > 0 && baseQty > 0 ? baseQty / numOrders : 0;
  const sizePerOrderDisplay = numOrders > 0 && Number(totalQty) > 0 ? Number(totalQty) / numOrders : 0;
  const notionalPerOrder = sizePerOrder * markPrice;

  const refreshTasks = useCallback(async () => {
    if (!accountId) return;
    try {
      setTasks(await fetchTasks(accountId));
    } catch {}
  }, [accountId]);

  useEffect(() => {
    refreshTasks();
    const iv = setInterval(refreshTasks, 3000);
    return () => clearInterval(iv);
  }, [refreshTasks]);

  const handleSubmit = async () => {
    if (!accountId || !address) {
      setError("Please connect your wallet first");
      return;
    }
    const keyPair = keyStore.getOrderlyKey(address);
    if (!keyPair) {
      setError("No active session key. Please log in.");
      return;
    }
    if (baseQty <= 0) {
      setError(inputInQuote && markPrice <= 0
        ? "Unable to fetch mark price for conversion"
        : "Enter a valid total size");
      return;
    }
    if (durationSec < 300 || durationSec > 86400) {
      setError("Running time must be 5 minutes to 24 hours");
      return;
    }
    // Validate against symbol rules
    const perOrderQty = baseQty / numOrders;
    if (perOrderQty < effectiveMinQty) {
      setError(`Per-suborder size (${perOrderQty.toFixed(4)}) below minimum (${effectiveMinQty.toFixed(4)} ${baseCurrency}). Increase total size or reduce duration.`);
      return;
    }
    if (markPrice > 0 && perOrderQty * markPrice < minNotional) {
      setError(`Each suborder must be ≥ ${minNotional} ${quoteCurrency}. Current: ${(perOrderQty * markPrice).toFixed(2)} ${quoteCurrency}.`);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      await createTwap({
        accountId,
        secretKey: keyPair.secretKey,
        symbol,
        side,
        totalQty: +baseQty.toFixed(6),
        durationSec,
        numSlices: numOrders,
        priceOffsetBps: randomize ? 10 : 5,
      });
      setTotalQty("");
      await refreshTasks();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const activeTasks = tasks.filter((t) => t.status === "running");
  const recentTasks = tasks.filter((t) => t.status !== "running").slice(0, 3);
  const isBuy = side === "BUY";

  return (
    <div style={S.container}>
      {/* Back button */}
      <button type="button" onClick={onBack} style={S.backBtn}>
        ← Back to Order Entry
      </button>

      {/* Buy / Sell toggle */}
      <div style={S.sideToggle}>
        <button
          type="button"
          onClick={() => setSide("BUY")}
          style={{
            ...S.sideBtn,
            ...(isBuy ? S.sideBuyActive : {}),
          }}
        >
          Buy / Long
        </button>
        <button
          type="button"
          onClick={() => setSide("SELL")}
          style={{
            ...S.sideBtn,
            ...(!isBuy ? S.sideSellActive : {}),
          }}
        >
          Sell / Short
        </button>
      </div>

      {/* Total Size */}
      <div style={S.fieldGroup}>
        <div style={S.fieldRow}>
          <input
            type="number"
            min={0}
            step="0.01"
            value={totalQty}
            onChange={(e) => setTotalQty(e.target.value)}
            placeholder="Total Size"
            style={S.fieldInput}
          />
          <button
            type="button"
            onClick={() => setInputInQuote(!inputInQuote)}
            style={S.currencyToggle}
            title={`Switch to ${inputInQuote ? baseCurrency : quoteCurrency}`}
          >
            {displayCurrency} ↕
          </button>
        </div>
        {inputInQuote && markPrice > 0 && baseQty > 0 && (
          <div style={S.conversionHint}>
            ≈ {baseQty.toFixed(4)} {baseCurrency} @ {markPrice.toFixed(2)}
          </div>
        )}
      </div>

      {/* Running Time */}
      <div style={S.sectionLabel}>Running Time (5m - 24h)</div>
      <div style={S.timeRow}>
        <div style={S.timeField}>
          <input
            type="number"
            min={0}
            max={24}
            value={hours || ""}
            onChange={(e) => setHours(Math.min(24, Number(e.target.value) || 0))}
            placeholder="0"
            style={S.timeInput}
          />
          <span style={S.timeLabel}>Hours</span>
        </div>
        <div style={S.timeField}>
          <input
            type="number"
            min={0}
            max={59}
            value={minutes || ""}
            onChange={(e) => setMinutes(Math.min(59, Number(e.target.value) || 0))}
            placeholder="30"
            style={S.timeInput}
          />
          <span style={S.timeLabel}>Minutes</span>
        </div>
      </div>

      {/* Options */}
      <div style={S.optionsRow}>
        <label style={S.checkbox}>
          <input
            type="checkbox"
            checked={randomize}
            onChange={(e) => setRandomize(e.target.checked)}
          />
          <span>Randomize</span>
        </label>
        <label style={S.checkbox}>
          <input
            type="checkbox"
            checked={reduceOnly}
            onChange={(e) => setReduceOnly(e.target.checked)}
          />
          <span>Reduce Only</span>
        </label>
      </div>

      {/* Validation warnings */}
      {baseQty > 0 && baseQty < effectiveMinQty && (
        <div style={S.warning}>
          Total size too small. Minimum per order: {effectiveMinQty.toFixed(4)} {baseCurrency}
          {markPrice > 0 ? ` (≈ ${(effectiveMinQty * markPrice).toFixed(2)} ${quoteCurrency})` : ""}.
        </div>
      )}
      {sizePerOrder > 0 && sizePerOrder < effectiveMinQty && baseQty >= effectiveMinQty && (
        <div style={S.warning}>
          Per-suborder size ({sizePerOrder.toFixed(4)} {baseCurrency}) below minimum.
          Orders will be capped to {maxOrdersByQty} to meet minimum.
        </div>
      )}
      {notionalPerOrder > 0 && notionalPerOrder < minNotional && (
        <div style={S.warning}>
          Each suborder must be ≥ {minNotional} {quoteCurrency}.
          Current: {notionalPerOrder.toFixed(2)} {quoteCurrency}/order.
          {markPrice > 0 ? ` Min total: ${(minNotional * numOrders).toFixed(2)} ${quoteCurrency}` : ""}
        </div>
      )}
      {symbolRules && markPrice > 0 && (
        <div style={S.infoHint}>
          Min order: {minNotional} {quoteCurrency} (≈ {(minNotional / markPrice).toFixed(4)} {baseCurrency})
          · Tick: {baseTick} {baseCurrency}
        </div>
      )}

      {/* Error */}
      {error && <div style={S.error}>{error}</div>}

      {/* Submit */}
      <button
        type="button"
        onClick={isConnected ? handleSubmit : undefined}
        disabled={loading || !isConnected}
        style={{
          ...S.submitBtn,
          background: !isConnected
            ? "var(--oui-color-base-4, #444)"
            : isBuy
            ? "rgb(var(--oui-color-success-darken, 14 203 129))"
            : "rgb(var(--oui-color-danger-darken, 246 70 93))",
        }}
      >
        {!isConnected
          ? "Connect Wallet to Trade"
          : loading
          ? "Starting TWAP..."
          : `${side} / ${isBuy ? "Long" : "Short"} ${pairName}`}
      </button>

      {/* Summary */}
      <div style={S.summary}>
        <SummaryRow label="Frequency" value={frequency > 0 ? `${frequency} seconds` : "-"} />
        <SummaryRow label="Runtime" value={formatRuntime(durationSec)} />
        <SummaryRow label="Number of Orders" value={numOrders > 0 ? String(numOrders) : "-"} />
        <SummaryRow
          label="Size per Suborder"
          value={sizePerOrder > 0
            ? `${sizePerOrder.toFixed(4)} ${baseCurrency}${inputInQuote ? ` (${sizePerOrderDisplay.toFixed(2)} ${quoteCurrency})` : ""}`
            : "-"}
        />
      </div>

      {/* Active tasks */}
      {activeTasks.length > 0 && (
        <div style={S.taskSection}>
          <div style={S.taskTitle}>ACTIVE TWAP</div>
          {activeTasks.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              onCancel={async () => {
                await cancelTask(task.id);
                refreshTasks();
              }}
            />
          ))}
        </div>
      )}

      {recentTasks.length > 0 && (
        <div style={S.taskSection}>
          <div style={S.taskTitle}>RECENT</div>
          {recentTasks.map((task) => (
            <TaskCard key={task.id} task={task} />
          ))}
        </div>
      )}
    </div>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={S.summaryRow}>
      <span style={S.summaryLabel}>{label}</span>
      <span style={S.summaryValue}>{value}</span>
    </div>
  );
}

function TaskCard({ task, onCancel }: { task: TwapTask; onCancel?: () => void }) {
  const progress = task.num_slices > 0 ? task.slices_placed / task.num_slices : 0;
  const pairName = task.symbol.replace("PERP_", "").replace("_", "/");
  const statusColor =
    task.status === "running" ? "#0ecb81"
    : task.status === "completed" ? "#7c5cfc"
    : task.status === "cancelled" ? "#666"
    : "#f6465d";

  return (
    <div style={S.taskCard}>
      <div style={S.taskHeader}>
        <span style={{ fontSize: 12, fontWeight: 600 }}>{pairName}</span>
        <span style={{ fontSize: 11, color: task.side === "BUY" ? "#0ecb81" : "#f6465d" }}>
          {task.side}
        </span>
        <span style={{ fontSize: 11, color: "var(--oui-color-base-6, #888)" }}>{task.total_qty}</span>
        <span style={{ fontSize: 10, color: statusColor, marginLeft: "auto" }}>{task.status}</span>
      </div>
      <div style={S.progressBg}>
        <div style={{ ...S.progressFill, width: `${progress * 100}%`, background: statusColor }} />
      </div>
      <div style={S.taskMeta}>
        <span>{task.slices_placed}/{task.num_slices} orders</span>
        {task.avg_fill_price > 0 && <span>avg {task.avg_fill_price.toFixed(2)}</span>}
      </div>
      {task.status === "running" && onCancel && (
        <button type="button" onClick={onCancel} style={S.cancelBtn}>Cancel</button>
      )}
    </div>
  );
}

function formatRuntime(sec: number): string {
  if (sec <= 0) return "-";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h`;
  return `${m}m`;
}

// ─── Styles ────────────────────────────────────────────────

const S: Record<string, React.CSSProperties> = {
  container: {
    display: "flex",
    flexDirection: "column",
    gap: 12,
    padding: "0 4px",
  },
  backBtn: {
    fontSize: 12,
    color: "var(--oui-color-base-6, #888)",
    background: "none",
    border: "none",
    cursor: "pointer",
    textAlign: "left" as const,
    padding: "4px 0",
  },
  sideToggle: {
    display: "flex",
    gap: 0,
    borderRadius: 6,
    overflow: "hidden",
    border: "1px solid var(--oui-color-line, #2a2a3e)",
  },
  sideBtn: {
    flex: 1,
    padding: "10px 0",
    fontSize: 13,
    fontWeight: 600,
    border: "none",
    cursor: "pointer",
    background: "transparent",
    color: "var(--oui-color-base-6, #888)",
    transition: "all 0.15s",
  },
  sideBuyActive: {
    background: "rgba(14, 203, 129, 0.15)",
    color: "#0ecb81",
  },
  sideSellActive: {
    background: "rgba(246, 70, 93, 0.15)",
    color: "#f6465d",
  },
  fieldGroup: {
    borderRadius: 6,
    border: "1px solid var(--oui-color-line, #2a2a3e)",
    overflow: "hidden",
  },
  fieldRow: {
    display: "flex",
    alignItems: "center",
    padding: "10px 12px",
  },
  fieldInput: {
    flex: 1,
    fontSize: 14,
    background: "transparent",
    border: "none",
    color: "var(--oui-color-base-10, #eee)",
    outline: "none",
  },
  currencyToggle: {
    fontSize: 12,
    color: "var(--oui-color-base-8, #ccc)",
    fontWeight: 500,
    background: "var(--oui-color-bg-base-2, #1a1a2e)",
    border: "1px solid var(--oui-color-line, #2a2a3e)",
    borderRadius: 4,
    padding: "2px 8px",
    cursor: "pointer",
    whiteSpace: "nowrap" as const,
  },
  conversionHint: {
    fontSize: 11,
    color: "var(--oui-color-base-5, #666)",
    padding: "0 12px 8px",
  },
  sectionLabel: {
    fontSize: 12,
    color: "var(--oui-color-base-6, #888)",
  },
  timeRow: {
    display: "flex",
    gap: 8,
  },
  timeField: {
    flex: 1,
    display: "flex",
    alignItems: "center",
    borderRadius: 6,
    border: "1px solid var(--oui-color-line, #2a2a3e)",
    padding: "8px 12px",
    gap: 8,
  },
  timeInput: {
    width: 40,
    fontSize: 14,
    background: "transparent",
    border: "none",
    color: "var(--oui-color-base-10, #eee)",
    outline: "none",
  },
  timeLabel: {
    fontSize: 12,
    color: "var(--oui-color-base-5, #666)",
  },
  optionsRow: {
    display: "flex",
    gap: 16,
  },
  checkbox: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    fontSize: 12,
    color: "var(--oui-color-base-8, #ccc)",
    cursor: "pointer",
  },
  warning: {
    fontSize: 11,
    color: "#f0b90b",
    padding: "6px 10px",
    borderRadius: 4,
    background: "rgba(240, 185, 11, 0.1)",
  },
  error: {
    fontSize: 11,
    color: "#f6465d",
    padding: "6px 10px",
    borderRadius: 4,
    background: "rgba(246, 70, 93, 0.1)",
  },
  infoHint: {
    fontSize: 10,
    color: "var(--oui-color-base-5, #666)",
    padding: "4px 10px",
    borderRadius: 4,
    background: "var(--oui-color-bg-base-1, rgba(255,255,255,0.03))",
  },
  submitBtn: {
    width: "100%",
    padding: "12px",
    fontSize: 14,
    fontWeight: 600,
    borderRadius: 6,
    border: "none",
    color: "#fff",
    cursor: "pointer",
  },
  summary: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
    paddingTop: 4,
    borderTop: "1px solid var(--oui-color-line, #1a1a2e)",
  },
  summaryRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  },
  summaryLabel: {
    fontSize: 12,
    color: "var(--oui-color-base-5, #666)",
  },
  summaryValue: {
    fontSize: 12,
    color: "var(--oui-color-base-8, #ccc)",
  },
  taskSection: { marginTop: 8 },
  taskTitle: {
    fontSize: 10,
    fontWeight: 500,
    color: "var(--oui-color-base-5, #666)",
    letterSpacing: 1,
    marginBottom: 6,
  },
  taskCard: {
    padding: 8,
    marginBottom: 4,
    borderRadius: 4,
    background: "var(--oui-color-bg-base-1, #12121f)",
  },
  taskHeader: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    marginBottom: 4,
  },
  progressBg: {
    height: 3,
    borderRadius: 2,
    background: "var(--oui-color-line, #2a2a3e)",
    overflow: "hidden",
    marginBottom: 4,
  },
  progressFill: {
    height: "100%",
    borderRadius: 2,
    transition: "width 0.5s ease",
  },
  taskMeta: {
    display: "flex",
    gap: 12,
    fontSize: 11,
    color: "var(--oui-color-base-6, #888)",
  },
  cancelBtn: {
    marginTop: 6,
    width: "100%",
    padding: "4px",
    fontSize: 11,
    borderRadius: 4,
    border: "1px solid var(--oui-color-line, #333)",
    background: "transparent",
    color: "#f6465d",
    cursor: "pointer",
  },
};
