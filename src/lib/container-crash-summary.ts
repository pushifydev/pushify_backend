import { extractLogTail } from './log-tail';

/** How many runtime log lines a start-up failure carries into the deployment record */
export const CRASH_LOG_LINES = 50;

/**
 * Exit state from `docker inspect -f '{{.State.Running}} {{.State.ExitCode}}'`.
 * The exit code only means something once the container has stopped; a running
 * (e.g. unhealthy) container reports 0, so it yields null.
 */
export function parseContainerExitState(inspectOutput: string): number | null {
  const [running, code] = inspectOutput.trim().split(/\s+/);
  if (running !== 'false' || !code || !/^-?\d+$/.test(code)) return null;
  return Number(code);
}

/**
 * Summary of a container that died or never became healthy after deploy, in the same
 * shape as the build failure summary (headline line, then the log tail) so it lands in
 * the deployment's errorMessage and the API returns it unchanged.
 * Secret masking happens where errorMessage is persisted (deployment worker).
 */
export function formatContainerCrashSummary(input: {
  headline: string;
  exitCode: number | null;
  logs: string | null | undefined;
  maxLines?: number;
}): string {
  const maxLines = input.maxLines ?? CRASH_LOG_LINES;
  const exitPart = input.exitCode === null ? '' : ` (exit code ${input.exitCode})`;
  const tail = extractLogTail(input.logs, maxLines);
  const body = tail
    ? `Runtime log (last ${maxLines} lines):\n${tail}`
    : 'The container produced no log output.';
  return `${input.headline}${exitPart}\n${body}`;
}
