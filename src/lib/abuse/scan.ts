import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AbuseReason } from '../../db/schema/abuse';
import type { AbuseRules } from './rules';

/**
 * Score a deploy against the Acceptable Use rules. Pure: callers hand in file text, the build
 * log (already secret-masked) and the image reference; nothing here touches the network.
 *
 * A rule counts once however often it matches, and reasons carry only where it matched — the
 * rule, a file and a line — never the text, so a flag can't leak what a repository contains.
 */

export interface ScanFile {
  path: string;
  content: string;
}

export interface ScanInput {
  files?: ScanFile[];
  /** File paths that exist but were not read (binaries, size limit) — still matched by `path` rules */
  otherPaths?: string[];
  buildLog?: string | null;
  image?: string | null;
}

export interface ScanResult {
  score: number;
  reasons: AbuseReason[];
  strong: number;
  medium: number;
  /** At or above the flag score with a strong signal, or two different medium ones */
  flagged: boolean;
  /** Eligible for automatic suspension (only acted on with ABUSE_AUTO_SUSPEND) */
  autoSuspend: boolean;
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

export function scanForAbuse(input: ScanInput, rules: AbuseRules): ScanResult {
  const reasons: AbuseReason[] = [];
  const files = input.files ?? [];

  for (const rule of rules.rules) {
    let hit: { file?: string; line?: number } | null = null;

    if (rule.target === 'content') {
      for (const f of files) {
        if (rule.files && !rule.files.test(f.path)) continue;
        const m = rule.pattern.exec(f.content);
        if (m) {
          hit = { file: f.path, line: lineOf(f.content, m.index) };
          break;
        }
      }
    } else if (rule.target === 'path') {
      const p = [...files.map((f) => f.path), ...(input.otherPaths ?? [])].find((x) => rule.pattern.test(x));
      if (p) hit = { file: p };
    } else if (rule.target === 'log') {
      const log = input.buildLog ?? '';
      const m = log ? rule.pattern.exec(log) : null;
      if (m) hit = { file: 'build log', line: lineOf(log, m.index) };
    } else if (rule.target === 'image') {
      if (input.image && rule.pattern.test(input.image)) hit = { file: 'image' };
    }

    if (hit) {
      reasons.push({ ruleId: rule.id, weight: rule.weight, strength: rule.strength, message: rule.message, ...hit });
    }
  }

  return scoreReasons(reasons, rules);
}

/** Turn reasons into a score and a decision. Used by deploy scans, runtime checks and merges. */
export function scoreReasons(reasons: AbuseReason[], rules: AbuseRules): ScanResult {
  const unique = new Map<string, AbuseReason>();
  for (const r of reasons) if (!unique.has(r.ruleId)) unique.set(r.ruleId, r);
  const list = [...unique.values()];

  const strong = list.filter((r) => r.strength === 'strong').length;
  const medium = list.filter((r) => r.strength === 'medium').length;
  const weak = Math.min(
    rules.policy.weakCap,
    list.filter((r) => r.strength === 'weak').reduce((s, r) => s + r.weight, 0),
  );
  const score = list.filter((r) => r.strength !== 'weak').reduce((s, r) => s + r.weight, 0) + weak;

  const enoughSignal = strong >= 1 || medium >= 2;
  const flagged = enoughSignal && score >= rules.policy.flagScore;
  const autoSuspend = strong >= 1 && score >= rules.policy.autoSuspendScore;

  // Strongest first, so the queue reads well
  const order = { strong: 0, medium: 1, weak: 2 } as const;
  list.sort((a, b) => order[a.strength] - order[b.strength] || b.weight - a.weight);
  return { score, reasons: list, strong, medium, flagged, autoSuspend };
}

/**
 * Read the text files of a checked-out repository within the rules' limits. Environment files,
 * keys and lockfiles are skipped by path before anything is opened.
 */
export async function readRepositoryForScan(root: string, rules: AbuseRules): Promise<Pick<ScanInput, 'files' | 'otherPaths'>> {
  const files: ScanFile[] = [];
  const otherPaths: string[] = [];
  let total = 0;
  let seen = 0;

  async function walk(dir: string): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (seen >= rules.scan.maxFiles || total >= rules.scan.maxTotalBytes) return;
      const abs = path.join(dir, entry.name);
      const rel = path.relative(root, abs).split(path.sep).join('/');
      if (rules.scan.skipPaths.test(rel)) continue;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      seen++;
      if (!rules.scan.textPaths.test(rel)) {
        otherPaths.push(rel);
        continue;
      }
      let size = 0;
      try {
        size = (await fs.stat(abs)).size;
      } catch {
        continue;
      }
      if (size > rules.scan.maxFileBytes || total + size > rules.scan.maxTotalBytes) {
        otherPaths.push(rel);
        continue;
      }
      try {
        files.push({ path: rel, content: await fs.readFile(abs, 'utf8') });
        total += size;
      } catch {
        otherPaths.push(rel);
      }
    }
  }

  await walk(root);
  return { files, otherPaths };
}
