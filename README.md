# TWAP Plugin for Orderly SDK v3

Time-Weighted Average Price (TWAP) execution strategy, built as an Orderly SDK v3 plugin for WooFi Pro.

## Demo

[Watch Demo Video](demo/module-twap-demo.mp4)

> **Disclaimer: This plugin is a proof-of-concept / demo implementation.** It is NOT production-ready. Both frontend and backend require thorough review and hardening before use in a live trading environment — including but not limited to stability, security, order reconciliation, edge case handling, and UI/UX validation. The current implementation may not cover all scenarios. See [Production Readiness](#production-readiness) for known gaps.

## Architecture

```
┌─ Frontend (SDK Plugin) ─────────┐          ┌─ Backend (Node.js) ───────────┐
│                                  │          │                               │
│  TwapForm.tsx                    │   REST   │  server.ts     (Express)      │
│   · UI form                      │ ──────> │  engine.ts     (executor)     │
│   · validation                   │ <────── │  db.ts         (persistence)  │
│   · task monitoring              │          │  api.ts        (Orderly API)  │
│                                  │          │  auth.ts       (ed25519)      │
│  TwapSection.tsx                 │          │  middleware.ts                │
│   · interceptors                 │          │                               │
│   · Advanced dropdown injection  │          └───────────┬───────────────────┘
│                                  │                      │
│  index.ts (plugin descriptor)    │                      │  POST /v1/order
│                                  │                      ▼
└──────────────────────────────────┘          ┌───────────────────────────────┐
                                              │     Orderly Orderbook         │
                                              └───────────────────────────────┘
```

**Frontend** = SDK plugin (interceptor-based, runs in broker's app)
**Backend** = standalone service (holds session keys, executes slices)

## Plugin Structure (Frontend)

```
src/plugins/twap/
├── index.ts          # Plugin descriptor (OrderlyPlugin)
├── TwapSection.tsx   # Interceptors + shared state
├── TwapForm.tsx      # TWAP order form UI
└── api.ts            # REST client for TWAP backend
```

### Interceptors

| Target | Purpose |
|--------|---------|
| `Trading.OrderEntry.TypeTabs` | Injects "TWAP" into the Advanced dropdown via MutationObserver; shows purple indicator bar when active |
| `OrderEntry` | Replaces the standard order form with `<TwapForm>` when TWAP mode is active |

### Shared State

Two interceptors share TWAP active/inactive state via a module-level store with `useSyncExternalStore` (no context provider needed).

### UI Features

- Buy/Sell toggle
- Total Size input with USDC/base currency toggle (auto-converts via mark price)
- Hours + Minutes duration input (5m - 24h)
- Randomize checkbox (widens price offset)
- Reduce Only checkbox (placeholder)
- Dynamic validation using symbol info API (`base_tick`, `base_min`, `min_notional`)
- Summary panel: frequency, runtime, number of orders, size per suborder
- Active TWAP task list with cancel + progress bar
- Minimum order warnings with USDC equivalent display

## Backend Service

```
backend/
├── src/
│   ├── server.ts      # Express server + CORS + routes
│   ├── engine.ts      # TWAP execution loop
│   ├── api.ts         # Orderly API client (orders, market data, symbol info)
│   ├── auth.ts        # ed25519 request signing
│   ├── db.ts          # Persistence layer (SQLite for demo — swap for your own DB in production)
│   └── middleware.ts   # Rate limiting, input validation, task limits
└── data/              # Auto-created, demo only
```

> **Note:** The demo uses SQLite for zero-config local development. SQLite is NOT recommended for production. Replace `db.ts` with your own persistence layer (e.g. PostgreSQL, MySQL) before deploying.

### Execution Model

1. Frontend sends `POST /twap` with account ID, session key, symbol, side, total qty, duration, num slices
2. Backend creates a task in the database, starts an async execution loop
3. Each slice: fetch mark price -> calculate IOC limit price (mark + offset) -> place order via Orderly API
4. Track progress in database; frontend polls `GET /twap?accountId=xxx` every 3s

### Order Placement

- **Order type**: `IOC` (Immediate-or-Cancel) — guarantees immediate execution or cancellation, no residual limit orders on the book
- **Price**: mark price + offset (demo default: 5bps, 10bps with randomize — adjust based on your market's typical spread)
- **Quantity**: total qty / num slices, rounded down to `base_tick` (fetched dynamically from Orderly symbol info API)
- **Identification**: `order_tag` + `client_order_id: "twap_{timestamp}_{random}_{sliceIndex}"`

### Security (Demo Defaults)

The following values are demo defaults for local testing. **Adjust all limits and thresholds to match your production requirements.**

- CORS origin whitelist (configurable via `CORS_ORIGINS` env var)
- Rate limiting (demo: 3 creates/60s per account, 60 reads/60s per IP)
- Input validation: symbol pattern, qty 0-1M, duration 60s-86400s, slices 2-100, offset 0-500bps
- Active task limit (demo: max 5 per account)
- Session keys held only in-memory for active tasks, never logged or persisted

### API Routes

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/twap` | Create and start a TWAP task |
| `GET` | `/twap?accountId=xxx` | List tasks for an account |
| `GET` | `/twap/:id` | Task detail with slices |
| `DELETE` | `/twap/:id` | Cancel a running task |
| `POST` | `/webhook/execution-report` | Receive fill updates (WS forwarder) |

### Fatal Error Handling

Engine stops a task immediately on these errors (no retry):
- `-1002` Unauthorized
- `-1003` Rate limit
- `-1004` Invalid parameter
- `-1102` Below min notional (< 10 USDC)
- `-1104` Step size violation
- Invalid signature / key not found

## Validation

Frontend and backend both fetch **live symbol rules** from the Orderly API (`GET /v1/public/info/{symbol}`). These values are defined by Orderly, not by this plugin:

| Rule | Orderly API Field | Example (ETH) | Check |
|------|-------------------|---------------|-------|
| Step size | `base_tick` | 0.0001 | Quantity rounded down to tick |
| Min quantity | `base_min` | 0.0001 | Per-suborder >= base_min |
| Min notional | `min_notional` | 10 USDC | Per-suborder value >= min_notional |

Values vary per symbol and may change — the plugin fetches them dynamically (backend caches for 5 min). The frontend applies a 10% buffer on `min_notional` to account for price drift between validation and execution.

## Running Locally

```bash
# Backend
cd backend
npm install
PORT=3100 CORS_ORIGINS="http://localhost:4564" npx tsx src/server.ts

# Frontend (in broker app, e.g. WooFi Pro)
# Register the plugin in your app's plugin config:
import { twapPlugin } from "@/plugins/twap";
// Add twapPlugin to your OrderlyProvider plugins array
```

## Environment Variables (Backend)

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3100` | Server port |
| `CORS_ORIGINS` | `http://localhost:4567,http://localhost:3000` | Comma-separated allowed origins |
| `ORDERLY_API_URL` | `https://testnet-api-evm.orderly.org` | Orderly API base URL |

## Production Readiness

**This demo covers the happy path but lacks the resilience required for production trading.** Below is a checklist of what needs to be addressed before going live.

### Stability

| Gap | Risk | Required Work |
|-----|------|---------------|
| **No order reconciliation** | If a `placeOrder` call times out but Orderly accepted it, we lose track of the order ("ghost order" sitting on the book) | On timeout/error, query `GET /v1/client/order/{client_order_id}` to confirm actual state before moving on |
| **In-memory task state** | Backend restart kills all execution loops; tasks stay `running` in DB but no slices are placed | Startup recovery: scan `running` tasks, resume execution from `slices_placed` count, reconcile each slice via `client_order_id` |
| **No WebSocket fills** | Fill tracking is optimistic; we don't know actual fill qty/price | Subscribe to `executionreport` WS topic, update slice status in real-time, recalculate remaining quantity |
| **Single-process only** | No horizontal scaling; one crash stops everything | Move to a job queue (e.g. BullMQ + Redis) or durable workflow engine (Temporal) |
| **SQLite is demo-only** | File-based DB, no concurrent write safety, no replication | Replace with a production database (PostgreSQL, MySQL, etc.) |
| **No health checks** | No way to detect if engine is stuck or API is down | Add `/health` endpoint, heartbeat monitoring, alerting on stalled tasks |

### Security

| Gap | Risk | Required Work |
|-----|------|---------------|
| **Session keys transit over REST** | Frontend sends `secretKey` in POST body — interceptable if not HTTPS | Enforce HTTPS in production; consider server-side key vault or broker-managed key injection |
| **No authentication on API** | Anyone who knows the backend URL can create/cancel tasks | Add API key or JWT auth; validate that the caller owns the `accountId` |
| **No request signing** | Backend API requests are unsigned — vulnerable to replay/tampering | Add HMAC or JWT-signed requests from frontend to backend |
| **Rate limits are in-memory** | Restart resets all rate limit counters | Move to Redis-backed rate limiting |
| **CORS is the only access control** | CORS is browser-enforced only; cURL/scripts bypass it entirely | Add server-side auth as primary access control, CORS as defense-in-depth |

### Order Execution

| Gap | Risk | Required Work |
|-----|------|---------------|
| **Fixed price offset** | 5-10 bps may not cross the spread on illiquid markets, causing missed fills | Dynamic offset based on current spread; or fallback to MARKET order after IOC miss |
| **No partial fill handling** | If IOC partially fills, remaining qty is lost for that slice | Track partial fills via WS, carry unfilled qty to next slice |
| **No max slippage control** | No price protection beyond the offset | Add configurable max slippage; abort task if market moves beyond threshold |
| **Reduce Only not implemented** | UI checkbox exists but backend ignores it | Pass `reduce_only: true` to Orderly API when enabled |
| **Dead man switch unauthorized** | `cancel_all_after` fails with `-1002` on testnet session keys | Investigate key permissions; implement client-side fallback timer |

### Monitoring & Observability

- Structured logging (JSON) with task ID correlation
- Metrics: orders placed/filled/failed per task, latency per slice, total slippage
- Alerting on: task error rate > threshold, stalled tasks, API errors
- Audit trail: immutable log of every order placed with full request/response

## Known Limitations (Demo)

- **No WebSocket integration**: Fill tracking is optimistic; production should subscribe to `executionreport` WS topic
- **No reconciliation on restart**: If backend restarts, in-flight tasks lose their execution loop (DB status can be cancelled manually)
- **Reduce Only**: UI checkbox exists but backend doesn't pass `reduce_only` to Orderly API yet
- **Single symbol**: Hardcoded `PERP_ETH_USDC` references in some places; should be fully dynamic

## Plugin Submission (Orderly Module Hub)

Only the **frontend plugin** needs to be submitted to Orderly's Module Hub. The backend is broker-operated infrastructure.

What gets submitted:
- `index.ts` — plugin descriptor
- `TwapSection.tsx` — interceptors
- `TwapForm.tsx` — UI form
- `api.ts` — REST client (broker configures their own backend URL)

The backend service is deployed and operated by each broker independently.
