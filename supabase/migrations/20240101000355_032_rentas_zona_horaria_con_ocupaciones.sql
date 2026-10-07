-- ---------------------------------------------------------------------------
-- Rentas 032 (Rn-P3-11, D-DSD-07): rentas.actualizar_propiedad rechaza cambiar la zona horaria cuando la
-- propiedad tiene reservas o bloqueos vigentes.
--
-- Por que una migracion nueva y no una edicion de 027: `supabase db push` decide por version, no por contenido;
-- una edicion de 027 nunca llegaria a una base donde 027 ya se aplico.
--
-- Cambio: UNA sola regla nueva (55000 si p_zona_horaria cambia y hay rentas.ocupacion con estado <> 'cancelado'
-- y upper(rango) >= hoy en la zona actual). El resto del cuerpo es el vigente de 027 sin cambios.
--
-- Seguridad: identica a 027. security definer con set search_path fijo, revoke de public/anon, execute solo a
-- authenticated; exige auth.uid() y rentas.es_admin_gestora (cross-tenant -> P0002). No agrega GRANT, policy ni
-- tabla. La lectura de rentas.ocupacion corre como owner de la funcion y solo produce un booleano interno: no
-- expone filas ni ids.
-- ---------------------------------------------------------------------------
create or replace function rentas.actualizar_propiedad(p_property_id uuid, p_nombre text default null, p_zona_horaria text default null, p_moneda text default null)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, rentas, core, pg_temp
as $$
declare
  v_org uuid;
  v_nombre text := nullif(btrim(coalesce(p_nombre, '')), '');
  v_moneda_actual text;
  v_zona_actual text;
begin
  if auth.uid() is null then
    raise exception 'rentas.actualizar_propiedad: solo staff autenticado.' using errcode = '42501';
  end if;
  select p.organization_id into v_org from core.property p where p.id = p_property_id for update;
  if v_org is null or not rentas.es_admin_gestora(v_org, p_property_id) then
    raise exception 'rentas.actualizar_propiedad: propiedad no encontrada.' using errcode = 'P0002';
  end if;
  if p_nombre is not null and (v_nombre is null or char_length(v_nombre) < 2 or char_length(v_nombre) > 120) then
    raise exception 'rentas.actualizar_propiedad: el nombre debe tener entre 2 y 120 caracteres.' using errcode = '22023';
  end if;
  if p_zona_horaria is not null and not exists (select 1 from pg_catalog.pg_timezone_names z where z.name = p_zona_horaria) then
    raise exception 'rentas.actualizar_propiedad: zona horaria IANA invalida.' using errcode = '22023';
  end if;
  if p_moneda is not null and p_moneda not in ('MXN', 'USD') then
    raise exception 'rentas.actualizar_propiedad: moneda invalida (se esperaba MXN o USD).' using errcode = '22023';
  end if;
  if v_nombre is not null and exists (
    select 1 from core.property p where p.organization_id = v_org and p.id <> p_property_id and lower(p.name) = lower(v_nombre)
  ) then
    raise exception 'rentas.actualizar_propiedad: ya existe una propiedad con ese nombre.' using errcode = '23505';
  end if;

  select pc.moneda, pc.zona_horaria into v_moneda_actual, v_zona_actual from rentas.property_config pc where pc.property_id = p_property_id;
  -- D-DSD-07: cambiar la zona horaria mueve el dia local de las noches de los syncs futuros y de los
  -- feeds exportados; con una reserva o bloqueo vigente (no cancelado, con fin >= hoy en la zona ACTUAL)
  -- correria hasta un dia. Se rechaza (55000, mismo codigo de la regla de moneda) y el cambio se hace
  -- cuando no haya ocupaciones vigentes.
  if p_zona_horaria is not null and p_zona_horaria <> coalesce(v_zona_actual, 'America/Mexico_City')
     and exists (
       select 1 from rentas.ocupacion o
       where o.property_id = p_property_id
         and o.estado <> 'cancelado'
         and upper(o.rango) >= (now() at time zone coalesce(v_zona_actual, 'America/Mexico_City'))::date
     ) then
    raise exception 'rentas.actualizar_propiedad: no se puede cambiar la zona horaria con reservas o bloqueos activos.' using errcode = '55000';
  end if;
  if p_moneda is not null and v_moneda_actual is not null and p_moneda <> v_moneda_actual
     and exists (select 1 from rentas.reserva_financiero rf where rf.property_id = p_property_id) then
    raise exception 'rentas.actualizar_propiedad: la propiedad ya tiene movimientos financieros; no se puede cambiar su moneda.' using errcode = '55000';
  end if;

  if v_nombre is not null then
    update core.property set name = v_nombre where id = p_property_id;
  end if;
  if p_zona_horaria is not null or p_moneda is not null then
    insert into rentas.property_config (property_id, organization_id, zona_horaria, moneda)
    values (p_property_id, v_org, coalesce(p_zona_horaria, 'America/Mexico_City'), coalesce(p_moneda, 'MXN'))
    on conflict (property_id) do update
      set zona_horaria = coalesce(p_zona_horaria, rentas.property_config.zona_horaria),
          moneda = coalesce(p_moneda, rentas.property_config.moneda);
  end if;
  return p_property_id;
end;
$$;
revoke all on function rentas.actualizar_propiedad(uuid, text, text, text) from public, anon;
grant execute on function rentas.actualizar_propiedad(uuid, text, text, text) to authenticated;
