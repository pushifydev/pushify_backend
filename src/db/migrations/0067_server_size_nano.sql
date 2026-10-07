-- A 1 vCPU / 1 GB size (Hetzner cpx02). Additive: existing rows keep their size.
ALTER TYPE "public"."server_size" ADD VALUE IF NOT EXISTS 'nano' BEFORE 'xs';
