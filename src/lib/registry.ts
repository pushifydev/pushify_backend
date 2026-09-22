/**
 * Private container registries.
 *
 * Two things needed credentials and had none: a Dockerfile whose `FROM` is a private base image,
 * and deploying an image directly instead of a repository. Both are solved the same way — before
 * the build or the pull, log in to every registry the organization has stored credentials for,
 * into a throwaway Docker config directory that is deleted when the deploy ends. Nothing is
 * written to the server's own `~/.docker/config.json`, so a shared runner never keeps one
 * customer's registry token around for the next deploy.
 *
 * Passwords go in through a quoted here-doc, never as an argument: arguments are visible in
 * `ps` to anyone else on the box, a here-doc's body is not.
 */

export interface RegistryCredential {
  /** What the user called it, for the deploy log */
  name: string;
  /** Host only: `ghcr.io`, `registry.gitlab.com`, `docker.io`, `registry.example.com:5000` */
  registry: string;
  username: string;
  /** Decrypted at the call site; never logged */
  password: string;
}

/** Docker Hub, when an image reference names no registry at all (`nginx:1`, `library/nginx`) */
export const DOCKER_HUB = 'docker.io';

const HEREDOC_DELIMITER = 'PUSHIFY_REGISTRY_PW';

/**
 * Host of a registry as `docker login` wants it: no scheme, no path, no trailing slash.
 * Docker Hub is spelled `docker.io` whichever of its several names the user typed.
 */
export function normalizeRegistry(input: string): string {
  const host = input
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .toLowerCase();
  if (host === 'index.docker.io' || host === 'registry-1.docker.io' || host === 'docker.io' || host === '') {
    return DOCKER_HUB;
  }
  return host;
}

/**
 * The registry an image reference pulls from. Docker's own rule: the part before the first
 * slash is a registry only when it looks like a host — it has a dot or a colon, or it is
 * `localhost`. So `ghcr.io/org/app` is GHCR while `myorg/app` is Docker Hub.
 */
export function registryOfImage(image: string): string {
  const [first] = image.trim().split('/');
  if (image.includes('/') && (first.includes('.') || first.includes(':') || first === 'localhost')) {
    return normalizeRegistry(first);
  }
  return DOCKER_HUB;
}

/**
 * An image reference that is safe to put in a shell command and is actually a reference.
 * Returns the reason it was refused, or null.
 */
export function validateImageReference(image: string): string | null {
  const value = image.trim();
  if (!value) return 'Image is required';
  if (value.length > 400) return 'Image reference is too long';
  // name[:tag] or name@sha256:… — letters, digits and . _ - / : @ only
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._\-/:@]*$/.test(value)) {
    return 'Image reference may only contain letters, digits and . _ - / : @';
  }
  if (value.includes('..')) return 'Image reference may not contain ".."';
  const afterRegistry = value.slice(value.indexOf('/') + 1);
  if (afterRegistry.split('@')[0].split(':').length > 2) return 'Image reference has more than one tag';
  return null;
}

/** A registry host that is a host, so it can go in a shell command unquoted-safe. */
export function validateRegistryHost(host: string): string | null {
  const value = normalizeRegistry(host);
  if (!value) return 'Registry is required';
  if (value.length > 255) return 'Registry host is too long';
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/.test(value)) {
    return 'Registry must be a host name, e.g. ghcr.io or registry.example.com:5000';
  }
  return null;
}

/** Credentials that can be sent through a here-doc without ending it early. */
export function validateCredential(credential: Pick<RegistryCredential, 'username' | 'password'>): string | null {
  if (!credential.username.trim()) return 'Username is required';
  if (!credential.password) return 'Password or token is required';
  if (/[\r\n]/.test(credential.username)) return 'Username may not contain line breaks';
  if (credential.password.split('\n').some((line) => line.trim() === HEREDOC_DELIMITER)) {
    return 'Password may not contain the line PUSHIFY_REGISTRY_PW';
  }
  return null;
}

/** Where one deploy's logins live. Per deploy, so two deploys never share a session. */
export function dockerConfigDir(deploymentId: string): string {
  return `/tmp/pushify-registry-${deploymentId.replace(/[^a-zA-Z0-9-]/g, '')}`;
}

/**
 * Log in to one registry inside `configDir`. The password arrives on stdin through a quoted
 * here-doc — it is in neither the command line nor the environment, so `ps` shows nothing.
 */
export function buildLoginCommand(configDir: string, credential: RegistryCredential): string {
  const registry = normalizeRegistry(credential.registry);
  // Docker Hub's login endpoint is not `docker.io`; naming it explicitly is what the daemon expects.
  const target = registry === DOCKER_HUB ? 'https://index.docker.io/v1/' : registry;
  return [
    `mkdir -p '${configDir}' && chmod 700 '${configDir}' && `,
    `docker --config '${configDir}' login '${target}' `,
    `--username '${credential.username.replace(/'/g, "'\\''")}' --password-stdin <<'${HEREDOC_DELIMITER}'\n`,
    credential.password,
    `\n${HEREDOC_DELIMITER}`,
  ].join('');
}

/** Remove the deploy's logins from the server — the tokens do not outlive the deploy. */
export function buildLogoutCommand(configDir: string): string {
  return `rm -rf '${configDir}'`;
}

/**
 * `DOCKER_CONFIG=…` to put in front of a build or pull, or an empty string when the deploy has
 * no credentials — then Docker uses its usual (anonymous) configuration.
 */
export function dockerConfigPrefix(configDir: string | null): string {
  return configDir ? `DOCKER_CONFIG='${configDir}' ` : '';
}

/**
 * Which of the organization's credentials this deploy should log in with. All of them: a
 * Dockerfile's `FROM` can name any registry and we cannot know which before the build runs.
 * Duplicates for one registry are dropped — the first wins, so the list stays predictable.
 */
export function credentialsToApply(credentials: RegistryCredential[]): RegistryCredential[] {
  const seen = new Set<string>();
  const applied: RegistryCredential[] = [];
  for (const credential of credentials) {
    const registry = normalizeRegistry(credential.registry);
    if (seen.has(registry)) continue;
    seen.add(registry);
    applied.push({ ...credential, registry });
  }
  return applied;
}
