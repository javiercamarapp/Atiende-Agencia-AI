-- D-04 (lista 69-B / EFOS) -- verificación contra Postgres REAL de la migración 014.
-- Cada escenario corre en su propio `begin; ... rollback;`. Alias `should_fail` = debe terminar
-- en ERROR; alias `..._deberia_ser_N` = el valor esperado (ver run-gate.mjs).
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-00000000ef01', 'despachos', 'Org A despachos', 'org-a-efos'),
  ('00000000-0000-0000-0000-00000000ef02', 'despachos', 'Org B despachos', 'org-b-efos'),
  ('00000000-0000-0000-0000-00000000ef03', 'hoteles', 'Org H hoteles', 'org-h-efos')
on conflict do nothing;
insert into core.property (id, organization_id, vertical, name) values
  ('00000000-0000-0000-0000-00000000ea01', '00000000-0000-0000-0000-00000000ef01', 'despachos', 'Contribuyente A'),
  ('00000000-0000-0000-0000-00000000ea02', '00000000-0000-0000-0000-00000000ef02', 'despachos', 'Contribuyente B')
on conflict do nothing;
insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-00000000eb01', 'efos-a@example.com', 'Staff A', 'seed'),
  ('00000000-0000-0000-0000-00000000eb02', 'efos-b@example.com', 'Staff B', 'seed'),
  ('00000000-0000-0000-0000-00000000eb03', 'efos-h@example.com', 'Staff hoteles', 'seed'),
  ('00000000-0000-0000-0000-00000000eb04', 'efos-none@example.com', 'Sin membresia', 'seed')
on conflict do nothing;
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-00000000eb01', '00000000-0000-0000-0000-00000000ef01', null, 'admin', 'admin'),
  ('00000000-0000-0000-0000-00000000eb02', '00000000-0000-0000-0000-00000000ef02', null, 'admin', 'admin'),
  ('00000000-0000-0000-0000-00000000eb03', '00000000-0000-0000-0000-00000000ef03', null, 'admin', 'admin')
on conflict do nothing;
-- invoices: 3 del contribuyente A (emisores definitivo/presunto/limpio), 1 del B (mismo emisor definitivo)
insert into despachos.invoice (organization_id, property_id, folio_fiscal, tipo, rfc_emisor, rfc_receptor, subtotal, total, valido, fecha) values
  ('00000000-0000-0000-0000-00000000ef01', '00000000-0000-0000-0000-00000000ea01', '00000000-0000-0000-0000-00000000c001', 'I', 'AAA010101AA1', 'RRR010101RR1', 100, 116, true, '2026-07-10'),
  ('00000000-0000-0000-0000-00000000ef01', '00000000-0000-0000-0000-00000000ea01', '00000000-0000-0000-0000-00000000c002', 'I', 'BBB020202BB2', 'RRR010101RR1', 200, 232, true, '2026-07-11'),
  ('00000000-0000-0000-0000-00000000ef01', '00000000-0000-0000-0000-00000000ea01', '00000000-0000-0000-0000-00000000c003', 'I', 'ZZZ999999ZZ9', 'RRR010101RR1', 300, 348, true, '2026-07-12'),
  ('00000000-0000-0000-0000-00000000ef02', '00000000-0000-0000-0000-00000000ea02', '00000000-0000-0000-0000-00000000c004', 'I', 'AAA010101AA1', 'RRR020202RR2', 400, 464, true, '2026-07-13')
on conflict do nothing;

\echo '=== INGESTA (solo sistema, idempotente por periodo) ==='

\echo '1. sistema (sin sub) inserta la edicion 2026-06 -> insertada'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (despachos.efos_ingestar_periodo('2026-06', repeat('a', 64),
  '[{"rfc":"AAA010101AA1","nombre":"FANTASMA SA","situacion":"presunto","fecha_presuncion_sat":"2026-05-30"}]'::jsonb) = 'insertada')::int as ingesta_insertada_deberia_ser_1;
rollback;

\echo '2. mismo periodo y mismo sha -> sin_cambios y NO duplica filas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select despachos.efos_ingestar_periodo('2026-06', repeat('a', 64), '[{"rfc":"AAA010101AA1","nombre":"X","situacion":"presunto"}]'::jsonb);
select despachos.efos_ingestar_periodo('2026-06', repeat('a', 64), '[{"rfc":"AAA010101AA1","nombre":"X","situacion":"presunto"}]'::jsonb) as segunda;
reset role;
select (count(*) = 1)::int as una_sola_fila_deberia_ser_1 from despachos.efos_contribuyente where periodo = '2026-06';
rollback;

\echo '3. mismo periodo con sha distinto -> reemplazada (la edicion corregida sustituye a la anterior, sin mezclar filas)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select despachos.efos_ingestar_periodo('2026-06', repeat('a', 64), '[{"rfc":"AAA010101AA1","nombre":"X","situacion":"presunto"},{"rfc":"BBB020202BB2","nombre":"Y","situacion":"presunto"}]'::jsonb);
select despachos.efos_ingestar_periodo('2026-06', repeat('b', 64), '[{"rfc":"AAA010101AA1","nombre":"X","situacion":"definitivo"}]'::jsonb) as reemplazo;
reset role;
select (count(*) = 1 and bool_and(situacion = 'definitivo'))::int as reemplazo_exacto_deberia_ser_1 from despachos.efos_contribuyente where periodo = '2026-06';
rollback;

\echo '4. staff autenticado (sub real) NO puede ingerir: 42501'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000eb01', true);
select despachos.efos_ingestar_periodo('2026-06', repeat('a', 64), '[{"rfc":"AAA010101AA1","nombre":"X","situacion":"presunto"}]'::jsonb) as should_fail;
rollback;

\echo '5. anon NO tiene EXECUTE sobre la ingesta'
begin;
set local role anon;
select despachos.efos_ingestar_periodo('2026-06', repeat('a', 64), '[{"rfc":"AAA010101AA1","nombre":"X","situacion":"presunto"}]'::jsonb) as should_fail;
rollback;

\echo '6. entrada invalida (periodo mal formado) -> error'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select despachos.efos_ingestar_periodo('2026-13', repeat('a', 64), '[{"rfc":"AAA010101AA1","nombre":"X","situacion":"presunto"}]'::jsonb) as should_fail;
rollback;

\echo '7. situacion fuera del catalogo -> error (check de tabla)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select despachos.efos_ingestar_periodo('2026-06', repeat('a', 64), '[{"rfc":"AAA010101AA1","nombre":"X","situacion":"inventada"}]'::jsonb) as should_fail;
rollback;

\echo '8. RFC duplicado dentro de la misma edicion -> error y no queda nada a medias'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select despachos.efos_ingestar_periodo('2026-06', repeat('a', 64), '[{"rfc":"AAA010101AA1","nombre":"X","situacion":"presunto"},{"rfc":"AAA010101AA1","nombre":"X","situacion":"definitivo"}]'::jsonb) as should_fail;
rollback;

\echo '9. lista vacia -> error (no se ingiere una lista vacia)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select despachos.efos_ingestar_periodo('2026-06', repeat('a', 64), '[]'::jsonb) as should_fail;
rollback;

\echo '=== ACCESO DIRECTO A TABLAS (cerrado) ==='

\echo '10. staff autenticado NO puede leer efos_contribuyente directo'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000eb01', true);
select count(*) as should_fail from despachos.efos_contribuyente;
rollback;

\echo '11. staff autenticado NO puede insertar directo en efos_contribuyente'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000eb01', true);
insert into despachos.efos_contribuyente (periodo, rfc, situacion) values ('2026-06', 'AAA010101AA1', 'definitivo') returning 1 as should_fail;
rollback;

\echo '12. anon NO puede leer efos_ingesta directo'
begin;
set local role anon;
select count(*) as should_fail from despachos.efos_ingesta;
rollback;

\echo '=== CONSULTA (solo staff de despachos) ==='

\echo '13. staff de despachos consulta y recibe SOLO coincidencias de la edicion mas reciente'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select despachos.efos_ingestar_periodo('2026-05', repeat('c', 64), '[{"rfc":"AAA010101AA1","nombre":"X","situacion":"presunto"},{"rfc":"BBB020202BB2","nombre":"Y","situacion":"presunto"}]'::jsonb);
select despachos.efos_ingestar_periodo('2026-06', repeat('d', 64), '[{"rfc":"AAA010101AA1","nombre":"X","situacion":"definitivo","fecha_definitivo_sat":"2026-06-15"}]'::jsonb);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000eb01', true);
select (count(*) = 1 and min(out_situacion) = 'definitivo' and min(out_periodo) = '2026-06' and min(out_fecha_definitivo_sat) = '2026-06-15')::int as solo_edicion_vigente_deberia_ser_1
from despachos.efos_consultar(array['aaa010101aa1 ', 'BBB020202BB2', 'ZZZ999999ZZ9']);
rollback;

\echo '14. consulta de RFC no listado -> cero filas (estado "limpio" lo decide efos_estado)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select despachos.efos_ingestar_periodo('2026-06', repeat('d', 64), '[{"rfc":"AAA010101AA1","nombre":"X","situacion":"definitivo"}]'::jsonb);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000eb01', true);
select (count(*) = 0)::int as no_listado_deberia_ser_1 from despachos.efos_consultar(array['ZZZ999999ZZ9']);
rollback;

\echo '15. sin ninguna edicion ingerida: efos_estado devuelve cero filas y efos_consultar cero filas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000eb01', true);
select ((select count(*) from despachos.efos_estado()) = 0 and (select count(*) from despachos.efos_consultar(array['AAA010101AA1'])) = 0)::int as sin_lista_deberia_ser_1;
rollback;

\echo '16. efos_estado devuelve la edicion mas reciente con su conteo'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select despachos.efos_ingestar_periodo('2026-05', repeat('c', 64), '[{"rfc":"AAA010101AA1","nombre":"X","situacion":"presunto"}]'::jsonb);
select despachos.efos_ingestar_periodo('2026-06', repeat('d', 64), '[{"rfc":"AAA010101AA1","nombre":"X","situacion":"definitivo"},{"rfc":"BBB020202BB2","nombre":"Y","situacion":"presunto"}]'::jsonb);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000eb01', true);
select (out_periodo = '2026-06' and out_filas = 2)::int as estado_vigente_deberia_ser_1 from despachos.efos_estado();
rollback;

\echo '17. staff de OTRA vertical (hoteles) NO puede consultar'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000eb03', true);
select * from despachos.efos_consultar(array['AAA010101AA1']) as should_fail;
rollback;

\echo '18. usuario sin membresia NO puede consultar'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000eb04', true);
select * from despachos.efos_consultar(array['AAA010101AA1']) as should_fail;
rollback;

\echo '19. anon NO puede consultar'
begin;
set local role anon;
select * from despachos.efos_consultar(array['AAA010101AA1']) as should_fail;
rollback;

\echo '20. sesion de sistema (sin sub) tampoco consulta (la consulta es de staff)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from despachos.efos_consultar(array['AAA010101AA1']) as should_fail;
rollback;

\echo '21. mas de 500 RFC en una consulta -> error (no es un volcado de la lista)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000eb01', true);
select * from despachos.efos_consultar(array(select 'AAA010101A' || lpad(g::text, 2, '0') from generate_series(1, 501) g)) as should_fail;
rollback;

\echo '22. helper interno efos_caller_es_staff_despachos NO es ejecutable por authenticated'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000eb01', true);
select despachos.efos_caller_es_staff_despachos() as should_fail;
rollback;

\echo '=== INVOICES AFECTADOS (cross-tenant) ==='

\echo '23. staff A ve en SU property solo presunto/definitivo (2 invoices), no el limpio'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select despachos.efos_ingestar_periodo('2026-06', repeat('d', 64), '[{"rfc":"AAA010101AA1","nombre":"X","situacion":"definitivo"},{"rfc":"BBB020202BB2","nombre":"Y","situacion":"presunto"},{"rfc":"ZZZ999999ZZ9","nombre":"Z","situacion":"desvirtuado"}]'::jsonb);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000eb01', true);
select (count(*) = 2 and bool_and(out_rfc_emisor in ('AAA010101AA1', 'BBB020202BB2')))::int as afectados_property_a_deberia_ser_1
from despachos.efos_invoices_afectados('00000000-0000-0000-0000-00000000ea01');
rollback;

\echo '24. staff A pidiendo la property de B (mismo emisor definitivo) -> 42501, sin fuga cross-tenant'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000eb01', true);
select * from despachos.efos_invoices_afectados('00000000-0000-0000-0000-00000000ea02') as should_fail;
rollback;

\echo '25. staff B solo ve el invoice de SU property'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select despachos.efos_ingestar_periodo('2026-06', repeat('d', 64), '[{"rfc":"AAA010101AA1","nombre":"X","situacion":"definitivo"}]'::jsonb);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000eb02', true);
select (count(*) = 1 and min(out_folio_fiscal) = '00000000-0000-0000-0000-00000000c004')::int as afectados_property_b_deberia_ser_1
from despachos.efos_invoices_afectados('00000000-0000-0000-0000-00000000ea02');
rollback;

\echo '26. anon y sesion de sistema NO pueden listar afectados'
begin;
set local role anon;
select * from despachos.efos_invoices_afectados('00000000-0000-0000-0000-00000000ea01') as should_fail;
rollback;

\echo '27. sesion de sistema (sin sub) tampoco'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from despachos.efos_invoices_afectados('00000000-0000-0000-0000-00000000ea01') as should_fail;
rollback;

\echo '28. staff de hoteles sin acceso a la property de despachos -> 42501'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000eb03', true);
select * from despachos.efos_invoices_afectados('00000000-0000-0000-0000-00000000ea01') as should_fail;
rollback;

\echo '29. las 5 funciones son security definer con search_path fijo y NINGUNA es ejecutable por anon ni public'
begin;
select (
  count(*) = 5
  and bool_and(p.prosecdef)
  and bool_and(coalesce(p.proconfig::text, '') like '%search_path=despachos, pg_temp%')
  and bool_and(not has_function_privilege('anon', p.oid, 'execute'))
  and bool_and(not has_function_privilege('public', p.oid, 'execute'))
)::int as funciones_endurecidas_deberia_ser_1
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'despachos' and p.proname in ('efos_caller_es_staff_despachos','efos_ingestar_periodo','efos_consultar','efos_estado','efos_invoices_afectados');
rollback;

\echo 'Escenarios esperados en ERROR: 4/5/6/7/8/9/10/11/12/17/18/19/20/21/22/24/26/27/28 deben terminar en ERROR; el resto en valor 1 o sin error.'
