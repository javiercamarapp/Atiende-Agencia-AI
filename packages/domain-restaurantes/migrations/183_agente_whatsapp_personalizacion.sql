-- F4c (paridad menor) -- TONO y MENSAJE ADICIONAL del dueno para el agente de WhatsApp. Prefijo de supabase/migrations asignado: 20240101000483 (interno 183).
--
-- Decision de diseno: tabla NUEVA por organizacion (no se tocan `agent_runtime_settings` ni `whatsapp_agent_config`, cuyas filas y tipos ya tienen pruebas). SIN fila, con tono null y
-- mensaje null el prompt del agente queda BYTE A BYTE igual que antes (en el perfil PM el campo `tone_style` de la 029 nunca llego al prompt; este tono SI, pero solo cuando el
-- dueno lo elige a proposito aqui). El mensaje del dueno es texto libre ACOTADO (600 caracteres): el servidor lo rechaza si intenta pisar reglas duras (propina, transferencia,
-- escalacion, seguridad, "ignora lo anterior") y lo inyecta en una seccion propia ANTES de las reglas duras, que quedan despues y ganan.
--
-- Justificacion de seguridad (una por una):
--  * RLS habilitado y `revoke all ... from public, anon`: `anon` no recibe NINGUN privilegio.
--  * SELECT para `authenticated` con `auth.uid() is null or owner/admin`: la rama `auth.uid() is null` es la sesion de SISTEMA (el webhook de WhatsApp arma el prompt del turno sin
--    usuario), mismo escape que `agent_runtime_settings` (055). El texto es del dueno sobre su propio negocio: no es PII de clientes.
--  * INSERT/UPDATE solo owner/admin, con `updated_by = auth.uid()` en el `with check`. `organization_id` solo en INSERT. Sin DELETE para `authenticated`: para volver al comportamiento
--    de siempre se guarda tono y mensaje en null (queda en la bitacora que escribe la API).
--  * CHECK por columna: tono de la lista cerrada de 4 y mensaje de 1 a 600 caracteres sin caracteres de control (se permiten tabulador y salto de linea); la API aplica ademas el filtro de reglas duras (defensa en profundidad:
--    la base solo acota formato y largo, no puede razonar sobre el contenido).
create table restaurantes.agente_whatsapp_personalizacion (
  organization_id uuid primary key references core.organization(id) on delete cascade,
  tono text check (tono is null or tono in ('calido_cercano', 'formal_directo', 'profesional_neutro', 'divertido_desenfadado')),
  mensaje_dueno text check (mensaje_dueno is null or (char_length(mensaje_dueno) between 1 and 600 and mensaje_dueno !~ '[\x01-\x08\x0b-\x1f\x7f]')),
  updated_by uuid references core.staff_user(id) on delete set null,
  updated_at timestamptz not null default now()
);

alter table restaurantes.agente_whatsapp_personalizacion enable row level security;

create policy "owner/admin o sistema lee la personalizacion del agente" on restaurantes.agente_whatsapp_personalizacion for select
  using (
    auth.uid() is null
    or exists (
      select 1 from core.membership m
      where m.organization_id = agente_whatsapp_personalizacion.organization_id and m.user_id = auth.uid() and m.vertical_role in ('owner', 'admin')
    )
  );

create policy "owner/admin crea la personalizacion del agente" on restaurantes.agente_whatsapp_personalizacion for insert
  with check (
    updated_by = auth.uid()
    and exists (
      select 1 from core.membership m
      where m.organization_id = agente_whatsapp_personalizacion.organization_id and m.user_id = auth.uid() and m.vertical_role in ('owner', 'admin')
    )
  );

create policy "owner/admin actualiza la personalizacion del agente" on restaurantes.agente_whatsapp_personalizacion for update
  using (
    exists (
      select 1 from core.membership m
      where m.organization_id = agente_whatsapp_personalizacion.organization_id and m.user_id = auth.uid() and m.vertical_role in ('owner', 'admin')
    )
  )
  with check (
    updated_by = auth.uid()
    and exists (
      select 1 from core.membership m
      where m.organization_id = agente_whatsapp_personalizacion.organization_id and m.user_id = auth.uid() and m.vertical_role in ('owner', 'admin')
    )
  );

revoke all on restaurantes.agente_whatsapp_personalizacion from public, anon;
grant select on restaurantes.agente_whatsapp_personalizacion to authenticated;
grant insert (organization_id, tono, mensaje_dueno, updated_by, updated_at) on restaurantes.agente_whatsapp_personalizacion to authenticated;
grant update (tono, mensaje_dueno, updated_by, updated_at) on restaurantes.agente_whatsapp_personalizacion to authenticated;
grant select, insert, update, delete on restaurantes.agente_whatsapp_personalizacion to service_role;
