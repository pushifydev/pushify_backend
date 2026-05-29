export type DeployFailureCategory =
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

export function classifyDeployFailure(logs: string, errorMessage?: string): ClassifiedDeployFailure {
  const text = `${logs}\n${errorMessage ?? ''}`.toLowerCase();

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

  if (
    text.includes('lightningcss') ||
    text.includes('linux-x64-musl') ||
    text.includes('linux-x64-gnu') ||
    text.includes('@tailwindcss/oxide')
  ) {
    return {
      category: 'platform_native',
      blame: 'pushify',
      label: 'Native module (platform)',
      userHint:
        'A CSS/native binary mismatch occurred. Redeploy with the latest Pushify backend; contact support if this persists.',
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
    (text.includes('cannot find module') && !text.includes('lightningcss'))
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
