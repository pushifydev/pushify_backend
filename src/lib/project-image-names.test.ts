import { describe, it, expect } from 'vitest';
import { projectImageRepos, imageRepoBelongsTo, projectImageReferenceFilters } from './project-image-names';

describe('project image names', () => {
  const repos = projectImageRepos('shop');

  it('covers both the remote (hyphen) and local (slash) naming', () => {
    expect(repos).toEqual(['pushify/shop', 'pushify-shop']);
  });

  it('matches the image and its preview builds only', () => {
    expect(imageRepoBelongsTo('pushify-shop', repos)).toBe(true);
    expect(imageRepoBelongsTo('pushify-shop-pr-12', repos)).toBe(true);
    expect(imageRepoBelongsTo('pushify/shop', repos)).toBe(true);
    expect(imageRepoBelongsTo('pushify/shop-pr-3', repos)).toBe(true);
    // A sibling project whose slug merely starts the same way is someone else's storage.
    expect(imageRepoBelongsTo('pushify-shop-v2', repos)).toBe(false);
    expect(imageRepoBelongsTo('pushify/shop2', repos)).toBe(false);
    expect(imageRepoBelongsTo('nginx', repos)).toBe(false);
  });

  it('produces docker reference filters for image + previews in both forms', () => {
    expect(projectImageReferenceFilters('shop')).toEqual([
      'pushify/shop', 'pushify/shop-pr-*', 'pushify-shop', 'pushify-shop-pr-*',
    ]);
  });
});
