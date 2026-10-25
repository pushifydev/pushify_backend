import { normalizeRootDirectory } from './normalize-root-directory';

/**
 * Env variable names a repository documents in its example file, for the new-project wizard.
 *
 * Only the names leave this module — never the values: an "example" file is still committed to
 * the repository and sometimes holds a real secret. `hasDefault` only says whether a non-blank
 * value was there.
 */

/** Checked in this order inside the project's root directory; the first one found is used. */
export const ENV_EXAMPLE_FILE_NAMES = ['.env.example', '.env.sample', '.env.template'] as const;

/** Bigger files are ignored (an example env file is a few KB). */
export const ENV_EXAMPLE_MAX_BYTES = 64 * 1024;

/** The same rule envVarService applies on create / bulk, so every detected key can be saved as-is. */
const ENV_KEY_RE = /^[A-Z][A-Z0-9_]*$/;
const ENV_KEY_MAX_LENGTH = 255;

const LINE_RE = /^(?:export\s+)?([^=\s]+)\s*=\s*(.*)$/;

export interface EnvExampleKey {
  key: string;
  hasDefault: boolean;
}

export interface EnvExampleDetection {
  /** Repository path of the file the keys came from, or null when none was found. */
  source: string | null;
  keys: EnvExampleKey[];
}

function closingQuoteIndex(value: string, quote: string): number {
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '\\') {
      i++;
      continue;
    }
    if (value[i] === quote) return i;
  }
  return -1;
}

/**
 * dotenv syntax: blank lines and `#` comments are skipped, `export ` is allowed, unquoted values
 * end at `#`, quoted values ('', "", ``) may span lines (PEM keys). Invalid names are dropped; a
 * repeated name keeps its first position and its last value, like dotenv.
 */
export function parseEnvExampleKeys(content: string): EnvExampleKey[] {
  const found = new Map<string, boolean>();
  const withoutBom = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  const lines = withoutBom.split(/\r\n|\r|\n/);
  // Line after which a quote character never appears again: a failed look-ahead runs once per
  // quote, so a file full of unclosed quotes stays linear.
  const neverClosesAfter = new Map<string, number>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;

    const match = LINE_RE.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;

    let value: string;
    const quote = rawValue[0];
    if (quote === '"' || quote === "'" || quote === '`') {
      const firstLine = rawValue.slice(1);
      const close = closingQuoteIndex(firstLine, quote);
      if (close !== -1) {
        value = firstLine.slice(0, close);
      } else {
        let end = -1;
        let closeAt = -1;
        if ((neverClosesAfter.get(quote) ?? Infinity) > i) {
          for (let j = i + 1; j < lines.length && end === -1; j++) {
            closeAt = closingQuoteIndex(lines[j], quote);
            if (closeAt !== -1) end = j;
          }
          if (end === -1) neverClosesAfter.set(quote, i);
        }
        if (end === -1) {
          // Never closed: dotenv reads the line as an unquoted value.
          value = rawValue.split('#')[0];
        } else {
          value = [firstLine, ...lines.slice(i + 1, end), lines[end].slice(0, closeAt)].join('\n');
          i = end; // skip the lines inside a multi-line value
        }
      }
    } else {
      value = rawValue.split('#')[0];
    }

    if (key.length > ENV_KEY_MAX_LENGTH || !ENV_KEY_RE.test(key)) continue;
    found.set(key, value.trim() !== '');
  }

  return [...found].map(([key, hasDefault]) => ({ key, hasDefault }));
}

/** Candidate paths, relative to the repository root, for a project's root directory. */
export function envExampleCandidatePaths(rootDirectory?: string | null): string[] {
  const root = normalizeRootDirectory(rootDirectory);
  return ENV_EXAMPLE_FILE_NAMES.map((name) => (root === '.' ? name : `${root}/${name}`));
}

/**
 * Keys from the first example file found. `readFile` resolves null for a missing, unreadable or
 * oversized file; no file at all is an empty list, not an error.
 */
export async function detectEnvExampleKeys(
  readFile: (path: string) => Promise<string | null>,
  rootDirectory?: string | null
): Promise<EnvExampleDetection> {
  for (const path of envExampleCandidatePaths(rootDirectory)) {
    const content = await readFile(path).catch(() => null);
    if (content === null) continue;
    return { source: path, keys: parseEnvExampleKeys(content) };
  }
  return { source: null, keys: [] };
}

/** Body as text, or null as soon as it is larger than `maxBytes` (stops downloading there). */
export async function readTextWithLimit(response: Response, maxBytes: number): Promise<string | null> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!response.body) {
    const text = await response.text();
    return Buffer.byteLength(text) > maxBytes ? null : text;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf-8');
}
