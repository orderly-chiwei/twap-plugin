/**
 * Security middleware for TWAP service.
 *
 * - Rate limiting: per-account and per-IP
 * - Input validation: strict schema checks
 * - CORS: configurable origin whitelist
 */

import type { Request, Response, NextFunction } from "express";

// ─── Rate Limiter ──────────────────────────────────────────

interface RateBucket {
  count: number;
  resetAt: number;
}

const rateBuckets = new Map<string, RateBucket>();

// Clean stale buckets every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateBuckets) {
    if (bucket.resetAt < now) rateBuckets.delete(key);
  }
}, 5 * 60_000);

function checkRate(key: string, maxRequests: number, windowMs: number): boolean {
  const now = Date.now();
  const bucket = rateBuckets.get(key);

  if (!bucket || bucket.resetAt < now) {
    rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }

  if (bucket.count >= maxRequests) return false;
  bucket.count++;
  return true;
}

/**
 * Rate limit: max `limit` requests per `windowSec` seconds, keyed by account or IP.
 */
export function rateLimit(opts: { limit: number; windowSec: number; keyFn?: (req: Request) => string }) {
  const { limit, windowSec, keyFn } = opts;
  const windowMs = windowSec * 1000;

  return (req: Request, res: Response, next: NextFunction) => {
    const key = keyFn ? keyFn(req) : req.ip || "unknown";
    if (!checkRate(key, limit, windowMs)) {
      res.status(429).json({ error: "Too many requests. Please try again later." });
      return;
    }
    next();
  };
}

// ─── Input Validation ──────────────────────────────────────

const SYMBOL_PATTERN = /^PERP_[A-Z0-9]+_USD[CT]$/;

export function validateCreateTwap(req: Request, res: Response, next: NextFunction) {
  const { accountId, secretKey, symbol, side, totalQty, durationSec, numSlices, priceOffsetBps } =
    req.body ?? {};

  const errors: string[] = [];

  if (!accountId || typeof accountId !== "string" || !accountId.startsWith("0x")) {
    errors.push("accountId must be a valid 0x-prefixed hex string");
  }

  if (!secretKey || typeof secretKey !== "string" || secretKey.length < 30) {
    errors.push("secretKey is required");
  }

  if (!symbol || typeof symbol !== "string" || !SYMBOL_PATTERN.test(symbol)) {
    errors.push("symbol must match PERP_XXX_USDC or PERP_XXX_USDT format");
  }

  if (!["BUY", "SELL"].includes(side)) {
    errors.push("side must be BUY or SELL");
  }

  const qty = Number(totalQty);
  if (!Number.isFinite(qty) || qty <= 0 || qty > 1_000_000) {
    errors.push("totalQty must be a positive number (max 1,000,000)");
  }

  const dur = Number(durationSec);
  if (!Number.isFinite(dur) || dur < 60 || dur > 86_400) {
    errors.push("durationSec must be 60–86400 (1 min to 24 hours)");
  }

  const slices = Number(numSlices);
  if (!Number.isInteger(slices) || slices < 2 || slices > 100) {
    errors.push("numSlices must be an integer 2–100");
  }

  if (priceOffsetBps !== undefined) {
    const bps = Number(priceOffsetBps);
    if (!Number.isFinite(bps) || bps < 0 || bps > 500) {
      errors.push("priceOffsetBps must be 0–500");
    }
  }

  if (errors.length > 0) {
    res.status(400).json({ error: "Validation failed", details: errors });
    return;
  }

  next();
}

// ─── Active task limit per account ─────────────────────────

const MAX_ACTIVE_PER_ACCOUNT = 5;

export function checkActiveTaskLimit(getCount: (accountId: string) => number) {
  return (req: Request, res: Response, next: NextFunction) => {
    const { accountId } = req.body;
    if (accountId && getCount(accountId) >= MAX_ACTIVE_PER_ACCOUNT) {
      res.status(429).json({
        error: `Maximum ${MAX_ACTIVE_PER_ACCOUNT} active TWAP tasks per account. Cancel existing tasks first.`,
      });
      return;
    }
    next();
  };
}
