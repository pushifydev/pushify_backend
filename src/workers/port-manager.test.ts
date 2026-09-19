import { describe, it, expect, vi } from 'vitest';
import type { SSHClient } from '../utils/ssh';
import { pickSwitchPort, recordPortAssignment } from './port-manager';

/**
 * The blue-green switch needs a second host port while the old container still serves on
 * the first. `pickSwitchPort` must reuse the current port when it is free and otherwise hand
 * out one that neither the registry, Docker nor any host listener holds.
 */
function fakeSsh(state: { listening: number[]; dockerPorts: number[]; registry: unknown }) {
  const uploads: { content: string; path: string }[] = [];
  const ssh = {
    exec: vi.fn(async (cmd: string) => {
      if (cmd.includes('cat /opt/pushify/port-registry.json')) {
        return { code: 0, stdout: JSON.stringify(state.registry), stderr: '' };
      }
      if (cmd.startsWith('docker ps')) {
        return { code: 0, stdout: state.dockerPorts.join('\n'), stderr: '' };
      }
      // isPortListening: `ss -tln ... | grep -E "[:.]<port>( |$)"`
      const single = cmd.match(/\[:\.\](\d+)\( \|\$\)/);
      if (single) {
        const port = Number(single[1]);
        return { code: 0, stdout: state.listening.includes(port) ? `LISTEN 0.0.0.0:${port}` : '', stderr: '' };
      }
      if (cmd.startsWith('ss -tln')) {
        return { code: 0, stdout: state.listening.join('\n'), stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    }),
    uploadFile: vi.fn(async (content: string, path: string) => {
      uploads.push({ content, path });
    }),
  };
  return { ssh: ssh as unknown as SSHClient, uploads };
}

describe('pickSwitchPort', () => {
  it('reuses the current port when nothing listens on it (first deploy, stack down)', async () => {
    const { ssh } = fakeSsh({ listening: [], dockerPorts: [], registry: { assignments: [] } });
    expect(await pickSwitchPort(ssh, 3005)).toBe(3005);
  });

  it('hands out a port that is not registered, published or listening when the current one is busy', async () => {
    const { ssh } = fakeSsh({
      listening: [3001, 3002],
      dockerPorts: [3003],
      registry: { assignments: [{ port: 3004, projectSlug: 'other', assignedAt: 'x' }] },
    });
    // 3001 is the busy current port; 3002 listening; 3003 docker; 3004 registered → 3005
    expect(await pickSwitchPort(ssh, 3001)).toBe(3005);
  });

  it('fails clearly when the range is exhausted', async () => {
    const { ssh } = fakeSsh({ listening: [3001], dockerPorts: [], registry: { assignments: [] } });
    await expect(pickSwitchPort(ssh, 3001, { min: 3001, max: 3001 })).rejects.toThrow('No available ports');
  });
});

describe('recordPortAssignment', () => {
  it('replaces the project entry and keeps everyone else', async () => {
    const { ssh, uploads } = fakeSsh({
      listening: [], dockerPorts: [],
      registry: { assignments: [{ port: 3001, projectSlug: 'shop', assignedAt: 'x' }, { port: 3002, projectSlug: 'blog', assignedAt: 'x' }] },
    });
    await recordPortAssignment(ssh, 'shop', 3005);
    const saved = JSON.parse(uploads[0].content) as { assignments: { port: number; projectSlug: string }[] };
    expect(saved.assignments.map((a) => [a.projectSlug, a.port])).toEqual([['blog', 3002], ['shop', 3005]]);
    expect(uploads[0].path).toBe('/opt/pushify/port-registry.json');
  });
});
