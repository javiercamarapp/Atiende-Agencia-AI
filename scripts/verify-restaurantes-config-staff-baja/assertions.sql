-- Fixtures + assertions que verifican, contra Postgres REAL (RLS + GRANT reales --
-- nunca el repositorio en memoria de domain-restaurantes/packages/db, que no aplica
-- ninguno de los dos), que estas dos migraciones cierran exactamente lo que dicen
-- cerrar:
--
--   A. packages/db/migrations/0022_remove_membership.sql (core.remove_membership --
--      baja de un staff YA ACEPTADO):
--     1. Positivo: owner/admin real de la organización SÍ puede dar de baja a un
--        staff de rango menor -- el membership desaparece de verdad.
--     2. Negativo (rol insuficiente): un "staff"/"repartidor" (rango < admin) NUNCA
--        puede ejecutar la función, aunque pertenezca a la misma organización -- ni
--        siquiera contra un target de rango igual o menor.
--     3. Cross-tenant: un owner real de OTRA organización jamás puede dar de baja a
--        un staff de esta -- rechazado por "no perteneces a esta organización"
--        (security definer bypassa RLS, la función re-valida la pertenencia).
--     4. `anon` rechazado por completo (sin GRANT de EXECUTE).
--     5. Auto-baja SIEMPRE bloqueada, para CUALQUIER rol (incluido el único owner).
--     6. "No dejar la organización sin ningún owner" -- demostrado por EXHAUSTIVIDAD
--        (ver el escenario 8 para el porqué): con un único owner, NINGÚN caller
--        posible puede removerlo (ni él mismo -- regla 5 --, ni nadie de rango menor
--        -- regla 2/3 combinadas con la jerarquía), así que la invariante "siempre
--        queda al menos 1 owner" se sostiene incluso sin necesitar disparar jamás el
--        chequeo explícito de conteo. Con 2 owners, remover a UNO de ellos sí es
--        legítimo (deja 1) -- se demuestra que el chequeo de conteo no bloquea ese
--        caso normal por error.
--     7. Esquema de PRODUCCIÓN a medio migrar (0022 no aplicada) -- SQLSTATE 42883,
--        recuperado con SAVEPOINT/ROLLBACK TO SAVEPOINT (mismo mecanismo que
--        runWithSavepointFallback en producción).
--
--   B. packages/domain-restaurantes/migrations/
--      021_restaurantes_config_editable_y_search_path_fix.sql (whatsapp_channel_
--      config/known_zone -- INSERT/UPDATE/DELETE nuevos):
--     8. Positivo: owner Y admin reales de la organización pueden conectar un
--        número de WhatsApp / agregar-borrar una zona conocida.
--     9. Negativo (rol insuficiente): "staff"/"repartidor" real de la MISMA
--        organización -- RECHAZADO por RLS (42501), aunque "staff" SÍ pase
--        MANAGER_ROLES para el catálogo (categories/products) -- esta config es
--        MÁS angosta (solo owner/admin) por diseño explícito de esta fase.
--    10. Cross-tenant: un owner real de OTRA organización -- RECHAZADO.
--    11. `anon` rechazado por completo (sin GRANT).
--    12. Esquema de PRODUCCIÓN a medio migrar (021 no aplicada) -- SQLSTATE 42501
--        (la tabla YA EXISTE, a diferencia de audit_log -- lo que falta es el
--        GRANT/policy de escritura), recuperado con SAVEPOINT/ROLLBACK TO SAVEPOINT.
--
-- Run vía ./run.sh -- ver ese archivo para cómo se levanta el Postgres efímero + el
-- mock mínimo de plataforma (mismo patrón que scripts/verify-restaurantes-audit-log/).
--
-- Cada escenario corre en su propio `begin; ... rollback;` -- nada de esto persiste
-- (salvo las fixtures de abajo, insertadas directo como el superusuario que corre el
-- script, igual que el resto de scripts/verify-*/).
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000000f1', 'restaurantes', 'Org A (config/baja)', 'org-a-config-baja'),
  ('00000000-0000-0000-0000-0000000000f2', 'restaurantes', 'Org B (config/baja, ajena)', 'org-b-config-baja')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-000000000031', 'owner-a@example.com', 'Owner A', 'seed'),
  ('00000000-0000-0000-0000-000000000032', 'admin-a@example.com', 'Admin A', 'seed'),
  ('00000000-0000-0000-0000-000000000033', 'staff-a@example.com', 'Staff A', 'seed'),
  ('00000000-0000-0000-0000-000000000034', 'repartidor-a@example.com', 'Repartidor A', 'seed'),
  ('00000000-0000-0000-0000-000000000035', 'segundo-owner-a@example.com', 'Segundo Owner A', 'seed'),
  ('00000000-0000-0000-0000-000000000036', 'owner-b@example.com', 'Owner B (ajeno)', 'seed')
on conflict do nothing;

-- 31: owner real de la Org A. 32: admin real de la Org A. 33: staff real de la Org A
-- (MANAGER_ROLES, pero rango < admin para esta autoridad). 34: repartidor real de la
-- Org A (rango más bajo). 35: SEGUNDO owner de la Org A (solo para el escenario de
-- "2 owners, remover a uno es legítimo"). 36: owner real, pero de la Org B (ajeno).
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-000000000031', '00000000-0000-0000-0000-0000000000f1', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-000000000032', '00000000-0000-0000-0000-0000000000f1', null, 'admin', 'admin'),
  ('00000000-0000-0000-0000-000000000033', '00000000-0000-0000-0000-0000000000f1', null, 'member', 'staff'),
  ('00000000-0000-0000-0000-000000000034', '00000000-0000-0000-0000-0000000000f1', null, 'member', 'repartidor'),
  ('00000000-0000-0000-0000-000000000035', '00000000-0000-0000-0000-0000000000f1', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-000000000036', '00000000-0000-0000-0000-0000000000f2', null, 'owner', 'owner')
on conflict do nothing;

\echo ''
\echo '=== A) core.remove_membership -- baja de staff activo ==='
\echo ''

\echo '--- 1. positivo: owner de la Org A da de baja a "staff" (rango menor) -- el membership desaparece de verdad ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000031', true);
select core.remove_membership('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-000000000033');
select count(*)::int as membership_deberia_ser_0
from core.membership where organization_id = '00000000-0000-0000-0000-0000000000f1' and user_id = '00000000-0000-0000-0000-000000000033';
rollback;

\echo '--- 2. positivo: admin de la Org A da de baja a "repartidor" (rango menor) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000032', true);
select core.remove_membership('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-000000000034');
select count(*)::int as membership_deberia_ser_0
from core.membership where organization_id = '00000000-0000-0000-0000-0000000000f1' and user_id = '00000000-0000-0000-0000-000000000034';
rollback;

\echo '--- 3. NEGATIVO (rol insuficiente): "staff" real (member) intenta dar de baja a "repartidor" (rango aun menor) -- RECHAZADO, rango < admin ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000033', true);
select core.remove_membership('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-000000000034') as should_fail;
rollback;

\echo '--- 4. NEGATIVO (rol insuficiente): "admin" real intenta dar de baja a "owner" (rango MAYOR) -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000032', true);
select core.remove_membership('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-000000000031') as should_fail;
rollback;

\echo '--- 5. CROSS-TENANT: owner real de la Org B intenta dar de baja a "staff" de la Org A -- RECHAZADO ("no perteneces a esta organización"), aunque security definer bypasse RLS ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000036', true);
select core.remove_membership('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-000000000033') as should_fail;
rollback;

\echo '--- 6. ANON: sin GRANT de EXECUTE -- RECHAZADO por completo ---'
begin;
set local role anon;
select core.remove_membership('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-000000000033') as should_fail;
rollback;

\echo '--- 7. auto-baja SIEMPRE bloqueada: el owner (único, sin otro owner en esta transaccion) NUNCA puede darse de baja a si mismo ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000031', true);
select core.remove_membership('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-000000000031') as should_fail;
rollback;

\echo '--- 8. "no dejar la organizacion sin ningun owner" -- demostrado por EXHAUSTIVIDAD: con Org A en su estado normal (UN SOLO owner, 31), NINGUN caller posible puede removerlo. Ya lo prueban los escenarios 4 (admin, rango menor -> rechazado) y 7 (el propio owner -> auto-baja rechazada) -- staff/repartidor tienen aun MENOS rango que admin, asi que tambien quedan cubiertos por la regla de rango. La invariante "siempre queda >= 1 owner" se sostiene por construccion, sin necesitar nunca el chequeo explicito de conteo. Este escenario demuestra la otra mitad: con DOS owners reales (31 y 35), remover a UNO SI es legitimo (deja 1 owner, nunca 0) -- el chequeo de conteo no bloquea por error el caso normal. ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000031', true);
select core.remove_membership('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-000000000035');
select count(*)::int as segundo_owner_removido_deberia_ser_0
from core.membership where organization_id = '00000000-0000-0000-0000-0000000000f1' and user_id = '00000000-0000-0000-0000-000000000035';
select count(*)::int as primer_owner_sigue_ahi_deberia_ser_1
from core.membership where organization_id = '00000000-0000-0000-0000-0000000000f1' and user_id = '00000000-0000-0000-0000-000000000031';
rollback;

\echo '--- 9. esquema a medio migrar: con core.remove_membership ELIMINADA dentro de esta MISMA transaccion, la llamada REAL que PostgresCoreRepository.removeMembership emite falla con SQLSTATE 42883 -- SAVEPOINT + ROLLBACK TO SAVEPOINT recupera la transaccion: la query siguiente SI corre (nunca 25P02) ---'
begin;
drop function core.remove_membership(uuid, uuid);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000031', true);
savepoint sp_verify_remove_membership;
do $$
declare
  v_state text;
begin
  begin
    -- Mismo texto SQL EXACTO que PostgresCoreRepository.removeMembership emite
    -- realmente, ver packages/db/src/postgres-core-repository.ts.
    perform core.remove_membership('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-000000000033');
    raise exception 'se esperaba SQLSTATE 42883 (funcion eliminada), pero no fallo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    if v_state <> '42883' then
      raise exception 'se esperaba SQLSTATE 42883, se obtuvo %', v_state;
    end if;
  end;
end $$;
rollback to savepoint sp_verify_remove_membership;
release savepoint sp_verify_remove_membership;
select 1 as transaccion_recuperada_tras_42883_deberia_ser_1;
rollback;

\echo ''
\echo '=== B) whatsapp_channel_config / known_zone -- configuracion editable (owner/admin) ==='
\echo ''

\echo '--- 10. positivo: owner de la Org A conecta un numero de WhatsApp ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000031', true);
insert into restaurantes.whatsapp_channel_config (organization_id, phone_number_id) values ('00000000-0000-0000-0000-0000000000f1', '15550001111')
  on conflict (organization_id) do update set phone_number_id = excluded.phone_number_id
  returning phone_number_id;
rollback;

\echo '--- 11. positivo: admin de la Org A TAMBIEN puede (mismo umbral que owner) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000032', true);
insert into restaurantes.whatsapp_channel_config (organization_id, phone_number_id) values ('00000000-0000-0000-0000-0000000000f1', '15550002222')
  on conflict (organization_id) do update set phone_number_id = excluded.phone_number_id
  returning phone_number_id;
rollback;

\echo '--- 12. NEGATIVO (rol insuficiente): "staff" real de la MISMA organizacion -- RECHAZADO (esta config es mas angosta que MANAGER_ROLES) ---'
begin;
-- as should_fail (INSERT no admite `as alias` al final de VALUES(...); este
-- comentario, dentro del bloque begin;/rollback;, es lo que el runner automático
-- detecta para marcar el escenario como "debe terminar en ERROR" -- mismo criterio
-- que scripts/verify-restaurantes-audit-log/assertions.sql, escenario 18).
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000033', true);
insert into restaurantes.whatsapp_channel_config (organization_id, phone_number_id) values ('00000000-0000-0000-0000-0000000000f1', '15550003333');
rollback;

\echo '--- 13. CROSS-TENANT: owner real de la Org B -- RECHAZADO ---'
begin;
-- as should_fail (ver nota del escenario 12).
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000036', true);
insert into restaurantes.whatsapp_channel_config (organization_id, phone_number_id) values ('00000000-0000-0000-0000-0000000000f1', '15550004444');
rollback;

\echo '--- 14. ANON: sin GRANT de INSERT -- RECHAZADO por completo ---'
begin;
-- as should_fail (ver nota del escenario 12).
set local role anon;
insert into restaurantes.whatsapp_channel_config (organization_id, phone_number_id) values ('00000000-0000-0000-0000-0000000000f1', '15550005555');
rollback;

\echo '--- 15. positivo: owner de la Org A agrega una zona conocida y luego la borra ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000031', true);
insert into restaurantes.known_zone (organization_id, name, lat, lng) values ('00000000-0000-0000-0000-0000000000f1', 'Zona Verify', 21.0, -89.0) returning id;
delete from restaurantes.known_zone where organization_id = '00000000-0000-0000-0000-0000000000f1' and name = 'Zona Verify' returning id;
rollback;

\echo '--- 16. NEGATIVO (rol insuficiente): "repartidor" real intenta agregar una zona conocida -- RECHAZADO ---'
begin;
-- as should_fail (ver nota del escenario 12).
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000034', true);
insert into restaurantes.known_zone (organization_id, name, lat, lng) values ('00000000-0000-0000-0000-0000000000f1', 'Zona Rechazada', 21.0, -89.0);
rollback;

\echo '--- 17. CROSS-TENANT: owner real de la Org B intenta borrar una zona conocida de la Org A -- 0 filas afectadas (RLS deja pasar el DELETE sin match, nunca un error -- mismo criterio que el resto del repo: "cero filas", nunca fuga de datos) ---'
insert into restaurantes.known_zone (id, organization_id, name, lat, lng) values ('00000000-0000-0000-0000-0000000000fa', '00000000-0000-0000-0000-0000000000f1', 'Zona Cross Tenant', 21.0, -89.0)
on conflict do nothing;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000036', true);
with borrado as (
  delete from restaurantes.known_zone where id = '00000000-0000-0000-0000-0000000000fa' returning id
)
select count(*)::int as filas_borradas_deberia_ser_0 from borrado;
rollback;
delete from restaurantes.known_zone where id = '00000000-0000-0000-0000-0000000000fa';

\echo '--- 18. esquema a medio migrar: con el GRANT de INSERT de whatsapp_channel_config REVOCADO dentro de esta MISMA transaccion (021 aun no aplicada en la base real), la llamada REAL que PostgresRestaurantesRepository.upsertWhatsappChannelConfig emite falla con SQLSTATE 42501 -- SAVEPOINT + ROLLBACK TO SAVEPOINT recupera la transaccion ---'
begin;
revoke insert on restaurantes.whatsapp_channel_config from authenticated;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000031', true);
savepoint sp_verify_whatsapp_config_write;
do $$
declare
  v_state text;
begin
  begin
    -- Mismo texto SQL EXACTO que PostgresRestaurantesRepository.
    -- upsertWhatsappChannelConfig emite realmente.
    insert into restaurantes.whatsapp_channel_config (organization_id, phone_number_id) values ('00000000-0000-0000-0000-0000000000f1', '15559998888')
      on conflict (organization_id) do update set phone_number_id = excluded.phone_number_id;
    raise exception 'se esperaba SQLSTATE 42501 (GRANT revocado), pero no fallo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    if v_state <> '42501' then
      raise exception 'se esperaba SQLSTATE 42501, se obtuvo %', v_state;
    end if;
  end;
end $$;
rollback to savepoint sp_verify_whatsapp_config_write;
release savepoint sp_verify_whatsapp_config_write;
select 1 as transaccion_recuperada_tras_42501_deberia_ser_1;
rollback;
