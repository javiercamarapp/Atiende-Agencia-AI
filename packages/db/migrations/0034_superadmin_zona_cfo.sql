-- Superadmin "CFO" -- SA-41 (zona CFO segura): rol `finanzas` de solo lectura, bitacora de CADA
-- consulta financiera (quien, que, cuando, filtros) y exportaciones atribuibles. La MFA/step-up
-- (0025) ya existe; esta migracion aporta el rol y la bitacora, y endurece el guard comun de
-- escritura para que un rol restringido no pueda mutar nada aunque llegue a una funcion SQL.
--
--   A) core.cfo_zone_role         -- un superadmin con fila aqui queda RESTRINGIDO a `finanzas`
--                                    (solo lectura de las pantallas financieras).
--   B) core.cfo_access_log        -- bitacora append-only de consultas, exportaciones, denegaciones
--                                    y cambios de rol de la zona CFO.
--   C) Funciones: resolver rol, registrar acceso, asignar/retirar rol, listar bitacora y roles.
--   D) core.superadmin_require_caller (0025) redefinido: ademas de caller-binding + superadmin,
--      rechaza (42501) a un superadmin restringido a `finanzas`. Es el guard de TODAS las
--      funciones de ESCRITURA de superadmin creadas desde 0025 (MFA reset, interruptores,
--      organizaciones, tipo de cambio, planes, infra del P&L...).
--
-- Requiere: 0010 (core.platform_superadmin), 0012 (core.is_platform_superadmin) y 0025
-- (core.superadmin_require_caller).
--
-- Alcance honesto del rol: las funciones de escritura anteriores a 0025 (prospectos 0012,
-- impersonacion 0020, break-glass) validan `core.is_platform_superadmin` directamente y NO pasan
-- por superadmin_require_caller; para esas el corte a un rol `finanzas` lo hace la capa de la API
-- (lista blanca de solo lectura en apps/api/src/superadmin-seguridad/zona-cfo.ts).
--
-- Justificacion de seguridad (cada GRANT/policy/funcion trae su razon):
--   * core.cfo_zone_role y core.cfo_access_log: RLS habilitado SIN policy y REVOKE ALL a public,
--     anon y authenticated. Razon: son datos de control de acceso y de auditoria; ningun rol de
--     la aplicacion los lee ni escribe directo, solo las funciones definer de abajo. Sin GRANT por
--     columna porque no hay ninguna columna accesible por rol alguno (las funciones corren como el
--     dueño y validan cada valor antes de escribir).
--   * core.cfo_access_log es append-only: un trigger rechaza UPDATE y DELETE (0A000) incluso para
--     el dueño. No tiene llaves foraneas (una FK con ON DELETE SET NULL haria un UPDATE y el
--     trigger bloquearia el borrado de la cuenta): actor_user_id es un uuid plano.
--   * core.cfo_zone_resolve_role: security definer, search_path fijo; exige auth.uid() =
--     p_caller_id (si no, devuelve NULL: nunca confirma el rol de otra cuenta). GRANT a
--     authenticated, no a anon: el API la llama con la sesion del usuario para decidir el corte.
--   * core.cfo_zone_log_access: security definer; exige auth.uid() = p_caller_id y que el caller
--     tenga rol resuelto (superadmin o finanzas), si no 42501. Razon: una cuenta cualquiera
--     autenticada no puede inflar la bitacora. Solo acepta consulta/exportacion/denegado: los
--     eventos de rol solo los escribe cfo_zone_set_role. Acota el tamaño de `filtros` (2000
--     caracteres) para que no sea un canal de relleno. GRANT a authenticated, no a anon.
--   * core.cfo_zone_set_role: security definer; usa core.superadmin_require_caller (un restringido
--     no puede cambiar roles, ni el suyo); el destino debe ser superadmin y distinto del caller
--     (nadie se asigna ni se quita el rol a si mismo); motivo >= 20 caracteres; queda en la
--     bitacora. La ruta del API exige step-up. GRANT a authenticated, no a anon.
--   * core.list_cfo_access_log_for_superadmin y core.list_cfo_zone_roles_for_superadmin: lectura
--     con el contrato de cero filas (auth.uid() = p_caller_id, superadmin NO restringido). Un rol
--     `finanzas` no puede leer quien consulto que. GRANT a authenticated, no a anon.

-- ═══════════════════════════════════════════════════════════════════════════
-- A) Rol restringido
-- ═══════════════════════════════════════════════════════════════════════════
create table core.cfo_zone_role (
  staff_user_id uuid primary key references core.platform_superadmin(staff_user_id) on delete cascade,
  rol text not null check (rol in ('finanzas')),
  assigned_by uuid,
  reason text not null check (char_length(btrim(reason)) >= 20),
  created_at timestamptz not null default now()
);
alter table core.cfo_zone_role enable row level security;
revoke all on core.cfo_zone_role from public, anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- B) Bitacora append-only
-- ═══════════════════════════════════════════════════════════════════════════
create table core.cfo_access_log (
  id uuid primary key default gen_random_uuid(),
  seq bigint generated always as identity,
  actor_user_id uuid not null,
  actor_rol text not null check (actor_rol in ('superadmin', 'finanzas')),
  accion text not null check (accion in ('consulta', 'exportacion', 'denegado', 'rol_asignado', 'rol_retirado')),
  recurso text not null check (char_length(recurso) between 1 and 160),
  filtros jsonb not null default '{}'::jsonb check (jsonb_typeof(filtros) = 'object' and char_length(filtros::text) <= 2000),
  occurred_at timestamptz not null default now()
);
create unique index cfo_access_log_seq_uidx on core.cfo_access_log (seq);
create index cfo_access_log_actor_idx on core.cfo_access_log (actor_user_id, seq desc);

create or replace function core.cfo_access_log_block_mutation()
returns trigger language plpgsql set search_path = core, pg_temp as $$
begin
  raise exception 'cfo_access_log_append_only: % no esta permitido sobre %', tg_op, tg_table_name using errcode = '0A000';
end;
$$;
create trigger cfo_access_log_block_update_trg before update on core.cfo_access_log
  for each row execute function core.cfo_access_log_block_mutation();
create trigger cfo_access_log_block_delete_trg before delete on core.cfo_access_log
  for each row execute function core.cfo_access_log_block_mutation();
alter table core.cfo_access_log enable row level security;
revoke all on core.cfo_access_log from public, anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- D) Guard comun de escritura (redefinido): un superadmin restringido a `finanzas` no escribe
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function core.superadmin_require_caller(p_caller_id uuid, p_fn text)
returns void language plpgsql stable security definer set search_path = core, pg_temp as $$
begin
  if auth.uid() is null or auth.uid() <> p_caller_id then
    raise exception '%: caller binding invalido (auth.uid() no coincide con p_caller_id)', p_fn using errcode = '42501';
  end if;
  if not core.is_platform_superadmin(p_caller_id) then
    raise exception '%: solo un superadmin de plataforma real puede ejecutar esta accion', p_fn using errcode = '42501';
  end if;
  if exists (select 1 from core.cfo_zone_role r where r.staff_user_id = p_caller_id) then
    raise exception '%: un superadmin con rol restringido (finanzas) es de solo lectura', p_fn using errcode = '42501';
  end if;
end;
$$;
revoke all on function core.superadmin_require_caller(uuid, text) from public, anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- C) Funciones
-- ═══════════════════════════════════════════════════════════════════════════
-- Rol efectivo de quien llama: 'finanzas' (restringido), 'superadmin' o NULL.
create or replace function core.cfo_zone_resolve_role(p_caller_id uuid)
returns text language plpgsql stable security definer set search_path = core, pg_temp as $$
begin
  if auth.uid() is null or auth.uid() <> p_caller_id or not core.is_platform_superadmin(p_caller_id) then
    return null;
  end if;
  if exists (select 1 from core.cfo_zone_role r where r.staff_user_id = p_caller_id and r.rol = 'finanzas') then
    return 'finanzas';
  end if;
  return 'superadmin';
end;
$$;
revoke all on function core.cfo_zone_resolve_role(uuid) from public, anon;
grant execute on function core.cfo_zone_resolve_role(uuid) to authenticated;

-- Registra UN acceso (consulta, exportacion o denegacion). Devuelve su seq.
create or replace function core.cfo_zone_log_access(p_caller_id uuid, p_accion text, p_recurso text, p_filtros jsonb default '{}'::jsonb)
returns bigint language plpgsql security definer set search_path = core, pg_temp as $$
declare
  v_rol text;
  v_recurso text := btrim(coalesce(p_recurso, ''));
  v_filtros jsonb := coalesce(p_filtros, '{}'::jsonb);
  v_seq bigint;
begin
  v_rol := core.cfo_zone_resolve_role(p_caller_id);
  if v_rol is null then
    raise exception 'cfo_zone_log_access: caller binding invalido o sin rol en la zona CFO' using errcode = '42501';
  end if;
  if p_accion is null or p_accion not in ('consulta', 'exportacion', 'denegado') then
    raise exception 'cfo_zone_log_access: accion invalida' using errcode = '22023';
  end if;
  if char_length(v_recurso) < 1 or char_length(v_recurso) > 160 then
    raise exception 'cfo_zone_log_access: recurso obligatorio (1-160 caracteres)' using errcode = '22023';
  end if;
  if jsonb_typeof(v_filtros) <> 'object' or char_length(v_filtros::text) > 2000 then
    raise exception 'cfo_zone_log_access: filtros debe ser un objeto de maximo 2000 caracteres' using errcode = '22023';
  end if;
  insert into core.cfo_access_log (actor_user_id, actor_rol, accion, recurso, filtros)
  values (p_caller_id, v_rol, p_accion, v_recurso, v_filtros)
  returning seq into v_seq;
  return v_seq;
end;
$$;
revoke all on function core.cfo_zone_log_access(uuid, text, text, jsonb) from public, anon;
grant execute on function core.cfo_zone_log_access(uuid, text, text, jsonb) to authenticated;

-- Asigna (p_rol = 'finanzas') o retira (p_rol null) el rol restringido de OTRO superadmin.
create or replace function core.cfo_zone_set_role(p_caller_id uuid, p_target_user_id uuid, p_rol text, p_reason text)
returns void language plpgsql security definer set search_path = core, pg_temp as $$
declare
  v_reason text := btrim(coalesce(p_reason, ''));
begin
  perform core.superadmin_require_caller(p_caller_id, 'cfo_zone_set_role');
  if p_target_user_id is null or p_target_user_id = p_caller_id then
    raise exception 'cfo_zone_set_role: nadie se asigna ni se quita el rol a si mismo' using errcode = '22023';
  end if;
  if p_rol is not null and p_rol <> 'finanzas' then
    raise exception 'cfo_zone_set_role: rol invalido' using errcode = '22023';
  end if;
  if char_length(v_reason) < 20 or char_length(v_reason) > 500 then
    raise exception 'cfo_zone_set_role: motivo obligatorio (20-500 caracteres)' using errcode = '22023';
  end if;
  if not exists (select 1 from core.platform_superadmin ps where ps.staff_user_id = p_target_user_id) then
    raise exception 'cfo_zone_set_role: el destino no es superadmin de plataforma' using errcode = '22023';
  end if;
  if p_rol is null then
    delete from core.cfo_zone_role where staff_user_id = p_target_user_id;
  else
    insert into core.cfo_zone_role (staff_user_id, rol, assigned_by, reason)
    values (p_target_user_id, p_rol, p_caller_id, v_reason)
    on conflict (staff_user_id) do update set rol = excluded.rol, assigned_by = excluded.assigned_by, reason = excluded.reason, created_at = now();
  end if;
  insert into core.cfo_access_log (actor_user_id, actor_rol, accion, recurso, filtros)
  values (p_caller_id, 'superadmin', case when p_rol is null then 'rol_retirado' else 'rol_asignado' end, 'zona-cfo/roles',
          jsonb_build_object('destino', p_target_user_id, 'rol', coalesce(p_rol, 'finanzas'), 'motivo', left(v_reason, 200)));
end;
$$;
revoke all on function core.cfo_zone_set_role(uuid, uuid, text, text) from public, anon;
grant execute on function core.cfo_zone_set_role(uuid, uuid, text, text) to authenticated;

create or replace function core.list_cfo_access_log_for_superadmin(p_caller_id uuid, p_limit int default 100, p_before_seq bigint default null)
returns table (seq bigint, actor_user_id uuid, actor_rol text, accion text, recurso text, filtros jsonb, occurred_at timestamptz)
language plpgsql stable security definer set search_path = core, pg_temp as $$
begin
  if core.cfo_zone_resolve_role(p_caller_id) is distinct from 'superadmin' then
    return;
  end if;
  return query
    select l.seq, l.actor_user_id, l.actor_rol, l.accion, l.recurso, l.filtros, l.occurred_at
    from core.cfo_access_log l
    where p_before_seq is null or l.seq < p_before_seq
    order by l.seq desc
    limit greatest(1, least(coalesce(p_limit, 100), 500));
end;
$$;
revoke all on function core.list_cfo_access_log_for_superadmin(uuid, int, bigint) from public, anon;
grant execute on function core.list_cfo_access_log_for_superadmin(uuid, int, bigint) to authenticated;

create or replace function core.list_cfo_zone_roles_for_superadmin(p_caller_id uuid)
returns table (staff_user_id uuid, email text, rol text, assigned_by uuid, reason text, created_at timestamptz)
language plpgsql stable security definer set search_path = core, pg_temp as $$
begin
  if core.cfo_zone_resolve_role(p_caller_id) is distinct from 'superadmin' then
    return;
  end if;
  return query
    select r.staff_user_id, u.email::text, r.rol, r.assigned_by, r.reason, r.created_at
    from core.cfo_zone_role r
    join core.staff_user u on u.id = r.staff_user_id
    order by r.created_at desc
    limit 200;
end;
$$;
revoke all on function core.list_cfo_zone_roles_for_superadmin(uuid) from public, anon;
grant execute on function core.list_cfo_zone_roles_for_superadmin(uuid) to authenticated;
