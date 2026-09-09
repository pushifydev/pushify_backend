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

  it('still maps legacy (built-in) price IDs to plans when env overrides are set', async () => {
    // Price-change migration safety: subscribers created on the old prices keep
    // renewing on those price IDs — their webhooks must still resolve to a plan.
    process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
    process.env.STRIPE_PRICE_HOBBY_MONTHLY = 'price_new_hobby_15';
    process.env.STRIPE_PRICE_PRO_MONTHLY = 'price_new_pro_29';

    const { getPlanFromPriceId } = await import('./stripe');

    expect(getPlanFromPriceId('price_new_hobby_15')).toBe('hobby');
    expect(getPlanFromPriceId('price_1TDiioC34JPtjVa9kZjFTYVF')).toBe('hobby'); // legacy $10
    expect(getPlanFromPriceId('price_1TDijQC34JPtjVa9IfxvjlPe')).toBe('pro'); // legacy $25
    expect(getPlanFromPriceId('price_unknown')).toBeNull();
  });

  it('resolves retired price IDs listed in STRIPE_PRICE_*_LEGACY env vars', async () => {
    // Production's old prices are account-specific (not the built-in defaults) — after
    // the env swap they must still map via the LEGACY vars, monthly and yearly alike.
    process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
    process.env.STRIPE_PRICE_HOBBY_MONTHLY = 'price_new_hobby_m';
    process.env.STRIPE_PRICE_HOBBY_LEGACY = 'price_old_hobby_m, price_old_hobby_y';
    process.env.STRIPE_PRICE_PRO_LEGACY = 'price_old_pro_m';

    const { getPlanFromPriceId } = await import('./stripe');

    expect(getPlanFromPriceId('price_old_hobby_m')).toBe('hobby');
    expect(getPlanFromPriceId('price_old_hobby_y')).toBe('hobby'); // trims whitespace
    expect(getPlanFromPriceId('price_old_pro_m')).toBe('pro');
    expect(getPlanFromPriceId('price_new_hobby_m')).toBe('hobby'); // active still wins
  });
});
