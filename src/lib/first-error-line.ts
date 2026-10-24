import { scrubSecrets } from './ops-scrub';

/**
 * The first line of a failed deploy's log that says what went wrong, for the deploy page and the
 * growth report: stored in `deployments.failure_summary` next to the category, so a failure the
 * classifier has no case for ('unknown') still shows its cause. Masked and capped like an ops
 * error: the caller's masker (the project's secrets) first, then scrubSecrets.
 */

export const FAILURE_SUMMARY_MAX_LENGTH = 300;

/** "[2026-10-24T10:00:00.000Z] " — the worker's prefix on every log line. */
const WORKER_TIMESTAMP = /^\[\d{4}-\d\d-\d\dT[^\]]*\]\s*/;
/** "#11 0.412 " — BuildKit's step number and elapsed seconds. */
const BUILDKIT_PREFIX = /^#\d+\s+(?:\d+\.\d+\s+)?/;
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

/** Words a tool prints when it fails. `text` is not lower-cased. */
const ERROR_LINE =
  /(?:error|exception)s?\b|\berr!|\bfatal\b|\bpanic(?:ked)?\b|\bfailed\b|\bfailure\b|\bcannot\b|\bcan't\b|\bcould not\b|\bunable to\b|\bnot found\b|\bno such file\b|\bpermission denied\b|\bsegmentation fault\b|\bkilled\b/i;

/** Lines that are never the cause: what ran, warnings, stack frames and the worker's own narration. */
const NOISE: RegExp[] = [
  /^\p{Extended_Pictographic}/u, // the worker's own lines (🔨 Building…, ⚠️ …, ❌ …, 💡 hint)
  /\[Pushify\] /, // the worker's tags (failureCategory=, queue:)
  /^\[[^\]]*\d+\/\d+\]\s/, // BuildKit step header "[builder 4/8] RUN npm ci"
  /^>\s/, // npm script echo "> next build", BuildKit "> [builder 5/8] RUN …:"
  /^\d+\s*\|/, // Dockerfile excerpt " 15 | >>> RUN npm run build"
  /^(?:RUN|COPY|ADD|FROM|WORKDIR|ENV|ARG|CMD|ENTRYPOINT|EXPOSE|USER)\s/, // echoed Dockerfile step
  /^(?:npm |yarn |pnpm )?warn(?:ing)?\b/i, // warnings appear in builds that pass
  /^at\s/, // JavaScript stack frame
  /^traceback \(most recent call last\)/i,
  /^file "[^"]*", line \d+/i, // Python stack frame
  /\b0 (?:errors?|failures?|vulnerabilities)\b/i,
];

/** Error lines that only say a step failed, not why: used only when nothing more specific is there. */
const GENERIC: RegExp[] = [
  /did not complete successfully|failed to solve/i, // BuildKit
  /^(?:docker build|remote deployment|deployment|build) failed:?$/i, // the worker's wrapper heading
  /^npm (?:err!|error)(?:\s*$|\s+(?:code (?:\d+|elifecycle)|errno|path|command|syscall|signal|lifecycle|a complete log)\b)/i,
  /^error:? command failed with exit code/i, // yarn
  /^elifecycle\b/i, // pnpm
];

function cleanLines(text: string | null | undefined): string[] {
  if (!text) return [];
  return text
    .replace(ANSI, '')
    .split('\n')
    .map((line) => line.replace(WORKER_TIMESTAMP, '').replace(BUILDKIT_PREFIX, '').trim())
    .filter((line) => line.length > 0);
}

function firstMatch(lines: string[], generic: boolean): string | undefined {
  return lines.find(
    (line) =>
      ERROR_LINE.test(line) &&
      !NOISE.some((p) => p.test(line)) &&
      GENERIC.some((p) => p.test(line)) === generic,
  );
}

/**
 * The first specific error line of the log, else of the raw error; then the first generic one
 * ("did not complete successfully"); then the raw error's first line. Null when there is nothing.
 */
export function firstErrorLine(
  logs: string | null | undefined,
  rawError?: string | null,
  mask: (text: string) => string = (text) => text,
): string | null {
  const logLines = cleanLines(logs);
  const errorLines = cleanLines(rawError);
  const line =
    firstMatch(logLines, false) ??
    firstMatch(errorLines, false) ??
    firstMatch(logLines, true) ??
    firstMatch(errorLines, true) ??
    errorLines[0];
  return line ? scrubSecrets(mask(line), FAILURE_SUMMARY_MAX_LENGTH) : null;
}
