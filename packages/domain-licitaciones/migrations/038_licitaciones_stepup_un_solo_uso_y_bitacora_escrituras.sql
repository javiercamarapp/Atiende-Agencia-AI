-- 038: (a) step-up de UN SOLO USO y (b) bitacora append-only de escrituras de licitaciones con antes/despues y correlacion.
-- Requiere: 002 (licitaciones.can_access_org/can_write_org), 0026 (core.staff_totp: el step-up nace de un segundo factor), core.membership.
--
-- Problema (L-P3-12, R5-09 del suelto): el token de step-up era un JWT sin estado: con UN codigo TOTP se podian aprobar varias
-- cosas, o repetir una peticion capturada, durante los 5 minutos de vida del token. Y las escrituras de datos de empresa, tarifas,
-- configuracion y staff no dejaban rastro de quien cambio que (solo `tender_audit_log` registraba alta/version de convocatoria).
--
-- Que agrega:
--   1. `core.step_up_consumption`: un renglon por token consumido (llave = `jti`). Sin GRANT para ningun rol de aplicacion y con RLS
--      habilitado: la unica puerta es (2).
--   2. `core.consume_step_up(...)`: SECURITY DEFINER, search_path fijo, REVOKE de public/anon. Exige `auth.uid() = p_user_id`
--      y membresia del llamador en la organizacion. `insert ... on conflict do nothing`: devuelve true la primera vez y false al
--      reusar. Corre en la MISMA transaccion de la accion (si la accion falla y se revierte, el token NO se gasta); dos peticiones
--      concurrentes con el mismo `jti` se serializan sobre la llave primaria: exactamente una obtiene true.
--   3. `core.purge_step_up_consumption(...)`: SOLO SISTEMA (`auth.uid() is null`), borra consumos de tokens ya vencidos (con una hora
--      de holgura); la llama el barrido de mantenimiento existente, sin cron nuevo.
--   4. `licitaciones.audit_trail`: bitacora de escrituras (entidad, accion, antes, despues, actor, `correlation_id`). Solo adicion:
--      `authenticated` solo tiene SELECT; no hay GRANT de INSERT/UPDATE/DELETE para ningun rol de aplicacion (incluido service_role).
--   5. `licitaciones.append_audit(...)`: SECURITY DEFINER, search_path fijo, REVOKE de public/anon. Staff: `auth.uid() = p_caller_id` y
--      rol de escritura en la organizacion. Sistema (ingesta automatica): `auth.uid() is null` y `p_caller_id` nulo. Valida el formato del
--      `correlation_id` y acota el tamano de antes/despues.
--   6. `licitaciones.is_org_admin(...)`: ayuda para la policy de lectura (owner/admin).
--   7. `licitaciones.tender_correlation_id(...)`: devuelve el `correlation_id` con que nacio una convocatoria (su primer renglon de bitacora
--      con correlacion) para que las aprobaciones y el manifiesto lo HEREDEN aunque quien actua (analyst/writer) no pueda leer la bitacora.
--      SECURITY DEFINER de solo lectura: devuelve unicamente ese identificador opaco, nunca antes/despues; exige membresia en la organizacion.
--
-- Justificacion de cada GRANT/policy/funcion:
--   * Sin GRANT sobre `core.step_up_consumption`: un cliente no debe poder leer ni borrar consumos (borrarlos reabriria el reuso).
--   * GRANT execute de `consume_step_up` a authenticated: valida identidad y membresia por si misma; nada para anon.
--   * GRANT execute de `purge_step_up_consumption` a authenticated: el guard `auth.uid() is null` la limita a la sesion de sistema
--     (mismo patron que las funciones de solo-sistema de 0016/0026); una sesion con usuario recibe 42501.
--   * GRANT select a authenticated sobre `audit_trail` + policy `is_org_admin`: la pantalla de bitacora es para owner/admin de la
--     propia organizacion; no hay `using (true)`; nada para anon.
--   * GRANT execute de `append_audit` a authenticated: unica via de escritura; ver (5).
--   * GRANT execute de `tender_correlation_id` a authenticated: valida membresia por si misma (sesion de sistema permitida: auth.uid() nulo).
--
-- Sin PII extra: antes/despues los arma la API con una lista cerrada de campos de la entidad (nunca tokens ni secretos).
--
-- Compatibilidad con la base sin migrar: el codigo TypeScript detecta 42883/42P01 dentro de un SAVEPOINT y sigue con el comportamiento
-- anterior (step-up sin estado y escrituras sin renglon de bitacora). ORDEN DE DESPLIEGUE: primero el codigo, despues esta migracion.

create table core.step_up_consumption (
  jti text primary key check (char_length(jti) between 8 and 64),
  user_id uuid not null references core.staff_user(id) on delete cascade,
  organization_id uuid not null references core.organization(id) on delete cascade,
  scope text not null check (char_length(scope) between 1 and 64),
  expires_at timestamptz not null,
  consumed_at timestamptz not null default now()
);
create index step_up_consumption_expires_idx on core.step_up_consumption (expires_at);

alter table core.step_up_consumption enable row level security;
revoke all on core.step_up_consumption from public, anon, authenticated;

create or replace function core.consume_step_up(
  p_jti text,
  p_user_id uuid,
  p_organization_id uuid,
  p_scope text,
  p_expires_at timestamptz
) returns boolean
language plpgsql security definer set search_path = pg_catalog, core as $$
declare
  v_rows integer;
begin
  if auth.uid() is null or auth.uid() is distinct from p_user_id then
    raise exception 'consume_step_up: solo la propia cuenta' using errcode = '42501';
  end if;
  if not exists (select 1 from core.membership m where m.user_id = p_user_id and m.organization_id = p_organization_id) then
    raise exception 'consume_step_up: sin membresia en la organizacion' using errcode = '42501';
  end if;
  insert into core.step_up_consumption (jti, user_id, organization_id, scope, expires_at)
  values (p_jti, p_user_id, p_organization_id, p_scope, p_expires_at)
  on conflict (jti) do nothing;
  get diagnostics v_rows = row_count;
  return v_rows = 1;
end;
$$;
revoke all on function core.consume_step_up(text, uuid, uuid, text, timestamptz) from public, anon;
grant execute on function core.consume_step_up(text, uuid, uuid, text, timestamptz) to authenticated;

create or replace function core.purge_step_up_consumption(p_grace interval default interval '1 hour')
returns integer
language plpgsql security definer set search_path = pg_catalog, core as $$
declare
  v_rows integer;
begin
  if auth.uid() is not null then
    raise exception 'purge_step_up_consumption: solo sistema' using errcode = '42501';
  end if;
  if p_grace < interval '5 minutes' then
    raise exception 'purge_step_up_consumption: holgura minima 5 minutos' using errcode = '22023';
  end if;
  delete from core.step_up_consumption where expires_at < now() - p_grace;
  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;
revoke all on function core.purge_step_up_consumption(interval) from public, anon;
grant execute on function core.purge_step_up_consumption(interval) to authenticated;

-- ---------------------------------------------------------------------------
-- Bitacora de escrituras (solo adicion)
-- ---------------------------------------------------------------------------

create or replace function licitaciones.is_org_admin(_organization_id uuid)
returns boolean language sql stable security definer set search_path = pg_catalog, core as $$
  select exists (
    select 1 from core.membership m
    where m.organization_id = _organization_id and m.user_id = auth.uid()
      and m.vertical_role in ('owner', 'admin')
  )
$$;
revoke all on function licitaciones.is_org_admin(uuid) from public, anon;
grant execute on function licitaciones.is_org_admin(uuid) to authenticated;

create table licitaciones.audit_trail (
  id uuid primary key default gen_random_uuid(),
  seq bigint generated always as identity,
  organization_id uuid not null references core.organization(id) on delete cascade,
  entity text not null check (char_length(entity) between 1 and 64),
  entity_id text check (entity_id is null or char_length(entity_id) <= 128),
  action text not null check (char_length(action) between 1 and 64),
  before jsonb,
  after jsonb,
  -- Nulo = sesion de sistema (ingesta automatica). Sin FK a proposito: la tabla es de solo adicion y un borrado de usuario
  -- no debe ni tocar ni bloquear la bitacora.
  actor_id uuid,
  correlation_id text check (correlation_id is null or correlation_id ~ '^[A-Za-z0-9._:-]{1,64}$'),
  created_at timestamptz not null default now()
);
create index audit_trail_org_seq_idx on licitaciones.audit_trail (organization_id, seq desc);
create index audit_trail_entity_idx on licitaciones.audit_trail (organization_id, entity, entity_id, seq desc);
create index audit_trail_correlation_idx on licitaciones.audit_trail (organization_id, correlation_id, seq) where correlation_id is not null;

alter table licitaciones.audit_trail enable row level security;
create policy "owner o admin ve la bitacora de escrituras" on licitaciones.audit_trail for select using (licitaciones.is_org_admin(organization_id));

revoke all on licitaciones.audit_trail from public, anon, authenticated, service_role;
grant select on licitaciones.audit_trail to authenticated;

create or replace function licitaciones.append_audit(
  p_caller_id uuid,
  p_organization_id uuid,
  p_entity text,
  p_entity_id text,
  p_action text,
  p_before jsonb,
  p_after jsonb,
  p_correlation_id text
) returns uuid
language plpgsql security definer set search_path = pg_catalog, licitaciones, core as $$
declare
  v_id uuid;
begin
  if auth.uid() is null then
    -- Sesion de sistema (ingesta automatica): sin actor.
    if p_caller_id is not null then
      raise exception 'append_audit: la sesion de sistema no puede declarar actor' using errcode = '42501';
    end if;
  else
    if auth.uid() is distinct from p_caller_id then
      raise exception 'append_audit: el actor debe ser quien llama' using errcode = '42501';
    end if;
    if not licitaciones.can_write_org(p_organization_id) then
      raise exception 'append_audit: sin rol de escritura en la organizacion' using errcode = '42501';
    end if;
  end if;
  if coalesce(pg_column_size(p_before), 0) + coalesce(pg_column_size(p_after), 0) > 65536 then
    raise exception 'append_audit: antes/despues exceden 64 KB' using errcode = '22023';
  end if;
  insert into licitaciones.audit_trail (organization_id, entity, entity_id, action, before, after, actor_id, correlation_id)
  values (p_organization_id, p_entity, p_entity_id, p_action, p_before, p_after, p_caller_id, p_correlation_id)
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function licitaciones.append_audit(uuid, uuid, text, text, text, jsonb, jsonb, text) from public, anon;
grant execute on function licitaciones.append_audit(uuid, uuid, text, text, text, jsonb, jsonb, text) to authenticated;

create or replace function licitaciones.tender_correlation_id(p_organization_id uuid, p_tender_id text)
returns text
language plpgsql stable security definer set search_path = pg_catalog, licitaciones, core as $$
declare
  v_corr text;
begin
  if auth.uid() is not null and not licitaciones.can_access_org(p_organization_id) then
    raise exception 'tender_correlation_id: sin membresia en la organizacion' using errcode = '42501';
  end if;
  select a.correlation_id into v_corr
    from licitaciones.audit_trail a
   where a.organization_id = p_organization_id and a.entity = 'convocatoria' and a.entity_id = p_tender_id and a.correlation_id is not null
   order by a.seq asc limit 1;
  return v_corr;
end;
$$;
revoke all on function licitaciones.tender_correlation_id(uuid, text) from public, anon;
grant execute on function licitaciones.tender_correlation_id(uuid, text) to authenticated;
