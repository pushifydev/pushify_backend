import { describe, it, expect, vi } from 'vitest';
import { projectContainers } from './log-collector';

/**
 * Regression: the collector used to try `-blue`, `-green` and the bare name and stop at the first
 * container it found, so a project's replicas, its staging container and any extra container were
 * never stored — their logs simply did not exist in the history.
 */

const ssh = (stdout: string) =>
  ({ exec: vi.fn().mockResolvedValue({ stdout, stderr: '', code: 0 }) }) as unknown as Parameters<typeof projectContainers>[0];

describe('projectContainers', () => {
  it('lists every container of the project, replicas included', async () => {
    const names = await projectContainers(ssh('pushify-shop-blue\npushify-shop-blue-2\npushify-shop-worker\n'), 'shop');
    expect(names).toEqual(['pushify-shop-blue', 'pushify-shop-blue-2', 'pushify-shop-worker']);
  });

  it('leaves other projects alone — a prefix is not a match', async () => {
    const names = await projectContainers(ssh('pushify-shop\npushify-shopify-blue\npushify-shop-green\n'), 'shop');
    expect(names).toEqual(['pushify-shop', 'pushify-shop-green']);
  });

  it('skips managed database containers of the same name', async () => {
    const names = await projectContainers(ssh('pushify-shop-blue\npushify-db-shop\n'), 'shop');
    expect(names).toEqual(['pushify-shop-blue']);
  });

  it('falls back to the plain name when nothing is running, so a stopped app is still asked', async () => {
    expect(await projectContainers(ssh('\n'), 'shop')).toEqual(['pushify-shop']);
  });
});
