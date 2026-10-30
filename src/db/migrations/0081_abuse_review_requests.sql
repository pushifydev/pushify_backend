-- A deploy stopped by the automatic Acceptable Use check can be put to a person for review, once:
-- the request is an abuse_flags row with source 'review_request'. Additive; no existing row changes.
CREATE UNIQUE INDEX IF NOT EXISTS "abuse_flags_review_request_deployment_unique"
  ON "abuse_flags" ("deployment_id") WHERE "source" = 'review_request';
