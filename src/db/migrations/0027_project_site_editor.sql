CREATE TABLE IF NOT EXISTS "project_site_editor" (
  "project_id" uuid PRIMARY KEY NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "seo" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "blocks" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "cms_config" jsonb DEFAULT '{"mode":"builtin"}'::jsonb NOT NULL,
  "published_html" text,
  "published_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
