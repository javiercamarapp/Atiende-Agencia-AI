-- Configuracion del agente de WhatsApp por organizacion y por sucursal (restaurantes). Prefijo de
-- supabase/migrations asignado para esta tanda: 20240101000216 (interno 029).
--
-- Hasta hoy `getAgentConfig` (llm-turn-handler.ts) devolvia SIEMPRE el agente generico (tutea, solo
-- domicilio, "si llueve"). Esta tabla guarda QUE perfil de agente usa cada organizacion/sucursal
-- (`generico` | `taqueria_pm`) y los pocos parametros editables de ese perfil (como se presenta, nombre
-- del negocio, tono, texto del tiempo de entrega). El prompt del perfil vive en el codigo (versionado y
-- probado), nunca como texto libre en la base: asi un owner no puede borrar por accidente las reglas duras.
--
-- Decision de diseno: tabla NUEVA, no modifica nada existente. El codigo TypeScript que la lee degrada con
-- SAVEPOINT al agente generico cuando la base todavia no la tiene (SQLSTATE 42P01/42703/42883/42501) --
-- nada de esto se aplica al mergear, y sin esta migracion el comportamiento es identico al de antes.
--
-- Justificacion de seguridad de cada GRANT / policy (una por una):
--
--  * RLS habilitado y `revoke all ... from public, anon`: `anon` no tiene NINGUN acceso.
--  * SELECT para `authenticated`: policy `auth.uid() is null or <staff de la organizacion>`. La rama
--    `auth.uid() is null` es la sesion de SISTEMA del webhook de WhatsApp (sin usuario), que debe leer la
--    config para armar el prompt; mismo escape hatch que `branch_policy` (023), `whatsapp_channel_config`
--    (017) y `known_zone` (016). La tabla no guarda PII, credenciales ni secretos (solo nombre de agente,
--    nombre del negocio, tono y un texto de tiempo de entrega).
--  * INSERT/UPDATE solo owner/admin de la organizacion (la personalidad y los tiempos que se le prometen al
--    cliente son mas sensibles que precios/disponibilidad: mismo umbral que `branch_policy` y
--    `whatsapp_channel_config`). El `with check` exige que `property_id`, cuando no es null, pertenezca a
--    `organization_id` (sin esto un owner de la org A podria escribir una fila para una sucursal de la org B
--    declarando su propia organizacion).
--  * GRANT por COLUMNA: las funciones reales solo escriben perfil, agent_name, business_name, tone_style,
--    delivery_time_text, enabled y updated_at (upsert). `organization_id` y `property_id` se conceden solo
--    en INSERT (una fila no cambia de tenant ni de sucursal). Sin DELETE: para apagar el perfil se pone
--    `enabled = false` (el lector ignora filas apagadas y cae al agente generico).
--  * Longitudes acotadas con CHECK: el nombre y el tiempo se inyectan en el prompt; un tope corto limita la
--    superficie de texto libre que un owner (o una cuenta comprometida) puede meter ahi.
create table restaurantes.whatsapp_agent_config (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  -- null = configuracion de la organizacion (aplica a todas sus sucursales sin fila propia).
  property_id uuid references core.property(id) on delete cascade,
  perfil text not null default 'generico' check (perfil in ('generico', 'taqueria_pm')),
  agent_name text check (agent_name is null or char_length(agent_name) between 1 and 60),
  business_name text check (business_name is null or char_length(business_name) between 1 and 120),
  tone_style text check (tone_style is null or tone_style in ('calido_cercano', 'formal_directo', 'profesional_neutro', 'divertido_desenfadado')),
  delivery_time_text text check (delivery_time_text is null or char_length(delivery_time_text) between 1 and 200),
  enabled boolean not null default true,
  updated_at timestamptz not null default now()
);

-- Una fila por organizacion y una por (organizacion, sucursal). Dos indices parciales porque un unique con
-- columnas null no distingue filas (null <> null).
create unique index whatsapp_agent_config_org_uidx on restaurantes.whatsapp_agent_config (organization_id) where property_id is null;
create unique index whatsapp_agent_config_property_uidx on restaurantes.whatsapp_agent_config (organization_id, property_id) where property_id is not null;

alter table restaurantes.whatsapp_agent_config enable row level security;

create policy "staff o sistema lee la config del agente de whatsapp" on restaurantes.whatsapp_agent_config for select
  using (
    auth.uid() is null
    or exists (
      select 1 from core.membership m
      where m.organization_id = whatsapp_agent_config.organization_id and m.user_id = auth.uid()
    )
  );

create policy "owner/admin crea la config del agente de whatsapp" on restaurantes.whatsapp_agent_config for insert
  with check (
    exists (
      select 1 from core.membership m
      where m.organization_id = whatsapp_agent_config.organization_id and m.user_id = auth.uid() and m.vertical_role in ('owner', 'admin')
    )
    and (
      whatsapp_agent_config.property_id is null
      or exists (
        select 1 from core.property p
        where p.id = whatsapp_agent_config.property_id and p.organization_id = whatsapp_agent_config.organization_id
      )
    )
  );

create policy "owner/admin actualiza la config del agente de whatsapp" on restaurantes.whatsapp_agent_config for update
  using (
    exists (
      select 1 from core.membership m
      where m.organization_id = whatsapp_agent_config.organization_id and m.user_id = auth.uid() and m.vertical_role in ('owner', 'admin')
    )
  )
  with check (
    exists (
      select 1 from core.membership m
      where m.organization_id = whatsapp_agent_config.organization_id and m.user_id = auth.uid() and m.vertical_role in ('owner', 'admin')
    )
  );

revoke all on restaurantes.whatsapp_agent_config from public, anon;
grant select on restaurantes.whatsapp_agent_config to authenticated;
grant insert (organization_id, property_id, perfil, agent_name, business_name, tone_style, delivery_time_text, enabled, updated_at)
  on restaurantes.whatsapp_agent_config to authenticated;
grant update (perfil, agent_name, business_name, tone_style, delivery_time_text, enabled, updated_at)
  on restaurantes.whatsapp_agent_config to authenticated;
grant select, insert, update, delete on restaurantes.whatsapp_agent_config to service_role;
