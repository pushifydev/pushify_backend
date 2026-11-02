import { beforeEach, describe, expect, it, vi } from 'vitest';

const execStreamingCommand = vi.fn();
const execCommand = vi.fn();

vi.mock('./shell', () => ({
  execStreamingCommand: (...args: unknown[]) => execStreamingCommand(...args),
  execCommand: (...args: unknown[]) => execCommand(...args),
  shSingleQuote: (v: string) => `'${v.replace(/'/g, `'\\''`)}'`,
}));

const { cloneRepository } = await import('./git');

describe('cloneRepository', () => {
  beforeEach(() => {
    execStreamingCommand.mockReset();
    execCommand.mockReset();
  });

  it('throws instead of falling back to the default branch when a commit is pinned', async () => {
    execStreamingCommand.mockResolvedValue({ stdout: '', stderr: 'Remote branch gone not found', exitCode: 128 });

    await expect(
      cloneRepository({ repoUrl: 'https://github.com/acme/app', branch: 'gone', commit: 'abcdef1234567' })
    ).rejects.toThrow(/Branch "gone" not found/);

    // Only the branch clone was attempted — no default-branch retry
    expect(execStreamingCommand).toHaveBeenCalledTimes(1);
    expect(execStreamingCommand.mock.calls[0][1]).toContain('--branch');
    expect(execCommand).not.toHaveBeenCalled();
  });

  it('still falls back to the default branch when no commit is pinned', async () => {
    execStreamingCommand
      .mockResolvedValueOnce({ stdout: '', stderr: 'Remote branch gone not found', exitCode: 128 })
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 });
    execCommand.mockImplementation(async (cmd: string) => {
      if (cmd.startsWith('git branch')) return { stdout: 'main\n', stderr: '', exitCode: 0 };
      if (cmd.startsWith('git rev-parse')) return { stdout: '1234567890abcdef\n', stderr: '', exitCode: 0 };
      if (cmd.startsWith('git log')) return { stdout: 'init\n', stderr: '', exitCode: 0 };
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const result = await cloneRepository({ repoUrl: 'https://github.com/acme/app', branch: 'gone' });

    expect(execStreamingCommand).toHaveBeenCalledTimes(2);
    expect(execStreamingCommand.mock.calls[1][1]).not.toContain('--branch');
    expect(result.branch).toBe('main');
    expect(result.commitHash).toBe('1234567890abcdef');
  });

  describe('access token in the clone URL', () => {
    const cloneUrlFor = async (repoUrl: string) => {
      execStreamingCommand.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
      execCommand.mockResolvedValue({ stdout: 'main\n', stderr: '', exitCode: 0 });
      await cloneRepository({ repoUrl, accessToken: 'SECRET' });
      const args = execStreamingCommand.mock.calls[0][1] as string[];
      return args[args.indexOf('--') + 1];
    };

    it.each([
      'https://evil.example/github.com/acme/repo',
      'https://gitlab.evil.example/x/y',
      'https://evil.example/https://github.com/a/b',
      'http://gitlab.com/x/y',
    ])('is never sent to %s', async (repoUrl) => {
      expect(await cloneUrlFor(repoUrl)).toBe(repoUrl);
      // nothing to scrub from .git/config either
      expect(execCommand.mock.calls.some(([cmd]) => String(cmd).includes('remote set-url'))).toBe(false);
    });

    it('goes to github.com and gitlab.com, then is scrubbed from .git/config', async () => {
      expect(await cloneUrlFor('https://github.com/acme/app')).toBe('https://x-access-token:SECRET@github.com/acme/app');
      expect(execCommand).toHaveBeenCalledWith("git remote set-url origin 'https://github.com/acme/app'", expect.anything());

      execStreamingCommand.mockReset();
      expect(await cloneUrlFor('https://gitlab.com/x/y')).toBe('https://oauth2:SECRET@gitlab.com/x/y');
    });
  });
});
