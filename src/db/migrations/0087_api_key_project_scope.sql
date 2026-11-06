-- API keys limited to specific projects: NULL keeps today's behaviour (every project the key's
-- creator can reach); a list limits the key to the project API of those projects, intersected
-- with the creator's own access on every request. Additive; existing keys stay unrestricted.
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "project_ids" uuid[];
