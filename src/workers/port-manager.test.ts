import { describe, expect, it } from 'vitest';
import type { SSHClient } from '../utils/ssh';
import { getOrAssignPort, type PortRegistry } from './port-manager';

interface MockServer {
  registry: PortRegistry;
  /** Running containers: name, optional compose project label, docker `Ports` column */
  containers: Array<{ name: string; composeProject?: string; ports: string }>;
  /** Host TCP listeners beyond the containers (sshd, postgres, user daemons…) */
  extraListeners: number[];
}

function hostPortsOf(server: MockServer): number[] {
  const ports: number[] = [...server.extraListeners];
  for (const c of server.containers) {
    for (const m of c.ports.matchAll(/:(\d+)->/g)) ports.push(parseInt(m[1], 10));
  }
  return [...new Set(ports)];
}

function mockSSH(server: MockServer): SSHClient {
  const exec = async (cmd: string) => {
    const ok = (stdout: string) => ({ stdout, stderr: '', code: 0 });
    if (cmd.includes('port-registry.json')) return ok(JSON.stringify(server.registry));
    if (cmd.includes('{{.Names}}|')) {
      return ok(
        server.containers
          .map((c) => `${c.name}|${c.composeProject ?? ''}|${c.ports}`)
          .join('\n')
      );
    }
    if (cmd.includes("{{.Ports}}")) {
      return ok(
        [...new Set(server.containers.flatMap((c) => [...c.ports.matchAll(/:(\d+)->/g)].map((m) => m[1])))].join('\n')
      );
    }
    if (cmd.includes('ss -tln') && cmd.includes('awk')) {
      return ok(hostPortsOf(server).join('\n'));
    }
    if (cmd.includes('ss -tln') && cmd.includes('grep -E')) {
      const port = parseInt(cmd.match(/\[:\.\](\d+)/)?.[1] ?? '', 10);
      return ok(hostPortsOf(server).includes(port) ? `LISTEN 0 128 0.0.0.0:${port} 0.0.0.0:*` : '');
    }
    return ok('');
  };
  const uploadFile = async (content: string, path: string) => {
    if (path.includes('port-registry.json')) server.registry = JSON.parse(content);
  };
  return { exec, uploadFile } as unknown as SSHClient;
}

const assignment = (projectSlug: string, port: number) => ({
  projectSlug,
  port,
  assignedAt: '2026-01-01T00:00:00.000Z',
});

describe('getOrAssignPort', () => {
  it('keeps the assigned port while the project container is running on it (redeploy)', async () => {
    const server: MockServer = {
      registry: { assignments: [assignment('my-app', 3001)] },
      containers: [{ name: 'pushify-my-app', ports: '0.0.0.0:3001->3000/tcp' }],
      extraListeners: [],
    };
    const result = await getOrAssignPort(mockSSH(server), 'my-app');
    expect(result).toEqual({ port: 3001, isNew: false });
  });

  it('keeps the assigned port when the stack is down and the port is still free', async () => {
    const server: MockServer = {
      registry: { assignments: [assignment('my-app', 3001)] },
      containers: [],
      extraListeners: [],
    };
    const result = await getOrAssignPort(mockSSH(server), 'my-app');
    expect(result).toEqual({ port: 3001, isNew: false });
  });

  it('reassigns when the recorded port was taken over by another process', async () => {
    const server: MockServer = {
      registry: { assignments: [assignment('my-app', 3001)] },
      containers: [{ name: 'someone-elses-container', ports: '0.0.0.0:3001->8080/tcp' }],
      extraListeners: [],
    };
    const result = await getOrAssignPort(mockSSH(server), 'my-app');
    expect(result).toEqual({ port: 3002, isNew: true });
    expect(server.registry.assignments).toEqual([expect.objectContaining({ projectSlug: 'my-app', port: 3002 })]);
  });

  it('adopts preferredPort from a pre-registry deploy and records it', async () => {
    const server: MockServer = {
      registry: { assignments: [] },
      containers: [
        {
          name: 'pushify-supa-kong-1',
          composeProject: 'pushify-supa',
          ports: '0.0.0.0:5003->8000/tcp, [::]:5003->8000/tcp',
        },
      ],
      extraListeners: [],
    };
    const result = await getOrAssignPort(mockSSH(server), 'supa', {
      range: { min: 5000, max: 5999 },
      preferredPort: 5003,
    });
    expect(result).toEqual({ port: 5003, isNew: false });
    expect(server.registry.assignments).toEqual([expect.objectContaining({ projectSlug: 'supa', port: 5003 })]);
  });

  it('fresh assignment skips docker 0.0.0.0 bindings, host listeners, and other registrations', async () => {
    const server: MockServer = {
      registry: { assignments: [assignment('other-app', 5002)] },
      containers: [{ name: 'pushify-other', ports: '0.0.0.0:5000->80/tcp' }],
      extraListeners: [5001],
    };
    const result = await getOrAssignPort(mockSSH(server), 'new-app', { range: { min: 5000, max: 5999 } });
    expect(result).toEqual({ port: 5003, isNew: true });
  });

  it('treats blue-green containers as the owner, but not a similarly named project', async () => {
    const blueGreen: MockServer = {
      registry: { assignments: [assignment('app', 3001)] },
      containers: [{ name: 'pushify-app-green', ports: '0.0.0.0:3001->3000/tcp' }],
      extraListeners: [],
    };
    expect(await getOrAssignPort(mockSSH(blueGreen), 'app')).toEqual({ port: 3001, isNew: false });

    const otherProject: MockServer = {
      registry: { assignments: [assignment('app', 3001)] },
      containers: [{ name: 'pushify-app-2', ports: '0.0.0.0:3001->3000/tcp' }],
      extraListeners: [],
    };
    expect(await getOrAssignPort(mockSSH(otherProject), 'app')).toEqual({ port: 3002, isNew: true });
  });
});
