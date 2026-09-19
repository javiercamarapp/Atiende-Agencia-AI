-- Hallazgo de auditoría (severidad CRÍTICA, inventario "flujos de sistema
-- bloqueados en escritura" -- ver PR de flujos-de-sistema-escrituras): el
-- Server Tool de voz de F&B (`POST /v1/hoteles/:propertyId/voz/tickets-fnb`,
-- `apps/api/src/routes/verticals/hoteles/voice-tools.ts`) y el webhook
-- entrante de WhatsApp (`POST /v1/hoteles/whatsapp/webhook`,
-- `apps/api/src/routes/verticals/hoteles/whatsapp.ts`) corren bajo sesión de
-- sistema (`packages/db/src/managed-postgres-engine.ts::withAppSession({
-- userId: null })`, `set local role authenticated` + `auth.uid()` SIEMPRE
-- NULL) pero dos lecturas y una escritura que ambos flujos necesitan quedan
-- bloqueadas por policies de staff autenticado (`core.has_property_access`,
-- exige `auth.uid()` real):
--
--   * `hoteles.voice_agent_config` SELECT (`findVoiceAgentConfig`,
--     invocado por `requireVoiceAgentConfig` ANTES de aceptar cualquier
--     tool call de voz -- resuelve el secreto por-property y si el agente
--     está habilitado) -- bloqueado por la policy `for all` "staff
--     admin ve/gestiona el secreto de voz de su property"
--     (`...000013_004_voz_whatsapp_fase2.sql`). Sin esta lectura, CADA
--     llamada al tool de voz responde 503 "El agente de voz no está
--     configurado o está deshabilitado" -- nunca llega siquiera a intentar
--     el INSERT de abajo.
--   * `hoteles.whatsapp_channel_config` SELECT
--     (`resolvePropertyByPhoneNumberId`, invocado por el webhook para
--     resolver a qué property pertenece el número de Meta Cloud API
--     entrante) -- bloqueado por la única policy que existe para esa tabla,
--     "staff ve la config de whatsapp de su property"
--     (misma migración). Sin esta lectura, CADA webhook entrante responde
--     `{"ok": true}` sin procesar nada ("Número no configurado en la
--     plataforma") -- el canal de WhatsApp de hoteles completo queda inerte
--     en silencio (200 siempre, Meta nunca reintenta).
--   * `hoteles.fnb_order` INSERT (`insertFnbOrder`, el pedido de F&B en sí)
--     -- bloqueado por "staff crea pedidos de f&b de su property"
--     (misma migración). Este es el hallazgo ya señalado explícitamente en
--     el PR previo (`...000136_0015_core_rls_sesion_sistema.sql`): incluso
--     si las dos lecturas de arriba no bloquearan nada, el pedido en sí
--     nunca se guardaría.
--
-- Verificado contra Postgres real -- ver `scripts/verify-flujos-sistema/`.
--
-- Decisión de diseño (caso por caso, misma regla que el PR #141):
--
--   * `hoteles.voice_agent_config` contiene `tool_webhook_secret` -- una
--     CREDENCIAL (`check (length(tool_webhook_secret) between 16 and
--     200)`). Un escape hatch `auth.uid() is null or ...` en la policy `for
--     all` existente ampliaría TAMBIÉN insert/update/delete a sesión de
--     sistema (hoy correctamente reservados a
--     `POST /hoteles/:propertyId/voz/config`, solo ADMIN_ROLES) -- se
--     descarta. En su lugar: función `security definer` de solo-sistema
--     (`hoteles.system_find_voice_agent_config`), mismo patrón que
--     `core.find_staff_by_email`/`find_staff_by_id` (login, el otro secreto
--     -- `password_hash` -- que este repo ya resuelve así) y que
--     `licitaciones.enqueue_messaging_outbox`/etc.
--     (`...000089_020_email_outbox_authenticated_grants.sql`). La policy
--     `for all` original NO se toca -- insert/update/delete del secreto
--     siguen siendo EXCLUSIVAMENTE de staff admin autenticado, igual que
--     hoy.
--   * `hoteles.whatsapp_channel_config` NO tiene credencial propia (el
--     secreto de firma de Meta -- `WHATSAPP_APP_SECRET` -- es de
--     plataforma, en `deps.env`, nunca en esta tabla; columnas:
--     `property_id`/`organization_id`/`phone_number_id`/`enabled`) --
--     mismo perfil de riesgo que `core.property`/`core.organization`
--     (catálogo de enrutamiento sin PII/credenciales). Se usa escape hatch
--     `auth.uid() is null or <regla actual>` en la ÚNICA policy que existe
--     (SELECT) -- la tabla sigue sin ninguna policy de insert/update/delete
--     para `authenticated` (gestión de catálogo fuera de fase, sin cambio).
--   * `hoteles.fnb_order` (items del pedido, notas, bandera de alergia) NO
--     es dinero/PII sensible/credencial -- es el mismo perfil de dato que un
--     pedido de restaurantes. Este vertical YA tiene un precedente PROPIO de
--     escape hatch para una escritura de sistema en una tabla money-adjacent
--     (`hoteles.night_audit_run`, `...000055_008_night_audit.sql`: `with
--     check (auth.uid() is null or hoteles.can_access_money(property_id))`)
--     -- se sigue el mismo patrón aquí. El `OR` nunca relaja el acceso de un
--     staff autenticado real (la regla original sigue aplicando sin cambio
--     para cualquier `auth.uid()` no nulo) -- solo sesión de sistema, nunca
--     alcanzable desde un JWT de usuario real (mismo análisis del PR #141).
--     `hoteles.fnb_order` UPDATE (confirmar cocina/asegurar) NO se toca --
--     esas dos acciones siguen siendo EXCLUSIVAMENTE de staff (
--     `confirmFnbKitchen`/`assureFnbSafety`, sin caller de sistema).
--
-- Alcance deliberado de esta migración: SOLO lo que hace falta para que
-- "pedido F&B por voz" y "WhatsApp inbound resuelve property" funcionen de
-- punta a punta bajo sesión de sistema. El resto de la cadena de hoteles
-- (`night-audit`/`no-show`, que además tocan `hoteles.charge`/
-- `hoteles.payment`/`hoteles.folio` -- tablas de DINERO) queda fuera de esta
-- migración a propósito -- requiere su propio diseño cuidadoso (ver reporte
-- del PR, sección "pendiente para un segundo PR").
--
-- Orden de despliegue: esta migración debe aplicarse ANTES de desplegar el
-- código de `packages/domain-hoteles/src/postgres-repository.ts` de este
-- mismo commit. `findVoiceAgentConfig` es EXCLUSIVA de sesión de sistema
-- (verificado: sin caller de staff autenticado) -- si el código nuevo se
-- desplegara ANTES que esta migración, la llamada fallaría con "function
-- hoteles.system_find_voice_agent_config(...) does not exist" en vez del 503
-- "agente no configurado" de hoy -- ambos son fallos duros ya manejados por
-- el `try/catch` del caller (`Errors.serviceUnavailable`), nunca peor que el
-- bug ya documentado aquí.

-- ---------------------------------------------------------------------------
-- 1) hoteles.fnb_order INSERT -- escape hatch (precedente propio:
--    hoteles.night_audit_run). La policy de SELECT recibe el MISMO escape
--    hatch: `insertFnbOrder` (postgres-repository.ts) hace `insert ...
--    returning ${FNB_ORDER_COLUMNS}` -- verificado empíricamente contra
--    Postgres real (igual que documenta
--    `...000094_015_cron_publico_rls_escape_hatch.sql` para rentas): un
--    `INSERT ... RETURNING` exige TAMBIÉN pasar la policy de SELECT de la
--    fila insertada, incluso con el WITH CHECK del INSERT ya satisfecho --
--    sin este segundo cambio, `insertFnbOrder` seguiría fallando con "new
--    row violates row-level security policy for table fnb_order" pese al
--    escape hatch de INSERT de arriba.
-- ---------------------------------------------------------------------------
drop policy if exists "staff crea pedidos de f&b de su property" on hoteles.fnb_order;
create policy "staff crea pedidos de f&b de su property" on hoteles.fnb_order for insert
  with check (auth.uid() is null or core.has_property_access(auth.uid(), property_id));

drop policy if exists "staff ve pedidos de f&b de su property" on hoteles.fnb_order;
create policy "staff ve pedidos de f&b de su property" on hoteles.fnb_order for select
  using (auth.uid() is null or core.has_property_access(auth.uid(), property_id));

-- ---------------------------------------------------------------------------
-- 2) hoteles.whatsapp_channel_config SELECT -- escape hatch (catálogo de
--    enrutamiento sin PII/credenciales, mismo perfil que core.property).
-- ---------------------------------------------------------------------------
drop policy if exists "staff ve la config de whatsapp de su property" on hoteles.whatsapp_channel_config;
create policy "staff ve la config de whatsapp de su property" on hoteles.whatsapp_channel_config for select
  using (auth.uid() is null or core.has_property_access(auth.uid(), property_id));

-- ---------------------------------------------------------------------------
-- 3) hoteles.voice_agent_config -- función security definer de solo-sistema
--    (contiene tool_webhook_secret, una credencial -- la policy `for all`
--    existente NO se toca).
-- ---------------------------------------------------------------------------
create or replace function hoteles.system_find_voice_agent_config(p_property_id uuid)
returns table (out_property_id uuid, out_organization_id uuid, out_tool_webhook_secret text, out_enabled boolean)
language plpgsql security definer set search_path = hoteles as $$
begin
  if auth.uid() is not null then
    raise exception 'system_find_voice_agent_config es solo para la sesión de sistema' using errcode = '42501';
  end if;

  return query
    select v.property_id, v.organization_id, v.tool_webhook_secret, v.enabled
    from hoteles.voice_agent_config v
    where v.property_id = p_property_id;
end;
$$;

revoke execute on function hoteles.system_find_voice_agent_config(uuid) from public;
grant execute on function hoteles.system_find_voice_agent_config(uuid) to authenticated;
