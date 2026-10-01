-- Rn-18 + Rn-19: que un tenant NUEVO de rentas pueda operar de punta a punta sin
-- intervencion de service_role.
--
--   A) Reglas de comision de canal configurables (Rn-18). Hasta 026, la unica forma de
--      insertar una fila en rentas.regla_comision_canal era service_role: un tenant
--      nuevo no tenia ninguna regla y el movimiento financiero de cualquier reserva
--      fallaba. Aqui se agregan funciones de alta/edicion para admin_gestora y un sembrado
--      idempotente de valores por defecto (al crear la organizacion, al crear una
--      propiedad y bajo demanda).
--   B) Alta y edicion de propiedades, unidades y propietarios (Rn-19). Hasta 026 solo el
--      registro inicial (016_onboarding_security_definer.sql) creaba esas filas.
--   C) Catalogo de entity_type de la bitacora: agrega 'propiedad', 'unidad', 'propietario'
--      y 'regla_comision' (el staff, 'membership', ya estaba reservado en 021).
--
-- Requiere: 003_finanzas_schema.sql, 016_onboarding_security_definer.sql,
-- 023_rentas_audit_log_cobertura_completa.sql.
--
-- JUSTIFICACION DE SEGURIDAD (cada funcion nueva)
--   * Ninguna tabla gana INSERT/UPDATE/DELETE para `authenticated` (el GRANT sigue siendo
--     solo SELECT, ver 001 y 003). Toda escritura nueva pasa por una funcion `security
--     definer`; por eso NO hay GRANT por columna nuevo: no se abre ninguna escritura directa
--     que acotar. core.property (donde vive el nombre de la propiedad) solo admite
--     escritura de service_role y por eso tambien se escribe via funcion.
--   * Todas exigen auth.uid() no nulo (42501): son decisiones de un humano autenticado, la
--     sesion de sistema (auth.uid() null) nunca las ejecuta. La unica funcion sin guard de
--     usuario es el sembrado interno `rentas.sembrar_reglas_comision_base`, que NO tiene
--     EXECUTE para ningun rol de la plataforma (solo la llaman otras funciones definer y el
--     trigger de abajo, que corren como el dueno).
--   * Todas verifican el rol DENTRO de la funcion con `rentas.es_admin_gestora`: vertical_role
--     = 'admin_gestora' en core.membership, con alcance de property respetado. Espejo SQL de
--     CATALOGO_ESCRITURA_ROLES / FINANZAS_ESCRITURA_ROLES de roles.ts, defensa en profundidad
--     frente a un cliente con JWT propio que se salte la API.
--   * Un recurso ajeno o inexistente da el MISMO error (42501 o P0002 segun la funcion) para
--     no revelar su existencia entre tenants.
--   * search_path fijo (pg_catalog primero, pg_temp al final), EXECUTE revocado a public y
--     anon, EXECUTE solo para authenticated.
--
-- Codigos: 42501 sin permiso, 22023 argumento invalido, 23505 duplicado, 55000 regla de
-- integridad (moneda de una propiedad con movimientos), P0002 no encontrado.

-- ---------------------------------------------------------------------------
-- C) Catalogo de entity_type de la bitacora. Mismo mecanismo que 023: DROP + ADD del CHECK.
-- ---------------------------------------------------------------------------
alter table rentas.audit_log drop constraint audit_log_entity_type_check;
alter table rentas.audit_log add constraint audit_log_entity_type_check
  check (entity_type in (
    'pricing', 'reserva', 'payout', 'owner_statement', 'membership', 'canal', 'bloqueo', 'owner_credential',
    'propiedad', 'unidad', 'propietario', 'regla_comision'
  ));

-- ---------------------------------------------------------------------------
-- Guard de rol compartido por las funciones de abajo.
--   p_property_id null  -> exige un admin_gestora de alcance TOTAL de la organizacion
--                          (property_ids null): recursos que son de la organizacion, no de
--                          una property (propietarios, reglas globales, propiedades nuevas).
--   p_property_id no null -> exige admin_gestora con acceso a esa property, y la property
--                          debe pertenecer a p_organization_id.
-- security definer porque lee core.membership/core.property sin depender de las policies de
-- quien llama; NO se otorga EXECUTE a ningun rol de la plataforma (la usan otras funciones
-- definer, que corren como el dueno).
-- ---------------------------------------------------------------------------
create function rentas.es_admin_gestora(p_organization_id uuid, p_property_id uuid default null)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, core, pg_temp
as $$
  select auth.uid() is not null and exists (
    select 1
    from core.membership m
    where m.user_id = auth.uid()
      and m.organization_id = p_organization_id
      and m.vertical_role = 'admin_gestora'
      and (
        (p_property_id is null and m.property_ids is null)
        or (
          p_property_id is not null
          and (m.property_ids is null or p_property_id = any(m.property_ids))
          and exists (select 1 from core.property p where p.id = p_property_id and p.organization_id = p_organization_id)
        )
      )
  )
$$;
revoke all on function rentas.es_admin_gestora(uuid, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- A) Reglas de comision de canal.
-- ---------------------------------------------------------------------------

-- Sembrado idempotente de valores por defecto: una regla GLOBAL (property_id null) por canal
-- del catalogo que todavia no tenga ninguna. Nunca pisa una regla existente. Valores
-- SUGERIDOS y no verificados con fuente oficial (la `fuente` lo dice textualmente y la UI lo
-- muestra): Airbnb confirmado como ya neto de comision (Finanzas-1, ver 003), Booking.com y
-- Vrbo con un porcentaje editable, reserva directa/manual sin comision de canal.
-- Solo se llama desde otras funciones definer y desde el trigger de abajo (sin EXECUTE para
-- ningun rol de la plataforma).
create function rentas.sembrar_reglas_comision_base(p_organization_id uuid)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, rentas, core, pg_temp
as $$
declare
  v_insertadas integer;
begin
  with defaults(codigo, ya_neto, bps, fuente) as (
    values
      ('airbnb',  true,  0,    'default_sugerido: Airbnb entrega el monto ya neto de su comision (confirmado en Finanzas-1)'),
      ('booking', false, 1500, 'default_sugerido_no_verificado: 15% de comision estimada de Booking.com; confirma tu contrato y editala'),
      ('vrbo',    false, 800,  'default_sugerido_no_verificado: 8% de comision estimada de Vrbo; confirma tu contrato y editala'),
      ('manual',  false, 0,    'default_sugerido: reserva directa o manual, sin comision de canal')
  ), insertadas as (
    insert into rentas.regla_comision_canal (organization_id, property_id, canal_id, ya_neto_de_comision, comision_basis_points, fuente)
    select p_organization_id, null, c.id, d.ya_neto, d.bps, d.fuente
    from defaults d
    join rentas.canal c on c.codigo = d.codigo
    where not exists (
      select 1 from rentas.regla_comision_canal r
      where r.organization_id = p_organization_id and r.canal_id = c.id and r.property_id is null
    )
    returning 1
  )
  select count(*) into v_insertadas from insertadas;
  return v_insertadas;
end;
$$;
revoke all on function rentas.sembrar_reglas_comision_base(uuid) from public, anon, authenticated;

-- Una organizacion de rentas nueva (el registro inserta rentas.organization_perfil dentro de
-- rentas.register_tenant_onboarding) nace con sus reglas por defecto. Sin tocar la funcion de
-- registro de 016. security definer: corre como el dueno, igual que el registro.
create function rentas.organization_perfil_sembrar_reglas()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, rentas, core, pg_temp
as $$
begin
  perform rentas.sembrar_reglas_comision_base(new.organization_id);
  return new;
end;
$$;
revoke all on function rentas.organization_perfil_sembrar_reglas() from public, anon, authenticated;

create trigger organization_perfil_sembrar_reglas_trg
after insert on rentas.organization_perfil
for each row execute function rentas.organization_perfil_sembrar_reglas();

-- Sembrado bajo demanda (boton "cargar valores sugeridos" para tenants que ya existian antes
-- de esta migracion y no tienen reglas). Solo admin_gestora de alcance total. Devuelve cuantas
-- reglas se crearon (0 si ya tenia todas).
create function rentas.sembrar_reglas_comision_por_defecto(p_organization_id uuid)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, rentas, core, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'rentas.sembrar_reglas_comision_por_defecto: solo staff autenticado.' using errcode = '42501';
  end if;
  if not rentas.es_admin_gestora(p_organization_id, null) then
    raise exception 'rentas.sembrar_reglas_comision_por_defecto: tu rol no puede configurar comisiones.' using errcode = '42501';
  end if;
  return rentas.sembrar_reglas_comision_base(p_organization_id);
end;
$$;
revoke all on function rentas.sembrar_reglas_comision_por_defecto(uuid) from public, anon;
grant execute on function rentas.sembrar_reglas_comision_por_defecto(uuid) to authenticated;

-- Alta de una regla para un canal. Una sola regla por (organizacion, canal, alcance): el
-- alcance es la property o, con p_property_id null, la regla global de la organizacion.
-- Editar una existente pasa por actualizar_regla_comision_canal; la trazabilidad del cambio
-- queda en la bitacora (rentas.audit_log), no en filas historicas.
create function rentas.crear_regla_comision_canal(
  p_organization_id uuid,
  p_property_id uuid,
  p_canal_codigo text,
  p_ya_neto_de_comision boolean,
  p_comision_basis_points integer,
  p_fuente text
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, rentas, core, pg_temp
as $$
declare
  v_canal_id uuid;
  v_fuente text := btrim(coalesce(p_fuente, ''));
  v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'rentas.crear_regla_comision_canal: solo staff autenticado.' using errcode = '42501';
  end if;
  if not rentas.es_admin_gestora(p_organization_id, p_property_id) then
    raise exception 'rentas.crear_regla_comision_canal: tu rol no puede configurar comisiones.' using errcode = '42501';
  end if;
  if p_ya_neto_de_comision is null then
    raise exception 'rentas.crear_regla_comision_canal: ya_neto_de_comision es obligatorio.' using errcode = '22023';
  end if;
  if p_comision_basis_points is null or p_comision_basis_points < 0 or p_comision_basis_points > 10000 then
    raise exception 'rentas.crear_regla_comision_canal: comision_basis_points debe estar entre 0 y 10000.' using errcode = '22023';
  end if;
  if p_ya_neto_de_comision and p_comision_basis_points <> 0 then
    raise exception 'rentas.crear_regla_comision_canal: un canal que ya entrega el monto neto de comision debe tener 0 puntos base.' using errcode = '22023';
  end if;
  if char_length(v_fuente) < 3 or char_length(v_fuente) > 200 then
    raise exception 'rentas.crear_regla_comision_canal: la fuente debe tener entre 3 y 200 caracteres.' using errcode = '22023';
  end if;

  select c.id into v_canal_id from rentas.canal c where c.codigo = p_canal_codigo;
  if v_canal_id is null then
    raise exception 'rentas.crear_regla_comision_canal: canal desconocido.' using errcode = '22023';
  end if;

  if exists (
    select 1 from rentas.regla_comision_canal r
    where r.organization_id = p_organization_id and r.canal_id = v_canal_id and r.property_id is not distinct from p_property_id
  ) then
    raise exception 'rentas.crear_regla_comision_canal: ya existe una regla para ese canal y alcance; editala en lugar de crear otra.' using errcode = '23505';
  end if;

  insert into rentas.regla_comision_canal (organization_id, property_id, canal_id, ya_neto_de_comision, comision_basis_points, fuente)
  values (p_organization_id, p_property_id, v_canal_id, p_ya_neto_de_comision, p_comision_basis_points, v_fuente)
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function rentas.crear_regla_comision_canal(uuid, uuid, text, boolean, integer, text) from public, anon;
grant execute on function rentas.crear_regla_comision_canal(uuid, uuid, text, boolean, integer, text) to authenticated;

-- Edicion de una regla existente: solo ya_neto_de_comision, comision_basis_points y fuente
-- (el canal y el alcance no cambian: crear otra regla es otra decision). Los movimientos ya
-- calculados guardan su propia copia de la comision (rentas.reserva_financiero), asi que editar
-- una regla nunca reescribe historia.
create function rentas.actualizar_regla_comision_canal(
  p_regla_id uuid,
  p_ya_neto_de_comision boolean,
  p_comision_basis_points integer,
  p_fuente text
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, rentas, core, pg_temp
as $$
declare
  v_regla rentas.regla_comision_canal%rowtype;
  v_fuente text := btrim(coalesce(p_fuente, ''));
begin
  if auth.uid() is null then
    raise exception 'rentas.actualizar_regla_comision_canal: solo staff autenticado.' using errcode = '42501';
  end if;
  if p_ya_neto_de_comision is null then
    raise exception 'rentas.actualizar_regla_comision_canal: ya_neto_de_comision es obligatorio.' using errcode = '22023';
  end if;
  if p_comision_basis_points is null or p_comision_basis_points < 0 or p_comision_basis_points > 10000 then
    raise exception 'rentas.actualizar_regla_comision_canal: comision_basis_points debe estar entre 0 y 10000.' using errcode = '22023';
  end if;
  if p_ya_neto_de_comision and p_comision_basis_points <> 0 then
    raise exception 'rentas.actualizar_regla_comision_canal: un canal que ya entrega el monto neto de comision debe tener 0 puntos base.' using errcode = '22023';
  end if;
  if char_length(v_fuente) < 3 or char_length(v_fuente) > 200 then
    raise exception 'rentas.actualizar_regla_comision_canal: la fuente debe tener entre 3 y 200 caracteres.' using errcode = '22023';
  end if;

  select r.* into v_regla from rentas.regla_comision_canal r where r.id = p_regla_id for update;
  -- Inexistente o de otra organizacion/property: el mismo P0002 (no revela su existencia).
  if not found or not rentas.es_admin_gestora(v_regla.organization_id, v_regla.property_id) then
    raise exception 'rentas.actualizar_regla_comision_canal: regla no encontrada.' using errcode = 'P0002';
  end if;

  update rentas.regla_comision_canal
  set ya_neto_de_comision = p_ya_neto_de_comision, comision_basis_points = p_comision_basis_points, fuente = v_fuente
  where id = v_regla.id;
  return v_regla.id;
end;
$$;
revoke all on function rentas.actualizar_regla_comision_canal(uuid, boolean, integer, text) from public, anon;
grant execute on function rentas.actualizar_regla_comision_canal(uuid, boolean, integer, text) to authenticated;

-- ---------------------------------------------------------------------------
-- B) Propiedades.
-- ---------------------------------------------------------------------------

-- Alta de una propiedad nueva de la organizacion, con su configuracion (zona horaria IANA
-- real, moneda MXN/USD) y las reglas de comision por defecto de la organizacion (idempotente).
-- Solo admin_gestora de alcance TOTAL: una propiedad nueva no estaria en el alcance de un
-- admin limitado a ciertas properties. Mismo nombre (sin distinguir mayusculas) dentro de la
-- organizacion -> 23505.
create function rentas.crear_propiedad(p_organization_id uuid, p_nombre text, p_zona_horaria text, p_moneda text)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, rentas, core, pg_temp
as $$
declare
  v_nombre text := btrim(coalesce(p_nombre, ''));
  v_property_id uuid;
begin
  if auth.uid() is null then
    raise exception 'rentas.crear_propiedad: solo staff autenticado.' using errcode = '42501';
  end if;
  if not rentas.es_admin_gestora(p_organization_id, null) then
    raise exception 'rentas.crear_propiedad: tu rol no puede crear propiedades.' using errcode = '42501';
  end if;
  if char_length(v_nombre) < 2 or char_length(v_nombre) > 120 then
    raise exception 'rentas.crear_propiedad: el nombre debe tener entre 2 y 120 caracteres.' using errcode = '22023';
  end if;
  if p_zona_horaria is null or not exists (select 1 from pg_catalog.pg_timezone_names z where z.name = p_zona_horaria) then
    raise exception 'rentas.crear_propiedad: zona horaria IANA invalida.' using errcode = '22023';
  end if;
  if p_moneda is null or p_moneda not in ('MXN', 'USD') then
    raise exception 'rentas.crear_propiedad: moneda invalida (se esperaba MXN o USD).' using errcode = '22023';
  end if;
  if exists (select 1 from core.property p where p.organization_id = p_organization_id and lower(p.name) = lower(v_nombre)) then
    raise exception 'rentas.crear_propiedad: ya existe una propiedad con ese nombre.' using errcode = '23505';
  end if;

  insert into core.property (organization_id, name, status)
  values (p_organization_id, v_nombre, 'active')
  returning id into v_property_id;

  insert into rentas.property_config (property_id, organization_id, zona_horaria, moneda)
  values (v_property_id, p_organization_id, p_zona_horaria, p_moneda);

  perform rentas.sembrar_reglas_comision_base(p_organization_id);
  return v_property_id;
end;
$$;
revoke all on function rentas.crear_propiedad(uuid, text, text, text) from public, anon;
grant execute on function rentas.crear_propiedad(uuid, text, text, text) to authenticated;

-- Edicion de nombre, zona horaria y moneda (cada parametro null = sin cambio). Cambiar la
-- moneda de una propiedad que ya tiene movimientos financieros se rechaza (55000): mezclaria
-- monedas en sus reportes y statements.
create function rentas.actualizar_propiedad(p_property_id uuid, p_nombre text default null, p_zona_horaria text default null, p_moneda text default null)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, rentas, core, pg_temp
as $$
declare
  v_org uuid;
  v_nombre text := nullif(btrim(coalesce(p_nombre, '')), '');
  v_moneda_actual text;
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

  select pc.moneda into v_moneda_actual from rentas.property_config pc where pc.property_id = p_property_id;
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

-- ---------------------------------------------------------------------------
-- B) Propietarios (rentas.owner + vinculo a la organizacion).
-- ---------------------------------------------------------------------------
create function rentas.crear_propietario(p_organization_id uuid, p_nombre text, p_email text default null)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, rentas, core, pg_temp
as $$
declare
  v_nombre text := btrim(coalesce(p_nombre, ''));
  v_email text := nullif(lower(btrim(coalesce(p_email, ''))), '');
  v_owner_id uuid;
begin
  if auth.uid() is null then
    raise exception 'rentas.crear_propietario: solo staff autenticado.' using errcode = '42501';
  end if;
  if not rentas.es_admin_gestora(p_organization_id, null) then
    raise exception 'rentas.crear_propietario: tu rol no puede crear propietarios.' using errcode = '42501';
  end if;
  if char_length(v_nombre) < 2 or char_length(v_nombre) > 120 then
    raise exception 'rentas.crear_propietario: el nombre debe tener entre 2 y 120 caracteres.' using errcode = '22023';
  end if;
  if v_email is not null and (char_length(v_email) > 200 or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$') then
    raise exception 'rentas.crear_propietario: correo invalido.' using errcode = '22023';
  end if;
  if v_email is not null and exists (
    select 1 from rentas.owner o join rentas.owner_organization oo on oo.owner_id = o.id
    where oo.organization_id = p_organization_id and lower(o.email) = v_email
  ) then
    raise exception 'rentas.crear_propietario: ya existe un propietario con ese correo.' using errcode = '23505';
  end if;

  insert into rentas.owner (name, email) values (v_nombre, v_email) returning id into v_owner_id;
  insert into rentas.owner_organization (owner_id, organization_id) values (v_owner_id, p_organization_id);
  return v_owner_id;
end;
$$;
revoke all on function rentas.crear_propietario(uuid, text, text) from public, anon;
grant execute on function rentas.crear_propietario(uuid, text, text) to authenticated;

-- Edicion de nombre y correo. Un propietario puede estar gestionado por MAS de una
-- organizacion (N:M, 001): editar sus datos globales desde una de ellas cambiaria lo que ve la
-- otra. Por eso solo se edita si esta vinculado UNICAMENTE a la organizacion que llama; si no,
-- 42501 (no editable desde aqui). p_quitar_email = true borra el correo.
create function rentas.actualizar_propietario(
  p_organization_id uuid,
  p_owner_id uuid,
  p_nombre text default null,
  p_email text default null,
  p_quitar_email boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, rentas, core, pg_temp
as $$
declare
  v_nombre text := nullif(btrim(coalesce(p_nombre, '')), '');
  v_email text := nullif(lower(btrim(coalesce(p_email, ''))), '');
begin
  if auth.uid() is null then
    raise exception 'rentas.actualizar_propietario: solo staff autenticado.' using errcode = '42501';
  end if;
  if not rentas.es_admin_gestora(p_organization_id, null) then
    raise exception 'rentas.actualizar_propietario: tu rol no puede editar propietarios.' using errcode = '42501';
  end if;
  perform 1 from rentas.owner_organization oo where oo.owner_id = p_owner_id and oo.organization_id = p_organization_id;
  if not found then
    raise exception 'rentas.actualizar_propietario: propietario no encontrado.' using errcode = 'P0002';
  end if;
  if exists (select 1 from rentas.owner_organization oo where oo.owner_id = p_owner_id and oo.organization_id <> p_organization_id) then
    raise exception 'rentas.actualizar_propietario: este propietario tambien lo gestiona otra organizacion; no se puede editar desde aqui.' using errcode = '42501';
  end if;
  if p_nombre is not null and (v_nombre is null or char_length(v_nombre) < 2 or char_length(v_nombre) > 120) then
    raise exception 'rentas.actualizar_propietario: el nombre debe tener entre 2 y 120 caracteres.' using errcode = '22023';
  end if;
  if v_email is not null and (char_length(v_email) > 200 or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$') then
    raise exception 'rentas.actualizar_propietario: correo invalido.' using errcode = '22023';
  end if;
  if v_email is not null and exists (
    select 1 from rentas.owner o join rentas.owner_organization oo on oo.owner_id = o.id
    where oo.organization_id = p_organization_id and o.id <> p_owner_id and lower(o.email) = v_email
  ) then
    raise exception 'rentas.actualizar_propietario: ya existe otro propietario con ese correo.' using errcode = '23505';
  end if;

  update rentas.owner
  set name = coalesce(v_nombre, name),
      email = case when p_quitar_email then null when v_email is not null then v_email else email end
  where id = p_owner_id;
  return p_owner_id;
end;
$$;
revoke all on function rentas.actualizar_propietario(uuid, uuid, text, text, boolean) from public, anon;
grant execute on function rentas.actualizar_propietario(uuid, uuid, text, text, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- B) Unidades.
-- ---------------------------------------------------------------------------

-- El propietario de una unidad debe estar vinculado a la MISMA organizacion de la property:
-- nunca se asigna un propietario de otro tenant (cross-tenant). Mismo nombre dentro de la
-- property -> 23505 (UNIQUE (property_id, name) de 001).
create function rentas.crear_unidad(p_property_id uuid, p_nombre text, p_owner_id uuid default null, p_duracion_minima_noches integer default 1)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, rentas, core, pg_temp
as $$
declare
  v_org uuid;
  v_nombre text := btrim(coalesce(p_nombre, ''));
  v_unidad_id uuid;
begin
  if auth.uid() is null then
    raise exception 'rentas.crear_unidad: solo staff autenticado.' using errcode = '42501';
  end if;
  select p.organization_id into v_org from core.property p where p.id = p_property_id;
  if v_org is null or not rentas.es_admin_gestora(v_org, p_property_id) then
    raise exception 'rentas.crear_unidad: tu rol no puede crear unidades en esta propiedad.' using errcode = '42501';
  end if;
  if char_length(v_nombre) < 1 or char_length(v_nombre) > 120 then
    raise exception 'rentas.crear_unidad: el nombre debe tener entre 1 y 120 caracteres.' using errcode = '22023';
  end if;
  if p_duracion_minima_noches is null or p_duracion_minima_noches < 1 or p_duracion_minima_noches > 365 then
    raise exception 'rentas.crear_unidad: la estancia minima debe estar entre 1 y 365 noches.' using errcode = '22023';
  end if;
  if p_owner_id is not null and not exists (
    select 1 from rentas.owner_organization oo where oo.owner_id = p_owner_id and oo.organization_id = v_org
  ) then
    raise exception 'rentas.crear_unidad: el propietario no pertenece a esta organizacion.' using errcode = '22023';
  end if;
  if exists (select 1 from rentas.unidad u where u.property_id = p_property_id and u.name = v_nombre) then
    raise exception 'rentas.crear_unidad: ya existe una unidad con ese nombre en esta propiedad.' using errcode = '23505';
  end if;

  insert into rentas.unidad (organization_id, property_id, owner_id, name, duracion_minima_noches)
  values (v_org, p_property_id, p_owner_id, v_nombre, p_duracion_minima_noches)
  returning id into v_unidad_id;
  return v_unidad_id;
end;
$$;
revoke all on function rentas.crear_unidad(uuid, text, uuid, integer) from public, anon;
grant execute on function rentas.crear_unidad(uuid, text, uuid, integer) to authenticated;

create function rentas.actualizar_unidad(
  p_unidad_id uuid,
  p_nombre text default null,
  p_owner_id uuid default null,
  p_quitar_owner boolean default false,
  p_duracion_minima_noches integer default null
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, rentas, core, pg_temp
as $$
declare
  v_unidad rentas.unidad%rowtype;
  v_nombre text := nullif(btrim(coalesce(p_nombre, '')), '');
begin
  if auth.uid() is null then
    raise exception 'rentas.actualizar_unidad: solo staff autenticado.' using errcode = '42501';
  end if;
  select u.* into v_unidad from rentas.unidad u where u.id = p_unidad_id for update;
  if not found or not rentas.es_admin_gestora(v_unidad.organization_id, v_unidad.property_id) then
    raise exception 'rentas.actualizar_unidad: unidad no encontrada.' using errcode = 'P0002';
  end if;
  if p_nombre is not null and (v_nombre is null or char_length(v_nombre) > 120) then
    raise exception 'rentas.actualizar_unidad: el nombre debe tener entre 1 y 120 caracteres.' using errcode = '22023';
  end if;
  if p_duracion_minima_noches is not null and (p_duracion_minima_noches < 1 or p_duracion_minima_noches > 365) then
    raise exception 'rentas.actualizar_unidad: la estancia minima debe estar entre 1 y 365 noches.' using errcode = '22023';
  end if;
  if p_owner_id is not null and not exists (
    select 1 from rentas.owner_organization oo where oo.owner_id = p_owner_id and oo.organization_id = v_unidad.organization_id
  ) then
    raise exception 'rentas.actualizar_unidad: el propietario no pertenece a esta organizacion.' using errcode = '22023';
  end if;
  if v_nombre is not null and exists (
    select 1 from rentas.unidad u where u.property_id = v_unidad.property_id and u.id <> v_unidad.id and u.name = v_nombre
  ) then
    raise exception 'rentas.actualizar_unidad: ya existe una unidad con ese nombre en esta propiedad.' using errcode = '23505';
  end if;

  update rentas.unidad
  set name = coalesce(v_nombre, name),
      owner_id = case when p_quitar_owner then null when p_owner_id is not null then p_owner_id else owner_id end,
      duracion_minima_noches = coalesce(p_duracion_minima_noches, duracion_minima_noches)
  where id = v_unidad.id;
  return v_unidad.id;
end;
$$;
revoke all on function rentas.actualizar_unidad(uuid, text, uuid, boolean, integer) from public, anon;
grant execute on function rentas.actualizar_unidad(uuid, text, uuid, boolean, integer) to authenticated;
