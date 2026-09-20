import type { Buildpack } from './types';
import { nodejsBuildpack } from './nodejs';
import { pythonBuildpack } from './python';
import { goBuildpack } from './go';
import { phpBuildpack } from './php';
import { rubyBuildpack } from './ruby';
import { rustBuildpack } from './rust';
import { javaBuildpack } from './java';
import { staticBuildpack } from './static';

/**
 * Registry of all available buildpacks.
 * Order matters — higher priority buildpacks first.
 * More specific (Node.js with framework detection) before generic (static HTML).
 */
export const buildpackRegistry: Buildpack[] = [
  nodejsBuildpack,
  pythonBuildpack,
  goBuildpack,
  phpBuildpack,
  rubyBuildpack,
  rustBuildpack,
  javaBuildpack,
  staticBuildpack, // Lowest priority — catches plain HTML
];

/**
 * Get a buildpack by ID
 */
export function getBuildpack(id: string): Buildpack | undefined {
  return buildpackRegistry.find((bp) => bp.id === id);
}

/** The buildpack that knows a framework name (`laravel` → php); null for names no buildpack owns. */
export function buildpackIdForFramework(framework: string): string | null {
  return buildpackRegistry.find((bp) => bp.frameworks.includes(framework))?.id ?? null;
}

export type { Buildpack, BuildpackDetectResult, BuildpackConfig } from './types';
export {
  detectBuildpack,
  detectBuildpackRemote,
  detectNodeFrameworkFromPackageJson,
} from './detector';
export { detectNextStandaloneRemote, detectNextStandaloneFromConfig } from './remote-detect';
export type { DetectionResult } from './detector';
