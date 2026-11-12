import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Automatic security update schedules: the cron pattern and maintenance window of a setting, and
 * the BullMQ job schedulers written for it (a fake queue; the servers table is mocked).
 */
const { h } = vi.hoisted(() => ({
  h: { rows: [] as Array<Record<string, unknown>> },
}));

vi.mock('../db', () => ({
  db: { select: () => ({ from: () => ({ where: async () => h.rows }) }) },
}));

import {
  autoPatchCronPattern,
  autoPatchSchedulerId,
  autoPatchWindowEnd,
  isWithinAutoPatchWindow,
  nextAutoPatchAlert,
  reconcileAutoPatchSchedules,
  syncServerAutoPatchSchedule,
  toAutoPatchSettings,
  type AutoPatchSettings,
} from './server-auto-patch';

const daily: AutoPatchSettings = { autoPatch: 'daily', autoPatchHour: 3, autoPatchWeekday: 0 };
const weekly: AutoPatchSettings = { autoPatch: 'weekly', autoPatchHour: 23, autoPatchWeekday: 6 };
const off: AutoPatchSettings = { autoPatch: 'off', autoPatchHour: 3, autoPatchWeekday: 0 };

function fakeQueue(existing: string[] = []) {
  const schedulers = new Map<string, { pattern?: string; tz?: string; template?: unknown }>(
    existing.map((k) => [k, {}])
  );
  return {
    schedulers,
    upsertJobScheduler: vi.fn(async (id: string, repeat: { pattern?: string; tz?: string }, template: unknown) => {
      schedulers.set(id, { ...repeat, template });
      return {} as never;
    }),
    removeJobScheduler: vi.fn(async (id: string) => schedulers.delete(id)),
    getJobSchedulers: vi.fn(async () => [...schedulers.keys()].map((key) => ({ key, name: 'auto-apply' }))),
  };
}

beforeEach(() => {
  h.rows = [];
});

describe('schedule and window', () => {
  it('cron patterns are UTC hour (and weekday) on the hour; off has none', () => {
    expect(autoPatchCronPattern(daily)).toBe('0 3 * * *');
    expect(autoPatchCronPattern(weekly)).toBe('0 23 * * 6');
    expect(autoPatchCronPattern(off)).toBeNull();
  });

  it('the window is the 60 minutes from the hour, on the weekday for weekly', () => {
    expect(isWithinAutoPatchWindow(new Date('2026-11-08T03:00:00Z'), daily)).toBe(true);
    expect(autoPatchWindowEnd(new Date('2026-11-08T03:59:59Z'), daily)?.toISOString()).toBe('2026-11-08T04:00:00.000Z');
    expect(isWithinAutoPatchWindow(new Date('2026-11-08T04:00:00Z'), daily)).toBe(false);
    expect(isWithinAutoPatchWindow(new Date('2026-11-08T02:59:59Z'), daily)).toBe(false);

    // 2026-11-07 is a Saturday
    expect(isWithinAutoPatchWindow(new Date('2026-11-07T23:30:00Z'), weekly)).toBe(true);
    expect(isWithinAutoPatchWindow(new Date('2026-11-08T23:30:00Z'), weekly)).toBe(false);
    expect(isWithinAutoPatchWindow(new Date('2026-11-08T00:10:00Z'), weekly)).toBe(false);

    expect(isWithinAutoPatchWindow(new Date('2026-11-08T03:10:00Z'), off)).toBe(false);
  });

  it('an unknown stored value reads as off', () => {
    expect(toAutoPatchSettings({ autoPatch: 'hourly', autoPatchHour: 3, autoPatchWeekday: 0 }).autoPatch).toBe('off');
  });
});

describe('nextAutoPatchAlert: one email per condition', () => {
  const applied = (rebootRequired: boolean | 'unknown') => ({ status: 'applied' as const, code: null, rebootRequired });
  const failed = (code: string | null) => ({ status: 'failed' as const, code, rebootRequired: null });
  const skipped = { status: 'skipped' as const, code: 'DEPLOY_IN_PROGRESS', rebootRequired: null };

  it('a clean run is never announced', () => {
    expect(nextAutoPatchAlert(null, applied(false))).toEqual({
      notified: { failureCode: null, rebootRequired: false },
      notify: null,
    });
  });

  it('a pending reboot is announced once, not again while it stays pending', () => {
    const first = nextAutoPatchAlert(null, applied(true));
    expect(first).toEqual({ notified: { failureCode: null, rebootRequired: true }, notify: 'reboot_required' });
    const second = nextAutoPatchAlert(first.notified, applied(true));
    expect(second.notify).toBeNull();
    // A reboot state that could not be read, a skipped run or a failure in between change nothing
    expect(nextAutoPatchAlert(second.notified, applied('unknown')).notified.rebootRequired).toBe(true);
    expect(nextAutoPatchAlert(second.notified, skipped)).toEqual({ notified: second.notified, notify: null });
    const afterFailure = nextAutoPatchAlert(second.notified, failed('SSH_ERROR'));
    expect(afterFailure.notify).toBe('failed');
    expect(nextAutoPatchAlert(afterFailure.notified, applied(true)).notify).toBeNull();
  });

  it('a reboot is announced again only after a run found none needed', () => {
    const cleared = nextAutoPatchAlert({ failureCode: null, rebootRequired: true }, applied(false));
    expect(cleared).toEqual({ notified: { failureCode: null, rebootRequired: false }, notify: null });
    expect(nextAutoPatchAlert(cleared.notified, applied(true)).notify).toBe('reboot_required');
  });

  it('a failure is announced once per code, and again after a run that worked', () => {
    const first = nextAutoPatchAlert(null, failed('DOCKER_DEPENDENCY'));
    expect(first).toEqual({ notified: { failureCode: 'DOCKER_DEPENDENCY', rebootRequired: false }, notify: 'failed' });
    expect(nextAutoPatchAlert(first.notified, failed('DOCKER_DEPENDENCY'))).toEqual({ notified: first.notified, notify: null });
    expect(nextAutoPatchAlert(first.notified, skipped).notify).toBeNull();
    expect(nextAutoPatchAlert(first.notified, failed('SSH_ERROR')).notify).toBe('failed');

    const recovered = nextAutoPatchAlert(first.notified, applied(false));
    expect(recovered).toEqual({ notified: { failureCode: null, rebootRequired: false }, notify: null });
    expect(nextAutoPatchAlert(recovered.notified, failed('DOCKER_DEPENDENCY')).notify).toBe('failed');
  });

  it('a failure without a code is still announced once', () => {
    const first = nextAutoPatchAlert(null, failed(null));
    expect(first.notify).toBe('failed');
    expect(nextAutoPatchAlert(first.notified, failed(null)).notify).toBeNull();
  });
});

describe('job schedulers', () => {
  it('turning it on writes a UTC cron scheduler that queues a scheduled run of this server', async () => {
    const queue = fakeQueue();
    expect(await syncServerAutoPatchSchedule({ id: 's-1', organizationId: 'org-1', ...weekly }, queue)).toBe(true);
    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      'auto-patch-s-1',
      { pattern: '0 23 * * 6', tz: 'UTC' },
      { name: 'auto-apply', data: { serverId: 's-1', organizationId: 'org-1', requestedBy: null, trigger: 'auto' } }
    );
    expect(autoPatchSchedulerId('s-1')).not.toContain(':');
  });

  it('turning it off removes the scheduler; without Redis nothing is written', async () => {
    const queue = fakeQueue(['auto-patch-s-1']);
    await syncServerAutoPatchSchedule({ id: 's-1', organizationId: 'org-1', ...off }, queue);
    expect(queue.upsertJobScheduler).not.toHaveBeenCalled();
    expect(queue.schedulers.has('auto-patch-s-1')).toBe(false);
    expect(await syncServerAutoPatchSchedule({ id: 's-1', organizationId: 'org-1', ...daily }, null)).toBe(false);
  });

  it('reconcile writes one per server with the setting on and removes stale ones, leaving others alone', async () => {
    h.rows = [{ id: 's-1', organizationId: 'org-1', ...daily }];
    const queue = fakeQueue(['auto-patch-s-gone', 'some-other-scheduler']);
    expect(await reconcileAutoPatchSchedules(queue)).toEqual({ scheduled: 1, removed: 1 });
    expect([...queue.schedulers.keys()].sort()).toEqual(['auto-patch-s-1', 'some-other-scheduler']);
    expect(queue.schedulers.get('auto-patch-s-1')).toMatchObject({ pattern: '0 3 * * *', tz: 'UTC' });
  });
});
