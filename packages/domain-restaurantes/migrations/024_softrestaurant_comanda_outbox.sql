-- SoftRestaurant: bandera por organizacion + outbox de comandas (Los Tacos de PM).
--
-- Contexto: la comanda se crea en el POS (SoftRestaurant) ANTES de cobrar y sale a
-- cocina. La API real del POS aun no existe para nosotros, asi que este archivo
-- solo crea lo que el dominio necesita para enchufar el adaptador despues:
--
--   1. `restaurantes.softrestaurant_config` -- bandera por organizacion
--      ('apagado' | 'sombra' | 'activo'). DEFAULT APAGADO: sin fila, o sin esta
--      migracion, el comportamiento actual queda intacto.
--   2. `restaurantes.pos_comanda_outbox` -- cola de comandas con maquina de estados
--      pendiente -> enviada -> confirmada | fallida -> captura_manual ->
--      capturada_manual (ver packages/domain-restaurantes/src/softrestaurant/).
--
-- Modelo de sesiones de este monorepo (ver 015_messaging_outbox_dispatch_*): el motor
-- SIEMPRE conecta como `set local role authenticated`; la "sesion de sistema" es esa
-- misma conexion con `auth.uid() is null`. Por eso las funciones de sistema llevan
-- `grant execute to authenticated` MAS el guard interno `auth.uid() is null`, y las
-- de staff exigen `auth.uid() is not null` + rol + membership.
--
-- JUSTIFICACION DE SEGURIDAD (cada GRANT / policy / funcion):
--
--   * Ambas tablas: RLS habilitada, `revoke all` de public/anon/authenticated/
--     service_role y NINGUN GRANT a anon. Nada de `using (true)`.
--   * `softrestaurant_config`: GRANT SELECT A NIVEL COLUMNA (organization_id, modo,
--     updated_at) a authenticated -- `updated_by` (id de staff) no se expone por
--     lectura directa. Policy de SELECT: solo miembros de la organizacion. Sin GRANT
--     de INSERT/UPDATE/DELETE: la unica escritura es `set_softrestaurant_modo`.
--   * `pos_comanda_outbox`: GRANT SELECT A NIVEL COLUMNA a authenticated con las
--     columnas que el panel de captura manual necesita (incluye `payload`, que trae
--     cliente/direccion/renglones porque el staff captura la comanda a mano desde
--     ahi); se OMITEN `idempotency_key` y `reclamada_en` (internas del worker).
--     Policy de SELECT: rol owner/admin/staff de la organizacion Y acceso a la
--     sucursal de la fila (`core.has_property_access`) -- un repartidor o un staff
--     restringido a otra sucursal no ve PII de comandas ajenas. SIN GRANT ni policy
--     de INSERT/UPDATE/DELETE para nadie: toda escritura pasa por las funciones
--     `security definer` de abajo (deny-by-default).
--   * `softrestaurant_modo(org)`: security definer, search_path fijo, revoke de
--     public/anon. Lectura de la bandera: sesion de sistema (auth.uid() is null, el
--     codigo ya resolvio la organizacion del request) o miembro de ESA organizacion.
--     Un miembro de otra organizacion recibe 42501 (cross-tenant).
--   * `set_softrestaurant_modo(org, modo)`: security definer. Solo owner/admin de la
--     organizacion; la sesion de sistema y cualquier otro rol reciben 42501. Cambiar
--     el modo a 'activo' manda comandas a un POS real, por eso es mas estrecho que
--     MANAGER_ROLES (mismo umbral que la config de WhatsApp, migracion 021).
--   * `pos_comanda_encolar`: SOLO sistema (auth.uid() is null). Valida que la
--     sucursal y el pedido pertenezcan a la organizacion indicada (nunca mezcla
--     tenants) y acota el payload. Idempotente: una fila por (organizacion, pedido).
--   * `pos_comanda_reclamar` / `pos_comanda_completar`: SOLO sistema. El reclamo usa
--     FOR UPDATE SKIP LOCKED (dos workers no toman la misma fila) y respeta la
--     bandera como interruptor de emergencia: con el modo 'apagado' no se reclama.
--   * `pos_comanda_marcar_capturada`: security definer, SOLO staff autenticado con
--     rol owner/admin/staff de la organizacion y acceso a la sucursal de la fila.
--     Solo transiciona filas pendiente/fallida/captura_manual (nunca una `enviada`
--     en vuelo ni una `confirmada`). Fila inexistente o de otra organizacion:
--     mismo error P0002 (no filtra existencia entre tenants).
--
-- Requiere: core (organization, property, membership, staff_user) y
-- 001_restaurantes_schema.sql (restaurantes.orders).

-- ---------------------------------------------------------------------------
-- 1) Bandera por organizacion
-- ---------------------------------------------------------------------------
create table restaurantes.softrestaurant_config (
  organization_id uuid primary key references core.organization(id) on delete cascade,
  modo text not null default 'apagado' check (modo in ('apagado', 'sombra', 'activo')),
  updated_by uuid references core.staff_user(id) on delete set null,
  updated_at timestamptz not null default now()
);

alter table restaurantes.softrestaurant_config enable row level security;
revoke all on restaurantes.softrestaurant_config from public, anon, authenticated, service_role;
grant select (organization_id, modo, updated_at) on restaurantes.softrestaurant_config to authenticated;

create policy "miembros ven la bandera de softrestaurant de su organizacion" on restaurantes.softrestaurant_config for select
  using (exists (
    select 1 from core.membership m
    where m.organization_id = softrestaurant_config.organization_id and m.user_id = auth.uid()
  ));

-- ---------------------------------------------------------------------------
-- 2) Outbox de comandas
-- ---------------------------------------------------------------------------
create table restaurantes.pos_comanda_outbox (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id),
  order_id uuid not null references restaurantes.orders(id) on delete cascade,
  idempotency_key text not null check (char_length(idempotency_key) between 1 and 200),
  estado text not null default 'pendiente'
    check (estado in ('pendiente', 'enviada', 'confirmada', 'fallida', 'captura_manual', 'capturada_manual')),
  modo text not null check (modo in ('sombra', 'activo')),
  payload jsonb not null check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 65536),
  intentos integer not null default 0 check (intentos >= 0),
  max_intentos integer not null default 5 check (max_intentos between 1 and 20),
  proximo_intento_en timestamptz not null default now(),
  reclamada_en timestamptz,
  folio text check (folio is null or char_length(folio) between 1 and 100),
  ultimo_error text check (ultimo_error is null or char_length(ultimo_error) <= 200),
  capturado_por uuid references core.staff_user(id) on delete set null,
  capturado_en timestamptz,
  nota_captura text check (nota_captura is null or char_length(nota_captura) <= 500),
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now(),
  -- Un folio solo puede existir si el POS confirmo: el agente nunca inventa folios.
  check (folio is null or estado = 'confirmada'),
  check (estado <> 'confirmada' or folio is not null),
  unique (organization_id, order_id),
  unique (organization_id, idempotency_key)
);

-- Patron de acceso del worker: filas reclamables por vencimiento.
create index pos_comanda_outbox_claim_idx
  on restaurantes.pos_comanda_outbox (proximo_intento_en)
  where estado in ('pendiente', 'fallida', 'enviada');
-- Patron de acceso del panel: por organizacion y estado, mas reciente primero.
create index pos_comanda_outbox_org_estado_idx
  on restaurantes.pos_comanda_outbox (organization_id, estado, creado_en desc);

alter table restaurantes.pos_comanda_outbox enable row level security;
revoke all on restaurantes.pos_comanda_outbox from public, anon, authenticated, service_role;
grant select (
  id, organization_id, property_id, order_id, estado, modo, payload, intentos, max_intentos,
  proximo_intento_en, folio, ultimo_error, capturado_por, capturado_en, nota_captura, creado_en, actualizado_en
) on restaurantes.pos_comanda_outbox to authenticated;

create policy "staff ve las comandas de softrestaurant de sus sucursales" on restaurantes.pos_comanda_outbox for select
  using (
    exists (
      select 1 from core.membership m
      where m.organization_id = pos_comanda_outbox.organization_id
        and m.user_id = auth.uid()
        and m.vertical_role in ('owner', 'admin', 'staff')
    )
    and core.has_property_access(auth.uid(), pos_comanda_outbox.property_id)
  );

-- ---------------------------------------------------------------------------
-- 3) Funciones
-- ---------------------------------------------------------------------------

-- Lectura de la bandera. Sin fila => 'apagado'.
create or replace function restaurantes.softrestaurant_modo(p_organization_id uuid)
returns text
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_modo text;
begin
  if auth.uid() is not null and not exists (
    select 1 from core.membership m where m.organization_id = p_organization_id and m.user_id = auth.uid()
  ) then
    raise exception 'restaurantes.softrestaurant_modo: el usuario no pertenece a la organizacion' using errcode = '42501';
  end if;
  select c.modo into v_modo from restaurantes.softrestaurant_config c where c.organization_id = p_organization_id;
  return coalesce(v_modo, 'apagado');
end;
$$;

-- Escritura de la bandera: solo owner/admin.
create or replace function restaurantes.set_softrestaurant_modo(p_organization_id uuid, p_modo text)
returns text
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
begin
  if v_actor is null then
    raise exception 'restaurantes.set_softrestaurant_modo: requiere un actor autenticado' using errcode = '42501';
  end if;
  if p_modo is null or p_modo not in ('apagado', 'sombra', 'activo') then
    raise exception 'restaurantes.set_softrestaurant_modo: modo invalido' using errcode = '22023';
  end if;
  if not exists (
    select 1 from core.membership m
    where m.organization_id = p_organization_id and m.user_id = v_actor and m.vertical_role in ('owner', 'admin')
  ) then
    raise exception 'restaurantes.set_softrestaurant_modo: solo owner/admin de la organizacion' using errcode = '42501';
  end if;
  insert into restaurantes.softrestaurant_config (organization_id, modo, updated_by, updated_at)
  values (p_organization_id, p_modo, v_actor, now())
  on conflict (organization_id) do update set modo = excluded.modo, updated_by = excluded.updated_by, updated_at = excluded.updated_at;
  return p_modo;
end;
$$;

-- Encolar (solo sistema). Idempotente por (organizacion, pedido).
create or replace function restaurantes.pos_comanda_encolar(
  p_organization_id uuid,
  p_property_id uuid,
  p_order_id uuid,
  p_idempotency_key text,
  p_modo text,
  p_payload jsonb,
  p_max_intentos integer default 5
)
returns setof restaurantes.pos_comanda_outbox
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
begin
  if auth.uid() is not null then
    raise exception 'restaurantes.pos_comanda_encolar es solo para la sesion de sistema' using errcode = '42501';
  end if;
  if p_modo is null or p_modo not in ('sombra', 'activo') then
    raise exception 'restaurantes.pos_comanda_encolar: modo invalido' using errcode = '22023';
  end if;
  if not exists (
    select 1 from restaurantes.orders o
    where o.id = p_order_id and o.organization_id = p_organization_id and o.property_id = p_property_id
  ) then
    raise exception 'restaurantes.pos_comanda_encolar: el pedido no pertenece a la organizacion/sucursal indicada' using errcode = '42501';
  end if;

  insert into restaurantes.pos_comanda_outbox (organization_id, property_id, order_id, idempotency_key, modo, payload, max_intentos)
  values (p_organization_id, p_property_id, p_order_id, p_idempotency_key, p_modo, p_payload, p_max_intentos)
  on conflict (organization_id, order_id) do nothing;

  return query
    select * from restaurantes.pos_comanda_outbox x
    where x.organization_id = p_organization_id and x.order_id = p_order_id;
end;
$$;

-- Reclamar (solo sistema). p_id null = lote; p_id = esa fila (intento inline).
create or replace function restaurantes.pos_comanda_reclamar(
  p_id uuid default null,
  p_limite integer default 10,
  p_lease_seconds integer default 120
)
returns setof restaurantes.pos_comanda_outbox
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
begin
  if auth.uid() is not null then
    raise exception 'restaurantes.pos_comanda_reclamar es solo para la sesion de sistema' using errcode = '42501';
  end if;
  if p_limite is null or p_limite < 1 or p_limite > 200 then
    raise exception 'restaurantes.pos_comanda_reclamar: limite invalido' using errcode = '22023';
  end if;
  if p_lease_seconds is null or p_lease_seconds < 1 or p_lease_seconds > 3600 then
    raise exception 'restaurantes.pos_comanda_reclamar: lease invalido' using errcode = '22023';
  end if;

  -- Un envio que murio a mitad (lease vencido) en su ULTIMO intento no se reclama
  -- otra vez: pasa a captura manual (no hay mas intentos que gastar).
  update restaurantes.pos_comanda_outbox x
  set estado = 'captura_manual', ultimo_error = 'lease_vencido:intentos_agotados', reclamada_en = null, actualizado_en = now()
  where x.estado = 'enviada'
    and x.reclamada_en < now() - make_interval(secs => p_lease_seconds)
    and x.intentos >= x.max_intentos
    and (p_id is null or x.id = p_id);

  return query
    update restaurantes.pos_comanda_outbox x
    set estado = 'enviada', intentos = x.intentos + 1, reclamada_en = now(), actualizado_en = now()
    where x.id in (
      select y.id from restaurantes.pos_comanda_outbox y
      left join restaurantes.softrestaurant_config c on c.organization_id = y.organization_id
      where (p_id is null or y.id = p_id)
        and coalesce(c.modo, 'apagado') <> 'apagado'
        and (
          (y.estado in ('pendiente', 'fallida') and y.proximo_intento_en <= now())
          or (y.estado = 'enviada' and y.reclamada_en < now() - make_interval(secs => p_lease_seconds))
        )
      order by y.proximo_intento_en, y.creado_en
      limit p_limite
      for update of y skip locked
    )
    returning x.*;
end;
$$;

-- Cerrar un intento (solo sistema). Solo desde 'enviada'.
create or replace function restaurantes.pos_comanda_completar(
  p_id uuid,
  p_estado text,
  p_folio text,
  p_ultimo_error text,
  p_proximo_intento timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_filas integer;
begin
  if auth.uid() is not null then
    raise exception 'restaurantes.pos_comanda_completar es solo para la sesion de sistema' using errcode = '42501';
  end if;
  if p_estado is null or p_estado not in ('confirmada', 'fallida', 'captura_manual') then
    raise exception 'restaurantes.pos_comanda_completar: estado destino invalido' using errcode = '22023';
  end if;
  if p_estado = 'confirmada' and (p_folio is null or btrim(p_folio) = '') then
    raise exception 'restaurantes.pos_comanda_completar: una comanda confirmada requiere el folio del POS' using errcode = '22023';
  end if;
  if p_estado = 'fallida' and p_proximo_intento is null then
    raise exception 'restaurantes.pos_comanda_completar: una comanda fallida requiere proximo intento' using errcode = '22023';
  end if;

  update restaurantes.pos_comanda_outbox x
  set estado = p_estado,
      folio = case when p_estado = 'confirmada' then left(p_folio, 100) else null end,
      ultimo_error = left(p_ultimo_error, 200),
      proximo_intento_en = case when p_estado = 'fallida' then p_proximo_intento else x.proximo_intento_en end,
      reclamada_en = null,
      actualizado_en = now()
  where x.id = p_id and x.estado = 'enviada';
  get diagnostics v_filas = row_count;
  return v_filas > 0;
end;
$$;

-- Captura manual (staff). Detiene los reintentos automaticos de esa comanda.
create or replace function restaurantes.pos_comanda_marcar_capturada(
  p_organization_id uuid,
  p_id uuid,
  p_nota text
)
returns restaurantes.pos_comanda_outbox
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_fila restaurantes.pos_comanda_outbox;
begin
  if v_actor is null then
    raise exception 'restaurantes.pos_comanda_marcar_capturada: requiere un actor autenticado' using errcode = '42501';
  end if;
  if not exists (
    select 1 from core.membership m
    where m.organization_id = p_organization_id and m.user_id = v_actor and m.vertical_role in ('owner', 'admin', 'staff')
  ) then
    raise exception 'restaurantes.pos_comanda_marcar_capturada: rol sin permiso' using errcode = '42501';
  end if;

  select * into v_fila
  from restaurantes.pos_comanda_outbox x
  where x.id = p_id and x.organization_id = p_organization_id
  for update;
  if not found or not core.has_property_access(v_actor, v_fila.property_id) then
    raise exception 'restaurantes.pos_comanda_marcar_capturada: comanda no encontrada' using errcode = 'P0002';
  end if;
  if v_fila.estado not in ('pendiente', 'fallida', 'captura_manual') then
    raise exception 'restaurantes.pos_comanda_marcar_capturada: estado % no permite captura manual', v_fila.estado using errcode = '55000';
  end if;

  update restaurantes.pos_comanda_outbox x
  set estado = 'capturada_manual', capturado_por = v_actor, capturado_en = now(), nota_captura = left(p_nota, 500),
      reclamada_en = null, actualizado_en = now()
  where x.id = p_id
  returning * into v_fila;
  return v_fila;
end;
$$;

revoke all on function restaurantes.softrestaurant_modo(uuid) from public, anon;
revoke all on function restaurantes.set_softrestaurant_modo(uuid, text) from public, anon;
revoke all on function restaurantes.pos_comanda_encolar(uuid, uuid, uuid, text, text, jsonb, integer) from public, anon;
revoke all on function restaurantes.pos_comanda_reclamar(uuid, integer, integer) from public, anon;
revoke all on function restaurantes.pos_comanda_completar(uuid, text, text, text, timestamptz) from public, anon;
revoke all on function restaurantes.pos_comanda_marcar_capturada(uuid, uuid, text) from public, anon;
grant execute on function restaurantes.softrestaurant_modo(uuid) to authenticated;
grant execute on function restaurantes.set_softrestaurant_modo(uuid, text) to authenticated;
grant execute on function restaurantes.pos_comanda_encolar(uuid, uuid, uuid, text, text, jsonb, integer) to authenticated;
grant execute on function restaurantes.pos_comanda_reclamar(uuid, integer, integer) to authenticated;
grant execute on function restaurantes.pos_comanda_completar(uuid, text, text, text, timestamptz) to authenticated;
grant execute on function restaurantes.pos_comanda_marcar_capturada(uuid, uuid, text) to authenticated;
