import { promises as fs } from 'fs';
import path from 'path';

/**
 * Popular npm packages that ship (or compile) a native addon. The Node buildpack image has
 * python3, make, g++ and pkg-config, so node-gyp builds and prebuilt glibc binaries work.
 * Packages listed in NEEDS_SYSTEM_LIBS additionally link against system libraries that are
 * not in the slim image — those need a custom Dockerfile.
 */
const NATIVE_PACKAGES = new Set([
  'sharp',
  'bcrypt',
  'argon2',
  'better-sqlite3',
  'sqlite3',
  'canvas',
  'node-sass',
  'bufferutil',
  'utf-8-validate',
  're2',
  'node-gyp',
  'node-pre-gyp',
  '@mapbox/node-pre-gyp',
  'cpu-features',
  'ssh2',
  'zeromq',
  'grpc',
  'libxmljs',
  'libxmljs2',
  'pg-native',
  'oracledb',
  'serialport',
  'usb',
  'deasync',
  'microtime',
  'kerberos',
]);

const NEEDS_SYSTEM_LIBS: Record<string, string> = {
  canvas: 'libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev',
  'pg-native': 'libpq-dev',
  libxmljs: 'libxml2-dev',
  libxmljs2: 'libxml2-dev',
  kerberos: 'libkrb5-dev',
  zeromq: 'libzmq3-dev',
};

export interface NativeDependencyReport {
  /** Native packages found in dependencies/devDependencies/optionalDependencies. */
  native: string[];
  /** Subset that needs system libraries missing from the buildpack image, with the apt packages. */
  needsSystemLibs: { name: string; aptPackages: string }[];
}

export function detectNativeNodeDependencies(pkg: {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}): NativeDependencyReport {
  const names = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies });
  const native = names.filter((n) => NATIVE_PACKAGES.has(n)).sort();
  const needsSystemLibs = native
    .filter((n) => n in NEEDS_SYSTEM_LIBS)
    .map((name) => ({ name, aptPackages: NEEDS_SYSTEM_LIBS[name] }));
  return { native, needsSystemLibs };
}

/** Human-readable build-log lines for the native dependencies of a Node project (empty when none). */
export function nativeDependencyLogLines(report: NativeDependencyReport): string[] {
  if (report.native.length === 0) return [];
  const lines = [
    `🧩 Native dependencies detected: ${report.native.join(', ')} — the build image includes python3, make, g++ and pkg-config (glibc) to compile them.`,
  ];
  for (const { name, aptPackages } of report.needsSystemLibs) {
    lines.push(
      `⚠️ ${name} also needs system libraries that are not in the Pushify build image (${aptPackages}). ` +
        `If the build fails, deploy with your own Dockerfile that runs: apt-get install -y ${aptPackages}`
    );
  }
  return lines;
}

/** Reads package.json under rootDir and returns the log lines; never throws. */
export async function readNativeDependencyLogLines(workDir: string, rootDir: string): Promise<string[]> {
  try {
    const pkgPath = path.join(workDir, rootDir === '.' ? '' : rootDir, 'package.json');
    const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf-8'));
    return nativeDependencyLogLines(detectNativeNodeDependencies(pkg));
  } catch {
    return [];
  }
}
