-- 172 -- Recordatorios operativos al gerente de pedidos SIN ACEPTAR despues de N minutos (F4b, paso 7). Prefijo de supabase/migrations: 20240101000472.
-- Requiere: 076 (avisos_operativos_candidatos: el aviso unico «sin aceptar» a 15 min queda INTACTO) y 043. NO duplica fix/r23-alertas: esta migracion
-- solo decide QUE pedidos necesitan recordatorio; el envio es el mecanismo de avisos del panel (emitirNotificacion), no WhatsApp.
--
-- Que agrega:
--   1. restaurantes.recordatorio_pedido_config (por sucursal): encendido por omision, primer recordatorio a N minutos (3..120, 10 por omision),
--      repetir cada M minutos (3..120, 10) y maximo de recordatorios (1..6, 3). El ultimo se escala a owner/admin en el TypeScript.
--   2. restaurantes.recordatorio_pedido_config_leer / _guardar (panel; guardar solo owner/admin).
--   3. restaurantes.recordatorios_pedido_candidatos(p_ahora): pedidos `pending` (no programados ni por aprobar) con edad >= N, con el numero de recordatorio
--      que les toca (1..max); SOLO sistema. El numero sale de la edad, asi dos ticks seguidos dan el mismo numero y la clave de dedupe evita repetirlo.
-- Justificacion de seguridad: tabla con RLS, `revoke all` y `grant select` a authenticated con policy de owner/admin/staff de la organizacion; escrituras solo por la
--   funcion definer (search_path fijo, revoke de public/anon, grant a authenticated, owner/admin con alcance). La funcion de candidatos exige auth.uid() NULO y solo
--   devuelve ids y numeros (sin PII). Todo filtra por organization_id.
-- Compatibilidad con base sin migrar: 42883/42P01 => el barrido devuelve `disponible: false` (igual que avisos-operativos.ts).
-- REVERSA: drop function recordatorios_pedido_candidatos(timestamptz), recordatorio_pedido_config_guardar(uuid, uuid, boolean, integer, integer, integer),
--   recordatorio_pedido_config_leer(uuid, uuid); drop table restaurantes.recordatorio_pedido_config.

create table if not exists restaurantes.recordatorio_pedido_config (
  property_id uuid primary key references core.property(id) on delete cascade,
  organization_id uuid not null references core.organization(id) on delete cascade,
  habilitado boolean not null default true,
  primero_min integer not null default 10 check (primero_min between 3 and 120),
  repetir_min integer not null default 10 check (repetir_min between 3 and 120),
  maximo integer not null default 3 check (maximo between 1 and 6),
  actualizado_en timestamptz not null default now()
);
alter table restaurantes.recordatorio_pedido_config enable row level security;
revoke all on restaurantes.recordatorio_pedido_config from public, anon, authenticated;
grant select on restaurantes.recordatorio_pedido_config to authenticated;
drop policy if exists "staff lee los recordatorios de pedidos de su organizacion" on restaurantes.recordatorio_pedido_config;
create policy "staff lee los recordatorios de pedidos de su organizacion" on restaurantes.recordatorio_pedido_config for select
  using (exists (select 1 from core.membership m where m.user_id = auth.uid() and m.organization_id = recordatorio_pedido_config.organization_id and m.vertical_role in ('owner', 'admin', 'staff')));

create or replace function restaurantes.recordatorio_pedido_config_leer(p_organization_id uuid, p_property_id uuid)
returns table (habilitado boolean, primero_min integer, repetir_min integer, maximo integer)
language plpgsql
stable
security definer
set search_path = restaurantes, core, pg_temp
as $$
#variable_conflict use_column
begin
  if auth.uid() is null then
    raise exception 'recordatorio_pedido_config_leer no es para la sesion de sistema' using errcode = '42501';
  end if;
  if not exists (
    select 1 from core.membership m join core.property p on p.id = p_property_id and p.organization_id = p_organization_id
    where m.user_id = auth.uid() and m.organization_id = p_organization_id and m.vertical_role in ('owner', 'admin', 'staff')
      and (m.property_ids is null or p_property_id = any (m.property_ids))
  ) then
    raise exception 'sin permiso para esta sucursal' using errcode = '42501';
  end if;
  return query
    select coalesce(c.habilitado, true), coalesce(c.primero_min, 10), coalesce(c.repetir_min, 10), coalesce(c.maximo, 3)
    from (select 1) u left join restaurantes.recordatorio_pedido_config c on c.property_id = p_property_id and c.organization_id = p_organization_id;
end;
$$;

create or replace function restaurantes.recordatorio_pedido_config_guardar(
  p_organization_id uuid, p_property_id uuid, p_habilitado boolean, p_primero_min integer, p_repetir_min integer, p_maximo integer
) returns void
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'recordatorio_pedido_config_guardar no es para la sesion de sistema' using errcode = '42501';
  end if;
  if p_habilitado is null or p_primero_min is null or p_primero_min not between 3 and 120 or p_repetir_min is null or p_repetir_min not between 3 and 120
     or p_maximo is null or p_maximo not between 1 and 6 then
    raise exception 'recordatorio_pedido_config_guardar: valores fuera de rango' using errcode = '22023';
  end if;
  if not exists (
    select 1 from core.membership m join core.property p on p.id = p_property_id and p.organization_id = p_organization_id
    where m.user_id = auth.uid() and m.organization_id = p_organization_id and m.vertical_role in ('owner', 'admin')
      and (m.property_ids is null or p_property_id = any (m.property_ids))
  ) then
    raise exception 'solo owner/admin de la sucursal configuran los recordatorios' using errcode = '42501';
  end if;
  insert into restaurantes.recordatorio_pedido_config (property_id, organization_id, habilitado, primero_min, repetir_min, maximo, actualizado_en)
  values (p_property_id, p_organization_id, p_habilitado, p_primero_min, p_repetir_min, p_maximo, now())
  on conflict (property_id) do update set habilitado = excluded.habilitado, primero_min = excluded.primero_min, repetir_min = excluded.repetir_min,
    maximo = excluded.maximo, actualizado_en = now();
end;
$$;

create or replace function restaurantes.recordatorios_pedido_candidatos(p_ahora timestamptz default null)
returns table (order_id uuid, organization_id uuid, property_id uuid, order_number bigint, numero_recordatorio integer, maximo integer, minutos integer)
language plpgsql
stable
security definer
set search_path = restaurantes, core, pg_temp
as $$
#variable_conflict use_column
declare
  v_now timestamptz := coalesce(p_ahora, now());
begin
  if auth.uid() is not null then
    raise exception 'recordatorios_pedido_candidatos es solo para la sesion de sistema' using errcode = '42501';
  end if;
  return query
  select z.order_id, z.organization_id, z.property_id, z.order_number, z.n, z.maximo, z.edad_min
  from (
    select o.id as order_id, o.organization_id, o.property_id, o.order_number::bigint as order_number,
           least(k.maximo, 1 + floor((e.edad - k.primero_min) / k.repetir_min))::integer as n,
           k.maximo, floor(e.edad)::integer as edad_min
    from restaurantes.orders o
    left join restaurantes.recordatorio_pedido_config c on c.property_id = o.property_id and c.organization_id = o.organization_id
    cross join lateral (select coalesce(c.habilitado, true) as habilitado, coalesce(c.primero_min, 10) as primero_min,
                               coalesce(c.repetir_min, 10) as repetir_min, coalesce(c.maximo, 3) as maximo) k
    cross join lateral (select extract(epoch from (v_now - coalesce(o.promovido_at, o.created_at))) / 60.0 as edad) e
    where o.status = 'pending'
      and k.habilitado
      and e.edad >= k.primero_min
      and coalesce(o.promovido_at, o.created_at) > v_now - interval '24 hours'
  ) z
  order by z.order_number
  limit 500;
end;
$$;

revoke all on function restaurantes.recordatorio_pedido_config_leer(uuid, uuid) from public, anon;
revoke all on function restaurantes.recordatorio_pedido_config_guardar(uuid, uuid, boolean, integer, integer, integer) from public, anon;
revoke all on function restaurantes.recordatorios_pedido_candidatos(timestamptz) from public, anon;
grant execute on function restaurantes.recordatorio_pedido_config_leer(uuid, uuid) to authenticated;
grant execute on function restaurantes.recordatorio_pedido_config_guardar(uuid, uuid, boolean, integer, integer, integer) to authenticated;
grant execute on function restaurantes.recordatorios_pedido_candidatos(timestamptz) to authenticated;
