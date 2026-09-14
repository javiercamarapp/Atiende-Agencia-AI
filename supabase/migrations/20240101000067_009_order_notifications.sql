-- Fase 9 restaurantes — bandeja de notificaciones internas al staff (ver
-- domain-restaurantes/src/order-notifications.ts). GAP real verificado contra el
-- código de esta rama antes de construir (order-lifecycle.ts/admin-orders.ts): NI
-- `changeOrderStatus` NI `changeAssignedOrderStatus` NI `createOrder` disparaban
-- NUNCA ningún aviso -- un manager solo se enteraba de un pedido nuevo si
-- refrescaba el panel a mano, y un cliente solo se enteraba de que su pedido iba en
-- camino si alguien del staff lo llamaba por teléfono.
--
-- DECISIÓN DE DISEÑO (documentada aquí a propósito, mismo criterio "honesto" que
-- `licitaciones.tender_change_notification`, migrations/010 de ese paquete): este
-- monorepo NO tiene ningún SDK de push/websocket compartido entre verticales (sin
-- Firebase Cloud Messaging, sin canal de WebSocket propio, sin ningún otro vertical
-- que ya resuelva "avisar en tiempo real a una pestaña abierta del panel admin").
-- Construir esa infraestructura completa es un proyecto aparte, no el gap de
-- "notificaciones de cambio de estado" en sí. Esta migración cierra el gap real y
-- verificable con lo que SÍ existe: una bandeja persistida, consultable por POLLING
-- desde el panel admin (`GET .../admin/order-notifications`, ver admin-orders.ts) --
-- nunca finge un canal de envío push que no existe.
--
-- El INSERT real pasa por una función SECURITY DEFINER
-- (`enqueue_staff_order_notification`, mismo patrón exacto que
-- `restaurantes.enqueue_messaging_outbox`, migrations/007) porque el evento más
-- urgente ("pedido nuevo") se dispara desde `createOrder`, que corre en el checkout
-- PÚBLICO (web/voz/WhatsApp, sin sesión de staff real — ver comentario de cabecera
-- de postgres-repository.ts: "no hay auth.uid() real en esos canales"). La
-- lectura/reconocimiento sí corren siempre con sesión de staff real (rutas
-- `authMiddleware` del panel admin), así que usan GRANTs de tabla + RLS normales,
-- igual que `restaurantes.orders`.

create table restaurantes.staff_order_notification (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  order_id uuid not null references restaurantes.orders(id) on delete cascade,
  event_type text not null check (event_type in ('order.created', 'order.problema', 'order.assigned_repartidor')),
  message text not null check (length(message) between 1 and 2000),
  created_at timestamptz not null default now(),
  acknowledged_at timestamptz,
  acknowledged_by uuid references core.staff_user(id),
  -- Idempotente por evento real de un pedido — un reintento (p.ej. un retry HTTP de
  -- create-order que create_order_idempotent resuelve devolviendo el MISMO pedido)
  -- nunca duplica la fila.
  unique (organization_id, order_id, event_type)
);
create index staff_order_notification_poll_idx
  on restaurantes.staff_order_notification (organization_id, created_at desc);
alter table restaurantes.staff_order_notification enable row level security;

revoke all on restaurantes.staff_order_notification from public, anon;
-- `authenticated`: el panel admin (siempre con sesión de staff real) lee/reconoce
-- directo contra la tabla -- mismo criterio que `restaurantes.orders` (migrations/007,
-- "staff actualiza pedidos de su organización"). `service_role`: consistente con el
-- resto de tablas de sistema de este paquete.
grant select, update on restaurantes.staff_order_notification to authenticated;
grant select, insert, update on restaurantes.staff_order_notification to service_role;

create policy "staff ve notificaciones de pedidos de su organización" on restaurantes.staff_order_notification for select
  using (exists (select 1 from core.membership m where m.organization_id = staff_order_notification.organization_id and m.user_id = auth.uid()));
create policy "staff reconoce notificaciones de pedidos de su organización" on restaurantes.staff_order_notification for update
  using (exists (select 1 from core.membership m where m.organization_id = staff_order_notification.organization_id and m.user_id = auth.uid()))
  with check (exists (select 1 from core.membership m where m.organization_id = staff_order_notification.organization_id and m.user_id = auth.uid()));

create or replace function restaurantes.enqueue_staff_order_notification(
  p_organization_id uuid, p_property_id uuid, p_order_id uuid, p_event_type text, p_message text
) returns setof restaurantes.staff_order_notification
language plpgsql security definer set search_path = restaurantes as $$
begin
  if p_event_type not in ('order.created', 'order.problema', 'order.assigned_repartidor') then
    raise exception 'invalid staff order notification event_type';
  end if;
  insert into restaurantes.staff_order_notification(organization_id, property_id, order_id, event_type, message)
  values (p_organization_id, p_property_id, p_order_id, p_event_type, p_message)
  on conflict (organization_id, order_id, event_type) do nothing;

  return query
    select * from restaurantes.staff_order_notification
    where organization_id = p_organization_id and order_id = p_order_id and event_type = p_event_type;
end; $$;

revoke all on function restaurantes.enqueue_staff_order_notification(uuid, uuid, uuid, text, text) from public, anon;
-- DESVIACIÓN DELIBERADA vs. `enqueue_messaging_outbox` (que solo otorga a
-- `service_role`, migrations/007): esta función SÍ necesita ejecutarse también como
-- `authenticated` -- `@atiende/db::ManagedPostgresEngine.withAppSession` (el único
-- motor real de este monorepo, ver packages/db/src/managed-postgres-engine.ts) fija
-- SIEMPRE `set local role authenticated` para CUALQUIER sesión de aplicación,
-- incluida la de sistema (`userId: null`) que usa el checkout público -- nunca
-- conecta realmente como `service_role`. Documentado aquí en vez de replicar en
-- silencio un grant que en la práctica bloquearía el caso de uso real más urgente
-- de esta migración ("pedido nuevo" desde checkout público).
grant execute on function restaurantes.enqueue_staff_order_notification(uuid, uuid, uuid, text, text) to authenticated, service_role;
