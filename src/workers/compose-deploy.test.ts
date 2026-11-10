import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Regression: a compose-stack redeploy used to run `docker compose down` before building, so a
 * broken `build:` step left the project with no container at all and nginx answered 502 until
 * the next good deploy. The build now runs while the previous stack is still serving.
 *
 * And a redeploy that changed only runtime variables or replicas rebuilt every image all the
 * same; it now starts the images already on the server when nothing the build reads changed.
 */

const COMMIT = 'a'.repeat(40);

const state = {
  buildExit: 0,
  commands: [] as string[],
  /** What `git rev-parse HEAD` answers in the server checkout */
  head: COMMIT,
  /** A runtime-only variable, as `docker compose config` resolves it into `environment:` */
  runtimeValue: 'one',
  /** The image of the `web` service on the server; null = not there */
  imageId: 'sha256:111' as string | null,
  /**
   * A registry image of the stack (`cache: image: redis:latest`), off by default: its ID on the
   * server (null = not there) and the one the registry serves now
   */
  registryImage: null as { name: string; localId: string | null; remoteId: string } | null,
};

/** The ID of an image on the server, null when it is not there */
function localImageId(name: string): string | null {
  if (name === 'pushify-shop-web') return state.imageId;
  if (state.registryImage?.name === name) return state.registryImage.localId;
  return null;
}

/** The image names a command lists in single quotes, without the `--format` template */
const quotedImageNames = (command: string) =>
  [...command.matchAll(/'([^']+)'/g)].map((match) => match[1]).filter((name) => name !== '{{.Id}}');

vi.mock('./port-manager', () => ({
  getOrAssignPort: vi.fn(async () => ({ port: 5123, isNew: false })),
}));

const setupNginxAndDomain = vi.fn(async () => 'https://shop.example.com');
const openFirewallPort = vi.fn(async () => undefined);
vi.mock('./remote-deployment', () => ({ setupNginxAndDomain, openFirewallPort }));

vi.mock('../db', () => ({ db: { select: () => { throw new Error('no db in this test'); } } }));

const { deployComposeFromRepo } = await import('./compose-deploy');
type Options = Parameters<typeof deployComposeFromRepo>[1];

const COMPOSE_YAML = `services:
  web:
    build: .
    ports:
      - "3000:3000"
`;

/** `docker compose config`: the file resolved, runtime environment included */
function resolvedConfig() {
  return `name: pushify-shop
services:
  web:
    build:
      context: /opt/pushify/apps/shop/repo
      dockerfile: Dockerfile
    environment:
      GREETING: ${state.runtimeValue}
    ports:
      - mode: ingress
        target: 3000
        published: "5123"
`;
}

function fakeSsh() {
  return {
    async exec(command: string) {
      state.commands.push(command);
      const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
      if (command.startsWith('docker compose version')) return ok('Docker Compose version v2.27.0');
      if (command.startsWith('cat ')) return ok(COMPOSE_YAML);
      if (command.startsWith('git -C ') && command.includes(' rev-parse HEAD')) return ok(`${state.head}\n`);
      if (/ config 2>\/dev\/null$/.test(command)) return ok(resolvedConfig());
      if (/ config --images 2>\/dev\/null$/.test(command)) {
        return ok(['pushify-shop-web', state.registryImage?.name].filter(Boolean).join('\n') + '\n');
      }
      if (command.startsWith('docker image inspect')) {
        const ids = quotedImageNames(command).map(localImageId);
        return ids.every(Boolean) ? ok(`${ids.join('\n')}\n`) : { code: 1, stdout: '', stderr: 'No such image' };
      }
      // One line per image, `-` for one that is not on the server
      if (command.startsWith('for image in ')) {
        return ok(`${quotedImageNames(command).map((name) => localImageId(name) ?? '-').join('\n')}\n`);
      }
      // `pull` leaves images built from the compose file alone; `--policy missing` pulls only absent ones
      if (/ pull (--policy missing )?--ignore-pull-failures 2>&1$/.test(command)) {
        const image = state.registryImage;
        if (image && (!command.includes('--policy missing') || image.localId === null)) {
          image.localId = image.remoteId;
        }
        return ok();
      }
      if (/ build 2>&1$/.test(command)) {
        if (state.buildExit !== 0) {
          return { code: state.buildExit, stdout: '', stderr: 'failed to solve: npm run build exited 1' };
        }
        state.imageId = 'sha256:222';
        return ok('built');
      }
      if (/ ps -q 2>&1$/.test(command)) return ok('abc123\n');
      return ok();
    },
    async uploadFile() {},
    async fileExists() {
      return false;
    },
  };
}

const progress: string[] = [];

function deploy(overrides: Partial<Options> = {}) {
  return deployComposeFromRepo(fakeSsh() as never, {
    server: { id: 'srv-1' } as never,
    projectId: 'proj-1',
    projectSlug: 'shop',
    deploySlug: 'shop',
    projectDir: '/opt/pushify/apps/shop',
    workDir: '/opt/pushify/apps/shop/repo',
    composeFile: '/opt/pushify/apps/shop/repo/docker-compose.yml',
    service: null,
    port: null,
    envVars: {},
    sharedHost: false,
    dockerConfig: null,
    commitHash: COMMIT,
    forceBuild: false,
    previous: null,
    pullPolicy: 'always',
    onProgress: (message) => progress.push(message),
    ...overrides,
  });
}

/** A first deploy that built, recorded the way the worker stores it on the deployment row */
async function firstDeploy() {
  const first = await deploy();
  state.commands = [];
  progress.length = 0;
  return { status: 'running', commitHash: COMMIT, buildMetadata: first.buildMetadata };
}

const indexOf = (re: RegExp) => state.commands.findIndex((c) => re.test(c));
const built = () => indexOf(/ build 2>&1$/) > -1;

beforeEach(() => {
  state.commands = [];
  state.buildExit = 0;
  state.head = COMMIT;
  state.runtimeValue = 'one';
  state.imageId = 'sha256:111';
  state.registryImage = null;
  progress.length = 0;
  vi.clearAllMocks();
});

describe('deployComposeFromRepo: a failed build leaves the previous stack serving', () => {
  it('build fails: the previous stack is never taken down and nginx is not touched', async () => {
    state.buildExit = 1;

    await expect(deploy()).rejects.toThrow(/Docker build failed/);

    expect(indexOf(/ build 2>&1$/)).toBeGreaterThan(-1);
    expect(indexOf(/ down /)).toBe(-1);
    expect(indexOf(/ up /)).toBe(-1);
    expect(setupNginxAndDomain).not.toHaveBeenCalled();
  });

  it('build succeeds: builds before stopping the previous stack, then starts without rebuilding', async () => {
    state.buildExit = 0;

    const result = await deploy();

    expect(result.success).toBe(true);
    const build = indexOf(/ build 2>&1$/);
    const down = indexOf(/ down /);
    const up = indexOf(/ up -d /);
    expect(build).toBeGreaterThan(-1);
    expect(down).toBeGreaterThan(build);
    expect(up).toBeGreaterThan(down);
    expect(state.commands[up]).not.toContain('--build');
    expect(setupNginxAndDomain).toHaveBeenCalledOnce();
  });
});

describe('deployComposeFromRepo: skips the build when its inputs did not change', () => {
  it('records the build inputs hash and the images it built', async () => {
    const result = await deploy();

    expect(result.buildMetadata).toEqual({
      composeBuildSkipped: false,
      composeInputsHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      composeImages: { 'pushify-shop-web': 'sha256:222' },
    });
  });

  it('env-only redeploy: no build, the stack is started from the images on the server', async () => {
    const previous = await firstDeploy();
    state.runtimeValue = 'two';

    const result = await deploy({ previous, envVars: { GREETING: 'two' } });

    expect(built()).toBe(false);
    expect(progress).toContain('⏭️ Build inputs unchanged, build skipped — starting the images already on the server');
    expect(indexOf(/ up -d /)).toBeGreaterThan(indexOf(/ down /));
    expect(setupNginxAndDomain).toHaveBeenCalled();
    expect(result.buildMetadata).toEqual({ ...previous.buildMetadata, composeBuildSkipped: true });
  });

  it('a new commit builds', async () => {
    const previous = await firstDeploy();
    state.head = 'b'.repeat(40);

    await deploy({ previous, commitHash: 'b'.repeat(40) });

    expect(built()).toBe(true);
    expect(progress).toContain('🔨 Building images (a new commit)...');
  });

  it('a forced redeploy builds, and says so in the metadata', async () => {
    const previous = await firstDeploy();

    const result = await deploy({ previous, forceBuild: true });

    expect(built()).toBe(true);
    expect(result.buildMetadata.forceBuild).toBe(true);
    expect(result.buildMetadata.composeBuildSkipped).toBe(false);
  });

  it('an image no longer on the server builds', async () => {
    const previous = await firstDeploy();
    state.imageId = null;

    await deploy({ previous });

    expect(built()).toBe(true);
  });

  it('a previous deploy that failed builds', async () => {
    const previous = await firstDeploy();

    await deploy({ previous: { ...previous, status: 'failed' } });

    expect(built()).toBe(true);
  });
});

describe('deployComposeFromRepo: pull policy', () => {
  const pullIndex = () => indexOf(/ pull (--policy missing )?--ignore-pull-failures 2>&1$/);
  const REDIS = 'redis:latest';

  beforeEach(() => {
    state.registryImage = { name: REDIS, localId: null, remoteId: 'sha256:r1' };
  });

  it('always (the default): pulls on every deploy and logs the images it pulled', async () => {
    await deploy();

    expect(state.commands[pullIndex()]).toMatch(/ pull --ignore-pull-failures 2>&1$/);
    expect(state.commands.some((c) => c.includes('--policy'))).toBe(false);
    expect(progress).toContain('⬇️ Pulled 1 image(s): redis:latest (new)');
  });

  it('always: the pull still runs when the build is skipped, before the build decision', async () => {
    const previous = await firstDeploy();

    const result = await deploy({ previous });

    expect(pullIndex()).toBeGreaterThan(-1);
    expect(pullIndex()).toBeLessThan(indexOf(/^docker image inspect/));
    expect(built()).toBe(false);
    expect(result.buildMetadata.composeBuildSkipped).toBe(true);
    expect(progress).toContain('⬇️ No image was pulled or updated');
    expect(progress).toContain(`✅ Unchanged on the server: pushify-shop-web, ${REDIS}`);
  });

  it('always: a moved tag is pulled and logged, and the stack builds and starts with it', async () => {
    const previous = await firstDeploy();
    state.registryImage!.remoteId = 'sha256:r2';

    const result = await deploy({ previous });

    expect(state.registryImage!.localId).toBe('sha256:r2');
    expect(progress).toContain('⬇️ Pulled 1 image(s): redis:latest (updated)');
    expect(progress).toContain('✅ Unchanged on the server: pushify-shop-web');
    expect(progress).toContain(
      '🔨 Building images (the images on the server are not the ones the previous deploy ran)...'
    );
    expect(indexOf(/ up -d /)).toBeGreaterThan(indexOf(/ down /));
    expect(result.buildMetadata.composeImages).toEqual({ 'pushify-shop-web': 'sha256:222', [REDIS]: 'sha256:r2' });
  });

  it('missing: pulls an image that is not on the server yet', async () => {
    await deploy({ pullPolicy: 'missing' });

    expect(state.commands[pullIndex()]).toMatch(/ pull --policy missing --ignore-pull-failures 2>&1$/);
    expect(progress).toContain('⬇️ Pulling images not on the server yet (pull policy: missing)...');
    expect(progress).toContain('⬇️ Pulled 1 image(s): redis:latest (new)');
  });

  it('missing: keeps the images already on the server, a moved tag included, and skips the build', async () => {
    const previous = await firstDeploy();
    state.registryImage!.remoteId = 'sha256:r2';

    const result = await deploy({ previous, pullPolicy: 'missing' });

    expect(state.commands[pullIndex()]).toContain('--policy missing');
    expect(state.registryImage!.localId).toBe('sha256:r1');
    expect(built()).toBe(false);
    expect(result.buildMetadata.composeBuildSkipped).toBe(true);
    expect(progress).toContain('⬇️ No image was pulled or updated');
    expect(progress).toContain(
      `📦 Already on the server, not pulled (pull policy: missing): pushify-shop-web, ${REDIS}`
    );
  });
});
