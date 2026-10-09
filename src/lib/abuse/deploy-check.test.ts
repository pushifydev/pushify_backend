import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  env: { ABUSE_DETECTION_ENABLED: true, ABUSE_AUTO_SUSPEND: false, ABUSE_RULES_PATH: undefined as string | undefined },
  covered: vi.fn(async () => true),
  recordFinding: vi.fn(async () => ({ flagId: 'f', created: true })),
  suspendProject: vi.fn(async () => ({})),
  adminNotify: vi.fn(),
}));

vi.mock('../../config/env', () => ({ env: mocks.env }));
vi.mock('../../services/abuse.service', () => ({
  projectIsCovered: mocks.covered,
  abuseService: { recordFinding: mocks.recordFinding, suspendProject: mocks.suspendProject },
}));
vi.mock('../../services/admin-notify.service', () => ({ adminNotify: mocks.adminNotify }));

import { abuseAfterBuild, abuseAfterClone } from './deploy-check';

const ctx = { projectId: 'p', organizationId: 'o', deploymentId: 'd' };
let dir: string;

beforeEach(() => {
  mocks.env.ABUSE_DETECTION_ENABLED = true;
  mocks.env.ABUSE_AUTO_SUSPEND = false;
  mocks.env.ABUSE_RULES_PATH = path.resolve(__dirname, '../../../config/abuse-rules.yaml');
  mocks.covered.mockReset().mockResolvedValue(true);
  mocks.recordFinding.mockClear();
  mocks.suspendProject.mockClear();
  dir = mkdtempSync(path.join(tmpdir(), 'abuse-deploy-'));
  writeFileSync(
    path.join(dir, 'Dockerfile'),
    'RUN git clone https://github.com/TelegramMessenger/MTProxy\nRUN wget https://github.com/XTLS/Xray-core/releases/download/v1/Xray-linux-64.zip',
  );
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('deploy-time Acceptable Use checks', () => {
  it('do nothing when detection is off (self-hosted default)', async () => {
    mocks.env.ABUSE_DETECTION_ENABLED = false;
    expect(await abuseAfterClone({ ...ctx, workDir: dir })).toBeNull();
    expect(mocks.covered).not.toHaveBeenCalled();
    expect(mocks.recordFinding).not.toHaveBeenCalled();
  });

  it('skip projects the hosted rules do not cover (BYOS on its own domain)', async () => {
    mocks.covered.mockResolvedValue(false);
    expect(await abuseAfterClone({ ...ctx, workDir: dir })).toBeNull();
    expect(mocks.recordFinding).not.toHaveBeenCalled();
  });

  it('queue a covered project right after clone, without suspending it', async () => {
    const result = await abuseAfterClone({ ...ctx, workDir: dir });
    expect(result?.flagged).toBe(true);
    expect(mocks.recordFinding).toHaveBeenCalledWith(expect.objectContaining({ source: 'deploy_scan', projectId: 'p' }));
    await abuseAfterBuild({ ...ctx, source: result, buildLog: 'ok' });
    expect(mocks.suspendProject).not.toHaveBeenCalled();
  });

  it('suspend automatically only with ABUSE_AUTO_SUSPEND and a strong, high score', async () => {
    mocks.env.ABUSE_AUTO_SUSPEND = true;
    const result = await abuseAfterClone({ ...ctx, workDir: dir });
    await abuseAfterBuild({ ...ctx, source: result, buildLog: '' });
    expect(mocks.suspendProject).toHaveBeenCalledWith(expect.objectContaining({ adminUserId: null, clause: 'proxy-vpn' }));
  });

  it('never throws into the deploy', async () => {
    mocks.covered.mockRejectedValue(new Error('db down'));
    await expect(abuseAfterClone({ ...ctx, workDir: dir })).resolves.toBeNull();
    await expect(abuseAfterBuild({ ...ctx, source: null, buildLog: '' })).resolves.toBeUndefined();
  });
});
