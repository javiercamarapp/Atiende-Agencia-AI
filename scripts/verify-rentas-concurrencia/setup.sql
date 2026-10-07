-- Fixtures y ayudantes SOLO de esta verificacion (schema `conc`, jamas viaja en una migracion). Se aplica DESPUES de las migraciones reales.
--
-- Alcance honesto: la logica de reserva/statement de rentas vive en TypeScript (packages/domain-rentas/src/aplicacion/reservas.ts y
-- apps/api/.../finanzas-statements.ts), no en funciones SQL. Los ayudantes `conc.try_reserva` y `conc.try_statement` reproducen LITERALMENTE la
-- secuencia SQL de esas rutas (mismo advisory lock `hashtextextended`, mismos INSERT contra las tablas reales, mismo manejo de 23P01) para
-- demostrar que las garantias de BASE DE DATOS (EXCLUDE ocupacion_sin_solape, UNIQUE de versiones, advisory lock por clave) aguantan N
-- conexiones simultaneas. Lo que se prueba con las funciones REALES de las migraciones: rentas.claim_ical_feeds (024) y core.accept_staff_invite.
-- Los ayudantes son security definer a proposito: RLS/GRANT ya los cubren los scripts/verify-rentas-*/ de una sola conexion; aqui se aislan los
-- bloqueos y las restricciones.
create schema conc;
grant usage on schema conc to authenticated;

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000c2701', 'rentas', 'Org Rentas Concurrencia', 'org-rentas-conc')
on conflict do nothing;
insert into core.property (id, organization_id, vertical, name) values
  ('00000000-0000-0000-0000-0000000c2711', '00000000-0000-0000-0000-0000000c2701', 'rentas', 'Propiedad Concurrencia')
on conflict do nothing;

-- 24 unidades (u01..u24): cada escenario/ronda usa la suya para no pisarse.
insert into rentas.unidad (id, organization_id, property_id, name, duracion_minima_noches)
select ('00000000-0000-0000-0000-0000000c28' || lpad(n::text, 2, '0'))::uuid, '00000000-0000-0000-0000-0000000c2701', '00000000-0000-0000-0000-0000000c2711', 'Unidad ' || n, 1
from generate_series(1, 24) n;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000c2721', 'admin-conc-rentas@example.com', 'Admin Concurrencia', 'seed');
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000c2721', '00000000-0000-0000-0000-0000000c2701', null, 'admin', 'admin_gestora');
insert into rentas.owner (id, name, email) values ('00000000-0000-0000-0000-0000000c2731', 'Propietario Concurrencia', 'prop-conc@example.com');
insert into rentas.owner_organization (owner_id, organization_id) values ('00000000-0000-0000-0000-0000000c2731', '00000000-0000-0000-0000-0000000c2701');

-- Reserva directa por la secuencia de crearReservaConfirmada: advisory lock por unidad, INSERT confirmado y, si el EXCLUDE (23P01) lo
-- rechaza, la misma reserva como conflicto_pendiente + fila de conflicto_calendario. Devuelve 'ok:confirmado' | 'ok:conflicto_pendiente' | 'err:<SQLSTATE>'.
create function conc.try_reserva(p_unidad uuid, p_inicio date, p_fin date, p_external text) returns text
language plpgsql
security definer
set search_path = pg_catalog, rentas, core, pg_temp
as $$
declare
  c_org constant uuid := '00000000-0000-0000-0000-0000000c2701';
  c_prop constant uuid := '00000000-0000-0000-0000-0000000c2711';
  v_id uuid;
  v_existente uuid;
  v_nuevo uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_unidad::text, 0));
  begin
    insert into rentas.ocupacion (organization_id, property_id, unidad_id, rango, capa, razon, estado, bloqueante, external_id)
    values (c_org, c_prop, p_unidad, daterange(p_inicio, p_fin, '[)'), 'reserva', 'RESERVA_CANAL', 'confirmado', true, p_external)
    returning id into v_id;
    return 'ok:confirmado';
  exception when exclusion_violation then
    select o.id into v_existente from rentas.ocupacion o
      where o.unidad_id = p_unidad and o.capa = 'reserva' and o.estado <> 'cancelado' and o.bloqueante and o.rango && daterange(p_inicio, p_fin, '[)') limit 1;
    insert into rentas.ocupacion (organization_id, property_id, unidad_id, rango, capa, razon, estado, bloqueante, external_id)
    values (c_org, c_prop, p_unidad, daterange(p_inicio, p_fin, '[)'), 'reserva', 'RESERVA_CANAL', 'conflicto_pendiente', false, p_external)
    returning id into v_nuevo;
    if v_existente is not null then
      insert into rentas.conflicto_calendario (organization_id, property_id, unidad_id, ocupacion_a_id, ocupacion_b_id, tipo)
      values (c_org, c_prop, p_unidad, v_existente, v_nuevo, 'overbooking_confirmado');
    end if;
    return 'ok:conflicto_pendiente';
  end;
exception when others then
  return 'err:' || sqlstate;
end;
$$;
grant execute on function conc.try_reserva(uuid, date, date, text) to authenticated;

-- Statement por la secuencia de la ruta: advisory lock (owner, property, periodo), leer la ultima version, idempotente si el hash no cambia,
-- exigir motivo si ya habia version, INSERT de version+1. Devuelve 'ok:creado:<v>' | 'ok:igual:<v>' | 'err:<SQLSTATE>'.
create function conc.try_statement(p_ini date, p_fin date, p_hash text, p_motivo text) returns text
language plpgsql
security definer
set search_path = pg_catalog, rentas, core, pg_temp
as $$
declare
  c_org constant uuid := '00000000-0000-0000-0000-0000000c2701';
  c_prop constant uuid := '00000000-0000-0000-0000-0000000c2711';
  c_owner constant uuid := '00000000-0000-0000-0000-0000000c2731';
  v_ver integer;
  v_hash text;
begin
  perform pg_advisory_xact_lock(hashtextextended('owner_statement:' || c_owner || ':' || c_prop || ':' || p_ini || ':' || p_fin, 0));
  select s.version, s.hash_contenido into v_ver, v_hash from rentas.owner_statement s
    where s.owner_id = c_owner and s.property_id = c_prop and s.periodo_inicio = p_ini and s.periodo_fin = p_fin order by s.version desc limit 1;
  if v_ver is not null and v_hash = p_hash then
    return 'ok:igual:' || v_ver;
  end if;
  if v_ver is not null and p_motivo is null then
    return 'err:motivo';
  end if;
  insert into rentas.owner_statement (organization_id, owner_id, property_id, periodo_inicio, periodo_fin, version, moneda,
    ingresos_brutos_centavos, comision_canal_centavos, comision_gestor_centavos, gastos_centavos, impuestos_centavos, neto_centavos, hash_contenido, motivo_version)
  values (c_org, c_owner, c_prop, p_ini, p_fin, coalesce(v_ver, 0) + 1, 'MXN', 0, 0, 0, 0, 0, 0, p_hash, p_motivo);
  return 'ok:creado:' || (coalesce(v_ver, 0) + 1);
exception when others then
  return 'err:' || sqlstate;
end;
$$;
grant execute on function conc.try_statement(date, date, text, text) to authenticated;

-- Lote iCal por la funcion REAL rentas.claim_ical_feeds (sesion de sistema). Devuelve 'ok:<ids separados por coma>' o 'err:<SQLSTATE>'.
create function conc.try_claim(p_limite integer) returns text
language plpgsql
as $$
declare
  v text;
begin
  select coalesce(string_agg(feed_id::text, ',' order by feed_id), '') into v from rentas.claim_ical_feeds(p_limite, 120, 0);
  return 'ok:' || v;
exception when others then
  return 'err:' || sqlstate;
end;
$$;
grant execute on function conc.try_claim(integer) to authenticated;

-- Aceptacion de invitacion por la funcion REAL core.accept_staff_invite (el invitado aun no tiene sesion: auth.uid() null).
create function conc.try_accept(p_token_seed text, p_nombre text) returns text
language plpgsql
as $$
begin
  perform * from core.accept_staff_invite(encode(sha256(convert_to(p_token_seed, 'utf8')), 'hex'), p_nombre, 'hash-de-prueba');
  return 'ok';
exception when others then
  return 'err:' || sqlstate;
end;
$$;
grant execute on function conc.try_accept(text, text) to authenticated;
