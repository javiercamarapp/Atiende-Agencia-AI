-- Hallazgo verificado por revisor independiente sobre el PR de
-- f2-citas-lista-de-espera (19-sep-2026): la migración 020
-- (`system_load_live_waitlist_candidates`) cierra el gap de RLS de
-- `citas.appointment_waitlist` en sesión de sistema, pero el paso INMEDIATO
-- SIGUIENTE de `runOptimizadorCore`/`runListaEsperaCore`
-- (`packages/domain-citas/src/reminders.ts`) -- resolver a qué
-- `phone_number_id` de WhatsApp Business mandar el aviso -- sigue llamando
-- `CitasRepository.resolveActiveWhatsAppPhoneNumberId`, un SELECT plano
-- contra `citas.whatsapp_config`. Esa tabla (003_waitlist_and_rate_limit.sql)
-- tiene UNA sola policy, de STAFF autenticado:
--
--   create policy "staff gestiona whatsapp_config de su organización" ...
--     using (exists (select 1 from core.membership m
--                    where m.organization_id = whatsapp_config.organization_id
--                      and m.user_id = auth.uid()));
--
-- EXACTAMENTE el mismo patrón que el gap (A) de la migración 020: bajo sesión
-- de SISTEMA (`auth.uid()` NULL) ese SELECT plano devuelve CERO filas, en
-- silencio -- con la migración 020 ya aplicada, `runOptimizadorCore` y
-- `runListaEsperaCore` SÍ ven candidatos reales, pero
-- `resolveActiveWhatsAppPhoneNumberId` devuelve `null` de todos modos ->
-- `{matched:false, reason:'no_whatsapp_config'}` /
-- `skippedNoWhatsappConfig:true` -- CERO avisos salen, con o sin la migración
-- 020. Ver el diagnóstico completo del revisor en
-- `/Users/javiercamaraportepetit/atiende-loop/work/progreso-correccion-f2-citas-lista-de-espera.md`.
--
-- Mismo diseño, mismo criterio caso-por-caso que la migración 020 (que a su
-- vez sigue `...000139_022_hoteles_sistema_voz_whatsapp_escritura.sql`):
-- `citas.whatsapp_config` no guarda PII de cliente (solo el `phone_number_id`
-- de la CUENTA de WhatsApp Business del negocio, y `is_active`) pero SÍ es
-- una credencial operativa de la plataforma (a qué número real llegan los
-- mensajes salientes de este tenant) -- se descarta un escape hatch en la
-- policy `for all` existente por el mismo motivo que 020: ampliaría TAMBIÉN
-- insert/update/delete a sesión de sistema (hoy correctamente reservados al
-- panel de staff -- el agente/cron nunca configura ni desactiva el número de
-- WhatsApp del negocio).
--
-- En su lugar: función `security definer` de SOLO-SISTEMA
-- (`citas.system_resolve_active_whatsapp_phone_number_id`), guard
-- `auth.uid() is null` (mismo patrón que
-- `citas.system_load_live_waitlist_candidates`, 020), que devuelve
-- ÚNICAMENTE `phone_number_id` (nunca `is_active`/`created_at`, que son solo
-- criterio de filtro interno) -- nunca un GRANT plano de SELECT sobre toda la
-- tabla a sesión de sistema. La policy `for all` original de staff NO se
-- toca: la resolución en sesión de STAFF (`previewListaEspera`, vista previa
-- de solo lectura del broadcast) sigue exactamente igual, vía RLS real de
-- staff, sin pasar por esta función.
--
-- Alcance de este fix: SOLO los dos callers que el revisor señaló como
-- bloqueante -- `runOptimizadorCore`/`runListaEsperaCore`
-- (`packages/domain-citas/src/reminders.ts`), los mismos que ya usan
-- `loadLiveWaitlistCandidatesAsSystem` (020) -- para no ampliar el alcance de
-- esta tarea (lista de espera) a otros flujos. `runConfirmacionCitaCore`
-- (cron de recordatorio 24h, `apps/api/.../citas/reminders.ts`),
-- `crisis-guardrail.ts::notifyOwnerOfEscalation` (canal de WhatsApp entrante)
-- y `PostgresCitasRepository.resolveOrganizationByPhoneNumberId` (línea
-- ~992, usado por el webhook entrante) también corren en sesión de sistema y
-- comparten el MISMO gap de RLS de `citas.whatsapp_config` -- preexistente,
-- fuera de alcance de esta tarea, documentado como pendiente en el cuerpo del
-- PR junto a este hallazgo.
--
-- Orden de despliegue: igual que 020 -- `resolveActiveWhatsAppPhoneNumberIdAsSystem`
-- (nuevo método, `postgres-repository.ts`) usa `runWithSavepointFallback` +
-- `isUndefinedFunctionError` (SQLSTATE 42883): si el código nuevo se
-- despliega ANTES que esta migración, cae a `null` (el mismo comportamiento
-- honesto de HOY: `no_whatsapp_config`/`skippedNoWhatsappConfig:true`, nunca
-- un 500) en vez de dejar la transacción abortada. No hay orden obligatorio
-- entre esta migración y la 020 (tablas y funciones independientes).
create or replace function citas.system_resolve_active_whatsapp_phone_number_id(p_organization_id uuid)
returns text
language plpgsql
security definer
set search_path = citas
as $$
declare
  v_phone_number_id text;
begin
  if auth.uid() is not null then
    raise exception 'system_resolve_active_whatsapp_phone_number_id es solo para la sesión de sistema' using errcode = '42501';
  end if;

  select w.phone_number_id into v_phone_number_id
    from citas.whatsapp_config w
    where w.organization_id = p_organization_id
      and w.is_active = true;

  return v_phone_number_id;
end;
$$;

revoke all on function citas.system_resolve_active_whatsapp_phone_number_id(uuid) from public, anon, authenticated;
grant execute on function citas.system_resolve_active_whatsapp_phone_number_id(uuid) to authenticated;
