import { describe, it, expect } from 'vitest';
import { previewHostname, previewDeploySlug, buildPreviewTeardownScript } from './preview-remote';
import { buildRemoteTeardownScript } from './project-remote-cleanup';

describe('previewHostname', () => {
  it('extracts the vhost name from a preview URL', () => {
    expect(previewHostname('https://pr-42-shop.pushify.dev')).toBe('pr-42-shop.pushify.dev');
    expect(previewHostname('https://pr-42-shop.pushify.dev/some/path')).toBe('pr-42-shop.pushify.dev');
  });

  it('is null for the localhost placeholder and garbage', () => {
    expect(previewHostname('http://localhost/preview/shop/pr-42')).toBeNull();
    expect(previewHostname('not a url')).toBeNull();
    expect(previewHostname(null)).toBeNull();
  });
});

describe('buildPreviewTeardownScript', () => {
  const script = buildPreviewTeardownScript('shop', 42);

  it('keys everything by the preview deploy slug', () => {
    expect(previewDeploySlug('shop', 42)).toBe('shop-pr-42');
  });

  it('removes only that PR\'s containers — not PR 4, not production', () => {
    expect(script).toContain("grep -E '^pushify-shop-pr-42(-|$)|^pushify-preview-shop-pr-42$'");
    const re = new RegExp('^pushify-shop-pr-42(-|$)|^pushify-preview-shop-pr-42$');
    expect(re.test('pushify-shop-pr-42')).toBe(true);
    expect(re.test('pushify-shop-pr-42-blue')).toBe(true);
    expect(re.test('pushify-preview-shop-pr-42')).toBe(true);
    expect(re.test('pushify-shop-pr-4')).toBe(false);
    expect(re.test('pushify-shop-pr-420')).toBe(false);
    expect(re.test('pushify-shop')).toBe(false);
  });

  it('removes the preview image in both naming forms', () => {
    expect(script).toContain("--filter=reference='pushify-shop-pr-42'");
    expect(script).toContain("--filter=reference='pushify/shop-pr-42'");
  });

  it('removes the preview vhost and reloads nginx', () => {
    expect(script).toContain('/etc/nginx/sites-enabled/pushify-shop-pr-42');
    expect(script).toContain('/etc/nginx/sites-available/pushify-shop-pr-42');
    expect(script).toContain('/opt/pushify/nginx/pushify-shop-pr-42.conf');
    expect(script).toContain('nginx -s reload');
  });

  it('refuses slugs and PR numbers that could escape the shell', () => {
    expect(() => buildPreviewTeardownScript('shop; rm -rf /', 1)).toThrow();
    expect(() => buildPreviewTeardownScript('shop', 0)).toThrow();
    expect(() => buildPreviewTeardownScript('shop', 1.5)).toThrow();
  });
});

describe('project teardown also drops the nginx vhosts the deployer writes', () => {
  const script = buildRemoteTeardownScript('shop', false);

  it('removes the production auto-subdomain site and every PR preview site', () => {
    expect(script).toContain('/etc/nginx/sites-enabled/pushify-shop ');
    expect(script).toContain('/etc/nginx/sites-enabled/pushify-shop-pr-*');
    expect(script).toContain('/etc/nginx/sites-available/pushify-shop-pr-*');
    expect(script).toContain('/opt/pushify/nginx/pushify-shop-pr-*.conf');
  });
});
