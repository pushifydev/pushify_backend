import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  classifyDeployError,
  classifyDeployFailure,
  describeFailureCategory,
  formatClassifiedErrorMessage,
  PolicyBlockedDeployError,
} from './deploy-failure-classify';
import { stripFailurePrefix } from './deploy-failure-summary';
import { formatContainerCrashSummary } from './container-crash-summary';
import { nodeInstallLines, nodeLightningcssGlibcFixLines } from './platform-docker';
import { buildpackRegistry } from '../buildpacks';

describe('classifyDeployFailure — native addon compile failures', () => {
  it('flags a node-gyp compile failure and points at a Dockerfile deploy', () => {
    const log = [
      'npm ERR! gyp ERR! stack Error: not found: make',
      'npm ERR! gyp ERR! find Python Python is not set from command line or npm configuration',
    ].join('\n');
    // docker.ts / remote-deployment.ts put the build output into the error itself
    const result = classifyDeployFailure(log, `Docker build failed: ${log}`);
    expect(result.category).toBe('platform_native');
    expect(result.label).toBe('Native module build');
    expect(result.userHint).toContain('Dockerfile');
  });

  it('flags a runtime load of a native binary that was never built', () => {
    const result = classifyDeployFailure(
      '',
      "Error: Cannot find module '/app/node_modules/bcrypt/build/Release/bcrypt_lib.node'"
    );
    expect(result.category).toBe('platform_native');
  });

  it('names the missing build tools in the hint', () => {
    const log = [
      'npm ERR! gyp ERR! stack Error: not found: make',
      'npm ERR! gyp ERR! find Python Python is not set from command line or npm configuration',
    ].join('\n');
    const { userHint } = classifyDeployFailure(log, `Docker build failed: ${log}`);
    expect(userHint).toContain('Missing build tools: make, python3');
    expect(userHint).toContain('build-essential');
  });

  it('names the missing header and its Debian package (canvas → cairo)', () => {
    const log = [
      '#12 [builder 5/9] RUN npm rebuild',
      "#12 4.1 ../src/CanvasRenderingContext2d.cc:9:10: fatal error: cairo.h: No such file or directory",
      '#12 4.1 gyp ERR! build error',
    ].join('\n');
    const result = classifyDeployFailure(log, `Docker build failed: ${log}`);
    expect(result.category).toBe('platform_native');
    expect(result.blame).toBe('pushify');
    expect(result.userHint).toContain('"cairo.h"');
    expect(result.userHint).toContain('libcairo2-dev');
    expect(result.userHint).toContain('Dockerfile');
  });

  it('names a library pkg-config could not find', () => {
    const log = [
      "Package pixman-1 was not found in the pkg-config search path.",
      'gyp ERR! configure error',
    ].join('\n');
    const { userHint } = classifyDeployFailure(log, `Docker build failed: ${log}`);
    expect(userHint).toContain('"pixman-1"');
    expect(userHint).toContain('libpixman-1-dev');
  });

  it('explains a sharp prebuilt binary missing for linux-x64', () => {
    const err = [
      'Error: Could not load the "sharp" module using the linux-x64 runtime',
      'Possible solutions:',
      '- Ensure optional dependencies can be installed:',
    ].join('\n');
    const result = classifyDeployFailure('', err);
    expect(result.category).toBe('platform_native');
    expect(result.label).toBe('Native module build');
    expect(result.userHint).toContain('npm install --os=linux --cpu=x64 sharp');
  });

  it('explains a glibc version mismatch of a prebuilt binary', () => {
    const err =
      "Error: /lib/x86_64-linux-gnu/libc.so.6: version `GLIBC_2.38' not found (required by /app/node_modules/foo/prebuilds/linux-x64/foo.node)";
    const result = classifyDeployFailure('', err);
    expect(result.category).toBe('platform_native');
    expect(result.userHint).toContain('libc mismatch');
  });

  it('suggests bcryptjs when bcrypt never got built', () => {
    const { userHint } = classifyDeployFailure(
      '',
      "Error: Cannot find module '/app/node_modules/bcrypt/build/Release/bcrypt_lib.node'"
    );
    expect(userHint).toContain('bcryptjs');
  });

  it('falls back to the generic native hint when no cause is recognisable', () => {
    const { userHint } = classifyDeployFailure('', 'gyp ERR! build error');
    expect(userHint).toContain('python3, make, g++ and pkg-config');
  });

  it('does not match on the generated Node install steps alone', () => {
    const result = classifyDeployFailure(nodeInstallLines('npm ci'), 'Deployment failed');
    expect(result.category).toBe('unknown');
  });
});

describe('classifyDeployFailure — repository access', () => {
  it.each([
    "Failed to clone repository: Cloning into '/tmp/pushify-x/repo'...\nfatal: could not read Username for 'https://github.com': No such device or address",
    'Pushify has no access to github.com/acme/site. Connect the GitHub account that can see it',
    "remote: Repository not found.\nfatal: repository 'https://github.com/acme/site/' not found",
    "fatal: Authentication failed for 'https://github.com/acme/site/'",
  ])('recognises %j', (message) => {
    const result = classifyDeployFailure('', message);
    expect(result.category).toBe('repository_access');
    expect(result.blame).toBe('project');
  });

  it('wins over categories whose keywords a clone log can contain', () => {
    // "killed" would otherwise read as out-of-memory
    const result = classifyDeployFailure('process killed', 'fatal: could not read Username');
    expect(result.category).toBe('repository_access');
  });
});

describe('classifyDeployFailure — the error wins over the log', () => {
  const nodeBuildLog = [
    '#14 [builder 8/8] RUN if [ -d node_modules/lightningcss ]; then LC_VER=$(node -p "require(\'lightningcss/package.json\').version"); fi',
    '#14 DONE 0.2s',
  ].join('\n');

  it('does not call a container that failed to start a native-module problem', () => {
    const result = classifyDeployFailure(nodeBuildLog, 'Blue-green deployment failed: container failed to start');
    expect(result.category).toBe('container_start');
  });

  it('still reads the log when the error says nothing specific', () => {
    const result = classifyDeployFailure('npm ERR! code ELIFECYCLE', 'Deployment failed');
    expect(result.category).toBe('application_build');
  });

  it('still finds a real native-module failure', () => {
    const result = classifyDeployFailure('', "Error: Cannot find module '../lightningcss.linux-x64-musl.node'");
    expect(result.category).toBe('platform_native');
  });
});

describe('classifyDeployFailure — platform native binaries', () => {
  const generatedLightningcssStep = nodeLightningcssGlibcFixLines();

  it('does not blame the platform for the generated lightningcss step in the log', () => {
    const result = classifyDeployFailure(`#14 [builder 8/8] ${generatedLightningcssStep}\n#14 DONE 0.2s`, 'Deployment failed');
    expect(result.category).toBe('unknown');
  });

  it('classifies a real application error even when the log contains the lightningcss step', () => {
    const result = classifyDeployFailure(
      `${generatedLightningcssStep}\nError: Cannot find module './routes/missing'`,
      'Deployment failed'
    );
    expect(result.category).toBe('application_build');
  });

  it.each([
    "Error: Cannot find module '../lightningcss.linux-x64-gnu.node'",
    "Error: Cannot find module '@tailwindcss/oxide-linux-x64-gnu'",
    'Error: Cannot find native binding. npm has a bug related to optional dependencies',
  ])('flags %j as a platform issue with an actionable hint', (message) => {
    const result = classifyDeployFailure('', message);
    expect(result.category).toBe('platform_native');
    expect(result.blame).toBe('pushify');
    expect(result.label).toBe('Native module (platform)');
    expect(result.userHint).toContain('Pushify build-platform issue');
    expect(result.userHint).toContain('Dockerfile');
  });
});

describe('classifyDeployFailure — buildpack build failures', () => {
  /** What remote-deployment.ts throws when a generated build fails: the BuildKit output. */
  const buildError = (...lines: string[]) =>
    `Docker build failed:\n${lines.map((l, i) => `#11 ${(i * 0.01 + 0.4).toFixed(3)} ${l}`).join('\n')}\n` +
    '#11 ERROR: process "/bin/sh -c npm run build" did not complete successfully: exit code: 1\n------\n' +
    'ERROR: failed to solve: process "/bin/sh -c npm run build" did not complete successfully: exit code: 1';

  /** What the blue-green step throws when the new container dies on start-up. */
  const startError = (...logs: string[]) =>
    `Blue-green deployment failed:\n${formatContainerCrashSummary({
      headline: 'Container exited unexpectedly',
      exitCode: 1,
      logs: logs.join('\n'),
    })}`;

  const fixtures: Record<string, Array<[string, string]>> = {
    buildpack_detection: [
      [
        'npm 10, no package.json (built as Node.js)',
        buildError(
          'npm error code ENOENT',
          'npm error syscall open',
          'npm error path /app/package.json',
          'npm error errno -2',
          "npm error enoent Could not read package.json: Error: ENOENT: no such file or directory, open '/app/package.json'",
        ),
      ],
      ['npm 9, no package.json', buildError("npm ERR! enoent ENOENT: no such file or directory, open '/app/package.json'")],
      ['pnpm, no package.json', buildError(' ERR_PNPM_NO_PKG_MANIFEST  No package.json found in /app')],
    ],
    runtime_version: [
      [
        'npm engine-strict',
        buildError(
          'npm error code EBADENGINE',
          'npm error engine Unsupported engine',
          'npm error notsup Required: {"node":">=22.0.0"}',
          'npm error notsup Actual: {"npm":"10.8.2","node":"v20.18.1"}',
        ),
      ],
      [
        'yarn 1 engines',
        buildError('error @vitejs/plugin-react@5.0.0: The engine "node" is incompatible with this module. Expected version "^20.19.0 || >=22.12.0". Got "20.18.1"'),
      ],
      ['pnpm engines', buildError(' ERR_PNPM_UNSUPPORTED_ENGINE  Unsupported environment (bad pnpm and/or Node.js version)')],
      ['Next.js', buildError('You are using Node.js 18.20.4. For Next.js, Node.js version "^18.18.0 || >= 20.0.0" is required.')],
      ['pip requires-python', buildError("ERROR: Package 'my-app' requires a different Python: 3.12.7 not in '>=3.13'")],
      ['go.mod toolchain', buildError('go: go.mod requires go >= 1.23.0 (running go 1.22.12; GOTOOLCHAIN=local)')],
      ['bundler ruby', buildError('Your Ruby version is 3.3.6, but your Gemfile specified 3.4.1')],
      ['composer php', buildError('  - Root composer.json requires php ^8.4 but your php version (8.3.14) does not satisfy that requirement.')],
      [
        'cargo rust-version',
        buildError('error: package `clap_lex v0.7.4` cannot be built because it requires rustc 1.81 or newer, while the currently active rustc version is 1.77.2'),
      ],
      ['cargo edition 2024', buildError('  feature `edition2024` is required')],
      [
        'maven release',
        buildError('[ERROR] Failed to execute goal org.apache.maven.plugins:maven-compiler-plugin:3.13.0:compile on project api: Fatal error compiling: error: release version 23 not supported'),
      ],
    ],
    dependency_install: [
      [
        'npm 10 ERESOLVE',
        buildError(
          'npm error code ERESOLVE',
          'npm error ERESOLVE unable to resolve dependency tree',
          'npm error Found: react@19.0.0',
          'npm error peer react@"^18.0.0" from react-helmet-async@2.0.5',
        ),
      ],
      ['npm 9 ETARGET', buildError('npm ERR! code ETARGET', 'npm ERR! notarget No matching version found for left-pad@^9.9.9.')],
      [
        'npm ci out of sync',
        buildError('npm error `npm ci` can only install packages when your package.json and package-lock.json or npm-shrinkwrap.json are in sync.'),
      ],
      ['yarn frozen lockfile', buildError('error Your lockfile needs to be updated, but yarn was run with `--frozen-lockfile`.')],
      [
        'pnpm frozen lockfile',
        buildError(' ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with "frozen-lockfile" because pnpm-lock.yaml is not up to date with package.json'),
      ],
      [
        'pip',
        buildError(
          'ERROR: Could not find a version that satisfies the requirement djangoo==5.1 (from versions: none)',
          'ERROR: No matching distribution found for djangoo==5.1',
        ),
      ],
      ['bundler', buildError("Could not find gem 'rails (~> 9.0)' in rubygems repository https://rubygems.org/ or installed locally.")],
      ['composer', buildError('Your requirements could not be resolved to an installable set of packages.')],
      [
        'go modules',
        buildError('main.go:8:2: missing go.sum entry for module providing package github.com/gin-gonic/gin (imported by example.com/api)'),
      ],
      ['cargo', buildError('error: failed to select a version for the requirement `serde = "^9.0"`')],
      [
        'maven',
        buildError('[ERROR] Failed to execute goal on project api: Could not resolve dependencies for project com.example:api:jar:1.0.0'),
      ],
    ],
    start_command: [
      ['npm 10, no start script', startError('npm error Missing script: "start"', 'npm error', 'npm error To see a list of scripts, run:')],
      ['npm 6, no start script', startError('npm ERR! missing script: start')],
      ['python main.py', startError("python: can't open file '/app/main.py': [Errno 2] No such file or directory")],
      ['uvicorn main:app', startError('ERROR:    Error loading ASGI app. Could not import module "main".')],
      ['gunicorn app:app', startError("Failed to find attribute 'app' in 'app'.")],
    ],
    out_of_memory: [
      [
        'build step OOM-killed without "Killed"',
        'Docker build failed:\n#14 [builder 8/9] RUN npm run build\n#14 12.31 Creating an optimized production build ...\n' +
          '#14 ERROR: process "/bin/sh -c npm run build" did not complete successfully: exit code: 137\n------\n' +
          'ERROR: failed to solve: process "/bin/sh -c npm run build" did not complete successfully: exit code: 137',
      ],
    ],
  };

  const cases = Object.entries(fixtures).flatMap(([category, list]) =>
    list.map(([name, error]) => [category, name, error] as const),
  );

  it.each(cases)('%s: %s', (category, _name, error) => {
    const result = classifyDeployFailure('', error);
    expect(result.category).toBe(category);
    expect(result.userHint.length).toBeGreaterThan(0);
    // The worker's entry point stores the same category in deployments.failure_category.
    expect(classifyDeployError(new Error(error), '', error).category).toBe(category);
  });

  it.each(cases)('%s: %s — the stored message lands in the same category again', (category, _name, error) => {
    // ops signals, the failure summary and the growth report re-classify deployments.error_message alone.
    const stored = formatClassifiedErrorMessage(classifyDeployFailure('', error), error);
    expect(classifyDeployFailure('', stored).category).toBe(category);
  });

  it('gives each new category its own label and hint', () => {
    const first = (category: string) => classifyDeployFailure('', fixtures[category][0][1]);
    const results = ['buildpack_detection', 'runtime_version', 'dependency_install', 'start_command'].map(first);
    expect(new Set(results.map((r) => r.label)).size).toBe(4);
    expect(new Set(results.map((r) => r.userHint)).size).toBe(4);
    expect(results.every((r) => r.blame === 'project')).toBe(true);
    expect(results.map((r) => r.label)).not.toContain('Deployment failed');
  });

  it('reads the log when the error itself says nothing specific', () => {
    expect(classifyDeployFailure(fixtures.dependency_install[0][1], 'Remote deployment failed').category).toBe('dependency_install');
  });

  it('does not take an engine warning for the failure', () => {
    const log = buildError('npm warn EBADENGINE Unsupported engine {', "npm warn EBADENGINE   required: { node: '>=22' },", 'Failed to compile.');
    expect(classifyDeployFailure('', log).category).toBe('application_build');
  });

  it('a failed build script is still an application build failure', () => {
    const log = buildError('npm ERR! code ELIFECYCLE', 'npm ERR! errno 2', 'npm ERR! my-app@1.0.0 build: `tsc`');
    expect(classifyDeployFailure('', log).category).toBe('application_build');
  });

  it('a container that dies for another reason is still a start failure', () => {
    expect(classifyDeployFailure('', startError('Error: connect ECONNREFUSED 127.0.0.1:5432')).category).toBe('container_start');
  });

  it('does not match the generated Dockerfile of any buildpack (BuildKit echoes every step)', () => {
    const buildpackCategories = ['buildpack_detection', 'runtime_version', 'dependency_install', 'start_command'];
    for (const buildpack of buildpackRegistry) {
      for (const framework of buildpack.frameworks) {
        const dockerfile = buildpack.generateDockerfile({ framework, envVars: { API_URL: 'x' } } as Parameters<typeof buildpack.generateDockerfile>[0]);
        expect(buildpackCategories).not.toContain(classifyDeployFailure(dockerfile, 'Deployment failed').category);
      }
    }
  });
});

describe('classifyDeployError — deploys stopped under the Acceptable Use Policy', () => {
  // The sentence the worker has thrown since beta.108 when a source scan stops a deploy.
  const AUP_MESSAGE =
    'This deploy was stopped and the project suspended under the Pushify Acceptable Use Policy (§2.1). ' +
    'See your email for details and how to appeal.';

  it('records policy_blocked from the error type, whatever the message says', () => {
    expect(classifyDeployError(new PolicyBlockedDeployError(AUP_MESSAGE), '', AUP_MESSAGE).category).toBe('policy_blocked');
    // Words the classifier would otherwise match ("killed" = out of memory) do not change it.
    const reworded = new PolicyBlockedDeployError('Deploy killed by policy');
    expect(classifyDeployError(reworded, 'npm ERR! gyp ERR!', reworded.message).category).toBe('policy_blocked');
  });

  it('does not match on the message: a plain error with the same text is not policy_blocked', () => {
    expect(classifyDeployError(new Error(AUP_MESSAGE), '', AUP_MESSAGE).category).toBe('unknown');
  });

  it('leaves real build and runtime failures exactly as the classifier puts them', () => {
    const cases: Array<[string, string]> = [
      ['', 'Docker build failed: npm ERR! Missing script: "build"'],
      ['', 'ENOSPC: no space left on device'],
      ['', 'Container failed to start: app is unhealthy'],
      ['#5 Killed', 'Docker build failed'],
    ];
    for (const [logs, message] of cases) {
      const classified = classifyDeployError(new Error(message), logs, message);
      expect(classified).toEqual(classifyDeployFailure(logs, message));
      expect(classified.category).not.toBe('policy_blocked');
    }
  });

  it('writes a message whose prefix the failure summary strips', () => {
    const classified = classifyDeployError(new PolicyBlockedDeployError(AUP_MESSAGE), '', AUP_MESSAGE);
    const stored = formatClassifiedErrorMessage(classified, AUP_MESSAGE);
    expect(stripFailurePrefix(stored)).toBe(AUP_MESSAGE);
  });

  describe('migration 0078 backfill', () => {
    const migration = readFileSync(
      fileURLToPath(new URL('../db/migrations/0078_deployment_failure_category.sql', import.meta.url)),
      'utf8',
    );
    // The POSIX regex the UPDATE uses; JavaScript reads this simple pattern the same way.
    const pattern = new RegExp(migration.match(/"error_message" ~ '([^']+)'/)![1]);

    it('matches the stored AUP message under whatever label the classifier gave it', () => {
      for (const logs of ['', 'Cloning into /tmp/build… zoom-room (oom)']) {
        const stored = formatClassifiedErrorMessage(classifyDeployFailure(logs, AUP_MESSAGE), AUP_MESSAGE);
        expect(stored).toMatch(pattern);
      }
    });

    it('does not match real failures, or the sentence echoed inside a build log', () => {
      const real = formatClassifiedErrorMessage(classifyDeployFailure('', 'npm ERR! Missing script'), 'npm ERR! Missing script');
      expect(real).not.toMatch(pattern);
      const echoed = `Docker build failed: #7 echo ${AUP_MESSAGE}`;
      expect(formatClassifiedErrorMessage(classifyDeployFailure('', echoed), echoed)).not.toMatch(pattern);
    });
  });
});

describe('describeFailureCategory — blame and label of a stored category', () => {
  const samples = [
    'fatal: could not read Username',
    'ENOSPC: no space left on device',
    'FATAL ERROR: JavaScript heap out of memory',
    'gyp ERR! build error',
    "npm error enoent Could not read package.json: Error: ENOENT: no such file or directory, open '/app/package.json'",
    'npm error code EBADENGINE',
    'npm error code ERESOLVE',
    'npm error Missing script: "start"',
    'Docker build failed: failed to solve',
    'Failed to compile.',
    'Container failed to start: app is unhealthy',
    'global deployment concurrency limit reached',
    'invalid package.json',
    'Deployment failed',
  ];
  const classified = [
    ...samples.map((message) => classifyDeployFailure('', message)),
    classifyDeployError(new PolicyBlockedDeployError('stopped'), '', 'stopped'),
  ];

  it('covers every category', () => {
    expect(new Set(classified.map((c) => c.category)).size).toBe(15);
  });

  it.each(classified.map((c) => [c.category, c] as const))('%s: same blame and label as the classifier', (category, c) => {
    expect(describeFailureCategory(category)).toEqual({ category, blame: c.blame, label: c.label });
  });

  it('is null for anything that is not a category', () => {
    for (const value of ['never_deployed', 'toString', '__proto__', '']) {
      expect(describeFailureCategory(value)).toBeNull();
    }
  });
});
