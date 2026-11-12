import { describe, it, expect, vi, beforeEach } from 'vitest';

/** The scheduled security update email: a failure or a pending reboot, the health page, sent once. */
const h = vi.hoisted(() => ({ sent: [] as Array<{ to: string; subject: string; html: string }> }));

vi.mock('nodemailer', () => ({
  default: {
    createTransport: () => ({
      sendMail: async (mail: { to: string; subject: string; html: string }) => {
        h.sent.push(mail);
      },
    }),
  },
}));
vi.mock('../config/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config/env')>();
  return {
    ...actual,
    env: { ...actual.env, GMAIL_USER: 'alerts@pushify.test', GMAIL_APP_PASSWORD: 'x', FRONTEND_URL: 'https://app.pushify.test' },
  };
});

import { sendServerAutoPatchEmail } from './email';

const base = { orgName: 'Acme', serverName: 'web-1', serverId: 'srv-1' };

beforeEach(() => {
  h.sent = [];
});

describe('sendServerAutoPatchEmail', () => {
  it('a failure: says what failed, that nothing rebooted, links the health page and that it will not repeat', async () => {
    await sendServerAutoPatchEmail('owner@acme.test', {
      ...base,
      alert: 'failed',
      code: 'DOCKER_DEPENDENCY',
      error: 'Nothing was installed: these updates would also upgrade <containerd>',
    });
    expect(h.sent).toHaveLength(1);
    const { html, subject } = h.sent[0]!;
    expect(subject).toBe('Automatic security updates failed on web-1 (Acme)');
    expect(html).toContain('DOCKER_DEPENDENCY: Nothing was installed: these updates would also upgrade &lt;containerd&gt;');
    expect(html).toContain('The server was not rebooted and Docker / containerd were not touched.');
    expect(html).toContain('https://app.pushify.test/dashboard/servers/srv-1?tab=health');
    expect(html).toContain('This is the only email for this failure.');
  });

  it('a pending reboot: the run summary, that Pushify never reboots, and that it will not repeat', async () => {
    await sendServerAutoPatchEmail('owner@acme.test', {
      ...base,
      alert: 'reboot_required',
      summary: 'Installed 3 security updates (apt); reboot required',
    });
    const { html, subject } = h.sent[0]!;
    expect(subject).toBe('web-1 needs a reboot to finish security updates (Acme)');
    expect(html).toContain('Installed 3 security updates (apt); reboot required.');
    expect(html).toContain('Pushify never reboots a server');
    expect(html).toContain('/dashboard/servers/srv-1?tab=health');
    expect(html).toContain('This is the only email for this pending reboot.');
  });

  it('in Turkish too', async () => {
    await sendServerAutoPatchEmail('owner@acme.test', { ...base, alert: 'reboot_required', summary: null }, 'tr');
    const { html, subject } = h.sent[0]!;
    expect(subject).toBe('web-1 güvenlik güncellemelerini tamamlamak için yeniden başlatılmalı (Acme)');
    expect(html).toContain('Pushify sunucuyu asla kendisi yeniden başlatmaz');
    expect(html).toContain('Bekleyen bu yeniden başlatma için gönderilen tek e-posta budur.');
  });
});
