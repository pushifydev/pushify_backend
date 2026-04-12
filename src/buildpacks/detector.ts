import { promises as fs } from 'fs';
import path from 'path';
import type { BuildpackDetectResult } from './types';
import { buildpackRegistry } from './index';

export interface DetectionResult {
  buildpackId: string;
  framework: string;
  confidence: number;
}

/**
 * Auto-detect the project's language and framework.
 * Checks if the user provided a Dockerfile first.
 * Then runs all buildpacks and returns the highest-confidence match.
 */
export async function detectBuildpack(workDir: string, rootDir: string = '.'): Promise<DetectionResult | null> {
  const base = path.join(workDir, rootDir === '.' ? '' : rootDir);

  // If user has a Dockerfile, skip detection
  const hasDockerfile = await fs.access(path.join(base, 'Dockerfile'))
    .then(() => true)
    .catch(() => false);

  if (hasDockerfile) {
    return { buildpackId: 'custom', framework: 'dockerfile', confidence: 100 };
  }

  // Run all buildpacks in parallel
  const results: (DetectionResult | null)[] = await Promise.all(
    buildpackRegistry.map(async (bp) => {
      try {
        const result = await bp.detect(workDir, rootDir);
        if (result.detected) {
          return {
            buildpackId: bp.id,
            framework: result.framework,
            confidence: result.confidence,
          };
        }
      } catch {
        // Ignore detection errors
      }
      return null;
    })
  );

  // Filter and sort by confidence
  const valid = results.filter((r): r is DetectionResult => r !== null);
  valid.sort((a, b) => b.confidence - a.confidence);

  return valid[0] || null;
}
