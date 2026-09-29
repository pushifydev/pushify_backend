import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildKeyRemovalCommand,
  buildManualKeyRemovalCommand,
  keyBody,
  keyComment,
  removePushifyKey,
} from './server-key-removal';

const PUSHIFY_KEY = 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAACAQDpushifyKEY+/= pushify-1a2b3c4d-1727600000000';
const USER_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIuserKEYuserKEYuserKEYuserKEY user@laptop';

function withAuthorizedKeys(content: string, run: (home: string, file: string) => void) {
  const home = mkdtempSync(join(tmpdir(), 'pushify-ak-'));
  try {
    mkdirSync(join(home, '.ssh'));
    const file = join(home, '.ssh', 'authorized_keys');
    writeFileSync(file, content);
    chmodSync(file, 0o600);
    run(home, file);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function runRemoval(home: string): number {
  try {
    execFileSync('bash', ['-c', buildKeyRemovalCommand(PUSHIFY_KEY)!], { env: { ...process.env, HOME: home } });
    return 0;
  } catch (err) {
    return (err as { status?: number }).status ?? 1;
  }
}

describe('key parsing', () => {
  it('extracts type + blob and the pushify comment', () => {
    expect(keyBody(PUSHIFY_KEY)).toBe('ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAACAQDpushifyKEY+/=');
    expect(keyComment(PUSHIFY_KEY)).toBe('pushify-1a2b3c4d-1727600000000');
    expect(keyComment(USER_KEY)).toBeNull();
  });

  it('refuses anything that could break out of the shell quoting', () => {
    expect(keyBody("ssh-rsa AAAA'; rm -rf / #")).toBeNull();
    expect(buildKeyRemovalCommand('not a key')).toBeNull();
    expect(keyComment("ssh-rsa AAAA pushify-x';id;'")).toBeNull();
  });
});

describe('buildKeyRemovalCommand (run in a real shell)', () => {
  it('removes only the Pushify key and keeps the file mode', () => {
    withAuthorizedKeys(`${USER_KEY}\n${PUSHIFY_KEY}\n${USER_KEY.replace('user@laptop', 'other')}\n`, (home, file) => {
      expect(runRemoval(home)).toBe(0);
      const left = readFileSync(file, 'utf8');
      expect(left).not.toContain('pushifyKEY');
      expect(left).toContain('user@laptop');
      expect(left).toContain('other');
      expect(statSync(file).mode & 0o777).toBe(0o600);
    });
  });

  it('succeeds when the key is already gone, the file becomes empty, or there is no file', () => {
    withAuthorizedKeys(`${USER_KEY}\n`, (home, file) => {
      expect(runRemoval(home)).toBe(0);
      expect(readFileSync(file, 'utf8')).toBe(`${USER_KEY}\n`);
    });
    withAuthorizedKeys(`${PUSHIFY_KEY}\n${PUSHIFY_KEY}\n`, (home, file) => {
      expect(runRemoval(home)).toBe(0);
      expect(readFileSync(file, 'utf8')).toBe('');
    });
    const empty = mkdtempSync(join(tmpdir(), 'pushify-ak-'));
    try {
      expect(runRemoval(empty)).toBe(0);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe('buildManualKeyRemovalCommand', () => {
  it('targets the key by its pushify comment', () => {
    expect(buildManualKeyRemovalCommand(PUSHIFY_KEY)).toBe(
      "sed -i '/ pushify-1a2b3c4d-1727600000000$/d' /root/.ssh/authorized_keys",
    );
  });

  it('falls back to the key body when there is no pushify comment', () => {
    expect(buildManualKeyRemovalCommand(USER_KEY)).toContain("grep -vF 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIuserKEYuserKEYuserKEYuserKEY'");
  });
});

describe('removePushifyKey', () => {
  function fakeClient(opts: { connect?: () => Promise<void>; code?: number; stderr?: string }) {
    const calls: string[] = [];
    let disconnected = false;
    return {
      calls,
      get disconnected() { return disconnected; },
      client: {
        connect: opts.connect ?? (async () => {}),
        exec: async (cmd: string) => { calls.push(cmd); return { stdout: '', stderr: opts.stderr ?? '', code: opts.code ?? 0 }; },
        disconnect: () => { disconnected = true; },
      },
    };
  }

  it('reports success when the command exits 0', async () => {
    const f = fakeClient({});
    const r = await removePushifyKey({ host: '203.0.113.5', publicKey: PUSHIFY_KEY, privateKey: 'k' }, () => f.client as never);
    expect(r).toEqual({ keyRemoved: true });
    expect(f.calls[0]).toContain("grep -vF 'ssh-rsa AAAAB3");
    expect(f.disconnected).toBe(true);
  });

  it('returns the manual command when the server is unreachable', async () => {
    const f = fakeClient({ connect: async () => { throw new Error('SSH connection error: connect ECONNREFUSED'); } });
    const r = await removePushifyKey({ host: '203.0.113.5', publicKey: PUSHIFY_KEY, password: 'p' }, () => f.client as never);
    expect(r.keyRemoved).toBe(false);
    expect(r.manualCommand).toContain('pushify-1a2b3c4d-1727600000000');
    expect(r.reason).toContain('ECONNREFUSED');
  });

  it('gives up after the timeout instead of hanging the delete request', async () => {
    const f = fakeClient({ connect: () => new Promise<void>(() => {}) });
    const r = await removePushifyKey({ host: '203.0.113.5', publicKey: PUSHIFY_KEY, privateKey: 'k' }, () => f.client as never, 20);
    expect(r.keyRemoved).toBe(false);
    expect(r.reason).toContain('timed out');
    expect(r.manualCommand).toBeDefined();
  });

  it('treats a non-zero exit as not removed', async () => {
    const f = fakeClient({ code: 1, stderr: 'Permission denied' });
    const r = await removePushifyKey({ host: '203.0.113.5', publicKey: PUSHIFY_KEY, privateKey: 'k' }, () => f.client as never);
    expect(r).toMatchObject({ keyRemoved: false, reason: 'Permission denied' });
  });

  it('does not try to connect without credentials', async () => {
    let created = false;
    const r = await removePushifyKey({ host: '203.0.113.5', publicKey: PUSHIFY_KEY }, () => { created = true; return fakeClient({}).client as never; });
    expect(created).toBe(false);
    expect(r).toMatchObject({ keyRemoved: false, reason: 'no stored credentials' });
  });
});
