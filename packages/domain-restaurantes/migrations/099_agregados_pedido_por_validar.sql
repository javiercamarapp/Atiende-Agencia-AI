-- 099 -- «Agregados por validar»: el cliente ya tiene un pedido enviado a la sucursal y pide agregar productos por WhatsApp o llamada. El agente NUNCA lo
-- confirma por su cuenta: crea una solicitud (`order_amendments`) que una persona de la sucursal acepta o rechaza con motivo. Prefijo de supabase/migrations
-- asignado: 20240101000413 (interno 099).
--
-- Decision de diseno: DOS tablas NUEVAS y ninguna restriccion existente cambia. La DECISION (aceptar/rechazar) es un UPDATE con compare-and-set
-- (`where status = 'pendiente'`) que las policies de RLS ya acotan por organizacion y sucursal, y la bitacora es append-only por GRANT: sin funciones para eso.
-- Las UNICAS funciones SECURITY DEFINER (tres de uso externo y un helper) son las que la sesion de SISTEMA (agente y tick, `auth.uid()` nulo) NO puede hacer con RLS porque no ve `orders`
-- (no hay policy de sistema sobre pedidos; por eso el resto del paquete lee pedidos desde el sistema con funciones solo-sistema, p. ej. la 071): crear la
-- solicitud validando el pedido, leerla con los datos del pedido, y listar lo pendiente para el barrido del SLA. Las tres exigen `auth.uid() is null`.
-- El TypeScript degrada con SAVEPOINT a «no disponible aun» cuando la base todavia no tiene las tablas (SQLSTATE 42P01/42703/42883): nada de esto se aplica al
-- mergear. Sin esta migracion el agente cae al aviso de siempre (escalar_a_humano, cancelacion_modificacion) y el panel dice «no disponible aun».
--
-- Estados: pendiente | aceptado | rechazado | vencido | cancelado_por_cliente | no_aplicable.
--   * pendiente: esperando a la sucursal (un solo agregado abierto por pedido: indice unico parcial; si el cliente pide mas se FUSIONA y sube `version`).
--   * aceptado / rechazado: decide una persona (decided_by = quien); el rechazo exige motivo de lista cerrada.
--   * vencido: el sistema lo cierra a los 20 minutos sin respuesta (nunca se acepta solo). decided_by queda nulo.
--   * cancelado_por_cliente: el cliente se arrepiente antes de que la sucursal decida.
--   * no_aplicable: el pedido salio a reparto, se entrego o se cancelo antes de decidir.
-- SLA (decision del dueno): la sucursal responde en <= 10 min; a los 10 se avisa al dueno y al cliente (aviso unico, escalation_level 1); a los 20 se
-- cierra como vencido y se ofrece pedido aparte o recoger (escalation_level 2). El calculo se hace al LEER y en el tick existente de 5 min (sin cron nuevo).
--
-- Justificacion de seguridad de cada GRANT / policy / trigger (uno por uno):
--  * RLS habilitado y `revoke all ... from public, anon, authenticated` antes de conceder: `anon` no recibe NINGUN privilegio.
--  * SELECT de order_amendments: sesion de SISTEMA (`auth.uid() is null`: agente, tick) o miembro owner/admin/staff de la organizacion con alcance a la sucursal
--    (`property_ids` nulo = todas). El repartidor NO entra (el permiso nuevo `pedidos.agregados` lo excluye). La fila no guarda telefono ni nombre: se leen del pedido.
--  * order_amendments NO tiene INSERT para authenticated: la solicitud nace SOLO en `agregado_crear_sistema` (definer, `auth.uid() is null`, search_path fijo,
--    revoke de public/anon): bloquea el pedido, exige que sea de la misma organizacion y sucursal y que su estado admita agregados, y es idempotente por
--    evento y por pedido (un solo abierto). Nadie crea solicitudes por PostgREST. `agregado_vista_json` (helper interno) no se concede a nadie: solo la llaman
--    las otras dos funciones del mismo duenio. `agregados_barrido_sistema` (definer, solo sistema) devuelve las pendientes con los datos del pedido para avisar
--    al cliente (el sistema no ve `orders` por RLS); sin parametros de organizacion: el barrido recorre todas, igual que el tick de los demas pasos.
--  * UPDATE de order_amendments: sistema o staff con alcance, y SOLO sobre filas `pendiente` (using); with check: un usuario no puede dejar `decided_by` ajeno
--    (decided_by = auth.uid()) ni resolver a nombre del sistema. GRANT por COLUMNA (sin organization_id, property_id, order_id, channel, source_event_id, requested_at).
--    El trigger `order_amendments_guardia` (SECURITY INVOKER) impide que un USUARIO cambie lo que pidio el cliente (items_added, totales, nota, version): solo el
--    sistema (fusion) lo puede. Las transiciones fuera de la maquina de estados mueren en el trigger y en el CHECK.
--  * Sin DELETE para authenticated: nada se borra; la bitacora queda completa. `service_role` conserva todos los privilegios (mantenimiento), como el resto del paquete.
--  * order_amendment_events: append-only. SELECT con el mismo alcance; INSERT de sistema o staff con alcance y `actor_user_id = auth.uid()` (o nulo si es sistema);
--    sin UPDATE ni DELETE para nadie salvo service_role. El detalle es jsonb acotado (< 4 kB) y no lleva PII.
--  * CHECK por columna: topes de items (1..30), importes 0..100000, nota <= 300, motivo de lista cerrada: valores fuera de rango mueren en la base aunque
--    alguien salte la validacion de la API.
--
-- REVERSA (manual, no se ejecuta sola, en este orden): la migracion solo CREA tablas, un trigger y cinco funciones, y nada mas las referencia; deshacerla es borrarlas. Las policies,
-- los GRANT, los indices y los CHECK caen con las tablas:
--     drop function restaurantes.agregados_barrido_sistema(timestamptz, integer);
--     drop function restaurantes.agregado_leer_sistema(uuid);
--     drop function restaurantes.agregado_crear_sistema(uuid, uuid, uuid, text, jsonb, numeric, text, text);
--     drop function restaurantes.agregado_vista_json(uuid);
--     drop table restaurantes.order_amendment_events;
--     drop table restaurantes.order_amendments;
--     drop function restaurantes.order_amendments_guardia();
-- Se pierde el historial de agregados (los pedidos NO cambian: lo aceptado ya quedo escrito en `orders.items`/`orders.total`). El TypeScript vuelve a la escalada
-- de siempre y el panel dice «no disponible aun», sin romperse (SQLSTATE 42P01).

create table restaurantes.order_amendments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id),
  order_id uuid not null references restaurantes.orders(id) on delete cascade,
  status text not null default 'pendiente'
    check (status in ('pendiente', 'aceptado', 'rechazado', 'vencido', 'cancelado_por_cliente', 'no_aplicable')),
  channel text not null check (channel in ('whatsapp', 'voice')),
  -- Renglones nuevos con la misma forma que `orders.items` (id, name, price, quantity...). Se agregan tal cual al pedido al aceptar.
  items_added jsonb not null check (jsonb_typeof(items_added) = 'array' and jsonb_array_length(items_added) between 1 and 30),
  total_before numeric(10, 2) not null check (total_before between 0 and 100000),
  total_added numeric(10, 2) not null check (total_added between 0 and 100000),
  total_after numeric(10, 2) not null check (total_after between 0 and 200000),
  customer_note text check (customer_note is null or char_length(customer_note) <= 300),
  -- Sube cada vez que el cliente pide mas sobre el mismo agregado abierto (fusion). El cronometro del SLA (requested_at) NO se reinicia.
  version integer not null default 1 check (version between 1 and 50),
  requested_at timestamptz not null default now(),
  first_seen_at timestamptz,
  decided_at timestamptz,
  decided_by uuid references core.staff_user(id) on delete set null,
  reject_reason text check (reject_reason is null or reject_reason in ('ya_salio_de_cocina', 'producto_agotado', 'pedido_en_reparto', 'fuera_de_horario', 'otro')),
  reject_note text check (reject_note is null or char_length(reject_note) <= 300),
  -- 0 = en tiempo, 1 = a los 10 min sin respuesta (dueno + cliente avisados), 2 = a los 20 min (cerrado, se ofrecio pedido aparte o recoger).
  escalation_level smallint not null default 0 check (escalation_level between 0 and 2),
  escalated_at timestamptz,
  -- Id opaco del evento que origino la solicitud (mensaje de Meta / llamada): el mismo evento nunca crea dos solicitudes.
  source_event_id text check (source_event_id is null or char_length(source_event_id) <= 255),
  check ((status = 'pendiente') = (decided_at is null)),
  check (status <> 'rechazado' or reject_reason is not null),
  check (status <> 'aceptado' or decided_by is not null),
  check (reject_reason is null or status = 'rechazado'),
  check (total_after = total_before + total_added)
);

-- Un solo agregado ABIERTO por pedido (el segundo pedido de agregar se fusiona en este).
create unique index order_amendments_un_abierto_por_pedido on restaurantes.order_amendments(order_id) where status = 'pendiente';
create unique index order_amendments_evento_uidx on restaurantes.order_amendments(organization_id, source_event_id) where source_event_id is not null;
-- Los avisos al cliente y la tarea de devolver llamada no son columnas: quedan en la bitacora (`cliente_avisado`, `callback_creado`, con el id en `detail`)
-- porque se escriben DESPUES de resolver y una solicitud resuelta ya no se actualiza.
-- Cola del panel y barrido del SLA: pendientes por sucursal, mas antiguos primero.
create index order_amendments_pendientes_idx on restaurantes.order_amendments(organization_id, property_id, requested_at) where status = 'pendiente';
create index order_amendments_pedido_idx on restaurantes.order_amendments(order_id, requested_at desc);

create table restaurantes.order_amendment_events (
  id uuid primary key default gen_random_uuid(),
  amendment_id uuid not null references restaurantes.order_amendments(id) on delete cascade,
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id),
  event_type text not null
    check (event_type in ('creado', 'fusionado', 'visto', 'aceptado', 'rechazado', 'vencido', 'cancelado_por_cliente', 'no_aplicable', 'sin_respuesta_10min', 'cliente_avisado', 'callback_creado')),
  actor_kind text not null check (actor_kind in ('usuario', 'agente', 'sistema')),
  actor_user_id uuid references core.staff_user(id) on delete set null,
  detail jsonb not null default '{}'::jsonb check (jsonb_typeof(detail) = 'object' and pg_column_size(detail) < 4096),
  created_at timestamptz not null default now(),
  check ((actor_kind = 'usuario') = (actor_user_id is not null))
);
create index order_amendment_events_amendment_idx on restaurantes.order_amendment_events(amendment_id, created_at);

-- Guardia (SECURITY INVOKER, sin privilegios propios): un USUARIO solo resuelve; lo que pidio el cliente y la identidad de la solicitud no cambian, y el estado
-- sigue la maquina (de pendiente a cualquier estado final; un estado final no se mueve). El sistema (auth.uid() nulo) sigue pudiendo fusionar y escalar.
create function restaurantes.order_amendments_guardia() returns trigger
language plpgsql
set search_path = restaurantes, pg_temp
as $$
begin
  if old.status <> 'pendiente' then
    raise exception 'order_amendments: una solicitud resuelta no se modifica' using errcode = '22023';
  end if;
  if auth.uid() is not null and (
       new.items_added is distinct from old.items_added or new.total_before is distinct from old.total_before
    or new.total_added is distinct from old.total_added or new.total_after is distinct from old.total_after
    or new.customer_note is distinct from old.customer_note or new.version is distinct from old.version
  ) then
    raise exception 'order_amendments: un usuario no puede cambiar lo que pidio el cliente' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger order_amendments_guardia before update on restaurantes.order_amendments
  for each row execute function restaurantes.order_amendments_guardia();

alter table restaurantes.order_amendments enable row level security;
alter table restaurantes.order_amendment_events enable row level security;

create policy "sistema o staff con alcance leen los agregados" on restaurantes.order_amendments for select
  using (
    auth.uid() is null
    or exists (
      select 1 from core.membership m
      where m.organization_id = order_amendments.organization_id and m.user_id = auth.uid()
        and m.vertical_role in ('owner', 'admin', 'staff')
        and (m.property_ids is null or order_amendments.property_id = any (m.property_ids))
    )
  );

create policy "sistema o staff con alcance resuelven agregados abiertos" on restaurantes.order_amendments for update
  using (
    status = 'pendiente'
    and (
      auth.uid() is null
      or exists (
        select 1 from core.membership m
        where m.organization_id = order_amendments.organization_id and m.user_id = auth.uid()
          and m.vertical_role in ('owner', 'admin', 'staff')
          and (m.property_ids is null or order_amendments.property_id = any (m.property_ids))
      )
    )
  )
  with check (
    auth.uid() is null
    or (
      (decided_by is null or decided_by = auth.uid())
      and exists (
        select 1 from core.membership m
        where m.organization_id = order_amendments.organization_id and m.user_id = auth.uid()
          and m.vertical_role in ('owner', 'admin', 'staff')
          and (m.property_ids is null or order_amendments.property_id = any (m.property_ids))
      )
    )
  );

create policy "sistema o staff con alcance leen la bitacora de agregados" on restaurantes.order_amendment_events for select
  using (
    auth.uid() is null
    or exists (
      select 1 from core.membership m
      where m.organization_id = order_amendment_events.organization_id and m.user_id = auth.uid()
        and m.vertical_role in ('owner', 'admin', 'staff')
        and (m.property_ids is null or order_amendment_events.property_id = any (m.property_ids))
    )
  );

create policy "sistema o staff con alcance anotan la bitacora de agregados" on restaurantes.order_amendment_events for insert
  with check (
    exists (
      select 1 from restaurantes.order_amendments a
      where a.id = order_amendment_events.amendment_id and a.organization_id = order_amendment_events.organization_id and a.property_id = order_amendment_events.property_id
    )
    and (
      (auth.uid() is null and actor_kind in ('agente', 'sistema') and actor_user_id is null)
      or (
        actor_kind = 'usuario' and actor_user_id = auth.uid()
        and exists (
          select 1 from core.membership m
          where m.organization_id = order_amendment_events.organization_id and m.user_id = auth.uid()
            and m.vertical_role in ('owner', 'admin', 'staff')
            and (m.property_ids is null or order_amendment_events.property_id = any (m.property_ids))
        )
      )
    )
  );

revoke all on restaurantes.order_amendments, restaurantes.order_amendment_events from public, anon, authenticated;
grant select on restaurantes.order_amendments to authenticated;
grant update (status, items_added, total_added, total_after, customer_note, version, first_seen_at, decided_at, decided_by, reject_reason, reject_note,
              escalation_level, escalated_at)
  on restaurantes.order_amendments to authenticated;
grant select on restaurantes.order_amendment_events to authenticated;
grant insert (amendment_id, organization_id, property_id, event_type, actor_kind, actor_user_id, detail) on restaurantes.order_amendment_events to authenticated;
grant select, insert, update, delete on restaurantes.order_amendments, restaurantes.order_amendment_events to service_role;

-- ---------------------------------------------------------------------------------------------------------------------------------------------------------
-- Funciones SOLO-SISTEMA (SECURITY DEFINER, search_path fijo). La sesion de sistema corre como `authenticated` con `auth.uid()` nulo y no ve `orders` por RLS.
-- ---------------------------------------------------------------------------------------------------------------------------------------------------------

-- Helper interno: la solicitud con los datos del pedido, en jsonb (mismas claves que las columnas que lee el TypeScript). Sin GRANT para nadie.
create function restaurantes.agregado_vista_json(p_amendment_id uuid) returns jsonb
language sql stable security definer
set search_path = restaurantes, core, pg_temp
as $$
  select to_jsonb(v) from (
    select a.id, a.organization_id, a.property_id, a.order_id, a.status, a.channel, a.items_added, a.total_before, a.total_added, a.total_after, a.customer_note,
           a.version, a.requested_at, a.first_seen_at, a.decided_at, a.decided_by, a.reject_reason, a.reject_note, a.escalation_level, a.escalated_at,
           (select su.full_name from core.staff_user su where su.id = a.decided_by) as decided_by_name,
           o.order_number, o.status as order_status, o.items as order_items, o.total as order_total, o.created_at as order_created_at,
           o.customer_name, o.customer_phone, o.branch as sucursal
    from restaurantes.order_amendments a
    join restaurantes.orders o on o.id = a.order_id and o.organization_id = a.organization_id
    where a.id = p_amendment_id
  ) v;
$$;
revoke all on function restaurantes.agregado_vista_json(uuid) from public, anon, authenticated;

-- Crea la solicitud del agente (o devuelve la abierta del pedido para que el TypeScript la FUSIONE). Estados: creado | abierto | repetido |
-- pedido_no_encontrado | pedido_no_agregable.
create function restaurantes.agregado_crear_sistema(
  p_organization_id uuid, p_property_id uuid, p_order_id uuid, p_channel text, p_items jsonb, p_total_added numeric, p_note text, p_source_event_id text
) returns jsonb
language plpgsql security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_order restaurantes.orders;
  v_id uuid;
  v_estado text := 'creado';
begin
  if auth.uid() is not null then
    raise exception 'agregado_crear_sistema es solo para la sesion de sistema' using errcode = '42501';
  end if;
  if p_source_event_id is not null then
    select a.id into v_id from restaurantes.order_amendments a where a.organization_id = p_organization_id and a.source_event_id = p_source_event_id;
    if found then
      return jsonb_build_object('estado', 'repetido', 'agregado', restaurantes.agregado_vista_json(v_id));
    end if;
  end if;
  -- (id, organizacion, sucursal) deben coincidir: un pedido ajeno o de otra sucursal es «no encontrado», igual que uno inexistente.
  select * into v_order from restaurantes.orders o
    where o.id = p_order_id and o.organization_id = p_organization_id and o.property_id = p_property_id
    for update;
  if not found then
    return jsonb_build_object('estado', 'pedido_no_encontrado');
  end if;
  if v_order.status not in ('programado', 'pending', 'preparando', 'listo_para_recoger') then
    return jsonb_build_object('estado', 'pedido_no_agregable', 'orderStatus', v_order.status);
  end if;
  insert into restaurantes.order_amendments (organization_id, property_id, order_id, channel, items_added, total_before, total_added, total_after, customer_note, source_event_id)
  values (p_organization_id, p_property_id, p_order_id, p_channel, p_items, v_order.total, p_total_added, v_order.total + p_total_added, p_note, p_source_event_id)
  on conflict (order_id) where status = 'pendiente' do nothing
  returning id into v_id;
  if v_id is null then
    select a.id into v_id from restaurantes.order_amendments a where a.order_id = p_order_id and a.status = 'pendiente';
    v_estado := 'abierto';
  end if;
  return jsonb_build_object('estado', v_estado, 'agregado', restaurantes.agregado_vista_json(v_id));
end;
$$;
revoke all on function restaurantes.agregado_crear_sistema(uuid, uuid, uuid, text, jsonb, numeric, text, text) from public, anon;
grant execute on function restaurantes.agregado_crear_sistema(uuid, uuid, uuid, text, jsonb, numeric, text, text) to authenticated;

-- Relee una solicitud con los datos del pedido (para quien la creo o la cerro como sistema y no ve `orders`).
create function restaurantes.agregado_leer_sistema(p_amendment_id uuid) returns jsonb
language plpgsql stable security definer
set search_path = restaurantes, core, pg_temp
as $$
begin
  if auth.uid() is not null then
    raise exception 'agregado_leer_sistema es solo para la sesion de sistema' using errcode = '42501';
  end if;
  return restaurantes.agregado_vista_json(p_amendment_id);
end;
$$;
revoke all on function restaurantes.agregado_leer_sistema(uuid) from public, anon;
grant execute on function restaurantes.agregado_leer_sistema(uuid) to authenticated;

-- Pendientes con 10+ minutos (o lo que pida el llamador) con los datos del pedido: el barrido del SLA corre en una sesion de sistema entre organizaciones.
create function restaurantes.agregados_barrido_sistema(p_antes timestamptz, p_limite integer) returns jsonb
language plpgsql stable security definer
set search_path = restaurantes, core, pg_temp
as $$
begin
  if auth.uid() is not null then
    raise exception 'agregados_barrido_sistema es solo para la sesion de sistema' using errcode = '42501';
  end if;
  if p_limite is null or p_limite < 1 or p_limite > 500 then
    raise exception 'agregados_barrido_sistema: limite fuera de rango' using errcode = '22023';
  end if;
  return coalesce((
    select jsonb_agg(restaurantes.agregado_vista_json(x.id) order by x.requested_at)
    from (select a.id, a.requested_at from restaurantes.order_amendments a where a.status = 'pendiente' and a.requested_at <= p_antes order by a.requested_at limit p_limite) x
  ), '[]'::jsonb);
end;
$$;
revoke all on function restaurantes.agregados_barrido_sistema(timestamptz, integer) from public, anon;
grant execute on function restaurantes.agregados_barrido_sistema(timestamptz, integer) to authenticated;
