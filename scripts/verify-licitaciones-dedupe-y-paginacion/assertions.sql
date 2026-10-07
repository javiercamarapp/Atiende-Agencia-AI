-- Fixtures + assertions contra Postgres REAL para packages/domain-licitaciones/migrations/037_licitaciones_huella_cruzada_entre_fuentes.sql
-- (paridad3 L-P3-14 huella cruzada + L-P3-13 consultas de listado/conteo).
--
-- Actores: c1 = owner Org A, c4 = viewer Org A, c2 = owner Org B (otro tenant). La sesion de SISTEMA es `authenticated` SIN
-- request.jwt.claim.sub (auth.uid() null), igual que withAppSession({ userId: null }).
--
-- Convenciones del gate (scripts/verify-real-postgres-ci/run-gate.mjs): cada escenario corre en su propio `begin; ... rollback;` y
-- debe completar sin error; las afirmaciones son bloques DO que lanzan excepcion si algo no se cumple (los negativos capturan el
-- SQLSTATE exacto).
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000000a1', 'licitaciones', 'Org A (dedupe)', 'org-a-dedupe'),
  ('00000000-0000-0000-0000-0000000000a2', 'licitaciones', 'Org B (dedupe, ajena)', 'org-b-dedupe')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000000c1', 'owner-a-dedupe@example.com', 'Owner A', 'seed'),
  ('00000000-0000-0000-0000-0000000000c2', 'owner-b-dedupe@example.com', 'Owner B (ajeno)', 'seed'),
  ('00000000-0000-0000-0000-0000000000c4', 'viewer-a-dedupe@example.com', 'Viewer A', 'seed')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000a1', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000000c4', '00000000-0000-0000-0000-0000000000a1', null, 'viewer', 'viewer'),
  ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000a2', null, 'owner', 'owner')
on conflict do nothing;

-- 251 convocatorias de Org A con el MISMO updated_at (peor caso para paginar) y estados/plazos conocidos:
--   100 discovered (10 con plazo en 3 dias), 80 in_progress (5 con plazo en 3 dias, 75 a 30 dias), 40 won (plazo en 2 dias),
--    30 submitted (plazo en 2 dias), 1 go. Total 251; abiertas = 251 - 40 = 211; por vencer en 7 dias = 15.
insert into licitaciones.tender (id, organization_id, title, status, updated_at, submission_deadline, source, external_id)
select
  ('10000000-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid,
  '00000000-0000-0000-0000-0000000000a1',
  'Convocatoria listado ' || i,
  case when i <= 100 then 'discovered' when i <= 180 then 'in_progress' when i <= 220 then 'won' when i <= 250 then 'submitted' else 'go' end,
  timestamptz '2026-01-01 00:00:00+00',
  case
    when i <= 10 then now() + interval '3 days'
    when i <= 100 then null
    when i <= 180 then now() + interval '30 days'
    when i <= 250 then now() + interval '2 days'
    else null
  end,
  'listado_prueba',
  'LIST-' || i
from generate_series(1, 251) as g(i);
-- Ajuste fino: de las 80 in_progress (101..180) solo 5 deben vencer en 3 dias; el resto a 30 dias.
update licitaciones.tender set submission_deadline = now() + interval '30 days'
 where organization_id = '00000000-0000-0000-0000-0000000000a1' and status = 'in_progress';
update licitaciones.tender set submission_deadline = now() + interval '3 days'
 where id in (select id from licitaciones.tender where organization_id = '00000000-0000-0000-0000-0000000000a1' and status = 'in_progress' order by id limit 5);

\echo ''
\echo '=== licitaciones: huella cruzada entre fuentes (037) y listados paginados ==='
\echo ''

\echo '--- 1. VECTORES DORADOS: la huella SQL coincide con la de TypeScript (mismos valores que cross-source-fingerprint.spec.ts) ---'
begin;
do $$ declare h text; begin
  h := licitaciones.tender_fingerprint('LA-931037999-E12-2026', 'Secretaría de Obras Públicas', timestamptz '2026-10-20 17:00:00-06');
  if h <> '8eaf2712199c939030644cdd295a2467cff146587baa0ac51522b4fa03a7d842' then raise exception 'vector 1 distinto: %', h; end if;
  h := licitaciones.tender_fingerprint('NÚM 7/2026', 'Ayuntamiento de Mérida', timestamptz '2026-11-02 09:00:00-06');
  if h <> '7df4e7484fa6efc6820640fbcb20028fc25f6c708acb1ae68184e6893964a1bf' then raise exception 'vector 2 distinto: %', h; end if;
end $$;
rollback;

\echo '--- 2. NORMALIZACION: formato distinto de la misma convocatoria da la MISMA huella; procedimiento distinto, otra huella ---'
begin;
do $$ declare base text; begin
  base := licitaciones.tender_fingerprint('LA-931037999-E12-2026', 'Secretaría de Obras Públicas', timestamptz '2026-10-20 17:00:00-06');
  if licitaciones.tender_fingerprint('  la-931037999-e12-2026 ', 'SECRETARIA   DE OBRAS PUBLICAS', timestamptz '2026-10-20 10:00:00-06') is distinct from base then
    raise exception 'mayusculas/espacios/acentos/hora distintos debian dar la misma huella'; end if;
  -- NFD (i + acento combinado) y NFC (i acentuada precompuesta) del mismo texto dan la misma huella.
  if licitaciones.tender_fingerprint('LA-931037999-E12-2026', 'Secretari' || U&'\0301' || 'a de Obras Públicas', timestamptz '2026-10-20 17:00:00-06') is distinct from base then
    raise exception 'NFD y NFC del mismo texto debian dar la misma huella'; end if;
  if licitaciones.tender_fingerprint('LA-931037999-E13-2026', 'Secretaría de Obras Públicas', timestamptz '2026-10-20 17:00:00-06') = base then
    raise exception 'procedimientos distintos no pueden compartir huella'; end if;
  if licitaciones.tender_fingerprint('LA-931037999-E12-2026', 'Otra convocante', timestamptz '2026-10-20 17:00:00-06') = base then
    raise exception 'convocantes distintas no pueden compartir huella'; end if;
end $$;
rollback;

\echo '--- 3. ZONA HORARIA: la fecha es la de Mexico (20 oct 21:00 CDMX = 21 oct 03:00 UTC sigue siendo dia 20; 21 oct 01:00 CDMX es dia 21) ---'
begin;
do $$ declare a text; b text; c text; begin
  a := licitaciones.tender_fingerprint('P-1', 'IMSS', timestamptz '2026-10-20 17:00:00-06');
  b := licitaciones.tender_fingerprint('P-1', 'IMSS', timestamptz '2026-10-21 03:00:00+00');
  c := licitaciones.tender_fingerprint('P-1', 'IMSS', timestamptz '2026-10-21 07:00:00+00');
  if a is distinct from b then raise exception '21 oct 03:00 UTC es 20 oct en CDMX: misma huella'; end if;
  if a = c then raise exception '21 oct 07:00 UTC es 21 oct en CDMX: otra huella'; end if;
end $$;
rollback;

\echo '--- 4. SIN DATO SUFICIENTE no hay huella (no se fusiona a ciegas) ---'
begin;
do $$ begin
  if licitaciones.tender_fingerprint(null, 'IMSS', now()) is not null then raise exception 'sin procedimiento no hay huella'; end if;
  if licitaciones.tender_fingerprint('P-1', '   ', now()) is not null then raise exception 'sin convocante no hay huella'; end if;
  if licitaciones.tender_fingerprint('P-1', 'IMSS', null) is not null then raise exception 'sin plazo no hay huella'; end if;
end $$;
rollback;

\echo '--- 5. TRIGGER: la huella la calcula la base; un valor enviado por el cliente se sobrescribe; alta manual usa el folio como procedimiento ---'
begin;
do $$ declare fp text; pn text; begin
  insert into licitaciones.tender (id, organization_id, title, source, external_id, contracting_body, submission_deadline, cross_source_fingerprint)
    values ('20000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000a1', 'Manual con huella falsa', 'manual', 'LA-01/2026', 'IMSS', timestamptz '2026-10-20 17:00:00-06', 'huella-falsa-del-cliente');
  select cross_source_fingerprint, procedure_number into fp, pn from licitaciones.tender where id = '20000000-0000-0000-0000-000000000001';
  if fp = 'huella-falsa-del-cliente' or fp is distinct from licitaciones.tender_fingerprint('LA-01/2026', 'IMSS', timestamptz '2026-10-20 17:00:00-06') then
    raise exception 'la huella debia recalcularla la base, quedo %', fp; end if;
  if pn is distinct from 'LA-01/2026' then raise exception 'el folio manual debia ser el numero de procedimiento, quedo %', pn; end if;
  update licitaciones.tender set submission_deadline = timestamptz '2026-10-25 17:00:00-06' where id = '20000000-0000-0000-0000-000000000001';
  select cross_source_fingerprint into fp from licitaciones.tender where id = '20000000-0000-0000-0000-000000000001';
  if fp is distinct from licitaciones.tender_fingerprint('LA-01/2026', 'IMSS', timestamptz '2026-10-25 17:00:00-06') then raise exception 'cambiar el plazo debia recalcular la huella'; end if;
end $$;
rollback;

\echo '--- 6. BACKFILL: el UPDATE de la migracion rellena procedure_number y huella de las manuales existentes, y deja las de otras fuentes sin huella ---'
begin;
do $$ declare fp text; fp2 text; begin
  insert into licitaciones.tender (id, organization_id, title, source, external_id, contracting_body, submission_deadline)
    values ('20000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-0000000000a1', 'Manual antigua', 'manual', 'LA-77/2026', 'ISSSTE', timestamptz '2026-10-20 17:00:00-06'),
           ('20000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-0000000000a1', 'Otra fuente antigua', 'nl_ocds', 'ocds-1', 'ISSSTE', timestamptz '2026-10-20 17:00:00-06');
  -- Estado previo a la migracion: sin numero de procedimiento ni huella.
  alter table licitaciones.tender disable trigger tender_set_fingerprint;
  update licitaciones.tender set procedure_number = null, cross_source_fingerprint = null where id in ('20000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000003');
  alter table licitaciones.tender enable trigger tender_set_fingerprint;
  -- Mismo UPDATE que el paso 4 de la migracion.
  update licitaciones.tender set procedure_number = external_id where source = 'manual' and external_id is not null and procedure_number is null;
  select cross_source_fingerprint into fp from licitaciones.tender where id = '20000000-0000-0000-0000-000000000002';
  select cross_source_fingerprint into fp2 from licitaciones.tender where id = '20000000-0000-0000-0000-000000000003';
  if fp is distinct from licitaciones.tender_fingerprint('LA-77/2026', 'ISSSTE', timestamptz '2026-10-20 17:00:00-06') then raise exception 'la manual debia quedar con huella'; end if;
  if fp2 is not null then raise exception 'la de otra fuente no tiene numero de procedimiento: no se inventa huella'; end if;
end $$;
rollback;

\echo '--- 7. DEDUPE: la misma convocatoria por dos fuentes crea UNA sola con dos fuentes; los conflictos se registran y NO sobrescriben ---'
begin;
set local role authenticated;
do $$ declare r1 record; r2 record; r3 record; n integer; confl jsonb; t text; begin
  select * into r1 from licitaciones.system_ingest_tender_dedupe('00000000-0000-0000-0000-0000000000a1', 'Rehabilitación de la avenida Reforma', timestamptz '2026-10-20 17:00:00-06', 'nl_ocds', 'ocds-xyz-1', 'Secretaría de Obras Públicas', array['45233120'], 18500000, 'MXN', 'Yucatán', 'Licitación pública', 'LA-931037999-E12-2026');
  if not r1.out_inserted or r1.out_linked then raise exception 'la primera fuente debia crear la convocatoria'; end if;

  select * into r2 from licitaciones.system_ingest_tender_dedupe('00000000-0000-0000-0000-0000000000a1', 'REHABILITACION DE LA AVENIDA REFORMA TRAMO NORTE', timestamptz '2026-10-20 12:00:00-06', 'agregador', 'agg-77', 'SECRETARIA DE OBRAS PUBLICAS', array['45233120'], 19000000, 'MXN', 'Yucatán', 'Licitación pública', ' la-931037999-e12-2026 ');
  if r2.out_inserted or not r2.out_linked then raise exception 'la segunda fuente debia ENLAZARSE, no crear'; end if;
  if r2.out_id <> r1.out_id then raise exception 'debia devolver la misma convocatoria'; end if;
  if r2.out_conflicts < 3 then raise exception 'esperados conflictos de titulo, plazo y presupuesto, hay %', r2.out_conflicts; end if;

  -- La sesion de sistema no LEE las tablas (RLS exige auth.uid()): las comprobaciones se hacen como superusuario y se vuelve al rol de sistema.
  execute 'reset role';
  select count(*) into n from licitaciones.tender where organization_id = '00000000-0000-0000-0000-0000000000a1' and cross_source_fingerprint = licitaciones.tender_fingerprint('LA-931037999-E12-2026', 'Secretaría de Obras Públicas', timestamptz '2026-10-20 17:00:00-06');
  if n <> 1 then raise exception 'debia haber UNA convocatoria con esa huella, hay %', n; end if;
  select title into t from licitaciones.tender where id = r1.out_id;
  if t <> 'Rehabilitación de la avenida Reforma' then raise exception 'la fuente nueva no debia sobrescribir el titulo: %', t; end if;
  select conflicts into confl from licitaciones.tender_alt_source where tender_id = r1.out_id and source = 'agregador';
  if not (confl @> '[{"field":"budget_amount"}]'::jsonb) then raise exception 'debia registrar el conflicto de presupuesto: %', confl; end if;
  if confl @> '[{"field":"contracting_body"}]'::jsonb then raise exception 'mayusculas/acentos distintos NO son un conflicto de convocante'; end if;
  execute 'set local role authenticated';

  -- Idempotencia: reingestar la fuente adicional no duplica ni la convocatoria ni el enlace.
  select * into r3 from licitaciones.system_ingest_tender_dedupe('00000000-0000-0000-0000-0000000000a1', 'REHABILITACION DE LA AVENIDA REFORMA TRAMO NORTE', timestamptz '2026-10-20 12:00:00-06', 'agregador', 'agg-77', 'SECRETARIA DE OBRAS PUBLICAS', array['45233120'], 19000000, 'MXN', 'Yucatán', 'Licitación pública', 'LA-931037999-E12-2026');
  if r3.out_inserted or not r3.out_linked or r3.out_id <> r1.out_id then raise exception 'reingestar debia seguir enlazada a la misma convocatoria'; end if;
  execute 'reset role';
  select count(*) into n from licitaciones.tender_alt_source where tender_id = r1.out_id;
  if n <> 1 then raise exception 'debia haber 1 fuente adicional, hay %', n; end if;
  execute 'set local role authenticated';

  -- La fuente primaria se actualiza como siempre (no se enlaza a si misma).
  select * into r3 from licitaciones.system_ingest_tender_dedupe('00000000-0000-0000-0000-0000000000a1', 'Rehabilitación de la avenida Reforma (v2)', timestamptz '2026-10-20 17:00:00-06', 'nl_ocds', 'ocds-xyz-1', 'Secretaría de Obras Públicas', array['45233120'], 18500000, 'MXN', 'Yucatán', 'Licitación pública', 'LA-931037999-E12-2026');
  if r3.out_inserted or r3.out_linked or r3.out_title <> 'Rehabilitación de la avenida Reforma (v2)' then raise exception 'la fuente primaria debia actualizar su propia convocatoria'; end if;

  -- Un procedimiento distinto de la misma convocante crea otra convocatoria.
  select * into r3 from licitaciones.system_ingest_tender_dedupe('00000000-0000-0000-0000-0000000000a1', 'Otra obra', timestamptz '2026-10-20 17:00:00-06', 'agregador', 'agg-78', 'Secretaría de Obras Públicas', array[]::text[], null, 'MXN', null, null, 'LA-931037999-E99-2026');
  if not r3.out_inserted or r3.out_linked then raise exception 'procedimiento distinto debia crear otra convocatoria'; end if;
end $$;
rollback;

\echo '--- 8. SIN HUELLA NO SE FUSIONA: dos fuentes sin numero de procedimiento crean dos convocatorias ---'
begin;
set local role authenticated;
do $$ declare r1 record; r2 record; begin
  select * into r1 from licitaciones.system_ingest_tender_dedupe('00000000-0000-0000-0000-0000000000a1', 'Sin numero', timestamptz '2026-10-20 17:00:00-06', 'nl_ocds', 'sn-1', 'IMSS', array[]::text[], null, 'MXN', null, null, null);
  select * into r2 from licitaciones.system_ingest_tender_dedupe('00000000-0000-0000-0000-0000000000a1', 'Sin numero', timestamptz '2026-10-20 17:00:00-06', 'agregador', 'sn-2', 'IMSS', array[]::text[], null, 'MXN', null, null, null);
  if r1.out_id = r2.out_id or r2.out_linked then raise exception 'sin huella no debia enlazar'; end if;
end $$;
rollback;

\echo '--- 9. CROSS-TENANT: la misma huella en OTRA organizacion NO se enlaza a la convocatoria de Org A ---'
begin;
set local role authenticated;
do $$ declare ra record; rb record; begin
  select * into ra from licitaciones.system_ingest_tender_dedupe('00000000-0000-0000-0000-0000000000a1', 'Obra', timestamptz '2026-10-20 17:00:00-06', 'nl_ocds', 'x-1', 'IMSS', array[]::text[], null, 'MXN', null, null, 'P-CROSS');
  select * into rb from licitaciones.system_ingest_tender_dedupe('00000000-0000-0000-0000-0000000000a2', 'Obra', timestamptz '2026-10-20 17:00:00-06', 'agregador', 'x-2', 'IMSS', array[]::text[], null, 'MXN', null, null, 'P-CROSS');
  if rb.out_linked or rb.out_id = ra.out_id or rb.out_organization_id <> '00000000-0000-0000-0000-0000000000a2' then raise exception 'Org B no debia enlazarse a Org A'; end if;
end $$;
rollback;

\echo '--- 10. SOLO SISTEMA: con auth.uid() la funcion falla (42501); source manual se rechaza; anon no tiene EXECUTE ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
do $$ begin
  perform * from licitaciones.system_ingest_tender_dedupe('00000000-0000-0000-0000-0000000000a1', 'X', null, 'nl_ocds', 'e1', null, array[]::text[], null, 'MXN', null, null, null);
  raise exception 'un staff autenticado no debia poder invocarla';
exception when sqlstate '42501' then null;
end $$;
rollback;

begin;
set local role authenticated;
do $$ begin
  perform * from licitaciones.system_ingest_tender_dedupe('00000000-0000-0000-0000-0000000000a1', 'X', null, 'manual', 'e1', null, array[]::text[], null, 'MXN', null, null, null);
  raise exception 'source manual no debia aceptarse';
exception when raise_exception then
  if sqlerrm like 'source manual no debia%' then raise; end if;
end $$;
rollback;

begin;
set local role anon;
do $$ begin
  perform * from licitaciones.system_ingest_tender_dedupe('00000000-0000-0000-0000-0000000000a1', 'X', null, 'nl_ocds', 'e1', null, array[]::text[], null, 'MXN', null, null, null);
  raise exception 'anon no debia tener EXECUTE';
exception when sqlstate '42501' then null;
end $$;
rollback;

\echo '--- 11. RLS de tender_alt_source: el miembro ve las de su organizacion, Org B no; authenticated no escribe; anon no lee ---'
begin;
insert into licitaciones.tender_alt_source (id, organization_id, tender_id, source, external_id)
  values ('30000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000a1', '10000000-0000-0000-0000-000000000001', 'agregador', 'rls-1');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c4', true);
do $$ declare n integer; begin
  select count(*) into n from licitaciones.tender_alt_source;
  if n <> 1 then raise exception 'el viewer de Org A debia ver 1 fuente adicional, vio %', n; end if;
end $$;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c2', true);
do $$ declare n integer; begin
  select count(*) into n from licitaciones.tender_alt_source;
  if n <> 0 then raise exception 'Org B no debia ver fuentes de Org A, vio %', n; end if;
end $$;
rollback;

begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
do $$ begin
  insert into licitaciones.tender_alt_source (organization_id, tender_id, source, external_id)
    values ('00000000-0000-0000-0000-0000000000a1', '10000000-0000-0000-0000-000000000001', 'agregador', 'intento-owner');
  raise exception 'ni el owner debia poder insertar fuentes adicionales (solo la funcion de sistema)';
exception when sqlstate '42501' then null;
end $$;
rollback;

begin;
set local role anon;
do $$ declare n integer; begin
  select count(*) into n from licitaciones.tender_alt_source;
  raise exception 'anon no debia poder leer';
exception when sqlstate '42501' then null;
end $$;
rollback;

\echo '--- 12. INDICE parcial de la huella existe ---'
begin;
do $$ declare n integer; begin
  select count(*) into n from pg_indexes where schemaname = 'licitaciones' and tablename = 'tender' and indexname = 'tender_cross_source_fingerprint_idx' and indexdef like '%WHERE%';
  if n <> 1 then raise exception 'falta el indice parcial de la huella'; end if;
end $$;
rollback;

\echo '--- 13. PAGINA: con 251 convocatorias del mismo updated_at, order by updated_at desc, id desc recorre todas sin repetir ni saltar ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
do $$ declare vistos uuid[] := '{}'; pagina uuid[]; off integer := 0; total integer; begin
  loop
    select array_agg(id order by updated_at desc, id desc) into pagina
      from (select id, updated_at from licitaciones.tender where organization_id = '00000000-0000-0000-0000-0000000000a1' and source = 'listado_prueba' order by updated_at desc, id desc limit 100 offset off) p;
    exit when pagina is null;
    if vistos && pagina then raise exception 'una pagina repitio filas ya vistas (offset %)', off; end if;
    vistos := vistos || pagina;
    off := off + 100;
  end loop;
  total := coalesce(array_length(vistos, 1), 0);
  if total <> 251 then raise exception 'debia recorrer 251, recorrio %', total; end if;
end $$;
rollback;

\echo '--- 14. CONTEOS del resumen (la consulta de summarizeTenders): total, abiertas, por vencer en 7 dias y por estado cuadran con lo sembrado ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
do $$ declare total integer := 0; abiertas integer := 0; por_vencer integer := 0; r record; begin
  for r in
    select status, count(*) as n,
           count(*) filter (where status <> all (array['won','lost','cancelled','no_go']) and status <> 'submitted'
                              and submission_deadline is not null and submission_deadline >= now()
                              and submission_deadline <= now() + make_interval(days => 7)) as closing
      from licitaciones.tender where organization_id = '00000000-0000-0000-0000-0000000000a1' and source = 'listado_prueba' group by status
  loop
    total := total + r.n;
    if r.status <> all (array['won','lost','cancelled','no_go']) then abiertas := abiertas + r.n; por_vencer := por_vencer + r.closing; end if;
  end loop;
  if total <> 251 then raise exception 'total esperado 251, hay %', total; end if;
  if abiertas <> 211 then raise exception 'abiertas esperadas 211, hay %', abiertas; end if;
  if por_vencer <> 15 then raise exception 'por vencer esperadas 15 (10 discovered + 5 in_progress), hay %', por_vencer; end if;
end $$;
rollback;

\echo ''
\echo '=== fin: cada escenario debe terminar sin ERROR ==='
