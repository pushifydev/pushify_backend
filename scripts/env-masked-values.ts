/**
 * READ-ONLY: environment variables whose stored value looks like a masked secret (`ab****yz` or
 * `****`). Before beta.94, `pushify env pull` followed by `pushify env push` replaced a secret with
 * its masked copy; this lists the variables that may have been hit, by project and key — never the
 * values. Nothing is changed.
 *
 *   npm run env:masked-values
 *
 * Run on the API host (it reads the PRODUCTION database and decrypts with its ENCRYPTION_KEY).
 * Note: isSecret itself was never reset by that path (drizzle leaves an undefined field alone), so
 * the flag still marks which of these were secrets.
 */
import { eq } from 'drizzle-orm';
import { db, closeDatabasePool } from '../src/db';
import { environmentVariables, organizations, projects } from '../src/db/schema';
import { decrypt } from '../src/lib/encryption';

const MASKED = /^(?:[\s\S]{2}\*{4}[\s\S]{2}|\*{4})$/;

async function main() {
  const rows = await db
    .select({
      key: environmentVariables.key,
      environment: environmentVariables.environment,
      isSecret: environmentVariables.isSecret,
      valueEncrypted: environmentVariables.valueEncrypted,
      updatedAt: environmentVariables.updatedAt,
      project: projects.slug,
      org: organizations.name,
    })
    .from(environmentVariables)
    .innerJoin(projects, eq(projects.id, environmentVariables.projectId))
    .innerJoin(organizations, eq(organizations.id, projects.organizationId));

  const hits = rows.filter((r) => {
    try {
      return MASKED.test(decrypt(r.valueEncrypted));
    } catch {
      return false;
    }
  });
  const secret = hits.filter((h) => h.isSecret).length;
  console.log(`Variables checked: ${rows.length}`);
  console.log(`Values that look masked: ${hits.length} (${secret} marked secret, ${hits.length - secret} not)`);
  for (const h of hits) {
    console.log(`  ${h.org} / ${h.project}  ${h.environment}  ${h.key}  ${h.isSecret ? 'secret' : 'plain'}  updated ${h.updatedAt.toISOString().slice(0, 10)}`);
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closeDatabasePool());
