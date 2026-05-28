import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('STRIPE_PRICE_IDS env overrides', () => {
  const envBackup = { ...process.env };

  afterEach(() => {
    process.env = { ...envBackup };
  });

  beforeEach(() => {
    vi.resetModules();
  });

  it('uses env price IDs when set', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
    process.env.STRIPE_PRICE_HOBBY_MONTHLY = 'price_live_hobby_m';
    process.env.STRIPE_PRICE_PRO_MONTHLY = 'price_live_pro_m';
    process.env.STRIPE_PRICE_PRO_YEARLY = 'price_live_pro_y';

    const { STRIPE_PRICE_IDS, getPriceId } = await import('./stripe');

    expect(STRIPE_PRICE_IDS.hobby?.monthly).toBe('price_live_hobby_m');
    expect(getPriceId('pro', 'yearly')).toBe('price_live_pro_y');
  });
});
