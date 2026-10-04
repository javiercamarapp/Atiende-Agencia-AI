-- R-15: perfil operativo del repartidor por organizacion + tipo de bitacora 'exportacion' (R-17).
-- Prefijo de supabase/migrations: 20240101000310 (interno restaurantes 044).
-- Requiere: 0001_core_schema.sql (core.membership, core.staff_user), 019_restaurantes_audit_log.sql (restaurantes.audit_log).
--
-- Que agrega (todo NUEVO salvo el CHECK de entity_type, que solo se AMPLIA):
--   * restaurantes.repartidor_perfil          -- datos OPERATIVOS: tipo de vehiculo, placas, disponibilidad y turno.
--   * restaurantes.repartidor_perfil_privado  -- datos PERSONALES: licencia (numero y vigencia) y contacto de emergencia.
--   * restaurantes.perfil_repartidor_acceso   -- helper de las policies de lectura.
--   * restaurantes.guardar_perfil_repartidor  -- UNICA escritura (definer): el propio repartidor o owner/admin.
--   * restaurantes.suprimir_perfil_repartidor -- derecho de cancelacion (ARCO): borra las dos filas; solo owner/admin.
--   * restaurantes.licencias_por_vencer_sistema -- barrido de sistema para avisar al owner (sin PII en el aviso).
--   * restaurantes.audit_log.entity_type admite 'exportacion' (R-17: quien exporto Historial/Clientes).
--
-- Por que DOS tablas: el staff de piso necesita ver vehiculo/placas/disponibilidad para despachar, pero NO la licencia ni el
-- contacto de emergencia. Los GRANT de columna no distinguen filas ni roles, asi que la separacion de lo sensible se hace por
-- TABLA con su propia policy de lectura (owner/admin y el propio repartidor); el staff de piso solo tiene policy sobre la operativa.
--
-- Retencion y ARCO (documentacion operativa, no asesoria legal):
--   * Retencion: ambas tablas llevan FK compuesta a core.membership (user_id, organization_id) ON DELETE CASCADE. Al dar de baja al
--     repartidor (se elimina su membresia) se borran su perfil operativo y su perfil personal; no hay purga por tiempo porque el dato
--     solo existe mientras la relacion operativa exista (minimizacion).
--   * ARCO acceso/rectificacion: el repartidor lee y corrige SU perfil (GET/PUT .../repartidor/perfil); owner/admin lee y corrige el de
--     cualquiera de su organizacion (GET/PUT .../admin/staff/:id/perfil-repartidor).
--   * ARCO cancelacion/supresion: suprimir_perfil_repartidor (owner/admin) borra ambas filas; la bitacora de auditoria solo conserva
--     QUE campos cambiaron, nunca los valores (sin PII).
--
-- Justificacion de seguridad (una por una):
--  * Ambas tablas: RLS activa; `revoke all ... from public, anon, authenticated`; SOLO `grant select` a authenticated (y service_role
--    por convencion del esquema). Sin GRANT ni policy de INSERT/UPDATE/DELETE: la escritura es exclusivamente guardar_/suprimir_
--    (definer), que validan al actor. Nada se otorga a anon. Un GRANT por columna no aplica: ninguna columna se escribe directo.
--  * Policy "lee el perfil operativo" (repartidor_perfil): el propio repartidor (auth.uid() = user_id y vertical_role = 'repartidor' en
--    esa organizacion) o owner/admin/staff de ESA organizacion. Cross-tenant: el helper compara contra core.membership de la
--    organizacion de la FILA, asi que un owner de otra organizacion no ve nada.
--  * Policy "lee el perfil personal" (repartidor_perfil_privado): el propio repartidor u owner/admin de la organizacion de la fila; el
--    staff de piso queda fuera (contacto de emergencia y licencia son datos personales de un tercero).
--  * restaurantes.perfil_repartidor_acceso: SECURITY DEFINER (lee core.membership, que el rol authenticated no puede leer), search_path
--    fijo (core, pg_temp), `revoke ... from public, anon`, grant a authenticated (las policies lo ejecutan con ese rol). Solo devuelve
--    un booleano sobre el propio auth.uid(); no filtra datos de terceros.
--  * restaurantes.guardar_perfil_repartidor: SECURITY DEFINER, search_path fijo, revoke de public/anon, grant a authenticated. Exige
--    auth.uid() no nulo. Autorizacion dentro de la funcion: (a) el propio repartidor sobre su propio perfil, o (b) owner/admin de la
--    organizacion sobre un miembro que sea repartidor ahi. Cualquier otro actor, organizacion ajena o usuario ajeno recibe 42501 (el
--    mismo error para "no existe" y "no es tuyo" de un tercero: sin oraculo). Un owner/admin sobre alguien que NO es repartidor recibe
--    P0002. Valida enums, longitudes, vigencia sensata y telefono de 10 digitos tambien en SQL (no depende del TypeScript).
--  * restaurantes.suprimir_perfil_repartidor: definer, search_path fijo, revoke de public/anon, grant a authenticated; solo owner/admin
--    de la organizacion (42501 para cualquier otro, incluido el propio repartidor: la supresion es una decision del responsable).
--  * restaurantes.licencias_por_vencer_sistema: definer, search_path fijo, revoke de public/anon, grant a authenticated (la sesion de
--    sistema del backend corre con ese rol sin usuario). Exige auth.uid() IS NULL: un usuario recibe 42501. Devuelve ids y dias, sin
--    nombre, telefono ni numero de licencia.
--  * audit_log.entity_type: solo se agrega un valor al CHECK; la tabla sigue append-only (triggers de 019) y sin GRANT de escritura.

-- ---------------------------------------------------------------------------
-- 1) Tablas
-- ---------------------------------------------------------------------------
create table restaurantes.repartidor_perfil (
  organization_id uuid not null,
  user_id uuid not null,
  vehiculo_tipo text check (vehiculo_tipo is null or vehiculo_tipo in ('moto', 'bicicleta', 'auto', 'a_pie', 'otro')),
  placas text check (placas is null or char_length(placas) between 1 and 15),
  disponibilidad text not null default 'disponible' check (disponibilidad in ('disponible', 'en_descanso', 'fuera_de_turno')),
  turno text check (turno is null or char_length(turno) between 1 and 120),
  updated_at timestamptz not null default now(),
  updated_by uuid references core.staff_user(id) on delete set null,
  primary key (organization_id, user_id),
  foreign key (user_id, organization_id) references core.membership (user_id, organization_id) on delete cascade
);

create table restaurantes.repartidor_perfil_privado (
  organization_id uuid not null,
  user_id uuid not null,
  licencia_numero text check (licencia_numero is null or char_length(licencia_numero) between 1 and 40),
  licencia_vigencia date,
  emergencia_nombre text check (emergencia_nombre is null or char_length(emergencia_nombre) between 1 and 100),
  emergencia_telefono text check (emergencia_telefono is null or emergencia_telefono ~ '^[0-9]{10}$'),
  updated_at timestamptz not null default now(),
  updated_by uuid references core.staff_user(id) on delete set null,
  primary key (organization_id, user_id),
  foreign key (user_id, organization_id) references core.membership (user_id, organization_id) on delete cascade,
  check ((licencia_numero is null) = (licencia_vigencia is null)),
  check ((emergencia_nombre is null) = (emergencia_telefono is null))
);
-- Barrido de licencias por vencer: solo filas con vigencia.
create index repartidor_perfil_privado_vigencia_idx on restaurantes.repartidor_perfil_privado (licencia_vigencia) where licencia_vigencia is not null;

-- ---------------------------------------------------------------------------
-- 2) Helper de lectura + policies
-- ---------------------------------------------------------------------------
-- p_nivel: 'privado' = el propio repartidor u owner/admin; 'operativo' = ademas el staff de piso.
create or replace function restaurantes.perfil_repartidor_acceso(p_organization_id uuid, p_user_id uuid, p_nivel text)
returns boolean
language sql
stable
security definer
set search_path = core, pg_temp
as $$
  select auth.uid() is not null and exists (
    select 1 from core.membership m
    where m.user_id = auth.uid()
      and m.organization_id = p_organization_id
      and (
        (m.user_id = p_user_id and m.vertical_role = 'repartidor')
        or m.vertical_role = any (case when p_nivel = 'privado' then array['owner', 'admin'] else array['owner', 'admin', 'staff'] end)
      )
  );
$$;
revoke all on function restaurantes.perfil_repartidor_acceso(uuid, uuid, text) from public, anon;
grant execute on function restaurantes.perfil_repartidor_acceso(uuid, uuid, text) to authenticated, service_role;

alter table restaurantes.repartidor_perfil enable row level security;
alter table restaurantes.repartidor_perfil_privado enable row level security;

create policy "lee el perfil operativo del repartidor" on restaurantes.repartidor_perfil for select
  using (restaurantes.perfil_repartidor_acceso(organization_id, user_id, 'operativo'));
create policy "lee el perfil personal del repartidor" on restaurantes.repartidor_perfil_privado for select
  using (restaurantes.perfil_repartidor_acceso(organization_id, user_id, 'privado'));

revoke all on restaurantes.repartidor_perfil, restaurantes.repartidor_perfil_privado from public, anon, authenticated;
grant select on restaurantes.repartidor_perfil, restaurantes.repartidor_perfil_privado to authenticated;
grant select on restaurantes.repartidor_perfil, restaurantes.repartidor_perfil_privado to service_role;

-- ---------------------------------------------------------------------------
-- 3) Escritura: guardar (reemplazo completo) y suprimir
-- ---------------------------------------------------------------------------
create or replace function restaurantes.guardar_perfil_repartidor(
  p_organization_id uuid,
  p_user_id uuid,
  p_vehiculo_tipo text,
  p_placas text,
  p_disponibilidad text,
  p_turno text,
  p_licencia_numero text,
  p_licencia_vigencia date,
  p_emergencia_nombre text,
  p_emergencia_telefono text
) returns void
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_rol_actor text;
  v_rol_objetivo text;
  v_placas text := nullif(btrim(p_placas), '');
  v_turno text := nullif(btrim(p_turno), '');
  v_lic text := nullif(btrim(p_licencia_numero), '');
  v_em_nombre text := nullif(btrim(p_emergencia_nombre), '');
  v_em_tel text := nullif(btrim(p_emergencia_telefono), '');
begin
  if v_actor is null then
    raise exception 'guardar_perfil_repartidor: requiere un usuario autenticado' using errcode = '42501';
  end if;
  select m.vertical_role into v_rol_actor from core.membership m where m.user_id = v_actor and m.organization_id = p_organization_id;
  if v_rol_actor is null then
    raise exception 'guardar_perfil_repartidor: sin acceso' using errcode = '42501';
  end if;
  if v_actor = p_user_id then
    if v_rol_actor <> 'repartidor' then
      raise exception 'guardar_perfil_repartidor: el perfil solo existe para repartidores' using errcode = 'P0002';
    end if;
  elsif v_rol_actor in ('owner', 'admin') then
    select m.vertical_role into v_rol_objetivo from core.membership m where m.user_id = p_user_id and m.organization_id = p_organization_id;
    if v_rol_objetivo is distinct from 'repartidor' then
      raise exception 'guardar_perfil_repartidor: el miembro no es repartidor de esta organizacion' using errcode = 'P0002';
    end if;
  else
    raise exception 'guardar_perfil_repartidor: sin acceso' using errcode = '42501';
  end if;

  if p_vehiculo_tipo is not null and p_vehiculo_tipo not in ('moto', 'bicicleta', 'auto', 'a_pie', 'otro') then
    raise exception 'guardar_perfil_repartidor: tipo de vehiculo desconocido' using errcode = '22023';
  end if;
  if p_disponibilidad not in ('disponible', 'en_descanso', 'fuera_de_turno') then
    raise exception 'guardar_perfil_repartidor: disponibilidad desconocida' using errcode = '22023';
  end if;
  if v_placas is not null and char_length(v_placas) > 15 then
    raise exception 'guardar_perfil_repartidor: placas demasiado largas' using errcode = '22023';
  end if;
  if v_turno is not null and char_length(v_turno) > 120 then
    raise exception 'guardar_perfil_repartidor: turno demasiado largo' using errcode = '22023';
  end if;
  if (v_lic is null) <> (p_licencia_vigencia is null) then
    raise exception 'guardar_perfil_repartidor: la licencia lleva numero y vigencia juntos' using errcode = '22023';
  end if;
  if v_lic is not null and char_length(v_lic) > 40 then
    raise exception 'guardar_perfil_repartidor: numero de licencia demasiado largo' using errcode = '22023';
  end if;
  if p_licencia_vigencia is not null and (p_licencia_vigencia < date '2000-01-01' or p_licencia_vigencia > date '2100-01-01') then
    raise exception 'guardar_perfil_repartidor: vigencia fuera de rango' using errcode = '22023';
  end if;
  if (v_em_nombre is null) <> (v_em_tel is null) then
    raise exception 'guardar_perfil_repartidor: el contacto de emergencia lleva nombre y telefono juntos' using errcode = '22023';
  end if;
  if v_em_nombre is not null and char_length(v_em_nombre) > 100 then
    raise exception 'guardar_perfil_repartidor: nombre de contacto demasiado largo' using errcode = '22023';
  end if;
  if v_em_tel is not null and v_em_tel !~ '^[0-9]{10}$' then
    raise exception 'guardar_perfil_repartidor: telefono de emergencia de 10 digitos' using errcode = '22023';
  end if;

  insert into restaurantes.repartidor_perfil (organization_id, user_id, vehiculo_tipo, placas, disponibilidad, turno, updated_at, updated_by)
  values (p_organization_id, p_user_id, p_vehiculo_tipo, v_placas, p_disponibilidad, v_turno, now(), v_actor)
  on conflict (organization_id, user_id) do update
    set vehiculo_tipo = excluded.vehiculo_tipo, placas = excluded.placas, disponibilidad = excluded.disponibilidad,
        turno = excluded.turno, updated_at = now(), updated_by = v_actor;

  insert into restaurantes.repartidor_perfil_privado (organization_id, user_id, licencia_numero, licencia_vigencia, emergencia_nombre, emergencia_telefono, updated_at, updated_by)
  values (p_organization_id, p_user_id, v_lic, p_licencia_vigencia, v_em_nombre, v_em_tel, now(), v_actor)
  on conflict (organization_id, user_id) do update
    set licencia_numero = excluded.licencia_numero, licencia_vigencia = excluded.licencia_vigencia,
        emergencia_nombre = excluded.emergencia_nombre, emergencia_telefono = excluded.emergencia_telefono,
        updated_at = now(), updated_by = v_actor;
end;
$$;
revoke all on function restaurantes.guardar_perfil_repartidor(uuid, uuid, text, text, text, text, text, date, text, text) from public, anon;
grant execute on function restaurantes.guardar_perfil_repartidor(uuid, uuid, text, text, text, text, text, date, text, text) to authenticated;

create or replace function restaurantes.suprimir_perfil_repartidor(p_organization_id uuid, p_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_borrados integer := 0;
  v_n integer;
begin
  if v_actor is null or not exists (
    select 1 from core.membership m where m.user_id = v_actor and m.organization_id = p_organization_id and m.vertical_role in ('owner', 'admin')
  ) then
    raise exception 'suprimir_perfil_repartidor: sin acceso' using errcode = '42501';
  end if;
  delete from restaurantes.repartidor_perfil where organization_id = p_organization_id and user_id = p_user_id;
  get diagnostics v_n = row_count;
  v_borrados := v_borrados + v_n;
  delete from restaurantes.repartidor_perfil_privado where organization_id = p_organization_id and user_id = p_user_id;
  get diagnostics v_n = row_count;
  v_borrados := v_borrados + v_n;
  return v_borrados > 0;
end;
$$;
revoke all on function restaurantes.suprimir_perfil_repartidor(uuid, uuid) from public, anon;
grant execute on function restaurantes.suprimir_perfil_repartidor(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 4) Barrido de sistema: licencias vencidas o por vencer
-- ---------------------------------------------------------------------------
create or replace function restaurantes.licencias_por_vencer_sistema(p_dias integer default 30)
returns table (organization_id uuid, user_id uuid, dias_restantes integer)
language plpgsql
stable
security definer
set search_path = restaurantes, core, pg_temp
as $$
begin
  if auth.uid() is not null then
    raise exception 'licencias_por_vencer_sistema es solo para la sesion de sistema' using errcode = '42501';
  end if;
  return query
    select p.organization_id, p.user_id, (p.licencia_vigencia - current_date)::integer
      from restaurantes.repartidor_perfil_privado p
     where p.licencia_vigencia is not null
       and p.licencia_vigencia <= current_date + least(greatest(coalesce(p_dias, 30), 1), 90)
     order by p.licencia_vigencia, p.organization_id, p.user_id
     limit 1000;
end;
$$;
revoke all on function restaurantes.licencias_por_vencer_sistema(integer) from public, anon;
grant execute on function restaurantes.licencias_por_vencer_sistema(integer) to authenticated;

-- ---------------------------------------------------------------------------
-- 5) Bitacora: tipo 'exportacion' (R-17)
-- ---------------------------------------------------------------------------
alter table restaurantes.audit_log drop constraint if exists audit_log_entity_type_check;
alter table restaurantes.audit_log add constraint audit_log_entity_type_check
  check (entity_type in ('producto', 'promocion', 'pedido', 'repartidor', 'staff', 'configuracion', 'exportacion'));
