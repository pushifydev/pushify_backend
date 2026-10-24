export type DeployFailureCategory =
  | 'repository_access'
  | 'out_of_memory'
  | 'disk_space'
  | 'platform_native'
  /** Generated (buildpack) builds: what the package manager or runtime said went wrong */
  | 'buildpack_detection'
  | 'runtime_version'
  | 'dependency_install'
  | 'start_command'
  | 'docker_build'
  | 'application_build'
  | 'container_start'
  | 'server_capacity'
  | 'project_config'
  /** Stopped under the Acceptable Use Policy. Not a failure: kept out of failure rates. */
  | 'policy_blocked'
  | 'unknown';

export type DeployFailureBlame = 'pushify' | 'server' | 'project';

export interface ClassifiedDeployFailure {
  category: DeployFailureCategory;
  blame: DeployFailureBlame;
  /** Short label stored in errorMessage prefix */
  label: string;
  userHint: string;
}

/** Blame and label of each category, as classifyDeployFailure gives them ('platform_native' also has "Native module (platform)"). */
const CATEGORY_LABELS: Record<DeployFailureCategory, Pick<ClassifiedDeployFailure, 'blame' | 'label'>> = {
  repository_access: { blame: 'project', label: 'Repository access' },
  out_of_memory: { blame: 'server', label: 'Out of memory' },
  disk_space: { blame: 'server', label: 'Disk full' },
  platform_native: { blame: 'pushify', label: 'Native module build' },
  buildpack_detection: { blame: 'project', label: 'Language not detected' },
  runtime_version: { blame: 'project', label: 'Unsupported runtime version' },
  dependency_install: { blame: 'project', label: 'Dependency install failed' },
  start_command: { blame: 'project', label: 'No start command' },
  docker_build: { blame: 'pushify', label: 'Docker build failed' },
  application_build: { blame: 'project', label: 'Application build failed' },
  container_start: { blame: 'project', label: 'Container failed to start' },
  server_capacity: { blame: 'server', label: 'Server busy' },
  project_config: { blame: 'project', label: 'Project configuration' },
  policy_blocked: { blame: 'project', label: 'Stopped by policy' },
  unknown: { blame: 'project', label: 'Deployment failed' },
};

/**
 * Blame and label of a category stored in deployments.failure_category, for reports that read
 * the stored category instead of re-classifying the message. Null for anything else.
 */
export function describeFailureCategory(
  category: string,
): Pick<ClassifiedDeployFailure, 'category' | 'blame' | 'label'> | null {
  if (!Object.prototype.hasOwnProperty.call(CATEGORY_LABELS, category)) return null;
  const known = category as DeployFailureCategory;
  return { category: known, ...CATEGORY_LABELS[known] };
}

/**
 * Thrown where a deploy is stopped under the Acceptable Use Policy. The category comes from the
 * error's type, never from its message, so rewording the message cannot turn it into a failure.
 */
export class PolicyBlockedDeployError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolicyBlockedDeployError';
  }
}

const POLICY_BLOCKED: ClassifiedDeployFailure = {
  category: 'policy_blocked',
  blame: 'project',
  label: 'Stopped by policy',
  userHint: 'This project is suspended under the Acceptable Use Policy. The email sent to the owner says why and how to appeal.',
};

/** The worker's entry point: what stopped the deploy if it says so itself, else the classifier. */
export function classifyDeployError(error: unknown, logs: string, rawError: string): ClassifiedDeployFailure {
  if (error instanceof PolicyBlockedDeployError) return POLICY_BLOCKED;
  return classifyDeployFailure(logs, rawError);
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
    text.includes('cannot allocate memory') ||
    // BuildKit's line for a build step the kernel OOM-killed (SIGKILL), often without "Killed"
    text.includes('exit code: 137')
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
    (text.includes('cannot find module') && text.includes('build/release/')) ||
    SHARP_PREBUILT_PATTERNS.some((p) => text.includes(p)) ||
    LIBC_MISMATCH_PATTERN.test(text)
  ) {
    return {
      category: 'platform_native',
      blame: 'pushify',
      label: 'Native module build',
      userHint: nativeBuildHint(text),
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

  // Generated builds whose failure the package manager or runtime names. Ahead of the generic
  // "npm ERR!" / "Docker build failed" buckets, which these used to land in (or in unknown).
  if (NO_MANIFEST_PATTERN.test(text)) {
    return {
      category: 'buildpack_detection',
      blame: 'project',
      label: 'Language not detected',
      userHint:
        'No package.json was found where the build ran, so Pushify could not tell which language the app uses and built it as Node.js. ' +
        "Set the project's root directory to the folder with your app's manifest (package.json, requirements.txt, pyproject.toml, go.mod, Gemfile, composer.json, Cargo.toml, pom.xml), " +
        'set framework in pushify.yaml, or add a Dockerfile.',
    };
  }

  if (RUNTIME_VERSION_PATTERNS.some((p) => p.test(text))) {
    return {
      category: 'runtime_version',
      blame: 'project',
      label: 'Unsupported runtime version',
      userHint:
        'The app or one of its dependencies needs a different language version than the build image has; the log names both. ' +
        'Relax the version requirement (engines, requires-python, go.mod, Gemfile, composer.json), pin a dependency version that supports the image, ' +
        'or deploy with your own Dockerfile on the version you need.',
    };
  }

  if (DEPENDENCY_INSTALL_PATTERNS.some((p) => p.test(text))) {
    return {
      category: 'dependency_install',
      blame: 'project',
      label: 'Dependency install failed',
      userHint:
        'Installing dependencies failed: a package or version could not be found, resolved or built, or the lockfile is out of sync with the manifest. ' +
        'Run the same install command locally on a clean checkout, fix the package the log names and commit the updated lockfile.',
    };
  }

  if (START_COMMAND_PATTERNS.some((p) => p.test(text))) {
    return {
      category: 'start_command',
      blame: 'project',
      label: 'No start command',
      userHint:
        'The image built, but the start command found nothing to run (no "start" script in package.json, or no main.py / main:app / app:app where the default command looks). ' +
        'Set the start command in the project settings or start in pushify.yaml.',
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

const DOCKERFILE_OPTION =
  'Or add your own Dockerfile to the repository (or set the project Dockerfile path) that installs what the dependency needs, so Pushify builds with it instead of the buildpack.';

const GENERIC_NATIVE_HINT =
  'A dependency with a native addon (node-gyp) could not be compiled. The Pushify build image includes python3, make, g++ and pkg-config; ' +
  'if the log shows a missing header or library (e.g. cairo, vips, libpq), that system package is not in the image. ' +
  'Deploy with your own Dockerfile that installs it (apt-get install <lib>-dev), or use a prebuilt alternative ' +
  '(e.g. bcryptjs instead of bcrypt).';

const SHARP_PREBUILT_PATTERNS = [
  'could not load the "sharp" module',
  'something went wrong installing the "sharp" module',
  'sharp: installation error',
  'sharp: prebuilt libvips',
];

/*
 * Generated (buildpack) build failures. Each pattern is what a package manager or runtime prints
 * when it fails — never a command line or a warning: BuildKit echoes every RUN step into the log
 * (`RUN npm install …`), and warnings such as "npm warn EBADENGINE" appear in builds that pass.
 * npm ≥ 10 prints "npm error", older npm "npm ERR!". `text` is lower-cased.
 */

/** No package.json where the Node build ran: no buildpack recognised the repository at its root directory. */
const NO_MANIFEST_PATTERN =
  /could not read package\.json|no such file or directory, open '[^'\n]*\/package\.json'|err_pnpm_no_pkg_manifest/;

/** The app or a dependency requires a language version the build image does not have. */
const RUNTIME_VERSION_PATTERNS: RegExp[] = [
  /npm (?:err!|error) code ebadengine/, // npm with engine-strict
  /error [^\n]*the engine "node" is incompatible with this module/, // yarn 1
  /err_pnpm_unsupported_engine/,
  /for next\.js, node\.js version|vite requires node\.js version/,
  /requires a different python/, // pip: requires-python
  /go\.mod requires go >=|note: module requires go \d/,
  /your ruby version is [^\n]*but your gemfile specified|requires ruby version/,
  /your php version \([^)\n]*\) does not satisfy/, // composer
  /requires rustc [\d.]+ or newer|rustc [\d.]+ is not supported by the following package|feature `edition20\d\d` is required/,
  /release version \d+ not supported|invalid target release|compiled by a more recent version of the java runtime/,
];

/** A dependency could not be found or resolved, or the lockfile does not match the manifest. */
const DEPENDENCY_INSTALL_PATTERNS: RegExp[] = [
  /npm (?:err!|error) code (?:eresolve|etarget|e404|eintegrity)\b/,
  /can only install packages when your package\.json and package-lock\.json/, // npm ci
  /your lockfile needs to be updated|the lockfile would have been modified by this install|couldn't find package|couldn't find any versions for/, // yarn
  /err_pnpm_(?:outdated_lockfile|no_matching_version|fetch_\d{3}|lockfile_\w+|peer_dep_issues)/,
  /could not find a version that satisfies the requirement|no matching distribution found for|resolutionimpossible/, // pip
  /your pipfile\.lock \([^)\n]*\) is out of date/,
  /could not find gem|bundler::gemnotfound|could not find compatible versions|and bundler cannot continue/,
  /your requirements could not be resolved to an installable set of packages|your lock file does not contain a compatible set of packages/, // composer
  /missing go\.sum entry|verifying [^\n]*: checksum mismatch|invalid version: unknown revision/,
  /failed to select a version for the requirement|no matching package named/, // cargo
  /could not resolve dependencies for project|could not resolve all (?:files|dependencies) for configuration/, // maven, gradle
];

/** The container started but the (default) start command had nothing to run. */
const START_COMMAND_PATTERNS: RegExp[] = [
  /missing script: "?start\b/, // npm start without a "start" script
  /python[\d.]*: can't open file '[^'\n]*': \[errno 2\]/, // python main.py
  /error loading asgi app/, // uvicorn main:app
  /failed to find attribute '[^'\n]*' in '[^'\n]*'/, // gunicorn app:app
];

/** A prebuilt binary that needs a newer glibc, or a glibc binary loaded on musl (Alpine). */
const LIBC_MISMATCH_PATTERN = /glibc_\d+\.\d+[^\n]*not found|error relocating[^\n]*\.node|ld-linux-x86-64\.so\.2[^\n]*no such file/;

/** C headers that commonly break node-gyp builds → Debian package that provides them. */
const HEADER_PACKAGES: Array<[RegExp, string]> = [
  [/^vips\//, 'libvips-dev'],
  [/^cairo/, 'libcairo2-dev'],
  [/^pango/, 'libpango1.0-dev'],
  [/^jpeglib\.h$/, 'libjpeg-dev'],
  [/^gif_lib\.h$/, 'libgif-dev'],
  [/^png\.h$/, 'libpng-dev'],
  [/^librsvg/, 'librsvg2-dev'],
  [/^libpq-fe\.h$/, 'libpq-dev'],
  [/^sqlite3\.h$/, 'libsqlite3-dev'],
  [/^openssl\//, 'libssl-dev'],
  [/^krb5|^gssapi/, 'libkrb5-dev'],
  [/^zmq\.h$/, 'libzmq3-dev'],
  [/^libusb/, 'libusb-1.0-0-dev'],
  [/^pcap/, 'libpcap-dev'],
  [/^udev\.h$|^libudev\.h$/, 'libudev-dev'],
];

/** pkg-config module names → Debian package. */
const PKGCONFIG_PACKAGES: Record<string, string> = {
  'pixman-1': 'libpixman-1-dev',
  cairo: 'libcairo2-dev',
  pangocairo: 'libpango1.0-dev',
  pango: 'libpango1.0-dev',
  'vips-cpp': 'libvips-dev',
  vips: 'libvips-dev',
  libpng: 'libpng-dev',
  'librsvg-2.0': 'librsvg2-dev',
  libjpeg: 'libjpeg-dev',
  libpq: 'libpq-dev',
  sqlite3: 'libsqlite3-dev',
  openssl: 'libssl-dev',
  libusb: 'libusb-1.0-0-dev',
  'libusb-1.0': 'libusb-1.0-0-dev',
};

/**
 * Turn a native build failure into something the user can act on: what is missing, how to fix
 * it, and the Dockerfile escape hatch. `text` is already lower-cased. Falls back to the generic
 * hint when the log has no recognisable cause.
 */
export function nativeBuildHint(text: string): string {
  const header = text.match(/fatal error: ([\w./+-]+\.h): no such file or directory/);
  if (header) {
    const pkg = HEADER_PACKAGES.find(([re]) => re.test(header[1]))?.[1];
    return (
      `Missing system library: the native addon needs the C header "${header[1]}", which is not in the Pushify build image` +
      (pkg ? ` (Debian package ${pkg}).` : '.') +
      ` Use a prebuilt alternative of the dependency if one exists. ${DOCKERFILE_OPTION}` +
      (pkg ? ` Example: RUN apt-get update && apt-get install -y ${pkg}` : '')
    );
  }

  const pkgConfig =
    text.match(/package '?([\w.+-]+)'?,? (?:was )?not found/) ??
    text.match(/no package '([\w.+-]+)' found/);
  if (pkgConfig) {
    const pkg = PKGCONFIG_PACKAGES[pkgConfig[1]];
    return (
      `Missing system library: pkg-config could not find "${pkgConfig[1]}"` +
      (pkg ? ` (Debian package ${pkg}).` : '.') +
      ` It is not in the Pushify build image. ${DOCKERFILE_OPTION}` +
      (pkg ? ` Example: RUN apt-get update && apt-get install -y ${pkg}` : '')
    );
  }

  const toolchain: string[] = [];
  if (/not found: make\b|make: not found|make: command not found/.test(text)) toolchain.push('make');
  if (/find python|could not find any python|python is not set|python3: not found/.test(text)) toolchain.push('python3');
  if (/not found: g\+\+|g\+\+: not found|g\+\+: command not found|not found: (?:cc|gcc)\b|gcc: not found/.test(text)) {
    toolchain.push('g++');
  }
  if (toolchain.length > 0) {
    return (
      `Missing build tools: ${toolchain.join(', ')} not found while compiling a native addon. ` +
      'The Pushify buildpack image installs python3, make, g++ and pkg-config — redeploy so the build uses the current image; ' +
      'if you use a custom install command that replaces the base image, add them yourself. ' +
      `${DOCKERFILE_OPTION} Example: RUN apt-get update && apt-get install -y build-essential python3`
    );
  }

  if (LIBC_MISMATCH_PATTERN.test(text)) {
    return (
      'libc mismatch: a prebuilt native binary was built for a different C library than the image ' +
      '(a newer glibc, or glibc vs musl/Alpine). The Pushify buildpack builds and runs on Debian bookworm (glibc 2.36). ' +
      'Delete node_modules from the repository if committed, regenerate the lockfile on Linux, or pin a dependency version whose ' +
      `prebuilt binary supports glibc 2.36. ${DOCKERFILE_OPTION}`
    );
  }

  if (SHARP_PREBUILT_PATTERNS.some((p) => text.includes(p))) {
    return (
      'sharp has no prebuilt binary for linux-x64 (glibc) in this install — usually a lockfile generated on macOS/Windows ' +
      'without the Linux optional packages. Run `npm install --os=linux --cpu=x64 sharp` (sharp ≥ 0.33) and commit the lockfile, ' +
      `or upgrade sharp. ${DOCKERFILE_OPTION}`
    );
  }

  if (text.includes('bcrypt')) {
    return `The bcrypt native addon could not be built or loaded. Switch to bcryptjs (pure JavaScript, same API) to avoid native compilation. ${DOCKERFILE_OPTION}`;
  }

  return GENERIC_NATIVE_HINT;
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
