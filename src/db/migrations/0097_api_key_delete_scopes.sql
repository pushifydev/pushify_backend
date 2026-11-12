-- Deleting with an API key now needs a separate `<resource>:delete` scope (API_KEY_SCOPES): HTTP
-- DELETE routes no longer accept `:write`. Every key that has a `:write` scope gets the matching
-- `:delete` scope, so keys created before keep deleting what they could delete. '*' keys already
-- have every scope and are not matched. Data only; re-running it adds nothing twice.
UPDATE "api_keys" SET "scopes" = "scopes" || ',projects:delete'
WHERE 'projects:write' = ANY (string_to_array(replace("scopes", ' ', ''), ','))
  AND NOT ('projects:delete' = ANY (string_to_array(replace("scopes", ' ', ''), ',')));
--> statement-breakpoint
UPDATE "api_keys" SET "scopes" = "scopes" || ',envvars:delete'
WHERE 'envvars:write' = ANY (string_to_array(replace("scopes", ' ', ''), ','))
  AND NOT ('envvars:delete' = ANY (string_to_array(replace("scopes", ' ', ''), ',')));
--> statement-breakpoint
UPDATE "api_keys" SET "scopes" = "scopes" || ',domains:delete'
WHERE 'domains:write' = ANY (string_to_array(replace("scopes", ' ', ''), ','))
  AND NOT ('domains:delete' = ANY (string_to_array(replace("scopes", ' ', ''), ',')));
--> statement-breakpoint
UPDATE "api_keys" SET "scopes" = "scopes" || ',servers:delete'
WHERE 'servers:write' = ANY (string_to_array(replace("scopes", ' ', ''), ','))
  AND NOT ('servers:delete' = ANY (string_to_array(replace("scopes", ' ', ''), ',')));
--> statement-breakpoint
UPDATE "api_keys" SET "scopes" = "scopes" || ',databases:delete'
WHERE 'databases:write' = ANY (string_to_array(replace("scopes", ' ', ''), ','))
  AND NOT ('databases:delete' = ANY (string_to_array(replace("scopes", ' ', ''), ',')));
