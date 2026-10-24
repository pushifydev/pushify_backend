-- The first line of a failed deploy's log that says what went wrong, written by the deploy worker
-- next to failure_category (lib/first-error-line.ts): masked, at most ~300 characters. Nullable;
-- additive. Earlier failures are filled by `npm run backfill:failure-category`, which re-runs the
-- classifier on each project's latest failed deploy.
ALTER TABLE "deployments" ADD COLUMN IF NOT EXISTS "failure_summary" text;
