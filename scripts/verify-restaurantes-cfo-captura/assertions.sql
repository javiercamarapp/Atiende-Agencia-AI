-- Fixtures + escenarios contra Postgres REAL (RLS + GRANT + auth.uid() reales, rol REAL authenticated) de
-- packages/domain-restaurantes/migrations/083_cfo_captura_y_softrestaurant_import.sql (CFO-03).
--
--   C. Configuracion del CFO: defaults sin fila (y que coinciden con los DEFAULT de la tabla), guardado con rangos (22023),
--      admin acotado/staff/repartidor/otra organizacion/sistema/anon, bitacora, sin DML directo.
--   K. Costos: version vigente unica y reemplazada, historial, filas de organizacion solo para organizacion completa,
--      alcance por sucursal, validaciones (22023), append-only (0A000), aditividad.
--   S. SoftRestaurant: importacion idempotente por huella, reemplazo por dias (se marca, no se borra), derivacion del resumen
--      desde cuentas, llaves de cliente rechazadas, topes de renglones, errores acotados a 50, folio unico entre vigentes,
--      alcance y roles, sin DML directo, lectura, lotes, cobertura.
--   E. Bitacora de exportaciones.
--   G. Seguridad transversal: search_path fijo en cada funcion nueva, anon sin execute, helpers internos sin execute.
--
-- Convenciones del gate (run-gate.mjs): cada escenario es `begin; ... rollback;`; el alias de columna que termina en el
-- sufijo de valor esperado marca el entero exacto; el helper t_esperar_error exige el SQLSTATE exacto.
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
  ('00000000-0000-0000-0000-0000000e8301', 'restaurantes', 'CFO Captura Org A', 'cfo-cap-a'),
  ('00000000-0000-0000-0000-0000000e8302', 'restaurantes', 'CFO Captura Org B (ajena)', 'cfo-cap-b')
on conflict do nothing;

insert into core.property (id, organization_id, name) values
  ('00000000-0000-0000-0000-0000000e83a1', '00000000-0000-0000-0000-0000000e8301', 'Sucursal A1'),
  ('00000000-0000-0000-0000-0000000e83a2', '00000000-0000-0000-0000-0000000e8301', 'Sucursal A2'),
  ('00000000-0000-0000-0000-0000000e83b1', '00000000-0000-0000-0000-0000000e8302', 'Sucursal B1')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000e8311', 'owner-a@cfocap.example.com', 'Owner A', 'seed'),
  ('00000000-0000-0000-0000-0000000e8312', 'admin-a1@cfocap.example.com', 'Admin A1 (solo A1)', 'seed'),
  ('00000000-0000-0000-0000-0000000e8313', 'staff-a@cfocap.example.com', 'Staff A', 'seed'),
  ('00000000-0000-0000-0000-0000000e8314', 'rep-a@cfocap.example.com', 'Repartidor A', 'seed'),
  ('00000000-0000-0000-0000-0000000e8315', 'owner-b@cfocap.example.com', 'Owner B (ajeno)', 'seed')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000e8311', '00000000-0000-0000-0000-0000000e8301', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000e8312', '00000000-0000-0000-0000-0000000e8301', array['00000000-0000-0000-0000-0000000e83a1']::uuid[], 'admin', 'admin'),
  ('00000000-0000-0000-0000-0000000e8313', '00000000-0000-0000-0000-0000000e8301', null, 'member', 'staff'),
  ('00000000-0000-0000-0000-0000000e8314', '00000000-0000-0000-0000-0000000e8301', null, 'member', 'repartidor'),
  ('00000000-0000-0000-0000-0000000e8315', '00000000-0000-0000-0000-0000000e8302', null, 'owner', 'owner')
on conflict do nothing;

-- Archivos SINTETICOS de SoftRestaurant (solo para estas pruebas; jamas a la base real).
create or replace function public.t_res1() returns jsonb language sql as $f$
  select '[
    {"dia_negocio":"2026-03-10","tipo_servicio":"comedor","forma_pago":"Efectivo","tickets":10,"bruta_centavos":100000,"descuento_centavos":5000,"cancelado_centavos":2000,"propina_centavos":8000,"iva_centavos":13103,"neta_centavos":95000},
    {"dia_negocio":"2026-03-10","tipo_servicio":"comedor","forma_pago":"TARJETA","tickets":5,"bruta_centavos":50000,"descuento_centavos":0,"cancelado_centavos":0,"propina_centavos":4000,"iva_centavos":6896,"neta_centavos":50000},
    {"dia_negocio":"2026-03-10","tipo_servicio":"domicilio","tickets":4,"bruta_centavos":40000,"neta_centavos":40000},
    {"dia_negocio":"2026-03-11","tipo_servicio":"comedor","tickets":3,"bruta_centavos":30000,"neta_centavos":30000}
  ]'::jsonb $f$;
create or replace function public.t_res2() returns jsonb language sql as $f$
  select '[{"dia_negocio":"2026-03-10","tipo_servicio":"comedor","tickets":20,"bruta_centavos":200000,"neta_centavos":190000,"iva_centavos":26207}]'::jsonb $f$;
create or replace function public.t_res3() returns jsonb language sql as $f$
  select '[
    {"dia_negocio":"2026-03-10","tipo_servicio":"comedor","tickets":20,"bruta_centavos":200000,"neta_centavos":190000},
    {"dia_negocio":"2026-03-11","tipo_servicio":"comedor","tickets":6,"bruta_centavos":60000,"neta_centavos":60000}
  ]'::jsonb $f$;
create or replace function public.t_cta1() returns jsonb language sql as $f$
  select '[
    {"folio":"1001","dia_negocio":"2026-03-10","hora_local":"13:05","tipo_servicio":"comedor","total_centavos":11600,"descuento_centavos":0,"propina_centavos":1000,"forma_pago":"Efectivo","cancelado":false},
    {"folio":"1002","dia_negocio":"2026-03-10","hora_local":"14:00","tipo_servicio":"comedor","total_centavos":23200,"descuento_centavos":2000,"propina_centavos":2000,"forma_pago":"Tarjeta","cancelado":false},
    {"folio":"1003","dia_negocio":"2026-03-10","tipo_servicio":"domicilio","total_centavos":9000,"forma_pago":"tarjeta"},
    {"folio":"1004","dia_negocio":"2026-03-10","tipo_servicio":"comedor","total_centavos":5000,"forma_pago":"efectivo","cancelado":true},
    {"folio":1005,"dia_negocio":"2026-03-11","tipo_servicio":"comedor","total_centavos":7000}
  ]'::jsonb $f$;
create or replace function public.t_cta2() returns jsonb language sql as $f$
  select '[
    {"folio":"1001","dia_negocio":"2026-03-15","tipo_servicio":"comedor","total_centavos":100},
    {"folio":"1006","dia_negocio":"2026-03-15","tipo_servicio":"comedor","total_centavos":200}
  ]'::jsonb $f$;

\echo '=== C1. sin fila: frecuente_n por default es 3 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select frecuente_n as frecuente_n_deberia_ser_3 from restaurantes.cfo_config_leer('00000000-0000-0000-0000-0000000e8301');
rollback;

\echo '=== C2. sin fila: iva_pct por default es 16 (x100) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select (iva_pct * 100)::int as iva_x100_deberia_ser_1600 from restaurantes.cfo_config_leer('00000000-0000-0000-0000-0000000e8301');
rollback;

\echo '=== C3. sin fila: comision_terminal_pct es nula (captura pendiente) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select (comision_terminal_pct is null)::int as comision_nula_deberia_ser_1 from restaurantes.cfo_config_leer('00000000-0000-0000-0000-0000000e8301');
rollback;

\echo '=== C4. sin fila: updated_at nulo marca 'defaults' ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select (updated_at is null)::int as es_default_deberia_ser_1 from restaurantes.cfo_config_leer('00000000-0000-0000-0000-0000000e8301');
rollback;

\echo '=== C5. guardar parcial conserva el resto y persiste ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select restaurantes.cfo_config_guardar('00000000-0000-0000-0000-0000000e8301', '{"frecuente_n": 5, "comision_terminal_pct": 2.5}'::jsonb);
select (frecuente_n * 1000 + comision_terminal_pct * 10 + promesa_min * 100000)::int as mezcla_deberia_ser_5005025 from restaurantes.cfo_config_leer('00000000-0000-0000-0000-0000000e8301');
rollback;

\echo '=== C6. guardar deja una fila en audit_log (cfo.config_actualizada) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select restaurantes.cfo_config_guardar('00000000-0000-0000-0000-0000000e8301', '{"frecuente_n": 5}'::jsonb);
select count(*) as bitacora_deberia_ser_1 from restaurantes.audit_log where organization_id = '00000000-0000-0000-0000-0000000e8301' and action = 'cfo.config_actualizada';
rollback;

\echo '=== C7. guardar lo mismo otra vez no duplica la bitacora ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select restaurantes.cfo_config_guardar('00000000-0000-0000-0000-0000000e8301', '{"frecuente_n": 5}'::jsonb);
select restaurantes.cfo_config_guardar('00000000-0000-0000-0000-0000000e8301', '{"frecuente_n": 5}'::jsonb);
select count(*) as bitacora_deberia_ser_1 from restaurantes.audit_log where organization_id = '00000000-0000-0000-0000-0000000e8301' and action = 'cfo.config_actualizada';
rollback;

\echo '=== C8. RECHAZADO: frecuente_n=21 fuera de rango -> 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select public.t_esperar_error($q$select restaurantes.cfo_config_guardar('00000000-0000-0000-0000-0000000e8301', '{"frecuente_n": 21}'::jsonb)$q$, '22023');
rollback;

\echo '=== C9. RECHAZADO: frecuente_n=0 fuera de rango -> 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select public.t_esperar_error($q$select restaurantes.cfo_config_guardar('00000000-0000-0000-0000-0000000e8301', '{"frecuente_n": 0}'::jsonb)$q$, '22023');
rollback;

\echo '=== C10. RECHAZADO: frecuente_dias=29 fuera de rango -> 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select public.t_esperar_error($q$select restaurantes.cfo_config_guardar('00000000-0000-0000-0000-0000000e8301', '{"frecuente_dias": 29}'::jsonb)$q$, '22023');
rollback;

\echo '=== C11. RECHAZADO: iva_pct=31 fuera de rango -> 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select public.t_esperar_error($q$select restaurantes.cfo_config_guardar('00000000-0000-0000-0000-0000000e8301', '{"iva_pct": 31}'::jsonb)$q$, '22023');
rollback;

\echo '=== C12. RECHAZADO: promesa_min=9 fuera de rango -> 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select public.t_esperar_error($q$select restaurantes.cfo_config_guardar('00000000-0000-0000-0000-0000000e8301', '{"promesa_min": 9}'::jsonb)$q$, '22023');
rollback;

\echo '=== C13. RECHAZADO: caida_pct=0 fuera de rango -> 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select public.t_esperar_error($q$select restaurantes.cfo_config_guardar('00000000-0000-0000-0000-0000000e8301', '{"caida_pct": 0}'::jsonb)$q$, '22023');
rollback;

\echo '=== C14. RECHAZADO: sr_cuadre_verde_centavos=-1 fuera de rango -> 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select public.t_esperar_error($q$select restaurantes.cfo_config_guardar('00000000-0000-0000-0000-0000000e8301', '{"sr_cuadre_verde_centavos": -1}'::jsonb)$q$, '22023');
rollback;

\echo '=== C15. RECHAZADO: comision_terminal_pct=21 fuera de rango -> 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select public.t_esperar_error($q$select restaurantes.cfo_config_guardar('00000000-0000-0000-0000-0000000e8301', '{"comision_terminal_pct": 21}'::jsonb)$q$, '22023');
rollback;

\echo '=== C16. RECHAZADO: entrega_p90_max_min=4 fuera de rango -> 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select public.t_esperar_error($q$select restaurantes.cfo_config_guardar('00000000-0000-0000-0000-0000000e8301', '{"entrega_p90_max_min": 4}'::jsonb)$q$, '22023');
rollback;

\echo '=== C17. RECHAZADO: cierre_baja_pp=101 fuera de rango -> 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select public.t_esperar_error($q$select restaurantes.cfo_config_guardar('00000000-0000-0000-0000-0000000e8301', '{"cierre_baja_pp": 101}'::jsonb)$q$, '22023');
rollback;

\echo '=== C18. RECHAZADO: llave desconocida -> 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select public.t_esperar_error($q$select restaurantes.cfo_config_guardar('00000000-0000-0000-0000-0000000e8301', '{"inventada": 1}'::jsonb)$q$, '22023');
rollback;

\echo '=== C19. RECHAZADO: texto donde va un entero -> 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select public.t_esperar_error($q$select restaurantes.cfo_config_guardar('00000000-0000-0000-0000-0000000e8301', '{"frecuente_n": "3"}'::jsonb)$q$, '22023');
rollback;

\echo '=== C20. RECHAZADO: entero con decimales -> 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select public.t_esperar_error($q$select restaurantes.cfo_config_guardar('00000000-0000-0000-0000-0000000e8301', '{"frecuente_n": 3.5}'::jsonb)$q$, '22023');
rollback;

\echo '=== C21. RECHAZADO: activo_dias >= perdido_dias -> 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select public.t_esperar_error($q$select restaurantes.cfo_config_guardar('00000000-0000-0000-0000-0000000e8301', '{"activo_dias": 130}'::jsonb)$q$, '22023');
rollback;

\echo '=== C22. RECHAZADO: umbral verde mayor que ambar -> 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select public.t_esperar_error($q$select restaurantes.cfo_config_guardar('00000000-0000-0000-0000-0000000e8301', '{"sr_cuadre_verde_pct": 5}'::jsonb)$q$, '22023');
rollback;

\echo '=== C23. comision_terminal_pct admite volver a null ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select restaurantes.cfo_config_guardar('00000000-0000-0000-0000-0000000e8301', '{"comision_terminal_pct": 2}'::jsonb);
select restaurantes.cfo_config_guardar('00000000-0000-0000-0000-0000000e8301', '{"comision_terminal_pct": null}'::jsonb);
select (comision_terminal_pct is null)::int as vuelve_nula_deberia_ser_1 from restaurantes.cfo_config_leer('00000000-0000-0000-0000-0000000e8301');
rollback;

\echo '=== C24. RECHAZADO: admin acotado no guarda -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8312', true);
select public.t_esperar_error($q$select restaurantes.cfo_config_guardar('00000000-0000-0000-0000-0000000e8301', '{"frecuente_n": 4}'::jsonb)$q$, '42501');
rollback;

\echo '=== C25. RECHAZADO: staff no guarda -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8313', true);
select public.t_esperar_error($q$select restaurantes.cfo_config_guardar('00000000-0000-0000-0000-0000000e8301', '{"frecuente_n": 4}'::jsonb)$q$, '42501');
rollback;

\echo '=== C26. RECHAZADO: repartidor no guarda -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8314', true);
select public.t_esperar_error($q$select restaurantes.cfo_config_guardar('00000000-0000-0000-0000-0000000e8301', '{"frecuente_n": 4}'::jsonb)$q$, '42501');
rollback;

\echo '=== C27. RECHAZADO: owner de otra organizacion no guarda -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8315', true);
select public.t_esperar_error($q$select restaurantes.cfo_config_guardar('00000000-0000-0000-0000-0000000e8301', '{"frecuente_n": 4}'::jsonb)$q$, '42501');
rollback;

\echo '=== C28. RECHAZADO: la sesion de sistema no guarda -> 42501 ==='
begin;
set local role authenticated;
select public.t_esperar_error($q$select restaurantes.cfo_config_guardar('00000000-0000-0000-0000-0000000e8301', '{"frecuente_n": 4}'::jsonb)$q$, '42501');
rollback;

\echo '=== C29. RECHAZADO: anon sin execute -> 42501 ==='
begin;
set local role anon;
select public.t_esperar_error($q$select restaurantes.cfo_config_guardar('00000000-0000-0000-0000-0000000e8301', '{"frecuente_n": 4}'::jsonb)$q$, '42501');
rollback;

\echo '=== C30. lectura: el admin acotado puede leer la configuracion ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8312', true);
select count(*) as filas_deberia_ser_1 from restaurantes.cfo_config_leer('00000000-0000-0000-0000-0000000e8301');
rollback;

\echo '=== C31. RECHAZADO: staff no lee la configuracion -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8313', true);
select public.t_esperar_error($q$select * from restaurantes.cfo_config_leer('00000000-0000-0000-0000-0000000e8301')$q$, '42501');
rollback;

\echo '=== C32. RECHAZADO: otra organizacion no lee la configuracion -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8315', true);
select public.t_esperar_error($q$select * from restaurantes.cfo_config_leer('00000000-0000-0000-0000-0000000e8301')$q$, '42501');
rollback;

\echo '=== C33. la sesion de sistema lee la configuracion (tick de alertas) ==='
begin;
set local role authenticated;
select frecuente_n as frecuente_n_deberia_ser_3 from restaurantes.cfo_config_leer('00000000-0000-0000-0000-0000000e8301');
rollback;

\echo '=== C34. RECHAZADO: sistema con una organizacion inexistente -> 42501 ==='
begin;
set local role authenticated;
select public.t_esperar_error($q$select * from restaurantes.cfo_config_leer('00000000-0000-0000-0000-00000000dead')$q$, '42501');
rollback;

\echo '=== C35. RLS: owner y admin acotado ven la fila; staff y otra organizacion no ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select restaurantes.cfo_config_guardar('00000000-0000-0000-0000-0000000e8301', '{"frecuente_n": 4}'::jsonb);
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8312', true);
select count(*) from restaurantes.cfo_config;
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8313', true);
select count(*) as filas_staff_deberia_ser_0 from restaurantes.cfo_config;
rollback;

\echo '=== C36. RLS: owner de otra organizacion no ve la fila ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select restaurantes.cfo_config_guardar('00000000-0000-0000-0000-0000000e8301', '{"frecuente_n": 4}'::jsonb);
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8315', true);
select count(*) as filas_otra_org_deberia_ser_0 from restaurantes.cfo_config;
rollback;

\echo '=== C37. RECHAZADO: sin INSERT directo -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select public.t_esperar_error($q$insert into restaurantes.cfo_config (organization_id) values ('00000000-0000-0000-0000-0000000e8301')$q$, '42501');
rollback;

\echo '=== C38. RECHAZADO: sin UPDATE directo -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select restaurantes.cfo_config_guardar('00000000-0000-0000-0000-0000000e8301', '{"frecuente_n": 4}'::jsonb);
select public.t_esperar_error($q$update restaurantes.cfo_config set frecuente_n = 9$q$, '42501');
rollback;

\echo '=== C39. RECHAZADO: sin DELETE directo -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select public.t_esperar_error($q$delete from restaurantes.cfo_config$q$, '42501');
rollback;

\echo '=== C40. los defaults de lectura coinciden con los DEFAULT de la tabla ==='
begin;
insert into restaurantes.cfo_config (organization_id) values ('00000000-0000-0000-0000-0000000e8302');
select count(*) as difiere_deberia_ser_0 from (select 1 where (to_jsonb(restaurantes.cfo_config_efectiva('00000000-0000-0000-0000-0000000e8301')) - 'organization_id' - 'updated_at') is distinct from (select to_jsonb(c) - 'organization_id' - 'updated_at' from restaurantes.cfo_config c where c.organization_id = '00000000-0000-0000-0000-0000000e8302')) x;
rollback;

\echo '=== C41. RECHAZADO: la tabla no admite un CHECK roto (frecuente_n = 0) -> 23514 ==='
begin;
select public.t_esperar_error($q$insert into restaurantes.cfo_config (organization_id, frecuente_n) values ('00000000-0000-0000-0000-0000000e8302', 0)$q$, '23514');
rollback;

\echo '=== K1. guardar y leer: el monto vigente sale tal cual ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select restaurantes.cfo_costo_guardar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', date '2026-03-01', 'insumos', 100000, null, null);
select monto_centavos as monto_deberia_ser_100000 from restaurantes.cfo_costos_leer('00000000-0000-0000-0000-0000000e8301', null, date '2026-03-01', date '2026-03-01');
rollback;

\echo '=== K2. guardar dos veces el mismo concepto deja 1 vigente y 1 reemplazada ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select restaurantes.cfo_costo_guardar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', date '2026-03-01', 'insumos', 100000, null, null);
select restaurantes.cfo_costo_guardar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', date '2026-03-01', 'insumos', 120000, null, null);
reset role;
select count(*) as vigentes_deberia_ser_1 from restaurantes.cfo_costo_captura where reemplazado_por is null and concepto = 'insumos';
rollback;

\echo '=== K3. guardar dos veces: 1 reemplazada marcada, no borrada ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select restaurantes.cfo_costo_guardar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', date '2026-03-01', 'insumos', 100000, null, null);
select restaurantes.cfo_costo_guardar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', date '2026-03-01', 'insumos', 120000, null, null);
reset role;
select count(*) as reemplazadas_deberia_ser_1 from restaurantes.cfo_costo_captura where reemplazado_por is not null and concepto = 'insumos';
rollback;

\echo '=== K4. el historial muestra las dos versiones ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select restaurantes.cfo_costo_guardar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', date '2026-03-01', 'insumos', 100000, null, null);
select restaurantes.cfo_costo_guardar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', date '2026-03-01', 'insumos', 120000, null, null);
select count(*) as versiones_deberia_ser_2 from restaurantes.cfo_costo_historial('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', date '2026-03-01', 'insumos');
rollback;

\echo '=== K5. el historial marca vigente solo la ultima ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select restaurantes.cfo_costo_guardar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', date '2026-03-01', 'insumos', 100000, null, null);
select restaurantes.cfo_costo_guardar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', date '2026-03-01', 'insumos', 120000, null, null);
select monto_centavos as vigente_deberia_ser_120000 from restaurantes.cfo_costo_historial('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', date '2026-03-01', 'insumos') where vigente;
rollback;

\echo '=== K6. la lectura trae solo la version vigente ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select restaurantes.cfo_costo_guardar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', date '2026-03-01', 'insumos', 100000, null, null);
select restaurantes.cfo_costo_guardar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', date '2026-03-01', 'insumos', 120000, null, null);
select count(*) as filas_deberia_ser_1 from restaurantes.cfo_costos_leer('00000000-0000-0000-0000-0000000e8301', null, date '2026-03-01', date '2026-03-01');
rollback;

\echo '=== K7. costo de organizacion (sucursal nula): lo ve el owner ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select restaurantes.cfo_costo_guardar('00000000-0000-0000-0000-0000000e8301', null, date '2026-03-01', 'nomina', 500000, null, null);
select count(*) as org_owner_deberia_ser_1 from restaurantes.cfo_costos_leer('00000000-0000-0000-0000-0000000e8301', null, date '2026-03-01', date '2026-03-01') where property_id is null;
rollback;

\echo '=== K8. costo de organizacion: el admin acotado NO lo ve ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select restaurantes.cfo_costo_guardar('00000000-0000-0000-0000-0000000e8301', null, date '2026-03-01', 'nomina', 500000, null, null);
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8312', true);
select count(*) as org_admin_deberia_ser_0 from restaurantes.cfo_costos_leer('00000000-0000-0000-0000-0000000e8301', null, date '2026-03-01', date '2026-03-01');
rollback;

\echo '=== K9. RLS directa: el admin acotado no ve filas de organizacion ni de otra sucursal ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select restaurantes.cfo_costo_guardar('00000000-0000-0000-0000-0000000e8301', null, date '2026-03-01', 'nomina', 500000, null, null);
select restaurantes.cfo_costo_guardar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a2', date '2026-03-01', 'renta', 90000, null, null);
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8312', true);
select count(*) as filas_ajenas_deberia_ser_0 from restaurantes.cfo_costo_captura;
rollback;

\echo '=== K10. el admin acotado guarda en su sucursal ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8312', true);
select (restaurantes.cfo_costo_guardar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', date '2026-03-01', 'servicios', 30000, null, null) is not null)::int as guardo_deberia_ser_1;
rollback;

\echo '=== K11. RECHAZADO: el admin acotado no guarda en otra sucursal -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8312', true);
select public.t_esperar_error($q$select restaurantes.cfo_costo_guardar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a2', date '2026-03-01', 'servicios', 30000, null, null)$q$, '42501');
rollback;

\echo '=== K12. RECHAZADO: el admin acotado no guarda a nivel organizacion -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8312', true);
select public.t_esperar_error($q$select restaurantes.cfo_costo_guardar('00000000-0000-0000-0000-0000000e8301', null, date '2026-03-01', 'servicios', 30000, null, null)$q$, '42501');
rollback;

\echo '=== K13. RECHAZADO: monto y porcentaje a la vez -> 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select public.t_esperar_error($q$select restaurantes.cfo_costo_guardar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', date '2026-03-01', 'food_cost_objetivo_pct', 1000, 30, null)$q$, '22023');
rollback;

\echo '=== K14. RECHAZADO: ni monto ni porcentaje -> 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select public.t_esperar_error($q$select restaurantes.cfo_costo_guardar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', date '2026-03-01', 'insumos', null, null, null)$q$, '22023');
rollback;

\echo '=== K15. RECHAZADO: porcentaje en un concepto que no es food_cost_objetivo_pct -> 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select public.t_esperar_error($q$select restaurantes.cfo_costo_guardar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', date '2026-03-01', 'insumos', null, 30, null)$q$, '22023');
rollback;

\echo '=== K16. RECHAZADO: food_cost_objetivo_pct exige porcentaje -> 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select public.t_esperar_error($q$select restaurantes.cfo_costo_guardar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', date '2026-03-01', 'food_cost_objetivo_pct', 1000, null, null)$q$, '22023');
rollback;

\echo '=== K17. RECHAZADO: monto negativo -> 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select public.t_esperar_error($q$select restaurantes.cfo_costo_guardar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', date '2026-03-01', 'insumos', -1, null, null)$q$, '22023');
rollback;

\echo '=== K18. RECHAZADO: porcentaje mayor a 100 -> 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select public.t_esperar_error($q$select restaurantes.cfo_costo_guardar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', date '2026-03-01', 'food_cost_objetivo_pct', null, 101, null)$q$, '22023');
rollback;

\echo '=== K19. RECHAZADO: mes que no es dia 1 -> 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select public.t_esperar_error($q$select restaurantes.cfo_costo_guardar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', date '2026-03-15', 'insumos', 1000, null, null)$q$, '22023');
rollback;

\echo '=== K20. RECHAZADO: concepto inventado -> 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select public.t_esperar_error($q$select restaurantes.cfo_costo_guardar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', date '2026-03-01', 'propinas', 1000, null, null)$q$, '22023');
rollback;

\echo '=== K21. RECHAZADO: nota de mas de 300 caracteres -> 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select public.t_esperar_error($q$select restaurantes.cfo_costo_guardar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', date '2026-03-01', 'insumos', 1000, null, repeat('x', 301))$q$, '22023');
rollback;

\echo '=== K22. food_cost_objetivo_pct guarda el porcentaje ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select restaurantes.cfo_costo_guardar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', date '2026-03-01', 'food_cost_objetivo_pct', null, 32.5, null);
select (pct * 10)::int as pct_x10_deberia_ser_325 from restaurantes.cfo_costos_leer('00000000-0000-0000-0000-0000000e8301', null, date '2026-03-01', date '2026-03-01') where concepto = 'food_cost_objetivo_pct';
rollback;

\echo '=== K23. RECHAZADO: staff no guarda -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8313', true);
select public.t_esperar_error($q$select restaurantes.cfo_costo_guardar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', date '2026-03-01', 'insumos', 1000, null, null)$q$, '42501');
rollback;

\echo '=== K24. RECHAZADO: repartidor no guarda -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8314', true);
select public.t_esperar_error($q$select restaurantes.cfo_costo_guardar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', date '2026-03-01', 'insumos', 1000, null, null)$q$, '42501');
rollback;

\echo '=== K25. RECHAZADO: owner de otra organizacion no guarda -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8315', true);
select public.t_esperar_error($q$select restaurantes.cfo_costo_guardar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', date '2026-03-01', 'insumos', 1000, null, null)$q$, '42501');
rollback;

\echo '=== K26. RECHAZADO: la sesion de sistema no guarda -> 42501 ==='
begin;
set local role authenticated;
select public.t_esperar_error($q$select restaurantes.cfo_costo_guardar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', date '2026-03-01', 'insumos', 1000, null, null)$q$, '42501');
rollback;

\echo '=== K27. RECHAZADO: anon sin execute -> 42501 ==='
begin;
set local role anon;
select public.t_esperar_error($q$select restaurantes.cfo_costo_guardar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', date '2026-03-01', 'insumos', 1000, null, null)$q$, '42501');
rollback;

\echo '=== K28. RECHAZADO: sucursal de otra organizacion declarando la mia -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select public.t_esperar_error($q$select restaurantes.cfo_costo_guardar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83b1', date '2026-03-01', 'insumos', 1000, null, null)$q$, '42501');
rollback;

\echo '=== K29. RECHAZADO: el admin acotado no lee el historial de organizacion -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8312', true);
select public.t_esperar_error($q$select * from restaurantes.cfo_costo_historial('00000000-0000-0000-0000-0000000e8301', null, date '2026-03-01', 'nomina')$q$, '42501');
rollback;

\echo '=== K30. lista explicita de sucursales: nunca trae filas de organizacion ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select restaurantes.cfo_costo_guardar('00000000-0000-0000-0000-0000000e8301', null, date '2026-03-01', 'nomina', 500000, null, null);
select restaurantes.cfo_costo_guardar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', date '2026-03-01', 'insumos', 100000, null, null);
select count(*) as org_en_lista_deberia_ser_0 from restaurantes.cfo_costos_leer('00000000-0000-0000-0000-0000000e8301', array['00000000-0000-0000-0000-0000000e83a1']::uuid[], date '2026-03-01', date '2026-03-01') where property_id is null;
rollback;

\echo '=== K31. aditividad: todas = A1 + A2 + no asignado ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select restaurantes.cfo_costo_guardar('00000000-0000-0000-0000-0000000e8301', null, date '2026-03-01', 'nomina', 500000, null, null);
select restaurantes.cfo_costo_guardar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', date '2026-03-01', 'insumos', 100000, null, null);
select restaurantes.cfo_costo_guardar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a2', date '2026-03-01', 'insumos', 70000, null, null);
select ((select coalesce(sum(monto_centavos), 0) from restaurantes.cfo_costos_leer('00000000-0000-0000-0000-0000000e8301', null, date '2026-03-01', date '2026-03-01')) - (select coalesce(sum(monto_centavos), 0) from restaurantes.cfo_costos_leer('00000000-0000-0000-0000-0000000e8301', array['00000000-0000-0000-0000-0000000e83a1']::uuid[], date '2026-03-01', date '2026-03-01')) - (select coalesce(sum(monto_centavos), 0) from restaurantes.cfo_costos_leer('00000000-0000-0000-0000-0000000e8301', array['00000000-0000-0000-0000-0000000e83a2']::uuid[], date '2026-03-01', date '2026-03-01')) - (select coalesce(sum(monto_centavos), 0) from restaurantes.cfo_costos_leer('00000000-0000-0000-0000-0000000e8301', null, date '2026-03-01', date '2026-03-01') where property_id is null))::int as diferencia_deberia_ser_0;
rollback;

\echo '=== K32. el admin acotado con 'todas' recibe solo sus sucursales ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select restaurantes.cfo_costo_guardar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', date '2026-03-01', 'insumos', 100000, null, null);
select restaurantes.cfo_costo_guardar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a2', date '2026-03-01', 'insumos', 70000, null, null);
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8312', true);
select count(*) as solo_a1_deberia_ser_1 from restaurantes.cfo_costos_leer('00000000-0000-0000-0000-0000000e8301', null, date '2026-03-01', date '2026-03-01');
rollback;

\echo '=== K33. RECHAZADO: el admin acotado pide una sucursal ajena -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8312', true);
select public.t_esperar_error($q$select * from restaurantes.cfo_costos_leer('00000000-0000-0000-0000-0000000e8301', array['00000000-0000-0000-0000-0000000e83a2']::uuid[], date '2026-03-01', date '2026-03-01')$q$, '42501');
rollback;

\echo '=== K34. RECHAZADO: sucursal de otra organizacion -> 42501 (mismo mensaje) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select public.t_esperar_error($q$select * from restaurantes.cfo_costos_leer('00000000-0000-0000-0000-0000000e8301', array['00000000-0000-0000-0000-0000000e83b1']::uuid[], date '2026-03-01', date '2026-03-01')$q$, '42501');
rollback;

\echo '=== K35. RECHAZADO: owner de otra organizacion no lee -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8315', true);
select public.t_esperar_error($q$select * from restaurantes.cfo_costos_leer('00000000-0000-0000-0000-0000000e8301', null, date '2026-03-01', date '2026-03-01')$q$, '42501');
rollback;

\echo '=== K36. RECHAZADO: staff no lee -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8313', true);
select public.t_esperar_error($q$select * from restaurantes.cfo_costos_leer('00000000-0000-0000-0000-0000000e8301', null, date '2026-03-01', date '2026-03-01')$q$, '42501');
rollback;

\echo '=== K37. RECHAZADO: rango de mas de 400 dias -> 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select public.t_esperar_error($q$select * from restaurantes.cfo_costos_leer('00000000-0000-0000-0000-0000000e8301', null, date '2024-01-01', date '2026-03-01')$q$, '22023');
rollback;

\echo '=== K38. la sesion de sistema lee los costos de la organizacion (incluye no asignado) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select restaurantes.cfo_costo_guardar('00000000-0000-0000-0000-0000000e8301', null, date '2026-03-01', 'nomina', 500000, null, null);
reset role;
set local role authenticated;
select count(*) as sistema_deberia_ser_1 from restaurantes.cfo_costos_leer('00000000-0000-0000-0000-0000000e8301', null, date '2026-03-01', date '2026-03-01');
rollback;

\echo '=== K39. RECHAZADO: sistema con sucursal de otra organizacion -> 42501 ==='
begin;
set local role authenticated;
select public.t_esperar_error($q$select * from restaurantes.cfo_costos_leer('00000000-0000-0000-0000-0000000e8301', array['00000000-0000-0000-0000-0000000e83b1']::uuid[], date '2026-03-01', date '2026-03-01')$q$, '42501');
rollback;

\echo '=== K40. RECHAZADO: sin INSERT directo -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select public.t_esperar_error($q$insert into restaurantes.cfo_costo_captura (organization_id, mes, concepto, monto_centavos) values ('00000000-0000-0000-0000-0000000e8301', date '2026-03-01', 'insumos', 1)$q$, '42501');
rollback;

\echo '=== K41. RECHAZADO: sin UPDATE directo -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select restaurantes.cfo_costo_guardar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', date '2026-03-01', 'insumos', 100000, null, null);
select public.t_esperar_error($q$update restaurantes.cfo_costo_captura set monto_centavos = 1$q$, '42501');
rollback;

\echo '=== K42. RECHAZADO: sin DELETE directo -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select restaurantes.cfo_costo_guardar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', date '2026-03-01', 'insumos', 100000, null, null);
select public.t_esperar_error($q$delete from restaurantes.cfo_costo_captura$q$, '42501');
rollback;

\echo '=== K43. append-only: ni siquiera el propietario borra una captura -> 0A000 ==='
begin;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-0000000e8311';
select restaurantes.cfo_costo_guardar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', date '2026-03-01', 'insumos', 100000, null, null);
select public.t_esperar_error($q$delete from restaurantes.cfo_costo_captura$q$, '0A000');
rollback;

\echo '=== K44. append-only: ni el propietario cambia el monto de una captura -> 0A000 ==='
begin;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-0000000e8311';
select restaurantes.cfo_costo_guardar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', date '2026-03-01', 'insumos', 100000, null, null);
select public.t_esperar_error($q$update restaurantes.cfo_costo_captura set monto_centavos = 1$q$, '0A000');
rollback;

\echo '=== K45. append-only: una version reemplazada no se vuelve a reemplazar -> 0A000 ==='
begin;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-0000000e8311';
select restaurantes.cfo_costo_guardar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', date '2026-03-01', 'insumos', 100000, null, null);
select restaurantes.cfo_costo_guardar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', date '2026-03-01', 'insumos', 120000, null, null);
select public.t_esperar_error($q$update restaurantes.cfo_costo_captura set reemplazado_por = gen_random_uuid() where reemplazado_por is not null$q$, '0A000');
rollback;

\echo '=== K46. indice unico: dos versiones vigentes del mismo concepto -> 23505 ==='
begin;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-0000000e8311';
select restaurantes.cfo_costo_guardar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', date '2026-03-01', 'insumos', 100000, null, null);
select public.t_esperar_error($q$insert into restaurantes.cfo_costo_captura (organization_id, property_id, mes, concepto, monto_centavos) values ('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', date '2026-03-01', 'insumos', 5)$q$, '23505');
rollback;

\echo '=== K47. indice unico: tambien para la fila de organizacion (sucursal nula) -> 23505 ==='
begin;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-0000000e8311';
select restaurantes.cfo_costo_guardar('00000000-0000-0000-0000-0000000e8301', null, date '2026-03-01', 'nomina', 500000, null, null);
select public.t_esperar_error($q$insert into restaurantes.cfo_costo_captura (organization_id, property_id, mes, concepto, monto_centavos) values ('00000000-0000-0000-0000-0000000e8301', null, date '2026-03-01', 'nomina', 5)$q$, '23505');
rollback;

\echo '=== K48. CHECK: monto y porcentaje a la vez no entra ni por SQL directo -> 23514 ==='
begin;
select public.t_esperar_error($q$insert into restaurantes.cfo_costo_captura (organization_id, mes, concepto, monto_centavos, pct) values ('00000000-0000-0000-0000-0000000e8301', date '2026-03-01', 'food_cost_objetivo_pct', 1, 1)$q$, '23514');
rollback;

\echo '=== K49. la captura deja una fila de bitacora (cfo.costo_capturado) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select restaurantes.cfo_costo_guardar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', date '2026-03-01', 'insumos', 100000, null, null);
select count(*) as bitacora_deberia_ser_1 from restaurantes.audit_log where organization_id = '00000000-0000-0000-0000-0000000e8301' and action = 'cfo.costo_capturado';
rollback;

\echo '=== K50. el historial dice quien capturo ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select restaurantes.cfo_costo_guardar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', date '2026-03-01', 'insumos', 100000, null, null);
select count(*) as con_autor_deberia_ser_1 from restaurantes.cfo_costo_historial('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', date '2026-03-01', 'insumos') where created_by = '00000000-0000-0000-0000-0000000e8311';
rollback;

\echo '=== S1. importar un resumen por tipo de servicio: 4 aceptados ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select aceptados as aceptados_deberia_ser_4 from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('a', 64), 'resumen_servicio', 'ventas.csv', public.t_res1());
rollback;

\echo '=== S2. importar crea el lote (creado = verdadero) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select creado::int as creado_deberia_ser_1 from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('a', 64), 'resumen_servicio', 'ventas.csv', public.t_res1());
rollback;

\echo '=== S3. el mismo archivo dos veces: creado = falso ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('a', 64), 'resumen_servicio', 'ventas.csv', public.t_res1());
select creado::int as creado_deberia_ser_0 from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('a', 64), 'resumen_servicio', 'ventas.csv', public.t_res1());
rollback;

\echo '=== S4. el mismo archivo dos veces: un solo lote ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('a', 64), 'resumen_servicio', 'ventas.csv', public.t_res1());
select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('a', 64), 'resumen_servicio', 'ventas.csv', public.t_res1());
select count(*) as lotes_deberia_ser_1 from restaurantes.sr_import_lote;
rollback;

\echo '=== S5. el mismo archivo dos veces: no duplica renglones ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('a', 64), 'resumen_servicio', 'ventas.csv', public.t_res1());
select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('a', 64), 'resumen_servicio', 'ventas.csv', public.t_res1());
select count(*) as renglones_deberia_ser_4 from restaurantes.sr_resumen_dia;
rollback;

\echo '=== S6. el mismo archivo dos veces devuelve el mismo lote_id ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
create temp table t_l on commit drop as select lote_id from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('a', 64), 'resumen_servicio', 'ventas.csv', public.t_res1());
select count(*) as mismo_lote_deberia_ser_1 from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('a', 64), 'resumen_servicio', 'ventas.csv', public.t_res1()) r join t_l on t_l.lote_id = r.lote_id;
rollback;

\echo '=== S7. lectura: tickets del comedor del dia 10 (suma de formas de pago) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('a', 64), 'resumen_servicio', 'ventas.csv', public.t_res1());
select tickets as tickets_deberia_ser_15 from restaurantes.sr_resumen_leer('00000000-0000-0000-0000-0000000e8301', null, date '2026-03-10', date '2026-03-11') where tipo_servicio = 'comedor' and dia_negocio = '2026-03-10';
rollback;

\echo '=== S8. lectura: bruta del comedor del dia 10 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('a', 64), 'resumen_servicio', 'ventas.csv', public.t_res1());
select bruta_centavos as bruta_deberia_ser_150000 from restaurantes.sr_resumen_leer('00000000-0000-0000-0000-0000000e8301', null, date '2026-03-10', date '2026-03-11') where tipo_servicio = 'comedor' and dia_negocio = '2026-03-10';
rollback;

\echo '=== S9. lectura: IVA sumado cuando todos los renglones lo traen ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('a', 64), 'resumen_servicio', 'ventas.csv', public.t_res1());
select iva_centavos as iva_deberia_ser_19999 from restaurantes.sr_resumen_leer('00000000-0000-0000-0000-0000000e8301', null, date '2026-03-10', date '2026-03-11') where tipo_servicio = 'comedor' and dia_negocio = '2026-03-10';
rollback;

\echo '=== S10. lectura: IVA nulo cuando el archivo no lo trae (no se inventa) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('a', 64), 'resumen_servicio', 'ventas.csv', public.t_res1());
select (iva_centavos is null)::int as iva_nulo_deberia_ser_1 from restaurantes.sr_resumen_leer('00000000-0000-0000-0000-0000000e8301', null, date '2026-03-10', date '2026-03-11') where tipo_servicio = 'domicilio';
rollback;

\echo '=== S11. la forma de pago se normaliza a minusculas ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('a', 64), 'resumen_servicio', 'ventas.csv', public.t_res1());
reset role;
select count(*) as normalizadas_deberia_ser_2 from restaurantes.sr_resumen_dia where forma_pago in ('efectivo', 'tarjeta');
rollback;

\echo '=== S12. lote nuevo sobre los mismos dias: la lectura suma solo lo vigente ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('a', 64), 'resumen_servicio', 'ventas.csv', public.t_res1());
select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('b', 64), 'resumen_servicio', 'ventas2.csv', public.t_res2());
select tickets as tickets_deberia_ser_20 from restaurantes.sr_resumen_leer('00000000-0000-0000-0000-0000000e8301', null, date '2026-03-10', date '2026-03-10') where tipo_servicio = 'comedor';
rollback;

\echo '=== S13. lote nuevo: el dia 10 reemplazado pierde tambien el domicilio viejo ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('a', 64), 'resumen_servicio', 'ventas.csv', public.t_res1());
select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('b', 64), 'resumen_servicio', 'ventas2.csv', public.t_res2());
select count(*) as domicilio_deberia_ser_0 from restaurantes.sr_resumen_leer('00000000-0000-0000-0000-0000000e8301', null, date '2026-03-10', date '2026-03-10') where tipo_servicio = 'domicilio';
rollback;

\echo '=== S14. lote nuevo: el dia 11 no cubierto sigue vigente ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('a', 64), 'resumen_servicio', 'ventas.csv', public.t_res1());
select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('b', 64), 'resumen_servicio', 'ventas2.csv', public.t_res2());
select tickets as dia11_deberia_ser_3 from restaurantes.sr_resumen_leer('00000000-0000-0000-0000-0000000e8301', null, date '2026-03-11', date '2026-03-11') where tipo_servicio = 'comedor';
rollback;

\echo '=== S15. lote viejo con renglones vigentes sigue 'aplicado' ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('a', 64), 'resumen_servicio', 'ventas.csv', public.t_res1());
select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('b', 64), 'resumen_servicio', 'ventas2.csv', public.t_res2());
select count(*) as aplicados_deberia_ser_2 from restaurantes.sr_import_lote where estado = 'aplicado';
rollback;

\echo '=== S16. lote viejo sin renglones vigentes pasa a 'reemplazado' ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('a', 64), 'resumen_servicio', 'ventas.csv', public.t_res1());
select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('b', 64), 'resumen_servicio', 'ventas3.csv', public.t_res3());
select count(*) as reemplazados_deberia_ser_1 from restaurantes.sr_import_lote where estado = 'reemplazado';
rollback;

\echo '=== S17. reemplazar marca los renglones, no los borra ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('a', 64), 'resumen_servicio', 'ventas.csv', public.t_res1());
select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('b', 64), 'resumen_servicio', 'ventas3.csv', public.t_res3());
reset role;
select count(*) as marcados_deberia_ser_4 from restaurantes.sr_resumen_dia where estado = 'reemplazado';
rollback;

\echo '=== S18. reimportar el archivo viejo despues de reemplazarlo sigue siendo idempotente ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('a', 64), 'resumen_servicio', 'ventas.csv', public.t_res1());
select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('b', 64), 'resumen_servicio', 'ventas3.csv', public.t_res3());
select creado::int as creado_deberia_ser_0 from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('a', 64), 'resumen_servicio', 'ventas.csv', public.t_res1());
rollback;

\echo '=== S19. cuentas: se aceptan los 5 tickets ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select aceptados as aceptados_deberia_ser_5 from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('c', 64), 'cuentas', 'cuentas.csv', public.t_cta1());
rollback;

\echo '=== S20. cuentas: deriva el resumen (tickets del comedor del dia 10) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('c', 64), 'cuentas', 'cuentas.csv', public.t_cta1());
select tickets as tickets_deberia_ser_2 from restaurantes.sr_resumen_leer('00000000-0000-0000-0000-0000000e8301', null, date '2026-03-10', date '2026-03-10') where tipo_servicio = 'comedor';
rollback;

\echo '=== S21. cuentas: bruta derivada = total + descuento (36800) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('c', 64), 'cuentas', 'cuentas.csv', public.t_cta1());
select bruta_centavos as bruta_deberia_ser_36800 from restaurantes.sr_resumen_leer('00000000-0000-0000-0000-0000000e8301', null, date '2026-03-10', date '2026-03-10') where tipo_servicio = 'comedor';
rollback;

\echo '=== S22. cuentas: descuento derivado ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('c', 64), 'cuentas', 'cuentas.csv', public.t_cta1());
select descuento_centavos as descuento_deberia_ser_2000 from restaurantes.sr_resumen_leer('00000000-0000-0000-0000-0000000e8301', null, date '2026-03-10', date '2026-03-10') where tipo_servicio = 'comedor';
rollback;

\echo '=== S23. cuentas: la cuenta cancelada va a cancelado y no a tickets ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('c', 64), 'cuentas', 'cuentas.csv', public.t_cta1());
select cancelado_centavos as cancelado_deberia_ser_5000 from restaurantes.sr_resumen_leer('00000000-0000-0000-0000-0000000e8301', null, date '2026-03-10', date '2026-03-10') where tipo_servicio = 'comedor';
rollback;

\echo '=== S24. cuentas: propina derivada ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('c', 64), 'cuentas', 'cuentas.csv', public.t_cta1());
select propina_centavos as propina_deberia_ser_3000 from restaurantes.sr_resumen_leer('00000000-0000-0000-0000-0000000e8301', null, date '2026-03-10', date '2026-03-10') where tipo_servicio = 'comedor';
rollback;

\echo '=== S25. cuentas: neta derivada (11600 + 23200) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('c', 64), 'cuentas', 'cuentas.csv', public.t_cta1());
select neta_centavos as neta_deberia_ser_34800 from restaurantes.sr_resumen_leer('00000000-0000-0000-0000-0000000e8301', null, date '2026-03-10', date '2026-03-10') where tipo_servicio = 'comedor';
rollback;

\echo '=== S26. cuentas: IVA derivado es nulo (el layout no lo trae) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('c', 64), 'cuentas', 'cuentas.csv', public.t_cta1());
select (iva_centavos is null)::int as iva_nulo_deberia_ser_1 from restaurantes.sr_resumen_leer('00000000-0000-0000-0000-0000000e8301', null, date '2026-03-10', date '2026-03-10') where tipo_servicio = 'comedor';
rollback;

\echo '=== S27. cuentas: el folio numerico se guarda como texto ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('c', 64), 'cuentas', 'cuentas.csv', public.t_cta1());
select count(*) as folio_deberia_ser_1 from restaurantes.sr_ticket where folio = '1005';
rollback;

\echo '=== S28. cuentas: un archivo nuevo reemplaza las cuentas del dia ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('c', 64), 'cuentas', 'cuentas.csv', public.t_cta1());
select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('d', 64), 'cuentas', 'cuentas2.csv', '[{"folio":"2001","dia_negocio":"2026-03-10","tipo_servicio":"comedor","total_centavos":100}]'::jsonb);
reset role;
select count(*) as vigentes_dia10_deberia_ser_1 from restaurantes.sr_ticket where estado = 'vigente' and dia_negocio = '2026-03-10';
rollback;

\echo '=== S29. cuentas: reemplazar marca las viejas, no las borra ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('c', 64), 'cuentas', 'cuentas.csv', public.t_cta1());
select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('d', 64), 'cuentas', 'cuentas2.csv', '[{"folio":"2001","dia_negocio":"2026-03-10","tipo_servicio":"comedor","total_centavos":100}]'::jsonb);
reset role;
select count(*) as marcadas_deberia_ser_4 from restaurantes.sr_ticket where estado = 'reemplazado';
rollback;

\echo '=== S30. folio ya vigente en un dia que el archivo nuevo no cubre: se rechaza el renglon ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('c', 64), 'cuentas', 'cuentas.csv', public.t_cta1());
select rechazados as rechazados_deberia_ser_1 from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('d', 64), 'cuentas', 'cuentas2.csv', public.t_cta2());
rollback;

\echo '=== S31. folio en conflicto: el renglon sano del mismo archivo si entra ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('c', 64), 'cuentas', 'cuentas.csv', public.t_cta1());
select aceptados as aceptados_deberia_ser_1 from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('d', 64), 'cuentas', 'cuentas2.csv', public.t_cta2());
rollback;

\echo '=== S32. el folio es unico entre vigentes por sucursal (indice) -> 23505 ==='
begin;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-0000000e8311';
select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('c', 64), 'cuentas', 'cuentas.csv', public.t_cta1());
select public.t_esperar_error($q$insert into restaurantes.sr_ticket (lote_id, organization_id, property_id, folio, dia_negocio, tipo_servicio, total_centavos, descuento_centavos, propina_centavos) select lote_id, organization_id, property_id, '1001', dia_negocio, tipo_servicio, 1, 0, 0 from restaurantes.sr_ticket limit 1$q$, '23505');
rollback;

\echo '=== S33. el mismo folio puede existir en otra sucursal ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('c', 64), 'cuentas', 'cuentas.csv', public.t_cta1());
select aceptados as aceptados_deberia_ser_5 from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a2', repeat('d', 64), 'cuentas', 'cuentas.csv', public.t_cta1());
rollback;

\echo '=== S34. folio duplicado dentro del archivo: se rechaza el segundo ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select rechazados as rechazados_deberia_ser_1 from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('e', 64), 'cuentas', 'dup.csv', '[{"folio":"3001","dia_negocio":"2026-03-12","tipo_servicio":"comedor","total_centavos":100},{"folio":"3001","dia_negocio":"2026-03-12","tipo_servicio":"comedor","total_centavos":200}]'::jsonb);
rollback;

\echo '=== S35. RECHAZADO: la llave 'cliente' aborta toda la importacion -> 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select public.t_esperar_error($q$select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('c', 64), 'cuentas', 'cuentas.csv', '[{"folio":"1","dia_negocio":"2026-03-10","tipo_servicio":"comedor","total_centavos":100,"cliente":"Ana"}]'::jsonb)$q$, '22023');
rollback;

\echo '=== S36. RECHAZADO: la llave 'telefono' aborta toda la importacion -> 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select public.t_esperar_error($q$select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('c', 64), 'cuentas', 'cuentas.csv', '[{"folio":"1","dia_negocio":"2026-03-10","tipo_servicio":"comedor","total_centavos":100},{"folio":"2","dia_negocio":"2026-03-10","tipo_servicio":"comedor","total_centavos":100,"telefono":"5512345678"}]'::jsonb)$q$, '22023');
rollback;

\echo '=== S37. RECHAZADO: llave de cliente en un resumen -> 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select public.t_esperar_error($q$select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('a', 64), 'resumen_servicio', 'v.csv', '[{"dia_negocio":"2026-03-10","tipo_servicio":"comedor","tickets":1,"bruta_centavos":1,"neta_centavos":1,"nombre":"x"}]'::jsonb)$q$, '22023');
rollback;

\echo '=== S38. RECHAZADO: llave de cuentas en un resumen -> 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select public.t_esperar_error($q$select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('a', 64), 'resumen_servicio', 'v.csv', '[{"dia_negocio":"2026-03-10","tipo_servicio":"comedor","tickets":1,"bruta_centavos":1,"neta_centavos":1,"folio":"1"}]'::jsonb)$q$, '22023');
rollback;

\echo '=== S39. la importacion abortada por llave de cliente no deja lote ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select public.t_esperar_error($q$select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('c', 64), 'cuentas', 'cuentas.csv', '[{"folio":"1","dia_negocio":"2026-03-10","tipo_servicio":"comedor","total_centavos":100,"cliente":"Ana"}]'::jsonb)$q$, '22023');
select count(*) as lotes_deberia_ser_0 from restaurantes.sr_import_lote;
rollback;

\echo '=== S40. RECHAZADO: mas de 20000 renglones de cuentas -> 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select public.t_esperar_error($q$select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('f', 64), 'cuentas', 'grande.csv', (select jsonb_agg(jsonb_build_object('folio', g::text, 'dia_negocio', '2026-03-10', 'tipo_servicio', 'comedor', 'total_centavos', 1)) from generate_series(1, 20001) g))$q$, '22023');
rollback;

\echo '=== S41. RECHAZADO: mas de 2000 renglones de resumen -> 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select public.t_esperar_error($q$select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('f', 64), 'resumen_servicio', 'grande.csv', (select jsonb_agg(jsonb_build_object('dia_negocio', '2026-03-10', 'tipo_servicio', 'comedor', 'forma_pago', 'f' || g::text, 'tickets', 1, 'bruta_centavos', 1, 'neta_centavos', 1)) from generate_series(1, 2001) g))$q$, '22023');
rollback;

\echo '=== S42. exactamente 20000 renglones de cuentas entran ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select aceptados as aceptados_deberia_ser_20000 from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('f', 64), 'cuentas', 'tope.csv', (select jsonb_agg(jsonb_build_object('folio', g::text, 'dia_negocio', '2026-03-10', 'tipo_servicio', 'comedor', 'total_centavos', 100, 'forma_pago', 'efectivo')) from generate_series(1, 20000) g));
rollback;

\echo '=== S43. RECHAZADO: arreglo vacio -> 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select public.t_esperar_error($q$select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('a', 64), 'cuentas', 'v.csv', '[]'::jsonb)$q$, '22023');
rollback;

\echo '=== S44. RECHAZADO: no es un arreglo -> 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select public.t_esperar_error($q$select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('a', 64), 'cuentas', 'v.csv', '{}'::jsonb)$q$, '22023');
rollback;

\echo '=== S45. RECHAZADO: huella que no es sha-256 -> 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select public.t_esperar_error($q$select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', 'xyz', 'cuentas', 'v.csv', public.t_cta1())$q$, '22023');
rollback;

\echo '=== S46. RECHAZADO: tipo desconocido -> 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select public.t_esperar_error($q$select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('a', 64), 'ventas', 'v.csv', public.t_cta1())$q$, '22023');
rollback;

\echo '=== S47. RECHAZADO: nombre de archivo con ruta -> 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select public.t_esperar_error($q$select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('a', 64), 'cuentas', 'carpeta/v.csv', public.t_cta1())$q$, '22023');
rollback;

\echo '=== S48. RECHAZADO: nombre de archivo de mas de 120 caracteres -> 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select public.t_esperar_error($q$select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('a', 64), 'cuentas', repeat('n', 121), public.t_cta1())$q$, '22023');
rollback;

\echo '=== S49. RECHAZADO: sucursal nula (un archivo = una sucursal) -> 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select public.t_esperar_error($q$select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', null, repeat('a', 64), 'cuentas', 'v.csv', public.t_cta1())$q$, '22023');
rollback;

\echo '=== S50. RECHAZADO: el mismo archivo para otra sucursal -> 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('c', 64), 'cuentas', 'cuentas.csv', public.t_cta1());
select public.t_esperar_error($q$select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a2', repeat('c', 64), 'cuentas', 'cuentas.csv', public.t_cta1())$q$, '22023');
rollback;

\echo '=== S51. renglones invalidos se cuentan como rechazados (monto negativo, fecha imposible, servicio desconocido) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select rechazados as rechazados_deberia_ser_3 from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('9', 64), 'cuentas', 'malo.csv', '[{"folio":"1","dia_negocio":"2026-03-10","tipo_servicio":"comedor","total_centavos":-5},{"folio":"2","dia_negocio":"2026-02-30","tipo_servicio":"comedor","total_centavos":5},{"folio":"3","dia_negocio":"2026-03-10","tipo_servicio":"mesa","total_centavos":5},{"folio":"4","dia_negocio":"2026-03-10","tipo_servicio":"comedor","total_centavos":5}]'::jsonb);
rollback;

\echo '=== S52. si ningun renglon es valido no se crea lote ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select (lote_id is null)::int as sin_lote_deberia_ser_1 from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('9', 64), 'cuentas', 'malo.csv', '[{"folio":"1","dia_negocio":"2026-03-10","tipo_servicio":"comedor","total_centavos":-5}]'::jsonb);
rollback;

\echo '=== S53. si ningun renglon es valido tampoco se escribe nada ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('9', 64), 'cuentas', 'malo.csv', '[{"folio":"1","dia_negocio":"2026-03-10","tipo_servicio":"comedor","total_centavos":-5}]'::jsonb);
select count(*) as lotes_deberia_ser_0 from restaurantes.sr_import_lote;
rollback;

\echo '=== S54. los errores traen renglon, campo y motivo ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select (errores -> 0 ->> 'renglon')::int as renglon_deberia_ser_1 from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('9', 64), 'cuentas', 'malo.csv', '[{"folio":"1","dia_negocio":"2026-03-10","tipo_servicio":"comedor","total_centavos":-5}]'::jsonb);
rollback;

\echo '=== S55. los errores se acotan a 50 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select jsonb_array_length(errores) as errores_deberia_ser_50 from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('8', 64), 'cuentas', 'malo.csv', (select jsonb_agg(jsonb_build_object('folio', g::text, 'dia_negocio', '2026-03-10', 'tipo_servicio', 'comedor', 'total_centavos', -1)) || '[{"folio":"ok","dia_negocio":"2026-03-10","tipo_servicio":"comedor","total_centavos":1}]'::jsonb from generate_series(1, 100) g));
rollback;

\echo '=== S56. con 100 renglones malos y 1 bueno: rechazados = 100 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select rechazados as rechazados_deberia_ser_100 from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('8', 64), 'cuentas', 'malo.csv', (select jsonb_agg(jsonb_build_object('folio', g::text, 'dia_negocio', '2026-03-10', 'tipo_servicio', 'comedor', 'total_centavos', -1)) || '[{"folio":"ok","dia_negocio":"2026-03-10","tipo_servicio":"comedor","total_centavos":1}]'::jsonb from generate_series(1, 100) g));
rollback;

\echo '=== S57. los errores no contienen datos del archivo (solo renglon, campo y motivo) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select count(*) as llaves_extra_deberia_ser_0 from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('9', 64), 'cuentas', 'malo.csv', '[{"folio":"SECRETO","dia_negocio":"2026-03-10","tipo_servicio":"comedor","total_centavos":-5}]'::jsonb) r, jsonb_array_elements(r.errores) e where e::text like '%SECRETO%';
rollback;

\echo '=== S58. un resumen con renglones repetidos de la misma llave los suma ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('7', 64), 'resumen_servicio', 'r.csv', '[{"dia_negocio":"2026-03-10","tipo_servicio":"comedor","forma_pago":"efectivo","tickets":1,"bruta_centavos":100,"neta_centavos":100},{"dia_negocio":"2026-03-10","tipo_servicio":"comedor","forma_pago":"Efectivo","tickets":2,"bruta_centavos":200,"neta_centavos":200}]'::jsonb);
select tickets as tickets_deberia_ser_3 from restaurantes.sr_resumen_leer('00000000-0000-0000-0000-0000000e8301', null, date '2026-03-10', date '2026-03-10');
rollback;

\echo '=== S59. la importacion deja una fila de bitacora (cfo.sr_importado) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('a', 64), 'resumen_servicio', 'ventas.csv', public.t_res1());
select count(*) as bitacora_deberia_ser_1 from restaurantes.audit_log where organization_id = '00000000-0000-0000-0000-0000000e8301' and action = 'cfo.sr_importado';
rollback;

\echo '=== S60. repetir el archivo no vuelve a escribir bitacora ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('a', 64), 'resumen_servicio', 'ventas.csv', public.t_res1());
select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('a', 64), 'resumen_servicio', 'ventas.csv', public.t_res1());
select count(*) as bitacora_deberia_ser_1 from restaurantes.audit_log where organization_id = '00000000-0000-0000-0000-0000000e8301' and action = 'cfo.sr_importado';
rollback;

\echo '=== S61. la bitacora de la importacion no guarda contenido ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('c', 64), 'cuentas', 'cuentas.csv', public.t_cta1());
select count(*) as con_folio_deberia_ser_0 from restaurantes.audit_log where action = 'cfo.sr_importado' and (despues like '%1001%' or antes like '%1001%');
rollback;

\echo '=== S62. RECHAZADO: staff no importa -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8313', true);
select public.t_esperar_error($q$select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('a', 64), 'cuentas', 'v.csv', public.t_cta1())$q$, '42501');
rollback;

\echo '=== S63. RECHAZADO: repartidor no importa -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8314', true);
select public.t_esperar_error($q$select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('a', 64), 'cuentas', 'v.csv', public.t_cta1())$q$, '42501');
rollback;

\echo '=== S64. RECHAZADO: owner de otra organizacion no importa -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8315', true);
select public.t_esperar_error($q$select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('a', 64), 'cuentas', 'v.csv', public.t_cta1())$q$, '42501');
rollback;

\echo '=== S65. RECHAZADO: la sesion de sistema no importa -> 42501 ==='
begin;
set local role authenticated;
select public.t_esperar_error($q$select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('a', 64), 'cuentas', 'v.csv', public.t_cta1())$q$, '42501');
rollback;

\echo '=== S66. RECHAZADO: anon sin execute -> 42501 ==='
begin;
set local role anon;
select public.t_esperar_error($q$select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('a', 64), 'cuentas', 'v.csv', public.t_cta1())$q$, '42501');
rollback;

\echo '=== S67. RECHAZADO: el admin acotado a A1 no importa a A2 -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8312', true);
select public.t_esperar_error($q$select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a2', repeat('a', 64), 'cuentas', 'v.csv', public.t_cta1())$q$, '42501');
rollback;

\echo '=== S68. el admin acotado a A1 importa a A1 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8312', true);
select aceptados as aceptados_deberia_ser_5 from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('c', 64), 'cuentas', 'cuentas.csv', public.t_cta1());
rollback;

\echo '=== S69. RECHAZADO: sucursal de otra organizacion declarando la mia -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select public.t_esperar_error($q$select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83b1', repeat('a', 64), 'cuentas', 'v.csv', public.t_cta1())$q$, '42501');
rollback;

\echo '=== S70. RECHAZADO: sin INSERT directo en sr_import_lote -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select public.t_esperar_error($q$insert into restaurantes.sr_import_lote (organization_id, property_id, huella, tipo, nombre_archivo, renglones, aceptados, rechazados) values ('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('a', 64), 'cuentas', 'x', 1, 1, 0)$q$, '42501');
rollback;

\echo '=== S71. RECHAZADO: sin INSERT directo en sr_resumen_dia -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select public.t_esperar_error($q$insert into restaurantes.sr_resumen_dia (lote_id, organization_id, property_id, dia_negocio, tipo_servicio, tickets, bruta_centavos, descuento_centavos, cancelado_centavos, propina_centavos, neta_centavos) values (gen_random_uuid(), '00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', date '2026-03-10', 'comedor', 1, 1, 0, 0, 0, 1)$q$, '42501');
rollback;

\echo '=== S72. RECHAZADO: sin INSERT directo en sr_ticket -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select public.t_esperar_error($q$insert into restaurantes.sr_ticket (lote_id, organization_id, property_id, folio, dia_negocio, tipo_servicio, total_centavos, descuento_centavos, propina_centavos) values (gen_random_uuid(), '00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', '9', date '2026-03-10', 'comedor', 1, 0, 0)$q$, '42501');
rollback;

\echo '=== S73. RECHAZADO: sin UPDATE directo en sr_import_lote -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('c', 64), 'cuentas', 'cuentas.csv', public.t_cta1());
select public.t_esperar_error($q$update restaurantes.sr_import_lote set estado = 'reemplazado'$q$, '42501');
rollback;

\echo '=== S76. RECHAZADO: sin DELETE directo en sr_import_lote -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('c', 64), 'cuentas', 'cuentas.csv', public.t_cta1());
select public.t_esperar_error($q$delete from restaurantes.sr_import_lote$q$, '42501');
rollback;

\echo '=== S74. RECHAZADO: sin UPDATE directo en sr_resumen_dia -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('c', 64), 'cuentas', 'cuentas.csv', public.t_cta1());
select public.t_esperar_error($q$update restaurantes.sr_resumen_dia set estado = 'reemplazado'$q$, '42501');
rollback;

\echo '=== S77. RECHAZADO: sin DELETE directo en sr_resumen_dia -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('c', 64), 'cuentas', 'cuentas.csv', public.t_cta1());
select public.t_esperar_error($q$delete from restaurantes.sr_resumen_dia$q$, '42501');
rollback;

\echo '=== S75. RECHAZADO: sin UPDATE directo en sr_ticket -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('c', 64), 'cuentas', 'cuentas.csv', public.t_cta1());
select public.t_esperar_error($q$update restaurantes.sr_ticket set estado = 'reemplazado'$q$, '42501');
rollback;

\echo '=== S78. RECHAZADO: sin DELETE directo en sr_ticket -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('c', 64), 'cuentas', 'cuentas.csv', public.t_cta1());
select public.t_esperar_error($q$delete from restaurantes.sr_ticket$q$, '42501');
rollback;

\echo '=== S79. append-only: ni el propietario borra un ticket -> 0A000 ==='
begin;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-0000000e8311';
select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('c', 64), 'cuentas', 'cuentas.csv', public.t_cta1());
select public.t_esperar_error($q$delete from restaurantes.sr_ticket$q$, '0A000');
rollback;

\echo '=== S80. append-only: ni el propietario cambia un monto de ticket -> 0A000 ==='
begin;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-0000000e8311';
select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('c', 64), 'cuentas', 'cuentas.csv', public.t_cta1());
select public.t_esperar_error($q$update restaurantes.sr_ticket set total_centavos = 1$q$, '0A000');
rollback;

\echo '=== S81. append-only: un reemplazado no vuelve a vigente -> 0A000 ==='
begin;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-0000000e8311';
select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('c', 64), 'cuentas', 'cuentas.csv', public.t_cta1());
select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('d', 64), 'cuentas', 'cuentas2.csv', '[{"folio":"2001","dia_negocio":"2026-03-10","tipo_servicio":"comedor","total_centavos":100}]'::jsonb);
select public.t_esperar_error($q$update restaurantes.sr_ticket set estado = 'vigente' where estado = 'reemplazado'$q$, '0A000');
rollback;

\echo '=== S82. append-only: ni el propietario borra un lote -> 0A000 ==='
begin;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-0000000e8311';
select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('c', 64), 'cuentas', 'cuentas.csv', public.t_cta1());
select public.t_esperar_error($q$delete from restaurantes.sr_import_lote$q$, '0A000');
rollback;

\echo '=== S83. RLS: el admin acotado a A1 no ve los lotes de A2 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a2', repeat('c', 64), 'cuentas', 'cuentas.csv', public.t_cta1());
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8312', true);
select count(*) as lotes_ajenos_deberia_ser_0 from restaurantes.sr_import_lote;
rollback;

\echo '=== S84. RLS: el admin acotado a A1 no ve las cuentas de A2 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a2', repeat('c', 64), 'cuentas', 'cuentas.csv', public.t_cta1());
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8312', true);
select count(*) as cuentas_ajenas_deberia_ser_0 from restaurantes.sr_ticket;
rollback;

\echo '=== S85. RLS: el admin acotado a A1 si ve las de A1 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('c', 64), 'cuentas', 'cuentas.csv', public.t_cta1());
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8312', true);
select count(*) as cuentas_propias_deberia_ser_5 from restaurantes.sr_ticket;
rollback;

\echo '=== S86. RLS: staff no ve nada ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('c', 64), 'cuentas', 'cuentas.csv', public.t_cta1());
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8313', true);
select count(*) as staff_deberia_ser_0 from restaurantes.sr_ticket;
rollback;

\echo '=== S87. RLS: owner de otra organizacion no ve nada ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('c', 64), 'cuentas', 'cuentas.csv', public.t_cta1());
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8315', true);
select count(*) as otra_org_deberia_ser_0 from restaurantes.sr_resumen_dia;
rollback;

\echo '=== S88. sin PII: las tablas de SR no tienen columnas de cliente ==='
begin;
select count(*) as columnas_pii_deberia_ser_0 from information_schema.columns where table_schema = 'restaurantes' and table_name in ('sr_import_lote', 'sr_resumen_dia', 'sr_ticket') and column_name ~ '(cliente|customer|nombre_cliente|telefono|phone|direccion|address|email|mesero)';
rollback;

\echo '=== S89. la columna created_by no se puede leer con SELECT de authenticated -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select public.t_esperar_error($q$select created_by from restaurantes.sr_import_lote$q$, '42501');
rollback;

\echo '=== S90. sr_lotes_listar: el owner ve el lote ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('c', 64), 'cuentas', 'cuentas.csv', public.t_cta1());
select count(*) as lotes_deberia_ser_1 from restaurantes.sr_lotes_listar('00000000-0000-0000-0000-0000000e8301', null, 50);
rollback;

\echo '=== S91. sr_lotes_listar: el admin acotado no ve lotes de A2 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a2', repeat('c', 64), 'cuentas', 'cuentas.csv', public.t_cta1());
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8312', true);
select count(*) as lotes_ajenos_deberia_ser_0 from restaurantes.sr_lotes_listar('00000000-0000-0000-0000-0000000e8301', null, 50);
rollback;

\echo '=== S92. RECHAZADO: sr_lotes_listar con sucursal ajena -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8312', true);
select public.t_esperar_error($q$select * from restaurantes.sr_lotes_listar('00000000-0000-0000-0000-0000000e8301', array['00000000-0000-0000-0000-0000000e83a2']::uuid[], 50)$q$, '42501');
rollback;

\echo '=== S93. RECHAZADO: sr_lotes_listar con limite 0 -> 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select public.t_esperar_error($q$select * from restaurantes.sr_lotes_listar('00000000-0000-0000-0000-0000000e8301', null, 0)$q$, '22023');
rollback;

\echo '=== S94. sr_lotes_listar respeta el limite ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('c', 64), 'cuentas', 'cuentas.csv', public.t_cta1());
select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('a', 64), 'resumen_servicio', 'ventas.csv', public.t_res3());
select count(*) as lotes_deberia_ser_1 from restaurantes.sr_lotes_listar('00000000-0000-0000-0000-0000000e8301', null, 1);
rollback;

\echo '=== S95. sr_cobertura: dias con dato de A1 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('a', 64), 'resumen_servicio', 'ventas.csv', public.t_res1());
select dias_con_dato as dias_deberia_ser_2 from restaurantes.sr_cobertura('00000000-0000-0000-0000-0000000e8301', array['00000000-0000-0000-0000-0000000e83a1']::uuid[]);
rollback;

\echo '=== S96. sr_cobertura: una sucursal sin archivo tiene 0 dias ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('a', 64), 'resumen_servicio', 'ventas.csv', public.t_res1());
select coalesce(dias_con_dato, 0) as dias_deberia_ser_0 from restaurantes.sr_cobertura('00000000-0000-0000-0000-0000000e8301', array['00000000-0000-0000-0000-0000000e83a2']::uuid[]);
rollback;

\echo '=== S97. sr_cobertura: el arreglo de dias trae las fechas vigentes ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('a', 64), 'resumen_servicio', 'ventas.csv', public.t_res1());
select cardinality(dias) as dias_deberia_ser_2 from restaurantes.sr_cobertura('00000000-0000-0000-0000-0000000e8301', array['00000000-0000-0000-0000-0000000e83a1']::uuid[]);
rollback;

\echo '=== S98. sr_cobertura: un dia reemplazado cuenta una sola vez ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('a', 64), 'resumen_servicio', 'ventas.csv', public.t_res1());
select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('b', 64), 'resumen_servicio', 'ventas3.csv', public.t_res3());
select dias_con_dato as dias_deberia_ser_2 from restaurantes.sr_cobertura('00000000-0000-0000-0000-0000000e8301', array['00000000-0000-0000-0000-0000000e83a1']::uuid[]);
rollback;

\echo '=== S99. aditividad del resumen: todas = A1 + A2 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('a', 64), 'resumen_servicio', 'ventas.csv', public.t_res1());
select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a2', repeat('b', 64), 'resumen_servicio', 'ventas3.csv', public.t_res3());
select ((select coalesce(sum(tickets), 0) from restaurantes.sr_resumen_leer('00000000-0000-0000-0000-0000000e8301', null, date '2026-03-10', date '2026-03-11')) - (select coalesce(sum(tickets), 0) from restaurantes.sr_resumen_leer('00000000-0000-0000-0000-0000000e8301', array['00000000-0000-0000-0000-0000000e83a1']::uuid[], date '2026-03-10', date '2026-03-11')) - (select coalesce(sum(tickets), 0) from restaurantes.sr_resumen_leer('00000000-0000-0000-0000-0000000e8301', array['00000000-0000-0000-0000-0000000e83a2']::uuid[], date '2026-03-10', date '2026-03-11')))::int as diferencia_deberia_ser_0;
rollback;

\echo '=== S100. el admin acotado con 'todas' solo suma A1 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('a', 64), 'resumen_servicio', 'ventas.csv', public.t_res1());
select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a2', repeat('b', 64), 'resumen_servicio', 'ventas3.csv', public.t_res3());
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8312', true);
select count(distinct property_id) as sucursales_deberia_ser_1 from restaurantes.sr_resumen_leer('00000000-0000-0000-0000-0000000e8301', null, date '2026-03-10', date '2026-03-11');
rollback;

\echo '=== S101. la sesion de sistema lee el resumen de la organizacion ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('a', 64), 'resumen_servicio', 'ventas.csv', public.t_res1());
reset role;
set local role authenticated;
select count(*) as filas_deberia_ser_3 from restaurantes.sr_resumen_leer('00000000-0000-0000-0000-0000000e8301', null, date '2026-03-10', date '2026-03-11');
rollback;

\echo '=== S102. RECHAZADO: sistema con sucursal de otra organizacion -> 42501 ==='
begin;
set local role authenticated;
select public.t_esperar_error($q$select * from restaurantes.sr_resumen_leer('00000000-0000-0000-0000-0000000e8301', array['00000000-0000-0000-0000-0000000e83b1']::uuid[], date '2026-03-10', date '2026-03-11')$q$, '42501');
rollback;

\echo '=== S103. RECHAZADO: staff no lee el resumen -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8313', true);
select public.t_esperar_error($q$select * from restaurantes.sr_resumen_leer('00000000-0000-0000-0000-0000000e8301', null, date '2026-03-10', date '2026-03-11')$q$, '42501');
rollback;

\echo '=== S104. RECHAZADO: rango de mas de 400 dias -> 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select public.t_esperar_error($q$select * from restaurantes.sr_resumen_leer('00000000-0000-0000-0000-0000000e8301', null, date '2025-01-01', date '2026-03-11')$q$, '22023');
rollback;

\echo '=== S105. RECHAZADO: rango invertido -> 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select public.t_esperar_error($q$select * from restaurantes.sr_resumen_leer('00000000-0000-0000-0000-0000000e8301', null, date '2026-03-11', date '2026-03-10')$q$, '22023');
rollback;

\echo '=== S106. RECHAZADO: lista vacia de sucursales -> 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select public.t_esperar_error($q$select * from restaurantes.sr_resumen_leer('00000000-0000-0000-0000-0000000e8301', array[]::uuid[], date '2026-03-10', date '2026-03-11')$q$, '22023');
rollback;

\echo '=== S107. RECHAZADO: anon sin execute en la lectura -> 42501 ==='
begin;
set local role anon;
select public.t_esperar_error($q$select * from restaurantes.sr_resumen_leer('00000000-0000-0000-0000-0000000e8301', null, date '2026-03-10', date '2026-03-11')$q$, '42501');
rollback;

\echo '=== S108. una fecha futura lejana se rechaza como renglon ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select rechazados as rechazados_deberia_ser_1 from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('6', 64), 'cuentas', 'f.csv', '[{"folio":"1","dia_negocio":"2099-01-01","tipo_servicio":"comedor","total_centavos":1},{"folio":"2","dia_negocio":"2026-03-10","tipo_servicio":"comedor","total_centavos":1}]'::jsonb);
rollback;

\echo '=== S109. un monto con decimales se rechaza como renglon (centavos enteros) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select rechazados as rechazados_deberia_ser_1 from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('6', 64), 'cuentas', 'f.csv', '[{"folio":"1","dia_negocio":"2026-03-10","tipo_servicio":"comedor","total_centavos":10.5},{"folio":"2","dia_negocio":"2026-03-10","tipo_servicio":"comedor","total_centavos":1}]'::jsonb);
rollback;

\echo '=== S110. un monto como texto se rechaza como renglon ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select rechazados as rechazados_deberia_ser_1 from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('6', 64), 'cuentas', 'f.csv', '[{"folio":"1","dia_negocio":"2026-03-10","tipo_servicio":"comedor","total_centavos":"10"},{"folio":"2","dia_negocio":"2026-03-10","tipo_servicio":"comedor","total_centavos":1}]'::jsonb);
rollback;

\echo '=== S111. un renglon que no es objeto se rechaza como renglon ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select rechazados as rechazados_deberia_ser_1 from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('6', 64), 'cuentas', 'f.csv', '[5,{"folio":"2","dia_negocio":"2026-03-10","tipo_servicio":"comedor","total_centavos":1}]'::jsonb);
rollback;

\echo '=== S112. fecha_min y fecha_max del lote ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('a', 64), 'resumen_servicio', 'ventas.csv', public.t_res1());
select (fecha_max - fecha_min) as rango_deberia_ser_1 from restaurantes.sr_lotes_listar('00000000-0000-0000-0000-0000000e8301', null, 5);
rollback;

\echo '=== E1. exportar deja su fila en la bitacora ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select restaurantes.cfo_registrar_exportacion('00000000-0000-0000-0000-0000000e8301', null, 'resumen', 'xlsx', date '2026-03-01', date '2026-03-31');
select count(*) as bitacora_deberia_ser_1 from restaurantes.audit_log where organization_id = '00000000-0000-0000-0000-0000000e8301' and action = 'cfo.exportacion' and entity_type = 'exportacion';
rollback;

\echo '=== E2. cada exportacion deja su propia fila ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select restaurantes.cfo_registrar_exportacion('00000000-0000-0000-0000-0000000e8301', null, 'resumen', 'xlsx', date '2026-03-01', date '2026-03-31');
select restaurantes.cfo_registrar_exportacion('00000000-0000-0000-0000-0000000e8301', null, 'ventas', 'pdf', date '2026-03-01', date '2026-03-31');
select count(*) as bitacora_deberia_ser_2 from restaurantes.audit_log where organization_id = '00000000-0000-0000-0000-0000000e8301' and action = 'cfo.exportacion';
rollback;

\echo '=== E3. la bitacora guarda vista y formato ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select restaurantes.cfo_registrar_exportacion('00000000-0000-0000-0000-0000000e8301', null, 'estado_resultados', 'pdf', date '2026-03-01', date '2026-03-31');
select count(*) as detalle_deberia_ser_1 from restaurantes.audit_log where action = 'cfo.exportacion' and despues like '%estado_resultados%' and despues like '%pdf%';
rollback;

\echo '=== E4. RECHAZADO: formato invalido -> 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select public.t_esperar_error($q$select restaurantes.cfo_registrar_exportacion('00000000-0000-0000-0000-0000000e8301', null, 'resumen', 'csv', date '2026-03-01', date '2026-03-31')$q$, '22023');
rollback;

\echo '=== E5. RECHAZADO: vista fuera de la lista -> 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select public.t_esperar_error($q$select restaurantes.cfo_registrar_exportacion('00000000-0000-0000-0000-0000000e8301', null, 'todo', 'xlsx', date '2026-03-01', date '2026-03-31')$q$, '22023');
rollback;

\echo '=== E6. RECHAZADO: rango invertido -> 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select public.t_esperar_error($q$select restaurantes.cfo_registrar_exportacion('00000000-0000-0000-0000-0000000e8301', null, 'resumen', 'xlsx', date '2026-03-31', date '2026-03-01')$q$, '22023');
rollback;

\echo '=== E7. RECHAZADO: rango de mas de 400 dias -> 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select public.t_esperar_error($q$select restaurantes.cfo_registrar_exportacion('00000000-0000-0000-0000-0000000e8301', null, 'resumen', 'xlsx', date '2024-01-01', date '2026-03-01')$q$, '22023');
rollback;

\echo '=== E8. el admin acotado exporta sus sucursales ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8312', true);
select (restaurantes.cfo_registrar_exportacion('00000000-0000-0000-0000-0000000e8301', array['00000000-0000-0000-0000-0000000e83a1']::uuid[], 'ventas', 'xlsx', date '2026-03-01', date '2026-03-31') is not null)::int as id_deberia_ser_1;
rollback;

\echo '=== E9. el admin acotado exporta 'todas' (las suyas) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8312', true);
select (restaurantes.cfo_registrar_exportacion('00000000-0000-0000-0000-0000000e8301', null, 'ventas', 'xlsx', date '2026-03-01', date '2026-03-31') is not null)::int as id_deberia_ser_1;
rollback;

\echo '=== E10. RECHAZADO: el admin acotado no exporta una sucursal ajena -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8312', true);
select public.t_esperar_error($q$select restaurantes.cfo_registrar_exportacion('00000000-0000-0000-0000-0000000e8301', array['00000000-0000-0000-0000-0000000e83a2']::uuid[], 'ventas', 'xlsx', date '2026-03-01', date '2026-03-31')$q$, '42501');
rollback;

\echo '=== E11. RECHAZADO: staff no exporta -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8313', true);
select public.t_esperar_error($q$select restaurantes.cfo_registrar_exportacion('00000000-0000-0000-0000-0000000e8301', null, 'resumen', 'xlsx', date '2026-03-01', date '2026-03-31')$q$, '42501');
rollback;

\echo '=== E12. RECHAZADO: repartidor no exporta -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8314', true);
select public.t_esperar_error($q$select restaurantes.cfo_registrar_exportacion('00000000-0000-0000-0000-0000000e8301', null, 'resumen', 'xlsx', date '2026-03-01', date '2026-03-31')$q$, '42501');
rollback;

\echo '=== E13. RECHAZADO: otra organizacion no exporta -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8315', true);
select public.t_esperar_error($q$select restaurantes.cfo_registrar_exportacion('00000000-0000-0000-0000-0000000e8301', null, 'resumen', 'xlsx', date '2026-03-01', date '2026-03-31')$q$, '42501');
rollback;

\echo '=== E14. RECHAZADO: la sesion de sistema no exporta -> 42501 ==='
begin;
set local role authenticated;
select public.t_esperar_error($q$select restaurantes.cfo_registrar_exportacion('00000000-0000-0000-0000-0000000e8301', null, 'resumen', 'xlsx', date '2026-03-01', date '2026-03-31')$q$, '42501');
rollback;

\echo '=== E15. RECHAZADO: anon sin execute -> 42501 ==='
begin;
set local role anon;
select public.t_esperar_error($q$select restaurantes.cfo_registrar_exportacion('00000000-0000-0000-0000-0000000e8301', null, 'resumen', 'xlsx', date '2026-03-01', date '2026-03-31')$q$, '42501');
rollback;

\echo '=== E16. la bitacora de exportaciones sigue siendo append-only -> 0A000 ==='
begin;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-0000000e8311';
select restaurantes.cfo_registrar_exportacion('00000000-0000-0000-0000-0000000e8301', null, 'resumen', 'xlsx', date '2026-03-01', date '2026-03-31');
select public.t_esperar_error($q$delete from restaurantes.audit_log where action = 'cfo.exportacion'$q$, '0A000');
rollback;

\echo '=== R1. dia cuyos renglones se rechazan todos por conflicto de folio conserva sus cuentas ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('4', 64), 'cuentas', 'a.csv', '[{"folio":"F-1","dia_negocio":"2026-07-02","tipo_servicio":"comedor","total_centavos":100}]'::jsonb);
select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('5', 64), 'cuentas', 'b.csv', '[{"folio":"X-1","dia_negocio":"2026-07-20","tipo_servicio":"comedor","total_centavos":100},{"folio":"X-2","dia_negocio":"2026-07-20","tipo_servicio":"comedor","total_centavos":200},{"folio":"X-3","dia_negocio":"2026-07-20","tipo_servicio":"comedor","total_centavos":300}]'::jsonb);
select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('6', 64), 'cuentas', 'c.csv', '[{"folio":"F-1","dia_negocio":"2026-07-20","tipo_servicio":"comedor","total_centavos":100},{"folio":"Q-1","dia_negocio":"2026-07-21","tipo_servicio":"comedor","total_centavos":100}]'::jsonb);
select count(*) as cuentas_dia20_deberia_ser_3 from restaurantes.sr_ticket where estado = 'vigente' and dia_negocio = '2026-07-20';
rollback;

\echo '=== R2. ese mismo dia conserva su resumen vigente ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('4', 64), 'cuentas', 'a.csv', '[{"folio":"F-1","dia_negocio":"2026-07-02","tipo_servicio":"comedor","total_centavos":100}]'::jsonb);
select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('5', 64), 'cuentas', 'b.csv', '[{"folio":"X-1","dia_negocio":"2026-07-20","tipo_servicio":"comedor","total_centavos":100},{"folio":"X-2","dia_negocio":"2026-07-20","tipo_servicio":"comedor","total_centavos":200},{"folio":"X-3","dia_negocio":"2026-07-20","tipo_servicio":"comedor","total_centavos":300}]'::jsonb);
select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('6', 64), 'cuentas', 'c.csv', '[{"folio":"F-1","dia_negocio":"2026-07-20","tipo_servicio":"comedor","total_centavos":100},{"folio":"Q-1","dia_negocio":"2026-07-21","tipo_servicio":"comedor","total_centavos":100}]'::jsonb);
select tickets as tickets_deberia_ser_3 from restaurantes.sr_resumen_leer('00000000-0000-0000-0000-0000000e8301', null, date '2026-07-20', date '2026-07-20');
rollback;

\echo '=== R3. la funcion toma el candado por sucursal antes del de huella ==='
begin;
select count(*) as candado_deberia_ser_1 from pg_proc p where p.proname = 'sr_importar' and pg_get_functiondef(p.oid) like '%sr_importar_sucursal%';
rollback;

\echo '=== R4. sumar tickets de una misma llave no desborda un entero (300 x 10 millones) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select aceptados as aceptados_deberia_ser_300 from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('3', 64), 'resumen_servicio', 'g.csv', (select jsonb_agg(jsonb_build_object('dia_negocio', '2026-03-10', 'tipo_servicio', 'comedor', 'tickets', 10000000, 'bruta_centavos', 1, 'neta_centavos', 1)) from generate_series(1, 300)));
rollback;

\echo '=== R5. y la lectura devuelve la suma completa ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('3', 64), 'resumen_servicio', 'g.csv', (select jsonb_agg(jsonb_build_object('dia_negocio', '2026-03-10', 'tipo_servicio', 'comedor', 'tickets', 10000000, 'bruta_centavos', 1, 'neta_centavos', 1)) from generate_series(1, 300)));
select (tickets / 1000000)::int as millones_deberia_ser_3000 from restaurantes.sr_resumen_leer('00000000-0000-0000-0000-0000000e8301', null, date '2026-03-10', date '2026-03-10');
rollback;

\echo '=== R6. RECHAZADO: iva_pct desbordado da 22023 y no 22003 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select public.t_esperar_error($q$select restaurantes.cfo_config_guardar('00000000-0000-0000-0000-0000000e8301', '{"iva_pct": 1000}'::jsonb)$q$, '22023');
rollback;

\echo '=== R7. RECHAZADO: frecuente_n desbordado da 22023 y no 22003 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select public.t_esperar_error($q$select restaurantes.cfo_config_guardar('00000000-0000-0000-0000-0000000e8301', '{"frecuente_n": 10000000000}'::jsonb)$q$, '22023');
rollback;

\echo '=== R8. borrar una sucursal con lotes y capturas (cascada) ya no choca con el trigger ==='
begin;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-0000000e8315';
select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8302', '00000000-0000-0000-0000-0000000e83b1', repeat('7', 64), 'cuentas', 'b.csv', public.t_cta1());
select restaurantes.cfo_costo_guardar('00000000-0000-0000-0000-0000000e8302', '00000000-0000-0000-0000-0000000e83b1', date '2026-03-01', 'insumos', 1000, null, null);
delete from core.property where id = '00000000-0000-0000-0000-0000000e83b1';
select count(*) as lotes_restantes_deberia_ser_0 from restaurantes.sr_import_lote where property_id = '00000000-0000-0000-0000-0000000e83b1';
rollback;

\echo '=== R9. la baja de un usuario solo anula created_by en la captura ==='
begin;
insert into restaurantes.cfo_costo_captura (organization_id, property_id, mes, concepto, monto_centavos, created_by) values ('00000000-0000-0000-0000-0000000e8301', null, date '2026-03-01', 'otros', 1, '00000000-0000-0000-0000-0000000e8314');
delete from core.staff_user where id = '00000000-0000-0000-0000-0000000e8314';
select count(*) as capturas_deberia_ser_1 from restaurantes.cfo_costo_captura where concepto = 'otros' and created_by is null;
rollback;

\echo '=== R10. con el padre vivo el DELETE directo sigue bloqueado -> 0A000 ==='
begin;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-0000000e8311';
select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('c', 64), 'cuentas', 'cuentas.csv', public.t_cta1());
select public.t_esperar_error($q$delete from restaurantes.sr_ticket$q$, '0A000');
rollback;

\echo '=== R11. reimportar un archivo corregido de 20000 cuentas (mismos folios y dias) tarda menos de 3 s ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('1', 64), 'cuentas', 'p1.csv', (select jsonb_agg(jsonb_build_object('folio', 'P-' || g::text, 'dia_negocio', (date '2026-06-01' + (g % 10))::text, 'tipo_servicio', 'comedor', 'total_centavos', 100, 'forma_pago', 'efectivo')) from generate_series(1, 20000) g));
select set_config('t.ini', clock_timestamp()::text, true);
select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('2', 64), 'cuentas', 'p2.csv', (select jsonb_agg(jsonb_build_object('folio', 'P-' || g::text, 'dia_negocio', (date '2026-06-01' + (g % 10))::text, 'tipo_servicio', 'comedor', 'total_centavos', 200, 'forma_pago', 'efectivo')) from generate_series(1, 20000) g));
select (extract(epoch from clock_timestamp() - current_setting('t.ini')::timestamptz) < 3)::int as rapido_deberia_ser_1;
rollback;

\echo '=== R12. la reimportacion corregida reemplaza las 20000 cuentas ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('1', 64), 'cuentas', 'p1.csv', (select jsonb_agg(jsonb_build_object('folio', 'P-' || g::text, 'dia_negocio', (date '2026-06-01' + (g % 10))::text, 'tipo_servicio', 'comedor', 'total_centavos', 100, 'forma_pago', 'efectivo')) from generate_series(1, 20000) g));
select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('2', 64), 'cuentas', 'p2.csv', (select jsonb_agg(jsonb_build_object('folio', 'P-' || g::text, 'dia_negocio', (date '2026-06-01' + (g % 10))::text, 'tipo_servicio', 'comedor', 'total_centavos', 200, 'forma_pago', 'efectivo')) from generate_series(1, 20000) g));
select count(*) as vigentes_deberia_ser_20000 from restaurantes.sr_ticket where estado = 'vigente' and lote_id = (select id from restaurantes.sr_import_lote where huella = repeat('2', 64));
rollback;

\echo '=== R13. con statement_timeout de 8 s la reimportacion de 20000 cuentas termina ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
set local statement_timeout = '8s';
select * from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('1', 64), 'cuentas', 'p1.csv', (select jsonb_agg(jsonb_build_object('folio', 'P-' || g::text, 'dia_negocio', (date '2026-06-01' + (g % 10))::text, 'tipo_servicio', 'comedor', 'total_centavos', 100, 'forma_pago', 'efectivo')) from generate_series(1, 20000) g));
select aceptados as aceptados_deberia_ser_20000 from restaurantes.sr_importar('00000000-0000-0000-0000-0000000e8301', '00000000-0000-0000-0000-0000000e83a1', repeat('2', 64), 'cuentas', 'p2.csv', (select jsonb_agg(jsonb_build_object('folio', 'P-' || g::text, 'dia_negocio', (date '2026-06-01' + (g % 10))::text, 'tipo_servicio', 'comedor', 'total_centavos', 200, 'forma_pago', 'efectivo')) from generate_series(1, 20000) g));
rollback;

\echo '=== G1. las 17 funciones nuevas existen ==='
begin;
select count(*) as funciones_deberia_ser_17 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'restaurantes' and p.proname in ('cfo_cap_gestor','cfo_resolver_alcance','cfo_cap_escritura','cfo_config_efectiva','cfo_config_leer','cfo_config_guardar','cfo_solo_marcar_reemplazo','cfo_costo_guardar','cfo_costos_leer','cfo_costo_historial','cfo_sr_entero','sr_normalizar_renglon','sr_importar','sr_resumen_leer','sr_lotes_listar','sr_cobertura','cfo_registrar_exportacion');
rollback;

\echo '=== G2. toda funcion nueva tiene search_path fijo ==='
begin;
select count(*) as sin_search_path_deberia_ser_0 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'restaurantes' and p.proname in ('cfo_cap_gestor','cfo_resolver_alcance','cfo_cap_escritura','cfo_config_efectiva','cfo_config_leer','cfo_config_guardar','cfo_solo_marcar_reemplazo','cfo_costo_guardar','cfo_costos_leer','cfo_costo_historial','cfo_sr_entero','sr_normalizar_renglon','sr_importar','sr_resumen_leer','sr_lotes_listar','sr_cobertura','cfo_registrar_exportacion') and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%');
rollback;

\echo '=== G3. anon no puede ejecutar ninguna funcion nueva ==='
begin;
select count(*) as anon_deberia_ser_0 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'restaurantes' and p.proname in ('cfo_cap_gestor','cfo_resolver_alcance','cfo_cap_escritura','cfo_config_efectiva','cfo_config_leer','cfo_config_guardar','cfo_solo_marcar_reemplazo','cfo_costo_guardar','cfo_costos_leer','cfo_costo_historial','cfo_sr_entero','sr_normalizar_renglon','sr_importar','sr_resumen_leer','sr_lotes_listar','sr_cobertura','cfo_registrar_exportacion') and has_function_privilege('anon', p.oid, 'execute');
rollback;

\echo '=== G4. authenticated ejecuta exactamente las 10 funciones publicas ==='
begin;
select count(*) as publicas_deberia_ser_10 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'restaurantes' and p.proname in ('cfo_cap_gestor','cfo_resolver_alcance','cfo_cap_escritura','cfo_config_efectiva','cfo_config_leer','cfo_config_guardar','cfo_solo_marcar_reemplazo','cfo_costo_guardar','cfo_costos_leer','cfo_costo_historial','cfo_sr_entero','sr_normalizar_renglon','sr_importar','sr_resumen_leer','sr_lotes_listar','sr_cobertura','cfo_registrar_exportacion') and has_function_privilege('authenticated', p.oid, 'execute');
rollback;

\echo '=== G5. las funciones definer publicas (10) son SECURITY DEFINER ==='
begin;
select count(*) as definer_deberia_ser_10 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'restaurantes' and p.proname in ('cfo_config_leer','cfo_config_guardar','cfo_costo_guardar','cfo_costos_leer','cfo_costo_historial','sr_importar','sr_resumen_leer','sr_lotes_listar','sr_cobertura','cfo_registrar_exportacion') and p.prosecdef;
rollback;

\echo '=== G6. RECHAZADO: authenticated no ejecuta un helper interno -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select public.t_esperar_error($q$select restaurantes.cfo_cap_gestor('00000000-0000-0000-0000-0000000e8301')$q$, '42501');
rollback;

\echo '=== G7. RECHAZADO: authenticated no ejecuta el normalizador interno -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8311', true);
select public.t_esperar_error($q$select restaurantes.sr_normalizar_renglon('cuentas', '{}'::jsonb)$q$, '42501');
rollback;

\echo '=== G8. RLS activa en las 5 tablas nuevas ==='
begin;
select count(*) as con_rls_deberia_ser_5 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'restaurantes' and c.relname in ('cfo_config','cfo_costo_captura','sr_import_lote','sr_resumen_dia','sr_ticket') and c.relrowsecurity;
rollback;

\echo '=== G9. ninguna tabla nueva concede DML a authenticated, anon ni service_role ==='
begin;
select count(*) as dml_deberia_ser_0 from information_schema.table_privileges where table_schema = 'restaurantes' and table_name in ('cfo_config','cfo_costo_captura','sr_import_lote','sr_resumen_dia','sr_ticket') and grantee in ('authenticated','anon','service_role','PUBLIC') and privilege_type in ('INSERT','UPDATE','DELETE','TRUNCATE');
rollback;

\echo '=== G10. anon no tiene SELECT en las tablas nuevas ==='
begin;
select count(*) as anon_select_deberia_ser_0 from information_schema.table_privileges where table_schema = 'restaurantes' and table_name in ('cfo_config','cfo_costo_captura','sr_import_lote','sr_resumen_dia','sr_ticket') and grantee in ('anon','PUBLIC') and privilege_type = 'SELECT';
rollback;

\echo '=== G11. ninguna columna created_by/updated_by se concede a authenticated ==='
begin;
select count(*) as actor_deberia_ser_0 from information_schema.column_privileges where table_schema = 'restaurantes' and table_name in ('cfo_config','cfo_costo_captura','sr_import_lote') and grantee = 'authenticated' and column_name in ('created_by','updated_by');
rollback;

