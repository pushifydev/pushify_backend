import { unzipSync, zipSync, type Unzipped, type Zippable } from 'fflate';

/**
 * "Drop a folder, get a URL": turning what a browser, the CLI or a zip hands us into a clean
 * set of site files — or refusing it. Everything here is pure (no I/O) so the rules are testable.
 *
 * Paths end up as SFTP targets and in `mkdir -p` on the customer's server, so they are held to a
 * strict shape: relative, no `..`, no hidden files (a `.git` or `.env` must never be published —
 * see the Sept 2026 static-site `.git` leak), letters/digits and a few punctuation marks only.
 */

export interface SiteFile {
  path: string;
  content: Uint8Array;
}

export const STATIC_UPLOAD_LIMITS = {
  maxFiles: 2000,
  maxFileBytes: 25 * 1024 * 1024,
  maxTotalBytes: 50 * 1024 * 1024,
} as const;

export type StaticUploadErrorCode =
  | 'NO_FILES'
  | 'NO_INDEX'
  | 'TOO_MANY_FILES'
  | 'FILE_TOO_LARGE'
  | 'TOO_LARGE'
  | 'BAD_PATH'
  | 'BAD_ZIP';

export class StaticUploadError extends Error {
  constructor(
    public readonly code: StaticUploadErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'StaticUploadError';
  }
}

const SEGMENT = /^[\p{L}\p{N}._\-@+~ ()]+$/u;
/** Junk that archivers and operating systems add; skipped silently. */
const IGNORED_SEGMENTS = new Set(['__MACOSX', 'Thumbs.db', 'desktop.ini', 'node_modules']);

/**
 * A clean relative path, `null` for a file that is skipped on purpose (hidden files and folders,
 * OS junk), or an error for a path that tries to escape or can't be represented safely.
 */
export function normalizeUploadPath(raw: string): string | null {
  const segments = raw
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s !== '' && s !== '.');
  if (segments.length === 0) return null;
  if (segments.some((s) => s === '..')) {
    throw new StaticUploadError('BAD_PATH', `Path leaves the site folder: ${raw}`);
  }
  if (segments.some((s) => s.startsWith('.') || IGNORED_SEGMENTS.has(s))) return null;
  for (const s of segments) {
    if (!SEGMENT.test(s) || s.length > 200) {
      throw new StaticUploadError('BAD_PATH', `Unsupported characters in file name: ${raw}`);
    }
  }
  const path = segments.join('/');
  if (path.length > 900) throw new StaticUploadError('BAD_PATH', `Path is too long: ${raw.slice(0, 80)}…`);
  return path;
}

/**
 * Validate and tidy a set of uploaded files:
 *  - hidden files and OS junk are dropped;
 *  - a single wrapping folder (`my-site/index.html`, as a zipped folder usually is) is unwrapped;
 *  - `index.html` must be at the root afterwards;
 *  - counts and sizes stay within STATIC_UPLOAD_LIMITS.
 */
export function collectSiteFiles(entries: Iterable<{ path: string; content: Uint8Array }>): SiteFile[] {
  const byPath = new Map<string, Uint8Array>();
  let total = 0;
  for (const entry of entries) {
    const path = normalizeUploadPath(entry.path);
    if (!path) continue;
    if (entry.content.byteLength > STATIC_UPLOAD_LIMITS.maxFileBytes) {
      throw new StaticUploadError('FILE_TOO_LARGE', `${path} is larger than 25 MB`);
    }
    const previous = byPath.get(path);
    total += entry.content.byteLength - (previous?.byteLength ?? 0);
    byPath.set(path, entry.content);
    if (byPath.size > STATIC_UPLOAD_LIMITS.maxFiles) {
      throw new StaticUploadError('TOO_MANY_FILES', `A site can have at most ${STATIC_UPLOAD_LIMITS.maxFiles} files`);
    }
    if (total > STATIC_UPLOAD_LIMITS.maxTotalBytes) {
      throw new StaticUploadError('TOO_LARGE', 'A site can be at most 50 MB');
    }
  }
  if (byPath.size === 0) throw new StaticUploadError('NO_FILES', 'No files to publish');

  let files = [...byPath].map(([path, content]) => ({ path, content }));
  if (!byPath.has('index.html')) {
    const tops = new Set(files.map((f) => f.path.split('/')[0]));
    const [top] = tops;
    if (tops.size === 1 && files.every((f) => f.path.includes('/')) && byPath.has(`${top}/index.html`)) {
      files = files.map((f) => ({ path: f.path.slice(top.length + 1), content: f.content }));
    }
  }
  if (!files.some((f) => f.path === 'index.html')) {
    throw new StaticUploadError('NO_INDEX', 'The site needs an index.html at its root');
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

/** Entries of an uploaded zip, refusing archives that would expand past the limits. */
export function entriesFromZip(zip: Uint8Array): { path: string; content: Uint8Array }[] {
  let declared = 0;
  let count = 0;
  let unzipped: Unzipped;
  try {
    unzipped = unzipSync(zip, {
      filter: (file) => {
        if (file.name.endsWith('/')) return false;
        count++;
        declared += file.originalSize;
        if (count > STATIC_UPLOAD_LIMITS.maxFiles * 2) {
          throw new StaticUploadError('TOO_MANY_FILES', `A site can have at most ${STATIC_UPLOAD_LIMITS.maxFiles} files`);
        }
        if (file.originalSize > STATIC_UPLOAD_LIMITS.maxFileBytes || declared > STATIC_UPLOAD_LIMITS.maxTotalBytes * 2) {
          throw new StaticUploadError('TOO_LARGE', 'The zip expands to more than 50 MB');
        }
        return true;
      },
    });
  } catch (err) {
    if (err instanceof StaticUploadError) throw err;
    throw new StaticUploadError('BAD_ZIP', 'The file is not a valid zip archive');
  }
  return Object.entries(unzipped).map(([path, content]) => ({ path, content }));
}

/** Stored form of a version: the cleaned files as one zip. */
export function packSiteFiles(files: SiteFile[]): Buffer {
  const tree: Zippable = {};
  for (const f of files) tree[f.path] = [f.content, { level: 6 }];
  return Buffer.from(zipSync(tree));
}

export function unpackSiteFiles(archive: Uint8Array): SiteFile[] {
  return Object.entries(unzipSync(archive))
    .filter(([path]) => !path.endsWith('/'))
    .map(([path, content]) => ({ path, content }));
}

/** Single-quote a value for a POSIX shell. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Folder / vhost name of a static site on its server. Uploaded sites can share a runner with
 * other organisations, whose project slugs may be the same, so theirs carries the project id.
 */
export function staticSiteKey(project: { id: string; slug: string; settings: unknown }): string {
  const settings = (project.settings ?? {}) as Record<string, unknown>;
  return settings.staticSource === 'upload' ? `${project.slug}-${project.id.slice(0, 8)}` : project.slug;
}
