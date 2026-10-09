import { execFileSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({ db: {} }));

import { appContainerPattern, projectContainerPattern, slugsConflict } from './project-containers';
import { buildAppShellCommand } from '../routes/server-terminal-ws';

/** What a shared runner might be running: project "app", plus other organizations' projects. */
const RUNNER = [
  // project "app" (workers: queue)
  'pushify-app',
  'pushify-app-blue',
  'pushify-app-green-2',
  'pushify-app-staging-blue',
  'pushify-app-pr-12-blue',
  'pushify-preview-app-pr-12',
  'pushify-app-db',
  'pushify-app-worker-queue',
  // other organizations — must never match "app"
  'pushify-app-store-blue',
  'pushify-app-store-worker-mail',
  'pushify-apple-blue',
  'pushify-app-pr-x-blue',
  'pushify-preview-app-store-pr-3',
  'pushify-app-worker-other',
];

/** Run the pattern through real `grep -E`, as the remote commands do. */
function grep(pattern: string): string[] {
  try {
    return execFileSync('grep', ['-E', pattern], { input: RUNNER.join('\n') + '\n' }).toString().trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

describe('exact project container names', () => {
  it("match the project's own containers and none of another organization's", () => {
    expect(grep(projectContainerPattern('app', ['queue'])).sort()).toEqual(
      [
        'pushify-app',
        'pushify-app-blue',
        'pushify-app-db',
        'pushify-app-green-2',
        'pushify-app-pr-12-blue',
        'pushify-app-staging-blue',
        'pushify-app-worker-queue',
        'pushify-preview-app-pr-12',
      ].sort(),
    );
  });

  it('only take workers the project actually has', () => {
    expect(grep(projectContainerPattern('app'))).not.toContain('pushify-app-worker-queue');
    expect(grep(projectContainerPattern('app', ['queue']))).not.toContain('pushify-app-worker-other');
  });

  it('the app pattern is production, staging and previews of this slug only', () => {
    const hits = grep(appContainerPattern('app'));
    expect(hits).toContain('pushify-app-blue');
    expect(hits).not.toContain('pushify-app-store-blue');
    expect(hits).not.toContain('pushify-apple-blue');
  });

  it('refuse slugs that are not plain [a-z0-9-]', () => {
    expect(() => projectContainerPattern("app'; rm -rf /")).toThrow();
  });
});

describe('slugsConflict', () => {
  it('identical slugs and deployer-suffixed slugs conflict; ordinary prefixes do not', () => {
    expect(slugsConflict('spiderpanel', 'spiderpanel')).toBe(true);
    expect(slugsConflict('app', 'app-staging')).toBe(true);
    expect(slugsConflict('app-pr-7', 'app')).toBe(true);
    expect(slugsConflict('app', 'app-worker-mail')).toBe(true);
    expect(slugsConflict('app', 'app-store')).toBe(false);
    expect(slugsConflict('app', 'apple')).toBe(false);
  });
});

describe('app shell target', () => {
  it('attaches only to pushify-<slug>[-blue|-green], with no looser fallback', () => {
    const cmd = buildAppShellCommand('app');
    expect(cmd).toContain('^pushify-app(-blue|-green)?$');
    expect(cmd).not.toContain('(-|$)');
  });
});
