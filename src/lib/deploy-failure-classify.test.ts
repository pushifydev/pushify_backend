import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  classifyDeployError,
  classifyDeployFailure,
  formatClassifiedErrorMessage,
  PolicyBlockedDeployError,
} from './deploy-failure-classify';
import { stripFailurePrefix } from './deploy-failure-summary';
import { nodeInstallLines, nodeLightningcssGlibcFixLines } from './platform-docker';

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
