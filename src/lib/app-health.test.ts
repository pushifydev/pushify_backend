import { describe, it, expect } from 'vitest';
import { classifyDownReason, describeEdgeStatus, dueReminderStep, formatDuration, nextHealthState, type HealthState } from './app-health';

const t = (minutes: number) => new Date(Date.UTC(2026, 8, 22, 12, minutes));
const state = (overrides: Partial<HealthState> = {}): HealthState => ({
  status: 'up',
  failCount: 0,
  downSince: null,
  notifiedAt: null,
  ...overrides,
});

describe('nextHealthState', () => {
  it('one failed check is not an outage', () => {
    const first = nextHealthState(state(), { healthy: false, statusCode: 502 }, 3, t(1));
    expect(first.state.status).toBe('up');
    expect(first.state.failCount).toBe(1);
    expect(first.notify).toBeNull();
  });

  it('warns once when the threshold is reached, and not again while it stays down', () => {
    let s = state();
    for (const minute of [1, 2]) s = nextHealthState(s, { healthy: false }, 3, t(minute)).state;
    const third = nextHealthState(s, { healthy: false }, 3, t(3));
    expect(third.state.status).toBe('down');
    expect(third.notify).toBe('down');
    expect(third.state.downSince).toEqual(t(3));

    const fourth = nextHealthState(third.state, { healthy: false }, 3, t(4));
    expect(fourth.notify).toBeNull();
    expect(fourth.state.status).toBe('down');
  });

  it('reports recovery once, with how long it was down', () => {
    const down = nextHealthState(state({ status: 'down', failCount: 3, downSince: t(3), notifiedAt: t(3) }), { healthy: true }, 3, t(20));
    expect(down.state.status).toBe('up');
    expect(down.notify).toBe('up');
    expect(down.downForMs).toBe(17 * 60 * 1000);

    const later = nextHealthState(down.state, { healthy: true }, 3, t(21));
    expect(later.notify).toBeNull();
  });

  it('says nothing about a recovery nobody was told about', () => {
    const recovered = nextHealthState(state({ status: 'up', failCount: 2 }), { healthy: true }, 3, t(5));
    expect(recovered.notify).toBeNull();
    expect(recovered.state.failCount).toBe(0);
  });

  it('formats how long it was down', () => {
    expect(formatDuration(60_000)).toBe('1 minute');
    expect(formatDuration(17 * 60_000)).toBe('17 minutes');
    expect(formatDuration(65 * 60_000)).toBe('1 hour 5 minutes');
    expect(formatDuration(120 * 60_000)).toBe('2 hours');
  });
});

describe('classifyDownReason', () => {
  it('no HTTP answer ("fetch failed") is the server or network, not the app', () => {
    expect(classifyDownReason({ statusCode: null, error: 'fetch failed' })).toBe('server_unreachable');
    expect(classifyDownReason({ error: 'Timeout' })).toBe('server_unreachable');
    expect(classifyDownReason({ error: 'fetch failed', serverReachable: false })).toBe('server_unreachable');
  });

  it('an HTTP 5xx is the app', () => {
    expect(classifyDownReason({ statusCode: 502 })).toBe('app_error');
    expect(classifyDownReason({ statusCode: 500, serverReachable: false })).toBe('app_error');
  });

  it('no HTTP answer while SSH still works is the app (hung or not listening)', () => {
    expect(classifyDownReason({ error: 'fetch failed', serverReachable: true })).toBe('app_error');
  });

  it('a failed latest deployment wins', () => {
    expect(classifyDownReason({ statusCode: 502, latestDeployFailed: true })).toBe('deploy_failed');
    expect(classifyDownReason({ error: 'fetch failed', latestDeployFailed: true })).toBe('deploy_failed');
  });
});

describe('describeEdgeStatus', () => {
  it('names a Cloudflare 520 as an empty response from the app', () => {
    expect(describeEdgeStatus(520)).toMatch(/^App returned an empty response \(HTTP 520\)/);
  });

  it('explains the other Cloudflare origin errors', () => {
    for (const code of [521, 522, 523, 524, 525, 526]) expect(describeEdgeStatus(code)).toContain(`HTTP ${code}`);
  });

  it('leaves ordinary statuses alone', () => {
    for (const code of [undefined, null, 0, 200, 404, 500, 502, 503]) expect(describeEdgeStatus(code)).toBeNull();
  });
});

describe('outage reminders', () => {
  const HOUR = 60 * 60 * 1000;
  const start = t(0);
  const at = (hours: number) => new Date(start.getTime() + hours * HOUR);
  const down = (overrides: Partial<HealthState> = {}) =>
    state({ status: 'down', failCount: 3, downSince: start, notifiedAt: start, reminderStep: 0, ...overrides });

  it('counts the 24h and 72h thresholds', () => {
    expect(dueReminderStep(null, at(100))).toBe(0);
    expect(dueReminderStep(start, at(23.9))).toBe(0);
    expect(dueReminderStep(start, at(24))).toBe(1);
    expect(dueReminderStep(start, at(71.9))).toBe(1);
    expect(dueReminderStep(start, at(72))).toBe(2);
    expect(dueReminderStep(start, at(24 * 15))).toBe(2);
  });

  it('sends nothing before 24h, one reminder at 24h, one at 72h, then stops', () => {
    let s = down();
    const sent: string[] = [];
    // A check every 30 minutes for 15 days
    for (let h = 0.5; h <= 24 * 15; h += 0.5) {
      const next = nextHealthState(s, { healthy: false, error: 'fetch failed' }, 3, at(h));
      if (next.notify) sent.push(`${next.notify}@${h}`);
      s = next.state;
    }
    expect(sent).toEqual(['reminder@24', 'reminder@72']);
    expect(s.reminderStep).toBe(2);
  });

  it('reports how long it has been down in the reminder', () => {
    const next = nextHealthState(down(), { healthy: false }, 3, at(24));
    expect(next.notify).toBe('reminder');
    expect(next.downForMs).toBe(24 * HOUR);
  });

  it('sends one reminder, not two, when both thresholds passed between checks', () => {
    const first = nextHealthState(down(), { healthy: false }, 3, at(80));
    expect(first.notify).toBe('reminder');
    expect(first.state.reminderStep).toBe(2);
    expect(nextHealthState(first.state, { healthy: false }, 3, at(81)).notify).toBeNull();
  });

  it('a recovery resets reminders so the next outage starts fresh', () => {
    const recovered = nextHealthState(down({ reminderStep: 2 }), { healthy: true }, 3, at(100));
    expect(recovered.notify).toBe('up');
    expect(recovered.state.reminderStep).toBe(0);
  });

  it('the first alert is still the down alert, not a reminder', () => {
    const s = state({ failCount: 2, reminderStep: 0 });
    const next = nextHealthState(s, { healthy: false }, 3, at(1));
    expect(next.notify).toBe('down');
    expect(next.state.reminderStep).toBe(0);
  });
});
