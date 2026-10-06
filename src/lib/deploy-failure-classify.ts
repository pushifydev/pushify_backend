export type DeployFailureCategory =
  | 'repository_access'
  | 'out_of_memory'
  | 'disk_space'
  | 'platform_native'
  | 'docker_build'
  | 'application_build'
  | 'container_start'
  | 'server_capacity'
  | 'project_config'
  | 'unknown';

export type DeployFailureBlame = 'pushify' | 'server' | 'project';

export interface ClassifiedDeployFailure {
  category: DeployFailureCategory;
  blame: DeployFailureBlame;
  /** Short label stored in errorMessage prefix */
  label: string;
  userHint: string;
}

const LOG_TAG = '[Pushify] failureCategory=';

export function failureCategoryLogLine(category: DeployFailureCategory): string {
  return `${LOG_TAG}${category}`;
}

export function parseFailureCategoryFromLogs(logs: string): DeployFailureCategory | null {
  const m = logs.match(/\[Pushify\] failureCategory=([a-z_]+)/);
  return m ? (m[1] as DeployFailureCategory) : null;
}

/**
 * The error says what went wrong; the log only says what ran. Classify on the error first and
 * fall back to the whole log only when the error is unspecific — every Node build log contains
 * the generated `RUN if [ -d node_modules/lightningcss ] …` line, so matching the log first
 * blamed "native module (platform)" for any Node deploy that failed after its build.
 */
export function classifyDeployFailure(logs: string, errorMessage?: string): ClassifiedDeployFailure {
  if (errorMessage) {
    const fromError = classifyText(errorMessage.toLowerCase());
    if (fromError.category !== 'unknown') return fromError;
  }
  return classifyText(`${logs}\n${errorMessage ?? ''}`.toLowerCase());
}

function classifyText(text: string): ClassifiedDeployFailure {

  // First: a clone that failed for lack of credentials never gets far enough to hit the others.
  if (
    text.includes('pushify has no access to') ||
    text.includes('could not read username') ||
    text.includes('terminal prompts disabled') ||
    text.includes('authentication failed for') ||
    text.includes('repository not found')
  ) {
    return {
      category: 'repository_access',
      blame: 'project',
      label: 'Repository access',
      userHint:
        'Pushify could not read the repository. Connect a GitHub account that can see it, or install the Pushify GitHub App on the repository owner (Project → Settings → GitHub access).',
    };
  }

  if (
    text.includes('no space left on device') ||
    text.includes('disk full') ||
    text.includes('enospc')
  ) {
    return {
      category: 'disk_space',
      blame: 'server',
      label: 'Disk full',
      userHint:
        'The server ran out of disk space. Free space (docker system prune) or use a larger server.',
    };
  }

  if (
    text.includes('out of memory') ||
    text.includes('oom') ||
    text.includes('javascript heap') ||
    text.includes('killed') ||
    text.includes('cannot allocate memory')
  ) {
    return {
      category: 'out_of_memory',
      blame: 'server',
      label: 'Out of memory',
      userHint:
        'The build or container exceeded memory limits. Upgrade the server or reduce build size (fewer dependencies, standalone output).',
    };
  }

  // A dependency's native addon could not be compiled (node-gyp) or was never built, so the
  // app fails when it loads the missing .node binary.
  if (
    text.includes('gyp err!') ||
    text.includes('could not locate the bindings file') ||
    text.includes('was compiled against a different node.js version') ||
    (text.includes('cannot find module') && text.includes('build/release/'))
  ) {
    return {
      category: 'platform_native',
      blame: 'pushify',
      label: 'Native module build',
      userHint:
        'A dependency with a native addon (node-gyp) could not be compiled. The Pushify build image includes python3, make, g++ and pkg-config; ' +
        'if the log shows a missing header or library (e.g. cairo, vips, libpq), that system package is not in the image. ' +
        'Deploy with your own Dockerfile that installs it (apt-get install <lib>-dev), or use a prebuilt alternative ' +
        '(e.g. bcryptjs instead of bcrypt).',
    };
  }

  // A prebuilt platform binary (lightningcss, Tailwind oxide, …) is missing or built for the
  // wrong libc. Match the binary/package names that appear in the actual error — not the bare
  // word "lightningcss" or "linux-x64-gnu", which every Node build log contains via the
  // generated `RUN if [ -d node_modules/lightningcss ] … lightningcss-linux-x64-gnu@…` step.
  if (
    text.includes('lightningcss.linux-') ||
    text.includes('linux-x64-musl') ||
    text.includes('linux-arm64-musl') ||
    text.includes('@tailwindcss/oxide') ||
    text.includes('cannot find native binding')
  ) {
    return {
      category: 'platform_native',
      blame: 'pushify',
      label: 'Native module (platform)',
      userHint:
        'This is a Pushify build-platform issue, not a bug in your code: a prebuilt native binary (e.g. lightningcss, Tailwind oxide) ' +
        'was missing or built for the wrong platform in the Pushify build image (Debian, glibc, linux). ' +
        'To unblock now: regenerate your lockfile on Linux (or delete it and let the build resolve platform packages), ' +
        'or deploy with your own Dockerfile based on node:20-bookworm-slim. Please contact support with the deployment ID so we can fix the image.',
    };
  }

  if (text.includes('global deployment concurrency') || text.includes('queue: position')) {
    return {
      category: 'server_capacity',
      blame: 'server',
      label: 'Server busy',
      userHint: 'The deployment server was busy. Wait and redeploy, or use a dedicated server.',
    };
  }

  if (
    text.includes('failed to compile') ||
    text.includes('npm err!') ||
    text.includes('error ts') ||
    text.includes('syntaxerror') ||
    text.includes('module not found') ||
    text.includes('cannot find module')
  ) {
    return {
      category: 'application_build',
      blame: 'project',
      label: 'Application build failed',
      userHint: 'Fix build errors in your repository (run the same build command locally).',
    };
  }

  if (text.includes('docker build failed') || text.includes('failed to solve')) {
    return {
      category: 'docker_build',
      blame: 'pushify',
      label: 'Docker build failed',
      userHint:
        'The generated image could not be built. Check deploy logs; if using a custom Dockerfile, validate it on the target OS (Linux).',
    };
  }

  if (
    text.includes('blue-green') ||
    text.includes('container') && text.includes('failed to start') ||
    text.includes('unhealthy')
  ) {
    return {
      category: 'container_start',
      blame: 'project',
      label: 'Container failed to start',
      userHint:
        'The image built but the app did not become healthy. Check PORT, start command, and runtime logs.',
    };
  }

  if (
    text.includes('next.config') ||
    text.includes('invalid package.json') ||
    text.includes('missing script')
  ) {
    return {
      category: 'project_config',
      blame: 'project',
      label: 'Project configuration',
      userHint: 'Fix project configuration (package.json scripts, framework config, root directory).',
    };
  }

  return {
    category: 'unknown',
    blame: 'project',
    label: 'Deployment failed',
    userHint: 'Review the full deploy log. Fix errors in your app or contact support with the deployment ID.',
  };
}

export function formatClassifiedErrorMessage(
  classified: ClassifiedDeployFailure,
  rawError: string
): string {
  const blameTag =
    classified.blame === 'pushify'
      ? '[Pushify]'
      : classified.blame === 'server'
        ? '[Server]'
        : '[Project]';
  return `${blameTag} ${classified.label}: ${rawError}`;
}
