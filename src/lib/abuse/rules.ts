import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { env } from '../../config/env';

/**
 * The Acceptable Use rules live in config/abuse-rules.yaml, not in code: operators tune them
 * without a release. Every pattern is compiled here once, so a bad regex fails at load with the
 * rule's id instead of silently never matching.
 */

const regexSource = z.string().min(1).refine((s) => {
  try {
    new RegExp(s, 'im');
    return true;
  } catch {
    return false;
  }
}, 'invalid regular expression');

const ruleSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  strength: z.enum(['strong', 'medium', 'weak']),
  weight: z.number().int().min(0).max(200),
  target: z.enum(['content', 'path', 'log', 'image']),
  pattern: regexSource,
  files: regexSource.optional(),
  message: z.string().min(1).max(200),
});

const fileSchema = z.object({
  policy: z.object({
    flagScore: z.number().int().min(1),
    autoSuspendScore: z.number().int().min(1),
    weakCap: z.number().int().min(0),
  }),
  runtime: z.object({
    egressBytes24h: z.number().positive(),
    relayMinEgressBytes24h: z.number().positive(),
    relayRatio: z.number().min(0).max(1),
    connections: z.number().int().positive(),
    connectionsSustainedMinutes: z.number().int().positive(),
  }),
  scan: z.object({
    maxFileBytes: z.number().int().positive(),
    maxFiles: z.number().int().positive(),
    maxTotalBytes: z.number().int().positive(),
    skipPaths: regexSource,
    textPaths: regexSource,
  }),
  rules: z.array(ruleSchema).min(1),
});

export type AbuseRuleStrength = 'strong' | 'medium' | 'weak';

export interface CompiledAbuseRule {
  id: string;
  strength: AbuseRuleStrength;
  weight: number;
  target: 'content' | 'path' | 'log' | 'image';
  pattern: RegExp;
  files?: RegExp;
  message: string;
}

export interface AbuseRules {
  policy: z.infer<typeof fileSchema>['policy'];
  runtime: z.infer<typeof fileSchema>['runtime'];
  scan: { maxFileBytes: number; maxFiles: number; maxTotalBytes: number; skipPaths: RegExp; textPaths: RegExp };
  rules: CompiledAbuseRule[];
}

/** Parse and compile a rules document. Throws with every problem listed. */
export function compileAbuseRules(yamlText: string): AbuseRules {
  const parsed = fileSchema.safeParse(parseYaml(yamlText));
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid abuse rules: ${problems}`);
  }
  const doc = parsed.data;
  const ids = new Set<string>();
  for (const r of doc.rules) {
    if (ids.has(r.id)) throw new Error(`Invalid abuse rules: duplicate rule id "${r.id}"`);
    ids.add(r.id);
  }
  return {
    policy: doc.policy,
    runtime: doc.runtime,
    scan: {
      ...doc.scan,
      skipPaths: new RegExp(doc.scan.skipPaths, 'i'),
      textPaths: new RegExp(doc.scan.textPaths, 'i'),
    },
    rules: doc.rules.map((r) => ({
      ...r,
      // `m` so ^/$ work per line; no `g` — matching is stateless.
      pattern: new RegExp(r.pattern, 'im'),
      files: r.files ? new RegExp(r.files, 'i') : undefined,
    })),
  };
}

export function abuseRulesPath(): string {
  return env.ABUSE_RULES_PATH
    ? path.resolve(env.ABUSE_RULES_PATH)
    : path.resolve(process.cwd(), 'config', 'abuse-rules.yaml');
}

let cached: AbuseRules | null = null;

/** The rules in use, read once per process. */
export function loadAbuseRules(): AbuseRules {
  if (!cached) cached = compileAbuseRules(readFileSync(abuseRulesPath(), 'utf8'));
  return cached;
}
