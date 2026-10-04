-- Consentimiento del aviso de privacidad en el checkout web + aviso al staff cuando un pedido programado entra a cocina.
-- Prefijo de supabase/migrations: 20240101000312 (interno restaurantes 042).
-- Requiere: 001 (orders), 009 (staff_order_notification), 018 (guard de membresia en enqueue_staff_order_notification),
-- 030 (privacy_config), 034 (estado `programado`, promover_pedidos_programados).
--
-- Que agrega:
--   1. restaurantes.order_privacy_consent         -- evidencia, UNA fila por pedido, de que el cliente acepto el aviso de
--      privacidad al hacer su pedido en el checkout publico (version del aviso vigente, fecha y canal). Sin telefono, nombre
--      ni texto libre: el pedido ya trae los datos del cliente; aqui solo queda que acepto y que version.
--   2. restaurantes.system_record_order_privacy_consent(...) -- UNICA escritura (solo sistema).
--   3. staff_order_notification admite el evento `order.programado_promovido` (CHECK + funcion): el aviso al staff de que un
--      pedido programado YA entro a cocina. El evento `order.created` ya se emitio al crearlo (con la hora programada); el
--      unique (organizacion, pedido, evento) sigue garantizando un solo aviso por evento y pedido.
--
-- Justificacion de seguridad (una por una):
--  * order_privacy_consent -- RLS activa. SELECT solo para owner/admin de la organizacion (misma policy que
--    privacy_notice_deliveries, 030). `revoke all from public, anon, authenticated, service_role` y GRANT SELECT por COLUMNA
--    (todas las columnas de la tabla; ninguna es sensible) a authenticated: sin INSERT/UPDATE/DELETE para nadie. Nada para
--    anon. La evidencia es inmutable desde la aplicacion: la unica via de escritura es la funcion de abajo.
--  * system_record_order_privacy_consent -- SECURITY DEFINER, search_path fijo (restaurantes, core, pg_temp), `revoke from
--    public, anon`, `grant execute` a authenticated (el backend abre SIEMPRE la sesion de sistema con ese rol, sin usuario;
--    mismo criterio que system_claim_privacy_notice, 030). Guard `auth.uid() is null`: ningun usuario logueado puede fabricar
--    consentimientos. Exige que el pedido pertenezca a la organizacion declarada (42501 si no: un barrido o un bug no
--    puede cruzar tenants). La version del aviso la decide LA BASE (privacy_config.notice_version de esa organizacion, 'v1'
--    si no hay fila), nunca el navegador. Idempotente: un reintento no duplica ni cambia la evidencia.
--  * enqueue_staff_order_notification -- se redefine con la misma firma, grants y guard de membresia de la 018, mas: (a) el
--    cuarto evento permitido y (b) el pedido debe existir en la organizacion y la sucursal declaradas (42501): antes, un
--    llamador con membresia podia adjuntar un aviso a un pedido de otra organizacion (defensa en profundidad; los llamadores
--    reales siempre pasan un pedido propio).
--  * CHECK de event_type: drop + add de la restriccion con el cuarto valor; las filas existentes (3 eventos) la cumplen.
-- Compatibilidad con la base SIN migrar: el codigo TypeScript captura 42883/42P01/42703 dentro de SAVEPOINT y cae a "no
-- registrado / sin aviso"; el pedido nunca falla por esto.

-- ---------------------------------------------------------------------------
-- 1) Evidencia de consentimiento del checkout
-- ---------------------------------------------------------------------------
create table restaurantes.order_privacy_consent (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  order_id uuid not null unique references restaurantes.orders(id) on delete cascade,
  notice_version text not null check (notice_version ~ '^[A-Za-z0-9._-]{1,32}$'),
  channel text not null check (channel in ('web')),
  accepted_at timestamptz not null default now()
);
create index restaurantes_order_privacy_consent_org_idx on restaurantes.order_privacy_consent (organization_id, accepted_at desc);

alter table restaurantes.order_privacy_consent enable row level security;

create policy "owner/admin lee el consentimiento de privacidad de pedidos" on restaurantes.order_privacy_consent for select
  using (exists (
    select 1 from core.membership m
    where m.organization_id = order_privacy_consent.organization_id
      and m.user_id = auth.uid()
      and m.vertical_role in ('owner', 'admin')
  ));

revoke all on restaurantes.order_privacy_consent from public, anon, authenticated, service_role;
grant select (id, organization_id, order_id, notice_version, channel, accepted_at)
  on restaurantes.order_privacy_consent to authenticated;

-- ---------------------------------------------------------------------------
-- 2) Registro del consentimiento (solo sistema). Devuelve TRUE si registro una fila nueva, FALSE si ya existia.
-- ---------------------------------------------------------------------------
create or replace function restaurantes.system_record_order_privacy_consent(
  p_organization_id uuid,
  p_order_id uuid,
  p_channel text
)
returns boolean
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_version text;
  v_id uuid;
begin
  if auth.uid() is not null then
    raise exception 'system_record_order_privacy_consent es solo para la sesion de sistema' using errcode = '42501';
  end if;
  if p_channel is distinct from 'web' then
    raise exception 'system_record_order_privacy_consent: canal no admitido' using errcode = '22023';
  end if;
  if not exists (select 1 from restaurantes.orders o where o.id = p_order_id and o.organization_id = p_organization_id) then
    raise exception 'system_record_order_privacy_consent: el pedido no pertenece a la organizacion' using errcode = '42501';
  end if;
  select pc.notice_version into v_version from restaurantes.privacy_config pc where pc.organization_id = p_organization_id;
  insert into restaurantes.order_privacy_consent (organization_id, order_id, notice_version, channel)
  values (p_organization_id, p_order_id, coalesce(v_version, 'v1'), p_channel)
  on conflict (order_id) do nothing
  returning id into v_id;
  return v_id is not null;
end;
$$;

revoke all on function restaurantes.system_record_order_privacy_consent(uuid, uuid, text) from public, anon;
grant execute on function restaurantes.system_record_order_privacy_consent(uuid, uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 3) Aviso al staff: pedido programado que entra a cocina
-- ---------------------------------------------------------------------------
alter table restaurantes.staff_order_notification drop constraint if exists staff_order_notification_event_type_check;
alter table restaurantes.staff_order_notification
  add constraint staff_order_notification_event_type_check
  check (event_type in ('order.created', 'order.problema', 'order.assigned_repartidor', 'order.programado_promovido'));

create or replace function restaurantes.enqueue_staff_order_notification(
  p_organization_id uuid, p_property_id uuid, p_order_id uuid, p_event_type text, p_message text
) returns setof restaurantes.staff_order_notification
language plpgsql security definer set search_path = restaurantes, core, pg_temp as $$
begin
  if p_event_type not in ('order.created', 'order.problema', 'order.assigned_repartidor', 'order.programado_promovido') then
    raise exception 'invalid staff order notification event_type';
  end if;

  if auth.uid() is not null and not exists (
    select 1 from core.membership m
    where m.organization_id = p_organization_id and m.user_id = auth.uid()
  ) then
    raise exception 'enqueue_staff_order_notification: no perteneces a esa organización' using errcode = '42501';
  end if;

  if not exists (
    select 1 from restaurantes.orders o
    where o.id = p_order_id and o.organization_id = p_organization_id and o.property_id = p_property_id
  ) then
    raise exception 'enqueue_staff_order_notification: el pedido no pertenece a esa organización y sucursal' using errcode = '42501';
  end if;

  insert into restaurantes.staff_order_notification(organization_id, property_id, order_id, event_type, message)
  values (p_organization_id, p_property_id, p_order_id, p_event_type, p_message)
  on conflict (organization_id, order_id, event_type) do nothing;

  return query
    select * from restaurantes.staff_order_notification
    where organization_id = p_organization_id and order_id = p_order_id and event_type = p_event_type;
end; $$;

revoke all on function restaurantes.enqueue_staff_order_notification(uuid, uuid, uuid, text, text) from public, anon;
grant execute on function restaurantes.enqueue_staff_order_notification(uuid, uuid, uuid, text, text) to authenticated, service_role;
