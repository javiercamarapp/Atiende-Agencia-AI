-- Modelo de la vertical restaurantes para el primer cliente real (Los Taquitos de PM,
-- varias sucursales). Una sola migracion con cinco piezas que comparten el prefijo de
-- supabase/migrations asignado para esta tanda (20240101000196, interno 023):
--
--   1. `restaurantes.branch_policy` -- politica por SUCURSAL: horario (turnos, doble
--      turno, cierre pasada la medianoche), pedido minimo por canal (domicilio /
--      recoger) y politica de propina.
--   2. `restaurantes.products.no_domicilio` / `restaurantes.categories.no_domicilio` --
--      regla dura "no se vende a domicilio" (PM: el alcohol).
--   3. `restaurantes.branch_delivery_zone` -- que zonas conocidas (`known_zone`) cubre
--      cada sucursal para entregas a domicilio ("fuera de zona").
--   4. `restaurantes.whatsapp_branch_channel` -- un numero de WhatsApp POR SUCURSAL
--      (hasta hoy `whatsapp_channel_config` admite uno por organizacion).
--   5. Guardia de unicidad cruzada de `phone_number_id` entre `whatsapp_channel_config`
--      y `whatsapp_branch_channel`.
--
-- Decision de diseno: todo son tablas/columnas NUEVAS, ninguna modifica una restriccion
-- existente. El codigo TypeScript que las consume degrada con SAVEPOINT cuando la base
-- todavia no las tiene (SQLSTATE 42P01/42703/42883) -- nada de esto se aplica al mergear.
--
-- Justificacion de seguridad de cada GRANT / policy / funcion (una por una):
--
--  * branch_policy
--    - RLS habilitado; `revoke all` implicito: la tabla es nueva y el `alter default
--      privileges` de la plataforma no le da nada a `anon`, asi que `anon` no tiene
--      NINGUN acceso (ni lectura: el horario no es publico por esta via).
--    - SELECT para `authenticated`: policy `auth.uid() is null or <staff de la
--      organizacion>`. La rama `auth.uid() is null` es la sesion de SISTEMA del agente
--      de WhatsApp/voz (sin usuario) que debe leer el horario/minimos para cotizar; es
--      el mismo escape hatch que ya usan `whatsapp_channel_config` (017) y `known_zone`
--      (016). La tabla no guarda PII ni secretos.
--    - INSERT/UPDATE solo owner/admin de la organizacion (la politica comercial --
--      minimos, propina, horario -- es mas sensible que precios/disponibilidad, mismo
--      umbral que whatsapp_channel_config en 021). El `with check` exige ademas que
--      `property_id` pertenezca a `organization_id` (sin esto un owner de la org A
--      podria escribir una fila para una property de la org B declarando su propia org).
--    - GRANT por COLUMNA: las funciones reales solo escriben horario, minimos, propina
--      y updated_at (upsert por property_id). `organization_id` se concede solo en
--      INSERT (nunca en UPDATE: una fila no puede cambiar de tenant). Sin DELETE: no hay
--      caso de uso (se sobreescribe con null).
--
--  * products/categories.no_domicilio -- columna nueva con default false. Los GRANT de
--    escritura de 007 son a nivel de tabla para el staff de la organizacion y cubren la
--    columna nueva: es una marca de catalogo del mismo grano que is_available, no una
--    decision de seguridad. No se estrecha el GRANT existente (cambiaria el alcance de
--    lo que hoy ya escribe el panel).
--
--  * branch_delivery_zone
--    - SELECT igual que branch_policy (staff o sesion de sistema: el checkout lo lee).
--    - INSERT/DELETE solo owner/admin; el `with check` de INSERT exige que la property
--      y la zona pertenezcan a la MISMA `organization_id` declarada (cross-tenant).
--    - GRANT por columna en INSERT (property_id, zone_id, organization_id); sin UPDATE
--      (una cobertura se agrega o se quita, nunca se edita).
--
--  * whatsapp_branch_channel
--    - SELECT staff o sistema (el webhook entrante resuelve el numero sin usuario).
--    - INSERT/UPDATE/DELETE solo owner/admin; `with check` exige property de la misma
--      organizacion. GRANT por columna: UPDATE solo de phone_number_id (rotar el numero);
--      la sucursal y la organizacion no se mueven.
--    - `phone_number_id` es PRIMARY KEY (un numero rutea a una sola sucursal) y
--      `property_id` es UNIQUE (una sucursal, un numero).
--
--  * guard_whatsapp_phone_number_id() -- funcion de trigger `security definer` con
--    `set search_path` fijo y `revoke ... from public`. Necesita ser definer porque debe
--    mirar la tabla hermana SIN que RLS la oculte (si no, un owner de la org B no veria
--    que el numero ya es de la org A y podria secuestrar su ruteo). Solo compara
--    organization_id y lanza 23505; no lee ni devuelve datos.

-- ---------------------------------------------------------------------------
-- 1) branch_policy
-- ---------------------------------------------------------------------------
create table restaurantes.branch_policy (
  property_id uuid primary key references core.property(id) on delete cascade,
  organization_id uuid not null references core.organization(id) on delete cascade,
  -- Arreglo de turnos: [{"dias":[0..6],"abre":"HH:MM","cierra":"HH:MM"}]. `cierra <=
  -- abre` significa que el turno cruza la medianoche (ej. 12:00 -> 01:00). La forma del
  -- contenido la valida la capa de aplicacion (horarios.ts) antes de escribir; aqui
  -- solo se acota el tipo y el tamano.
  horario jsonb check (horario is null or (jsonb_typeof(horario) = 'array' and jsonb_array_length(horario) <= 28)),
  pedido_minimo_domicilio numeric(10, 2) check (pedido_minimo_domicilio is null or pedido_minimo_domicilio >= 0),
  pedido_minimo_recoger numeric(10, 2) check (pedido_minimo_recoger is null or pedido_minimo_recoger >= 0),
  propina_politica text check (propina_politica is null or propina_politica in ('nunca', 'siempre', 'solo_tarjeta')),
  updated_at timestamptz not null default now()
);

alter table restaurantes.branch_policy enable row level security;

create policy "staff o sistema lee la politica de sucursal" on restaurantes.branch_policy for select
  using (
    auth.uid() is null
    or exists (
      select 1 from core.membership m
      where m.organization_id = branch_policy.organization_id and m.user_id = auth.uid()
    )
  );

create policy "owner/admin crea la politica de su sucursal" on restaurantes.branch_policy for insert
  with check (
    exists (
      select 1 from core.membership m
      where m.organization_id = branch_policy.organization_id and m.user_id = auth.uid() and m.vertical_role in ('owner', 'admin')
    )
    and exists (
      select 1 from core.property p
      where p.id = branch_policy.property_id and p.organization_id = branch_policy.organization_id
    )
  );

create policy "owner/admin actualiza la politica de su sucursal" on restaurantes.branch_policy for update
  using (
    exists (
      select 1 from core.membership m
      where m.organization_id = branch_policy.organization_id and m.user_id = auth.uid() and m.vertical_role in ('owner', 'admin')
    )
  )
  with check (
    exists (
      select 1 from core.membership m
      where m.organization_id = branch_policy.organization_id and m.user_id = auth.uid() and m.vertical_role in ('owner', 'admin')
    )
  );

revoke all on restaurantes.branch_policy from public, anon;
grant select on restaurantes.branch_policy to authenticated;
grant insert (property_id, organization_id, horario, pedido_minimo_domicilio, pedido_minimo_recoger, propina_politica, updated_at)
  on restaurantes.branch_policy to authenticated;
grant update (horario, pedido_minimo_domicilio, pedido_minimo_recoger, propina_politica, updated_at)
  on restaurantes.branch_policy to authenticated;
grant select, insert, update, delete on restaurantes.branch_policy to service_role;

-- ---------------------------------------------------------------------------
-- 2) no_domicilio en catalogo
-- ---------------------------------------------------------------------------
alter table restaurantes.products add column no_domicilio boolean not null default false;
alter table restaurantes.categories add column no_domicilio boolean not null default false;

-- ---------------------------------------------------------------------------
-- 3) branch_delivery_zone
-- ---------------------------------------------------------------------------
create table restaurantes.branch_delivery_zone (
  property_id uuid not null references core.property(id) on delete cascade,
  zone_id uuid not null references restaurantes.known_zone(id) on delete cascade,
  organization_id uuid not null references core.organization(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (property_id, zone_id)
);
create index branch_delivery_zone_org_idx on restaurantes.branch_delivery_zone (organization_id);

alter table restaurantes.branch_delivery_zone enable row level security;

create policy "staff o sistema lee la cobertura de entrega" on restaurantes.branch_delivery_zone for select
  using (
    auth.uid() is null
    or exists (
      select 1 from core.membership m
      where m.organization_id = branch_delivery_zone.organization_id and m.user_id = auth.uid()
    )
  );

create policy "owner/admin agrega cobertura de entrega" on restaurantes.branch_delivery_zone for insert
  with check (
    exists (
      select 1 from core.membership m
      where m.organization_id = branch_delivery_zone.organization_id and m.user_id = auth.uid() and m.vertical_role in ('owner', 'admin')
    )
    and exists (
      select 1 from core.property p
      where p.id = branch_delivery_zone.property_id and p.organization_id = branch_delivery_zone.organization_id
    )
    and exists (
      select 1 from restaurantes.known_zone z
      where z.id = branch_delivery_zone.zone_id and z.organization_id = branch_delivery_zone.organization_id
    )
  );

create policy "owner/admin quita cobertura de entrega" on restaurantes.branch_delivery_zone for delete
  using (
    exists (
      select 1 from core.membership m
      where m.organization_id = branch_delivery_zone.organization_id and m.user_id = auth.uid() and m.vertical_role in ('owner', 'admin')
    )
  );

revoke all on restaurantes.branch_delivery_zone from public, anon;
grant select, delete on restaurantes.branch_delivery_zone to authenticated;
grant insert (property_id, zone_id, organization_id) on restaurantes.branch_delivery_zone to authenticated;
grant select, insert, update, delete on restaurantes.branch_delivery_zone to service_role;

-- ---------------------------------------------------------------------------
-- 4) whatsapp_branch_channel
-- ---------------------------------------------------------------------------
create table restaurantes.whatsapp_branch_channel (
  phone_number_id text primary key check (length(phone_number_id) between 1 and 255),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null unique references core.property(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index whatsapp_branch_channel_org_idx on restaurantes.whatsapp_branch_channel (organization_id);

alter table restaurantes.whatsapp_branch_channel enable row level security;

create policy "staff o sistema lee los numeros por sucursal" on restaurantes.whatsapp_branch_channel for select
  using (
    auth.uid() is null
    or exists (
      select 1 from core.membership m
      where m.organization_id = whatsapp_branch_channel.organization_id and m.user_id = auth.uid()
    )
  );

create policy "owner/admin conecta el whatsapp de una sucursal" on restaurantes.whatsapp_branch_channel for insert
  with check (
    exists (
      select 1 from core.membership m
      where m.organization_id = whatsapp_branch_channel.organization_id and m.user_id = auth.uid() and m.vertical_role in ('owner', 'admin')
    )
    and exists (
      select 1 from core.property p
      where p.id = whatsapp_branch_channel.property_id and p.organization_id = whatsapp_branch_channel.organization_id
    )
  );

create policy "owner/admin rota el whatsapp de una sucursal" on restaurantes.whatsapp_branch_channel for update
  using (
    exists (
      select 1 from core.membership m
      where m.organization_id = whatsapp_branch_channel.organization_id and m.user_id = auth.uid() and m.vertical_role in ('owner', 'admin')
    )
  )
  with check (
    exists (
      select 1 from core.membership m
      where m.organization_id = whatsapp_branch_channel.organization_id and m.user_id = auth.uid() and m.vertical_role in ('owner', 'admin')
    )
  );

create policy "owner/admin desconecta el whatsapp de una sucursal" on restaurantes.whatsapp_branch_channel for delete
  using (
    exists (
      select 1 from core.membership m
      where m.organization_id = whatsapp_branch_channel.organization_id and m.user_id = auth.uid() and m.vertical_role in ('owner', 'admin')
    )
  );

revoke all on restaurantes.whatsapp_branch_channel from public, anon;
grant select, delete on restaurantes.whatsapp_branch_channel to authenticated;
grant insert (phone_number_id, organization_id, property_id) on restaurantes.whatsapp_branch_channel to authenticated;
grant update (phone_number_id) on restaurantes.whatsapp_branch_channel to authenticated;
grant select, insert, update, delete on restaurantes.whatsapp_branch_channel to service_role;

-- ---------------------------------------------------------------------------
-- 5) Unicidad cruzada de phone_number_id
-- ---------------------------------------------------------------------------
create or replace function restaurantes.guard_whatsapp_phone_number_id()
returns trigger
language plpgsql
security definer
set search_path = restaurantes, pg_temp
as $$
begin
  if tg_table_name = 'whatsapp_branch_channel' then
    if exists (
      select 1 from restaurantes.whatsapp_channel_config c
      where c.phone_number_id = new.phone_number_id and c.organization_id <> new.organization_id
    ) then
      raise exception 'restaurantes_whatsapp_phone_number_id_en_uso: el numero ya esta conectado a otra organizacion'
        using errcode = '23505';
    end if;
  else
    if exists (
      select 1 from restaurantes.whatsapp_branch_channel b
      where b.phone_number_id = new.phone_number_id and b.organization_id <> new.organization_id
    ) then
      raise exception 'restaurantes_whatsapp_phone_number_id_en_uso: el numero ya esta conectado a otra organizacion'
        using errcode = '23505';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function restaurantes.guard_whatsapp_phone_number_id() from public, anon, authenticated;

create trigger whatsapp_branch_channel_guard_phone_number_id
  before insert or update of phone_number_id on restaurantes.whatsapp_branch_channel
  for each row execute function restaurantes.guard_whatsapp_phone_number_id();

create trigger whatsapp_channel_config_guard_phone_number_id
  before insert or update of phone_number_id on restaurantes.whatsapp_channel_config
  for each row execute function restaurantes.guard_whatsapp_phone_number_id();
