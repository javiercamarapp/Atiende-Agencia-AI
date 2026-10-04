-- Ajustes del agente de restaurantes por ORGANIZACION: modelo y temperatura del agente de WhatsApp, modelo de la cascada de voz, temperatura de la
-- voz, ritmo y estilo de habla, y sonido de fondo opcional de la llamada. Es el equivalente, sobre la arquitectura vigente (gateway LLM + Gemini Live),
-- de lo que el original dejaba ajustar en ElevenLabs. Prefijo de supabase/migrations asignado: 20240101000330 (interno 055).
--
-- Decision de diseno: UNA tabla NUEVA, ninguna restriccion existente cambia. El codigo TypeScript que la lee degrada con SAVEPOINT a los valores de
-- siempre cuando la base todavia no la tiene (SQLSTATE 42P01/42703/42883) -- nada de esto se aplica al mergear, y sin esta migracion el agente se
-- comporta exactamente como antes. La lista de modelos permitidos vive en el codigo (versionada, con precio y proveedores de EE.UU. verificados): aqui
-- solo se acota el FORMATO del id; el gateway ignora un id no registrado, asi que un valor escrito directo en la base nunca llama a un modelo no listado.
--
-- Justificacion de seguridad de cada GRANT / policy (una por una):
--
--  * RLS habilitado y `revoke all ... from public, anon`: `anon` no recibe NINGUN privilegio (ni lectura).
--  * SELECT para `authenticated` con la policy `auth.uid() is null or <owner/admin de la organizacion>`:
--      - la rama `auth.uid() is null` es la sesion de SISTEMA: el webhook de WhatsApp (que elige modelo y temperatura del turno) y el servicio de
--        llamadas (que abre la llamada con estos ajustes) no tienen usuario; mismo escape hatch que `whatsapp_agent_config` (029) y `branch_voice_config`
--        (025). La tabla no guarda PII, secretos ni texto libre: solo ids de modelo, numeros y valores de una lista cerrada.
--      - el panel lo lee solo owner/admin: los ajustes del agente son configuracion comercial (mismo umbral que la config de voz y de WhatsApp).
--  * INSERT/UPDATE solo owner/admin de la organizacion, y `updated_by = auth.uid()` en el `with check`: nadie escribe ajustes a nombre de otro. El
--    `organization_id` se concede solo en INSERT (una fila no cambia de tenant) y la PK por organizacion impide filas duplicadas.
--  * GRANT por COLUMNA: la API solo escribe los ocho ajustes, `updated_by` y `updated_at` (upsert por organizacion). Sin DELETE para `authenticated`:
--    para volver a los valores de la plataforma se guarda null/valores por omision (queda en la bitacora de auditoria, que escribe la API).
--  * `service_role` conserva todos los privilegios (mantenimiento de plataforma), igual que el resto de las tablas del paquete.
--  * CHECK por columna: formato del id de modelo (autor/modelo, <= 80), temperatura 0..1, ritmo y estilo de listas cerradas y volumen del fondo 0..20
--    (% de plena escala: el fondo nunca tapa la voz del agente). Valores invalidos mueren en la base aunque alguien salte la validacion de la API.
create table restaurantes.agent_runtime_settings (
  organization_id uuid primary key references core.organization(id) on delete cascade,
  -- null = el modelo de la plataforma (el primer escalon de la escalera del rol).
  whatsapp_model text check (whatsapp_model is null or (char_length(whatsapp_model) <= 80 and whatsapp_model ~ '^[a-z0-9][a-z0-9._-]*/[a-z0-9][a-z0-9._:-]*$')),
  -- null = la de siempre (0). Solo la aplican los modelos que la admiten.
  whatsapp_temperature numeric(3,2) check (whatsapp_temperature is null or whatsapp_temperature between 0 and 1),
  voice_cascade_model text check (voice_cascade_model is null or (char_length(voice_cascade_model) <= 80 and voice_cascade_model ~ '^[a-z0-9][a-z0-9._-]*/[a-z0-9][a-z0-9._:-]*$')),
  voice_temperature numeric(3,2) check (voice_temperature is null or voice_temperature between 0 and 1),
  voice_pace text not null default 'normal' check (voice_pace in ('pausado', 'normal', 'agil')),
  voice_style text not null default 'neutro' check (voice_style in ('neutro', 'calido', 'sobrio', 'animado')),
  -- Sonido de fondo de restaurante en la llamada: apagado por omision.
  voice_background boolean not null default false,
  voice_background_volume smallint not null default 8 check (voice_background_volume between 0 and 20),
  updated_by uuid references core.staff_user(id) on delete set null,
  updated_at timestamptz not null default now()
);

alter table restaurantes.agent_runtime_settings enable row level security;

create policy "owner/admin o sistema lee los ajustes del agente" on restaurantes.agent_runtime_settings for select
  using (
    auth.uid() is null
    or exists (
      select 1 from core.membership m
      where m.organization_id = agent_runtime_settings.organization_id and m.user_id = auth.uid() and m.vertical_role in ('owner', 'admin')
    )
  );

create policy "owner/admin crea los ajustes del agente de su organizacion" on restaurantes.agent_runtime_settings for insert
  with check (
    updated_by = auth.uid()
    and exists (
      select 1 from core.membership m
      where m.organization_id = agent_runtime_settings.organization_id and m.user_id = auth.uid() and m.vertical_role in ('owner', 'admin')
    )
  );

create policy "owner/admin actualiza los ajustes del agente de su organizacion" on restaurantes.agent_runtime_settings for update
  using (
    exists (
      select 1 from core.membership m
      where m.organization_id = agent_runtime_settings.organization_id and m.user_id = auth.uid() and m.vertical_role in ('owner', 'admin')
    )
  )
  with check (
    updated_by = auth.uid()
    and exists (
      select 1 from core.membership m
      where m.organization_id = agent_runtime_settings.organization_id and m.user_id = auth.uid() and m.vertical_role in ('owner', 'admin')
    )
  );

revoke all on restaurantes.agent_runtime_settings from public, anon;
grant select on restaurantes.agent_runtime_settings to authenticated;
grant insert (organization_id, whatsapp_model, whatsapp_temperature, voice_cascade_model, voice_temperature, voice_pace, voice_style, voice_background, voice_background_volume, updated_by, updated_at)
  on restaurantes.agent_runtime_settings to authenticated;
grant update (whatsapp_model, whatsapp_temperature, voice_cascade_model, voice_temperature, voice_pace, voice_style, voice_background, voice_background_volume, updated_by, updated_at)
  on restaurantes.agent_runtime_settings to authenticated;
grant select, insert, update, delete on restaurantes.agent_runtime_settings to service_role;
