-- PM PR-3 + PR-4 (Los Taquitos de PM): recoger como canal completo, promociones automaticas
-- por dia y canal, combo de cortesia y puentes (horario por fecha). Una sola migracion con cuatro
-- piezas que comparten el prefijo de supabase/migrations asignado para esta tarea (20240101000213,
-- interno 028):
--
--   1. `restaurantes.orders`: columnas `canal`, `propina`, `hora_recogida`; estados nuevos
--      `listo_para_recoger` y `no_recogido`; `create_order_idempotent` las persiste.
--   2. `restaurantes.promotions`: tipo `cortesia` (N productos de una lista a $0 cuando el pedido
--      incluye un producto disparador), `auto_apply` (se aplica sola, sin codigo) y las columnas del
--      combo de cortesia.
--   3. `restaurantes.branch_hours_exception`: horario por FECHA de una sucursal (puentes: dos
--      sucursales extra abren con los dos turnos).
--
-- Decision de diseno: solo se AGREGAN columnas/tablas y se amplian dos CHECK (status, type); nada se
-- elimina. El codigo TypeScript que las consume degrada contra la base SIN migrar (SQLSTATE
-- 42703/42P01/42883, y 23514 al escribir un estado nuevo) dentro de SAVEPOINT, y NUNCA depende de que
-- esta migracion exista para seguir creando pedidos: `create_order_idempotent` viejo ignora las llaves
-- extra (`canal`, `propina`, `hora_recogida`) que el codigo ya manda en el jsonb.
--
-- Justificacion de seguridad de cada cambio (uno por uno):
--
--  * orders.canal / propina / hora_recogida -- columnas informativas nuevas. NO se agrega ningun GRANT
--    ni policy: heredan el GRANT de UPDATE de tabla de la migracion 007 y las policies RLS por
--    organizacion (el staff solo toca pedidos de SU organizacion; mismo nivel de confianza que ya
--    tiene sobre `total` y `notes`). `anon` sigue sin ningun acceso a `orders`. Los CHECK acotan el
--    dominio (canal in domicilio/recoger, propina >= 0 y <= 100000).
--  * orders_status_check -- se reemplaza ampliando la lista con los dos estados nuevos. No cambia
--    permisos. La maquina de estados real (que transiciones se permiten) vive en
--    `order-lifecycle.ts`; el CHECK solo acota el dominio de valores.
--  * create_order_idempotent -- `create or replace` con la MISMA firma, `security definer`, el MISMO
--    `set search_path = restaurantes` y la MISMA guarda `auth.uid() is not null -> 42501` de la
--    migracion 013 (solo la sesion de sistema la llama); unica diferencia: el INSERT incluye las tres
--    columnas nuevas. Los GRANT existentes se conservan (create or replace no los toca) y se vuelve a
--    revocar de public/anon por claridad. `canal` vacio -> null; el CHECK de la columna rechaza un
--    canal invalido en vez de guardarlo.
--  * promotions.auto_apply / courtesy_product_ids / courtesy_quantity -- columnas nuevas que heredan
--    los GRANT de tabla y las policies de la migracion 010 (staff de la organizacion gestiona las
--    suyas; select publico de promociones ACTIVAS que ya existia para resolver un codigo; las columnas
--    nuevas no son datos sensibles). Los CHECK nuevos son defensa en profundidad:
--      - `auto_apply` EXIGE `channels` explicito: una promocion que se aplica sola nunca puede quedar
--        sin restriccion de canal por omision (las de PM valen solo para recoger, nunca a domicilio).
--      - tipo `cortesia` exige lista disparadora (`product_ids`), lista de cortesia y 1..10 piezas, y
--        acota ambas listas (<= 50) para que un staff no infle la fila.
--      - los ids de las listas no tienen FK (Postgres no soporta FK por elemento): el motor solo los
--        compara contra los renglones del MISMO pedido y la API valida que cada id sea un producto de la
--        organizacion, asi que un id ajeno no puede alterar el pedido de otra organizacion.
--  * branch_hours_exception -- tabla nueva, RLS habilitado, `anon` sin NINGUN acceso. SELECT para staff
--    de la organizacion o sesion de sistema (`auth.uid() is null`: el agente de WhatsApp/voz debe leer
--    el horario para decidir si la sucursal esta abierta; mismo escape hatch que branch_policy). INSERT
--    /UPDATE/DELETE solo owner/admin; el `with check` exige que la property pertenezca a la
--    `organization_id` declarada (sin esto un owner de la org A escribiria una excepcion para una
--    sucursal de la org B). GRANT por COLUMNA: INSERT de las columnas reales y UPDATE solo de las que la
--    API edita (nunca organization_id/property_id: una fila no cambia de tenant ni de sucursal).
--    Sin funciones nuevas ni security definer.

-- ---------------------------------------------------------------------------
-- 1) orders: canal, propina, hora de recogida y estados de recoger
-- ---------------------------------------------------------------------------
alter table restaurantes.orders
  add column if not exists canal text check (canal is null or canal in ('domicilio', 'recoger')),
  add column if not exists propina numeric(10, 2) check (propina is null or (propina >= 0 and propina <= 100000)),
  add column if not exists hora_recogida timestamptz;

alter table restaurantes.orders drop constraint if exists orders_status_check;
alter table restaurantes.orders
  add constraint orders_status_check
  check (status in ('pending', 'preparando', 'en_camino', 'entregado', 'cancelado', 'completado', 'problema', 'listo_para_recoger', 'no_recogido'));

create index if not exists orders_org_canal_created_idx on restaurantes.orders (organization_id, canal, created_at desc);

-- create_order_idempotent: misma firma y postura de seguridad que la migracion 013, con las tres columnas nuevas.
create or replace function restaurantes.create_order_idempotent(
  p_order jsonb,
  p_dedupe_fingerprint text,
  p_idempotency_key text default null
) returns jsonb
language plpgsql
security definer
set search_path = restaurantes
as $$
declare
  v_order restaurantes.orders;
  v_organization_id uuid := (p_order->>'organization_id')::uuid;
  v_customer_id uuid := (p_order->>'customer_id')::uuid;
begin
  if auth.uid() is not null then
    raise exception 'create_order_idempotent es solo para la sesión de sistema' using errcode = '42501';
  end if;

  if p_dedupe_fingerprint !~ '^[0-9a-f]{64}$'
     or (p_idempotency_key is not null and p_idempotency_key !~ '^[0-9a-f]{64}$') then
    raise exception 'invalid idempotency input';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    v_organization_id::text || ':' || coalesce(p_idempotency_key, p_dedupe_fingerprint),
    0
  ));

  if p_idempotency_key is not null then
    select * into v_order from restaurantes.orders
    where organization_id = v_organization_id and idempotency_key = p_idempotency_key
    limit 1;
    if v_order.id is not null and v_order.dedupe_fingerprint is distinct from p_dedupe_fingerprint then
      raise sqlstate 'PT409' using message = 'idempotency key was already used with a different order payload';
    end if;
  else
    select * into v_order from restaurantes.orders
    where organization_id = v_organization_id
      and dedupe_fingerprint = p_dedupe_fingerprint
      and status = 'pending'
      and created_at >= now() - interval '5 minutes'
    order by created_at desc
    limit 1;
  end if;

  if v_order.id is not null then return to_jsonb(v_order); end if;

  insert into restaurantes.orders(
    customer_name, customer_phone, customer_address, customer_email, customer_id,
    organization_id, branch, property_id, total, status, items, source,
    call_transcript, call_recording_url, notes, payment_method,
    dedupe_fingerprint, idempotency_key, canal, propina, hora_recogida
  ) values (
    p_order->>'customer_name', p_order->>'customer_phone', nullif(p_order->>'customer_address', ''), nullif(p_order->>'customer_email', ''), v_customer_id,
    v_organization_id, p_order->>'branch', (p_order->>'property_id')::uuid,
    (p_order->>'total')::numeric, 'pending', p_order->'items', p_order->>'source',
    nullif(p_order->>'call_transcript', ''), nullif(p_order->>'call_recording_url', ''),
    nullif(p_order->>'notes', ''), nullif(p_order->>'payment_method', ''),
    p_dedupe_fingerprint, p_idempotency_key,
    nullif(p_order->>'canal', ''), nullif(p_order->>'propina', '')::numeric, nullif(p_order->>'hora_recogida', '')::timestamptz
  ) returning * into v_order;

  update restaurantes.customers
  set order_count = order_count + 1, last_order_at = now()
  where id = v_customer_id and organization_id = v_organization_id;

  return to_jsonb(v_order);
end;
$$;

revoke all on function restaurantes.create_order_idempotent(jsonb, text, text) from public, anon;

-- ---------------------------------------------------------------------------
-- 2) promotions: cortesia, auto_apply
-- ---------------------------------------------------------------------------
alter table restaurantes.promotions drop constraint if exists promotions_type_check;
alter table restaurantes.promotions
  add constraint promotions_type_check check (type in ('percentage', 'fixed', 'bogo', 'cortesia'));

-- Como bogo (027), el combo de cortesia no usa `value`: se fija en 1 (la tabla exige value > 0).
alter table restaurantes.promotions
  add constraint promotions_cortesia_value_check check (type <> 'cortesia' or value = 1);

alter table restaurantes.promotions
  add column if not exists auto_apply boolean not null default false,
  add column if not exists courtesy_product_ids uuid[],
  add column if not exists courtesy_quantity smallint;

alter table restaurantes.promotions
  add constraint promotions_courtesy_product_ids_check
  check (courtesy_product_ids is null or cardinality(courtesy_product_ids) between 1 and 50);
alter table restaurantes.promotions
  add constraint promotions_courtesy_quantity_check
  check (courtesy_quantity is null or courtesy_quantity between 1 and 10);
alter table restaurantes.promotions
  add constraint promotions_cortesia_shape_check
  check (type <> 'cortesia' or (product_ids is not null and courtesy_product_ids is not null and courtesy_quantity is not null));
alter table restaurantes.promotions
  add constraint promotions_auto_apply_channels_check
  check (not auto_apply or channels is not null);

create index if not exists promotions_org_auto_apply_idx on restaurantes.promotions (organization_id) where auto_apply and is_active;

-- ---------------------------------------------------------------------------
-- 3) branch_hours_exception (puentes)
-- ---------------------------------------------------------------------------
create table restaurantes.branch_hours_exception (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  -- Rango de FECHAS locales de la sucursal (inclusive) en que rige `horario` en lugar del horario
  -- semanal. Maximo 31 dias por excepcion: un puente, no un cambio de horario permanente.
  fecha_desde date not null,
  fecha_hasta date not null,
  -- Mismo formato que `branch_policy.horario`: [{"dias":[0..6],"abre":"HH:MM","cierra":"HH:MM"}].
  -- La forma del contenido la valida la capa de aplicacion (horarios.ts); aqui solo tipo y tamano.
  horario jsonb not null check (jsonb_typeof(horario) = 'array' and jsonb_array_length(horario) <= 28),
  motivo text check (motivo is null or char_length(motivo) between 1 and 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (fecha_hasta >= fecha_desde and fecha_hasta - fecha_desde <= 31)
);
create index branch_hours_exception_property_idx on restaurantes.branch_hours_exception (property_id, fecha_desde, fecha_hasta);
create index branch_hours_exception_org_idx on restaurantes.branch_hours_exception (organization_id);

alter table restaurantes.branch_hours_exception enable row level security;

create policy "staff o sistema lee las excepciones de horario" on restaurantes.branch_hours_exception for select
  using (
    auth.uid() is null
    or exists (
      select 1 from core.membership m
      where m.organization_id = branch_hours_exception.organization_id and m.user_id = auth.uid()
    )
  );

create policy "owner/admin crea excepciones de horario" on restaurantes.branch_hours_exception for insert
  with check (
    exists (
      select 1 from core.membership m
      where m.organization_id = branch_hours_exception.organization_id and m.user_id = auth.uid() and m.vertical_role in ('owner', 'admin')
    )
    and exists (
      select 1 from core.property p
      where p.id = branch_hours_exception.property_id and p.organization_id = branch_hours_exception.organization_id
    )
  );

create policy "owner/admin edita excepciones de horario" on restaurantes.branch_hours_exception for update
  using (
    exists (
      select 1 from core.membership m
      where m.organization_id = branch_hours_exception.organization_id and m.user_id = auth.uid() and m.vertical_role in ('owner', 'admin')
    )
  )
  with check (
    exists (
      select 1 from core.membership m
      where m.organization_id = branch_hours_exception.organization_id and m.user_id = auth.uid() and m.vertical_role in ('owner', 'admin')
    )
  );

create policy "owner/admin borra excepciones de horario" on restaurantes.branch_hours_exception for delete
  using (
    exists (
      select 1 from core.membership m
      where m.organization_id = branch_hours_exception.organization_id and m.user_id = auth.uid() and m.vertical_role in ('owner', 'admin')
    )
  );

revoke all on restaurantes.branch_hours_exception from public, anon;
grant select, delete on restaurantes.branch_hours_exception to authenticated;
grant insert (organization_id, property_id, fecha_desde, fecha_hasta, horario, motivo) on restaurantes.branch_hours_exception to authenticated;
grant update (fecha_desde, fecha_hasta, horario, motivo, updated_at) on restaurantes.branch_hours_exception to authenticated;
grant select, insert, update, delete on restaurantes.branch_hours_exception to service_role;
