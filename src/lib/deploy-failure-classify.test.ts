import { describe, it, expect } from 'vitest';
import { classifyDeployFailure } from './deploy-failure-classify';
import { nodeInstallLines } from './platform-docker';

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
