ALTER TABLE "project_site_editor" ADD COLUMN IF NOT EXISTS "pages" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
UPDATE "project_site_editor"
SET "pages" = jsonb_build_array(
  jsonb_build_object(
    'id', gen_random_uuid()::text,
    'title', 'Home',
    'slug', '',
    'blocks', "blocks",
    'seo', "seo"
  )
)
WHERE "pages" = '[]'::jsonb;
