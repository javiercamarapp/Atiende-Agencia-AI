-- Conocimiento del negocio (politicas, preguntas frecuentes, avisos temporales), interruptor DURO del agente de WhatsApp por sucursal y
-- bandera de saludo no interrumpible de la llamada (restaurantes). Prefijo de supabase/migrations asignado para esta tanda:
-- 20240101000323 (interno 053).
--
-- Decision de diseno: dos tablas NUEVAS y UNA columna nueva con valor por omision que conserva el comportamiento actual. Nada se
-- renombra ni se borra. El codigo TypeScript que las usa degrada con SAVEPOINT (SQLSTATE 42P01/42703/42883/42501) a "sin conocimiento
-- cargado", "agente de WhatsApp encendido" y "saludo interrumpible" cuando la base todavia no tiene esta migracion: nada de esto se aplica
-- al mergear.
--
-- Justificacion de seguridad de cada tabla / GRANT / policy (una por una):
--
--  1) restaurantes.conocimiento_negocio
--   * RLS habilitado y `revoke all ... from public, anon`: `anon` no tiene NINGUN acceso.
--   * SELECT para `authenticated`: policy `auth.uid() is null or <miembro de la organizacion>`. La rama `auth.uid() is null` es la sesion de
--     SISTEMA del webhook de WhatsApp y de la llamada (sin usuario), que debe leer el conocimiento vigente para armar el prompt; mismo escape
--     hatch que `branch_policy` (023) y `whatsapp_agent_config` (029). La tabla guarda texto de negocio ya publicado al cliente (politicas y
--     preguntas frecuentes): no guarda PII, credenciales ni secretos. Un validador de aplicacion rechaza precios y nombres del catalogo
--     (el precio sale siempre de cotizar_pedido); la base solo acota longitudes y tipos.
--   * INSERT/UPDATE/DELETE solo owner/admin de la organizacion (lo que se le dice al cliente en nombre del negocio pesa mas que el
--     catalogo: mismo umbral que 029). El `with check` exige que `property_id`, cuando no es null, pertenezca a `organization_id`.
--   * `reemplaza_id` NO se valida en una policy (una policy que consulta su propia tabla recursa: lo reprodujo la verificacion contra Postgres
--     real) sino en el trigger `guard_conocimiento_reemplaza()`: `security definer` con `set search_path` fijo y `revoke ... from public`
--     (mismo patron que `guard_whatsapp_phone_number_id`, 023). Necesita ser definer porque debe mirar la fila apuntada SIN que RLS la
--     oculte (si no, un owner de la org A no veria que el id es de la org B y no podria rechazarlo con certeza). Solo compara organization_id
--     y property_id de la fila apuntada y lanza 23514 si no es una entrada GENERAL de la MISMA organizacion; no devuelve datos.
--   * GRANT por COLUMNA: las funciones reales solo escriben titulo, texto, tipo, prioridad, vigencia, activo, estado, reemplaza_id, version,
--     actualizado_por y updated_at (upsert/edicion). `organization_id`, `property_id`, `origen` y `creado_por` se conceden solo en INSERT
--     (una fila no cambia de tenant, de sucursal ni de autor). DELETE a authenticated va acotado por la policy a owner/admin: borrar un aviso
--     que ya no aplica es una accion legitima y la bitacora (restaurantes.audit_log, escrita por el API) conserva el rastro.
--   * Longitudes y rangos con CHECK: el texto llega al prompt del agente; un tope de 2000 caracteres por entrada limita la superficie de texto
--     libre que un owner (o una cuenta comprometida) puede inyectar, y la vigencia no puede invertirse.
--   * `estado` 'borrador' | 'publicado': los borradores salen de importar un documento y NUNCA llegan al agente hasta que una persona los
--     aprueba (el lector del agente exige estado = 'publicado' y activo).
--
--  2) restaurantes.whatsapp_sucursal_control
--   * Una fila por sucursal con `agente_activo` (por omision true = como hoy). Es un control DURO: con false el turno no llama al modelo.
--   * Mismas policies y GRANT por columna que branch_policy (023): SELECT staff o sistema (el webhook sin usuario debe leerla antes del modelo),
--     INSERT/UPDATE solo owner/admin con `with check` de sucursal-de-la-organizacion, sin DELETE (para volver a encender se pone true). INSERT
--     concede organization_id/property_id una sola vez; UPDATE solo agente_activo, actualizado_por y updated_at. `anon` sin acceso.
--
--  3) restaurantes.branch_voice_config.mensaje_inicial_interrumpible
--   * Booleano NOT NULL default true (el saludo se puede interrumpir, como hasta hoy). Con false la maquina de la llamada ignora el barge-in
--     durante el saludo (aviso de asistente virtual y grabacion completo). Se amplian los GRANT por COLUMNA de INSERT y UPDATE de
--     `authenticated` a esta sola columna; las policies de 025 (solo owner/admin) siguen protegiendo escritura y cross-tenant.

-- ---------------------------------------------------------------------------
-- 1) conocimiento_negocio
-- ---------------------------------------------------------------------------
create table restaurantes.conocimiento_negocio (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  -- null = conocimiento de toda la organizacion; con valor = solo esa sucursal.
  property_id uuid references core.property(id) on delete cascade,
  -- Entrada de sucursal que SUSTITUYE a una entrada general para esa sucursal (sobreescribir sin duplicar el aviso).
  reemplaza_id uuid references restaurantes.conocimiento_negocio(id) on delete set null,
  titulo text not null check (char_length(titulo) between 1 and 120),
  texto text not null check (char_length(texto) between 1 and 2000),
  tipo text not null check (tipo in ('politica', 'faq', 'aviso_temporal')),
  -- Mayor = antes (el tope total de caracteres recorta por el final).
  prioridad smallint not null default 50 check (prioridad between 0 and 100),
  -- Fechas LOCALES de la sucursal (null = sin limite por ese lado).
  vigente_desde date,
  vigente_hasta date,
  activo boolean not null default true,
  estado text not null default 'publicado' check (estado in ('borrador', 'publicado')),
  origen text not null default 'manual' check (origen in ('manual', 'importado')),
  version integer not null default 1 check (version >= 1),
  creado_por uuid references core.staff_user(id) on delete set null,
  actualizado_por uuid references core.staff_user(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (vigente_desde is null or vigente_hasta is null or vigente_hasta >= vigente_desde),
  check (reemplaza_id is null or property_id is not null)
);

create index conocimiento_negocio_org_idx on restaurantes.conocimiento_negocio (organization_id, property_id);

alter table restaurantes.conocimiento_negocio enable row level security;

create policy "staff o sistema lee el conocimiento del negocio" on restaurantes.conocimiento_negocio for select
  using (
    auth.uid() is null
    or exists (
      select 1 from core.membership m
      where m.organization_id = conocimiento_negocio.organization_id and m.user_id = auth.uid()
    )
  );

create policy "owner/admin crea conocimiento del negocio" on restaurantes.conocimiento_negocio for insert
  with check (
    exists (
      select 1 from core.membership m
      where m.organization_id = conocimiento_negocio.organization_id and m.user_id = auth.uid() and m.vertical_role in ('owner', 'admin')
    )
    and (
      conocimiento_negocio.property_id is null
      or exists (
        select 1 from core.property p
        where p.id = conocimiento_negocio.property_id and p.organization_id = conocimiento_negocio.organization_id
      )
    )
  );

create policy "owner/admin actualiza conocimiento del negocio" on restaurantes.conocimiento_negocio for update
  using (
    exists (
      select 1 from core.membership m
      where m.organization_id = conocimiento_negocio.organization_id and m.user_id = auth.uid() and m.vertical_role in ('owner', 'admin')
    )
  )
  with check (
    exists (
      select 1 from core.membership m
      where m.organization_id = conocimiento_negocio.organization_id and m.user_id = auth.uid() and m.vertical_role in ('owner', 'admin')
    )
  );

create policy "owner/admin borra conocimiento del negocio" on restaurantes.conocimiento_negocio for delete
  using (
    exists (
      select 1 from core.membership m
      where m.organization_id = conocimiento_negocio.organization_id and m.user_id = auth.uid() and m.vertical_role in ('owner', 'admin')
    )
  );

create function restaurantes.guard_conocimiento_reemplaza() returns trigger
language plpgsql
security definer
set search_path = restaurantes, pg_temp
as $$
begin
  if new.reemplaza_id is not null and not exists (
    select 1 from restaurantes.conocimiento_negocio g
    where g.id = new.reemplaza_id and g.organization_id = new.organization_id and g.property_id is null
  ) then
    raise exception 'conocimiento_negocio: reemplaza_id debe apuntar a una entrada general de la misma organizacion' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function restaurantes.guard_conocimiento_reemplaza() from public, anon, authenticated;

create trigger conocimiento_negocio_guard_reemplaza
  before insert or update of reemplaza_id, organization_id on restaurantes.conocimiento_negocio
  for each row execute function restaurantes.guard_conocimiento_reemplaza();

revoke all on restaurantes.conocimiento_negocio from public, anon;
grant select on restaurantes.conocimiento_negocio to authenticated;
grant insert (organization_id, property_id, reemplaza_id, titulo, texto, tipo, prioridad, vigente_desde, vigente_hasta, activo, estado, origen, version, creado_por, actualizado_por, updated_at)
  on restaurantes.conocimiento_negocio to authenticated;
grant update (reemplaza_id, titulo, texto, tipo, prioridad, vigente_desde, vigente_hasta, activo, estado, version, actualizado_por, updated_at)
  on restaurantes.conocimiento_negocio to authenticated;
grant delete on restaurantes.conocimiento_negocio to authenticated;
grant select, insert, update, delete on restaurantes.conocimiento_negocio to service_role;

-- ---------------------------------------------------------------------------
-- 2) whatsapp_sucursal_control
-- ---------------------------------------------------------------------------
create table restaurantes.whatsapp_sucursal_control (
  property_id uuid primary key references core.property(id) on delete cascade,
  organization_id uuid not null references core.organization(id) on delete cascade,
  agente_activo boolean not null default true,
  actualizado_por uuid references core.staff_user(id) on delete set null,
  updated_at timestamptz not null default now()
);

alter table restaurantes.whatsapp_sucursal_control enable row level security;

create policy "staff o sistema lee el interruptor del agente de whatsapp" on restaurantes.whatsapp_sucursal_control for select
  using (
    auth.uid() is null
    or exists (
      select 1 from core.membership m
      where m.organization_id = whatsapp_sucursal_control.organization_id and m.user_id = auth.uid()
    )
  );

create policy "owner/admin crea el interruptor del agente de whatsapp" on restaurantes.whatsapp_sucursal_control for insert
  with check (
    exists (
      select 1 from core.membership m
      where m.organization_id = whatsapp_sucursal_control.organization_id and m.user_id = auth.uid() and m.vertical_role in ('owner', 'admin')
    )
    and exists (
      select 1 from core.property p
      where p.id = whatsapp_sucursal_control.property_id and p.organization_id = whatsapp_sucursal_control.organization_id
    )
  );

create policy "owner/admin actualiza el interruptor del agente de whatsapp" on restaurantes.whatsapp_sucursal_control for update
  using (
    exists (
      select 1 from core.membership m
      where m.organization_id = whatsapp_sucursal_control.organization_id and m.user_id = auth.uid() and m.vertical_role in ('owner', 'admin')
    )
  )
  with check (
    exists (
      select 1 from core.membership m
      where m.organization_id = whatsapp_sucursal_control.organization_id and m.user_id = auth.uid() and m.vertical_role in ('owner', 'admin')
    )
  );

revoke all on restaurantes.whatsapp_sucursal_control from public, anon;
grant select on restaurantes.whatsapp_sucursal_control to authenticated;
grant insert (property_id, organization_id, agente_activo, actualizado_por, updated_at) on restaurantes.whatsapp_sucursal_control to authenticated;
grant update (agente_activo, actualizado_por, updated_at) on restaurantes.whatsapp_sucursal_control to authenticated;
grant select, insert, update, delete on restaurantes.whatsapp_sucursal_control to service_role;

-- ---------------------------------------------------------------------------
-- 3) saludo de la llamada no interrumpible
-- ---------------------------------------------------------------------------
alter table restaurantes.branch_voice_config add column mensaje_inicial_interrumpible boolean not null default true;

grant insert (mensaje_inicial_interrumpible) on restaurantes.branch_voice_config to authenticated;
grant update (mensaje_inicial_interrumpible) on restaurantes.branch_voice_config to authenticated;
