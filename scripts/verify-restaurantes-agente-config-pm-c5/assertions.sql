-- Fixtures + escenarios contra Postgres REAL (RLS + GRANT por columna reales -- nunca el repositorio en memoria) de
-- packages/domain-restaurantes/migrations/039_agente_config_umbral_y_rafagas.sql: columnas `large_order_text` (umbral de pedido
-- grande) y `reply_debounce_seconds` (espera de rafagas) de restaurantes.whatsapp_agent_config.
--
-- Cada escenario corre en su propio `begin; ... rollback;`. Un escenario "RECHAZADO" termina en ERROR real de Postgres (lo marca el
-- comentario `-- as should_fail`); un escenario de conteo termina en `..._deberia_ser_N`.
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000f0001', 'restaurantes', 'PM Org A', 'pm-c5-a'),
  ('00000000-0000-0000-0000-0000000f0002', 'restaurantes', 'PM Org B (ajena)', 'pm-c5-b')
on conflict do nothing;

insert into core.property (id, organization_id, name) values
  ('00000000-0000-0000-0000-0000000f00a1', '00000000-0000-0000-0000-0000000f0001', 'Sucursal A1'),
  ('00000000-0000-0000-0000-0000000f00b1', '00000000-0000-0000-0000-0000000f0002', 'Sucursal B1')
on conflict do nothing;

insert into restaurantes.branch_detail (property_id, organization_id, slug) values
  ('00000000-0000-0000-0000-0000000f00a1', '00000000-0000-0000-0000-0000000f0001', 'a1'),
  ('00000000-0000-0000-0000-0000000f00b1', '00000000-0000-0000-0000-0000000f0002', 'b1')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000f0011', 'owner-a@pmc5.example.com', 'Owner A', 'seed'),
  ('00000000-0000-0000-0000-0000000f0013', 'staff-a@pmc5.example.com', 'Staff A', 'seed'),
  ('00000000-0000-0000-0000-0000000f0014', 'owner-b@pmc5.example.com', 'Owner B (ajeno)', 'seed')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000f0011', '00000000-0000-0000-0000-0000000f0001', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000f0013', '00000000-0000-0000-0000-0000000f0001', null, 'member', 'staff'),
  ('00000000-0000-0000-0000-0000000f0014', '00000000-0000-0000-0000-0000000f0002', null, 'owner', 'owner')
on conflict do nothing;

-- Config previa (insertada como superusuario): una fila de la organizacion A creada como antes de la 039 (sin las columnas nuevas).
insert into restaurantes.whatsapp_agent_config (organization_id, property_id, perfil, agent_name, delivery_time_text) values
  ('00000000-0000-0000-0000-0000000f0001', null, 'taqueria_pm', 'Lupita', 'de 40 a 50 minutos');

\echo '=== P1. COMPATIBILIDAD: las filas previas quedan con NULL en las dos columnas nuevas (= valores por omision del perfil) ==='
begin;
select count(*)::int as filas_previas_con_null_deberia_ser_1
  from restaurantes.whatsapp_agent_config
  where organization_id = '00000000-0000-0000-0000-0000000f0001' and large_order_text is null and reply_debounce_seconds is null;
rollback;

\echo '=== P2. COMPATIBILIDAD: el SELECT anterior (033, sin las columnas nuevas) sigue funcionando igual ==='
begin;
select count(*)::int as lector_anterior_sigue_funcionando_deberia_ser_1
  from (select property_id, perfil, agent_name, business_name, tone_style, delivery_time_text, greeting_text, salsas_text, promos_text, escalation_reasons_off, version
          from restaurantes.whatsapp_agent_config where organization_id = '00000000-0000-0000-0000-0000000f0001') t;
rollback;

\echo '=== P3. POSITIVO: el upsert EXACTO del repositorio (organizacion) como owner de A guarda el umbral y la espera ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0011', true);
insert into restaurantes.whatsapp_agent_config as c
  (organization_id, property_id, perfil, agent_name, business_name, tone_style, delivery_time_text, greeting_text, salsas_text, promos_text, escalation_reasons_off, large_order_text, reply_debounce_seconds, enabled, version, updated_at)
values ('00000000-0000-0000-0000-0000000f0001', null, 'taqueria_pm', 'Lupita', null, null, null, null, null, null, '{}'::text[], 'más de $5,000 o más de 6 kg', 6, true, 1, now())
on conflict (organization_id) where property_id is null do update set
  large_order_text = excluded.large_order_text, reply_debounce_seconds = excluded.reply_debounce_seconds, version = c.version + 1, updated_at = excluded.updated_at
returning property_id, large_order_text, reply_debounce_seconds, version;
select count(*)::int as umbral_y_espera_guardados_deberia_ser_1 from restaurantes.whatsapp_agent_config where organization_id = '00000000-0000-0000-0000-0000000f0001' and large_order_text = 'más de $5,000 o más de 6 kg' and reply_debounce_seconds = 6;
rollback;

\echo '=== P4. POSITIVO: espera 0 (apagada) y 30 (tope) entran; NULL tambien ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0011', true);
update restaurantes.whatsapp_agent_config set reply_debounce_seconds = 0 where organization_id = '00000000-0000-0000-0000-0000000f0001' returning reply_debounce_seconds;
update restaurantes.whatsapp_agent_config set reply_debounce_seconds = 30 where organization_id = '00000000-0000-0000-0000-0000000f0001' returning reply_debounce_seconds;
update restaurantes.whatsapp_agent_config set reply_debounce_seconds = null where organization_id = '00000000-0000-0000-0000-0000000f0001' returning reply_debounce_seconds;
rollback;

\echo '=== P5. RECHAZADO (debe fallar): CHECK -- una espera de 31 s no entra (la funcion del webhook dura 30 s) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0011', true);
-- as should_fail
update restaurantes.whatsapp_agent_config set reply_debounce_seconds = 31 where organization_id = '00000000-0000-0000-0000-0000000f0001' returning reply_debounce_seconds;
rollback;

\echo '=== P6. RECHAZADO (debe fallar): CHECK -- una espera negativa no entra ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0011', true);
-- as should_fail
update restaurantes.whatsapp_agent_config set reply_debounce_seconds = -1 where organization_id = '00000000-0000-0000-0000-0000000f0001' returning reply_debounce_seconds;
rollback;

\echo '=== P7. RECHAZADO (debe fallar): CHECK de longitud -- un umbral de 201 caracteres no entra (acota el texto libre que llega al prompt) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0011', true);
-- as should_fail
update restaurantes.whatsapp_agent_config set large_order_text = repeat('x', 201) where organization_id = '00000000-0000-0000-0000-0000000f0001' returning large_order_text;
rollback;

\echo '=== P8. RECHAZADO (debe fallar): CHECK de longitud -- un umbral vacio no entra (vacio = NULL, se guarda como NULL) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0011', true);
-- as should_fail
update restaurantes.whatsapp_agent_config set large_order_text = '' where organization_id = '00000000-0000-0000-0000-0000000f0001' returning large_order_text;
rollback;

\echo '=== P9. ROL INSUFICIENTE: staff de A no cambia el umbral (RLS filtra: 0 filas) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0013', true);
with actualizado as (
  update restaurantes.whatsapp_agent_config set large_order_text = 'más de $1', reply_debounce_seconds = 5 where organization_id = '00000000-0000-0000-0000-0000000f0001' returning 1
)
select count(*)::int as filas_actualizadas_por_staff_deberia_ser_0 from actualizado;
rollback;

\echo '=== P10. CROSS-TENANT: owner de B no cambia el umbral de A (RLS filtra: 0 filas, nunca error ni fuga) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0014', true);
with actualizado as (
  update restaurantes.whatsapp_agent_config set large_order_text = 'más de $1', reply_debounce_seconds = 5 where organization_id = '00000000-0000-0000-0000-0000000f0001' returning 1
)
select count(*)::int as filas_actualizadas_cross_tenant_deberia_ser_0 from actualizado;
rollback;

\echo '=== P11. CROSS-TENANT: owner de B no crea una fila de A con el umbral (RLS with check) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0014', true);
-- as should_fail
insert into restaurantes.whatsapp_agent_config (organization_id, property_id, perfil, large_order_text, reply_debounce_seconds)
  values ('00000000-0000-0000-0000-0000000f0001', '00000000-0000-0000-0000-0000000f00a1', 'taqueria_pm', 'más de $1', 5) returning property_id;
rollback;

\echo '=== P12. RECHAZADO (debe fallar): anon no lee las columnas nuevas ==='
begin;
set local role anon;
-- as should_fail
select large_order_text, reply_debounce_seconds from restaurantes.whatsapp_agent_config;
rollback;

\echo '=== P13. RECHAZADO (debe fallar): anon no escribe las columnas nuevas ==='
begin;
set local role anon;
-- as should_fail
update restaurantes.whatsapp_agent_config set reply_debounce_seconds = 5 returning 1;
rollback;

\echo '=== P14. SISTEMA SIN USUARIO (webhook de WhatsApp, rol del backend): lee las columnas nuevas con el SELECT exacto del lector ==='
begin;
update restaurantes.whatsapp_agent_config set large_order_text = 'más de $5,000', reply_debounce_seconds = 6 where organization_id = '00000000-0000-0000-0000-0000000f0001';
select count(*)::int as lector_nuevo_ve_las_columnas_deberia_ser_1
  from (select property_id, perfil, agent_name, business_name, tone_style, delivery_time_text, greeting_text, salsas_text, promos_text, escalation_reasons_off, large_order_text, reply_debounce_seconds, version
          from restaurantes.whatsapp_agent_config
         where organization_id = '00000000-0000-0000-0000-0000000f0001' and enabled = true and (property_id = '00000000-0000-0000-0000-0000000f00a1' or property_id is null)
         order by (property_id is null) asc limit 1) t
 where t.large_order_text = 'más de $5,000' and t.reply_debounce_seconds = 6;
rollback;

\echo '=== E1. BASE SIN MIGRAR (columna 039 ausente): el SELECT nuevo falla con 42703 y SAVEPOINT recupera la transaccion para leer con el SELECT de 033 ==='
begin;
alter table restaurantes.whatsapp_agent_config drop column reply_debounce_seconds, drop column large_order_text;
savepoint sp_lector_039;
do $$
declare
  v_state text;
begin
  begin
    perform large_order_text, reply_debounce_seconds from restaurantes.whatsapp_agent_config where organization_id = '00000000-0000-0000-0000-0000000f0001';
    raise exception 'se esperaba SQLSTATE 42703, pero no fallo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    if v_state <> '42703' then
      raise exception 'se esperaba SQLSTATE 42703, se obtuvo %', v_state;
    end if;
  end;
end $$;
rollback to savepoint sp_lector_039;
release savepoint sp_lector_039;
select count(*)::int as lector_033_sigue_leyendo_deberia_ser_1
  from (select property_id, perfil, agent_name, greeting_text, version from restaurantes.whatsapp_agent_config where organization_id = '00000000-0000-0000-0000-0000000f0001') t;
rollback;
