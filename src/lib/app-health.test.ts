import { describe, it, expect } from 'vitest';
import { formatDuration, nextHealthState, type HealthState } from './app-health';

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
