export interface BuildpackDetectResult {
  detected: boolean;
  framework: string;
  confidence: number; // 0-100, higher = more confident
}

export interface BuildpackConfig {
  buildCommand?: string | null;
  installCommand?: string | null;
  startCommand?: string | null;
  outputDirectory?: string | null;
  port?: number;
  rootDirectory?: string;
  envVars?: Record<string, string>;
}

export interface Buildpack {
  /** Unique ID for this buildpack */
  id: string;

  /** Display name */
  name: string;

  /** Supported frameworks within this buildpack */
  frameworks: string[];

  /** Detect if this buildpack should handle the project */
  detect(workDir: string, rootDir: string): Promise<BuildpackDetectResult>;

  /** Generate a production-ready Dockerfile */
  generateDockerfile(config: BuildpackConfig): string;

  /** Default port the app listens on */
  getDefaultPort(framework?: string): number;

  /** Default build command */
  getDefaultBuildCommand(framework?: string): string;

  /** Default start command */
  getDefaultStartCommand(framework?: string): string;

  /** Default install command */
  getDefaultInstallCommand(framework?: string): string;

  /** Health check path */
  getHealthCheckPath(framework?: string): string;
}
