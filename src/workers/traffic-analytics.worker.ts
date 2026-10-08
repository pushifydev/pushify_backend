import { logger } from '../lib/logger';
import { env } from '../config/env';
import { trafficAnalyticsService } from '../services/traffic-analytics.service';

/** Once an hour: one SSH call per server, aggregated there with awk. */
const COLLECT_INTERVAL_MS = 60 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 5 * 60 * 1000;

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let firstRun: ReturnType<typeof setTimeout> | null = null;
let inProgress = false;

export function startTrafficAnalyticsWorker(): void {
  if (intervalHandle) return;
  if (!env.TRAFFIC_ANALYTICS_ENABLED) {
    logger.info('Traffic analytics disabled (TRAFFIC_ANALYTICS_ENABLED=false)');
    return;
  }
  const tick = () => {
    if (inProgress) return;
    inProgress = true;
    (async () => {
      const collected = await trafficAnalyticsService.collectAll();
      const pruned = await trafficAnalyticsService.prune();
      logger.info({ ...collected, pruned }, 'Traffic analytics collected');
    })()
      .catch((err) => logger.error({ err }, 'Traffic analytics collection failed'))
      .finally(() => {
        inProgress = false;
      });
  };
  intervalHandle = setInterval(tick, COLLECT_INTERVAL_MS);
  firstRun = setTimeout(tick, FIRST_RUN_DELAY_MS);
  logger.info('Traffic analytics worker started (hourly)');
}

export function stopTrafficAnalyticsWorker(): void {
  if (intervalHandle) clearInterval(intervalHandle);
  if (firstRun) clearTimeout(firstRun);
  intervalHandle = null;
  firstRun = null;
}
