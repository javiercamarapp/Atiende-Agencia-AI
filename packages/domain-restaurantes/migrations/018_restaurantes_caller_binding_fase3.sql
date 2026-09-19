-- Fase 3 del hallazgo de seguridad "caller binding" (ver `packages/db/migrations/
-- 0016_caller_binding_fase3.sql` para el resumen completo de la clase de hallazgo, y
-- `scripts/verify-caller-binding-fase2/README.md` -- sección "Fuera de alcance" --
-- donde quedó documentado este hallazgo concreto en la Fase 2, con un call-site-audit
-- que resultó INCOMPLETO para la primera de las dos funciones de abajo -- ver el
-- comentario propio de esa función para el detalle real, reverificado en esta fase).
--
-- 1) `restaurantes.enqueue_staff_order_notification` (`009_order_notifications.sql`)
--    es `security definer` con `grant execute ... to authenticated`, y recibe
--    `p_organization_id`/`p_property_id`/`p_order_id` explícitos sin atarlos a
--    `auth.uid()`.
--
--    Call-site-audit (verificado contra el código real de esta rama -- el README de
--    la Fase 2 decía "único call site real en createOrder (checkout público, sesión
--    de sistema)", pero eso quedó desactualizado por la Fase 12 (asignación de
--    repartidor), que agregó DOS callers más): tiene HOY tres callers reales, vía
--    `order-notifications.ts::enqueueStaffNotification`:
--      - `notifyStaffNewOrderCore` <- `createOrder` (`routes/verticals/restaurantes/
--        public.ts`, checkout público, `engine.withAppSession({userId: null})` --
--        sesión de SISTEMA, sin membership real).
--      - `notifyStaffOrderProblemCore` <- `changeAssignedOrderStatus`
--        (`repartidor-orders.ts`, sesión REAL del repartidor autenticado,
--        `auth.uid()` = su propio id).
--      - `notifyStaffRepartidorAssignedCore` <- `assignRepartidorToOrder`
--        (`admin-orders.ts` `PATCH .../assign-repartidor`, sesión REAL del admin
--        autenticado).
--    Un guard "solo sistema" (Clase B) ROMPERÍA los dos callers autenticados reales
--    -- no aplica. Tampoco es Clase C pura (no hay un solo `p_actor_user_id` al que
--    atar `auth.uid()` -- la tabla no tiene esa columna). El hueco real es de
--    ALCANCE: hoy un `authenticated` de la organización A podría, por RPC directo,
--    inyectar una notificación falsa en la bandeja de la organización B (la policy
--    de SELECT de `staff_order_notification` la haría visible a cualquier miembro
--    de B). El guard nuevo reutiliza EXACTAMENTE el criterio de esa misma policy
--    ("staff ve notificaciones de pedidos de su organización", migración 009):
--    cuando hay sesión real (`auth.uid()` no nulo), exige membership en
--    `p_organization_id`; cuando es sesión de sistema (`auth.uid()` null, el
--    checkout público), no exige nada -- preserva el caller sin sesión intacto.
--
-- 2) `restaurantes.increment_promotion_uses` (`010_promotions.sql`) es `security
--    definer` con `grant execute ... to authenticated`, sin ningún parámetro de
--    pedido/actor -- solo `p_organization_id`/`p_promotion_id`. Confirmado un único
--    call site real: `orders.ts::createOrder` (mismo checkout público, sesión de
--    sistema, ver arriba). Hoy CUALQUIER `authenticated` de CUALQUIER organización
--    puede, por RPC directo, llamar esta función con el `promotion_id` de un
--    competidor y agotar su `max_uses` sin haber creado ningún pedido real -- ni
--    siquiera necesita ser staff de esa organización (`times_used`/`max_uses` no
--    tienen ninguna relación con `core.membership`). Clase B (sistema): MISMO
--    guard que `despachos.record_audit_log`/`hoteles.record_fraude_audit_log` --
--    cierra el abuso por completo (nunca alcanzable por ningún `authenticated`),
--    sin cambio de TypeScript (el único call site ya corre en sesión de sistema).

create or replace function restaurantes.enqueue_staff_order_notification(
  p_organization_id uuid, p_property_id uuid, p_order_id uuid, p_event_type text, p_message text
) returns setof restaurantes.staff_order_notification
language plpgsql security definer set search_path = restaurantes as $$
begin
  if p_event_type not in ('order.created', 'order.problema', 'order.assigned_repartidor') then
    raise exception 'invalid staff order notification event_type';
  end if;

  if auth.uid() is not null and not exists (
    select 1 from core.membership m
    where m.organization_id = p_organization_id and m.user_id = auth.uid()
  ) then
    raise exception 'enqueue_staff_order_notification: no perteneces a esa organización' using errcode = '42501';
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

create or replace function restaurantes.increment_promotion_uses(
  p_organization_id uuid,
  p_promotion_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = restaurantes
as $$
declare
  v_promotion restaurantes.promotions;
begin
  if auth.uid() is not null then
    raise exception 'increment_promotion_uses: solo alcanzable desde sesión de sistema' using errcode = '42501';
  end if;

  update restaurantes.promotions
  set times_used = times_used + 1, updated_at = now()
  where id = p_promotion_id
    and organization_id = p_organization_id
    and is_active = true
    and (max_uses is null or times_used < max_uses)
  returning * into v_promotion;

  if v_promotion.id is null then return null; end if;
  return to_jsonb(v_promotion);
end;
$$;

revoke all on function restaurantes.increment_promotion_uses(uuid, uuid) from public, anon;
grant execute on function restaurantes.increment_promotion_uses(uuid, uuid) to authenticated, service_role;
