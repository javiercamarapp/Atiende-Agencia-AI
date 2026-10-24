-- Fixtures + assertions contra Postgres REAL (RLS/GRANT/auth.uid()/security definer reales -- el repositorio en
-- memoria de domain-rentas nunca los aplica) de packages/domain-rentas/migrations/037_rentas_feed_export_token.sql
-- (paridad3 rentas: URL de exportacion iCal con token rotable y "Sincronizar ahora").
--
-- Que demuestra (positivo, negativo, cross-tenant, anon):
--   A. rentas.rotar_feed_export_token: lo ejecutan admin_gestora y operador:calendario_mensajeria; lo rechazan el rol
--      de solo calendario, el contador, otra organizacion, el sistema y anon; rotar deja exactamente un token
--      vigente; hash invalido o unidad inexistente se rechazan.
--   B. la tabla rentas.feed_export_token: el staff de la property ve las filas SIN la columna token_hash; otra
--      organizacion no ve nada; authenticated no inserta ni actualiza directo; anon no tiene acceso; un solo token
--      vigente por (unidad, canal).
--   C. rentas.resolver_feed_export_token: solo la sesion de sistema; resuelve solo tokens vigentes; registra el
--      ultimo acceso con limite de una escritura por minuto; un hash mal formado o desconocido no devuelve filas.
--   D. rentas.claim_ical_feed_manual: solo la sesion de sistema; entrega un feed con lease libre aunque este en
--      backoff, nunca uno con lease vigente ni inactivo; se puede reclamar de nuevo tras liberar el lease.
--   E. definer con search_path fijo y EXECUTE revocado a public/anon.
--
-- Run via scripts/verify-real-postgres-ci/run-gate.mjs (auto-descubierto en CI) o con ./run.sh. Cada escenario corre
-- en su propio `begin; ... rollback;`.
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000000a1', 'rentas', 'Org A (feed token)', 'org-a-feed-token'),
  ('00000000-0000-0000-0000-0000000000a2', 'rentas', 'Org B (feed token, ajena)', 'org-b-feed-token')
on conflict do nothing;

insert into core.property (id, organization_id, vertical, name) values
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a1', 'rentas', 'Casa Playa'),
  ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000a2', 'rentas', 'Casa Ajena')
on conflict do nothing;

insert into rentas.property_config (property_id, organization_id, zona_horaria, moneda) values
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a1', 'America/Cancun', 'MXN'),
  ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000a2', 'America/Mexico_City', 'MXN')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-000000000011', 'admin-a-ft@example.com', 'Admin A', 'seed'),
  ('00000000-0000-0000-0000-000000000012', 'op-cal-a-ft@example.com', 'Operador calendario A', 'seed'),
  ('00000000-0000-0000-0000-000000000013', 'op-solo-a-ft@example.com', 'Operador solo calendario A', 'seed'),
  ('00000000-0000-0000-0000-000000000014', 'contador-a-ft@example.com', 'Contador A', 'seed'),
  ('00000000-0000-0000-0000-000000000017', 'admin-b-ft@example.com', 'Admin B (ajeno)', 'seed')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-0000000000a1', null, 'owner', 'admin_gestora'),
  ('00000000-0000-0000-0000-000000000012', '00000000-0000-0000-0000-0000000000a1', null, 'member', 'operador:calendario_mensajeria'),
  ('00000000-0000-0000-0000-000000000013', '00000000-0000-0000-0000-0000000000a1', null, 'member', 'operador:solo_calendario'),
  ('00000000-0000-0000-0000-000000000014', '00000000-0000-0000-0000-0000000000a1', null, 'viewer', 'contador'),
  ('00000000-0000-0000-0000-000000000017', '00000000-0000-0000-0000-0000000000a2', null, 'owner', 'admin_gestora')
on conflict do nothing;

insert into rentas.unidad (id, organization_id, property_id, name, duracion_minima_noches) values
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', 'Suite 1', 1),
  ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000b2', 'Suite Ajena', 1)
on conflict do nothing;

-- Un feed iCal conectado en la Suite 1 (Airbnb) para los escenarios de reclamo manual.
insert into rentas.canal_feed_externo (id, organization_id, property_id, unidad_id, canal_id, url_importacion)
select '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1',
       '00000000-0000-0000-0000-0000000000c1', c.id, 'https://www.airbnb.com/calendar/ical/ejemplo.ics'
from rentas.canal c where c.codigo = 'airbnb'
on conflict do nothing;

\echo ''
\echo '=== A. rentas.rotar_feed_export_token ==='
\echo ''

\echo '--- 1. admin_gestora crea el primer token de (Suite 1, Airbnb) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
select token_id, creado_en from rentas.rotar_feed_export_token('00000000-0000-0000-0000-0000000000c1', (select id from rentas.canal where codigo = 'airbnb'), repeat('a', 64));
select count(*) as vigentes_deberia_ser_1 from rentas.feed_export_token where unidad_id = '00000000-0000-0000-0000-0000000000c1' and revocado_en is null;
rollback;

\echo '--- 2. rotar revoca el anterior y deja exactamente un token vigente ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
select token_id from rentas.rotar_feed_export_token('00000000-0000-0000-0000-0000000000c1', (select id from rentas.canal where codigo = 'airbnb'), repeat('a', 64));
select token_id from rentas.rotar_feed_export_token('00000000-0000-0000-0000-0000000000c1', (select id from rentas.canal where codigo = 'airbnb'), repeat('b', 64));
select count(*) as vigentes_deberia_ser_1 from rentas.feed_export_token where unidad_id = '00000000-0000-0000-0000-0000000000c1' and revocado_en is null;
rollback;

\echo '--- 2b. tras rotar, el token anterior queda revocado (no desaparece: queda como historial) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
select token_id from rentas.rotar_feed_export_token('00000000-0000-0000-0000-0000000000c1', (select id from rentas.canal where codigo = 'airbnb'), repeat('a', 64));
select token_id from rentas.rotar_feed_export_token('00000000-0000-0000-0000-0000000000c1', (select id from rentas.canal where codigo = 'airbnb'), repeat('b', 64));
select count(*) as revocados_deberia_ser_1 from rentas.feed_export_token where unidad_id = '00000000-0000-0000-0000-0000000000c1' and revocado_en is not null;
rollback;

\echo '--- 3. operador:calendario_mensajeria tambien puede rotar ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000012', true);
select token_id from rentas.rotar_feed_export_token('00000000-0000-0000-0000-0000000000c1', (select id from rentas.canal where codigo = 'vrbo'), repeat('c', 64));
select count(*) as vigentes_deberia_ser_1 from rentas.feed_export_token where unidad_id = '00000000-0000-0000-0000-0000000000c1' and revocado_en is null;
rollback;

\echo '--- 4. el rol de SOLO calendario (lectura) NO puede rotar llamando la funcion directo ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000013', true);
select token_id as should_fail from rentas.rotar_feed_export_token('00000000-0000-0000-0000-0000000000c1', (select id from rentas.canal where codigo = 'airbnb'), repeat('a', 64));
rollback;

\echo '--- 5. el contador NO puede rotar ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000014', true);
select token_id as should_fail from rentas.rotar_feed_export_token('00000000-0000-0000-0000-0000000000c1', (select id from rentas.canal where codigo = 'airbnb'), repeat('a', 64));
rollback;

\echo '--- 6. cross-tenant: el admin de otra organizacion NO puede rotar la URL de una unidad ajena ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000017', true);
select token_id as should_fail from rentas.rotar_feed_export_token('00000000-0000-0000-0000-0000000000c1', (select id from rentas.canal where codigo = 'airbnb'), repeat('a', 64));
rollback;

\echo '--- 7. la sesion de sistema (auth.uid() null) NO puede rotar ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select token_id as should_fail from rentas.rotar_feed_export_token('00000000-0000-0000-0000-0000000000c1', (select id from rentas.canal where codigo = 'airbnb'), repeat('a', 64));
rollback;

\echo '--- 8. anon NO puede ejecutar la funcion (EXECUTE revocado) ---'
begin;
set local role anon;
select token_id as should_fail from rentas.rotar_feed_export_token('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000ee', repeat('a', 64));
rollback;

\echo '--- 9. un hash con formato invalido se rechaza ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
select token_id as should_fail from rentas.rotar_feed_export_token('00000000-0000-0000-0000-0000000000c1', (select id from rentas.canal where codigo = 'airbnb'), 'no-es-un-hash');
rollback;

\echo '--- 10. una unidad inexistente se rechaza sin revelar nada ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
select token_id as should_fail from rentas.rotar_feed_export_token('00000000-0000-0000-0000-0000000000ff', (select id from rentas.canal where codigo = 'airbnb'), repeat('a', 64));
rollback;

\echo ''
\echo '=== B. tabla rentas.feed_export_token (RLS + GRANT por columna) ==='
\echo ''

\echo '--- 11. el staff de la property ve su fila (sin leer token_hash) ---'
begin;
insert into rentas.feed_export_token (organization_id, property_id, unidad_id, canal_id, token_hash)
select '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000c1', c.id, repeat('a', 64) from rentas.canal c where c.codigo = 'airbnb';
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000013', true);
select count(id) as visibles_deberia_ser_1 from rentas.feed_export_token;
rollback;

\echo '--- 12. el staff NO puede leer la columna token_hash ---'
begin;
insert into rentas.feed_export_token (organization_id, property_id, unidad_id, canal_id, token_hash)
select '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000c1', c.id, repeat('a', 64) from rentas.canal c where c.codigo = 'airbnb';
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
select token_hash as should_fail from rentas.feed_export_token;
rollback;

\echo '--- 13. cross-tenant: el staff de otra organizacion no ve las filas ---'
begin;
insert into rentas.feed_export_token (organization_id, property_id, unidad_id, canal_id, token_hash)
select '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000c1', c.id, repeat('a', 64) from rentas.canal c where c.codigo = 'airbnb';
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000017', true);
select count(id) as ajeno_deberia_ser_0 from rentas.feed_export_token;
rollback;

\echo '--- 14. authenticated NO inserta directo en la tabla ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
insert into rentas.feed_export_token (organization_id, property_id, unidad_id, canal_id, token_hash)
select '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000c1', c.id, repeat('a', 64) from rentas.canal c where c.codigo = 'airbnb'
returning id as should_fail;
rollback;

\echo '--- 15. authenticated NO actualiza directo (nadie puede des-revocar ni reescribir el hash) ---'
begin;
insert into rentas.feed_export_token (organization_id, property_id, unidad_id, canal_id, token_hash, revocado_en)
select '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000c1', c.id, repeat('a', 64), now() from rentas.canal c where c.codigo = 'airbnb';
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
update rentas.feed_export_token set revocado_en = null returning id as should_fail;
rollback;

\echo '--- 16. authenticated NO borra filas ---'
begin;
insert into rentas.feed_export_token (organization_id, property_id, unidad_id, canal_id, token_hash)
select '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000c1', c.id, repeat('a', 64) from rentas.canal c where c.codigo = 'airbnb';
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
delete from rentas.feed_export_token returning id as should_fail;
rollback;

\echo '--- 17. anon NO tiene acceso a la tabla ---'
begin;
set local role anon;
select count(*) as should_fail from rentas.feed_export_token;
rollback;

\echo '--- 18. un solo token vigente por (unidad, canal): el indice unico parcial lo hace cumplir ---'
begin;
insert into rentas.feed_export_token (organization_id, property_id, unidad_id, canal_id, token_hash)
select '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000c1', c.id, repeat('a', 64) from rentas.canal c where c.codigo = 'airbnb';
insert into rentas.feed_export_token (organization_id, property_id, unidad_id, canal_id, token_hash)
select '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000c1', c.id, repeat('b', 64) from rentas.canal c where c.codigo = 'airbnb'
returning id as should_fail;
rollback;

\echo ''
\echo '=== C. rentas.resolver_feed_export_token ==='
\echo ''

\echo '--- 19. la sesion de sistema resuelve un token vigente a su (unidad, canal) y registra el ultimo acceso ---'
begin;
insert into rentas.feed_export_token (organization_id, property_id, unidad_id, canal_id, token_hash)
select '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000c1', c.id, repeat('a', 64) from rentas.canal c where c.codigo = 'airbnb';
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as resueltos_deberia_ser_1 from rentas.resolver_feed_export_token(repeat('a', 64)) where unidad_id = '00000000-0000-0000-0000-0000000000c1' and canal_codigo = 'airbnb';
rollback;

\echo '--- 19b. el ultimo acceso queda registrado ---'
begin;
insert into rentas.feed_export_token (organization_id, property_id, unidad_id, canal_id, token_hash)
select '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000c1', c.id, repeat('a', 64) from rentas.canal c where c.codigo = 'airbnb';
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) from rentas.resolver_feed_export_token(repeat('a', 64));
reset role;
select count(*) as con_acceso_deberia_ser_1 from rentas.feed_export_token where token_hash = repeat('a', 64) and ultimo_acceso_en is not null;
rollback;

\echo '--- 20. un token revocado ya no resuelve ---'
begin;
insert into rentas.feed_export_token (organization_id, property_id, unidad_id, canal_id, token_hash, revocado_en)
select '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000c1', c.id, repeat('a', 64), now() from rentas.canal c where c.codigo = 'airbnb';
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as revocado_deberia_ser_0 from rentas.resolver_feed_export_token(repeat('a', 64));
rollback;

\echo '--- 21. un hash desconocido o mal formado no devuelve filas ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as desconocido_deberia_ser_0 from rentas.resolver_feed_export_token(repeat('f', 64));
rollback;

begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as malformado_deberia_ser_0 from rentas.resolver_feed_export_token('no-es-un-hash');
rollback;

\echo '--- 22. un staff autenticado NO puede resolver tokens (solo la sesion de sistema) ---'
begin;
insert into rentas.feed_export_token (organization_id, property_id, unidad_id, canal_id, token_hash)
select '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000c1', c.id, repeat('a', 64) from rentas.canal c where c.codigo = 'airbnb';
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
select count(*) as should_fail from rentas.resolver_feed_export_token(repeat('a', 64));
rollback;

\echo '--- 23. anon NO puede ejecutar el resolvedor ---'
begin;
set local role anon;
select count(*) as should_fail from rentas.resolver_feed_export_token(repeat('a', 64));
rollback;

\echo '--- 24. el ultimo acceso se escribe a lo mas una vez por minuto ---'
begin;
insert into rentas.feed_export_token (organization_id, property_id, unidad_id, canal_id, token_hash, ultimo_acceso_en)
select '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000c1', c.id, repeat('a', 64), now() - interval '10 seconds' from rentas.canal c where c.codigo = 'airbnb';
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) from rentas.resolver_feed_export_token(repeat('a', 64));
reset role;
select count(*) as sin_reescribir_deberia_ser_1 from rentas.feed_export_token where token_hash = repeat('a', 64) and ultimo_acceso_en < now() - interval '5 seconds';
rollback;

\echo ''
\echo '=== D. rentas.claim_ical_feed_manual ==='
\echo ''

\echo '--- 25. la sesion de sistema reclama un feed con lease libre ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as reclamado_deberia_ser_1 from rentas.claim_ical_feed_manual('00000000-0000-0000-0000-0000000000d1');
rollback;

\echo '--- 26. mientras el lease esta vigente, un segundo reclamo no recibe el feed ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) from rentas.claim_ical_feed_manual('00000000-0000-0000-0000-0000000000d1');
select count(*) as segundo_deberia_ser_0 from rentas.claim_ical_feed_manual('00000000-0000-0000-0000-0000000000d1');
rollback;

\echo '--- 27. ignora el backoff y el piso de espaciamiento (el usuario pidio sincronizar ya) ---'
begin;
update rentas.canal_feed_externo set proximo_intento_en = now() + interval '5 hours', ultimo_intento_en = now() where id = '00000000-0000-0000-0000-0000000000d1';
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as en_backoff_deberia_ser_1 from rentas.claim_ical_feed_manual('00000000-0000-0000-0000-0000000000d1');
rollback;

\echo '--- 28. un feed inactivo no se reclama ---'
begin;
update rentas.canal_feed_externo set activo = false where id = '00000000-0000-0000-0000-0000000000d1';
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as inactivo_deberia_ser_0 from rentas.claim_ical_feed_manual('00000000-0000-0000-0000-0000000000d1');
rollback;

\echo '--- 29. un staff autenticado NO puede reclamar (la ruta valida el rol y reclama en sesion de sistema) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
select count(*) as should_fail from rentas.claim_ical_feed_manual('00000000-0000-0000-0000-0000000000d1');
rollback;

\echo '--- 30. anon NO puede reclamar ---'
begin;
set local role anon;
select count(*) as should_fail from rentas.claim_ical_feed_manual('00000000-0000-0000-0000-0000000000d1');
rollback;

\echo '--- 31. tras liberar el lease (024) se puede reclamar de nuevo ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select rentas.liberar_ical_feed(f.feed_id, f.lease_token, true) from rentas.claim_ical_feed_manual('00000000-0000-0000-0000-0000000000d1') f;
select count(*) as de_nuevo_deberia_ser_1 from rentas.claim_ical_feed_manual('00000000-0000-0000-0000-0000000000d1');
rollback;

\echo ''
\echo '=== E. definer + search_path fijo + EXECUTE revocado ==='
\echo ''

\echo '--- 32. las tres funciones son security definer con search_path fijo ---'
begin;
select count(*) as definer_deberia_ser_3
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'rentas' and p.proname in ('rotar_feed_export_token', 'resolver_feed_export_token', 'claim_ical_feed_manual')
  and p.prosecdef and exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%');
rollback;

\echo '--- 33. ni public ni anon tienen EXECUTE sobre ellas ---'
begin;
select count(*) as con_execute_deberia_ser_0
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'rentas' and p.proname in ('rotar_feed_export_token', 'resolver_feed_export_token', 'claim_ical_feed_manual')
  and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('public', p.oid, 'execute'));
rollback;
