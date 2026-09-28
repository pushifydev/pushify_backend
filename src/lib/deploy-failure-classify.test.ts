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
