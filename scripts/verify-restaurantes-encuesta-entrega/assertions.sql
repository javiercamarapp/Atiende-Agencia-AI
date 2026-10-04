-- Fixtures + escenarios contra Postgres REAL (RLS + GRANT + auth.uid() reales, nunca el repositorio en memoria) de
-- packages/domain-restaurantes/migrations/041_encuesta_post_entrega.sql: encuesta post-entrega (R-41).
--
--   A. Configuracion por sucursal (leer/guardar, validaciones, bitacora solo si algo cambio).
--   B. Barrido: encuesta_candidatas (activa, espera, ventana de 48 h, demo, otro tenant) y encuesta_registrar_envio (idempotente).
--   C. Lado publico: encuesta_publica (sin PII, liga de resenas solo con calificacion >= umbral) y encuesta_responder (first-write-wins).
--   D. Resumen de satisfaccion: global, por sucursal, por repartidor (zona horaria de la sucursal, cohorte por envio).
--   E. Autorizacion: staff de piso, repartidor, admin acotado, otro tenant, anon, sesion de sistema vs staff, tablas cerradas, CHECKs.
--   F. Base SIN migrar: la funcion eliminada da 42883 y un bloque con subtransaccion recupera la transaccion.
--
-- Convenciones del gate (run-gate.mjs): cada escenario es `begin; ... rollback;`; el alias `should_fail` marca el que debe terminar en
-- ERROR; los alias con sufijo deberia_ser_N marcan el valor esperado (entero exacto).
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
  ('00000000-0000-0000-0000-0000000e4101', 'restaurantes', 'Encuesta Org A', 'enc-a'),
  ('00000000-0000-0000-0000-0000000e4102', 'restaurantes', 'Encuesta Org B (ajena)', 'enc-b')
on conflict do nothing;

insert into core.property (id, organization_id, name) values
  ('00000000-0000-0000-0000-0000000e41a1', '00000000-0000-0000-0000-0000000e4101', 'Sucursal A1'),
  ('00000000-0000-0000-0000-0000000e41a2', '00000000-0000-0000-0000-0000000e4101', 'Sucursal A2 (Auckland)'),
  ('00000000-0000-0000-0000-0000000e41b1', '00000000-0000-0000-0000-0000000e4102', 'Sucursal B1')
on conflict do nothing;

insert into restaurantes.branch_detail (property_id, organization_id, slug, zona_horaria) values
  ('00000000-0000-0000-0000-0000000e41a1', '00000000-0000-0000-0000-0000000e4101', 'a1', null),
  ('00000000-0000-0000-0000-0000000e41a2', '00000000-0000-0000-0000-0000000e4101', 'a2', 'Pacific/Auckland'),
  ('00000000-0000-0000-0000-0000000e41b1', '00000000-0000-0000-0000-0000000e4102', 'b1', null)
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000e4111', 'owner-a@enc.example.com', 'Owner A', 'seed'),
  ('00000000-0000-0000-0000-0000000e4112', 'admin-a1@enc.example.com', 'Admin A1 (solo A1)', 'seed'),
  ('00000000-0000-0000-0000-0000000e4113', 'staff-a@enc.example.com', 'Staff A', 'seed'),
  ('00000000-0000-0000-0000-0000000e4114', 'rep-a@enc.example.com', 'Repartidor Uno', 'seed'),
  ('00000000-0000-0000-0000-0000000e4115', 'rep2-a@enc.example.com', 'Repartidor Dos', 'seed'),
  ('00000000-0000-0000-0000-0000000e4116', 'owner-b@enc.example.com', 'Owner B (ajeno)', 'seed')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000e4111', '00000000-0000-0000-0000-0000000e4101', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000e4112', '00000000-0000-0000-0000-0000000e4101', array['00000000-0000-0000-0000-0000000e41a1']::uuid[], 'admin', 'admin'),
  ('00000000-0000-0000-0000-0000000e4113', '00000000-0000-0000-0000-0000000e4101', null, 'member', 'staff'),
  ('00000000-0000-0000-0000-0000000e4114', '00000000-0000-0000-0000-0000000e4101', null, 'member', 'repartidor'),
  ('00000000-0000-0000-0000-0000000e4115', '00000000-0000-0000-0000-0000000e4101', null, 'member', 'repartidor'),
  ('00000000-0000-0000-0000-0000000e4116', '00000000-0000-0000-0000-0000000e4102', null, 'owner', 'owner')
on conflict do nothing;

-- Configuracion de encuesta: A1 y B1 activas (A1 con liga de resenas y umbral 4); A2 SIN fila (apagada por defecto).
insert into restaurantes.encuesta_config (property_id, organization_id, activa, espera_min, resenas_url, umbral_resena) values
  ('00000000-0000-0000-0000-0000000e41a1', '00000000-0000-0000-0000-0000000e4101', true, 30, 'https://g.page/r/ejemplo/review', 4),
  ('00000000-0000-0000-0000-0000000e41b1', '00000000-0000-0000-0000-0000000e4102', true, 30, null, 4);

-- Canal de WhatsApp: la organizacion A por numero de organizacion; la B por numero de sucursal.
insert into restaurantes.whatsapp_channel_config (organization_id, phone_number_id) values ('00000000-0000-0000-0000-0000000e4101', 'pnid-enc-a');
insert into restaurantes.whatsapp_branch_channel (phone_number_id, organization_id, property_id) values ('pnid-enc-b1', '00000000-0000-0000-0000-0000000e4102', '00000000-0000-0000-0000-0000000e41b1');

-- Pedidos CANDIDATOS del barrido (sin encuesta). "Ahora" de las pruebas del barrido = 2026-03-10 19:00:00+00.
insert into restaurantes.orders (id, organization_id, property_id, customer_name, customer_phone, total, status, items, source, created_at, delivered_at, assigned_repartidor_id) values
  ('00000000-0000-0000-0000-0000000e4191', '00000000-0000-0000-0000-0000000e4101', '00000000-0000-0000-0000-0000000e41a1', 'Cliente Uno', '+52 5511111111', 100, 'entregado', '[]', 'whatsapp', '2026-03-10 17:00:00+00', '2026-03-10 18:00:00+00', '00000000-0000-0000-0000-0000000e4114'),
  ('00000000-0000-0000-0000-0000000e4192', '00000000-0000-0000-0000-0000000e4101', '00000000-0000-0000-0000-0000000e41a1', 'Cliente Dos', '+52 5522222222', 100, 'entregado', '[]', 'whatsapp', '2026-03-10 17:00:00+00', '2026-03-10 18:00:00+00', '00000000-0000-0000-0000-0000000e4114'),
  ('00000000-0000-0000-0000-0000000e4193', '00000000-0000-0000-0000-0000000e4101', '00000000-0000-0000-0000-0000000e41a1', 'Cliente Tres', '+52 5533333333', 100, 'completado', '[]', 'web', '2026-03-10 17:00:00+00', '2026-03-10 18:00:00+00', '00000000-0000-0000-0000-0000000e4115'),
  -- o4: trafico demo (telefono 0009): nunca recibe encuesta.
  ('00000000-0000-0000-0000-0000000e4194', '00000000-0000-0000-0000-0000000e4101', '00000000-0000-0000-0000-0000000e41a1', 'Visitante Demo', '+52 0009123456', 100, 'entregado', '[]', 'whatsapp', '2026-03-10 17:00:00+00', '2026-03-10 18:00:00+00', null),
  -- o5: aun no entregado.
  ('00000000-0000-0000-0000-0000000e4195', '00000000-0000-0000-0000-0000000e4101', '00000000-0000-0000-0000-0000000e41a1', 'Cliente Cinco', '+52 5555555555', 100, 'pending', '[]', 'web', '2026-03-10 17:00:00+00', null, null),
  -- o6: sucursal A2 (encuesta apagada: sin fila de configuracion).
  ('00000000-0000-0000-0000-0000000e4196', '00000000-0000-0000-0000-0000000e4101', '00000000-0000-0000-0000-0000000e41a2', 'Cliente A2', '+52 5577777777', 100, 'entregado', '[]', 'whatsapp', '2026-03-10 17:00:00+00', '2026-03-10 18:00:00+00', '00000000-0000-0000-0000-0000000e4114'),
  -- o7: entregado hace mas de 48 h.
  ('00000000-0000-0000-0000-0000000e4197', '00000000-0000-0000-0000-0000000e4101', '00000000-0000-0000-0000-0000000e41a1', 'Cliente Viejo', '+52 5599999999', 100, 'entregado', '[]', 'whatsapp', '2026-03-05 17:00:00+00', '2026-03-05 18:00:00+00', null),
  -- o8: otro tenant (B1, encuesta activa).
  ('00000000-0000-0000-0000-0000000e4198', '00000000-0000-0000-0000-0000000e4102', '00000000-0000-0000-0000-0000000e41b1', 'Cliente B', '+52 5544440000', 100, 'entregado', '[]', 'whatsapp', '2026-03-10 17:00:00+00', '2026-03-10 18:00:00+00', null),
  -- o9: entregado hace 10 minutos: aun dentro de la espera de 30.
  ('00000000-0000-0000-0000-0000000e4199', '00000000-0000-0000-0000-0000000e4101', '00000000-0000-0000-0000-0000000e41a1', 'Cliente Nueve', '+52 5566666666', 100, 'entregado', '[]', 'whatsapp', '2026-03-10 18:00:00+00', '2026-03-10 18:50:00+00', null),
-- Pedidos que YA tienen encuesta registrada (para resumen y lado publico).
  ('00000000-0000-0000-0000-0000000e419a', '00000000-0000-0000-0000-0000000e4101', '00000000-0000-0000-0000-0000000e41a1', 'Cliente Diez', '+52 5510101010', 100, 'entregado', '[]', 'whatsapp', '2026-03-10 16:00:00+00', '2026-03-10 17:00:00+00', '00000000-0000-0000-0000-0000000e4114'),
  ('00000000-0000-0000-0000-0000000e419b', '00000000-0000-0000-0000-0000000e4101', '00000000-0000-0000-0000-0000000e41a1', 'Cliente Once', '+52 5511111112', 100, 'entregado', '[]', 'whatsapp', '2026-03-10 16:00:00+00', '2026-03-10 17:00:00+00', '00000000-0000-0000-0000-0000000e4114'),
  ('00000000-0000-0000-0000-0000000e419c', '00000000-0000-0000-0000-0000000e4101', '00000000-0000-0000-0000-0000000e41a1', 'Cliente Doce', '+52 5512121212', 100, 'entregado', '[]', 'whatsapp', '2026-03-10 16:00:00+00', '2026-03-10 17:00:00+00', '00000000-0000-0000-0000-0000000e4115'),
  ('00000000-0000-0000-0000-0000000e419d', '00000000-0000-0000-0000-0000000e4102', '00000000-0000-0000-0000-0000000e41b1', 'Cliente Trece', '+52 5513131313', 100, 'entregado', '[]', 'whatsapp', '2026-03-10 16:00:00+00', '2026-03-10 17:00:00+00', null),
  ('00000000-0000-0000-0000-0000000e419e', '00000000-0000-0000-0000-0000000e4101', '00000000-0000-0000-0000-0000000e41a2', 'Cliente Catorce', '+52 5514141414', 100, 'entregado', '[]', 'whatsapp', '2026-03-10 11:00:00+00', '2026-03-10 11:30:00+00', '00000000-0000-0000-0000-0000000e4114');

-- Encuestas registradas:
--   e1 (o10, A1, rep1): 5 estrellas; e2 (o11, A1, rep1): 2 estrellas con comentario; e3 (o12, A1, rep2): enviada sin respuesta.
--   e4 (o13, B1, otro tenant): 1 estrella. e5 (o14, A2 Auckland, rep1): enviada 2026-03-10 12:00Z = 2026-03-11 01:00 local, 4 estrellas.
insert into restaurantes.encuesta_entrega (id, organization_id, property_id, order_id, repartidor_id, enviada_at, respondida_at, calificacion, comentario) values
  ('00000000-0000-0000-0000-0000000e41c1', '00000000-0000-0000-0000-0000000e4101', '00000000-0000-0000-0000-0000000e41a1', '00000000-0000-0000-0000-0000000e419a', '00000000-0000-0000-0000-0000000e4114', '2026-03-10 18:30:00+00', '2026-03-10 19:00:00+00', 5, 'Excelente'),
  ('00000000-0000-0000-0000-0000000e41c2', '00000000-0000-0000-0000-0000000e4101', '00000000-0000-0000-0000-0000000e41a1', '00000000-0000-0000-0000-0000000e419b', '00000000-0000-0000-0000-0000000e4114', '2026-03-10 18:30:00+00', '2026-03-10 19:30:00+00', 2, 'Llego frio'),
  ('00000000-0000-0000-0000-0000000e41c3', '00000000-0000-0000-0000-0000000e4101', '00000000-0000-0000-0000-0000000e41a1', '00000000-0000-0000-0000-0000000e419c', '00000000-0000-0000-0000-0000000e4115', '2026-03-10 18:30:00+00', null, null, null),
  ('00000000-0000-0000-0000-0000000e41c4', '00000000-0000-0000-0000-0000000e4102', '00000000-0000-0000-0000-0000000e41b1', '00000000-0000-0000-0000-0000000e419d', null, '2026-03-10 18:30:00+00', '2026-03-10 19:00:00+00', 1, 'Mal'),
  ('00000000-0000-0000-0000-0000000e41c5', '00000000-0000-0000-0000-0000000e4101', '00000000-0000-0000-0000-0000000e41a2', '00000000-0000-0000-0000-0000000e419e', '00000000-0000-0000-0000-0000000e4114', '2026-03-10 12:00:00+00', '2026-03-10 13:00:00+00', 4, null);

\echo '=== A1. owner lee la configuracion de A1: activa ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4111', true);
select (restaurantes.encuesta_config_leer('00000000-0000-0000-0000-0000000e4101', '00000000-0000-0000-0000-0000000e41a1')->>'activa')::boolean::integer as activa_deberia_ser_1;
rollback;

\echo '=== A2. A2 sin fila: apagada por defecto ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4111', true);
select (restaurantes.encuesta_config_leer('00000000-0000-0000-0000-0000000e4101', '00000000-0000-0000-0000-0000000e41a2')->>'activa')::boolean::integer as activa_defecto_deberia_ser_0;
rollback;

\echo '=== A3. owner guarda la configuracion de A2 y la lee de vuelta ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4111', true);
select restaurantes.encuesta_config_guardar('00000000-0000-0000-0000-0000000e4101', '00000000-0000-0000-0000-0000000e41a2', true, 30, 'https://g.page/r/nuevo', 4);
select (restaurantes.encuesta_config_leer('00000000-0000-0000-0000-0000000e4101', '00000000-0000-0000-0000-0000000e41a2')->>'activa')::boolean::integer as activa_guardada_deberia_ser_1;
rollback;

\echo '=== A4. guardar deja UNA fila de bitacora con el actor real y un reintento sin cambios no agrega otra ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4111', true);
select restaurantes.encuesta_config_guardar('00000000-0000-0000-0000-0000000e4101', '00000000-0000-0000-0000-0000000e41a2', true, 30, 'https://g.page/r/nuevo', 4);
select restaurantes.encuesta_config_guardar('00000000-0000-0000-0000-0000000e4101', '00000000-0000-0000-0000-0000000e41a2', true, 30, 'https://g.page/r/nuevo', 4);
reset role;
select count(*) as bitacora_deberia_ser_1 from restaurantes.audit_log where action = 'encuesta.configuracion_actualizada' and entity_id = '00000000-0000-0000-0000-0000000e41a2' and actor_user_id = '00000000-0000-0000-0000-0000000e4111';
rollback;

\echo '=== A5. el admin acotado a A1 guarda A1 (quita la liga, umbral 5) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4112', true);
select restaurantes.encuesta_config_guardar('00000000-0000-0000-0000-0000000e4101', '00000000-0000-0000-0000-0000000e41a1', true, 30, null, 5);
select (restaurantes.encuesta_config_leer('00000000-0000-0000-0000-0000000e4101', '00000000-0000-0000-0000-0000000e41a1')->>'umbral_resena')::integer as umbral_deberia_ser_5;
rollback;

\echo '=== A6. RECHAZADO: liga de resenas javascript: -> 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4111', true);
select public.t_esperar_error($q$select restaurantes.encuesta_config_guardar('00000000-0000-0000-0000-0000000e4101', '00000000-0000-0000-0000-0000000e41a1', true, 30, 'javascript:alert(1)', 4)$q$, '22023');
rollback;

\echo '=== A7. RECHAZADO: liga de resenas http (no https) -> 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4111', true);
select public.t_esperar_error($q$select restaurantes.encuesta_config_guardar('00000000-0000-0000-0000-0000000e4101', '00000000-0000-0000-0000-0000000e41a1', true, 30, 'http://g.page/r/x', 4)$q$, '22023');
rollback;

\echo '=== A8. RECHAZADO: liga con credenciales en el host -> 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4111', true);
select public.t_esperar_error($q$select restaurantes.encuesta_config_guardar('00000000-0000-0000-0000-0000000e4101', '00000000-0000-0000-0000-0000000e41a1', true, 30, 'https://user@evil.example.com/x', 4)$q$, '22023');
rollback;

\echo '=== A9. RECHAZADO: espera de 2 minutos fuera de rango -> 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4111', true);
select public.t_esperar_error($q$select restaurantes.encuesta_config_guardar('00000000-0000-0000-0000-0000000e4101', '00000000-0000-0000-0000-0000000e41a1', true, 2, 'https://g.page/r/nuevo', 4)$q$, '22023');
rollback;

\echo '=== A10. RECHAZADO: umbral 6 fuera de rango -> 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4111', true);
select public.t_esperar_error($q$select restaurantes.encuesta_config_guardar('00000000-0000-0000-0000-0000000e4101', '00000000-0000-0000-0000-0000000e41a1', true, 30, 'https://g.page/r/nuevo', 6)$q$, '22023');
rollback;

\echo '=== A11. RECHAZADO: el staff de piso no guarda la configuracion -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4113', true);
select public.t_esperar_error($q$select restaurantes.encuesta_config_guardar('00000000-0000-0000-0000-0000000e4101', '00000000-0000-0000-0000-0000000e41a1', true, 30, 'https://g.page/r/nuevo', 4)$q$, '42501');
rollback;

\echo '=== A12. RECHAZADO: el admin acotado a A1 no guarda A2 -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4112', true);
select public.t_esperar_error($q$select restaurantes.encuesta_config_guardar('00000000-0000-0000-0000-0000000e4101', '00000000-0000-0000-0000-0000000e41a2', true, 30, 'https://g.page/r/nuevo', 4)$q$, '42501');
rollback;

\echo '=== A13. RECHAZADO cross-tenant: el owner de B no guarda A1 -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4116', true);
select public.t_esperar_error($q$select restaurantes.encuesta_config_guardar('00000000-0000-0000-0000-0000000e4101', '00000000-0000-0000-0000-0000000e41a1', true, 30, 'https://g.page/r/nuevo', 4)$q$, '42501');
rollback;

\echo '=== A14. RECHAZADO cross-tenant: el owner de A no guarda la sucursal de B declarando su organizacion -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4111', true);
select public.t_esperar_error($q$select restaurantes.encuesta_config_guardar('00000000-0000-0000-0000-0000000e4101', '00000000-0000-0000-0000-0000000e41b1', true, 30, 'https://g.page/r/nuevo', 4)$q$, '42501');
rollback;

\echo '=== A15. RECHAZADO: el repartidor no lee la configuracion -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4114', true);
select public.t_esperar_error($q$select restaurantes.encuesta_config_leer('00000000-0000-0000-0000-0000000e4101', '00000000-0000-0000-0000-0000000e41a1')$q$, '42501');
rollback;

\echo '=== B1. candidatas globales (o1,o2,o3 de A1 y o8 de B1; demo, no entregado, A2 apagada, vieja y reciente fuera) ==='
begin;
set local role authenticated;
select jsonb_array_length(restaurantes.encuesta_candidatas(null, timestamptz '2026-03-10 19:00:00+00', 100)) as candidatas_deberia_ser_4;
rollback;

\echo '=== B2. candidatas acotadas a la organizacion A (no mezclan tenants) ==='
begin;
set local role authenticated;
select jsonb_array_length(restaurantes.encuesta_candidatas('00000000-0000-0000-0000-0000000e4101', timestamptz '2026-03-10 19:00:00+00', 100)) as candidatas_a_deberia_ser_3;
rollback;

\echo '=== B3. el limite acota el lote ==='
begin;
set local role authenticated;
select jsonb_array_length(restaurantes.encuesta_candidatas('00000000-0000-0000-0000-0000000e4101', timestamptz '2026-03-10 19:00:00+00', 2)) as candidatas_limite_deberia_ser_2;
rollback;

\echo '=== B4. despues de las 19:20 tambien entra o9 (30 minutos tras su entrega) ==='
begin;
set local role authenticated;
select jsonb_array_length(restaurantes.encuesta_candidatas('00000000-0000-0000-0000-0000000e4101', timestamptz '2026-03-10 19:30:00+00', 100)) as candidatas_tarde_deberia_ser_4;
rollback;

\echo '=== B5. un pedido registrado deja de ser candidato ==='
begin;
set local role authenticated;
select restaurantes.encuesta_registrar_envio('00000000-0000-0000-0000-0000000e4101', '00000000-0000-0000-0000-0000000e4191');
select jsonb_array_length(restaurantes.encuesta_candidatas('00000000-0000-0000-0000-0000000e4101', timestamptz '2026-03-10 19:00:00+00', 100)) as candidatas_tras_registro_deberia_ser_2;
rollback;

\echo '=== B6. registrar el envio es idempotente: la segunda vez devuelve false ==='
begin;
set local role authenticated;
select restaurantes.encuesta_registrar_envio('00000000-0000-0000-0000-0000000e4101', '00000000-0000-0000-0000-0000000e4191');
select restaurantes.encuesta_registrar_envio('00000000-0000-0000-0000-0000000e4101', '00000000-0000-0000-0000-0000000e4191')::integer as segunda_deberia_ser_0;
rollback;

\echo '=== B7. registrar el envio devuelve true la primera vez ==='
begin;
set local role authenticated;
select restaurantes.encuesta_registrar_envio('00000000-0000-0000-0000-0000000e4101', '00000000-0000-0000-0000-0000000e4191')::integer as primera_deberia_ser_1;
rollback;

\echo '=== B8. el registro copia el repartidor asignado como foto ==='
begin;
set local role authenticated;
select restaurantes.encuesta_registrar_envio('00000000-0000-0000-0000-0000000e4101', '00000000-0000-0000-0000-0000000e4191');
reset role;
select count(*) as repartidor_foto_deberia_ser_1 from restaurantes.encuesta_entrega where order_id = '00000000-0000-0000-0000-0000000e4191' and repartidor_id = '00000000-0000-0000-0000-0000000e4114';
rollback;

\echo '=== B9. un pedido sin repartidor (recoger) se registra con repartidor nulo ==='
begin;
set local role authenticated;
select restaurantes.encuesta_registrar_envio('00000000-0000-0000-0000-0000000e4102', '00000000-0000-0000-0000-0000000e4198');
reset role;
select count(*) as sin_repartidor_deberia_ser_1 from restaurantes.encuesta_entrega where order_id = '00000000-0000-0000-0000-0000000e4198' and repartidor_id is null;
rollback;

\echo '=== B9b. una organizacion sin numero de WhatsApp no tiene candidatas (no ocupa el lote) ==='
begin;
set local role authenticated;
reset role;
delete from restaurantes.whatsapp_channel_config where organization_id = '00000000-0000-0000-0000-0000000e4101';
select jsonb_array_length(restaurantes.encuesta_candidatas('00000000-0000-0000-0000-0000000e4101', timestamptz '2026-03-10 19:00:00+00', 100)) as sin_canal_deberia_ser_0;
rollback;

\echo '=== B10. RECHAZADO: registrar un pedido no entregado -> 22023 ==='
begin;
set local role authenticated;
select public.t_esperar_error($q$select restaurantes.encuesta_registrar_envio('00000000-0000-0000-0000-0000000e4101', '00000000-0000-0000-0000-0000000e4195')$q$, '22023');
rollback;

\echo '=== B11. RECHAZADO cross-tenant: registrar el pedido de A declarando la organizacion B -> 22023 ==='
begin;
set local role authenticated;
select public.t_esperar_error($q$select restaurantes.encuesta_registrar_envio('00000000-0000-0000-0000-0000000e4102', '00000000-0000-0000-0000-0000000e4191')$q$, '22023');
rollback;

\echo '=== B12. RECHAZADO: el staff no usa encuesta_candidatas (solo sistema) -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4111', true);
select public.t_esperar_error($q$select restaurantes.encuesta_candidatas('00000000-0000-0000-0000-0000000e4101', timestamptz '2026-03-10 19:00:00+00', 10)$q$, '42501');
rollback;

\echo '=== B13. RECHAZADO: el staff no usa encuesta_registrar_envio (solo sistema) -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4111', true);
select public.t_esperar_error($q$select restaurantes.encuesta_registrar_envio('00000000-0000-0000-0000-0000000e4101', '00000000-0000-0000-0000-0000000e4191')$q$, '42501');
rollback;

\echo '=== B14. RECHAZADO: anon no ejecuta encuesta_candidatas -> 42501 ==='
begin;
set local role anon;
select public.t_esperar_error($q$select restaurantes.encuesta_candidatas('00000000-0000-0000-0000-0000000e4101', timestamptz '2026-03-10 19:00:00+00', 10)$q$, '42501');
rollback;

\echo '=== C1. publica: una encuesta de 5 estrellas con umbral 4 devuelve la liga de resenas ==='
begin;
set local role authenticated;
select (restaurantes.encuesta_publica('00000000-0000-0000-0000-0000000e4101', '00000000-0000-0000-0000-0000000e419a')->>'resenas_url' is not null)::integer as liga_deberia_ser_1;
rollback;

\echo '=== C2. publica: una de 2 estrellas NO devuelve liga ==='
begin;
set local role authenticated;
select (restaurantes.encuesta_publica('00000000-0000-0000-0000-0000000e4101', '00000000-0000-0000-0000-0000000e419b')->>'resenas_url' is not null)::integer as sin_liga_deberia_ser_0;
rollback;

\echo '=== C3. publica: una encuesta sin responder esta marcada como no respondida ==='
begin;
set local role authenticated;
select (restaurantes.encuesta_publica('00000000-0000-0000-0000-0000000e4101', '00000000-0000-0000-0000-0000000e419c')->>'respondida')::boolean::integer as respondida_deberia_ser_0;
rollback;

\echo '=== C4. publica: sin PII (ni nombre ni telefono ni comentario) ==='
begin;
set local role authenticated;
select (restaurantes.encuesta_publica('00000000-0000-0000-0000-0000000e4101', '00000000-0000-0000-0000-0000000e419a')::text ~* 'Cliente|5510101010|Excelente')::integer as pii_deberia_ser_0;
rollback;

\echo '=== C5. publica cross-tenant: la organizacion B no ve la encuesta de A ==='
begin;
set local role authenticated;
select (restaurantes.encuesta_publica('00000000-0000-0000-0000-0000000e4102', '00000000-0000-0000-0000-0000000e419a') is null)::integer as ajena_deberia_ser_1;
rollback;

\echo '=== C6. responder registra la primera respuesta ==='
begin;
set local role authenticated;
select (restaurantes.encuesta_responder('00000000-0000-0000-0000-0000000e4101', '00000000-0000-0000-0000-0000000e419c', 4, ' Bien ')->>'estado' = 'registrada')::integer as registrada_deberia_ser_1;
rollback;

\echo '=== C7. responder: la primera respuesta gana y la segunda recibe ya_respondida ==='
begin;
set local role authenticated;
select restaurantes.encuesta_responder('00000000-0000-0000-0000-0000000e4101', '00000000-0000-0000-0000-0000000e419c', 4, 'Bien');
select (restaurantes.encuesta_responder('00000000-0000-0000-0000-0000000e4101', '00000000-0000-0000-0000-0000000e419c', 1, 'Otra')->>'calificacion')::integer as primera_gana_deberia_ser_4;
rollback;

\echo '=== C8. responder: la segunda llamada reporta ya_respondida ==='
begin;
set local role authenticated;
select restaurantes.encuesta_responder('00000000-0000-0000-0000-0000000e4101', '00000000-0000-0000-0000-0000000e419c', 4, 'Bien');
select (restaurantes.encuesta_responder('00000000-0000-0000-0000-0000000e4101', '00000000-0000-0000-0000-0000000e419c', 1, 'Otra')->>'estado' = 'ya_respondida')::integer as ya_respondida_deberia_ser_1;
rollback;

\echo '=== C9. responder: un comentario en blanco se guarda como nulo ==='
begin;
set local role authenticated;
select restaurantes.encuesta_responder('00000000-0000-0000-0000-0000000e4101', '00000000-0000-0000-0000-0000000e419c', 3, '   ');
reset role;
select count(*) as comentario_nulo_deberia_ser_1 from restaurantes.encuesta_entrega where order_id = '00000000-0000-0000-0000-0000000e419c' and comentario is null and calificacion = 3;
rollback;

\echo '=== C10. responder con calificacion alta devuelve la liga de resenas de la sucursal ==='
begin;
set local role authenticated;
select (restaurantes.encuesta_responder('00000000-0000-0000-0000-0000000e4101', '00000000-0000-0000-0000-0000000e419c', 5, null)->>'resenas_url' = 'https://g.page/r/ejemplo/review')::integer as liga_correcta_deberia_ser_1;
rollback;

\echo '=== C11. responder cross-tenant: la organizacion B no responde la encuesta de A ==='
begin;
set local role authenticated;
select (restaurantes.encuesta_responder('00000000-0000-0000-0000-0000000e4102', '00000000-0000-0000-0000-0000000e419c', 5, null)->>'estado' = 'no_encontrada')::integer as no_encontrada_deberia_ser_1;
rollback;

\echo '=== C12. RECHAZADO: calificacion 6 -> 22023 ==='
begin;
set local role authenticated;
select public.t_esperar_error($q$select restaurantes.encuesta_responder('00000000-0000-0000-0000-0000000e4101', '00000000-0000-0000-0000-0000000e419c', 6, null)$q$, '22023');
rollback;

\echo '=== C13. RECHAZADO: calificacion 0 -> 22023 ==='
begin;
set local role authenticated;
select public.t_esperar_error($q$select restaurantes.encuesta_responder('00000000-0000-0000-0000-0000000e4101', '00000000-0000-0000-0000-0000000e419c', 0, null)$q$, '22023');
rollback;

\echo '=== C14. RECHAZADO: comentario de mas de 1000 caracteres -> 22023 ==='
begin;
set local role authenticated;
select public.t_esperar_error($q$select restaurantes.encuesta_responder('00000000-0000-0000-0000-0000000e4101', '00000000-0000-0000-0000-0000000e419c', 3, repeat('x', 1001))$q$, '22023');
rollback;

\echo '=== C15. RECHAZADO: el staff no responde por un cliente (solo sistema) -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4111', true);
select public.t_esperar_error($q$select restaurantes.encuesta_responder('00000000-0000-0000-0000-0000000e4101', '00000000-0000-0000-0000-0000000e419c', 5, null)$q$, '42501');
rollback;

\echo '=== C16. RECHAZADO: anon no ejecuta encuesta_responder -> 42501 ==='
begin;
set local role anon;
select public.t_esperar_error($q$select restaurantes.encuesta_responder('00000000-0000-0000-0000-0000000e4101', '00000000-0000-0000-0000-0000000e419c', 5, null)$q$, '42501');
rollback;

\echo '=== C17. RECHAZADO: el staff no usa encuesta_publica (solo sistema) -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4111', true);
select public.t_esperar_error($q$select restaurantes.encuesta_publica('00000000-0000-0000-0000-0000000e4101', '00000000-0000-0000-0000-0000000e419a')$q$, '42501');
rollback;

\echo '=== D1. resumen del dia 10 (owner, toda la organizacion): enviadas = 3 de A1 (la de A2 cae el dia 11 local) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4111', true);
select (restaurantes.encuesta_resumen('00000000-0000-0000-0000-0000000e4101', date '2026-03-10', date '2026-03-10')->'global'->>'enviadas')::integer as enviadas_deberia_ser_3;
rollback;

\echo '=== D2. resumen del dia 10: respondidas = 2 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4111', true);
select (restaurantes.encuesta_resumen('00000000-0000-0000-0000-0000000e4101', date '2026-03-10', date '2026-03-10')->'global'->>'respondidas')::integer as respondidas_deberia_ser_2;
rollback;

\echo '=== D3. resumen del dia 10: promedio 3.50 (5 y 2) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4111', true);
select ((restaurantes.encuesta_resumen('00000000-0000-0000-0000-0000000e4101', date '2026-03-10', date '2026-03-10')->'global'->>'promedio')::numeric * 100)::integer as promedio_deberia_ser_350;
rollback;

\echo '=== D4. resumen dias 10 y 11 (zona de A2): enviadas = 4 y promedio 3.67 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4111', true);
select (restaurantes.encuesta_resumen('00000000-0000-0000-0000-0000000e4101', date '2026-03-10', date '2026-03-11')->'global'->>'enviadas')::integer as enviadas_dos_dias_deberia_ser_4;
rollback;

\echo '=== D5. resumen dias 10 y 11: promedio redondeado a 2 decimales ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4111', true);
select ((restaurantes.encuesta_resumen('00000000-0000-0000-0000-0000000e4101', date '2026-03-10', date '2026-03-11')->'global'->>'promedio')::numeric * 100)::integer as promedio_dos_dias_deberia_ser_367;
rollback;

\echo '=== D6. distribucion: una de 5 estrellas ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4111', true);
select (restaurantes.encuesta_resumen('00000000-0000-0000-0000-0000000e4101', date '2026-03-10', date '2026-03-10')->'global'->'distribucion'->>4)::integer as cinco_estrellas_deberia_ser_1;
rollback;

\echo '=== D7. por sucursal: A1 con promedio 3.50 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4111', true);
select ((x->>'promedio')::numeric * 100)::integer as prom_a1_deberia_ser_350 from jsonb_array_elements(restaurantes.encuesta_resumen('00000000-0000-0000-0000-0000000e4101', date '2026-03-10', date '2026-03-11')->'por_sucursal') x where x->>'nombre' = 'Sucursal A1';
rollback;

\echo '=== D8. por sucursal: A2 con promedio 4.00 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4111', true);
select ((x->>'promedio')::numeric * 100)::integer as prom_a2_deberia_ser_400 from jsonb_array_elements(restaurantes.encuesta_resumen('00000000-0000-0000-0000-0000000e4101', date '2026-03-10', date '2026-03-11')->'por_sucursal') x where x->>'nombre' like 'Sucursal A2%';
rollback;

\echo '=== D9. por sucursal: solo las sucursales de la organizacion (2, no la de B) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4111', true);
select jsonb_array_length(restaurantes.encuesta_resumen('00000000-0000-0000-0000-0000000e4101', date '2026-03-10', date '2026-03-11')->'por_sucursal') as sucursales_deberia_ser_2;
rollback;

\echo '=== D10. por repartidor: Repartidor Uno con 3 encuestas enviadas en los dos dias (e1, e2 y la de A2) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4111', true);
select (x->>'enviadas')::integer as enviadas_rep1_deberia_ser_3 from jsonb_array_elements(restaurantes.encuesta_resumen('00000000-0000-0000-0000-0000000e4101', date '2026-03-10', date '2026-03-11')->'por_repartidor') x where x->>'nombre' = 'Repartidor Uno';
rollback;

\echo '=== D11. por repartidor: Repartidor Uno con promedio 3.67 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4111', true);
select ((x->>'promedio')::numeric * 100)::integer as prom_rep1_deberia_ser_367 from jsonb_array_elements(restaurantes.encuesta_resumen('00000000-0000-0000-0000-0000000e4101', date '2026-03-10', date '2026-03-11')->'por_repartidor') x where x->>'nombre' = 'Repartidor Uno';
rollback;

\echo '=== D12. por repartidor: Repartidor Dos sin respuestas tiene promedio nulo (no 0) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4111', true);
select (x->>'promedio' is null)::integer as prom_rep2_nulo_deberia_ser_1 from jsonb_array_elements(restaurantes.encuesta_resumen('00000000-0000-0000-0000-0000000e4101', date '2026-03-10', date '2026-03-11')->'por_repartidor') x where x->>'nombre' = 'Repartidor Dos';
rollback;

\echo '=== D13. comentarios recientes: 3 respuestas en los dos dias ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4111', true);
select jsonb_array_length(restaurantes.encuesta_resumen('00000000-0000-0000-0000-0000000e4101', date '2026-03-10', date '2026-03-11')->'recientes') as recientes_deberia_ser_3;
rollback;

\echo '=== D14. comentarios recientes: no aparece nada de otro tenant ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4111', true);
select (restaurantes.encuesta_resumen('00000000-0000-0000-0000-0000000e4101', date '2026-03-10', date '2026-03-11')::text like '%Mal%')::integer as ajeno_deberia_ser_0;
rollback;

\echo '=== D15. el admin acotado a A1 solo ve A1 (enviadas dos dias = 3) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4112', true);
select (restaurantes.encuesta_resumen('00000000-0000-0000-0000-0000000e4101', date '2026-03-10', date '2026-03-11')->'global'->>'enviadas')::integer as enviadas_admin_deberia_ser_3;
rollback;

\echo '=== D16. el admin acotado a A1 pide su sucursal explicita ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4112', true);
select (restaurantes.encuesta_resumen('00000000-0000-0000-0000-0000000e4101', date '2026-03-10', date '2026-03-11', '00000000-0000-0000-0000-0000000e41a1')->'global'->>'enviadas')::integer as enviadas_a1_deberia_ser_3;
rollback;

\echo '=== D17. dia sin encuestas: enviadas 0 y promedio nulo ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4111', true);
select (restaurantes.encuesta_resumen('00000000-0000-0000-0000-0000000e4101', date '2026-03-01', date '2026-03-02')->'global'->>'enviadas')::integer as vacio_deberia_ser_0;
rollback;

\echo '=== D18. RECHAZADO: el admin acotado a A1 no pide A2 -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4112', true);
select public.t_esperar_error($q$select restaurantes.encuesta_resumen('00000000-0000-0000-0000-0000000e4101', date '2026-03-10', date '2026-03-11', '00000000-0000-0000-0000-0000000e41a2')$q$, '42501');
rollback;

\echo '=== D19. RECHAZADO: el staff de piso no ve el resumen -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4113', true);
select public.t_esperar_error($q$select restaurantes.encuesta_resumen('00000000-0000-0000-0000-0000000e4101', date '2026-03-10', date '2026-03-11')$q$, '42501');
rollback;

\echo '=== D20. RECHAZADO: el repartidor no ve el resumen -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4114', true);
select public.t_esperar_error($q$select restaurantes.encuesta_resumen('00000000-0000-0000-0000-0000000e4101', date '2026-03-10', date '2026-03-11')$q$, '42501');
rollback;

\echo '=== D21. RECHAZADO cross-tenant: el owner de B no ve el resumen de A -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4116', true);
select public.t_esperar_error($q$select restaurantes.encuesta_resumen('00000000-0000-0000-0000-0000000e4101', date '2026-03-10', date '2026-03-11')$q$, '42501');
rollback;

\echo '=== D22. RECHAZADO cross-tenant: el owner de B pide la sucursal de A -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4116', true);
select public.t_esperar_error($q$select restaurantes.encuesta_resumen('00000000-0000-0000-0000-0000000e4101', date '2026-03-10', date '2026-03-11', '00000000-0000-0000-0000-0000000e41a1')$q$, '42501');
rollback;

\echo '=== D23. RECHAZADO: anon no ejecuta el resumen -> 42501 ==='
begin;
set local role anon;
select public.t_esperar_error($q$select restaurantes.encuesta_resumen('00000000-0000-0000-0000-0000000e4101', date '2026-03-10', date '2026-03-11')$q$, '42501');
rollback;

\echo '=== D24. RECHAZADO: la sesion de sistema (sin usuario) no lee el resumen de staff -> 42501 ==='
begin;
set local role authenticated;
select public.t_esperar_error($q$select restaurantes.encuesta_resumen('00000000-0000-0000-0000-0000000e4101', date '2026-03-10', date '2026-03-11')$q$, '42501');
rollback;

\echo '=== D25. RECHAZADO: rango de mas de 92 dias -> 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4111', true);
select public.t_esperar_error($q$select restaurantes.encuesta_resumen('00000000-0000-0000-0000-0000000e4101', date '2025-11-01', date '2026-03-11')$q$, '22023');
rollback;

\echo '=== D26. RECHAZADO: rango invertido -> 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4111', true);
select public.t_esperar_error($q$select restaurantes.encuesta_resumen('00000000-0000-0000-0000-0000000e4101', date '2026-03-11', date '2026-03-10')$q$, '22023');
rollback;

\echo '=== E1. RECHAZADO: el owner no lee encuesta_entrega directo (sin GRANT) -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4111', true);
select public.t_esperar_error($q$select * from restaurantes.encuesta_entrega$q$, '42501');
rollback;

\echo '=== E2. RECHAZADO: el owner no lee encuesta_config directo (sin GRANT) -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4111', true);
select public.t_esperar_error($q$select * from restaurantes.encuesta_config$q$, '42501');
rollback;

\echo '=== E3. RECHAZADO: anon no lee encuesta_entrega -> 42501 ==='
begin;
set local role anon;
select public.t_esperar_error($q$select * from restaurantes.encuesta_entrega$q$, '42501');
rollback;

\echo '=== E4. RECHAZADO: el owner no inserta una encuesta directo -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4111', true);
select public.t_esperar_error($q$insert into restaurantes.encuesta_entrega (organization_id, property_id, order_id) values ('00000000-0000-0000-0000-0000000e4101', '00000000-0000-0000-0000-0000000e41a1', '00000000-0000-0000-0000-0000000e4191')$q$, '42501');
rollback;

\echo '=== E5. RECHAZADO: el owner no modifica una calificacion directo -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4111', true);
select public.t_esperar_error($q$update restaurantes.encuesta_entrega set calificacion = 5 where order_id = '00000000-0000-0000-0000-0000000e419b'$q$, '42501');
rollback;

\echo '=== E6. CHECK: calificacion 7 no cabe ==='
begin;
set local role authenticated;
reset role;
select public.t_esperar_error($q$insert into restaurantes.encuesta_entrega (organization_id, property_id, order_id, respondida_at, calificacion) values ('00000000-0000-0000-0000-0000000e4101', '00000000-0000-0000-0000-0000000e41a1', '00000000-0000-0000-0000-0000000e4191', now(), 7)$q$, '23514');
rollback;

\echo '=== E7. CHECK: respondida_at sin calificacion no cabe ==='
begin;
set local role authenticated;
reset role;
select public.t_esperar_error($q$insert into restaurantes.encuesta_entrega (organization_id, property_id, order_id, respondida_at) values ('00000000-0000-0000-0000-0000000e4101', '00000000-0000-0000-0000-0000000e41a1', '00000000-0000-0000-0000-0000000e4191', now())$q$, '23514');
rollback;

\echo '=== E8. UNIQUE: una sola encuesta por pedido ==='
begin;
set local role authenticated;
reset role;
select public.t_esperar_error($q$insert into restaurantes.encuesta_entrega (organization_id, property_id, order_id) values ('00000000-0000-0000-0000-0000000e4101', '00000000-0000-0000-0000-0000000e41a1', '00000000-0000-0000-0000-0000000e419a')$q$, '23505');
rollback;

\echo '=== E9. CHECK: la tabla rechaza una liga de resenas javascript: ==='
begin;
set local role authenticated;
reset role;
select public.t_esperar_error($q$update restaurantes.encuesta_config set resenas_url = 'javascript:alert(1)' where property_id = '00000000-0000-0000-0000-0000000e41a1'$q$, '23514');
rollback;

\echo '=== E10. ningun GRANT de tabla a anon ni authenticated en las dos tablas nuevas ==='
begin;
set local role authenticated;
reset role;
select count(*) as grants_deberia_ser_0 from information_schema.role_table_grants where table_schema = 'restaurantes' and table_name in ('encuesta_entrega', 'encuesta_config') and grantee in ('anon', 'authenticated', 'PUBLIC');
rollback;

\echo '=== E11. RLS activo en las dos tablas nuevas ==='
begin;
set local role authenticated;
reset role;
select count(*) as rls_deberia_ser_2 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'restaurantes' and c.relname in ('encuesta_entrega', 'encuesta_config') and c.relrowsecurity;
rollback;

\echo '=== E12. las 7 funciones nuevas son security definer con search_path fijo ==='
begin;
set local role authenticated;
reset role;
select count(*) as definer_deberia_ser_7 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'restaurantes' and p.proname like 'encuesta\_%' and p.prosecdef and p.proconfig::text like '%search_path%';
rollback;

\echo '=== F1. base SIN migrar: la funcion eliminada da 42883 y la transaccion se recupera con subtransaccion ==='
begin;
drop function restaurantes.encuesta_resumen(uuid, date, date, uuid);
do $$
declare
  v_state text;
begin
  begin
    perform restaurantes.encuesta_resumen('00000000-0000-0000-0000-0000000e4101', date '2026-03-10', date '2026-03-11', null);
    raise exception 'se esperaba SQLSTATE 42883 y la llamada no fallo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    if v_state <> '42883' then
      raise exception 'se esperaba SQLSTATE 42883, se obtuvo %', v_state;
    end if;
  end;
end $$;
select 1 as transaccion_recuperada_deberia_ser_1;
rollback;

\echo 'Todos los escenarios terminan con la expectativa del propio archivo: RECHAZADO = sin ERROR dentro de t_esperar_error (el helper exige el SQLSTATE exacto); alias deberia_ser_N = valor exacto.'
