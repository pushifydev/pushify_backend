import { describe, it, expect, vi, beforeEach } from 'vitest';

/** The disk alert email: free GB, where deploys stop, the health page, and that it is sent once. */
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

import { sendServerDiskEmail } from './email';

const details = {
  orgName: 'Acme',
  serverName: 'web-1',
  serverId: 'srv-1',
  usedPercent: 87,
  availGb: 5.2,
  critical: false,
  alertPercent: 85,
  deployBlockPercent: 90,
  deployMinFreeGb: 2,
};

beforeEach(() => {
  h.sent = [];
});

describe('sendServerDiskEmail', () => {
  it('says how much is free, where deploys stop, links the health page and that it will not repeat', async () => {
    await sendServerDiskEmail('owner@acme.test', details);
    expect(h.sent).toHaveLength(1);
    const { html, subject } = h.sent[0]!;
    expect(subject).toBe('web-1 disk is 87% full (Acme)');
    expect(html).toContain('5.2 GB left');
    expect(html).toContain('Deploys to this server stop at 90% used or when less than 2 GB is free.');
    expect(html).toContain('https://app.pushify.test/dashboard/servers/srv-1?tab=health');
    expect(html).toContain('only email for this crossing of the 85% alert threshold');
    expect(html).toContain('falls to 80% or below');
  });

  it('in Turkish too', async () => {
    await sendServerDiskEmail('owner@acme.test', details, 'tr');
    const { html } = h.sent[0]!;
    expect(html).toContain('5.2 GB kaldı');
    expect(html).toContain("deploy'lar disk %90 dolduğunda ya da 2 GB'tan az yer kaldığında durur");
    expect(html).toContain('/dashboard/servers/srv-1?tab=health');
    expect(html).toContain('%80 ya da altına inip');
  });
});
