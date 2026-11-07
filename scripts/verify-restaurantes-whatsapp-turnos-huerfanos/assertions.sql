-- Fixtures + escenarios contra Postgres REAL de packages/domain-restaurantes/migrations/192_whatsapp_turnos_huerfanos.sql.
--
--   A. Positivo: la sesion de sistema reclama los mensajes huerfanos (processing con mas de 90 s, failed reintentable) de organizaciones con cerebro_v2 y los
--      marca processing con intentos + 1; p_todas incluye a las demas; p_limite se acota a 1..10.
--   B. Aislamiento: el telefono y el numero emisor salen de la conversacion y el canal de la MISMA organizacion (cross-tenant).
--   C. Autorizacion: un usuario autenticado (auth.uid() no nulo) -> 42501; anon -> 42501.
--
-- Convenciones del gate (run-gate.mjs): cada escenario es `begin; ... rollback;`; los alias con sufijo deberia_ser_N marcan el valor esperado.
\set ON_ERROR_STOP off
\pset pager off

create or replace function public.t_esperar_error(p_sql text, p_estado text) returns void
language plpgsql as $$
declare
  v text;
begin
  begin
    execute p_sql;
  exception when others then
    get stacked diagnostics v = returned_sqlstate;
    if v <> p_estado then
      raise exception 'se esperaba SQLSTATE %, se obtuvo % (%)', p_estado, v, sqlerrm;
    end if;
    return;
  end;
  raise exception 'se esperaba SQLSTATE % y la sentencia no fallo', p_estado;
end $$;

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000f1921', 'restaurantes', 'Huerfanos Org A', 'huerfanos-a'),
  ('00000000-0000-0000-0000-0000000f1922', 'restaurantes', 'Huerfanos Org B', 'huerfanos-b')
on conflict do nothing;
insert into core.property (id, organization_id, vertical, name, status) values
  ('00000000-0000-0000-0000-0000000f19a1', '00000000-0000-0000-0000-0000000f1921', 'restaurantes', 'Suc A', 'active'),
  ('00000000-0000-0000-0000-0000000f19b1', '00000000-0000-0000-0000-0000000f1922', 'restaurantes', 'Suc B', 'active')
on conflict do nothing;
insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000f1931', 'owner-a@huerfanos.example.com', 'Owner A', 'seed')
on conflict do nothing;
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000f1931', '00000000-0000-0000-0000-0000000f1921', null, 'owner', 'owner')
on conflict do nothing;

insert into restaurantes.agent_runtime_settings (organization_id, cerebro_v2) values
  ('00000000-0000-0000-0000-0000000f1921', true),
  ('00000000-0000-0000-0000-0000000f1922', false)
on conflict (organization_id) do update set cerebro_v2 = excluded.cerebro_v2;

insert into restaurantes.whatsapp_branch_channel (phone_number_id, organization_id, property_id) values
  ('pn-huerfanos-a', '00000000-0000-0000-0000-0000000f1921', '00000000-0000-0000-0000-0000000f19a1'),
  ('pn-huerfanos-b', '00000000-0000-0000-0000-0000000f1922', '00000000-0000-0000-0000-0000000f19b1');

-- El MISMO telefono tiene conversacion en las dos organizaciones (cross-tenant).
insert into restaurantes.whatsapp_conversations (organization_id, phone, property_id) values
  ('00000000-0000-0000-0000-0000000f1921', '+5219990000021', '00000000-0000-0000-0000-0000000f19a1'),
  ('00000000-0000-0000-0000-0000000f1922', '+5219990000021', '00000000-0000-0000-0000-0000000f19b1');

-- h1: processing hace 3 min (sale); h2: failed reintentable (sale); h3: processing hace 30 s (no: lease vigente); h4: failed con 5 intentos (no);
-- h5: failed de la fase A (no: Meta reintenta); h6: hace 20 min (no: fuera de 10 min); h7: processing hace 3 min en ORG B sin cerebro_v2 (solo con p_todas).
insert into restaurantes.whatsapp_inbound_events (message_id, organization_id, phone_hash, status, attempts, claimed_at, last_error_class) values
  ('wamid.huerfano-h1', '00000000-0000-0000-0000-0000000f1921', encode(sha256(convert_to('+5219990000021', 'UTF8')), 'hex'), 'processing', 1, now() - interval '3 minutes', null),
  ('wamid.huerfano-h2', '00000000-0000-0000-0000-0000000f1921', encode(sha256(convert_to('+5219990000021', 'UTF8')), 'hex'), 'failed', 2, now() - interval '2 minutes', 'Timeout'),
  ('wamid.huerfano-h3', '00000000-0000-0000-0000-0000000f1921', encode(sha256(convert_to('+5219990000021', 'UTF8')), 'hex'), 'processing', 1, now() - interval '30 seconds', null),
  ('wamid.huerfano-h4', '00000000-0000-0000-0000-0000000f1921', encode(sha256(convert_to('+5219990000021', 'UTF8')), 'hex'), 'failed', 5, now() - interval '2 minutes', 'Timeout'),
  ('wamid.huerfano-h5', '00000000-0000-0000-0000-0000000f1921', encode(sha256(convert_to('+5219990000021', 'UTF8')), 'hex'), 'failed', 1, now() - interval '2 minutes', 'RecepcionConEsperaFallo'),
  ('wamid.huerfano-h6', '00000000-0000-0000-0000-0000000f1921', encode(sha256(convert_to('+5219990000021', 'UTF8')), 'hex'), 'processing', 1, now() - interval '20 minutes', null),
  ('wamid.huerfano-h7', '00000000-0000-0000-0000-0000000f1922', encode(sha256(convert_to('+5219990000021', 'UTF8')), 'hex'), 'processing', 1, now() - interval '3 minutes', null);

\echo '=== A1. Sistema: reclama solo los huerfanos de organizaciones con cerebro_v2 ==='
begin;
set local role authenticated;
create temp table t_reclamados on commit drop as select * from restaurantes.reclamar_turnos_whatsapp_huerfanos(null, false, 10);
select count(*) as reclamados_deberia_ser_2 from t_reclamados;
rollback;
begin;
set local role authenticated;
create temp table t_reclamados on commit drop as select * from restaurantes.reclamar_turnos_whatsapp_huerfanos(null, false, 10);
select count(*) as h1_y_h2_deberia_ser_2 from t_reclamados where message_id in ('wamid.huerfano-h1', 'wamid.huerfano-h2');
rollback;

\echo '=== A2. El reclamo marca processing con intentos + 1 ==='
begin;
select count(*) as reclamados from restaurantes.reclamar_turnos_whatsapp_huerfanos(null, false, 10);
select attempts as intentos_h2_deberia_ser_3 from restaurantes.whatsapp_inbound_events where message_id = 'wamid.huerfano-h2';
rollback;
begin;
select count(*) as reclamados from restaurantes.reclamar_turnos_whatsapp_huerfanos(null, false, 10);
select count(*) as h2_en_processing_deberia_ser_1 from restaurantes.whatsapp_inbound_events where message_id = 'wamid.huerfano-h2' and status = 'processing' and last_error_class is null;
rollback;

\echo '=== A3. p_todas incluye organizaciones sin cerebro_v2; p_limite se acota ==='
begin;
set local role authenticated;
select count(*) as con_todas_deberia_ser_3 from restaurantes.reclamar_turnos_whatsapp_huerfanos(null, true, 10);
rollback;
begin;
set local role authenticated;
select count(*) as limite_1_deberia_ser_1 from restaurantes.reclamar_turnos_whatsapp_huerfanos(null, false, 1);
rollback;
begin;
set local role authenticated;
select count(*) as limite_0_se_acota_a_1_deberia_ser_1 from restaurantes.reclamar_turnos_whatsapp_huerfanos(null, false, 0);
rollback;

\echo '=== B1. Aislamiento: telefono y numero emisor de la MISMA organizacion ==='
begin;
set local role authenticated;
create temp table t_b on commit drop as select * from restaurantes.reclamar_turnos_whatsapp_huerfanos(null, true, 10);
select count(*) as numero_de_su_org_deberia_ser_3 from t_b
  where (organization_id = '00000000-0000-0000-0000-0000000f1921' and phone_number_id = 'pn-huerfanos-a' and property_id = '00000000-0000-0000-0000-0000000f19a1')
     or (organization_id = '00000000-0000-0000-0000-0000000f1922' and phone_number_id = 'pn-huerfanos-b' and property_id = '00000000-0000-0000-0000-0000000f19b1');
rollback;
begin;
set local role authenticated;
create temp table t_b on commit drop as select * from restaurantes.reclamar_turnos_whatsapp_huerfanos(null, true, 10);
select count(*) as telefono_deberia_ser_3 from t_b where phone = '+5219990000021';
rollback;
begin;
set local role authenticated;
select count(*) as solo_org_a_deberia_ser_2 from restaurantes.reclamar_turnos_whatsapp_huerfanos('00000000-0000-0000-0000-0000000f1921', true, 10);
rollback;

\echo '=== C1. RECHAZADO: un usuario autenticado (auth.uid() no nulo) -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f1931', true);
select public.t_esperar_error($q$select * from restaurantes.reclamar_turnos_whatsapp_huerfanos(null, false, 10)$q$, '42501');
rollback;

\echo '=== C2. RECHAZADO: anon no ejecuta la funcion -> 42501 ==='
begin;
set local role anon;
select public.t_esperar_error($q$select * from restaurantes.reclamar_turnos_whatsapp_huerfanos(null, false, 10)$q$, '42501');
rollback;
