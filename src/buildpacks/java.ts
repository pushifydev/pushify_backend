import { promises as fs } from 'fs';
import path from 'path';
import type { Buildpack, BuildpackDetectResult, BuildpackConfig } from './types';

export const javaBuildpack: Buildpack = {
  id: 'java',
  name: 'Java',
  frameworks: ['spring', 'maven', 'gradle', 'java'],

  async detect(workDir: string, rootDir: string): Promise<BuildpackDetectResult> {
    const base = path.join(workDir, rootDir === '.' ? '' : rootDir);
    try {
      // Maven
      const pom = await fs.readFile(path.join(base, 'pom.xml'), 'utf-8').catch(() => '');
      if (pom) {
        if (pom.includes('spring-boot')) return { detected: true, framework: 'spring', confidence: 95 };
        return { detected: true, framework: 'maven', confidence: 85 };
      }

      // Gradle
      const gradle = await fs.readFile(path.join(base, 'build.gradle'), 'utf-8').catch(() => '');
      const gradleKts = await fs.readFile(path.join(base, 'build.gradle.kts'), 'utf-8').catch(() => '');
      const gradleContent = gradle || gradleKts;
      if (gradleContent) {
        if (gradleContent.includes('spring-boot')) return { detected: true, framework: 'spring', confidence: 95 };
        return { detected: true, framework: 'gradle', confidence: 85 };
      }

      return { detected: false, framework: '', confidence: 0 };
    } catch {
      return { detected: false, framework: '', confidence: 0 };
    }
  },

  generateDockerfile(config: BuildpackConfig): string {
    const framework = (config as any).framework || 'java';
    const port = config.port || 8080;
    const rootDir = config.rootDirectory || '.';
    const copyPrefix = rootDir === '.' ? '' : rootDir + '/';

    const isMaven = framework === 'maven' || framework === 'spring';
    const isGradle = framework === 'gradle';

    if (isGradle) return this._gradle(copyPrefix, rootDir, port);
    return this._maven(copyPrefix, rootDir, port);
  },

  getDefaultPort(): number { return 8080; },
  getDefaultBuildCommand(framework?: string): string {
    if (framework === 'gradle') return './gradlew build -x test';
    return 'mvn package -DskipTests';
  },
  getDefaultStartCommand(): string { return 'java -jar app.jar'; },
  getDefaultInstallCommand(framework?: string): string {
    if (framework === 'gradle') return './gradlew dependencies';
    return 'mvn dependency:resolve';
  },
  getHealthCheckPath(): string { return '/actuator/health'; },

  _maven(copyPrefix: string, rootDir: string, port: number): string {
    return `FROM maven:3.9-eclipse-temurin-21-alpine AS builder

WORKDIR /app

COPY ${copyPrefix}pom.xml ./
RUN mvn dependency:resolve -q

COPY ${rootDir === '.' ? '.' : rootDir} .
RUN mvn package -DskipTests -q

FROM eclipse-temurin:21-jre-alpine AS runner

WORKDIR /app

COPY --from=builder /app/target/*.jar app.jar

EXPOSE ${port}
ENV PORT=${port}
ENV JAVA_OPTS="-Xmx256m -Xms128m"

CMD ["sh", "-c", "java $JAVA_OPTS -jar app.jar --server.port=$PORT"]
`;
  },

  _gradle(copyPrefix: string, rootDir: string, port: number): string {
    return `FROM gradle:8.5-jdk21-alpine AS builder

WORKDIR /app

COPY ${copyPrefix}build.gradle* ${copyPrefix}settings.gradle* ${copyPrefix}gradle* ./
RUN gradle dependencies --no-daemon -q 2>/dev/null || true

COPY ${rootDir === '.' ? '.' : rootDir} .
RUN gradle build -x test --no-daemon -q

FROM eclipse-temurin:21-jre-alpine AS runner

WORKDIR /app

COPY --from=builder /app/build/libs/*.jar app.jar

EXPOSE ${port}
ENV PORT=${port}
ENV JAVA_OPTS="-Xmx256m -Xms128m"

CMD ["sh", "-c", "java $JAVA_OPTS -jar app.jar --server.port=$PORT"]
`;
  },
} as Buildpack & Record<string, any>;
