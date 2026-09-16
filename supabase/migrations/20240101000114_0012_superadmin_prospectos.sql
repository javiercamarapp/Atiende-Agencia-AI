-- "Cerebro de ventas" — pedido real de Javier ("como Likida, donde pongamos los
-- clientes a los que podemos venderle esto según el tipo de solución"). Mismo
-- concepto que `prospecto` en el panel interno de Likida (referencia de solo
-- lectura, `~/likida.ai/src/app/admin/`) -- adaptado: ahí el prospecto es
-- SIEMPRE una flota (un solo producto); aquí un prospecto es un negocio al que
-- se le puede vender CUALQUIERA de las 6 verticales, así que `vertical` es una
-- columna real del prospecto, no una decisión de qué tabla usar.
--
-- Mismo criterio de acceso que el resto del back office de plataforma
-- (`0010_platform_superadmin.sql`): sin GRANT directo, sin policy de RLS
-- basada en `auth.uid()` (el superadmin no es "dueño" de ningún prospecto por
-- fila) -- acceso exclusivamente vía funciones `security definer` que validan
-- `core.is_platform_superadmin(p_caller_id)` DENTRO de la función, nunca solo
-- en la capa TS (mismo hallazgo crítico de `0011_login_lookup_security_
-- definer.sql`: una policy de RLS mal pensada para este caso de uso bloquea
-- todo, o un GRANT directo sin validación adentro es un hueco real).

create table core.prospecto (
  id uuid primary key default gen_random_uuid(),
  empresa text not null,
  vertical text not null check (vertical = any (array['hoteles','restaurantes','rentas','licitaciones','citas','despachos'])),
  ciudad text,
  contacto_nombre text,
  telefono text,
  correo text,
  -- Embudo real: mismos 5 estados de avance + 3 estados terminales que ya usa
  -- Likida en su propio prospecto.estado (referencia de solo lectura) --
  -- vocabulario de ventas probado, no inventado.
  estado text not null default 'nuevo' check (
    estado = any (array['nuevo','contactado','demo','propuesta','negociacion','ganado','perdido','descartado'])
  ),
  fuente text,
  notas text,
  creado_por uuid references core.staff_user(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index prospecto_vertical_idx on core.prospecto (vertical);
create index prospecto_estado_idx on core.prospecto (estado);

alter table core.prospecto enable row level security;
revoke all on core.prospecto from public, anon, authenticated;

create or replace function core.list_prospectos_for_superadmin(p_caller_id uuid)
returns setof core.prospecto
language sql stable security definer set search_path = core, pg_temp
as $$
  select p.* from core.prospecto p
  where core.is_platform_superadmin(p_caller_id)
  order by p.updated_at desc;
$$;

revoke all on function core.list_prospectos_for_superadmin(uuid) from public;
grant execute on function core.list_prospectos_for_superadmin(uuid) to authenticated;

create or replace function core.create_prospecto_for_superadmin(
  p_caller_id uuid,
  p_empresa text,
  p_vertical text,
  p_ciudad text,
  p_contacto_nombre text,
  p_telefono text,
  p_correo text,
  p_fuente text,
  p_notas text
)
returns core.prospecto
language plpgsql security definer set search_path = core, pg_temp
as $$
declare
  v_row core.prospecto;
begin
  if not core.is_platform_superadmin(p_caller_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  insert into core.prospecto (empresa, vertical, ciudad, contacto_nombre, telefono, correo, fuente, notas, creado_por)
  values (p_empresa, p_vertical, p_ciudad, p_contacto_nombre, p_telefono, p_correo, p_fuente, p_notas, p_caller_id)
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function core.create_prospecto_for_superadmin(uuid, text, text, text, text, text, text, text, text) from public;
grant execute on function core.create_prospecto_for_superadmin(uuid, text, text, text, text, text, text, text, text) to authenticated;

-- `update_prospecto_for_superadmin`: cambia estado y/o notas de un prospecto
-- ya existente (mover en el embudo es la acción real del día a día). Los
-- demás campos (empresa/vertical/contacto) se editan por separado si hace
-- falta en un pase futuro -- esta función cubre el caso de uso real de HOY.
create or replace function core.update_prospecto_for_superadmin(
  p_caller_id uuid,
  p_prospecto_id uuid,
  p_estado text,
  p_notas text
)
returns core.prospecto
language plpgsql security definer set search_path = core, pg_temp
as $$
declare
  v_row core.prospecto;
begin
  if not core.is_platform_superadmin(p_caller_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  update core.prospecto
  set estado = coalesce(p_estado, estado),
      notas = coalesce(p_notas, notas),
      updated_at = now()
  where id = p_prospecto_id
  returning * into v_row;

  if v_row.id is null then
    raise exception 'prospecto not found' using errcode = 'P0002';
  end if;

  return v_row;
end;
$$;

revoke all on function core.update_prospecto_for_superadmin(uuid, uuid, text, text) from public;
grant execute on function core.update_prospecto_for_superadmin(uuid, uuid, text, text) to authenticated;
