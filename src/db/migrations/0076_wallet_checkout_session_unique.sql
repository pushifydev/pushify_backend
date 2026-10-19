-- One wallet credit per Stripe checkout session. The webhook and the success-page confirm
-- process the same session in parallel; with this index the second insert conflicts and
-- creditWallet credits nothing. Rows without a session id (charges, refunds) are unaffected.
-- Fails if duplicate rows already exist; find them first with:
--   SELECT organization_id, stripe_checkout_session_id, count(*) FROM infra_wallet_transactions
--   WHERE stripe_checkout_session_id IS NOT NULL GROUP BY 1, 2 HAVING count(*) > 1;
CREATE UNIQUE INDEX IF NOT EXISTS "infra_wallet_transactions_org_checkout_session_uq" ON "infra_wallet_transactions" ("organization_id","stripe_checkout_session_id") WHERE "stripe_checkout_session_id" IS NOT NULL;
