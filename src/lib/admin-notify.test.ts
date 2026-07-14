import { describe, it, expect } from 'vitest';
import { parseAdminNotifyEmails, buildAdminEmailContent } from './admin-notify';

describe('parseAdminNotifyEmails', () => {
  it('parses a comma-separated list with whitespace', () => {
    expect(parseAdminNotifyEmails('a@x.dev, b@y.dev ,c@z.dev')).toEqual([
      'a@x.dev',
      'b@y.dev',
      'c@z.dev',
    ]);
  });

  it('returns empty for unset/blank values', () => {
    expect(parseAdminNotifyEmails('')).toEqual([]);
    expect(parseAdminNotifyEmails('  ,  ')).toEqual([]);
  });

  it('drops entries that are not email-shaped', () => {
    expect(parseAdminNotifyEmails('a@x.dev, notanemail, @, b@y.dev')).toEqual([
      'a@x.dev',
      'b@y.dev',
    ]);
  });
});

describe('buildAdminEmailContent', () => {
  it('builds subject/html/text with fields and escapes HTML', () => {
    const { subject, html, text } = buildAdminEmailContent('user.registered', {
      user: 'x@y.dev',
      name: '<script>alert(1)</script>',
      org: "Acme's Team",
      skipped: undefined,
    });
    expect(subject).toBe('[Pushify] New user registered');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('x@y.dev');
    expect(html).not.toContain('skipped');
    expect(text).toContain('user: x@y.dev');
    expect(text).toContain('Event: user.registered');
  });
});
