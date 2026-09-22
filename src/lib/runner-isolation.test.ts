import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  applyRunnerIsolationCommand,
  runnerIsolationScript,
  RUNNER_APP_NETWORK,
  RUNNER_ISOLATION_SCRIPT_PATH,
} from './runner-isolation';

// The behaviour is checked for real in the e2e suite (shared runner case); these pin the rules.
describe('runnerIsolationScript', () => {
  const script = runnerIsolationScript();
  const rules = script.split('\n').filter((line) => line.startsWith('ipt '));

  it('is valid sh', () => {
    expect(() => execFileSync('sh', ['-n'], { input: script })).not.toThrow();
  });

  it('creates the apps network with inter-container traffic off', () => {
    expect(script).toContain(`docker network inspect ${RUNNER_APP_NETWORK} >/dev/null 2>&1 || docker network create`);
    expect(script).toContain('-o com.docker.network.bridge.name=pushify-apps0');
    expect(script).toContain('-o com.docker.network.bridge.enable_icc=false');
  });

  it("matches the apps' bridge, and the default bridge (builds) only while nothing foreign is on it", () => {
    expect(script).toContain('BRIDGES="pushify-apps0"');
    expect(script).toContain(`docker ps --filter network=bridge --format '{{.Names}}' 2>/dev/null | grep -v '^pushify-' || true`);
    expect(script).toContain('BRIDGES="$BRIDGES $DEFAULT_BRIDGE"');
    expect(script).toContain('ipt -D INPUT -i "$DEFAULT_BRIDGE" -j PUSHIFY-IN');
    expect(script).toContain('PUSHIFY_ISOLATION_BUILDS_SKIPPED');
    for (const rule of rules.filter((r) => /-[io] /.test(r) && !r.includes('DEFAULT_BRIDGE'))) {
      expect(rule).toMatch(/-[io] "\$b"/);
    }
  });

  it("covers marketplace apps' own networks — traffic inside one stays allowed — unless something foreign is on them", () => {
    expect(script).toContain('ipt -A PUSHIFY-FWD -i br-+ -o br-+ -j RETURN');
    expect(script).toContain('ipt -A PUSHIFY-FWD -i br-+ -d "$range" -j DROP');
    expect(script).toContain('ipt -C INPUT -i br-+ -j PUSHIFY-IN 2>/dev/null || ipt -I INPUT 1 -i br-+ -j PUSHIFY-IN');
    expect(script).toContain('ipt -D INPUT -i br-+ -j PUSHIFY-IN');
    expect(script).toContain('PUSHIFY_ISOLATION_APPNETS_SKIPPED');
    // inside-the-network RETURN comes before the private-range drops (the app's database is in 172.16/12)
    expect(script.indexOf('-i br-+ -o br-+ -j RETURN')).toBeLessThan(script.indexOf('-i br-+ -d "$range" -j DROP'));
  });

  it('rebuilds its own chains instead of appending duplicates', () => {
    expect(script).toContain('ipt -F PUSHIFY-FWD');
    expect(script).toContain('ipt -F PUSHIFY-IN');
    expect(script).toContain('ipt -C DOCKER-USER -j PUSHIFY-FWD 2>/dev/null || ipt -I DOCKER-USER 1 -j PUSHIFY-FWD');
    expect(script).toContain('ipt -C INPUT -i "$b" -j PUSHIFY-IN 2>/dev/null || ipt -I INPUT 1 -i "$b" -j PUSHIFY-IN');
  });

  it('lets replies through before any drop', () => {
    const fwd = rules.filter((line) => line.startsWith('ipt -A PUSHIFY-FWD'));
    expect(fwd[0]).toContain('--ctstate ESTABLISHED,RELATED -j RETURN');
    const input = rules.filter((line) => line.startsWith('ipt -A PUSHIFY-IN'));
    expect(input[0]).toContain('--ctstate ESTABLISHED,RELATED -j RETURN');
    expect(input[input.length - 1]).toBe('ipt -A PUSHIFY-IN -j DROP');
  });

  it('drops app → app and app → metadata/private ranges', () => {
    expect(script).toContain('ipt -A PUSHIFY-FWD -i "$b" -o "$b" -j DROP');
    expect(script).toContain('for range in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 169.254.0.0/16; do');
    expect(script).toContain('ipt -A PUSHIFY-FWD -i "$b" -d "$range" -j DROP');
  });

  it("leaves visitors' own connections alone — an app without a domain is served on <ip>:<port>", () => {
    expect(script).not.toContain('! -i');
  });

  it('only lets apps reach the host on 80/443', () => {
    expect(script).toContain('ipt -A PUSHIFY-IN -p tcp -m multiport --dports 80,443 -j RETURN');
  });
});

describe('applyRunnerIsolationCommand', () => {
  it('ships the script base64-encoded and runs it', () => {
    const cmd = applyRunnerIsolationCommand();
    expect(cmd).not.toContain('iptables -w');
    expect(cmd).toContain(`base64 -d > ${RUNNER_ISOLATION_SCRIPT_PATH}`);
    expect(cmd.endsWith(`${RUNNER_ISOLATION_SCRIPT_PATH} 2>&1`)).toBe(true);
  });
});
