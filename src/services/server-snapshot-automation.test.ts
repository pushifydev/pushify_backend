import { describe, it, expect, vi } from 'vitest';

vi.mock('../db', () => ({ db: {} }));

import { serverSnapshotAutomationService, AUTO_SNAPSHOT_DESCRIPTION } from './server-snapshot-automation.service';
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

describe('pruneSnapshots', () => {
  it('removes the oldest automatic snapshots only, until the server is within its limit', async () => {
    const deleteSnapshot = vi.fn(async () => undefined);
    const provider = { deleteSnapshot } as never;
    const pruned = await serverSnapshotAutomationService.pruneSnapshots(
      provider,
      [snap('manual-old', 1, false), snap('auto-1', 2, true), snap('auto-2', 3, true), snap('auto-3', 4, true)],
      2,
    );
    expect(pruned).toBe(2);
    expect(deleteSnapshot.mock.calls.map((c) => (c as unknown as [string])[0])).toEqual(['auto-1', 'auto-2']);
  });

  it('never deletes a snapshot taken by hand, even over the limit', async () => {
    const deleteSnapshot = vi.fn(async () => undefined);
    const pruned = await serverSnapshotAutomationService.pruneSnapshots(
      { deleteSnapshot } as never,
      [snap('m1', 1, false), snap('m2', 2, false), snap('m3', 3, false)],
      1,
    );
    expect(pruned).toBe(0);
    expect(deleteSnapshot).not.toHaveBeenCalled();
  });
});
