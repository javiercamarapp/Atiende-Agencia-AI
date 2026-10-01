-- catalog-snapshot.sql — "huella" de los esquemas respaldados, en UN solo json.
-- Se corre DOS veces con exactamente la misma consulta:
--   1) en backup.sh, dentro de la MISMA transacción REPEATABLE READ (misma foto)
--      que usa pg_dump --snapshot, así que describe exactamente lo que el dump contiene;
--   2) en drill.sh, contra la base restaurada.
-- scripts/respaldo/lib.mjs::compareCatalogs compara ambos. Es de SOLO LECTURA
-- (SELECT) y no devuelve datos de negocio: únicamente nombres de objetos, conteos
-- de filas, banderas de RLS, número de políticas, GRANTs y atributos de funciones.
--
-- Entrada: variable psql :schemas = 'core,citas,...' (ya validada por lib.mjs::parseSchemas).
-- Salida: una línea json (usar psql -At o \o con tuples_only/unaligned).
with s as (select unnest(string_to_array(:'schemas', ',')) as nspname),
tabs as (
  select c.oid, n.nspname, c.relname, c.relkind, c.relrowsecurity, c.relforcerowsecurity, c.relowner
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  join s on s.nspname = n.nspname
  where c.relkind in ('r', 'p') and not c.relispartition
),
counts as (
  select nspname, relname,
    (xpath('/row/c/text()',
       query_to_xml(format('select count(*) as c from %I.%I', nspname, relname), false, true, '')))[1]::text::bigint as rows
  from tabs
),
grants as (
  -- Tablas, vistas, vistas materializadas y secuencias de los esquemas.
  select n.nspname as schema, c.relname as object,
         case when c.relkind = 'S' then 'sequence' else 'table' end as kind,
         case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as grantee,
         a.privilege_type as privilege
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  join s on s.nspname = n.nspname
  cross join lateral aclexplode(c.relacl) a
  where c.relkind in ('r', 'p', 'v', 'm', 'S') and a.grantee <> c.relowner
  union all
  -- GRANT a nivel columna.
  select n.nspname, c.relname || '.' || at.attname, 'column',
         case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,
         a.privilege_type
  from pg_attribute at
  join pg_class c on c.oid = at.attrelid
  join pg_namespace n on n.oid = c.relnamespace
  join s on s.nspname = n.nspname
  cross join lateral aclexplode(at.attacl) a
  where at.attacl is not null and not at.attisdropped and a.grantee <> c.relowner
  union all
  -- EXECUTE de funciones.
  select n.nspname, format('%I(%s)', p.proname, pg_get_function_identity_arguments(p.oid)), 'function',
         case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,
         a.privilege_type
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  join s on s.nspname = n.nspname
  cross join lateral aclexplode(p.proacl) a
  where a.grantee <> p.proowner
),
fns as (
  select n.nspname as schema,
         format('%I(%s)', p.proname, pg_get_function_identity_arguments(p.oid)) as signature,
         p.prosecdef as secdef,
         exists (select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) cfg where cfg like 'search_path=%') as search_path_set,
         -- proacl null = el default de Postgres (EXECUTE para PUBLIC); un `revoke ... from public`
         -- sin más GRANTs deja solo al dueño, que la lista de grants de arriba filtra: este
         -- booleano es lo que distingue ambos casos.
         (p.proacl is null or exists (select 1 from aclexplode(p.proacl) x where x.grantee = 0)) as public_exec
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  join s on s.nspname = n.nspname
  where p.prokind in ('f', 'p')
    and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
)
select jsonb_build_object(
  'server_version', current_setting('server_version'),
  'counts', coalesce((select jsonb_agg(jsonb_build_object('schema', nspname, 'table', relname, 'rows', rows) order by nspname, relname) from counts), '[]'),
  'tables', coalesce((select jsonb_agg(jsonb_build_object(
      'schema', t.nspname, 'table', t.relname, 'rls', t.relrowsecurity, 'force_rls', t.relforcerowsecurity,
      'policies', (select count(*) from pg_policy pl where pl.polrelid = t.oid)) order by t.nspname, t.relname) from tabs t), '[]'),
  'grants', coalesce((select jsonb_agg(to_jsonb(g) order by g.schema, g.object, g.kind, g.grantee, g.privilege) from grants g), '[]'),
  'functions', coalesce((select jsonb_agg(to_jsonb(f) order by f.schema, f.signature) from fns f), '[]'),
  'invariants', jsonb_build_object(
    'secdef_sin_search_path', coalesce((select jsonb_agg(f.schema || '.' || f.signature order by f.schema, f.signature) from fns f where f.secdef and not f.search_path_set), '[]'),
    'politicas_using_true', coalesce((select jsonb_agg(p.schemaname || '.' || p.tablename || '.' || p.policyname order by p.schemaname, p.tablename, p.policyname)
        from pg_policies p join s on s.nspname = p.schemaname where p.qual = 'true'), '[]'),
    'anon_con_escritura_en_tablas', coalesce((select jsonb_agg(g.schema || '.' || g.object || ':' || g.privilege order by g.schema, g.object, g.privilege)
        from grants g where g.grantee = 'anon' and g.kind in ('table', 'column') and g.privilege <> 'SELECT'), '[]')
  )
)::text;
