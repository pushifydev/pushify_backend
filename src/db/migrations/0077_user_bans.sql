-- Account bans (Acceptable Use): a banned flag on users, identifiers that may not sign up again,
-- and the user an abuse action concerns. Additive; no existing row changes.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "banned_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "ban_reason" text;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "banned_identifiers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "kind" varchar(16) NOT NULL,
  "value" varchar(255) NOT NULL,
  "user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "reason" text,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "banned_identifiers_kind_value_unique" ON "banned_identifiers" ("kind", "value");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "banned_identifiers_user_idx" ON "banned_identifiers" ("user_id");
--> statement-breakpoint
ALTER TABLE "abuse_actions" ADD COLUMN IF NOT EXISTS "user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL;
