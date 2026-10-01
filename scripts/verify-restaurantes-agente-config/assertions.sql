-- Fixtures + escenarios contra Postgres REAL (RLS + GRANT por columna reales -- nunca el repositorio en
-- memoria) de packages/domain-restaurantes/migrations/029_whatsapp_agent_config.sql
-- (restaurantes.whatsapp_agent_config).
--
-- Cada escenario corre en su propio `begin; ... rollback;`. Un escenario "RECHAZADO" termina en ERROR real de
-- Postgres (lo marca el comentario `-- as should_fail`); un escenario de conteo termina en `..._deberia_ser_N`.
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000d0001', 'restaurantes', 'PM Org A', 'pm-cfg-a'),
  ('00000000-0000-0000-0000-0000000d0002', 'restaurantes', 'PM Org B (ajena)', 'pm-cfg-b')
on conflict do nothing;

insert into core.property (id, organization_id, name) values
  ('00000000-0000-0000-0000-0000000d00a1', '00000000-0000-0000-0000-0000000d0001', 'Sucursal A1'),
  ('00000000-0000-0000-0000-0000000d00a2', '00000000-0000-0000-0000-0000000d0001', 'Sucursal A2'),
  ('00000000-0000-0000-0000-0000000d00b1', '00000000-0000-0000-0000-0000000d0002', 'Sucursal B1')
on conflict do nothing;

insert into restaurantes.branch_detail (property_id, organization_id, slug) values
  ('00000000-0000-0000-0000-0000000d00a1', '00000000-0000-0000-0000-0000000d0001', 'a1'),
  ('00000000-0000-0000-0000-0000000d00a2', '00000000-0000-0000-0000-0000000d0001', 'a2'),
  ('00000000-0000-0000-0000-0000000d00b1', '00000000-0000-0000-0000-0000000d0002', 'b1')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000d0011', 'owner-a@cfg.example.com', 'Owner A', 'seed'),
  ('00000000-0000-0000-0000-0000000d0012', 'admin-a@cfg.example.com', 'Admin A', 'seed'),
  ('00000000-0000-0000-0000-0000000d0013', 'staff-a@cfg.example.com', 'Staff A', 'seed'),
  ('00000000-0000-0000-0000-0000000d0014', 'owner-b@cfg.example.com', 'Owner B (ajeno)', 'seed')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000d0011', '00000000-0000-0000-0000-0000000d0001', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000d0012', '00000000-0000-0000-0000-0000000d0001', null, 'admin', 'admin'),
  ('00000000-0000-0000-0000-0000000d0013', '00000000-0000-0000-0000-0000000d0001', null, 'member', 'staff'),
  ('00000000-0000-0000-0000-0000000d0014', '00000000-0000-0000-0000-0000000d0002', null, 'owner', 'owner')
on conflict do nothing;

-- Datos previos (insertados como superusuario): config de la organizacion A y de la sucursal A2, y una
-- apagada de la organizacion B.
insert into restaurantes.whatsapp_agent_config (organization_id, property_id, perfil, agent_name, delivery_time_text) values
  ('00000000-0000-0000-0000-0000000d0001', null, 'taqueria_pm', 'Lupita', 'de 40 a 50 minutos'),
  ('00000000-0000-0000-0000-0000000d0001', '00000000-0000-0000-0000-0000000d00a2', 'taqueria_pm', 'Mari', 'de 50 a 60 minutos');
insert into restaurantes.whatsapp_agent_config (organization_id, property_id, perfil, enabled) values
  ('00000000-0000-0000-0000-0000000d0002', null, 'taqueria_pm', false);

\echo '=== A1. POSITIVO: owner de A crea la config de la sucursal A1 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0011', true);
insert into restaurantes.whatsapp_agent_config (organization_id, property_id, perfil, agent_name, tone_style)
  values ('00000000-0000-0000-0000-0000000d0001', '00000000-0000-0000-0000-0000000d00a1', 'taqueria_pm', 'Rosa', 'formal_directo')
  returning property_id, perfil, agent_name;
rollback;

\echo '=== A2. POSITIVO: el upsert EXACTO del repositorio (organizacion) como admin de A: on conflict sobre el indice parcial actualiza la fila existente ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0012', true);
insert into restaurantes.whatsapp_agent_config (organization_id, property_id, perfil, agent_name, business_name, tone_style, delivery_time_text, enabled, updated_at)
values ('00000000-0000-0000-0000-0000000d0001', null, 'taqueria_pm', 'Lupe', null, null, 'de 45 a 55 minutos', true, now())
on conflict (organization_id) where property_id is null do update set
  perfil = excluded.perfil, agent_name = excluded.agent_name, business_name = excluded.business_name,
  tone_style = excluded.tone_style, delivery_time_text = excluded.delivery_time_text, enabled = true, updated_at = excluded.updated_at
returning property_id, agent_name, delivery_time_text;
rollback;

\echo '=== A3. POSITIVO: el upsert EXACTO del repositorio (sucursal A2) como owner de A: actualiza, no duplica ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0011', true);
insert into restaurantes.whatsapp_agent_config (organization_id, property_id, perfil, agent_name, business_name, tone_style, delivery_time_text, enabled, updated_at)
values ('00000000-0000-0000-0000-0000000d0001', '00000000-0000-0000-0000-0000000d00a2', 'taqueria_pm', 'Mariana', null, null, null, true, now())
on conflict (organization_id, property_id) where property_id is not null do update set
  perfil = excluded.perfil, agent_name = excluded.agent_name, business_name = excluded.business_name,
  tone_style = excluded.tone_style, delivery_time_text = excluded.delivery_time_text, enabled = true, updated_at = excluded.updated_at
returning property_id, agent_name;
select count(*)::int as filas_de_a2_tras_upsert_deberia_ser_1 from restaurantes.whatsapp_agent_config where property_id = '00000000-0000-0000-0000-0000000d00a2';
rollback;

\echo '=== A4. RECHAZADO (debe fallar): staff de A (rol staff, no owner/admin) no crea config ==='
begin;
-- as should_fail (INSERT sin alias)
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0013', true);
insert into restaurantes.whatsapp_agent_config (organization_id, property_id, perfil)
  values ('00000000-0000-0000-0000-0000000d0001', '00000000-0000-0000-0000-0000000d00a1', 'taqueria_pm');
rollback;

\echo '=== A5. RECHAZADO (debe fallar): owner de B escribe para una property de A declarando SU organizacion (property no pertenece a la org declarada) ==='
begin;
-- as should_fail (INSERT sin alias)
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0014', true);
insert into restaurantes.whatsapp_agent_config (organization_id, property_id, perfil)
  values ('00000000-0000-0000-0000-0000000d0002', '00000000-0000-0000-0000-0000000d00a1', 'taqueria_pm');
rollback;

\echo '=== A6. RECHAZADO (debe fallar): owner de B declara la organizacion A (no es miembro de A) ==='
begin;
-- as should_fail (INSERT sin alias)
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0014', true);
insert into restaurantes.whatsapp_agent_config (organization_id, property_id, perfil)
  values ('00000000-0000-0000-0000-0000000d0001', null, 'taqueria_pm');
rollback;

\echo '=== A7. RECHAZADO (debe fallar): unicidad -- una segunda fila de organizacion (property null) viola el indice parcial ==='
begin;
-- as should_fail (INSERT sin alias)
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0011', true);
insert into restaurantes.whatsapp_agent_config (organization_id, property_id, perfil)
  values ('00000000-0000-0000-0000-0000000d0001', null, 'generico');
rollback;

\echo '=== A8. RECHAZADO (debe fallar): CHECK de perfil -- un perfil inventado no entra ==='
begin;
-- as should_fail (INSERT sin alias)
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0011', true);
insert into restaurantes.whatsapp_agent_config (organization_id, property_id, perfil)
  values ('00000000-0000-0000-0000-0000000d0001', '00000000-0000-0000-0000-0000000d00a1', 'perfil_inventado');
rollback;

\echo '=== A9. RECHAZADO (debe fallar): CHECK de longitud -- un nombre de agente de 61 caracteres no entra (acota el texto libre que llega al prompt) ==='
begin;
-- as should_fail (INSERT sin alias)
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0011', true);
insert into restaurantes.whatsapp_agent_config (organization_id, property_id, perfil, agent_name)
  values ('00000000-0000-0000-0000-0000000d0001', '00000000-0000-0000-0000-0000000d00a1', 'taqueria_pm', repeat('x', 61));
rollback;

\echo '=== A10. RECHAZADO (debe fallar): GRANT por columna -- ni el owner puede mover organization_id de una fila ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0011', true);
update restaurantes.whatsapp_agent_config set organization_id = '00000000-0000-0000-0000-0000000d0002' where property_id is null and organization_id = '00000000-0000-0000-0000-0000000d0001' returning 1 as should_fail;
rollback;

\echo '=== A11. RECHAZADO (debe fallar): GRANT por columna -- ni el owner puede mover property_id de una fila ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0011', true);
update restaurantes.whatsapp_agent_config set property_id = '00000000-0000-0000-0000-0000000d00a1' where property_id = '00000000-0000-0000-0000-0000000d00a2' returning 1 as should_fail;
rollback;

\echo '=== A12. CROSS-TENANT: owner de B no actualiza la config de A (RLS filtra: 0 filas, nunca error ni fuga) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0014', true);
with actualizado as (
  update restaurantes.whatsapp_agent_config set agent_name = 'hackeado' where organization_id = '00000000-0000-0000-0000-0000000d0001' returning id
)
select count(*)::int as filas_actualizadas_cross_tenant_deberia_ser_0 from actualizado;
rollback;

\echo '=== A13. ROL INSUFICIENTE: staff de A no actualiza la config (0 filas) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0013', true);
with actualizado as (
  update restaurantes.whatsapp_agent_config set agent_name = 'staff' where organization_id = '00000000-0000-0000-0000-0000000d0001' returning id
)
select count(*)::int as filas_actualizadas_por_staff_deberia_ser_0 from actualizado;
rollback;

\echo '=== A14. RECHAZADO (debe fallar): no hay DELETE para authenticated (se apaga con enabled = false) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0011', true);
delete from restaurantes.whatsapp_agent_config where organization_id = '00000000-0000-0000-0000-0000000d0001' returning 1 as should_fail;
rollback;

\echo '=== A15. LECTURA: staff de A ve solo las 2 filas de su organizacion ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0013', true);
select count(*)::int as filas_visibles_para_staff_de_a_deberia_ser_2 from restaurantes.whatsapp_agent_config;
rollback;

\echo '=== A16. LECTURA CROSS-TENANT: el owner de B no ve ninguna fila de A (solo la suya, apagada) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0014', true);
select count(*)::int as filas_de_a_visibles_para_b_deberia_ser_0 from restaurantes.whatsapp_agent_config where organization_id = '00000000-0000-0000-0000-0000000d0001';
rollback;

\echo '=== A17. SISTEMA SIN USUARIO (webhook de WhatsApp): lee con el SQL EXACTO del lector; la fila de la sucursal manda sobre la de la organizacion ==='
begin;
set local role authenticated;
select count(*)::int as precedencia_sucursal_sobre_organizacion_deberia_ser_1
from (
  select property_id, agent_name from restaurantes.whatsapp_agent_config
   where organization_id = '00000000-0000-0000-0000-0000000d0001' and enabled = true
     and (property_id = '00000000-0000-0000-0000-0000000d00a2' or property_id is null)
   order by (property_id is null) asc
   limit 1
) r where r.agent_name = 'Mari';
rollback;

\echo '=== A18. SISTEMA SIN USUARIO: sin fila propia de la sucursal A1, cae a la de la organizacion ==='
begin;
set local role authenticated;
select count(*)::int as sin_fila_propia_cae_a_la_organizacion_deberia_ser_1
from (
  select property_id, agent_name from restaurantes.whatsapp_agent_config
   where organization_id = '00000000-0000-0000-0000-0000000d0001' and enabled = true
     and (property_id = '00000000-0000-0000-0000-0000000d00a1' or property_id is null)
   order by (property_id is null) asc
   limit 1
) r where r.agent_name = 'Lupita';
rollback;

\echo '=== A19. FILA APAGADA: con enabled = false el lector no la devuelve (cae al agente generico) ==='
begin;
set local role authenticated;
select count(*)::int as fila_apagada_ignorada_deberia_ser_0
from (
  select 1 from restaurantes.whatsapp_agent_config
   where organization_id = '00000000-0000-0000-0000-0000000d0002' and enabled = true and (property_id is null)
) r;
rollback;

\echo '=== A20. RECHAZADO (debe fallar): anon no lee la tabla ==='
begin;
set local role anon;
select count(*) as should_fail from restaurantes.whatsapp_agent_config;
rollback;

\echo '=== A21. RECHAZADO (debe fallar): anon no inserta ==='
begin;
-- as should_fail (INSERT sin alias)
set local role anon;
insert into restaurantes.whatsapp_agent_config (organization_id, perfil) values ('00000000-0000-0000-0000-0000000d0001', 'taqueria_pm');
rollback;

\echo '=== E1. BASE SIN MIGRAR: con la tabla eliminada, el SQL real del lector falla con 42P01 y SAVEPOINT recupera la transaccion ==='
begin;
drop table restaurantes.whatsapp_agent_config;
savepoint sp_verify_whatsapp_agent_config_read;
do $$
declare
  v_state text;
begin
  begin
    perform property_id, perfil from restaurantes.whatsapp_agent_config where organization_id = '00000000-0000-0000-0000-0000000d0001' and enabled = true;
    raise exception 'se esperaba SQLSTATE 42P01, pero no fallo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    if v_state <> '42P01' then
      raise exception 'se esperaba SQLSTATE 42P01, se obtuvo %', v_state;
    end if;
  end;
end $$;
rollback to savepoint sp_verify_whatsapp_agent_config_read;
release savepoint sp_verify_whatsapp_agent_config_read;
select count(*)::int as organizacion_sigue_leyendo_deberia_ser_1 from core.organization where id = '00000000-0000-0000-0000-0000000d0001';
rollback;
