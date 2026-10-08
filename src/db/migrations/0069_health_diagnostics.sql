-- SSH / Docker / proxy port (80, 443) checks for a project whose server gives no HTTP answer,
-- with the suggested next step. Additive.
ALTER TABLE "project_health_state" ADD COLUMN IF NOT EXISTS "diagnostics" jsonb;
