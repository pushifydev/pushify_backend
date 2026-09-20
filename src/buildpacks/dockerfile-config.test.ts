import { describe, it, expect } from 'vitest';
import { getBuildpack } from './index';

/** Dockerfile generation must honour the install/build/start commands a person configured
 *  (dashboard or pushify.yaml) — every framework path used to silently use its defaults. */
const gen = (id: string, cfg: Record<string, unknown>) => getBuildpack(id)!.generateDockerfile(cfg as never);

describe('nodejs buildpack', () => {
  it('nextjs: custom build + start replace the defaults', () => {
    const df = gen('nodejs', { framework: 'nextjs', buildCommand: 'pnpm build:prod', startCommand: 'node server.js --port 3000' });
    expect(df).toContain('pnpm build:prod');
    expect(df).not.toContain('npm run build');
    expect(df).toContain('CMD ["sh", "-c", "node server.js --port 3000"]');
    expect(df).not.toContain('CMD ["npm", "start"]');
  });

  it('nextjs: keeps npm defaults when nothing is configured', () => {
    const df = gen('nodejs', { framework: 'nextjs' });
    expect(df).toContain('npm run build');
    expect(df).toContain('CMD ["npm", "start"]');
  });

  it('nuxt: custom build + start', () => {
    const df = gen('nodejs', { framework: 'nuxt', buildCommand: 'yarn generate', startCommand: 'node .output/server/index.mjs' });
    expect(df).toContain('yarn generate');
    expect(df).toContain('CMD ["sh", "-c", "node .output/server/index.mjs"]');
  });

  it('svelte static output defaults to build/, others to dist/', () => {
    expect(gen('nodejs', { framework: 'svelte' })).toContain('/build ');
    expect(gen('nodejs', { framework: 'react' })).toContain('/dist ');
    expect(gen('nodejs', { framework: 'react', outputDirectory: 'out' })).toContain('/out ');
  });
});

describe('python buildpack', () => {
  it('django: discovers the wsgi module at start-up instead of assuming config.wsgi', () => {
    const df = gen('python', { framework: 'django' });
    expect(df).toContain('*/wsgi.py');
    expect(df).toContain('${WSGI:-config}.wsgi:application');
    expect(df).toContain('collectstatic');
  });

  it('django: install/build/start overrides', () => {
    const df = gen('python', {
      framework: 'django',
      installCommand: 'poetry install --no-dev',
      buildCommand: 'python manage.py compilemessages',
      startCommand: 'daphne myproj.asgi:application -b 0.0.0.0 -p 8000',
    });
    expect(df).toContain('poetry install --no-dev');
    expect(df).toContain('RUN python manage.py compilemessages');
    expect(df).not.toContain('collectstatic');
    expect(df).toContain('CMD ["sh", "-c", "daphne myproj.asgi:application -b 0.0.0.0 -p 8000"]');
    expect(df).not.toContain('gunicorn');
  });

  it('installs from requirements.txt, Pipfile or pyproject.toml — whichever exists', () => {
    const df = gen('python', { framework: 'fastapi' });
    expect(df).toContain('requirements.txt* Pipfile* Pipfile.lock* pyproject.toml* poetry.lock*');
    expect(df).toContain('if [ -f requirements.txt ]');
    expect(df).toContain('elif [ -f Pipfile ]');
    expect(df).toContain('elif [ -f pyproject.toml ]');
    expect(df).toContain('uvicorn main:app');
  });

  it('flask + generic honour a custom start command', () => {
    expect(gen('python', { framework: 'flask', startCommand: 'gunicorn wsgi:app' })).toContain('CMD ["sh", "-c", "gunicorn wsgi:app"]');
    expect(gen('python', { framework: 'python', startCommand: 'python -m bot' })).toContain('CMD ["sh", "-c", "python -m bot"]');
  });
});

describe('php buildpack', () => {
  it('laravel: install/build/start overrides', () => {
    const df = gen('php', {
      framework: 'laravel',
      installCommand: 'composer install --no-dev',
      buildCommand: 'php artisan optimize',
      startCommand: 'php artisan octane:start --host=0.0.0.0 --port=8080',
    });
    expect(df).toContain('RUN composer install --no-dev\n');
    expect(df).not.toContain('--no-scripts');
    expect(df).toContain('RUN php artisan optimize');
    expect(df).not.toContain('route:cache');
    expect(df).toContain('CMD ["sh", "-c", "php artisan octane:start --host=0.0.0.0 --port=8080"]');
    expect(df).not.toContain('supervisord"');
    expect(df).toContain('chown -R www-data:www-data storage bootstrap/cache');
  });

  it('laravel: defaults stay intact', () => {
    const df = gen('php', { framework: 'laravel' });
    expect(df).toContain('composer install --no-dev --optimize-autoloader --no-scripts');
    expect(df).toContain('route:cache');
    expect(df).toContain('CMD ["supervisord", "-c", "/etc/supervisord.conf"]');
  });

  it('generic php: custom start', () => {
    const df = gen('php', { framework: 'php', startCommand: 'php -S 0.0.0.0:80 -t public' });
    expect(df).toContain('CMD ["sh", "-c", "php -S 0.0.0.0:80 -t public"]');
    expect(df).not.toContain('apache2-foreground');
  });
});

describe('ruby buildpack', () => {
  it('rails: install/build/start overrides', () => {
    const df = gen('ruby', {
      framework: 'rails',
      installCommand: 'bundle install --jobs 8',
      buildCommand: 'bundle exec rake assets:precompile',
      startCommand: 'bundle exec puma -C config/puma.rb',
    });
    expect(df).toContain('RUN bundle install --jobs 8\n');
    expect(df).toContain('RUN bundle exec rake assets:precompile');
    expect(df).not.toContain('db:migrate');
    expect(df).toContain('CMD ["sh", "-c", "bundle exec puma -C config/puma.rb"]');
  });

  it('generic ruby: start command runs through sh so flags with spaces survive', () => {
    const df = gen('ruby', { framework: 'ruby', startCommand: 'bundle exec rackup -o 0.0.0.0 -p 4567' });
    expect(df).toContain('CMD ["sh", "-c", "bundle exec rackup -o 0.0.0.0 -p 4567"]');
  });
});

describe('go, rust and java buildpacks', () => {
  it('go: custom build must produce ./server; custom start replaces /server', () => {
    const df = gen('go', { buildCommand: 'go build -o server ./cmd/api', startCommand: '/server --migrate' });
    expect(df).toContain('RUN go build -o server ./cmd/api && cp ./server /server');
    expect(df).toContain('CMD ["sh", "-c", "/server --migrate"]');
    expect(gen('go', {})).toContain('CMD ["/server"]');
  });

  it('rust: custom build + start', () => {
    const df = gen('rust', { buildCommand: 'cargo build --release --bin api', startCommand: '/server --workers 4' });
    expect(df).toContain('cargo build --release --bin api');
    expect(df).toContain('CMD ["sh", "-c", "/server --workers 4"]');
  });

  it('java: maven and gradle honour build + start', () => {
    const mvn = gen('java', { framework: 'maven', buildCommand: 'mvn -Pprod package -DskipTests', startCommand: 'java -jar app.jar --spring.profiles.active=prod' });
    expect(mvn).toContain('RUN mvn -Pprod package -DskipTests');
    expect(mvn).toContain('CMD ["sh", "-c", "java -jar app.jar --spring.profiles.active=prod"]');
    const gradle = gen('java', { framework: 'gradle', buildCommand: 'gradle bootJar --no-daemon' });
    expect(gradle).toContain('RUN gradle bootJar --no-daemon');
    expect(gradle).toContain('java $JAVA_OPTS -jar app.jar');
  });
});
