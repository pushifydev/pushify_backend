export function detectFrameworkFromPackageJson(packageJson: string): {
  framework: string | null;
  buildCommand: string | null;
  installCommand: string | null;
  outputDirectory: string | null;
  startCommand: string | null;
} {
  try {
    const pkg = JSON.parse(packageJson);
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };

    if (deps['next']) {
      return {
        framework: 'nextjs',
        buildCommand: 'npm run build',
        installCommand: 'npm install',
        outputDirectory: '.next',
        startCommand: 'npm start',
      };
    }

    if (deps['nuxt']) {
      return {
        framework: 'nuxt',
        buildCommand: 'npm run build',
        installCommand: 'npm install',
        outputDirectory: '.output',
        startCommand: 'npm start',
      };
    }

    if (deps['svelte'] || deps['@sveltejs/kit']) {
      return {
        framework: 'svelte',
        buildCommand: 'npm run build',
        installCommand: 'npm install',
        outputDirectory: 'build',
        startCommand: null,
      };
    }

    if (deps['astro']) {
      return {
        framework: 'astro',
        buildCommand: 'npm run build',
        installCommand: 'npm install',
        outputDirectory: 'dist',
        startCommand: null,
      };
    }

    if (deps['vue']) {
      return {
        framework: 'vue',
        buildCommand: 'npm run build',
        installCommand: 'npm install',
        outputDirectory: 'dist',
        startCommand: null,
      };
    }

    if (deps['react'] || deps['react-dom']) {
      return {
        framework: 'react',
        buildCommand: 'npm run build',
        installCommand: 'npm install',
        outputDirectory: 'build',
        startCommand: null,
      };
    }

    if (pkg.scripts?.start) {
      return {
        framework: 'nodejs',
        buildCommand: pkg.scripts?.build ? 'npm run build' : null,
        installCommand: 'npm install',
        outputDirectory: null,
        startCommand: 'npm start',
      };
    }
  } catch {
    // invalid json
  }

  return {
    framework: null,
    buildCommand: null,
    installCommand: null,
    outputDirectory: null,
    startCommand: null,
  };
}

export const STATIC_FRAMEWORK_RESULT = {
  docker: {
    framework: 'docker' as const,
    buildCommand: null,
    installCommand: null,
    outputDirectory: null,
    startCommand: null,
  },
  static: {
    framework: 'static' as const,
    buildCommand: null,
    installCommand: null,
    outputDirectory: '.',
    startCommand: null,
  },
};
