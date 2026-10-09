import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { compileAbuseRules } from './rules';
import { scoreReasons } from './scan';
import { ConnectionTracker, connectionCountCommand, evaluateRuntime, parseConnectionCounts } from './runtime';

const rules = compileAbuseRules(readFileSync(path.resolve(__dirname, '../../../config/abuse-rules.yaml'), 'utf8'));
const GIB = 1024 ** 3;

describe('evaluateRuntime', () => {
  it('a busy but ordinary site (high egress, little ingress) is one medium signal — not flagged', () => {
    const reasons = evaluateRuntime({ egressBytes: 80 * GIB, ingressBytes: 2 * GIB, connectionsSustained: false, connectionCount: 40 }, rules);
    expect(reasons.map((r) => r.ruleId)).toEqual(['runtime-egress']);
    expect(scoreReasons(reasons, rules).flagged).toBe(false);
  });

  it('a relay (in ≈ out, high volume) with many long-lived connections is flagged', () => {
    const reasons = evaluateRuntime({ egressBytes: 60 * GIB, ingressBytes: 58 * GIB, connectionsSustained: true, connectionCount: 450 }, rules);
    expect(reasons.map((r) => r.ruleId).sort()).toEqual(['runtime-connections', 'runtime-egress', 'runtime-relay']);
    expect(scoreReasons(reasons, rules).flagged).toBe(true);
  });

  it('many websocket connections alone are not enough', () => {
    const reasons = evaluateRuntime({ egressBytes: 1 * GIB, ingressBytes: 1 * GIB, connectionsSustained: true, connectionCount: 900 }, rules);
    expect(reasons.map((r) => r.ruleId)).toEqual(['runtime-connections']);
    expect(scoreReasons(reasons, rules).flagged).toBe(false);
  });
});

describe('ConnectionTracker', () => {
  it('counts as sustained only after the whole window above the threshold', () => {
    const t = new ConnectionTracker();
    const min = 60_000;
    expect(t.record('p', 300, 200, 30 * min, 0)).toBe(false);
    expect(t.record('p', 300, 200, 30 * min, 20 * min)).toBe(false);
    expect(t.record('p', 300, 200, 30 * min, 30 * min)).toBe(true);
    // A dip resets the clock
    expect(t.record('p', 10, 200, 30 * min, 31 * min)).toBe(false);
    expect(t.record('p', 300, 200, 30 * min, 32 * min)).toBe(false);
  });
});

describe('connection counting command', () => {
  it('parses counts per container and sums replicas by name', () => {
    const counts = parseConnectionCounts('pushify-shop-blue 12\npushify-shop-blue-2 30\ngarbage\n');
    expect(counts.get('pushify-shop-blue')).toBe(12);
    expect(counts.get('pushify-shop-blue-2')).toBe(30);
    expect(counts.size).toBe(2);
  });

  it('only matches app containers of safe slugs and prints counts, never connection lines', () => {
    const cmd = connectionCountCommand(['shop', 'bad;rm -rf /']);
    expect(cmd).toContain("'^pushify-(shop)(-(blue|green)(-[0-9]+)?)?$'");
    expect(cmd).not.toContain('rm -rf');
    expect(cmd).toContain('| wc -l');
    expect(connectionCountCommand([])).toBe('true');
  });
});
