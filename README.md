# TWAP Plugin for Orderly SDK v3

Time-Weighted Average Price (TWAP) execution strategy, built as an Orderly SDK v3 plugin for WooFi Pro.

## Architecture

```
Frontend (SDK Plugin)              Backend (Node.js Service)
┌─────────────────────┐            ┌──────────────────────┐
│ TwapForm.tsx         │  REST     │ server.ts (Express)   │
│  - UI form           │ ───────> │ engine.ts (executor)  │
│  - validation        │ <─────── │ db.ts (SQLite)        │
│  - task monitoring   │           │ api.ts (Orderly API)  │
│                      │           │ auth.ts (ed25519)     │
│ TwapSection.tsx      │           │ middleware.ts         │
│  - interceptors      │           └──────────┬───────────┘
│  - Advanced dropdown │                      │
│    injection          │                      │ Orderly API
│                      │                      │ (POST /v1/order)
│ index.ts (plugin)    │                      ▼
└─────────────────────┘            ┌──────────────────────┐
                                   │ Orderly Orderbook     │
                                   └──────────────────────┘
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
│   ├── db.ts          # SQLite persistence (tasks + slices)
│   └── middleware.ts   # Rate limiting, input validation, task limits
└── data/
    └── twap.db        # SQLite database (auto-created)
```

### Execution Model

1. Frontend sends `POST /twap` with account ID, session key, symbol, side, total qty, duration, num slices
2. Backend creates a task in SQLite, starts an async execution loop
3. Each slice: fetch mark price -> calculate IOC limit price (mark + offset) -> place order via Orderly API
4. Track progress in SQLite; frontend polls `GET /twap?accountId=xxx` every 3s

### Order Placement

- **Order type**: `IOC` (Immediate-or-Cancel) — guarantees immediate execution or cancellation, no residual limit orders on the book
- **Price**: mark price + offset (default 5bps for sells, 10bps with randomize)
- **Quantity**: total qty / num slices, rounded down to `base_tick` (fetched dynamically from symbol info API)
- **Identification**: `order_tag: "TWAP_DEMO"` + `client_order_id: "twap_{timestamp}_{random}_{sliceIndex}"`

### Security

- CORS origin whitelist (configurable via `CORS_ORIGINS` env var)
- Rate limiting: 3 creates/60s per account, 60 reads/60s per IP
- Input validation: symbol pattern, quantity range, duration range, slice count
- Active task limit: max 5 per account
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

Frontend fetches `GET /v1/public/info/{symbol}` for real-time validation:

| Rule | Source | Check |
|------|--------|-------|
| Step size | `base_tick` (e.g. 0.0001 for ETH) | Quantity rounded to tick |
| Min quantity | `base_min` (e.g. 0.0001) | Per-suborder >= base_min |
| Min notional | `min_notional` (e.g. 10 USDC) | Per-suborder value >= 10 USDC (with 10% buffer) |

Backend also fetches symbol info dynamically (cached 5 min) for the same validations.

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

## Known Limitations

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
