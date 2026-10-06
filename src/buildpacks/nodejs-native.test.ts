import { describe, it, expect } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { classifyDeployFailure } from '../lib/deploy-failure-classify';
import {
  detectNativeNodeDependencies,
  nativeDependencyLogLines,
  readNativeDependencyLogLines,
} from './nodejs-native';

describe('detectNativeNodeDependencies', () => {
  it('finds common native packages across dependency groups', () => {
    const report = detectNativeNodeDependencies({
      dependencies: { express: '^4', sharp: '^0.33', bcrypt: '^5' },
      devDependencies: { 'better-sqlite3': '^9' },
      optionalDependencies: { bufferutil: '^4' },
    });
    expect(report.native).toEqual(['bcrypt', 'better-sqlite3', 'bufferutil', 'sharp']);
    expect(report.needsSystemLibs).toEqual([]);
  });

  it('flags packages that need system libraries missing from the image', () => {
    const report = detectNativeNodeDependencies({ dependencies: { canvas: '^2' } });
    expect(report.needsSystemLibs.map((p) => p.name)).toEqual(['canvas']);
    const lines = nativeDependencyLogLines(report);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('Dockerfile');
    expect(lines[1]).toContain('libcairo2-dev');
  });

  it('returns no log lines for a pure-JS project', () => {
    expect(nativeDependencyLogLines(detectNativeNodeDependencies({ dependencies: { express: '^4' } }))).toEqual([]);
  });

  it('log lines alone are not classified as a failure', () => {
    const lines = nativeDependencyLogLines(
      detectNativeNodeDependencies({ dependencies: { canvas: '^2', sharp: '^0.33', 'node-gyp': '^10' } })
    );
    expect(classifyDeployFailure(lines.join('\n'), 'Deployment failed').category).toBe('unknown');
  });
});

describe('readNativeDependencyLogLines', () => {
  it('reads package.json under the root directory and never throws', async () => {
    const dir = await fs.mkdtemp(path.join(process.env.TMPDIR || os.tmpdir(), 'pushify-native-'));
    try {
      await fs.mkdir(path.join(dir, 'api'));
      await fs.writeFile(path.join(dir, 'api', 'package.json'), JSON.stringify({ dependencies: { sharp: '1' } }));
      expect((await readNativeDependencyLogLines(dir, 'api'))[0]).toContain('sharp');
      expect(await readNativeDependencyLogLines(dir, '.')).toEqual([]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
