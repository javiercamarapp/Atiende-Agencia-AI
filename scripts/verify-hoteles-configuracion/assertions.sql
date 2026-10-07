-- H-P3-04 (P1) -- CONFIGURACION DEL HOTEL: verifica contra Postgres REAL (nunca el mirror en memoria, que no aplica
-- RLS/GRANT/triggers) que `packages/domain-hoteles/migrations/047_hoteles_configuracion_y_equipo.sql` cierra lo que dice cerrar:
-- (a) positivo: owner/gm cambian impuestos, politica de cancelacion, sobreventa y precio de una tarifa, y cada cambio deja su
--     fila en `hoteles.config_audit_log` con valor anterior y nuevo (una llamada repetida no duplica la bitacora);
-- (b) negativo: frontdesk, accountant, owner de OTRA organizacion, anon y la sesion de sistema no escriben; rangos invalidos
--     se rechazan; la bitacora no se lee cross-tenant ni se escribe directo; UPDATE directo a tax_config esta rechazado;
-- (c) la sobreventa editada se respeta en `hoteles.book_availability`;
-- (d) el precio manual de staff bloquea al motor de revenue (`tarifa_manual_vigente`) y el trigger no se deja falsificar;
-- (e) base a medio migrar: SQLSTATE 42883/42703 recuperados con SAVEPOINT real.
-- Corre via ./run.sh (local) o scripts/verify-real-postgres-ci/run-gate.mjs (CI).
\set ON_ERROR_STOP off
\pset pager off

-- Fixtures persistentes (superusuario de la conexion, bypass RLS, auth.uid() nulo).
insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-00000000c0a1', 'hoteles', 'Hotel A configuracion', 'hotel-a-configuracion'),
  ('00000000-0000-0000-0000-00000000c0b1', 'hoteles', 'Hotel B configuracion', 'hotel-b-configuracion')
on conflict do nothing;
insert into core.property (id, organization_id, vertical, name) values
  ('00000000-0000-0000-0000-0000000c1a01', '00000000-0000-0000-0000-00000000c0a1', 'hoteles', 'Hotel A - Property 1'),
  ('00000000-0000-0000-0000-0000000c1a02', '00000000-0000-0000-0000-00000000c0a1', 'hoteles', 'Hotel A - Property 2'),
  ('00000000-0000-0000-0000-0000000c1b01', '00000000-0000-0000-0000-00000000c0b1', 'hoteles', 'Hotel B - Property 1')
on conflict do nothing;
insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000c0a01', 'owner-a-config@example.com', 'Owner A', 'seed'),
  ('00000000-0000-0000-0000-0000000c0a02', 'gm-a-config@example.com', 'GM A', 'seed'),
  ('00000000-0000-0000-0000-0000000c0a03', 'frontdesk-a-config@example.com', 'Frontdesk A', 'seed'),
  ('00000000-0000-0000-0000-0000000c0a04', 'accountant-a-config@example.com', 'Accountant A', 'seed'),
  ('00000000-0000-0000-0000-0000000c0b01', 'owner-b-config@example.com', 'Owner B', 'seed')
on conflict do nothing;
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000c0a01', '00000000-0000-0000-0000-00000000c0a1', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000c0a02', '00000000-0000-0000-0000-00000000c0a1', null, 'admin', 'gm'),
  ('00000000-0000-0000-0000-0000000c0a03', '00000000-0000-0000-0000-00000000c0a1', null, 'member', 'frontdesk'),
  ('00000000-0000-0000-0000-0000000c0a04', '00000000-0000-0000-0000-00000000c0a1', null, 'member', 'accountant'),
  ('00000000-0000-0000-0000-0000000c0b01', '00000000-0000-0000-0000-00000000c0b1', null, 'owner', 'owner')
on conflict do nothing;
insert into hoteles.room_type (id, organization_id, property_id, name, max_occupancy) values
  ('00000000-0000-0000-0000-0000000c2a01', '00000000-0000-0000-0000-00000000c0a1', '00000000-0000-0000-0000-0000000c1a01', 'Doble A', 2),
  ('00000000-0000-0000-0000-0000000c2b01', '00000000-0000-0000-0000-00000000c0b1', '00000000-0000-0000-0000-0000000c1b01', 'Doble B', 2)
on conflict do nothing;
insert into hoteles.rate_plan (id, organization_id, property_id, room_type_id, date, price) values
  ('00000000-0000-0000-0000-0000000c3a01', '00000000-0000-0000-0000-00000000c0a1', '00000000-0000-0000-0000-0000000c1a01', '00000000-0000-0000-0000-0000000c2a01', current_date + 5, 1000),
  ('00000000-0000-0000-0000-0000000c3a02', '00000000-0000-0000-0000-00000000c0a1', '00000000-0000-0000-0000-0000000c1a01', '00000000-0000-0000-0000-0000000c2a01', current_date + 6, 1000),
  ('00000000-0000-0000-0000-0000000c3b01', '00000000-0000-0000-0000-00000000c0b1', '00000000-0000-0000-0000-0000000c1b01', '00000000-0000-0000-0000-0000000c2b01', current_date + 5, 900)
on conflict do nothing;
-- Inventario lleno (2 de 2) para probar la sobreventa en book_availability.
insert into hoteles.availability (organization_id, property_id, room_type_id, date, total_rooms, booked_rooms) values
  ('00000000-0000-0000-0000-00000000c0a1', '00000000-0000-0000-0000-0000000c1a01', '00000000-0000-0000-0000-0000000c2a01', current_date + 10, 2, 2)
on conflict do nothing;
-- Property A2 ya tiene configuracion fiscal (el caso "cambia el ISH de 3 % a 4 %").
insert into hoteles.tax_config (property_id, organization_id, iva_rate, ish_rate, discount_threshold) values
  ('00000000-0000-0000-0000-0000000c1a02', '00000000-0000-0000-0000-00000000c0a1', 0.16, 0.03, 500)
on conflict do nothing;
-- Recomendaciones del motor (insertadas como sistema: auth.uid() nulo).
insert into hoteles.rate_recommendation (id, property_id, room_type_id, fecha, current_bar_price, recommended_price, suggested_min_stay, desglose) values
  ('00000000-0000-0000-0000-0000000c4a01', '00000000-0000-0000-0000-0000000c1a01', '00000000-0000-0000-0000-0000000c2a01', current_date + 5, 1000, 1100, 1, '{}'::jsonb)
on conflict do nothing;

\echo '=== 1. owner configura impuestos de una property SIN fila previa (insert) -- la bitacora guarda valor anterior nulo ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0a01', true);
select iva_rate, ish_rate, discount_threshold, dsa_per_night from hoteles.set_tax_config('00000000-0000-0000-0000-0000000c1a01', 0.16, 0.025, 800, 12.5);
do $$
declare v_n integer; v_prev jsonb; v_new jsonb;
begin
  select count(*), max(valor_anterior::text)::jsonb, max(valor_nuevo::text)::jsonb into v_n, v_prev, v_new
    from hoteles.config_audit_log where property_id = '00000000-0000-0000-0000-0000000c1a01' and area = 'impuestos';
  if v_n <> 1 or v_prev is not null or (v_new->>'ishRate')::numeric <> 0.025 then
    raise exception 'bitacora de impuestos incorrecta: n=%, anterior=%, nuevo=%', v_n, v_prev, v_new;
  end if;
end $$;
rollback;

\echo '=== 2. llamada IDEMPOTENTE: repetir los mismos impuestos no duplica la bitacora ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0a01', true);
select 1 from hoteles.set_tax_config('00000000-0000-0000-0000-0000000c1a01', 0.16, 0.03, 500, 0);
select 1 from hoteles.set_tax_config('00000000-0000-0000-0000-0000000c1a01', 0.16, 0.03, 500, 0);
select count(*) as deberia_ser_1 from hoteles.config_audit_log where property_id = '00000000-0000-0000-0000-0000000c1a01' and area = 'impuestos';
rollback;

\echo '=== 3. gm cambia el ISH de 3 % a 4 % en una property YA configurada -- la bitacora guarda el valor anterior (0.03) y el nuevo (0.04) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0a02', true);
select 1 from hoteles.set_tax_config('00000000-0000-0000-0000-0000000c1a02', 0.16, 0.04, 500, 0);
do $$
declare v_prev numeric; v_new numeric;
begin
  select (valor_anterior->>'ishRate')::numeric, (valor_nuevo->>'ishRate')::numeric into v_prev, v_new
    from hoteles.config_audit_log where property_id = '00000000-0000-0000-0000-0000000c1a02' and area = 'impuestos';
  if v_prev <> 0.03 or v_new <> 0.04 then
    raise exception 'valores de bitacora incorrectos: anterior=%, nuevo=%', v_prev, v_new;
  end if;
end $$;
rollback;

\echo '=== 4. frontdesk NO puede cambiar impuestos (42501) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0a03', true);
do $$
begin
  begin
    perform hoteles.set_tax_config('00000000-0000-0000-0000-0000000c1a02', 0.16, 0.04, 500, 0);
    raise exception 'se esperaba insufficient_privilege y la llamada no fallo';
  exception when insufficient_privilege then
    null;
  end;
end $$;
rollback;

\echo '=== 5. accountant NO puede cambiar impuestos (42501) pero SI los lee (RLS de tax_config) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0a04', true);
do $$
begin
  begin
    perform hoteles.set_tax_config('00000000-0000-0000-0000-0000000c1a02', 0.16, 0.04, 500, 0);
    raise exception 'se esperaba insufficient_privilege y la llamada no fallo';
  exception when insufficient_privilege then
    null;
  end;
end $$;
select count(*) as deberia_ser_1 from hoteles.tax_config where property_id = '00000000-0000-0000-0000-0000000c1a02';
rollback;

\echo '=== 6. owner de OTRA organizacion (cross-tenant) NO puede cambiar impuestos ni leer la configuracion fiscal ajena ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0b01', true);
do $$
begin
  begin
    perform hoteles.set_tax_config('00000000-0000-0000-0000-0000000c1a02', 0.16, 0.04, 500, 0);
    raise exception 'se esperaba insufficient_privilege y la llamada no fallo';
  exception when insufficient_privilege then
    null;
  end;
end $$;
select count(*) as deberia_ser_0 from hoteles.tax_config where property_id = '00000000-0000-0000-0000-0000000c1a02';
rollback;

\echo '=== 7. anon NO puede ejecutar set_tax_config (sin GRANT EXECUTE) ==='
begin;
set local role anon;
do $$
begin
  begin
    perform hoteles.set_tax_config('00000000-0000-0000-0000-0000000c1a02', 0.16, 0.04, 500, 0);
    raise exception 'se esperaba insufficient_privilege y la llamada no fallo';
  exception when insufficient_privilege then
    null;
  end;
end $$;
rollback;

\echo '=== 8. la sesion de SISTEMA (auth.uid() nulo) NO puede cambiar impuestos: la configuracion es una decision de un humano ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
do $$
begin
  begin
    perform hoteles.set_tax_config('00000000-0000-0000-0000-0000000c1a02', 0.16, 0.04, 500, 0);
    raise exception 'se esperaba insufficient_privilege y la llamada no fallo';
  exception when insufficient_privilege then
    null;
  end;
end $$;
rollback;

\echo '=== 9. rangos invalidos (IVA 1.5, umbral negativo) se rechazan con 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0a01', true);
do $$
begin
  begin
    perform hoteles.set_tax_config('00000000-0000-0000-0000-0000000c1a01', 1.5, 0.03, 500, 0);
    raise exception 'se esperaba invalid_parameter_value y la llamada no fallo';
  exception when invalid_parameter_value then
    null;
  end;
end $$;
do $$
begin
  begin
    perform hoteles.set_tax_config('00000000-0000-0000-0000-0000000c1a01', 0.16, 0.03, -1, 0);
    raise exception 'se esperaba invalid_parameter_value y la llamada no fallo';
  exception when invalid_parameter_value then
    null;
  end;
end $$;
rollback;

\echo '=== 10. UPDATE directo a tax_config y escritura directa a la bitacora estan rechazados (solo existen las funciones set_*) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0a01', true);
do $$
begin
  begin
    update hoteles.tax_config set ish_rate = 0 where property_id = '00000000-0000-0000-0000-0000000c1a02';
    raise exception 'se esperaba insufficient_privilege y la llamada no fallo';
  exception when insufficient_privilege then
    null;
  end;
end $$;
do $$
begin
  begin
    insert into hoteles.config_audit_log (organization_id, property_id, area, valor_nuevo) values ('00000000-0000-0000-0000-00000000c0a1', '00000000-0000-0000-0000-0000000c1a01', 'impuestos', '{}'::jsonb);
    raise exception 'se esperaba insufficient_privilege y la llamada no fallo';
  exception when insufficient_privilege then
    null;
  end;
end $$;
rollback;

\echo '=== 11. la bitacora la leen owner/gm de la property; frontdesk y el owner de otra organizacion ven 0 filas ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0a01', true);
select 1 from hoteles.set_tax_config('00000000-0000-0000-0000-0000000c1a01', 0.16, 0.05, 500, 0);
select count(*) as deberia_ser_1 from hoteles.config_audit_log where property_id = '00000000-0000-0000-0000-0000000c1a01';
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0a03', true);
select count(*) as deberia_ser_0 from hoteles.config_audit_log where property_id = '00000000-0000-0000-0000-0000000c1a01';
rollback;

\echo '=== 12. la bitacora no se lee cross-tenant ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0a01', true);
select 1 from hoteles.set_tax_config('00000000-0000-0000-0000-0000000c1a01', 0.16, 0.05, 500, 0);
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0b01', true);
select count(*) as deberia_ser_0 from hoteles.config_audit_log where property_id = '00000000-0000-0000-0000-0000000c1a01';
rollback;

\echo '=== 13. owner define la politica de cancelacion (48 h, 30 %, texto) sin fila previa y queda en bitacora ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0a01', true);
select free_until_hours, penalty_pct, guest_text from hoteles.set_cancellation_policy('00000000-0000-0000-0000-0000000c1a01', 48, 0.3, '  Cancelacion gratis hasta 48 h antes.  ');
do $$
declare v_txt text;
begin
  select guest_text into v_txt from hoteles.cancellation_policy where property_id = '00000000-0000-0000-0000-0000000c1a01';
  if v_txt <> 'Cancelacion gratis hasta 48 h antes.' then raise exception 'texto no recortado: %', v_txt; end if;
end $$;
select count(*) as deberia_ser_1 from hoteles.config_audit_log where property_id = '00000000-0000-0000-0000-0000000c1a01' and area = 'politica_cancelacion';
rollback;

\echo '=== 14. politica de cancelacion: penalidad fuera de 0-1 y horas negativas se rechazan; frontdesk no escribe ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0a01', true);
do $$
begin
  begin
    perform hoteles.set_cancellation_policy('00000000-0000-0000-0000-0000000c1a01', 24, 1.5, null);
    raise exception 'se esperaba invalid_parameter_value y la llamada no fallo';
  exception when invalid_parameter_value then
    null;
  end;
end $$;
do $$
begin
  begin
    perform hoteles.set_cancellation_policy('00000000-0000-0000-0000-0000000c1a01', -1, 0.5, null);
    raise exception 'se esperaba invalid_parameter_value y la llamada no fallo';
  exception when invalid_parameter_value then
    null;
  end;
end $$;
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0a03', true);
do $$
begin
  begin
    perform hoteles.set_cancellation_policy('00000000-0000-0000-0000-0000000c1a01', 24, 0.5, null);
    raise exception 'se esperaba insufficient_privilege y la llamada no fallo';
  exception when insufficient_privilege then
    null;
  end;
end $$;
rollback;

\echo '=== 15. politica de cancelacion: cross-tenant no escribe ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0b01', true);
do $$
begin
  begin
    perform hoteles.set_cancellation_policy('00000000-0000-0000-0000-0000000c1a01', 24, 0.5, null);
    raise exception 'se esperaba insufficient_privilege y la llamada no fallo';
  exception when insufficient_privilege then
    null;
  end;
end $$;
rollback;

\echo '=== 16. SOBREVENTA: con el valor por omision (0) un inventario lleno rechaza la reserva; owner sube a 2 y book_availability acepta 2 mas y rechaza la tercera ==='
begin;
do $$
begin
  begin
    perform hoteles.book_availability('00000000-0000-0000-0000-0000000c1a01', '00000000-0000-0000-0000-0000000c2a01', current_date + 10, 1);
    raise exception 'se esperaba sin_disponibilidad con sobreventa 0';
  exception when sqlstate 'P0001' then
    if sqlerrm not like 'sin_disponibilidad%' then raise; end if;
  end;
end $$;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0a01', true);
select max_overbook_rooms from hoteles.set_room_type_overbooking('00000000-0000-0000-0000-0000000c1a01', '00000000-0000-0000-0000-0000000c2a01', 2, 90);
reset role;
select booked_rooms from hoteles.book_availability('00000000-0000-0000-0000-0000000c1a01', '00000000-0000-0000-0000-0000000c2a01', current_date + 10, 1);
select booked_rooms from hoteles.book_availability('00000000-0000-0000-0000-0000000c1a01', '00000000-0000-0000-0000-0000000c2a01', current_date + 10, 1);
do $$
begin
  begin
    perform hoteles.book_availability('00000000-0000-0000-0000-0000000c1a01', '00000000-0000-0000-0000-0000000c2a01', current_date + 10, 1);
    raise exception 'se esperaba sin_disponibilidad al pasar el tope de sobreventa';
  exception when sqlstate 'P0001' then
    if sqlerrm not like 'sin_disponibilidad%' then raise; end if;
  end;
end $$;
select count(*) as deberia_ser_1 from hoteles.config_audit_log where property_id = '00000000-0000-0000-0000-0000000c1a01' and area = 'sobreventa';
rollback;

\echo '=== 17. sobreventa: valores fuera de rango, frontdesk, cross-tenant y un tipo de habitacion de OTRA property se rechazan ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0a01', true);
do $$
begin
  begin
    perform hoteles.set_room_type_overbooking('00000000-0000-0000-0000-0000000c1a01', '00000000-0000-0000-0000-0000000c2a01', -1, null);
    raise exception 'se esperaba invalid_parameter_value y la llamada no fallo';
  exception when invalid_parameter_value then
    null;
  end;
end $$;
do $$
begin
  begin
    perform hoteles.set_room_type_overbooking('00000000-0000-0000-0000-0000000c1a01', '00000000-0000-0000-0000-0000000c2b01', 1, null);
    raise exception 'se esperaba no_data_found y la llamada no fallo';
  exception when no_data_found then
    null;
  end;
end $$;
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0a03', true);
do $$
begin
  begin
    perform hoteles.set_room_type_overbooking('00000000-0000-0000-0000-0000000c1a01', '00000000-0000-0000-0000-0000000c2a01', 1, null);
    raise exception 'se esperaba insufficient_privilege y la llamada no fallo';
  exception when insufficient_privilege then
    null;
  end;
end $$;
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0b01', true);
do $$
begin
  begin
    perform hoteles.set_room_type_overbooking('00000000-0000-0000-0000-0000000c1a01', '00000000-0000-0000-0000-0000000c2a01', 1, null);
    raise exception 'se esperaba insufficient_privilege y la llamada no fallo';
  exception when insufficient_privilege then
    null;
  end;
end $$;
rollback;

\echo '=== 18. TARIFA: owner edita el precio (queda marcada como manual con su autor) y la bitacora guarda anterior y nuevo; repetir la edicion no duplica ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0a01', true);
select price from hoteles.set_rate_price('00000000-0000-0000-0000-0000000c1a01', '00000000-0000-0000-0000-0000000c3a01', 1500, null);
select price from hoteles.set_rate_price('00000000-0000-0000-0000-0000000c1a01', '00000000-0000-0000-0000-0000000c3a01', 1500, null);
do $$
declare v_at timestamptz; v_by uuid; v_n integer; v_prev numeric; v_new numeric;
begin
  select manual_price_at, manual_price_by into v_at, v_by from hoteles.rate_plan where id = '00000000-0000-0000-0000-0000000c3a01';
  if v_at is null or v_by <> '00000000-0000-0000-0000-0000000c0a01' then raise exception 'la tarifa no quedo marcada como manual del owner'; end if;
  select count(*), max((valor_anterior->>'price')::numeric), max((valor_nuevo->>'price')::numeric) into v_n, v_prev, v_new
    from hoteles.config_audit_log where entity_id = '00000000-0000-0000-0000-0000000c3a01' and area = 'tarifa';
  if v_n <> 1 or v_prev <> 1000 or v_new <> 1500 then raise exception 'bitacora de tarifa incorrecta: n=%, anterior=%, nuevo=%', v_n, v_prev, v_new; end if;
end $$;
rollback;

\echo '=== 19. tarifa: precio negativo, frontdesk, cross-tenant y una tarifa de otra property se rechazan ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0a01', true);
do $$
begin
  begin
    perform hoteles.set_rate_price('00000000-0000-0000-0000-0000000c1a01', '00000000-0000-0000-0000-0000000c3a01', -5, null);
    raise exception 'se esperaba invalid_parameter_value y la llamada no fallo';
  exception when invalid_parameter_value then
    null;
  end;
end $$;
do $$
begin
  begin
    perform hoteles.set_rate_price('00000000-0000-0000-0000-0000000c1a01', '00000000-0000-0000-0000-0000000c3b01', 100, null);
    raise exception 'se esperaba no_data_found y la llamada no fallo';
  exception when no_data_found then
    null;
  end;
end $$;
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0a03', true);
do $$
begin
  begin
    perform hoteles.set_rate_price('00000000-0000-0000-0000-0000000c1a01', '00000000-0000-0000-0000-0000000c3a01', 100, null);
    raise exception 'se esperaba insufficient_privilege y la llamada no fallo';
  exception when insufficient_privilege then
    null;
  end;
end $$;
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0b01', true);
do $$
begin
  begin
    perform hoteles.set_rate_price('00000000-0000-0000-0000-0000000c1a01', '00000000-0000-0000-0000-0000000c3a01', 100, null);
    raise exception 'se esperaba insufficient_privilege y la llamada no fallo';
  exception when insufficient_privilege then
    null;
  end;
end $$;
do $$
begin
  begin
    perform hoteles.set_rate_price('00000000-0000-0000-0000-0000000c1b01', '00000000-0000-0000-0000-0000000c3a01', 100, null);
    raise exception 'se esperaba no_data_found y la llamada no fallo';
  exception when no_data_found then
    null;
  end;
end $$;
rollback;

\echo '=== 20. MOTOR DE REVENUE: una tarifa con precio manual NO la pisa system_apply_rate_recommendation (tarifa_manual_vigente) y la tarifa conserva el precio del owner ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0a01', true);
select price from hoteles.set_rate_price('00000000-0000-0000-0000-0000000c1a01', '00000000-0000-0000-0000-0000000c3a01', 1500, null);
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
do $$
begin
  begin
    perform hoteles.system_apply_rate_recommendation('00000000-0000-0000-0000-0000000c4a01');
    raise exception 'se esperaba tarifa_manual_vigente y el motor aplico la recomendacion';
  exception when sqlstate 'P0001' then
    if sqlerrm not like 'tarifa_manual_vigente%' then raise; end if;
  end;
end $$;
reset role;
select count(*) as deberia_ser_1 from hoteles.rate_plan where id = '00000000-0000-0000-0000-0000000c3a01' and price = 1500;
rollback;

\echo '=== 21. el trigger de precio manual no se deja falsificar y un alta de staff NO marca: manual_price_by/at quedan nulos aunque el cliente los escriba; el motor (sistema) no marca ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0a01', true);
insert into hoteles.rate_plan (organization_id, property_id, room_type_id, date, price, manual_price_at, manual_price_by)
values ('00000000-0000-0000-0000-00000000c0a1', '00000000-0000-0000-0000-0000000c1a01', '00000000-0000-0000-0000-0000000c2a01', current_date + 20, 800, null, '00000000-0000-0000-0000-0000000c0a02');
do $$
declare v_by uuid;
begin
  select manual_price_by into v_by from hoteles.rate_plan where room_type_id = '00000000-0000-0000-0000-0000000c2a01' and date = current_date + 20;
  if v_by is not null then raise exception 'manual_price_by falsificable o marcado por un alta: %', v_by; end if;
  if exists (select 1 from hoteles.rate_plan where room_type_id = '00000000-0000-0000-0000-0000000c2a01' and date = current_date + 20 and manual_price_at is not null) then
    raise exception 'un alta de staff no debe marcar la tarifa como manual';
  end if;
end $$;
reset role;
select set_config('request.jwt.claim.sub', '', true);
update hoteles.rate_plan set price = 850 where room_type_id = '00000000-0000-0000-0000-0000000c2a01' and date = current_date + 6;
select count(*) as deberia_ser_1 from hoteles.rate_plan where id = '00000000-0000-0000-0000-0000000c3a02' and price = 850 and manual_price_at is null;
rollback;

\echo '=== 22. BASE SIN MIGRAR: sin la funcion set_tax_config la llamada falla con 42883 y el SAVEPOINT recupera la transaccion (nunca 25P02) ==='
begin;
drop function hoteles.set_tax_config(uuid, numeric, numeric, numeric, numeric);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0a01', true);
savepoint sp_verify_set_tax_config;
do $$
declare v_state text;
begin
  begin
    perform hoteles.set_tax_config('00000000-0000-0000-0000-0000000c1a01', 0.16, 0.03, 500, 0);
    raise exception 'se esperaba 42883 y la funcion existe';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    if v_state <> '42883' then raise exception 'se esperaba 42883, se obtuvo %', v_state; end if;
  end;
end $$;
rollback to savepoint sp_verify_set_tax_config;
release savepoint sp_verify_set_tax_config;
select 1 as transaccion_recuperada_deberia_ser_1;
rollback;

\echo '=== 23. BASE SIN MIGRAR: sin la columna guest_text la lectura de la politica falla con 42703 y el SAVEPOINT recupera la transaccion ==='
begin;
alter table hoteles.cancellation_policy drop column guest_text;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0a01', true);
savepoint sp_verify_guest_text;
do $$
declare v_state text;
begin
  begin
    perform guest_text from hoteles.cancellation_policy limit 1;
    raise exception 'se esperaba 42703 y la columna existe';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    if v_state <> '42703' then raise exception 'se esperaba 42703, se obtuvo %', v_state; end if;
  end;
end $$;
rollback to savepoint sp_verify_guest_text;
release savepoint sp_verify_guest_text;
select free_until_hours from hoteles.cancellation_policy limit 1;
rollback;


\echo '=== 24. owner omite el gate de Primeros pasos: queda una fila en la bitacora; frontdesk y cross-tenant reciben 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0a01', true);
select hoteles.record_onboarding_skip('00000000-0000-0000-0000-0000000c1a01') is not null as registrado;
select count(*) as deberia_ser_1 from hoteles.config_audit_log where property_id = '00000000-0000-0000-0000-0000000c1a01' and area = 'onboarding_omitido';
rollback;

\echo '=== 25. omitir primeros pasos: frontdesk y owner de otra organizacion NO pueden (42501) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0a03', true);
do $$
begin
  begin
    perform hoteles.record_onboarding_skip('00000000-0000-0000-0000-0000000c1a01');
    raise exception 'se esperaba insufficient_privilege';
  exception when insufficient_privilege then null;
  end;
end $$;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0b01', true);
do $$
begin
  begin
    perform hoteles.record_onboarding_skip('00000000-0000-0000-0000-0000000c1a01');
    raise exception 'se esperaba insufficient_privilege';
  exception when insufficient_privilege then null;
  end;
end $$;
rollback;

-- Fixtures del motor para los escenarios 26 y 27 (mismo camino real que scripts/verify-hoteles-motor-tarifas): gate shadow -> propone
-- (90+ dias en shadow) -> aprobacion de owner -> backtest que pasa -> autopilot.
insert into hoteles.revenue_engine_gate (organization_id, property_id, gate, shadow_started_at) values
  ('00000000-0000-0000-0000-00000000c0a1', '00000000-0000-0000-0000-0000000c1a01', 'shadow', now() - interval '91 days')
on conflict do nothing;
update hoteles.revenue_engine_gate set gate = 'propone' where property_id = '00000000-0000-0000-0000-0000000c1a01';
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0a01', false);
update hoteles.revenue_engine_gate set owner_approved_autopilot_at = now() where property_id = '00000000-0000-0000-0000-0000000c1a01';
select set_config('request.jwt.claim.sub', '', false);
insert into hoteles.revenue_backtest_run (
  organization_id, property_id, counterfactual_method, windows_evaluated, windows_engine_won,
  engine_total_revenue, baseline_total_revenue, improvement_pct, passes, failure_reasons
) values (
  '00000000-0000-0000-0000-00000000c0a1', '00000000-0000-0000-0000-0000000c1a01', 'misma_tarifa_periodo_anterior', 10, 8,
  120000.00, 100000.00, 20.0, true, '[]'::jsonb
);
update hoteles.revenue_engine_gate set gate = 'autopilot' where property_id = '00000000-0000-0000-0000-0000000c1a01';

\echo '=== 26. MOTOR: una tarifa dada de alta por staff (sin edicion manual) SI la aplica el motor sobre una recomendacion pendiente ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0a01', true);
insert into hoteles.rate_plan (organization_id, property_id, room_type_id, date, price)
values ('00000000-0000-0000-0000-00000000c0a1', '00000000-0000-0000-0000-0000000c1a01', '00000000-0000-0000-0000-0000000c2a01', current_date + 5, 1000)
on conflict (room_type_id, date) do update set price = excluded.price;
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select estado from hoteles.system_apply_rate_recommendation('00000000-0000-0000-0000-0000000c4a01');
reset role;
select count(*) as deberia_ser_1 from hoteles.rate_plan where room_type_id = '00000000-0000-0000-0000-0000000c2a01' and date = current_date + 5 and price = 1100 and manual_price_at is null;
rollback;

\echo '=== 27. MOTOR: la aprobacion humana explicita se aplica aunque haya precio manual y limpia la marca ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0a01', true);
insert into hoteles.rate_plan (organization_id, property_id, room_type_id, date, price)
values ('00000000-0000-0000-0000-00000000c0a1', '00000000-0000-0000-0000-0000000c1a01', '00000000-0000-0000-0000-0000000c2a01', current_date + 5, 1000)
on conflict (room_type_id, date) do update set price = excluded.price;
select price from hoteles.set_rate_price('00000000-0000-0000-0000-0000000c1a01',
  (select id from hoteles.rate_plan where room_type_id = '00000000-0000-0000-0000-0000000c2a01' and date = current_date + 5), 1300, null);
reset role;
update hoteles.revenue_engine_gate set gate = 'propone' where property_id = '00000000-0000-0000-0000-0000000c1a01';
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0a01', true);
update hoteles.rate_recommendation set estado = 'aprobada' where id = '00000000-0000-0000-0000-0000000c4a01';
select set_config('request.jwt.claim.sub', '', true);
select estado from hoteles.system_apply_rate_recommendation('00000000-0000-0000-0000-0000000c4a01');
reset role;
select count(*) as deberia_ser_1 from hoteles.rate_plan where room_type_id = '00000000-0000-0000-0000-0000000c2a01' and date = current_date + 5 and price = 1100 and manual_price_at is null;
rollback;

\echo ''
\echo '=== listo: 27 escenarios (los "deberia_ser_N" y los do-blocks deben terminar sin error) ==='
