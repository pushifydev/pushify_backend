import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import net from 'node:net';
import { tcpProbeCommand } from './remote-docker';

const sh = promisify(execFile);
const probe = async (port: number, env: NodeJS.ProcessEnv = process.env) =>
  (await sh('sh', ['-c', tcpProbeCommand(port)], { env })).stdout.trim();

describe('tcpProbeCommand', () => {
  it('says OK for a listening port and FAIL for a closed one', async () => {
    const server = net.createServer((socket) => socket.end()).listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address() as net.AddressInfo;
    try {
      expect(await probe(port)).toBe('OK');
    } finally {
      server.close();
    }
    expect(await probe(port)).toBe('FAIL');
  });

  it('works on a server without nc', async () => {
    // A PATH with bash/timeout/curl but no nc, like a stock Debian image
    const dir = '/tmp';
    const server = net.createServer((socket) => socket.end()).listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address() as net.AddressInfo;
    try {
      const env = { ...process.env, PATH: ['/bin', '/usr/bin'].join(':') };
      const withoutNc = tcpProbeCommand(port).replace('nc -z', `${dir}/definitely-not-nc -z`);
      const { stdout } = await sh('sh', ['-c', withoutNc], { env });
      expect(stdout.trim()).toBe('OK');
    } finally {
      server.close();
    }
  });
});
