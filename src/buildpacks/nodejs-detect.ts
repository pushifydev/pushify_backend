import type { BuildpackDetectResult } from './types';

/** Node.js framework detection from package.json dependencies. */
export function detectNodeFrameworkFromPackageJson(pkg: {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}): BuildpackDetectResult {
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };

  if (deps['next']) return { detected: true, framework: 'nextjs', confidence: 95 };
  if (deps['nuxt']) return { detected: true, framework: 'nuxt', confidence: 95 };
  if (deps['@sveltejs/kit'] || deps['svelte']) return { detected: true, framework: 'svelte', confidence: 90 };
  if (deps['astro']) return { detected: true, framework: 'astro', confidence: 90 };
  if (deps['@remix-run/react']) return { detected: true, framework: 'remix', confidence: 90 };
  if (deps['vue']) return { detected: true, framework: 'vue', confidence: 85 };
  if (deps['react'] || deps['react-dom']) return { detected: true, framework: 'react', confidence: 85 };
  if (deps['express']) return { detected: true, framework: 'express', confidence: 80 };
  if (deps['fastify']) return { detected: true, framework: 'fastify', confidence: 80 };
  if (deps['hono']) return { detected: true, framework: 'hono', confidence: 80 };
  if (deps['koa']) return { detected: true, framework: 'koa', confidence: 80 };

  return { detected: true, framework: 'nodejs', confidence: 70 };
}
