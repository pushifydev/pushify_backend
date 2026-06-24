import { env } from '../config/env';
import { logger } from './logger';

/**
 * Dynamic EUR→USD rate for infra billing.
 *
 * We pay Hetzner in EUR but charge customers in USD, so a strengthening EUR
 * erodes (or eventually wipes out) the infra margin. This module keeps a live
 * rate cached in-memory so pricing never blocks on the network, and falls back
 * to a conservative floor if the live fetch fails.
 *
 * Source: ECB daily reference rate via Frankfurter (free, no API key).
 */
const FX_URL = 'https://api.frankfurter.dev/v1/latest?base=EUR&symbols=USD';

/** ECB publishes once per working day (~16:00 CET), so refreshing twice a day is plenty. */
const TTL_MS = 12 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5000;

/** Never charge using a rate below this — safety net if FX dips or the API returns bad data. */
const FLOOR_RATE = env.INFRA_EUR_TO_USD_RATE;
/** Multiplier applied on top of the live rate to absorb intraday swings (ECB rate is up to ~1 day stale). */
const BUFFER = 1 + env.INFRA_FX_BUFFER_PERCENT / 100;

let cachedRate = FLOOR_RATE;
let lastFetchedAt = 0;
let refreshing: Promise<void> | null = null;

async function fetchLiveRate(): Promise<number> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(FX_URL, { signal: controller.signal });
    if (!res.ok) throw new Error(`FX HTTP ${res.status}`);
    const data = (await res.json()) as { rates?: { USD?: number } };
    const usd = data.rates?.USD;
    if (typeof usd !== 'number' || !Number.isFinite(usd) || usd <= 0) {
      throw new Error('FX response missing a valid USD rate');
    }
    return usd;
  } finally {
    clearTimeout(timer);
  }
}

/** Refresh the cached rate from the live source. Coalesces concurrent calls. Never throws. */
export async function refreshEurToUsdRate(): Promise<void> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const live = await fetchLiveRate();
      const buffered = live * BUFFER;
      // Floor guard: we only ever move the rate UP from the configured minimum.
      cachedRate = Math.max(buffered, FLOOR_RATE);
      lastFetchedAt = Date.now();
      logger.info(
        {
          liveEurUsd: Number(live.toFixed(4)),
          bufferedEurUsd: Number(buffered.toFixed(4)),
          appliedEurUsd: Number(cachedRate.toFixed(4)),
          floor: FLOOR_RATE,
        },
        'EUR→USD rate refreshed',
      );
    } catch (err) {
      // Billing must never block or under-charge on FX failure — keep the last good (or floor) rate.
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), appliedEurUsd: cachedRate },
        'EUR→USD refresh failed, keeping previous rate',
      );
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

/**
 * Synchronous read used by pricing. Returns the cached rate immediately and
 * kicks off a non-blocking refresh when the cache is stale.
 */
export function getEurToUsdRate(): number {
  if (Date.now() - lastFetchedAt > TTL_MS) {
    void refreshEurToUsdRate();
  }
  return cachedRate;
}

/** Prime the cache at startup. Fire-and-forget — callers should not await. */
export function primeEurToUsdRate(): Promise<void> {
  return refreshEurToUsdRate();
}
