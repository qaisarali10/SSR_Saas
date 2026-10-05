-- SSR SaaS: role privileges.
--
-- Why this file exists
-- --------------------
-- 0001 created the schema but never granted privileges on it, so every query
-- the server made failed with Postgres 42501 "permission denied for table
-- companies" and the container crash-looped at boot:
--   Error: Supabase connection failed:
--   at createStore (file:///app/server/src/store/index.js:12:20)
--
-- This also closes a privilege-escalation hole 0001 left open: Postgres grants
-- EXECUTE on functions to PUBLIC by default, and 0001's RPCs are SECURITY
-- DEFINER (so they run as the owner and ignore RLS). Several take p_user and
-- p_is_admin as arguments, so with the default PUBLIC grant anyone holding the
-- anon key -- which is public by design and ships in the browser bundle -- could
-- call sales_by_period(p_user => <any uuid>, p_is_admin => true) and read every
-- tenant's sales, or replace_schemes() and rewrite another user's rows.
--
-- Safe to re-run.

-- ---------------------------------------------------------------------------
-- Schema usage
-- ---------------------------------------------------------------------------
grant usage on schema public to service_role;

-- ---------------------------------------------------------------------------
-- Tables: service_role only.
--
-- The browser bundle never queries these tables -- client/src/supabaseClient.js
-- uses supabase-js purely to drive the OAuth redirect, and every real query
-- goes through the server. So anon/authenticated are deliberately not granted
-- table access (least privilege). If you ever query Supabase directly from a
-- client, grant to authenticated as well; the RLS policies in 0001 already
-- exist to constrain it.
-- ---------------------------------------------------------------------------
grant all privileges on all tables in schema public to service_role;

-- No serial/identity columns today (every id is uuid or an explicit value), but
-- grant sequences so adding one later cannot silently break the server.
grant all privileges on all sequences in schema public to service_role;

-- ---------------------------------------------------------------------------
-- Functions: revoke PUBLIC first, then re-grant narrowly.
-- ---------------------------------------------------------------------------
revoke execute on all functions in schema public from public;

-- RLS policies from 0001 call public.is_admin(), and policy expressions are
-- evaluated as the querying role, so this one function has to stay executable by
-- the browser-facing roles. It is SECURITY DEFINER but returns only a boolean
-- about the caller, so it leaks nothing.
grant execute on function public.is_admin() to anon, authenticated;

-- The reporting/transactional RPCs stay server-only.
grant execute on all functions in schema public to service_role;

-- ---------------------------------------------------------------------------
-- Default privileges, so a later migration cannot silently reopen either hole.
-- Only affects objects created by the role running this file.
-- ---------------------------------------------------------------------------
alter default privileges in schema public revoke execute on functions from public;
alter default privileges in schema public grant all on tables to service_role;
alter default privileges in schema public grant all on sequences to service_role;
