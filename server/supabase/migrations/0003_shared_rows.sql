-- SSR SaaS: shared (unowned) rows are visible to every signed-in user.
--
-- Why this file exists
-- --------------------
-- The legacy MongoDB catalogue was migrated with --skip-users, because none of
-- its 530 distributors or 2 companies ever recorded a `user` field. They
-- therefore carry user_id NULL, and both layers that enforce ownership would
-- have hidden them from every non-admin:
--
--   * server/src/utils/ownership.js -- already updated to treat a NULL owner as
--     "shared" (see buildUserFilter / verifyOwnership).
--   * the RLS policies from 0001 -- these still say `user_id = auth.uid()`,
--     which is never true for NULL, so a direct client query would return
--     nothing even though the app does.
--
-- This aligns the policies with the app. Rows that DO have an owner keep the
-- exact isolation they had: user_id = auth.uid() is still required, so one
-- tenant still cannot see another tenant's rows. Only the NULL-owner case is
-- new, and it is the whole point of the migration.
--
-- Safe to re-run.

do $$
declare
  t text;
begin
  foreach t in array array[
    'companies', 'distributors', 'products', 'product_aliases', 'product_schemes',
    'sales', 'services', 'upload_logs', 'temp_missing_products'
  ]
  loop
    if exists (
      select 1 from pg_policies
      where schemaname = 'public' and tablename = t and policyname = t || '_owner_access'
    ) then
      execute format('drop policy %I on public.%I', t || '_owner_access', t);
    end if;

    -- `user_id is null` = the shared legacy catalogue. Admins keep everything,
    -- owners keep their own, and everyone gets the shared rows.
    execute format(
      'create policy %I on public.%I for all '
      || 'using (public.is_admin() or user_id is null or user_id = auth.uid()) '
      || 'with check (public.is_admin() or user_id is null or user_id = auth.uid())',
      t || '_owner_access', t
    );
  end loop;
end $$;

-- audit_logs.user_id is text and the built-in administrator signs its rows
-- with a synthetic id, so this table stays owner-scoped plus admin; there is no
-- shared audit data to expose.