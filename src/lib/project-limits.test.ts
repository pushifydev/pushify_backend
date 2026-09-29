import { beforeEach, describe, expect, it, vi } from 'vitest';

// The services read existing rows through db.select().from().where(); the test
// controls how many rows "exist" and fails loudly if anything gets inserted.
const state = vi.hoisted(() => ({ existingRows: 0, inserted: 0 }));

vi.mock('../db', () => {
  const where = () => Promise.resolve(Array.from({ length: state.existingRows }, (_, i) => ({ id: `row-${i}` })));
  const insertChain = {
    values: () => {
      state.inserted++;
      return { returning: () => Promise.resolve([{ id: 'new' }]) };
    },
  };
  return {
    db: {
      select: () => ({ from: () => ({ where }) }),
      insert: () => insertChain,
    },
  };
});

vi.mock('./org-access', () => ({
  requireProjectMember: vi.fn(async () => ({ project: { id: 'p1' } })),
}));

import { PROJECT_LIMITS } from './project-limits';
import { parsePushifyConfig } from './pushify-config';
import { scheduledTaskService } from '../services/scheduled-task.service';
import { projectVolumeService } from '../services/project-volume.service';
import { MAX_WORKERS_PER_PROJECT } from './worker-validate';

const TASK = PROJECT_LIMITS.scheduledTasks;

function yamlWithCron(count: number, timeoutSeconds?: number): string {
  const items = Array.from({ length: count }, (_, i) =>
    [
      `  - name: job-${i}`,
      `    schedule: "0 3 * * *"`,
      `    command: node job.js`,
      ...(timeoutSeconds !== undefined ? [`    timeoutSeconds: ${timeoutSeconds}`] : []),
    ].join('\n'),
  );
  return `cron:\n${items.join('\n')}\n`;
}

function yamlWithVolumes(count: number): string {
  const items = Array.from({ length: count }, (_, i) => `  - name: vol${i}\n    path: /data/v${i}`);
  return `volumes:\n${items.join('\n')}\n`;
}

function yamlWithWorkers(count: number): string {
  const items = Array.from({ length: count }, (_, i) => `  - name: w${i}\n    command: node worker.js`);
  return `workers:\n${items.join('\n')}\n`;
}

describe('pushify.yaml schema uses PROJECT_LIMITS', () => {
  it('accepts exactly the cron limit and rejects one more', () => {
    expect(parsePushifyConfig(yamlWithCron(TASK.maxPerProject)).error).toBeNull();
    expect(parsePushifyConfig(yamlWithCron(TASK.maxPerProject + 1)).error).not.toBeNull();
  });

  it('accepts the timeout bounds and rejects values outside them', () => {
    expect(parsePushifyConfig(yamlWithCron(1, TASK.minTimeoutSeconds)).error).toBeNull();
    expect(parsePushifyConfig(yamlWithCron(1, TASK.maxTimeoutSeconds)).error).toBeNull();
    expect(parsePushifyConfig(yamlWithCron(1, TASK.minTimeoutSeconds - 1)).error).not.toBeNull();
    expect(parsePushifyConfig(yamlWithCron(1, TASK.maxTimeoutSeconds + 1)).error).not.toBeNull();
  });

  it('accepts exactly the volume limit and rejects one more', () => {
    expect(parsePushifyConfig(yamlWithVolumes(PROJECT_LIMITS.volumes.maxPerProject)).error).toBeNull();
    expect(parsePushifyConfig(yamlWithVolumes(PROJECT_LIMITS.volumes.maxPerProject + 1)).error).not.toBeNull();
  });

  it('accepts exactly the worker limit and rejects one more', () => {
    expect(MAX_WORKERS_PER_PROJECT).toBe(PROJECT_LIMITS.workers.maxPerProject);
    expect(parsePushifyConfig(yamlWithWorkers(PROJECT_LIMITS.workers.maxPerProject)).error).toBeNull();
    expect(parsePushifyConfig(yamlWithWorkers(PROJECT_LIMITS.workers.maxPerProject + 1)).error).not.toBeNull();
  });
});

describe('services use the same PROJECT_LIMITS', () => {
  const task = { name: 'job', type: 'command' as const, schedule: '0 3 * * *', command: 'node job.js' };

  beforeEach(() => {
    state.existingRows = 0;
    state.inserted = 0;
  });

  it('scheduled tasks: timeout bounds match the schema', async () => {
    await expect(
      scheduledTaskService.createTask('p1', 'o1', 'u1', { ...task, timeoutSeconds: TASK.maxTimeoutSeconds + 1 }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      scheduledTaskService.createTask('p1', 'o1', 'u1', { ...task, timeoutSeconds: TASK.minTimeoutSeconds - 1 }),
    ).rejects.toMatchObject({ status: 400 });
    expect(state.inserted).toBe(0);

    await scheduledTaskService.createTask('p1', 'o1', 'u1', { ...task, timeoutSeconds: TASK.maxTimeoutSeconds });
    expect(state.inserted).toBe(1);
  });

  it('scheduled tasks: the count limit matches the schema', async () => {
    state.existingRows = TASK.maxPerProject;
    await expect(scheduledTaskService.createTask('p1', 'o1', 'u1', task)).rejects.toMatchObject({ status: 400 });
    state.existingRows = TASK.maxPerProject - 1;
    await scheduledTaskService.createTask('p1', 'o1', 'u1', task);
    expect(state.inserted).toBe(1);
  });

  it('volumes: the count limit matches the schema', async () => {
    const volume = { name: 'uploads', containerPath: '/app/uploads' };
    state.existingRows = PROJECT_LIMITS.volumes.maxPerProject;
    await expect(projectVolumeService.createVolume('p1', 'o1', 'u1', volume)).rejects.toMatchObject({ status: 400 });
    state.existingRows = PROJECT_LIMITS.volumes.maxPerProject - 1;
    await projectVolumeService.createVolume('p1', 'o1', 'u1', volume);
    expect(state.inserted).toBe(1);
  });
});
