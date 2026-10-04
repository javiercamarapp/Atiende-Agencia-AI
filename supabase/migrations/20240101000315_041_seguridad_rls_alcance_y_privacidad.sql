-- QA R1 (restaurantes) -- defensa en profundidad de RLS/GRANT por ROL y por SUCURSAL, higiene de permisos y
-- privacidad (cancelacion ARCO ejecutable + retencion completa). Prefijo de supabase/migrations: 20240101000315.
--
-- Contexto: hasta aqui las policies de escritura y de lectura de datos personales solo pedian "existe una membresia
-- de la organizacion". La capa TypeScript SI distingue rol y sucursal (assertVerticalRole + resolveEffectivePropertyIds),
-- pero una sesion SQL con el JWT de un repartidor o de un staff acotado a una sucursal podia leer pedidos ajenos y
-- reescribir pedidos, catalogo y promociones. Esta migracion lleva a la base la misma regla que ya aplica la API.
--
-- Todo es ADITIVO o ENDURECE: ninguna operacion nueva se concede; se estrechan policies y GRANT. El codigo TypeScript
-- sigue funcionando contra la base SIN migrar (no depende de nada de aqui salvo las funciones nuevas de privacidad, que
-- degradan con SQLSTATE 42883 dentro de SAVEPOINT; ver postgres-repository.ts de privacidad).
--
-- Quien conserva acceso (nada cambia para ellos): la sesion de SISTEMA (auth.uid() is null, rol authenticated) entra por
-- las funciones security definer y por las policies "sistema" que ya existian; service_role no se toca.
--
-- 0) Funciones auxiliares (security definer, STABLE, search_path fijo, revoke de public/anon):
--    justificacion: las policies no pueden consultar core.membership directamente porque `authenticated` no tiene SELECT
--    sobre una membresia ajena; ademas centralizar la regla evita que cada policy la reescriba distinto. Devuelven false
--    (nunca error) sin sesion (auth.uid() null), asi la sesion de sistema nunca gana acceso por aqui.
--      * actor_gestor(org)                      -- owner/admin/staff de la organizacion (rol, sin importar la sucursal).
--      * actor_gestiona_sucursal(org, property) -- gestor cuya membresia incluye esa sucursal (property_ids null = todas).
--      * actor_gestiona_alcance(org, ids)       -- gestor cuya membresia cubre TODAS las sucursales de `ids`; con `ids` null
--                                                  (alcance "toda la organizacion") exige una membresia sin acotar.
--      * actor_repartidor_asignado(org, uid)    -- el repartidor de la organizacion que es el asignado de esa fila.
--    telefono_clave(text): misma regla que phone.ts::normalizePhone (ultimos 10 digitos) para cruzar telefonos entre
--    canales (WhatsApp guarda "+521...", voz "+52...", pedidos 10 digitos). IMMUTABLE y sin acceso a tablas.

create or replace function restaurantes.actor_gestor(p_organization_id uuid)
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
       and m.vertical_role in ('owner', 'admin', 'staff')
  );
$$;

create or replace function restaurantes.actor_gestiona_sucursal(p_organization_id uuid, p_property_id uuid)
returns boolean
language sql
stable
security definer
set search_path = core, pg_temp
as $$
  select auth.uid() is not null and p_property_id is not null and exists (
    select 1 from core.membership m
     where m.user_id = auth.uid()
       and m.organization_id = p_organization_id
       and m.vertical_role in ('owner', 'admin', 'staff')
       and (m.property_ids is null or p_property_id = any (m.property_ids))
       and exists (select 1 from core.property p where p.id = p_property_id and p.organization_id = p_organization_id)
  );
$$;

create or replace function restaurantes.actor_gestiona_alcance(p_organization_id uuid, p_property_ids uuid[])
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
       and m.vertical_role in ('owner', 'admin', 'staff')
       and (m.property_ids is null or (p_property_ids is not null and p_property_ids <@ m.property_ids))
  );
$$;

create or replace function restaurantes.actor_repartidor_asignado(p_organization_id uuid, p_asignado uuid)
returns boolean
language sql
stable
security definer
set search_path = core, pg_temp
as $$
  select auth.uid() is not null and p_asignado is not null and p_asignado = auth.uid() and exists (
    select 1 from core.membership m
     where m.user_id = auth.uid()
       and m.organization_id = p_organization_id
       and m.vertical_role = 'repartidor'
  );
$$;

create or replace function restaurantes.telefono_clave(p_telefono text)
returns text
language sql
immutable
set search_path = pg_catalog
as $$
  select case
    when length(regexp_replace(coalesce(p_telefono, ''), '\D', '', 'g')) >= 7
      then right(regexp_replace(p_telefono, '\D', '', 'g'), 10)
    else btrim(coalesce(p_telefono, ''))
  end;
$$;

revoke all on function restaurantes.actor_gestor(uuid) from public, anon;
revoke all on function restaurantes.actor_gestiona_sucursal(uuid, uuid) from public, anon;
revoke all on function restaurantes.actor_gestiona_alcance(uuid, uuid[]) from public, anon;
revoke all on function restaurantes.actor_repartidor_asignado(uuid, uuid) from public, anon;
revoke all on function restaurantes.telefono_clave(text) from public, anon;
grant execute on function restaurantes.actor_gestor(uuid) to authenticated, service_role;
grant execute on function restaurantes.actor_gestiona_sucursal(uuid, uuid) to authenticated, service_role;
grant execute on function restaurantes.actor_gestiona_alcance(uuid, uuid[]) to authenticated, service_role;
grant execute on function restaurantes.actor_repartidor_asignado(uuid, uuid) to authenticated, service_role;
grant execute on function restaurantes.telefono_clave(text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 1) QA-R1-seguridad-01 -- ESCRITURA por rol y sucursal
-- ---------------------------------------------------------------------------

-- 1a) orders. UPDATE por COLUMNA: solo lo que las rutas reales escriben (estado y entrega, asignacion de repartidor y
--     su hora estimada, nota de incidencia). Nunca total, items, telefono ni organization_id: un pedido ya creado no
--     cambia su importe desde una sesion de staff. (Las tres sentencias UPDATE de postgres-repository.ts escriben
--     exactamente estas columnas; el alta pasa por create_order_idempotent, security definer.)
revoke update on restaurantes.orders from authenticated;
grant update (status, delivered_at, assigned_repartidor_id, estimated_delivery_at, incident_note) on restaurantes.orders to authenticated;

drop policy if exists "staff actualiza pedidos de su organización" on restaurantes.orders;
create policy "gestor de la sucursal o repartidor asignado actualiza pedidos" on restaurantes.orders for update
  using (
    restaurantes.actor_gestiona_sucursal(organization_id, property_id)
    or restaurantes.actor_repartidor_asignado(organization_id, assigned_repartidor_id)
  )
  with check (
    restaurantes.actor_gestiona_sucursal(organization_id, property_id)
    or restaurantes.actor_repartidor_asignado(organization_id, assigned_repartidor_id)
  );

-- 1b) catalogo de la organizacion (categories, products): solo roles gestores escriben. El catalogo es de toda la
--     organizacion (no tiene sucursal), asi que el alcance es el rol; la lectura sigue en las policies de 014.
drop policy if exists "staff gestiona categorías de su organización" on restaurantes.categories;
create policy "gestores insertan categorias" on restaurantes.categories for insert
  with check (restaurantes.actor_gestor(organization_id));
create policy "gestores actualizan categorias" on restaurantes.categories for update
  using (restaurantes.actor_gestor(organization_id)) with check (restaurantes.actor_gestor(organization_id));
create policy "gestores borran categorias" on restaurantes.categories for delete
  using (restaurantes.actor_gestor(organization_id));

drop policy if exists "staff gestiona productos de su organización" on restaurantes.products;
create policy "gestores insertan productos" on restaurantes.products for insert
  with check (restaurantes.actor_gestor(organization_id));
create policy "gestores actualizan productos" on restaurantes.products for update
  using (restaurantes.actor_gestor(organization_id)) with check (restaurantes.actor_gestor(organization_id));
create policy "gestores borran productos" on restaurantes.products for delete
  using (restaurantes.actor_gestor(organization_id));

-- 1c) branch_products y branch_detail: rol gestor Y sucursal de la membresia (precio/disponibilidad y datos de la sucursal).
--     branch_products solo tiene GRANT de insert/update (007): se conserva; la policy "for all" se divide para que el
--     comando DELETE (sin GRANT) no quede como letra muerta.
drop policy if exists "staff gestiona branch_products de su organización" on restaurantes.branch_products;
create policy "gestores de la sucursal insertan branch_products" on restaurantes.branch_products for insert
  with check (exists (
    select 1 from core.property p
     where p.id = branch_products.property_id
       and restaurantes.actor_gestiona_sucursal(p.organization_id, p.id)
  ));
create policy "gestores de la sucursal actualizan branch_products" on restaurantes.branch_products for update
  using (exists (
    select 1 from core.property p
     where p.id = branch_products.property_id
       and restaurantes.actor_gestiona_sucursal(p.organization_id, p.id)
  ))
  with check (exists (
    select 1 from core.property p
     where p.id = branch_products.property_id
       and restaurantes.actor_gestiona_sucursal(p.organization_id, p.id)
  ));

drop policy if exists "staff actualiza detalle de sucursal de su organización" on restaurantes.branch_detail;
create policy "gestores de la sucursal actualizan el detalle" on restaurantes.branch_detail for update
  using (restaurantes.actor_gestiona_sucursal(organization_id, property_id))
  with check (restaurantes.actor_gestiona_sucursal(organization_id, property_id));

-- 1d) promotions: escritura solo de roles gestores y dentro del alcance de la membresia. Una promocion SIN sucursales
--     (property_ids null = toda la organizacion) solo la gestiona una membresia sin acotar; una promocion acotada solo la
--     gestiona quien cubre todas sus sucursales.
drop policy if exists "staff gestiona promociones de su organización" on restaurantes.promotions;
create policy "gestores crean promociones dentro de su alcance" on restaurantes.promotions for insert
  with check (restaurantes.actor_gestiona_alcance(organization_id, property_ids));
create policy "gestores actualizan promociones dentro de su alcance" on restaurantes.promotions for update
  using (restaurantes.actor_gestiona_alcance(organization_id, property_ids))
  with check (restaurantes.actor_gestiona_alcance(organization_id, property_ids));
create policy "gestores borran promociones dentro de su alcance" on restaurantes.promotions for delete
  using (restaurantes.actor_gestiona_alcance(organization_id, property_ids));

-- ---------------------------------------------------------------------------
-- 2) QA-R1-seguridad-02 -- SELECT de promotions acotado por organizacion
--    Antes: "cualquiera puede ver promociones activas" (is_active = true, sin organizacion) dejaba a CUALQUIER sesion
--    autenticada leer los codigos activos de otras organizaciones. Mismo arreglo que 014 aplico al catalogo: la sesion de
--    SISTEMA (auth.uid() null: checkout web/voz/WhatsApp) resuelve solo promociones ACTIVAS; un usuario ve solo las de su
--    organizacion y solo si es gestor (un repartidor no necesita los codigos).
-- ---------------------------------------------------------------------------
drop policy if exists "cualquiera puede ver promociones activas" on restaurantes.promotions;
drop policy if exists "staff ve promociones de su organización" on restaurantes.promotions;
create policy "sistema resuelve promociones activas" on restaurantes.promotions for select
  using (auth.uid() is null and is_active = true);
create policy "gestores ven las promociones de su organizacion" on restaurantes.promotions for select
  using (restaurantes.actor_gestor(organization_id));

-- ---------------------------------------------------------------------------
-- 3) QA-R1-seguridad-03 -- LECTURA de datos personales por rol y sucursal
--    orders: gestor de la sucursal del pedido o el repartidor al que esta asignado (el repartidor nunca ve el resto).
--    customers / customer_addresses: memoria de cliente por organizacion (sin sucursal) -> solo roles gestores.
--    callback_requests / whatsapp_conversations: gestor de la sucursal (property_id) o, si la fila no tiene sucursal,
--    una membresia sin acotar (mismo criterio que handoff_actor_en_sucursal en 028).
-- ---------------------------------------------------------------------------
drop policy if exists "staff ve pedidos de su organización" on restaurantes.orders;
create policy "gestor de la sucursal o repartidor asignado ve pedidos" on restaurantes.orders for select
  using (
    restaurantes.actor_gestiona_sucursal(organization_id, property_id)
    or restaurantes.actor_repartidor_asignado(organization_id, assigned_repartidor_id)
  );

drop policy if exists "staff ve clientes de su organización" on restaurantes.customers;
create policy "gestores ven clientes de su organizacion" on restaurantes.customers for select
  using (restaurantes.actor_gestor(organization_id));

drop policy if exists "staff ve direcciones de sus clientes" on restaurantes.customer_addresses;
create policy "gestores ven direcciones de sus clientes" on restaurantes.customer_addresses for select
  using (exists (
    select 1 from restaurantes.customers c
     where c.id = customer_addresses.customer_id
       and restaurantes.actor_gestor(c.organization_id)
  ));

drop policy if exists "staff ve solicitudes de contacto de su organización" on restaurantes.callback_requests;
create policy "gestores ven solicitudes de contacto de su alcance" on restaurantes.callback_requests for select
  using (
    case when property_id is null
      then restaurantes.actor_gestiona_alcance(organization_id, null)
      else restaurantes.actor_gestiona_sucursal(organization_id, property_id)
    end
  );

drop policy if exists "staff ve conversaciones de whatsapp de su organización" on restaurantes.whatsapp_conversations;
create policy "gestores ven conversaciones de whatsapp de su alcance" on restaurantes.whatsapp_conversations for select
  using (
    case when property_id is null
      then restaurantes.actor_gestiona_alcance(organization_id, null)
      else restaurantes.actor_gestiona_sucursal(organization_id, property_id)
    end
  );

-- ---------------------------------------------------------------------------
-- 4) QA-R1-seguridad-11 -- higiene de permisos
--    * anon NO necesita SELECT de nada de esto (el checkout publico entra por la sesion de sistema, rol authenticated con
--      auth.uid() null; nadie conecta como anon). Fallaba cerrado por RLS, pero contradecia la regla "nunca GRANT a anon".
--    * Las funciones invoker de KPI, nivel de cliente y zona quedaban ejecutables por PUBLIC (y por anon): revoke y
--      GRANT explicito a authenticated/service_role (siguen siendo invoker: RLS aplica a quien las llama).
--    * Las funciones de trigger no necesitan EXECUTE para dispararse (basta el permiso al crear el trigger).
--    * demo_limpiar (solo operador) fijaba search_path = pg_catalog, public: se fija sin `public` (todas sus referencias
--      ya van calificadas con restaurantes./core.).
-- ---------------------------------------------------------------------------
revoke select on restaurantes.categories, restaurantes.products, restaurantes.branch_products,
  restaurantes.branch_detail, restaurantes.promotions from anon;

revoke all on function restaurantes.calc_customer_tier(uuid, uuid) from public, anon;
revoke all on function restaurantes.calc_customer_tier_distribution(uuid) from public, anon;
revoke all on function restaurantes.orders_bucketed_stats(uuid, uuid[], timestamptz[], timestamptz[]) from public, anon;
revoke all on function restaurantes.orders_channel_stats(uuid, uuid[]) from public, anon;
revoke all on function restaurantes.whatsapp_conversation_stats(uuid, uuid[]) from public, anon;
revoke all on function restaurantes.get_customer_overview_kpis(uuid) from public, anon;
revoke all on function restaurantes.nearest_branch_by_colonia(uuid, text) from public, anon;
grant execute on function restaurantes.calc_customer_tier(uuid, uuid) to authenticated, service_role;
grant execute on function restaurantes.calc_customer_tier_distribution(uuid) to authenticated, service_role;
grant execute on function restaurantes.orders_bucketed_stats(uuid, uuid[], timestamptz[], timestamptz[]) to authenticated, service_role;
grant execute on function restaurantes.orders_channel_stats(uuid, uuid[]) to authenticated, service_role;
grant execute on function restaurantes.whatsapp_conversation_stats(uuid, uuid[]) to authenticated, service_role;
grant execute on function restaurantes.get_customer_overview_kpis(uuid) to authenticated, service_role;
grant execute on function restaurantes.nearest_branch_by_colonia(uuid, text) to authenticated, service_role;

revoke all on function restaurantes.audit_log_block_mutation() from public, anon;
revoke all on function restaurantes.data_rights_events_block_mutation() from public, anon;
revoke all on function restaurantes.callback_requests_sync_status() from public, anon;

alter function restaurantes.demo_limpiar(uuid, text, integer) set search_path = pg_catalog, pg_temp;

-- ---------------------------------------------------------------------------
-- 5) QA-R1-seguridad-06/07/10/14 -- privacidad
-- ---------------------------------------------------------------------------

-- 5a) Bitacora de voz (voice_tool_audit): es append-only por trigger. La retencion necesita borrar filas vencidas SIN abrir
--     la puerta a nadie mas: el trigger permite DELETE solo cuando la funcion de purga (security definer, solo sistema) marca
--     la transaccion con un parametro local. Nadie tiene GRANT de DELETE sobre la tabla, asi que el parametro solo lo puede
--     usar esa funcion; UPDATE sigue bloqueado siempre.
create or replace function restaurantes.voice_tool_audit_block_mutation()
returns trigger
language plpgsql
set search_path = restaurantes, pg_temp
as $$
begin
  if tg_op = 'DELETE' and coalesce(current_setting('restaurantes.purga_privacidad', true), '') = 'on' then
    return old;
  end if;
  raise exception 'restaurantes_voice_tool_audit_append_only: % no esta permitido sobre restaurantes.voice_tool_audit', tg_op
    using errcode = '0A000';
end;
$$;
revoke all on function restaurantes.voice_tool_audit_block_mutation() from public, anon;

-- 5b) Telefonos del titular con solicitud ARCO abierta (solo sistema): la purga TypeScript calcula con la llave del
--     servidor los seudonimos de voz de cada telefono y los pasa a la purga SQL (la base no conoce esa llave).
create or replace function restaurantes.system_list_open_arco_phones(p_limit integer default 1000, p_organization_id uuid default null)
returns table (out_organization_id uuid, out_customer_phone text)
language plpgsql
stable
security definer
set search_path = restaurantes, core, pg_temp
as $$
begin
  if auth.uid() is not null then
    raise exception 'system_list_open_arco_phones es solo para la sesion de sistema' using errcode = '42501';
  end if;
  return query
    select r.organization_id, r.customer_phone
      from restaurantes.data_rights_requests r
     where r.status in ('recibida', 'en_proceso', 'bloqueada') and (p_organization_id is null or r.organization_id = p_organization_id)
     order by r.created_at
     limit least(greatest(coalesce(p_limit, 1000), 1), 5000);
end;
$$;
revoke all on function restaurantes.system_list_open_arco_phones(integer, uuid) from public, anon;
grant execute on function restaurantes.system_list_open_arco_phones(integer, uuid) to authenticated;

-- 5c) Ejecucion de la cancelacion ARCO (QA-R1-seguridad-06). Funcion INTERNA: nadie la ejecuta directamente (revoke total);
--     la invoca update_data_rights_request_status (security definer, ya valido owner/admin y la organizacion de la solicitud).
--       modo 'bloqueo'    -> el titular pidio cancelar y los datos se BLOQUEAN: se borra lo que el agente usa para
--                            personalizar (direcciones, memoria de conversacion de WhatsApp, estado de flujo, turnos de voz);
--                            los pedidos y el cliente se conservan solo como registro (obligaciones legales).
--       modo 'supresion'  -> cancelacion resuelta: ademas se ANONIMIZAN pedido, cliente, conversacion, solicitudes de
--                            contacto y cola de mensajes del titular. Importes y productos de los pedidos se conservan
--                            (contabilidad), sin nombre, telefono, correo, direccion ni transcripcion.
--     El cruce es por telefono_clave (ultimos 10 digitos): WhatsApp (+521...), voz (+52...) y pedidos (10 digitos) coinciden.
--     La voz se cruza por caller_hash, que se recibe ya calculado por el servidor (llave propia, ver p_caller_hashes).
--     Devuelve los conteos para la bitacora.
create or replace function restaurantes.arco_ejecutar_cancelacion(
  p_organization_id uuid,
  p_customer_phone text,
  p_modo text,
  p_caller_hashes text[]
)
returns jsonb
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_clave text := restaurantes.telefono_clave(p_customer_phone);
  v_hashes text[] := coalesce(p_caller_hashes, '{}'::text[]) ||
    array(select encode(sha256(convert_to(d, 'UTF8')), 'hex')
            from unnest(array[
              regexp_replace(p_customer_phone, '\D', '', 'g'),
              right(regexp_replace(p_customer_phone, '\D', '', 'g'), 10),
              '52' || right(regexp_replace(p_customer_phone, '\D', '', 'g'), 10),
              '521' || right(regexp_replace(p_customer_phone, '\D', '', 'g'), 10)
            ]) as d where d <> '');
  v_pedidos integer := 0;
  v_clientes integer := 0;
  v_direcciones integer := 0;
  v_conversaciones integer := 0;
  v_callbacks integer := 0;
  v_outbox integer := 0;
  v_comandas integer := 0;
  v_flujos integer := 0;
  v_turnos integer := 0;
  v_llamadas integer := 0;
  v_order_ids uuid[];
begin
  if p_modo not in ('bloqueo', 'supresion') then
    raise exception 'arco_ejecutar_cancelacion: modo invalido' using errcode = '22023';
  end if;
  if length(regexp_replace(coalesce(p_customer_phone, ''), '\D', '', 'g')) < 7 then
    -- Sin un telefono utilizable no hay a quien cruzar; nunca se borra "por parecido".
    return jsonb_build_object('modo', p_modo, 'omitido', 'telefono_no_utilizable');
  end if;

  select coalesce(array_agg(o.id), '{}') into v_order_ids
    from restaurantes.orders o
   where o.organization_id = p_organization_id and restaurantes.telefono_clave(o.customer_phone) = v_clave;

  -- Comunes a bloqueo y supresion: lo que el agente usa para personalizar.
  delete from restaurantes.customer_addresses a
   using restaurantes.customers c
   where a.customer_id = c.id and c.organization_id = p_organization_id and restaurantes.telefono_clave(c.phone) = v_clave;
  get diagnostics v_direcciones = row_count;

  update restaurantes.whatsapp_conversations w set messages = '[]'::jsonb
   where w.organization_id = p_organization_id and restaurantes.telefono_clave(w.phone) = v_clave and w.messages <> '[]'::jsonb;
  get diagnostics v_conversaciones = row_count;

  delete from restaurantes.order_flow_state f
   where f.organization_id = p_organization_id and f.flow_key like 'wa:%' and restaurantes.telefono_clave(substr(f.flow_key, 4)) = v_clave;
  get diagnostics v_flujos = row_count;

  delete from restaurantes.voice_turn t
   using restaurantes.voice_conversation c
   where t.conversation_id = c.id and c.organization_id = p_organization_id and c.caller_hash = any (v_hashes);
  get diagnostics v_turnos = row_count;

  if p_modo = 'supresion' then
    update restaurantes.voice_conversation c set caller_hash = null
     where c.organization_id = p_organization_id and c.caller_hash = any (v_hashes);
    get diagnostics v_llamadas = row_count;

    update restaurantes.orders o
       set customer_name = 'Titular (cancelacion ARCO)', customer_phone = 'anonimizado', customer_address = null,
           customer_email = null, customer_id = null, call_transcript = null, call_recording_url = null, notes = null
     where o.id = any (v_order_ids);
    get diagnostics v_pedidos = row_count;

    update restaurantes.staff_order_notification n set message = 'Pedido anonimizado'
     where n.organization_id = p_organization_id and n.order_id = any (v_order_ids);

    update restaurantes.customers c
       set name = null, phone = 'anon-' || translate(c.id::text, '0123456789-', 'ghijklmnopq'), updated_at = now()
     where c.organization_id = p_organization_id and restaurantes.telefono_clave(c.phone) = v_clave;
    get diagnostics v_clientes = row_count;

    update restaurantes.whatsapp_conversations w
       set phone = 'anon-' || translate(w.id::text, '0123456789-', 'ghijklmnopq')
     where w.organization_id = p_organization_id and restaurantes.telefono_clave(w.phone) = v_clave;

    update restaurantes.callback_requests r
       set customer_name = 'Titular (cancelacion ARCO)', customer_phone = 'anonimizado', message = null, reason = null
     where r.organization_id = p_organization_id and restaurantes.telefono_clave(r.customer_phone) = v_clave;
    get diagnostics v_callbacks = row_count;

    -- Cola de mensajes ya enviados o agotados: se borra (lleva telefono y texto). Los pendientes tambien: el titular
    -- pidio cancelar y no debe recibir mas mensajes.
    delete from restaurantes.messaging_outbox m
     where m.organization_id = p_organization_id
       and (
         (m.channel = 'whatsapp' and restaurantes.telefono_clave(m.payload ->> 'to') = v_clave)
         or exists (select 1 from unnest(v_order_ids) oid where m.dedupe_key like '%' || oid::text || '%')
       );
    get diagnostics v_outbox = row_count;

    -- Comandas del POS de pedidos del titular: se quita el cliente del payload en las que ya terminaron su ciclo.
    update restaurantes.pos_comanda_outbox p
       set payload = jsonb_set(p.payload, '{cliente}', jsonb_build_object('nombre', 'Titular (cancelacion ARCO)', 'telefono', 'anonimizado'))
     where p.organization_id = p_organization_id and p.order_id = any (v_order_ids)
       and p.estado not in ('pendiente', 'captura_manual') and p.payload ? 'cliente';
    get diagnostics v_comandas = row_count;
  end if;

  return jsonb_build_object(
    'modo', p_modo, 'pedidos', v_pedidos, 'clientes', v_clientes, 'direcciones', v_direcciones,
    'conversaciones', v_conversaciones, 'solicitudes_contacto', v_callbacks, 'mensajes_en_cola', v_outbox,
    'comandas', v_comandas, 'flujos', v_flujos, 'turnos_voz', v_turnos, 'llamadas', v_llamadas
  );
end;
$$;
revoke all on function restaurantes.arco_ejecutar_cancelacion(uuid, text, text, text[]) from public, anon, authenticated, service_role;

-- 5d) update_data_rights_request_status con ejecucion real. Mismas validaciones, mismos codigos de error y mismo contrato
--     que en 030; agrega p_caller_hashes (seudonimos de voz del titular calculados por el servidor). En una cancelacion:
--     'bloqueada' bloquea el uso de los datos y 'resuelta' los suprime/anonimiza, en la MISMA transaccion y con evidencia en
--     la bitacora (conteos, sin datos personales). El cuerpo de 4 argumentos de 030 se conserva como envoltorio sin hashes.
create or replace function restaurantes.update_data_rights_request_status(
  p_organization_id uuid,
  p_request_id uuid,
  p_new_status text,
  p_note text,
  p_caller_hashes text[]
)
returns table (out_id uuid, out_status text)
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_role text;
  v_row restaurantes.data_rights_requests%rowtype;
  v_from text;
  v_ok boolean;
  v_efecto jsonb;
begin
  if v_actor is null then
    raise exception 'restaurantes.update_data_rights_request_status: requiere un actor autenticado' using errcode = '28000';
  end if;

  select m.vertical_role into v_role
    from core.membership m
   where m.organization_id = p_organization_id and m.user_id = v_actor;
  if v_role is null or v_role not in ('owner', 'admin') then
    raise exception 'restaurantes.update_data_rights_request_status: solo owner/admin de la organizacion' using errcode = '42501';
  end if;

  if p_new_status is null or p_new_status not in ('en_proceso', 'bloqueada', 'resuelta', 'rechazada') then
    raise exception 'restaurantes.update_data_rights_request_status: estado destino invalido' using errcode = '22023';
  end if;
  if p_new_status = 'rechazada' and (p_note is null or btrim(p_note) = '') then
    raise exception 'restaurantes.update_data_rights_request_status: rechazar exige un motivo' using errcode = '22023';
  end if;

  select * into v_row
    from restaurantes.data_rights_requests r
   where r.id = p_request_id and r.organization_id = p_organization_id
   for update;
  if not found then
    raise exception 'restaurantes.update_data_rights_request_status: solicitud no encontrada' using errcode = 'P0002';
  end if;

  v_from := v_row.status;
  v_ok := case
    when v_from = 'recibida' then p_new_status in ('en_proceso', 'bloqueada', 'resuelta', 'rechazada')
    when v_from = 'en_proceso' then p_new_status in ('bloqueada', 'resuelta', 'rechazada')
    when v_from = 'bloqueada' then p_new_status in ('resuelta', 'rechazada')
    else false
  end;
  if p_new_status = 'bloqueada' and v_row.right_type <> 'cancelacion' then
    v_ok := false;
  end if;
  if not v_ok then
    raise exception 'restaurantes.update_data_rights_request_status: transicion % -> % no permitida', v_from, p_new_status using errcode = '55000';
  end if;

  update restaurantes.data_rights_requests
     set status = p_new_status,
         handled_by = v_actor,
         resolution_note = case when p_new_status in ('resuelta', 'rechazada') then left(p_note, 1000) else resolution_note end,
         resolved_at = case when p_new_status in ('resuelta', 'rechazada') then now() else resolved_at end,
         updated_at = now()
   where id = v_row.id;

  insert into restaurantes.data_rights_events (organization_id, request_id, actor_user_id, actor_kind, event, from_status, to_status, note)
  values (p_organization_id, v_row.id, v_actor, 'staff', 'cambio_estado', v_from, p_new_status, left(p_note, 500));

  if v_row.right_type = 'cancelacion' and p_new_status in ('bloqueada', 'resuelta') then
    v_efecto := restaurantes.arco_ejecutar_cancelacion(
      p_organization_id, v_row.customer_phone,
      case when p_new_status = 'resuelta' then 'supresion' else 'bloqueo' end,
      p_caller_hashes
    );
    -- Evidencia del efecto real (solo conteos): el titular puede pedir constancia de que se ejecuto.
    insert into restaurantes.data_rights_events (organization_id, request_id, actor_user_id, actor_kind, event, from_status, to_status, note)
    values (p_organization_id, v_row.id, v_actor, 'sistema', 'cambio_estado', p_new_status, p_new_status,
            left('Cancelacion ejecutada: ' || v_efecto::text, 500));
  end if;

  return query select v_row.id, p_new_status;
end;
$$;
revoke all on function restaurantes.update_data_rights_request_status(uuid, uuid, text, text, text[]) from public, anon;
grant execute on function restaurantes.update_data_rights_request_status(uuid, uuid, text, text, text[]) to authenticated;

create or replace function restaurantes.update_data_rights_request_status(
  p_organization_id uuid,
  p_request_id uuid,
  p_new_status text,
  p_note text
)
returns table (out_id uuid, out_status text)
language sql
security definer
set search_path = restaurantes, core, pg_temp
as $$
  select * from restaurantes.update_data_rights_request_status(p_organization_id, p_request_id, p_new_status, p_note, '{}'::text[]);
$$;
revoke all on function restaurantes.update_data_rights_request_status(uuid, uuid, text, text) from public, anon;
grant execute on function restaurantes.update_data_rights_request_status(uuid, uuid, text, text) to authenticated;

-- 5e) Purga por retencion ampliada (QA-R1-seguridad-07, 10, 14). Solo sistema. Cambios sobre 030:
--     * cubre tambien callback_requests (anonimiza), messaging_outbox y pos_comanda_outbox ya terminados (quita telefono y
--       texto del payload), conversation_note y voice_tool_audit (borra), con los dias de retencion de la organizacion
--       (la cola de mensajes, fija en 30 dias: solo sirve para reintentar un envio);
--     * el bloqueo por solicitud ARCO abierta compara por telefono_clave (WhatsApp y voz del mismo titular se protegen entre si)
--       y la voz tambien por los seudonimos pasados en p_protected_hashes (llave del servidor) y por los sha256 calculables aqui;
--     * devuelve `out_pendiente`: true si algun lote se lleno (queda trabajo), para que el cron siga de forma correcta.
--     La firma de 1 argumento de 030 se conserva como envoltorio con el mismo resultado de 3 columnas.
create or replace function restaurantes.system_purge_expired_privacy_data(p_limit integer, p_protected_hashes text[])
returns table (
  out_conversations_cleared integer,
  out_voice_turns_deleted integer,
  out_voice_calls_anonymized integer,
  out_callbacks_anonymized integer,
  out_outbox_scrubbed integer,
  out_notes_deleted integer,
  out_audit_deleted integer,
  out_pendiente boolean
)
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 500), 1), 5000);
  v_conv integer := 0;
  v_turns integer := 0;
  v_calls integer := 0;
  v_cb integer := 0;
  v_outbox integer := 0;
  v_pos integer := 0;
  v_notes integer := 0;
  v_audit integer := 0;
  v_calls_pend boolean := false;
  v_protegidos text[] := coalesce(p_protected_hashes, '{}'::text[]) ||
    array(
      select encode(sha256(convert_to(d, 'UTF8')), 'hex')
        from restaurantes.data_rights_requests r
        cross join lateral unnest(array[
          regexp_replace(r.customer_phone, '\D', '', 'g'),
          right(regexp_replace(r.customer_phone, '\D', '', 'g'), 10),
          '52' || right(regexp_replace(r.customer_phone, '\D', '', 'g'), 10),
          '521' || right(regexp_replace(r.customer_phone, '\D', '', 'g'), 10)
        ]) as d
       where r.status in ('recibida', 'en_proceso', 'bloqueada') and d <> '' and d <> '52' and d <> '521'
    );
begin
  if auth.uid() is not null then
    raise exception 'system_purge_expired_privacy_data es solo para la sesion de sistema' using errcode = '42501';
  end if;

  -- 1) conversaciones de WhatsApp (mensajes)
  with victims as (
    select w.id
      from restaurantes.whatsapp_conversations w
      left join restaurantes.privacy_config pc on pc.organization_id = w.organization_id
     where w.messages <> '[]'::jsonb
       and w.updated_at < now() - make_interval(days => coalesce(pc.conversation_retention_days, 180))
       and not exists (
         select 1 from restaurantes.data_rights_requests r
          where r.organization_id = w.organization_id
            and restaurantes.telefono_clave(r.customer_phone) = restaurantes.telefono_clave(w.phone)
            and r.status in ('recibida', 'en_proceso', 'bloqueada')
       )
     order by w.updated_at
     limit v_limit
  ), cleared as (
    update restaurantes.whatsapp_conversations w set messages = '[]'::jsonb
      from victims v where w.id = v.id
    returning 1
  )
  select count(*) into v_conv from cleared;

  -- 2) llamadas de voz (turnos y caller_hash). Una llamada sin caller_hash y sin turnos ya no entra al lote.
  with old_calls as (
    select c.id, (c.caller_hash is not null) as con_hash
      from restaurantes.voice_conversation c
      left join restaurantes.privacy_config pc on pc.organization_id = c.organization_id
     where (c.ended_at is not null or c.started_at < now() - interval '1 day')
       and c.started_at < now() - make_interval(days => coalesce(pc.voice_retention_days, 30))
       and (
         exists (select 1 from restaurantes.voice_turn t where t.conversation_id = c.id)
         or c.caller_hash is not null
       )
       and not (c.caller_hash is not null and c.caller_hash = any (v_protegidos))
     order by c.started_at
     limit v_limit
  ), del_turns as (
    delete from restaurantes.voice_turn t using old_calls o where t.conversation_id = o.id returning 1
  ), anon as (
    update restaurantes.voice_conversation c set caller_hash = null
      from old_calls o where c.id = o.id and c.caller_hash is not null returning 1
  )
  select (select count(*) from del_turns), (select count(*) from anon), (select count(*) >= v_limit from old_calls)
    into v_turns, v_calls, v_calls_pend;

  -- 3) solicitudes de contacto: anonimiza las mas viejas que la retencion de conversaciones
  with victims as (
    select r.id
      from restaurantes.callback_requests r
      left join restaurantes.privacy_config pc on pc.organization_id = r.organization_id
     where r.created_at < now() - make_interval(days => coalesce(pc.conversation_retention_days, 180))
       and (r.customer_phone <> 'anonimizado' or r.message is not null)
       and not exists (
         select 1 from restaurantes.data_rights_requests q
          where q.organization_id = r.organization_id
            and restaurantes.telefono_clave(q.customer_phone) = restaurantes.telefono_clave(r.customer_phone)
            and q.status in ('recibida', 'en_proceso', 'bloqueada')
       )
     order by r.created_at
     limit v_limit
  ), scrubbed as (
    update restaurantes.callback_requests r
       set customer_name = 'Titular anonimizado', customer_phone = 'anonimizado', message = null, reason = null
      from victims v where r.id = v.id
    returning 1
  )
  select count(*) into v_cb from scrubbed;

  -- 4) cola de mensajes (payload con telefono/correo y texto) ya enviada o agotada hace mas de 30 dias
  with victims as (
    select m.id
      from restaurantes.messaging_outbox m
     where m.status in ('sent', 'dead', 'failed')
       and m.created_at < now() - interval '30 days'
       and m.payload <> '{}'::jsonb
       and not exists (
         select 1 from restaurantes.data_rights_requests q
          where q.organization_id = m.organization_id
            and q.status in ('recibida', 'en_proceso', 'bloqueada')
            and restaurantes.telefono_clave(q.customer_phone) = restaurantes.telefono_clave(m.payload ->> 'to')
       )
     order by m.created_at
     limit v_limit
  ), scrubbed as (
    update restaurantes.messaging_outbox m set payload = '{}'::jsonb
      from victims v where m.id = v.id
    returning 1
  )
  select count(*) into v_outbox from scrubbed;

  -- 4b) comandas del POS ya terminadas: se quita el cliente del payload tras la retencion de conversaciones
  with victims as (
    select p.id
      from restaurantes.pos_comanda_outbox p
      left join restaurantes.privacy_config pc on pc.organization_id = p.organization_id
     where p.estado not in ('pendiente', 'captura_manual')
       and p.creado_en < now() - make_interval(days => coalesce(pc.conversation_retention_days, 180))
       and p.payload ? 'cliente'
       and (p.payload -> 'cliente' ->> 'telefono') is distinct from 'anonimizado'
     order by p.creado_en
     limit v_limit
  ), scrubbed as (
    update restaurantes.pos_comanda_outbox p
       set payload = jsonb_set(p.payload, '{cliente}', jsonb_build_object('nombre', 'Titular anonimizado', 'telefono', 'anonimizado'))
      from victims v where p.id = v.id
    returning 1
  )
  select count(*) into v_pos from scrubbed;
  v_outbox := v_outbox + v_pos;

  -- 5) notas internas de conversacion (texto libre del personal)
  with victims as (
    select n.id
      from restaurantes.conversation_note n
      left join restaurantes.privacy_config pc on pc.organization_id = n.organization_id
     where n.created_at < now() - make_interval(days => coalesce(pc.conversation_retention_days, 180))
     order by n.created_at
     limit v_limit
  ), gone as (
    delete from restaurantes.conversation_note n using victims v where n.id = v.id returning 1
  )
  select count(*) into v_notes from gone;

  -- 6) bitacora de voz (seudonimo del telefono y detalle): se conserva la retencion de conversaciones de la organizacion
  perform set_config('restaurantes.purga_privacidad', 'on', true);
  with victims as (
    select a.id
      from restaurantes.voice_tool_audit a
      left join restaurantes.privacy_config pc on pc.organization_id = a.organization_id
     where a.created_at < now() - make_interval(days => coalesce(pc.conversation_retention_days, 180))
     order by a.created_at
     limit v_limit
  ), gone as (
    delete from restaurantes.voice_tool_audit a using victims v where a.id = v.id returning 1
  )
  select count(*) into v_audit from gone;
  perform set_config('restaurantes.purga_privacidad', 'off', true);

  return query select v_conv, v_turns, v_calls, v_cb, v_outbox, v_notes, v_audit,
    (v_conv >= v_limit or v_calls_pend or v_cb >= v_limit or v_notes >= v_limit or v_audit >= v_limit or v_outbox >= v_limit);
end;
$$;
revoke all on function restaurantes.system_purge_expired_privacy_data(integer, text[]) from public, anon;
grant execute on function restaurantes.system_purge_expired_privacy_data(integer, text[]) to authenticated;

create or replace function restaurantes.system_purge_expired_privacy_data(p_limit integer default 500)
returns table (out_conversations_cleared integer, out_voice_turns_deleted integer, out_voice_calls_anonymized integer)
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
begin
  if auth.uid() is not null then
    raise exception 'system_purge_expired_privacy_data es solo para la sesion de sistema' using errcode = '42501';
  end if;
  return query
    select p.out_conversations_cleared, p.out_voice_turns_deleted, p.out_voice_calls_anonymized
      from restaurantes.system_purge_expired_privacy_data(p_limit, '{}'::text[]) p;
end;
$$;
revoke all on function restaurantes.system_purge_expired_privacy_data(integer) from public, anon;
grant execute on function restaurantes.system_purge_expired_privacy_data(integer) to authenticated;

-- 5f) Purga de PLATAFORMA (core.system_run_retention_purge, 0036; cron diario /internal/plataforma/privacidad-retencion) para las
--     clases restaurantes_*: misma proteccion de titulares con ARCO abierta (recibida/en_proceso/bloqueada) que la purga 5e.
--     Defecto que corrige: la 0036 protegia la voz solo por el sha256 de UN formato de telefono y WhatsApp por igualdad literal;
--     con ACTOR_HASH_KEY (seudonimo HMAC, QA R1 seguridad-08) los caller_hash nuevos no coincidian y el cron borraba los
--     turnos de voz de quien tiene una solicitud abierta (incluida una de acceso).
--     Cambios: (a) WhatsApp compara por restaurantes.telefono_clave (ultimos 10 digitos); (b) la voz se protege por los
--     seudonimos que pasa el servidor en p_protected_hashes mas los sha256 de las 4 variantes del telefono de cada solicitud
--     abierta de la organizacion; (c) la firma de 4 argumentos queda como envoltorio (p_protected_hashes nulo), asi un
--     llamador viejo sigue funcionando. Justificacion de seguridad: solo sistema (auth.uid() is null, 42501 si no),
--     security definer con search_path fijo, revoke de public/anon, sin GRANT nuevo a anon; la lista de hashes solo AMPLIA lo
--     protegido (nunca borra mas). Se aplica solo si la 0036 ya esta en la base (si no, no hay nada que reemplazar).
do $arco_plataforma$
begin
  if to_regprocedure('core.system_run_retention_purge(uuid,text,boolean,integer)') is null then
    raise notice '041 5f: core.system_run_retention_purge no existe (0036 sin aplicar); se omite';
    return;
  end if;
  execute $fn$
create or replace function core.system_run_retention_purge(p_org uuid, p_data_class text, p_dry_run boolean, p_limit integer, p_protected_hashes text[])
returns table (out_run_id uuid, out_status text, out_retention_days integer, out_rows_affected integer, out_rows_anonymized integer, out_rows_protected integer)
language plpgsql security definer set search_path = core, restaurantes, pg_temp as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 500), 1), 5000);
  v_dry boolean := coalesce(p_dry_run, false);
  v_class core.retention_class%rowtype;
  v_days integer;
  v_cutoff timestamptz;
  v_affected integer := 0;
  v_anon integer := 0;
  v_protected integer := 0;
  v_status text;
  v_blocked text;
  v_id uuid;
  v_protegidos text[];
begin
  if auth.uid() is not null then
    raise exception 'system_run_retention_purge: solo para la sesion de sistema' using errcode = '42501';
  end if;
  if not exists (select 1 from core.organization o where o.id = p_org) then
    raise exception 'system_run_retention_purge: la organizacion no existe' using errcode = '22023';
  end if;
  -- Seudonimos de voz a proteger: los que pasa el servidor (HMAC, con la llave que la base no conoce) mas los sha256 planos
  -- de todas las variantes del telefono de cada solicitud ARCO abierta de ESTA organizacion (filas anteriores a la llave).
  v_protegidos := coalesce(p_protected_hashes, '{}'::text[]) ||
    array(
      select encode(sha256(convert_to(d, 'UTF8')), 'hex')
        from restaurantes.data_rights_requests r
        cross join lateral unnest(array[
          regexp_replace(r.customer_phone, '\D', '', 'g'),
          right(regexp_replace(r.customer_phone, '\D', '', 'g'), 10),
          '52' || right(regexp_replace(r.customer_phone, '\D', '', 'g'), 10),
          '521' || right(regexp_replace(r.customer_phone, '\D', '', 'g'), 10)
        ]) as d
       where r.organization_id = p_org and r.status in ('recibida', 'en_proceso', 'bloqueada') and d <> '' and d <> '52' and d <> '521'
    );
  select * into v_class from core.retention_class c where c.data_class = p_data_class;
  if not found then
    raise exception 'system_run_retention_purge: clase de dato desconocida' using errcode = '22023';
  end if;

  select e.out_days into v_days from core._retention_effective(p_org, p_data_class) e;
  v_cutoff := now() - make_interval(days => v_days);

  if v_class.executor <> 'plataforma' then
    v_status := 'sin_ejecutor';
  elsif exists (
    select 1 from core.purge_hold h
     where h.organization_id = p_org and h.released_at is null and (h.data_class is null or h.data_class = p_data_class)
  ) then
    v_status := 'bloqueada';
    v_blocked := 'retencion_legal_activa';
  elsif p_data_class = 'restaurantes_whatsapp_conversaciones' then
    select count(*) into v_protected
      from restaurantes.whatsapp_conversations w
     where w.organization_id = p_org and w.messages <> '[]'::jsonb and w.updated_at < v_cutoff
       and exists (
         select 1 from restaurantes.data_rights_requests r
          where r.organization_id = w.organization_id and restaurantes.telefono_clave(r.customer_phone) = restaurantes.telefono_clave(w.phone) and r.status in ('recibida', 'en_proceso', 'bloqueada')
       );
    if v_dry then
      select count(*) into v_affected from (
        select 1 from restaurantes.whatsapp_conversations w
         where w.organization_id = p_org and w.messages <> '[]'::jsonb and w.updated_at < v_cutoff
           and not exists (
             select 1 from restaurantes.data_rights_requests r
              where r.organization_id = w.organization_id and restaurantes.telefono_clave(r.customer_phone) = restaurantes.telefono_clave(w.phone) and r.status in ('recibida', 'en_proceso', 'bloqueada')
           )
         order by w.updated_at limit v_limit
      ) s;
    else
      with victims as (
        select w.id from restaurantes.whatsapp_conversations w
         where w.organization_id = p_org and w.messages <> '[]'::jsonb and w.updated_at < v_cutoff
           and not exists (
             select 1 from restaurantes.data_rights_requests r
              where r.organization_id = w.organization_id and restaurantes.telefono_clave(r.customer_phone) = restaurantes.telefono_clave(w.phone) and r.status in ('recibida', 'en_proceso', 'bloqueada')
           )
         order by w.updated_at limit v_limit
      ), cleared as (
        update restaurantes.whatsapp_conversations w set messages = '[]'::jsonb from victims v where w.id = v.id returning 1
      )
      select count(*) into v_affected from cleared;
    end if;
    v_status := case when v_dry then 'simulacion' else 'ok' end;
  elsif p_data_class = 'restaurantes_voz_transcripciones' then
    select count(*) into v_protected
      from restaurantes.voice_conversation c
     where c.organization_id = p_org and (c.ended_at is not null or c.started_at < now() - interval '1 day') and c.started_at < v_cutoff
       and (exists (select 1 from restaurantes.voice_turn t where t.conversation_id = c.id) or c.caller_hash is not null)
       and c.caller_hash = any (v_protegidos);
    if v_dry then
      select count(*), count(*) filter (where s.has_hash) into v_affected, v_anon from (
        select c.caller_hash is not null as has_hash
          from restaurantes.voice_conversation c
         where c.organization_id = p_org and (c.ended_at is not null or c.started_at < now() - interval '1 day') and c.started_at < v_cutoff
           and (exists (select 1 from restaurantes.voice_turn t where t.conversation_id = c.id) or c.caller_hash is not null)
           and not coalesce(c.caller_hash = any (v_protegidos), false)
         order by c.started_at limit v_limit
      ) s;
      -- En simulacion rows_affected cuenta llamadas candidatas (no turnos): se documenta en el catalogo.
    else
      with old_calls as (
        select c.id from restaurantes.voice_conversation c
         where c.organization_id = p_org and (c.ended_at is not null or c.started_at < now() - interval '1 day') and c.started_at < v_cutoff
           and (exists (select 1 from restaurantes.voice_turn t where t.conversation_id = c.id) or c.caller_hash is not null)
           and not coalesce(c.caller_hash = any (v_protegidos), false)
         order by c.started_at limit v_limit
      ), del_turns as (
        delete from restaurantes.voice_turn t using old_calls o where t.conversation_id = o.id returning 1
      ), anon as (
        update restaurantes.voice_conversation c set caller_hash = null from old_calls o where c.id = o.id and c.caller_hash is not null returning 1
      )
      select (select count(*) from del_turns), (select count(*) from anon) into v_affected, v_anon;
    end if;
    v_status := case when v_dry then 'simulacion' else 'ok' end;
  else
    v_status := 'sin_ejecutor';
  end if;

  insert into core.purge_run_log (organization_id, data_class, status, retention_days, cutoff_at, rows_affected, rows_anonymized, rows_protected, blocked_reason)
  values (p_org, p_data_class, v_status, v_days, v_cutoff, v_affected, v_anon, v_protected, v_blocked)
  returning id into v_id;

  return query select v_id, v_status, v_days, v_affected, v_anon, v_protected;
end;
$$;
  $fn$;
  execute 'revoke all on function core.system_run_retention_purge(uuid, text, boolean, integer, text[]) from public, anon';
  execute 'grant execute on function core.system_run_retention_purge(uuid, text, boolean, integer, text[]) to authenticated';
  execute $fn$
create or replace function core.system_run_retention_purge(p_org uuid, p_data_class text, p_dry_run boolean default false, p_limit integer default 500)
returns table (out_run_id uuid, out_status text, out_retention_days integer, out_rows_affected integer, out_rows_anonymized integer, out_rows_protected integer)
language plpgsql security definer set search_path = core, restaurantes, pg_temp as $$
begin
  if auth.uid() is not null then
    raise exception 'system_run_retention_purge: solo para la sesion de sistema' using errcode = '42501';
  end if;
  return query select * from core.system_run_retention_purge(p_org, p_data_class, p_dry_run, p_limit, null::text[]);
end;
$$;
  $fn$;
end
$arco_plataforma$;
