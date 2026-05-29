/** Last N non-empty lines from build/deploy logs for failure notifications */
export function extractLogTail(logs: string | null | undefined, maxLines = 20): string | undefined {
  if (!logs?.trim()) return undefined;

  const lines = logs.split('\n').map((l) => l.trimEnd()).filter((l) => l.length > 0);
  if (lines.length === 0) return undefined;

  const tail = lines.slice(-maxLines).join('\n');
  const maxChars = 4000;
  if (tail.length <= maxChars) return tail;
  return `…\n${tail.slice(-maxChars)}`;
}
