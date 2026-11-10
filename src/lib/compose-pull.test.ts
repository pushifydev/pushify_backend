import { describe, it, expect } from 'vitest';
import { composePullArgs, normalizeComposePullPolicy, pulledImages } from './compose-pull';

describe('compose pull policy', () => {
  it('always pulls every image; missing passes --policy missing', () => {
    expect(composePullArgs('always')).toBe('pull --ignore-pull-failures');
    expect(composePullArgs('missing')).toBe('pull --policy missing --ignore-pull-failures');
  });

  it('anything unknown behaves like always (the behaviour before the setting existed)', () => {
    expect(normalizeComposePullPolicy('missing')).toBe('missing');
    expect(normalizeComposePullPolicy('always')).toBe('always');
    for (const value of [undefined, null, '', 'never', 'MISSING']) {
      expect(normalizeComposePullPolicy(value)).toBe('always');
    }
  });
});

describe('pulledImages', () => {
  it('lists images that are new on the server or whose ID changed, sorted', () => {
    expect(
      pulledImages(
        { 'redis:latest': 'sha256:r1', 'postgres:16': null, 'nginx:1.27': 'sha256:n1', 'shop-web': null },
        { 'redis:latest': 'sha256:r2', 'postgres:16': 'sha256:p1', 'nginx:1.27': 'sha256:n1', 'shop-web': null }
      )
    ).toEqual([
      { image: 'postgres:16', change: 'new' },
      { image: 'redis:latest', change: 'updated' },
    ]);
  });

  it('is empty when nothing changed', () => {
    expect(pulledImages({ 'redis:7': 'sha256:r1' }, { 'redis:7': 'sha256:r1' })).toEqual([]);
  });
});
