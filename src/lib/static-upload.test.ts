import { describe, it, expect } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import {
  collectSiteFiles,
  entriesFromZip,
  normalizeUploadPath,
  packSiteFiles,
  unpackSiteFiles,
  StaticUploadError,
  shellQuote,
} from './static-upload';

const f = (path: string, text = 'x') => ({ path, content: strToU8(text) });

describe('normalizeUploadPath', () => {
  it('keeps ordinary paths, including non-ASCII names', () => {
    expect(normalizeUploadPath('css/site.css')).toBe('css/site.css');
    expect(normalizeUploadPath('./hakkımızda.html')).toBe('hakkımızda.html');
    expect(normalizeUploadPath('img\\logo (1).png')).toBe('img/logo (1).png');
  });

  it('skips hidden files and OS junk', () => {
    expect(normalizeUploadPath('.git/config')).toBeNull();
    expect(normalizeUploadPath('.env')).toBeNull();
    expect(normalizeUploadPath('site/.DS_Store')).toBeNull();
    expect(normalizeUploadPath('__MACOSX/index.html')).toBeNull();
  });

  it('refuses paths that escape or carry shell characters', () => {
    expect(() => normalizeUploadPath('../etc/passwd')).toThrow(StaticUploadError);
    expect(() => normalizeUploadPath('a/../../b')).toThrow(StaticUploadError);
    expect(() => normalizeUploadPath('x$(reboot).html')).toThrow(StaticUploadError);
    expect(() => normalizeUploadPath("it's.html")).toThrow(StaticUploadError);
  });

  it('treats leading slashes as relative', () => {
    expect(normalizeUploadPath('/index.html')).toBe('index.html');
  });
});

describe('collectSiteFiles', () => {
  it('requires index.html at the root', () => {
    expect(() => collectSiteFiles([f('about.html')])).toThrow(/index\.html/);
  });

  it('unwraps a single top folder', () => {
    const files = collectSiteFiles([f('my-site/index.html'), f('my-site/css/a.css')]);
    expect(files.map((x) => x.path)).toEqual(['css/a.css', 'index.html']);
  });

  it('does not unwrap when the root already has index.html', () => {
    const files = collectSiteFiles([f('index.html'), f('docs/index.html')]);
    expect(files.map((x) => x.path)).toEqual(['docs/index.html', 'index.html']);
  });

  it('drops hidden files', () => {
    const files = collectSiteFiles([f('index.html'), f('.git/config'), f('.env')]);
    expect(files.map((x) => x.path)).toEqual(['index.html']);
  });

  it('refuses an empty upload', () => {
    expect(() => collectSiteFiles([f('.DS_Store')])).toThrow(/No files/);
  });

  it('refuses a site over the size limit', () => {
    const big = { path: 'index.html', content: new Uint8Array(26 * 1024 * 1024) };
    expect(() => collectSiteFiles([big])).toThrow(/25 MB/);
  });
});

describe('zips', () => {
  it('reads a zip and round-trips through the stored form', () => {
    const zip = zipSync({ 'site/index.html': strToU8('<h1>hi</h1>'), 'site/a.css': strToU8('body{}') });
    const files = collectSiteFiles(entriesFromZip(zip));
    const back = unpackSiteFiles(packSiteFiles(files));
    expect(back.map((x) => x.path).sort()).toEqual(['a.css', 'index.html']);
    expect(new TextDecoder().decode(back.find((x) => x.path === 'index.html')!.content)).toBe('<h1>hi</h1>');
  });

  it('refuses something that is not a zip', () => {
    expect(() => entriesFromZip(strToU8('not a zip'))).toThrow(/valid zip/);
  });
});

describe('shellQuote', () => {
  it('quotes single quotes', () => {
    expect(shellQuote("a'b")).toBe(`'a'\\''b'`);
  });
});

describe('staticSiteKey', () => {
  it('keeps the slug for Site Studio sites and adds the project id for uploads', async () => {
    const { staticSiteKey } = await import('./static-upload');
    const id = '3c6c924f-7aec-4768-a49e-8b4596763153';
    expect(staticSiteKey({ id, slug: 'site', settings: { static: true } })).toBe('site');
    expect(staticSiteKey({ id, slug: 'site', settings: { static: true, staticSource: 'upload' } })).toBe('site-3c6c924f');
  });
});
