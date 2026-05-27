import { describe, it, expect } from 'vitest';
import { getApiRequestsPerMinute } from './plans';

describe('getApiRequestsPerMinute', () => {
  it('returns plan limits matching public docs', () => {
    expect(getApiRequestsPerMinute('free')).toBe(60);
    expect(getApiRequestsPerMinute('hobby')).toBe(120);
    expect(getApiRequestsPerMinute('pro')).toBe(300);
    expect(getApiRequestsPerMinute('business')).toBe(600);
    expect(getApiRequestsPerMinute('enterprise')).toBe(-1);
  });
});
