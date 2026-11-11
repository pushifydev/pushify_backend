import { describe, it, expect, beforeEach, vi } from 'vitest';
import { HTTPException } from 'hono/http-exception';

/**
 * A server's own disk alert threshold, set with PATCH /servers/:serverId (`diskAlertPercent`):
 * a whole number from 50 to 99, or null for the install-wide default (85). Owner/admin only.
 */
const h = vi.hoisted(() => ({
  role: 'owner',
  row: {} as Record<string, unknown>,
  updates: [] as Record<string, unknown>[],
}));

vi.mock('../db', () => {
  const select = {
    from: () => select,
    where: () => select,
    limit: async () => [h.row],
    groupBy: async () => [],
  };
  return {
    db: {
      select: () => select,
      update: () => ({
        set: (values: Record<string, unknown>) => ({
          where: () => ({
            returning: async () => {
              h.updates.push(values);
              return [{ ...h.row, ...values }];
            },
          }),
        }),
      }),
    },
  };
});
vi.mock('../repositories/organization.repository', () => ({
  organizationRepository: { findMember: async () => ({ role: h.role }) },
}));

import { serverService } from './server.service';

const update = (body: Record<string, unknown>) =>
  serverService.updateServer('srv-1', 'org-1', 'user-1', body as { diskAlertPercent?: number | null }, 'en');

beforeEach(() => {
  h.role = 'owner';
  h.updates = [];
  h.row = {
    id: 'srv-1', organizationId: 'org-1', name: 'srv', provider: 'hetzner', providerData: {}, labels: {},
    isManaged: true, diskAlertPercent: null, autoPatch: 'off', autoPatchHour: 3, autoPatchWeekday: 0,
  };
});

describe('serverService.updateServer (diskAlertPercent)', () => {
  it('returns the default threshold in effect when none is set', async () => {
    const server = await update({ name: 'renamed' });
    expect(server.diskAlertPercent).toBe(85);
    expect(h.updates[0]).not.toHaveProperty('diskAlertPercent');
  });

  it('stores a threshold from 50 to 99 and returns it', async () => {
    const server = await update({ diskAlertPercent: 75 });
    expect(h.updates[0]).toMatchObject({ diskAlertPercent: 75 });
    expect(server.diskAlertPercent).toBe(75);
    await update({ diskAlertPercent: 50 });
    await update({ diskAlertPercent: 99 });
    expect(h.updates.map((u) => u.diskAlertPercent)).toEqual([75, 50, 99]);
  });

  it('goes back to the default with null', async () => {
    h.row.diskAlertPercent = 70;
    const server = await update({ diskAlertPercent: null });
    expect(h.updates[0]).toMatchObject({ diskAlertPercent: null });
    expect(server.diskAlertPercent).toBe(85);
  });

  it.each([49, 100, 85.5, '85', true])('refuses %s with 400 and stores nothing', async (value) => {
    const err = await update({ diskAlertPercent: value }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HTTPException);
    expect((err as HTTPException).status).toBe(400);
    expect((err as HTTPException).message).toMatch(/50 to 99/);
    expect(h.updates).toHaveLength(0);
  });

  it('is for owners and admins only', async () => {
    h.role = 'member';
    const err = await update({ diskAlertPercent: 75 }).catch((e: unknown) => e);
    expect((err as HTTPException).status).toBe(403);
    expect(h.updates).toHaveLength(0);
  });
});
