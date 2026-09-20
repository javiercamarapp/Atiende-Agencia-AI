-- f2-citas-whatsapp-config-sesion-sistema (tarea de integridad Fase 2) — MISMO gap
-- de RLS que la migración 021 (`system_resolve_active_whatsapp_phone_number_id`),
-- en la dirección INVERSA: `021` resuelve "qué `phone_number_id` usa esta
-- organización" (saliente); esta migración resuelve "qué organización es dueña de
-- este `phone_number_id`" (entrante) — la primera consulta real del webhook de
-- WhatsApp (`apps/api/.../citas/whatsapp.ts::POST /v1/citas/whatsapp/webhook`), que
-- SIEMPRE abre su propia sesión de SISTEMA (`deps.engine.withAppSession({ userId:
-- null }, ...)`, sin `authMiddleware`/JWT -- Meta no manda ningún usuario
-- autenticado).
--
-- `citas.whatsapp_config` (003_waitlist_and_rate_limit.sql) tiene UNA sola policy,
-- de staff autenticado:
--
--   create policy "staff gestiona whatsapp_config de su organización" ...
--     using (exists (select 1 from core.membership m
--                    where m.organization_id = whatsapp_config.organization_id
--                      and m.user_id = auth.uid()));
--
-- Bajo sesión de SISTEMA (`auth.uid()` NULL) esa policy SIEMPRE deniega -- el
-- SELECT plano de `PostgresCitasRepository.resolveOrganizationByPhoneNumberId`
-- devuelve CERO filas, en silencio, sin importar qué tan bien configurado esté el
-- negocio. Efecto real: `whatsapp.ts` trata TODO mensaje entrante de WhatsApp de
-- citas como "número no configurado en la plataforma" (rama de `ack silencioso, no
-- reintento`) -- el webhook entero nunca ha resuelto una organización contra
-- Postgres real desde que existe (Fase 2 de citas), invisible en
-- `InMemoryCitasRepository` (sin RLS que reproducir) y en
-- `apps/api/tests/citas-whatsapp-llm-agent.spec.ts` (usa el doble en memoria). Este
-- mismo caller ya estaba documentado como gap pendiente en el comentario de cabecera
-- de la migración 021 ("`PostgresCitasRepository.resolveOrganizationByPhoneNumberId`
-- ... tiene el mismo gap en la dirección inversa").
--
-- Mismo diseño, mismo criterio caso-por-caso que 020/021: `citas.whatsapp_config`
-- no guarda PII de cliente, pero SÍ es una credencial operativa de la plataforma —
-- se descarta un escape hatch en la policy `for all` existente por el mismo motivo
-- que 020/021: ampliaría TAMBIÉN insert/update/delete a sesión de sistema (hoy
-- correctamente reservados al panel de staff — el webhook nunca configura ni
-- desactiva el número de WhatsApp del negocio, solo necesita LEER a qué
-- organización pertenece).
--
-- En su lugar: función `security definer` de SOLO-SISTEMA
-- (`citas.system_resolve_organization_by_whatsapp_phone_number_id`), guard
-- `auth.uid() is null` (mismo patrón EXACTO que `system_resolve_active_whatsapp_
-- phone_number_id`, 021), que devuelve ÚNICAMENTE `organization_id` (nunca
-- `phone_number_id`/`is_active`/`created_at`, que son solo criterio de filtro
-- interno) -- nunca un GRANT plano de SELECT sobre toda la tabla a sesión de
-- sistema. La policy `for all` original de staff NO se toca: el panel de staff
-- (configurar/desactivar `whatsapp_config`) sigue exactamente igual, vía RLS real
-- de staff, sin pasar por esta función.
--
-- Orden de despliegue: igual que 020/021 --
-- `resolveOrganizationByPhoneNumberIdAsSystem` (nuevo método,
-- `postgres-repository.ts`) usa `runWithSavepointFallback` + `isUndefinedFunctionError`
-- (SQLSTATE 42883): si el código nuevo se despliega ANTES que esta migración, cae a
-- `null` (el mismo comportamiento honesto de HOY: "número no configurado", nunca un
-- 500) en vez de dejar la transacción abortada. No hay orden obligatorio entre esta
-- migración y ninguna otra (función independiente, ninguna otra migración depende
-- de ella).
create or replace function citas.system_resolve_organization_by_whatsapp_phone_number_id(p_phone_number_id text)
returns uuid
language plpgsql
security definer
set search_path = citas
as $$
declare
  v_organization_id uuid;
begin
  if auth.uid() is not null then
    raise exception 'system_resolve_organization_by_whatsapp_phone_number_id es solo para la sesión de sistema' using errcode = '42501';
  end if;

  select w.organization_id into v_organization_id
    from citas.whatsapp_config w
    where w.phone_number_id = p_phone_number_id
      and w.is_active = true;

  return v_organization_id;
end;
$$;

revoke all on function citas.system_resolve_organization_by_whatsapp_phone_number_id(text) from public, anon, authenticated;
grant execute on function citas.system_resolve_organization_by_whatsapp_phone_number_id(text) to authenticated;
