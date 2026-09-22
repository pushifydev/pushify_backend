/**
 * Everything a customer controls that reaches a shell or a path on a deploy server — repo URL,
 * branch, root directory, Dockerfile path, build/install/start commands. Deploy servers run these
 * as root, and the shared runner is one host for many customers, so each value is checked
 * where it enters (API, pushify.yaml) and again right before a deploy uses it (old rows,
 * branches that arrive in webhooks).
 *
 * What went wrong without it: a branch named `x;curl …|sh` or a URL with `$(…)` ran as root in the
 * clone command; a `file:///opt/pushify/apps/<other>/repo` URL cloned another customer's code; a
 * root directory of `../../…` built someone else's checkout — or, with a newline in the build
 * command, wrote a cron line to /etc/cron.d.
 */

/** Local file:// repos only for the e2e box (and anyone who explicitly opts in on their own host). */
const allowLocalRepos = () => process.env.PUSHIFY_ALLOW_LOCAL_REPOS === '1';

export function validateGitRepoUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'Repository URL is not a valid URL';
  }
  if (url.protocol === 'file:' && allowLocalRepos()) return null;
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return 'Repository URL must start with https://';
  }
  if (!url.hostname) return 'Repository URL needs a host';
  if (/[\s"'`$\\;|&<>(){}]/.test(value)) return 'Repository URL contains characters that are not allowed';
  return null;
}

/** Git ref names allow ; | $ ( ) — we don't: a branch is a word, not a command. */
const BRANCH_RE = /^[A-Za-z0-9._/+@-]+$/;

export function validateGitBranch(value: string): string | null {
  if (!value || value.length > 100) return 'Branch name must be 1–100 characters';
  if (!BRANCH_RE.test(value)) return 'Branch name may only contain letters, digits and . _ / + @ -';
  if (value.startsWith('-') || value.startsWith('/') || value.endsWith('/')) return 'Branch name has an invalid start or end';
  if (value.includes('..') || value.includes('//')) return 'Branch name may not contain ".." or "//"';
  return null;
}

const REL_PATH_RE = /^[A-Za-z0-9._/@+-]+$/;

/** A path inside the repository: relative, no `..`, no shell characters. */
export function validateRepoRelativePath(value: string, label: string): string | null {
  const trimmed = value.trim().replace(/\\/g, '/');
  if (trimmed === '' || trimmed === '.' || trimmed === './' || trimmed === '/') return null;
  const path = trimmed.replace(/^\/+/, '').replace(/\/+$/, '');
  if (path.length > 255) return `${label} is too long`;
  if (!REL_PATH_RE.test(path)) return `${label} may only contain letters, digits and . _ / @ + -`;
  if (path.split('/').some((segment) => segment === '..')) return `${label} must stay inside the repository (no "..")`;
  return null;
}

/** Build / install / start commands end up in a Dockerfile `RUN` or `sh -c`: one line only. */
export function validateSingleLineCommand(value: string, label: string): string | null {
  if (value.length > 1000) return `${label} is too long`;
  if (/[\r\n\0]/.test(value)) return `${label} must be a single line (chain steps with &&)`;
  return null;
}

export interface RepoSettings {
  gitRepoUrl?: string | null;
  gitBranch?: string | null;
  rootDirectory?: string | null;
  dockerfilePath?: string | null;
  buildCommand?: string | null;
  installCommand?: string | null;
  startCommand?: string | null;
  outputDirectory?: string | null;
}

/** First problem with a project's repo settings, or null. Empty values are fine (not set). */
export function firstRepoSettingsError(settings: RepoSettings): string | null {
  const checks: Array<string | null> = [
    settings.gitRepoUrl ? validateGitRepoUrl(settings.gitRepoUrl) : null,
    settings.gitBranch ? validateGitBranch(settings.gitBranch) : null,
    settings.rootDirectory ? validateRepoRelativePath(settings.rootDirectory, 'Root directory') : null,
    settings.dockerfilePath ? validateRepoRelativePath(settings.dockerfilePath, 'Dockerfile path') : null,
    settings.buildCommand ? validateSingleLineCommand(settings.buildCommand, 'Build command') : null,
    settings.installCommand ? validateSingleLineCommand(settings.installCommand, 'Install command') : null,
    settings.startCommand ? validateSingleLineCommand(settings.startCommand, 'Start command') : null,
    settings.outputDirectory ? validateRepoRelativePath(settings.outputDirectory, 'Output directory') : null,
  ];
  return checks.find((error) => error !== null) ?? null;
}

/**
 * The free-form project settings (PATCH /projects/:id/settings stores any JSON) — the keys a
 * deploy reads: installCommand / buildCommand / startCommand, outputDirectory, framework.
 */
export function firstProjectSettingsError(settings: Record<string, unknown> | null | undefined): string | null {
  if (!settings) return null;
  const str = (key: string) => (typeof settings[key] === 'string' ? (settings[key] as string) : null);
  for (const [key, label] of [
    ['installCommand', 'Install command'],
    ['buildCommand', 'Build command'],
    ['startCommand', 'Start command'],
  ] as const) {
    const value = str(key);
    const error = value ? validateSingleLineCommand(value, label) : null;
    if (error) return error;
  }
  const output = str('outputDirectory');
  if (output) {
    const error = validateRepoRelativePath(output, 'Output directory');
    if (error) return error;
  }
  const framework = str('framework');
  if (framework && !/^[A-Za-z0-9.+-]{1,50}$/.test(framework)) return 'Framework name is not valid';
  return null;
}
