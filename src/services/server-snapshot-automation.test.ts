import { describe, it, expect, vi } from 'vitest';

vi.mock('../db', () => ({ db: {} }));

import { planAutomaticSnapshot, AUTO_SNAPSHOT_DESCRIPTION } from './server-snapshot-automation.service';
import type { Snapshot } from '../providers/cloud-provider.interface';

const snap = (id: string, day: number, auto: boolean): Snapshot => ({
  id,
  name: id,
  description: auto ? AUTO_SNAPSHOT_DESCRIPTION : 'before the upgrade',
  sizeGb: 1,
  status: 'available',
  progress: null,
  createdAt: new Date(Date.UTC(2026, 8, day)),
});

describe('planAutomaticSnapshot', () => {
  it('adds a snapshot below the limit', () => {
    expect(planAutomaticSnapshot([snap('a1', 1, true)], 2)).toEqual({ create: true, replace: null });
  });

  it('at the limit, replaces the oldest automatic snapshot — the count never goes down', () => {
    expect(planAutomaticSnapshot([snap('m', 1, false), snap('a1', 2, true), snap('a2', 3, true)], 3)).toEqual({ create: true, replace: 'a1' });
  });

  it('over a newly enforced limit, still only replaces one: nothing is deleted to get under it', () => {
    const over = [snap('m1', 1, false), snap('m2', 2, false), snap('a1', 3, true), snap('a2', 4, true)];
    expect(planAutomaticSnapshot(over, 1)).toEqual({ create: true, replace: 'a1' });
  });

  it('does nothing when every snapshot was taken by hand and the limit is reached', () => {
    expect(planAutomaticSnapshot([snap('m1', 1, false), snap('m2', 2, false)], 2)).toEqual({ create: false, replace: null });
  });
});
