import tls from 'node:tls';

/**
 * Certificates renew by themselves (certbot on each server) — until they don't: the domain's DNS
 * moved away, port 80 got blocked, a rate limit. Then the first sign used to be a browser warning
 * on the customer's site. A daily check reads what each domain actually serves and warns twice:
 * 14 days before expiry, and a last time 3 days before (or once it has expired).
 */

const DAY = 24 * 60 * 60 * 1000;
export const FIRST_WARNING_DAYS = 14;
export const FINAL_WARNING_DAYS = 3;

export type ExpiryWarning = 'first' | 'final';

/** Which warning is due now for a certificate expiring at `expiresAt`, given the last one sent. */
export function dueExpiryWarning(expiresAt: Date, notifiedAt: Date | null, now: Date = new Date()): ExpiryWarning | null {
  const left = expiresAt.getTime() - now.getTime();
  if (left > FIRST_WARNING_DAYS * DAY) return null;
  const sentBefore = (days: number) => !!notifiedAt && notifiedAt.getTime() >= expiresAt.getTime() - days * DAY;
  if (left <= FINAL_WARNING_DAYS * DAY) return sentBefore(FINAL_WARNING_DAYS) ? null : 'final';
  return sentBefore(FIRST_WARNING_DAYS) ? null : 'first';
}

export function daysLeft(expiresAt: Date, now: Date = new Date()): number {
  return Math.floor((expiresAt.getTime() - now.getTime()) / DAY);
}

/**
 * When the certificate `host` serves on 443 expires — whatever serves it (the server, a CDN in
 * front). null when nothing answers; never throws.
 */
export function servedCertificateExpiry(host: string, options: { port?: number; timeoutMs?: number } = {}): Promise<Date | null> {
  const { port = 443, timeoutMs = 8000 } = options;
  return new Promise((resolve) => {
    const socket = tls.connect({ host, port, servername: host, rejectUnauthorized: false, timeout: timeoutMs }, () => {
      const cert = socket.getPeerCertificate();
      socket.destroy();
      const expires = cert?.valid_to ? new Date(cert.valid_to) : null;
      resolve(expires && !Number.isNaN(expires.getTime()) ? expires : null);
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve(null);
    });
    socket.on('error', () => resolve(null));
  });
}
