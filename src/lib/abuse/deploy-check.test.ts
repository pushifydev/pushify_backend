import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  env: { ABUSE_DETECTION_ENABLED: true, ABUSE_AUTO_SUSPEND: false, ABUSE_RULES_PATH: undefined as string | undefined },
  covered: vi.fn(async () => true),
  recordFinding: vi.fn(async () => ({ flagId: 'f', created: true })),
  suspendProject: vi.fn(async () => ({})),
  clearedRuleIds: vi.fn(async () => new Set<string>()),
  adminNotify: vi.fn(),
}));

vi.mock('../../config/env', () => ({ env: mocks.env }));
vi.mock('../../services/abuse.service', () => ({
  projectIsCovered: mocks.covered,
  abuseService: { recordFinding: mocks.recordFinding, suspendProject: mocks.suspendProject, clearedRuleIds: mocks.clearedRuleIds },
}));
vi.mock('../../services/admin-notify.service', () => ({ adminNotify: mocks.adminNotify }));
const autoBan = vi.hoisted(() => vi.fn(async () => false));
vi.mock('../../services/user-ban.service', () => ({ userBanService: { maybeAutoBan: autoBan } }));

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
  mocks.clearedRuleIds.mockReset().mockResolvedValue(new Set());
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

  it('with ABUSE_AUTO_SUSPEND, stops the deploy before the build: suspends, blocks, checks auto-ban', async () => {
    mocks.env.ABUSE_AUTO_SUSPEND = true;
    autoBan.mockClear();
    const result = await abuseAfterClone({ ...ctx, workDir: dir });
    expect(result?.blocked).toBe(true);
    expect(mocks.suspendProject).toHaveBeenCalledTimes(1);
    expect(mocks.suspendProject).toHaveBeenCalledWith(expect.objectContaining({ adminUserId: null, clause: 'proxy-vpn' }));
    expect(autoBan).toHaveBeenCalledWith('p');
  });

  it('does not block when the project is already suspended (409), and never without the setting', async () => {
    mocks.env.ABUSE_AUTO_SUSPEND = true;
    mocks.suspendProject.mockRejectedValueOnce(Object.assign(new Error('already'), { status: 409 }));
    expect((await abuseAfterClone({ ...ctx, workDir: dir }))?.blocked).toBeUndefined();
    mocks.env.ABUSE_AUTO_SUSPEND = false;
    expect((await abuseAfterClone({ ...ctx, workDir: dir }))?.blocked).toBeUndefined();
  });

  it('after an approved review, neither flags nor stops the rules the admin cleared for the project', async () => {
    const found = await abuseAfterClone({ ...ctx, workDir: dir });
    const ruleIds = found!.reasons.map((r) => r.ruleId);
    mocks.recordFinding.mockClear();

    mocks.env.ABUSE_AUTO_SUSPEND = true;
    mocks.clearedRuleIds.mockResolvedValue(new Set(ruleIds));
    const result = await abuseAfterClone({ ...ctx, workDir: dir });
    expect(mocks.clearedRuleIds).toHaveBeenCalledWith('p');
    expect(result?.flagged).toBe(false);
    expect(result?.blocked).toBeUndefined();
    await abuseAfterBuild({ ...ctx, source: found, buildLog: 'ok' });
    expect(mocks.recordFinding).not.toHaveBeenCalled();
    expect(mocks.suspendProject).not.toHaveBeenCalled();
  });

  it('still stops a deploy whose findings were not the ones cleared', async () => {
    mocks.env.ABUSE_AUTO_SUSPEND = true;
    mocks.clearedRuleIds.mockResolvedValue(new Set(['some-other-rule']));
    expect((await abuseAfterClone({ ...ctx, workDir: dir }))?.blocked).toBe(true);
    expect(mocks.suspendProject).toHaveBeenCalledTimes(1);
  });

  it('never throws into the deploy', async () => {
    mocks.covered.mockRejectedValue(new Error('db down'));
    await expect(abuseAfterClone({ ...ctx, workDir: dir })).resolves.toBeNull();
    await expect(abuseAfterBuild({ ...ctx, source: null, buildLog: '' })).resolves.toBeUndefined();
  });
});
