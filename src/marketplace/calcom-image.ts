import { createHash } from 'crypto';

/** Docker tag for a Cal.com image built with the correct NEXT_PUBLIC_WEBAPP_URL. */
export function calcomImageTag(publicUrl: string): string {
  const hash = createHash('sha256').update(publicUrl).digest('hex').slice(0, 12);
  return `pushify-calcom:${hash}`;
}

/** Shell script run on the server to build Cal.com when the Hub image URL mismatch breaks the app. */
export function buildCalcomImageScript(params: {
  projectDir: string;
  publicUrl: string;
  imageTag: string;
  nextAuthSecret: string;
  encryptionKey: string;
}): string {
  const { projectDir, publicUrl, imageTag, nextAuthSecret, encryptionKey } = params;
  const esc = (s: string) => s.replace(/'/g, "'\\''");
  return `#!/bin/bash
set -euo pipefail
cd '${esc(projectDir)}'
if docker image inspect '${esc(imageTag)}' >/dev/null 2>&1; then
  echo "Cal.com image ${esc(imageTag)} already exists"
  exit 0
fi
echo "Cloning Cal.com source (shallow)..."
rm -rf calcom-src
git clone --depth 1 https://github.com/calcom/cal.com.git calcom-src
cd calcom-src
export DOCKER_BUILDKIT=1
echo "Building Cal.com for ${esc(publicUrl)} (15–30 min)..."
docker build \\
  --build-arg NEXT_PUBLIC_WEBAPP_URL='${esc(publicUrl)}' \\
  --build-arg NEXT_PUBLIC_LICENSE_CONSENT=agree \\
  --build-arg CALCOM_TELEMETRY_DISABLED=1 \\
  --build-arg ORGANIZATIONS_ENABLED=false \\
  --build-arg NEXTAUTH_SECRET='${esc(nextAuthSecret)}' \\
  --build-arg CALENDSO_ENCRYPTION_KEY='${esc(encryptionKey)}' \\
  --build-arg DATABASE_URL='postgresql://calcom:build@database:5432/calendso' \\
  --build-arg DATABASE_DIRECT_URL='postgresql://calcom:build@database:5432/calendso' \\
  -t '${esc(imageTag)}' \\
  -f Dockerfile .
docker run --rm '${esc(imageTag)}' printenv BUILT_NEXT_PUBLIC_WEBAPP_URL || true
echo "Cal.com image build finished: ${esc(imageTag)}"
`;
}
