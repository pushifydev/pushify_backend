/**
 * Install the certificate for auto subdomains (*.PREVIEW_BASE_URL) on the shared runners, over
 * the same SSH connection deploys use — no root password or separate SSH access needed.
 *
 *   npx tsx scripts/install-wildcard-cert.ts <certificate.pem> <private-key.pem> [serverId …]
 *
 * Without server ids it installs on every runner in PUSHIFY_RUNNER_SERVER_IDS. The files land in
 * WILDCARD_SSL_PATH (fullchain.pem 644, privkey.pem 600) — where deploys look for them — after
 * checking locally that the key belongs to the certificate and the certificate covers
 * *.PREVIEW_BASE_URL. Works with a Cloudflare Origin certificate or a Let's Encrypt wildcard.
 * The key is never printed. Run on the API host (same .env); delete the local key file after.
 */
import { readFileSync } from 'node:fs';
import { X509Certificate, createPrivateKey } from 'node:crypto';
import { inArray } from 'drizzle-orm';
import { db, closeDatabasePool } from '../src/db';
import { servers } from '../src/db/schema/servers';
import { env } from '../src/config/env';
import { decrypt } from '../src/lib/encryption';
import { SSHClient } from '../src/utils/ssh';

async function main() {
  const [certPath, keyPath, ...serverArgs] = process.argv.slice(2);
  if (!certPath || !keyPath) {
    console.error('Usage: npx tsx scripts/install-wildcard-cert.ts <certificate.pem> <private-key.pem> [serverId …]');
    process.exit(1);
  }
  const base = env.PREVIEW_BASE_URL;
  if (!base) throw new Error('PREVIEW_BASE_URL is not set');
  const dir = env.WILDCARD_SSL_PATH || `/etc/letsencrypt/live/${base}`;

  const certPem = readFileSync(certPath, 'utf8');
  const keyPem = readFileSync(keyPath, 'utf8');
  const cert = new X509Certificate(certPem);
  if (!cert.checkPrivateKey(createPrivateKey(keyPem))) {
    throw new Error('The private key does not belong to this certificate');
  }
  const names = (cert.subjectAltName || '').split(',').map((n) => n.trim().replace(/^DNS:/, ''));
  if (!names.includes(`*.${base}`)) {
    throw new Error(`The certificate does not cover *.${base} (it covers: ${names.join(', ') || 'nothing'})`);
  }
  console.log(`Certificate: ${names.join(', ')} — valid until ${cert.validTo}`);

  const ids = serverArgs.length
    ? serverArgs
    : (env.PUSHIFY_RUNNER_SERVER_IDS || env.PUSHIFY_RUNNER_SERVER_ID || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0) throw new Error('No server ids given and PUSHIFY_RUNNER_SERVER_IDS is empty');
  const targets = await db.select().from(servers).where(inArray(servers.id, ids));

  let failed = 0;
  for (const server of targets) {
    const label = `${server.name} (${server.ipv4})`;
    if (!server.ipv4 || !server.sshPrivateKey) {
      console.error(`✗ ${label}: no SSH access configured`);
      failed++;
      continue;
    }
    const ssh = new SSHClient();
    try {
      await ssh.connect({ host: server.ipv4, username: 'root', privateKey: decrypt(server.sshPrivateKey) });
      await ssh.exec(`mkdir -p ${dir} && chmod 755 ${dir}`);
      await ssh.uploadFile(certPem, `${dir}/fullchain.pem`);
      await ssh.uploadFile(keyPem, `${dir}/privkey.pem`);
      await ssh.exec(`chmod 644 ${dir}/fullchain.pem && chmod 600 ${dir}/privkey.pem`);
      const check = await ssh.exec(`openssl x509 -in ${dir}/fullchain.pem -noout -enddate && nginx -t 2>&1 | tail -1`);
      console.log(`✓ ${label}: installed in ${dir} — ${check.stdout.trim().replace(/\n/g, ' · ')}`);
    } catch (err) {
      console.error(`✗ ${label}: ${err instanceof Error ? err.message : String(err)}`);
      failed++;
    } finally {
      ssh.disconnect();
    }
  }
  for (const id of ids.filter((id) => !targets.some((t) => t.id === id))) {
    console.error(`✗ ${id}: no such server`);
    failed++;
  }
  if (failed) process.exitCode = 1;
  else console.log('Done. The next deploy on these servers creates auto subdomains.');
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closeDatabasePool());
