-- Segunda mitad del hallazgo P1 de la auditoría de 22 rubros ("wirear el webhook
-- del PAC de CFDI: implementado y probado en el puerto, solo falta la ruta HTTP").
-- `@atiende/mcp-cfdi::CfdiPort.verifyAndNormalizeWebhook` ya verifica la firma del
-- PAC (Finkok/SW Sapien) y normaliza el evento; lo que faltaba era la ruta HTTP
-- (`apps/api/src/routes/verticals/hoteles/cfdi-webhook.ts`) que lo recibe y aplica
-- la transición de estado -- ver el comentario de cabecera de ese archivo para el
-- hueco de negocio real que esto cierra (una cancelación que requería
-- aceptación/rechazo del receptor -- ciclo 2022+ del SAT -- nunca llegaba a esta
-- plataforma salvo que el staff pulsara "consultar estado" a mano).
--
-- El PAC que llama a ese webhook NO trae sesión de usuario ni
-- organizationId/propertyId (no hay JWT de staff). La fila de
-- hoteles.cfdi_emision que corresponde al UUID fiscal del evento vive detrás de la
-- política RLS "dinero: staff con acceso ... cfdi de hospedaje"
-- (001_hoteles_schema.sql/006_cfdi_hospedaje.sql, hoteles.can_access_money()), que
-- exige auth.uid() con membership de la property -- una sesión de sistema
-- (auth.uid() is null, engine.withAppSession({ userId: null }, ...), mismo patrón
-- que whatsapp.ts) NUNCA la satisface, para NINGUNA property. Un UPDATE normal
-- desde esa sesión no tocaría ninguna fila (0 rows afectadas, sin error visible --
-- el peor tipo de bug silencioso).
--
-- Esta función localiza + aplica la transición en UNA sola sentencia atómica
-- (SECURITY DEFINER, bypassa RLS SOLO para esta operación puntual), con la MISMA
-- semántica de transición que `updateCfdiEmisionCancelacion`
-- (postgres-repository.ts, usada por POST .../cancelar y .../consultar-estado):
-- `canceled_at` únicamente se sella al ENTRAR a 'cancelado' (nunca se vuelve a
-- tocar si ya estaba cancelado). Eso hace que reintentar el MISMO evento del PAC
-- (idempotencia exigida por cualquier webhook entrante) sea un no-op seguro a
-- nivel de base de datos incluso si la primera línea de defensa (el replay guard
-- de `CfdiPort.verifyAndNormalizeWebhook`, ver shared.ts::InMemoryReplayGuard)
-- llegara a fallar.
--
-- Mismo patrón EXACTO que las 6 funciones de
-- packages/domain-hoteles/migrations/004_voz_whatsapp_fase2.sql
-- (whatsapp_append_turn/claim_whatsapp_message/finish_whatsapp_message/etc.):
-- `security definer`, guard "auth.uid() is not null -> raise exception" (solo
-- para la sesión de sistema), y GRANT EXECUTE a `authenticated` -- NUNCA solo a
-- `service_role`. `withAppSession` siempre conecta a Postgres real como
-- `authenticated` (nunca como `service_role`); una función security definer sin
-- GRANT a `authenticated` es invocable solo por un rol que este monorepo nunca usa
-- en producción -- ese bug real (funciones security definer sin GRANT a
-- authenticated) ya se corrigió 7 veces en este repo, ver
-- 017_rpc_anti_duplicado_authenticated_grants.sql para el historial completo.

create or replace function hoteles.apply_cfdi_webhook_status(
  p_uuid_fiscal uuid,
  p_status text
) returns setof hoteles.cfdi_emision
language plpgsql
security definer
set search_path = hoteles
as $$
begin
  if auth.uid() is not null then
    raise exception 'apply_cfdi_webhook_status es solo para la sesión de sistema' using errcode = '42501';
  end if;

  if p_status not in ('pendiente', 'timbrado', 'en_proceso_cancelacion', 'cancelado', 'rechazado') then
    raise exception 'apply_cfdi_webhook_status: status inválido: %', p_status;
  end if;

  return query
  update hoteles.cfdi_emision c
  set status = p_status,
      canceled_at = case when p_status = 'cancelado' and c.status <> 'cancelado' then now() else c.canceled_at end
  where c.uuid_fiscal = p_uuid_fiscal
  returning c.*;
end;
$$;

grant execute on function hoteles.apply_cfdi_webhook_status(uuid, text) to authenticated;
