import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { compileAbuseRules } from './rules';
import { readRepositoryForScan, scanForAbuse, type ScanFile } from './scan';

const rules = compileAbuseRules(readFileSync(path.resolve(__dirname, '../../../config/abuse-rules.yaml'), 'utf8'));

// The shape of the app that prompted this: FastAPI relaying VLESS over WebSocket/XHTTP, an
// MTProxy build in the Dockerfile, Xray fetched at runtime and an IP/SNI scanner.
const spiderPanelLike: ScanFile[] = [
  {
    path: 'Dockerfile',
    content: [
      'FROM python:3.12-slim',
      'RUN git clone https://github.com/TelegramMessenger/MTProxy && cd MTProxy && make',
      'COPY . /app',
      'CMD ["uvicorn", "main:app"]',
    ].join('\n'),
  },
  {
    path: 'app/main.py',
    content: [
      'from fastapi import FastAPI, WebSocket',
      '@app.websocket("/ws/{uuid}")',
      'async def relay(ws: WebSocket, uuid: str): ...',
      'XRAY_URL = "https://github.com/XTLS/Xray-core/releases/latest/download/Xray-linux-64.zip"',
      'def share_link(u): return f"vless://{u}@{host}:443?type=ws"',
    ].join('\n'),
  },
  { path: 'app/scanner.py', content: 'def sni_scan(ranges): ...' },
];

const benign: Record<string, ScanFile[]> = {
  'chat app with websockets': [
    { path: 'server.js', content: "const io = require('socket.io')(server);\nio.on('connection', (s) => s.emit('hi'));" },
    { path: 'package.json', content: '{"dependencies":{"socket.io":"^4.7.0","express":"^4.19.0"}}' },
  ],
  'next.js app with a dev proxy': [
    { path: 'next.config.js', content: "module.exports = { async rewrites() { return [{ source: '/api/:p*', destination: 'http://localhost:4000/:p*' }] } } // proxy" },
    { path: 'package.json', content: '{"dependencies":{"next":"15","http-proxy-middleware":"^3.0.0","socks-proxy-agent":"^8.0.0"}}' },
  ],
  'nginx reverse proxy config': [
    { path: 'nginx.conf', content: 'location / { proxy_pass http://app:3000; proxy_set_header Upgrade $http_upgrade; }' },
  ],
  'fastapi websocket chat': [
    { path: 'main.py', content: 'from fastapi import WebSocket\n@app.websocket("/ws/chat")\nasync def chat(ws: WebSocket): ...' },
  ],
};

describe('abuse rules file', () => {
  it('loads, compiles every pattern and has unique ids', () => {
    expect(rules.rules.length).toBeGreaterThan(10);
    expect(new Set(rules.rules.map((r) => r.id)).size).toBe(rules.rules.length);
  });

  it('rejects a bad pattern by naming it', () => {
    expect(() =>
      compileAbuseRules(`
policy: { flagScore: 40, autoSuspendScore: 120, weakCap: 10 }
runtime: { egressBytes24h: 1, relayMinEgressBytes24h: 1, relayRatio: 0.8, connections: 1, connectionsSustainedMinutes: 1 }
scan: { maxFileBytes: 1, maxFiles: 1, maxTotalBytes: 1, skipPaths: 'x', textPaths: 'y' }
rules:
  - { id: broken, strength: strong, weight: 1, target: content, pattern: '(', message: m }
`),
    ).toThrow(/rules\.0\.pattern/);
  });
});

describe('scanForAbuse', () => {
  it('flags a SpiderPanel-like app with strong reasons and file/line locations', () => {
    const result = scanForAbuse({ files: spiderPanelLike }, rules);
    expect(result.flagged).toBe(true);
    const ids = result.reasons.map((r) => r.ruleId);
    expect(ids).toEqual(expect.arrayContaining(['mtproxy', 'xray-core', 'proxy-share-uri', 'tunnel-routes', 'ip-sni-scanner']));
    expect(result.reasons.find((r) => r.ruleId === 'mtproxy')).toMatchObject({ file: 'Dockerfile', line: 2 });
    // Strongest first
    expect(result.reasons[0].strength).toBe('strong');
  });

  it('never stores the matched text, only where it matched', () => {
    const result = scanForAbuse({ files: spiderPanelLike }, rules);
    const serialized = JSON.stringify(result.reasons);
    expect(serialized).not.toContain('vless://{u}');
    expect(serialized).not.toContain('Xray-linux-64.zip');
  });

  for (const [name, files] of Object.entries(benign)) {
    it(`does not flag an ordinary app: ${name}`, () => {
      const result = scanForAbuse({ files }, rules);
      expect(result.flagged).toBe(false);
      expect(result.strong).toBe(0);
    });
  }

  it('weak signals alone never flag, however many there are', () => {
    const files = Array.from({ length: 20 }, (_, i) => ({
      path: `f${i}.js`,
      content: 'new WebSocket(url); // proxy NET_ADMIN',
    }));
    const result = scanForAbuse({ files }, rules);
    expect(result.flagged).toBe(false);
    expect(result.score).toBeLessThanOrEqual(rules.policy.weakCap);
  });

  it('one medium signal is not enough; two different ones are', () => {
    const one = scanForAbuse({ files: [{ path: 'scan.sh', content: 'masscan -p1-65535 10.0.0.0/8' }] }, rules);
    expect(one.flagged).toBe(false);
    const two = scanForAbuse(
      {
        files: [
          { path: 'scan.sh', content: 'masscan -p1-65535 10.0.0.0/8' },
          { path: 'Dockerfile', content: 'RUN apt-get install -y microsocks' },
        ],
      },
      rules,
    );
    expect(two.flagged).toBe(true);
  });

  it('scans the build log and image references too', () => {
    expect(scanForAbuse({ buildLog: 'Step 5/9\nXray 1.8.24 (Xray, Penetrates Everything.)' }, rules).flagged).toBe(true);
    expect(scanForAbuse({ image: 'teddysun/xray:latest' }, rules).flagged).toBe(true);
    expect(scanForAbuse({ image: 'nginx:1.27' }, rules).flagged).toBe(false);
  });

  it('marks auto-suspend only for a strong, high score', () => {
    expect(scanForAbuse({ files: spiderPanelLike }, rules).autoSuspend).toBe(true);
    expect(scanForAbuse({ image: 'teddysun/xray:latest' }, rules).autoSuspend).toBe(false);
  });
});

describe('readRepositoryForScan', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reads source files but never env files, keys, lockfiles or node_modules', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'abuse-scan-'));
    mkdirSync(path.join(dir, 'node_modules/x'), { recursive: true });
    mkdirSync(path.join(dir, 'src'));
    writeFileSync(path.join(dir, 'Dockerfile'), 'FROM node:22');
    writeFileSync(path.join(dir, 'src/index.ts'), 'console.log(1)');
    writeFileSync(path.join(dir, '.env'), 'SECRET=vless://should-never-be-read');
    writeFileSync(path.join(dir, '.env.production'), 'X=1');
    writeFileSync(path.join(dir, 'server.key'), 'KEY');
    writeFileSync(path.join(dir, 'package-lock.json'), '{}');
    writeFileSync(path.join(dir, 'node_modules/x/index.js'), 'vless://');
    writeFileSync(path.join(dir, 'logo.png'), 'PNG');

    const { files, otherPaths } = await readRepositoryForScan(dir, rules);
    expect(files!.map((f) => f.path).sort()).toEqual(['Dockerfile', 'src/index.ts']);
    expect(otherPaths).toEqual(['logo.png']);
    expect(scanForAbuse({ files, otherPaths }, rules).reasons).toEqual([]);
  });
});
