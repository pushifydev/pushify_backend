import { promises as fs } from 'fs';
import path from 'path';
import type { Buildpack, BuildpackDetectResult, BuildpackConfig } from './types';

/** Folders a hand-written site usually lives in, in the order they are tried. */
export const STATIC_SITE_DIRS = ['.', 'public', 'dist', 'build', 'site', 'www', 'html', 'docs', 'src', 'web', 'static', 'app'];

/**
 * Runs in the first build stage over the repository at /src and writes the site to /out/html and
 * the server config to /out/conf. It exists because copying the repository straight into nginx's
 * web root went wrong in three ways: a site kept in a subfolder (or whose nginx.conf `root`
 * pointed at one) left the image's "Welcome to nginx!" page as the home page; `.git` — whose
 * config held the clone URL with its access token — and the Dockerfile were served to anyone;
 * and a repo nginx.conf written for a VPS (TLS, HTTPS redirects, `http {}`) broke or looped.
 */
export const STATIC_SITE_SCRIPT = `# Pushify static site: picks the web root, strips the repository's internals, writes the
# nginx server config. $1 = port. Reads $PUSHIFY_SRC (/src), writes $PUSHIFY_OUT (/out).
set -eu
PORT="$1"
SRC="\${PUSHIFY_SRC:-/src}"
OUT="\${PUSHIFY_OUT:-/out}"
mkdir -p "$OUT/html" "$OUT/conf"

has_index() {
  [ -n "$(find "$1" -maxdepth 1 -type f \\( -iname index.html -o -iname index.htm \\) 2>/dev/null | head -n 1)" ]
}

# 1. The repository's own nginx config, if it has one.
CONF=""
for c in nginx.conf nginx/nginx.conf nginx/default.conf .nginx/nginx.conf .nginx/default.conf conf/nginx.conf default.conf; do
  if [ -f "$SRC/$c" ]; then CONF="$SRC/$c"; break; fi
done

# 2. The web root: the folder that config's \`root\` names (matched by its tail, so
#    /var/www/site finds ./site), else the first usual folder with an index page, else the
#    shallowest folder holding a .html file.
WEBROOT=""
if [ -n "$CONF" ]; then
  R="$(sed -n -E 's/^[[:space:]]*root[[:space:]]+["'\\'']?([^"'\\'';[:space:]]+).*/\\1/p' "$CONF" | head -n 1)"
  T="\${R#/}"
  while [ -n "$T" ]; do
    if [ -d "$SRC/$T" ] && has_index "$SRC/$T"; then WEBROOT="$SRC/$T"; break; fi
    case "$T" in */*) T="\${T#*/}" ;; *) T="" ;; esac
  done
fi
if [ -z "$WEBROOT" ]; then
  for d in . public dist build site www html docs src web static app; do
    if [ -d "$SRC/$d" ] && has_index "$SRC/$d"; then
      if [ "$d" = . ]; then WEBROOT="$SRC"; else WEBROOT="$SRC/$d"; fi
      break
    fi
  done
fi
if [ -z "$WEBROOT" ]; then
  F="$(find "$SRC" -type f -iname '*.html' -not -path '*/.git/*' -not -path '*/node_modules/*' 2>/dev/null \\
    | awk -F/ '{ print NF "\\t" $0 }' | sort -n | head -n 1 | cut -f2-)"
  if [ -n "$F" ]; then WEBROOT="$(dirname "$F")"; else WEBROOT="$SRC"; fi
fi
REL="\${WEBROOT#"$SRC"}"
echo "Pushify: web root /\${REL#/}"

# 3. Copy the site, never the repository's internals (.git, Dockerfile, env files, …).
cp -a "$WEBROOT"/. "$OUT/html"/
cd "$OUT/html"
rm -rf .git .github .gitlab .gitignore .gitattributes .gitmodules .dockerignore Dockerfile \\
  docker-compose.yml docker-compose.yaml compose.yml compose.yaml pushify.yaml pushify.yml pushify.json \\
  .env .env.* node_modules .DS_Store
if [ -n "$CONF" ]; then
  case "$CONF" in "$WEBROOT"/*) rm -f "$OUT/html/\${CONF#"$WEBROOT"/}" ;; esac
fi

# 4. A home page: index.html exactly (Linux is case-sensitive), else index.htm / Index.html,
#    else a page named like one (home, main, anasayfa, …), else the first page.
if [ ! -f index.html ]; then
  I="$(find . -maxdepth 1 -type f \\( -iname index.html -o -iname index.htm \\) | head -n 1)"
  if [ -z "$I" ]; then
    for n in home.html main.html default.html anasayfa.html start.html welcome.html; do
      I="$(find . -maxdepth 1 -type f -iname "$n" | head -n 1)"
      if [ -n "$I" ]; then break; fi
    done
  fi
  [ -n "$I" ] || I="$(find . -maxdepth 1 -type f -iname '*.html' | sort | head -n 1)"
  if [ -n "$I" ]; then
    cp "$I" index.html
    echo "Pushify: no index.html, serving \${I#./} as the home page"
  fi
fi

# 5. Default server config: clean URLs (/about -> about.html); a site with 404.html gets real
#    404s, anything else falls back to index.html (single-page apps).
if [ -f 404.html ]; then
  TRY='$uri $uri.html $uri/ =404'; ERR='error_page 404 /404.html;'
else
  TRY='$uri $uri.html $uri/ /index.html'; ERR=''
fi
cat > "$OUT/conf/default.conf" <<EOF
server {
    listen $PORT;
    root /usr/share/nginx/html;
    index index.html index.htm;
    $ERR
    location ~ /\\.(?!well-known) { return 404; }
    location ~* \\.(?:css|js|mjs|json|png|jpg|jpeg|gif|svg|webp|avif|ico|woff2?|ttf|eot|map)\\$ {
        expires 1h;
        try_files \\$uri =404;
    }
    location / {
        try_files $TRY;
        add_header Cache-Control "no-cache";
    }
}
EOF

# 6. The repository's config, made to fit behind Pushify: listen on $PORT over plain HTTP (TLS
#    ends at the host), serve the web root, and drop server blocks that redirect to https://
#    (behind the proxy they would loop). A full nginx.conf (http { … }) is not used.
if [ -n "$CONF" ]; then
  NAME="\${CONF#"$SRC"/}"
  if grep -Eq '^[[:space:]]*(http|events)[[:space:]]*\\{' "$CONF"; then
    echo "Pushify: $NAME is a full nginx config (http { ... }), using the default static config. Put server { ... } rules in it to customise."
  elif grep -Eq '^[[:space:]]*server[[:space:]]*\\{' "$CONF"; then
    awk '
      {
        line = $0
        if (depth == 0 && !inserver && line ~ /^[[:space:]]*server[[:space:]]*\\{/) inserver = 1
        if (inserver) buf = buf line "\\n"; else print line
        opens = gsub(/\\{/, "{", line); closes = gsub(/\\}/, "}", line)
        depth += opens - closes
        if (inserver && depth <= 0) {
          if (buf !~ /(return|rewrite)[^;]*https:\\/\\//) printf "%s", buf
          buf = ""; inserver = 0; depth = 0
        }
      }
    ' "$CONF" \\
      | sed -E \\
        -e 's/(listen[[:space:]]+)([^ ;]*:)?[0-9]+/\\1\\2'"$PORT"'/' \\
        -e 's/(listen[[:space:]][^;]*)[[:space:]]+ssl/\\1/' \\
        -e 's/(listen[[:space:]][^;]*)[[:space:]]+http2/\\1/' \\
        -e '/^[[:space:]]*ssl_[a-z_]+[[:space:]]/d' \\
        -e '/^[[:space:]]*http2[[:space:]]+on/d' \\
        -e 's#^([[:space:]]*root[[:space:]]+)[^;]+#\\1/usr/share/nginx/html#' \\
      > "$OUT/conf/repo.conf"
    if grep -Eq '^[[:space:]]*server[[:space:]]*\\{' "$OUT/conf/repo.conf"; then
      echo "Pushify: using $NAME (listen $PORT, root = the web root)"
    else
      rm -f "$OUT/conf/repo.conf"
      echo "Pushify: $NAME only redirects to HTTPS, which Pushify already does. Using the default static config."
    fi
  else
    echo "Pushify: $NAME has no server { ... } block, using the default static config"
  fi
fi
`;

async function listEntries(dir: string) {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

const isPage = (name: string) => /\.html?$/i.test(name);
const isIndex = (name: string) => /^index\.html?$/i.test(name);

/** Any page within two levels (skipping dependencies and VCS), like the remote detector. */
async function hasPageWithin(dir: string, depth: number): Promise<boolean> {
  for (const entry of await listEntries(dir)) {
    if (entry.isFile() && isPage(entry.name)) return true;
    if (entry.isDirectory() && depth > 1 && !['node_modules', '.git'].includes(entry.name)) {
      if (await hasPageWithin(path.join(dir, entry.name), depth - 1)) return true;
    }
  }
  return false;
}

export const staticBuildpack: Buildpack = {
  id: 'static',
  name: 'Static Site',
  frameworks: ['html', 'static'],

  async detect(workDir: string, rootDir: string): Promise<BuildpackDetectResult> {
    const base = path.join(workDir, rootDir === '.' ? '' : rootDir);
    // An index page (any case, .html or .htm) at the root or in a usual folder, else any page
    // within two levels. (Only a root index.html used to count.)
    for (const dir of STATIC_SITE_DIRS) {
      const entries = await listEntries(path.join(base, dir === '.' ? '' : dir));
      if (entries.some((e) => e.isFile() && isIndex(e.name))) {
        return { detected: true, framework: 'static', confidence: dir === '.' ? 50 : 45 };
      }
    }
    if (await hasPageWithin(base, 2)) return { detected: true, framework: 'static', confidence: 40 };
    return { detected: false, framework: '', confidence: 0 };
  },

  generateDockerfile(config: BuildpackConfig): string {
    const rootDir = config.rootDirectory || '.';
    // The deploy workers map the host port to the project's configured port
    // (default 3000) — nginx must listen on that same port, not a hardcoded 80.
    const port = config.port || 80;
    const script = Buffer.from(STATIC_SITE_SCRIPT, 'utf8').toString('base64');

    return `# Static site. Stage 1 picks the web root (the folder the repo's nginx.conf \`root\` names, a usual
# folder with an index page, or wherever the .html files are), leaves out the repository's internals
# (.git, Dockerfile, env files) and prepares the nginx config. Stage 2 serves only that.
# Source: pushify_backend/src/buildpacks/static.ts
FROM nginx:alpine AS site
COPY ${rootDir === '.' ? '.' : rootDir} /src
RUN echo '${script}' | base64 -d > /pushify-static.sh && sh /pushify-static.sh ${port}

FROM nginx:alpine
RUN rm -rf /usr/share/nginx/html/* /etc/nginx/conf.d/*
COPY --from=site /out/html/ /usr/share/nginx/html/
COPY --from=site /out/conf/ /etc/nginx/pushify/
# The repository's nginx config when it passes nginx -t, the default static config otherwise.
RUN if [ -f /etc/nginx/pushify/repo.conf ]; then \\
      cp /etc/nginx/pushify/repo.conf /etc/nginx/conf.d/default.conf; \\
      if ! nginx -t 2>/dev/null; then \\
        echo 'Pushify: the repository nginx config failed nginx -t, using the default static config'; \\
        cp /etc/nginx/pushify/default.conf /etc/nginx/conf.d/default.conf; \\
      fi; \\
    else cp /etc/nginx/pushify/default.conf /etc/nginx/conf.d/default.conf; fi && nginx -t

EXPOSE ${port}

CMD ["nginx", "-g", "daemon off;"]
`;
  },

  getDefaultPort(): number { return 80; },
  getDefaultBuildCommand(): string { return ''; },
  getDefaultStartCommand(): string { return 'nginx -g "daemon off;"'; },
  getDefaultInstallCommand(): string { return ''; },
  getHealthCheckPath(): string { return '/'; },
};
