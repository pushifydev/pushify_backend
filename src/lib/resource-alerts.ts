/**
 * Telling someone before the app falls over.
 *
 * CPU, memory and network are recorded for every container every 15 seconds, and until now
 * nothing read them. An app pinned at its memory limit is minutes away from being OOM-killed
 * into a restart loop, and the first anyone heard of it was the monitoring saying it had stopped
 * answering — or the customer saying it.
 *
 * The hard part is not the threshold, it is not crying wolf. A container is briefly at 100% CPU
 * every time it starts, and a garbage collector runs at 95% memory by design. So a reading only
 * counts once it has *stayed* over the line long enough to be a condition rather than a moment,
 * and it only clears once it has come back down well under it — otherwise a value sitting on the
 * boundary sends a mail every few minutes.
 */

export type ResourceKind = 'memory' | 'cpu';

export interface ResourceThreshold {
  /** Over this percentage, the clock starts */
  percent: number;
  /** …and it has to stay over for this long before anyone is told */
  sustainMs: number;
  /**
   * It is only over once the reading is this far back under the line. Without the gap, a
   * container oscillating around the threshold alternates "problem" and "recovered" for ever.
   */
  clearMargin: number;
  /**
   * Past this, the stored state is not a live condition — it is a leftover. A project paused
   * while over the line stops producing readings, so nothing clears it; resumed a month later,
   * the first healthy reading would otherwise send "recovered, it was over for 31 days", which
   * is both useless and alarming. Beyond this the state is simply dropped, quietly.
   */
  staleAfterMs: number;
}

/**
 * Memory is the one that kills: past ~90% of the limit the kernel is choosing what to kill next,
 * so five minutes is already generous. CPU saturation makes an app slow rather than dead, and
 * legitimately happens during a build or a batch job, so it has to last much longer to be worth
 * an email.
 */
export const DEFAULT_THRESHOLDS: Record<ResourceKind, ResourceThreshold> = {
  memory: { percent: 90, sustainMs: 5 * 60 * 1000, clearMargin: 10, staleAfterMs: 3 * 24 * 60 * 60 * 1000 },
  cpu: { percent: 90, sustainMs: 15 * 60 * 1000, clearMargin: 15, staleAfterMs: 3 * 24 * 60 * 60 * 1000 },
};

export interface ResourceState {
  /** When the reading first went over the line, or null while it is under */
  since: Date | null;
  /** When someone was told, or null if not yet */
  notifiedAt: Date | null;
}

export interface ResourceSample {
  percent: number;
  /** Which container the reading came from — a project can run several */
  containerName: string;
}

export interface ResourceTransition {
  state: ResourceState;
  /** Set when this reading is the one worth sending a message about */
  notify: 'pressure' | 'recovered' | null;
  /** How long it had been over the line, for the recovery message */
  underPressureForMs?: number;
}

export const EMPTY_RESOURCE_STATE: ResourceState = { since: null, notifiedAt: null };

/**
 * Where one reading leaves the state, and whether it is worth telling anyone.
 *
 * Deliberately pure and time-explicit: the worker passes `now`, so the whole behaviour — how long
 * pressure has to last, when a recovery counts — is testable without waiting for real minutes.
 */
export function nextResourceState(
  previous: ResourceState,
  sample: ResourceSample,
  threshold: ResourceThreshold,
  now: Date
): ResourceTransition {
  const over = sample.percent >= threshold.percent;
  const clearedLine = threshold.percent - threshold.clearMargin;

  if (over) {
    const since = previous.since ?? now;
    const forMs = now.getTime() - since.getTime();

    // Long enough to be a condition, and nobody has been told yet
    if (forMs >= threshold.sustainMs && !previous.notifiedAt) {
      return { state: { since, notifiedAt: now }, notify: 'pressure' };
    }
    return { state: { since, notifiedAt: previous.notifiedAt }, notify: null };
  }

  // Under the line, but still inside the margin: not over any more, not clear either. Hold the
  // state so a reading hovering at the threshold neither re-alerts nor declares victory.
  if (sample.percent > clearedLine) {
    return { state: previous, notify: null };
  }

  // Properly back down
  if (previous.notifiedAt) {
    const forMs = previous.since ? now.getTime() - previous.since.getTime() : 0;
    // A gap this long means nobody was watching, not that it was on fire the whole time
    if (forMs > threshold.staleAfterMs) {
      return { state: EMPTY_RESOURCE_STATE, notify: null };
    }
    return { state: EMPTY_RESOURCE_STATE, notify: 'recovered', underPressureForMs: forMs };
  }
  return { state: EMPTY_RESOURCE_STATE, notify: null };
}

/**
 * The reading that matters for a project, out of all its containers: the highest one. Three
 * replicas at 95% memory is one problem, not three, and the worst container is the one to name.
 */
export function worstSample(samples: ResourceSample[]): ResourceSample | null {
  let worst: ResourceSample | null = null;
  for (const sample of samples) {
    if (!Number.isFinite(sample.percent)) continue;
    if (!worst || sample.percent > worst.percent) worst = sample;
  }
  return worst;
}

/** "4 minutes", "2 hours" — for a message a person reads, not a duration a machine parses. */
export function formatDurationShort(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60000));
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'}`;
}

/** What the reading means, in the words the email uses. */
export function describeResource(kind: ResourceKind, percent: number, containerName: string): string {
  const rounded = Math.round(percent);
  return kind === 'memory'
    ? `${containerName} is using ${rounded}% of the memory it is allowed`
    : `${containerName} has been running at ${rounded}% CPU`;
}
