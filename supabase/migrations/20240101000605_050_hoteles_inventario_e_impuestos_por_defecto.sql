-- Onboarding P0 hoteles: inventario generado desde las habitaciones y configuracion de impuestos por defecto.
--
-- Problema (investigacion A §3.2/§3.5): ningun codigo de producto escribia hoteles.availability (book_availability, unica via de reserva,
-- responde `sin_disponibilidad` si no hay fila por tipo y noche) y sin fila en hoteles.tax_config cotizar o crear una reserva respondia
-- 500 (loadTaxConfig lanza). Un hotel nuevo no podia llegar a su primera reserva sin SQL a mano.
--
-- Que agrega (aditivo; ninguna tabla ni funcion existente se reemplaza):
--   A) Trigger AFTER INSERT en hoteles.room_type: al crear el primer tipo de habitacion de una propiedad se siembra su fila de
--      hoteles.tax_config con los DEFAULT de la tabla (IVA 16 %, ISH 3 %, umbral 500; migracion 001). `on conflict do nothing`: una
--      configuracion ya capturada nunca se pisa.
--   B) hoteles.generar_inventario(p_property_id, p_desde, p_hasta): crea/actualiza hoteles.availability para cada tipo de habitacion y
--      noche del rango con total_rooms = numero de habitaciones fisicas del tipo (hoteles.room). Conserva booked_rooms (solo lo mueve
--      book_availability). Idempotente: re-ejecutar recalcula total_rooms (p. ej. tras dar de alta mas habitaciones). Tambien siembra la
--      tax_config por defecto si falta (hoteles creados antes de este archivo). Rango maximo 400 noches, desde ayer como minimo.
--
-- Justificacion de seguridad:
--   * A: funcion de trigger security definer (authenticated no tiene INSERT en hoteles.tax_config y el owner/gm que crea el tipo no debe
--     necesitarlo), `set search_path = hoteles, pg_temp`, solo inserta la fila de la MISMA propiedad/organizacion del tipo recien creado
--     (que ya paso la policy de 018: can_manage_catalog). `revoke all ... from public`: no es invocable como RPC.
--   * B: security definer, `set search_path = hoteles, core, pg_temp`, `revoke all from public, anon`, execute solo a authenticated. Con
--     sesion de staff exige hoteles.can_manage_catalog(p_property_id) (owner/gm con acceso a ESA propiedad; 42501 si no): un staff de otra
--     organizacion o sin rol no escribe nada. Sesion de sistema (auth.uid() nulo) permitida para crons. Valida el rango (22023) y que la
--     propiedad sea de hoteles (P0002). Solo escribe filas de la propiedad indicada; la organizacion se toma de core.property, nunca de
--     un parametro. No se crea ningun GRANT de tabla nuevo.

-- ═══════════════════════════════════════════════════════════════════════════
-- A) tax_config por defecto al crear el primer tipo de habitacion
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function hoteles.room_type_tax_config_por_defecto()
returns trigger
language plpgsql
security definer
set search_path = hoteles, pg_temp
as $$
begin
  insert into hoteles.tax_config (property_id, organization_id)
  values (new.property_id, new.organization_id)
  on conflict (property_id) do nothing;
  return new;
end;
$$;
revoke all on function hoteles.room_type_tax_config_por_defecto() from public, anon, authenticated;

drop trigger if exists room_type_tax_config_por_defecto on hoteles.room_type;
create trigger room_type_tax_config_por_defecto
  after insert on hoteles.room_type
  for each row execute function hoteles.room_type_tax_config_por_defecto();

-- ═══════════════════════════════════════════════════════════════════════════
-- B) Generar inventario desde las habitaciones
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function hoteles.generar_inventario(p_property_id uuid, p_desde date, p_hasta date)
returns table (out_tipos integer, out_noches integer, out_filas integer)
language plpgsql
security definer
set search_path = hoteles, core, pg_temp
as $$
declare
  v_org uuid;
  v_tipos integer;
  v_filas integer;
begin
  select p.organization_id into v_org from core.property p where p.id = p_property_id and p.vertical = 'hoteles';
  if v_org is null then
    raise exception 'generar_inventario: propiedad de hoteles no encontrada' using errcode = 'P0002';
  end if;
  if auth.uid() is not null and not hoteles.can_manage_catalog(p_property_id) then
    raise exception 'generar_inventario: solo owner/gm de la propiedad' using errcode = '42501';
  end if;
  if p_desde is null or p_hasta is null or p_hasta < p_desde then
    raise exception 'generar_inventario: rango invalido' using errcode = '22023';
  end if;
  if p_desde < current_date - 1 then
    raise exception 'generar_inventario: el rango no puede empezar en el pasado' using errcode = '22023';
  end if;
  if p_hasta - p_desde + 1 > 400 then
    raise exception 'generar_inventario: maximo 400 noches por llamada' using errcode = '22023';
  end if;

  insert into hoteles.tax_config (property_id, organization_id) values (p_property_id, v_org) on conflict (property_id) do nothing;

  select count(*) into v_tipos from hoteles.room_type rt where rt.property_id = p_property_id;

  insert into hoteles.availability (organization_id, property_id, room_type_id, date, total_rooms)
  select v_org, p_property_id, rt.id, d::date,
         (select count(*) from hoteles.room r where r.room_type_id = rt.id and r.property_id = p_property_id)::integer
    from hoteles.room_type rt
   cross join generate_series(p_desde, p_hasta, interval '1 day') d
   where rt.property_id = p_property_id
  on conflict (property_id, room_type_id, date) do update
    set total_rooms = excluded.total_rooms, updated_at = now()
    where hoteles.availability.total_rooms is distinct from excluded.total_rooms;
  get diagnostics v_filas = row_count;

  return query select v_tipos, (p_hasta - p_desde + 1)::integer, v_filas;
end;
$$;
revoke all on function hoteles.generar_inventario(uuid, date, date) from public, anon;
grant execute on function hoteles.generar_inventario(uuid, date, date) to authenticated;
