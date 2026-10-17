-- Verifica, contra Postgres REAL (RLS + GRANT + auth.uid() reales), la migracion
-- packages/db/migrations/0057_superadmin_preflight_organizacion.sql (hechos de solo lectura del "Listo para produccion"):
--
--   A) Autorizacion: solo un superadmin real con su propio uid; staff normal (owner de la propia organizacion), uid ajeno
--      (caller-binding), sesion de sistema y anon reciben 42501.
--   B) Contenido correcto para una organizacion de restaurantes: sucursales (activa/inactiva, coordenadas, productos, horario,
--      pedido minimo, zonas, numero propio, voz), canal general, agente, pedidos y privacidad.
--   C) Aislamiento: nada de otra organizacion; vertical distinta de restaurantes -> restaurantes null; inexistente -> NULL.
--   D) La respuesta no trae correos, telefonos ni la URL del aviso de privacidad.
--   E) Base sin una tabla (simulada): ESE bloque queda en NULL y el resto se entrega (nunca un cero inventado).
--   F) GRANT y estructura: sin EXECUTE para anon, security definer con search_path fijo.
--
-- Convenciones del gate (scripts/verify-real-postgres-ci/run-gate.mjs): cada escenario es un begin/rollback propio; un escenario con
-- alias de error esperado debe terminar en ERROR; el alias deberia_ser_N exige que la ultima fila valga N; el resto debe completar sin
-- error. Las comprobaciones de contenido son bloques DO que lanzan si no se cumple lo esperado.
-- Sesion de SISTEMA = rol authenticated con request.jwt.claim.sub vacio.
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug, status) values
  ('00000000-0000-0000-0000-0000000f4000', 'restaurantes', 'Org A preflight', 'org-pf-a', 'active'),
  ('00000000-0000-0000-0000-0000000f4001', 'restaurantes', 'Org B preflight', 'org-pf-b', 'active'),
  ('00000000-0000-0000-0000-0000000f4002', 'citas', 'Org C preflight', 'org-pf-c', 'active')
on conflict do nothing;
insert into core.property (id, organization_id, vertical, name, status) values
  ('00000000-0000-0000-0000-0000000f4300', '00000000-0000-0000-0000-0000000f4000', 'restaurantes', 'Sucursal A1', 'active'),
  ('00000000-0000-0000-0000-0000000f4301', '00000000-0000-0000-0000-0000000f4000', 'restaurantes', 'Sucursal A2', 'active'),
  ('00000000-0000-0000-0000-0000000f4302', '00000000-0000-0000-0000-0000000f4000', 'restaurantes', 'Sucursal A3 inactiva', 'inactive'),
  ('00000000-0000-0000-0000-0000000f4310', '00000000-0000-0000-0000-0000000f4001', 'restaurantes', 'Sucursal B1 solo de B', 'active')
on conflict do nothing;
insert into restaurantes.branch_detail (property_id, slug, phone, address, lat, lng, display_order, organization_id) values
  ('00000000-0000-0000-0000-0000000f4300', 'a1', '9990000001', 'Calle Secreta 1', 20.97, -89.62, 1, '00000000-0000-0000-0000-0000000f4000'),
  ('00000000-0000-0000-0000-0000000f4301', 'a2', null, null, null, null, 2, '00000000-0000-0000-0000-0000000f4000'),
  ('00000000-0000-0000-0000-0000000f4302', 'a3', null, null, 20.9, -89.6, 3, '00000000-0000-0000-0000-0000000f4000'),
  ('00000000-0000-0000-0000-0000000f4310', 'b1', null, null, null, null, 1, '00000000-0000-0000-0000-0000000f4001')
on conflict do nothing;
insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000f4100', 'sa-pf@example.com', 'Superadmin PF Secreto', 'seed'),
  ('00000000-0000-0000-0000-0000000f4101', 'owner-a-pf@example.com', 'Dueno A Secreto', 'seed'),
  ('00000000-0000-0000-0000-0000000f4102', 'staff-a-pf@example.com', 'Staff A Secreto', 'seed'),
  ('00000000-0000-0000-0000-0000000f4103', 'repartidor-a-pf@example.com', 'Repartidor A Secreto', 'seed'),
  ('00000000-0000-0000-0000-0000000f4104', 'owner-b-pf@example.com', 'Dueno B Secreto', 'seed')
on conflict do nothing;
insert into core.platform_superadmin (staff_user_id) values ('00000000-0000-0000-0000-0000000f4100') on conflict do nothing;
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000f4101', '00000000-0000-0000-0000-0000000f4000', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000f4102', '00000000-0000-0000-0000-0000000f4000', array['00000000-0000-0000-0000-0000000f4300']::uuid[], 'member', 'staff'),
  ('00000000-0000-0000-0000-0000000f4103', '00000000-0000-0000-0000-0000000f4000', null, 'member', 'repartidor'),
  ('00000000-0000-0000-0000-0000000f4104', '00000000-0000-0000-0000-0000000f4001', null, 'owner', 'owner')
on conflict do nothing;

-- Datos de la org A: A1 completa, A2 vacia.
insert into restaurantes.products (id, organization_id, name, price, is_available) values
  ('00000000-0000-0000-0000-0000000f4500', '00000000-0000-0000-0000-0000000f4000', 'Taco PF 1', 20, true),
  ('00000000-0000-0000-0000-0000000f4501', '00000000-0000-0000-0000-0000000f4000', 'Taco PF 2', 25, true),
  ('00000000-0000-0000-0000-0000000f4502', '00000000-0000-0000-0000-0000000f4000', 'Taco PF 3 agotado', 30, true)
on conflict do nothing;
insert into restaurantes.branch_products (property_id, product_id, price, is_available) values
  ('00000000-0000-0000-0000-0000000f4300', '00000000-0000-0000-0000-0000000f4500', 20, true),
  ('00000000-0000-0000-0000-0000000f4300', '00000000-0000-0000-0000-0000000f4501', 25, true),
  ('00000000-0000-0000-0000-0000000f4300', '00000000-0000-0000-0000-0000000f4502', 30, false);
insert into restaurantes.branch_policy (property_id, organization_id, horario, pedido_minimo_domicilio) values
  ('00000000-0000-0000-0000-0000000f4300', '00000000-0000-0000-0000-0000000f4000',
   '[{"dias":[1,2,3],"abre":"09:00","cierra":"15:00"},{"dias":[1,2,3],"abre":"15:00","cierra":"23:00"}]'::jsonb, 80);
insert into restaurantes.known_zone (id, organization_id, name, lat, lng) values
  ('00000000-0000-0000-0000-0000000f4600', '00000000-0000-0000-0000-0000000f4000', 'Colonia PF', 20.9, -89.6);
insert into restaurantes.branch_delivery_zone (property_id, zone_id, organization_id) values
  ('00000000-0000-0000-0000-0000000f4300', '00000000-0000-0000-0000-0000000f4600', '00000000-0000-0000-0000-0000000f4000');
insert into restaurantes.whatsapp_channel_config (organization_id, phone_number_id) values ('00000000-0000-0000-0000-0000000f4000', 'pn-pf-general-secreto');
insert into restaurantes.whatsapp_branch_channel (phone_number_id, organization_id, property_id) values
  ('pn-pf-a1-secreto', '00000000-0000-0000-0000-0000000f4000', '00000000-0000-0000-0000-0000000f4300');
insert into restaurantes.branch_voice_config (property_id, organization_id, habilitado, proveedor, voice_id) values
  ('00000000-0000-0000-0000-0000000f4300', '00000000-0000-0000-0000-0000000f4000', true, 'gemini-3.8-live', 'Kore'),
  ('00000000-0000-0000-0000-0000000f4301', '00000000-0000-0000-0000-0000000f4000', false, 'gemini-3.8-live', 'Kore');
insert into restaurantes.whatsapp_agent_config (organization_id, property_id, perfil, agent_name) values
  ('00000000-0000-0000-0000-0000000f4000', null, 'taqueria_pm', 'Taquito');
insert into restaurantes.orders (organization_id, property_id, customer_name, customer_phone, total, items, status, created_at) values
  ('00000000-0000-0000-0000-0000000f4000', '00000000-0000-0000-0000-0000000f4300', 'Cliente Secreto', '5550000000', 100, '[]', 'pending', now());
insert into restaurantes.privacy_config (organization_id, responsible_name, notice_url) values
  ('00000000-0000-0000-0000-0000000f4000', 'Taquitos PF SA de CV', 'https://aviso-secreto.example.com/privacidad');

-- ═══════════════════════════════════════════════════════════════════════════
-- A) Autorizacion
-- ═══════════════════════════════════════════════════════════════════════════
\echo 'A1. superadmin lee la org A: una fila jsonb no nula -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f4100', true);
select (core.get_org_preflight_restaurantes_for_superadmin('00000000-0000-0000-0000-0000000f4100', '00000000-0000-0000-0000-0000000f4000') is not null)::int as deberia_ser_1;
rollback;

\echo 'A2. owner de la propia org A (staff normal) no lee: 42501 -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f4101', true);
do $$ declare v_ok boolean := false; begin
  begin perform core.get_org_preflight_restaurantes_for_superadmin('00000000-0000-0000-0000-0000000f4101', '00000000-0000-0000-0000-0000000f4000'); exception when sqlstate '42501' then v_ok := true; end;
  if not v_ok then raise exception 'esperaba SQLSTATE 42501'; end if;
end $$;
rollback;

\echo 'A3. caller-binding falso (uid del owner con el id del superadmin): 42501 -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f4101', true);
do $$ declare v_ok boolean := false; begin
  begin perform core.get_org_preflight_restaurantes_for_superadmin('00000000-0000-0000-0000-0000000f4100', '00000000-0000-0000-0000-0000000f4000'); exception when sqlstate '42501' then v_ok := true; end;
  if not v_ok then raise exception 'esperaba SQLSTATE 42501'; end if;
end $$;
rollback;

\echo 'A4. sesion de sistema (uid nulo) con el id del superadmin: 42501 -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
do $$ declare v_ok boolean := false; begin
  begin perform core.get_org_preflight_restaurantes_for_superadmin('00000000-0000-0000-0000-0000000f4100', '00000000-0000-0000-0000-0000000f4000'); exception when sqlstate '42501' then v_ok := true; end;
  if not v_ok then raise exception 'esperaba SQLSTATE 42501'; end if;
end $$;
rollback;

\echo 'A5. anon no tiene EXECUTE: 42501 -- RECHAZADO'
begin;
set local role anon;
do $$ declare v_ok boolean := false; begin
  begin perform core.get_org_preflight_restaurantes_for_superadmin('00000000-0000-0000-0000-0000000f4100', '00000000-0000-0000-0000-0000000f4000'); exception when sqlstate '42501' then v_ok := true; end;
  if not v_ok then raise exception 'esperaba SQLSTATE 42501'; end if;
end $$;
rollback;

-- ═══════════════════════════════════════════════════════════════════════════
-- B) Contenido de la org A
-- ═══════════════════════════════════════════════════════════════════════════
\echo 'B1. sucursales de la org A: tres, con sus hechos exactos -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f4100', true);
do $$ declare r jsonb; s jsonb; a1 jsonb; a2 jsonb; a3 jsonb; begin
  r := core.get_org_preflight_restaurantes_for_superadmin('00000000-0000-0000-0000-0000000f4100', '00000000-0000-0000-0000-0000000f4000');
  if r->>'vertical' <> 'restaurantes' then raise exception 'vertical: %', r->>'vertical'; end if;
  s := r->'restaurantes'->'sucursales';
  if jsonb_array_length(s) <> 3 then raise exception 'esperaba 3 sucursales: %', jsonb_array_length(s); end if;
  select e into a1 from jsonb_array_elements(s) e where e->>'nombre' = 'Sucursal A1';
  select e into a2 from jsonb_array_elements(s) e where e->>'nombre' = 'Sucursal A2';
  select e into a3 from jsonb_array_elements(s) e where e->>'nombre' = 'Sucursal A3 inactiva';
  if not (a1->>'activa')::boolean or not (a1->>'conCoordenadas')::boolean then raise exception 'A1 activa/coordenadas: %', a1; end if;
  if (a1->>'productosDisponibles')::int <> 2 then raise exception 'A1 productos disponibles debia ser 2: %', a1; end if;
  if jsonb_array_length(a1->'horario') <> 2 then raise exception 'A1 horario: %', a1; end if;
  if not (a1->>'conPedidoMinimoDomicilio')::boolean then raise exception 'A1 pedido minimo: %', a1; end if;
  if (a1->>'zonasDeEntrega')::int <> 1 then raise exception 'A1 zonas: %', a1; end if;
  if not (a1->>'conWhatsappPropio')::boolean then raise exception 'A1 whatsapp propio: %', a1; end if;
  if a1->>'voz' <> 'habilitada' then raise exception 'A1 voz: %', a1; end if;
  if not (a2->>'activa')::boolean then raise exception 'A2 debia estar activa'; end if;
  if (a2->>'conCoordenadas')::boolean or (a2->>'conWhatsappPropio')::boolean then raise exception 'A2 debia estar vacia: %', a2; end if;
  if (a2->>'productosDisponibles')::int <> 0 or (a2->>'zonasDeEntrega')::int <> 0 then raise exception 'A2 sin menu ni zonas: %', a2; end if;
  if a2->'horario' <> 'null'::jsonb then raise exception 'A2 sin politica -> horario null: %', a2; end if;
  if a2->>'voz' <> 'deshabilitada' then raise exception 'A2 voz deshabilitada a proposito: %', a2; end if;
  if (a3->>'activa')::boolean then raise exception 'A3 debia estar inactiva'; end if;
  if a3->>'voz' <> 'sin_configurar' then raise exception 'A3 voz sin configurar: %', a3; end if;
end $$;
rollback;

\echo 'B2. canal general, agente, pedidos y privacidad de la org A -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f4100', true);
do $$ declare r jsonb; x jsonb; begin
  r := core.get_org_preflight_restaurantes_for_superadmin('00000000-0000-0000-0000-0000000f4100', '00000000-0000-0000-0000-0000000f4000');
  x := r->'restaurantes';
  if not (x->>'whatsappGeneral')::boolean then raise exception 'whatsappGeneral: %', x; end if;
  if not (x->'agente'->>'configurada')::boolean or not (x->'agente'->>'conNombre')::boolean then raise exception 'agente: %', x->'agente'; end if;
  if not (x->>'hayPedidos')::boolean then raise exception 'hayPedidos: %', x; end if;
  if not (x->'privacidad'->>'configurada')::boolean or not (x->'privacidad'->>'conResponsable')::boolean or not (x->'privacidad'->>'conAviso')::boolean then raise exception 'privacidad: %', x->'privacidad'; end if;
  if x->'privacidad'->>'version' <> 'v1' then raise exception 'version: %', x->'privacidad'; end if;
  if (x->'privacidad'->>'avisosPublicados')::int <> 0 then raise exception 'avisosPublicados: %', x->'privacidad'; end if;
end $$;
rollback;

\echo 'B3. org B (restaurantes sin configurar): todo en falso/vacio, nunca datos de A -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f4100', true);
do $$ declare r jsonb; x jsonb; begin
  r := core.get_org_preflight_restaurantes_for_superadmin('00000000-0000-0000-0000-0000000f4100', '00000000-0000-0000-0000-0000000f4001');
  x := r->'restaurantes';
  if jsonb_array_length(x->'sucursales') <> 1 then raise exception 'org B debia tener 1 sucursal: %', x->'sucursales'; end if;
  if (x->'sucursales'->0->>'nombre') <> 'Sucursal B1 solo de B' then raise exception 'sucursal ajena: %', x->'sucursales'; end if;
  if (x->>'whatsappGeneral')::boolean or (x->>'hayPedidos')::boolean then raise exception 'B no tiene canal ni pedidos: %', x; end if;
  if (x->'agente'->>'configurada')::boolean then raise exception 'B sin agente: %', x->'agente'; end if;
  if (x->'privacidad'->>'configurada')::boolean or (x->'privacidad'->>'conAviso')::boolean then raise exception 'B sin privacidad: %', x->'privacidad'; end if;
end $$;
rollback;

-- ═══════════════════════════════════════════════════════════════════════════
-- C) Vertical distinta, inexistente
-- ═══════════════════════════════════════════════════════════════════════════
\echo 'C1. organizacion de citas: restaurantes null (no aplica) -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f4100', true);
select ((core.get_org_preflight_restaurantes_for_superadmin('00000000-0000-0000-0000-0000000f4100', '00000000-0000-0000-0000-0000000f4002')->>'vertical') = 'citas'
        and (core.get_org_preflight_restaurantes_for_superadmin('00000000-0000-0000-0000-0000000f4100', '00000000-0000-0000-0000-0000000f4002')->'restaurantes') = 'null'::jsonb)::int as deberia_ser_1;
rollback;

\echo 'C2. organizacion inexistente: NULL -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f4100', true);
select (core.get_org_preflight_restaurantes_for_superadmin('00000000-0000-0000-0000-0000000f4100', '00000000-0000-0000-0000-0000000f49ff') is null)::int as deberia_ser_1;
rollback;

-- ═══════════════════════════════════════════════════════════════════════════
-- D) Sin datos personales
-- ═══════════════════════════════════════════════════════════════════════════
\echo 'D1. la respuesta no trae correos, telefonos, numeros de WhatsApp ni la URL del aviso -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f4100', true);
do $$ declare t text; begin
  t := core.get_org_preflight_restaurantes_for_superadmin('00000000-0000-0000-0000-0000000f4100', '00000000-0000-0000-0000-0000000f4000')::text;
  if t like '%@%' or t like '%example.com%' or t like '%Secret%' or t like '%9990000001%' or t like '%5550000000%' or t like '%pn-pf%' or t like '%https://%' then
    raise exception 'la respuesta filtra un dato personal o una URL: %', t;
  end if;
end $$;
rollback;

-- ═══════════════════════════════════════════════════════════════════════════
-- E) Una tabla ausente deja SOLO su bloque en NULL
-- ═══════════════════════════════════════════════════════════════════════════
\echo 'E1. sin restaurantes.branch_policy (simulado): sucursales null y el resto intacto -- OK'
begin;
alter table restaurantes.branch_policy rename to branch_policy_ausente;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f4100', true);
do $$ declare x jsonb; begin
  x := core.get_org_preflight_restaurantes_for_superadmin('00000000-0000-0000-0000-0000000f4100', '00000000-0000-0000-0000-0000000f4000')->'restaurantes';
  if x->'sucursales' <> 'null'::jsonb then raise exception 'sucursales debia ser null: %', x->'sucursales'; end if;
  if not (x->>'whatsappGeneral')::boolean or not (x->>'hayPedidos')::boolean then raise exception 'el resto debia entregarse: %', x; end if;
end $$;
rollback;

\echo 'E2. sin restaurantes.privacy_config (simulado): privacidad null y el resto intacto -- OK'
begin;
alter table restaurantes.privacy_config rename to privacy_config_ausente;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f4100', true);
do $$ declare x jsonb; begin
  x := core.get_org_preflight_restaurantes_for_superadmin('00000000-0000-0000-0000-0000000f4100', '00000000-0000-0000-0000-0000000f4000')->'restaurantes';
  if x->'privacidad' <> 'null'::jsonb then raise exception 'privacidad debia ser null: %', x->'privacidad'; end if;
  if jsonb_array_length(x->'sucursales') <> 3 then raise exception 'sucursales debia entregarse: %', x; end if;
end $$;
rollback;

-- ═══════════════════════════════════════════════════════════════════════════
-- F) GRANT y estructura
-- ═══════════════════════════════════════════════════════════════════════════
\echo 'F1. anon sin EXECUTE, authenticated con EXECUTE, security definer con search_path fijo -- OK'
select (
  not has_function_privilege('anon', 'core.get_org_preflight_restaurantes_for_superadmin(uuid, uuid)', 'execute')
  and has_function_privilege('authenticated', 'core.get_org_preflight_restaurantes_for_superadmin(uuid, uuid)', 'execute')
  and (select p.prosecdef and exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%')
         from pg_proc p where p.oid = 'core.get_org_preflight_restaurantes_for_superadmin(uuid, uuid)'::regprocedure)
)::int as deberia_ser_1;
