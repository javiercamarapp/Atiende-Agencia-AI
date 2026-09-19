-- Fase 6 §2 (seguimiento) — soporte de Cal.com self-hosted:
-- `calcom_base_url` opcional en `citas.provider_calcom_accounts`
-- (008_calendar_provider_accounts.sql). Sin este campo, `RealCalComPort`
-- (../src/calcom-port.ts) siempre apunta al SaaS oficial
-- (`https://api.cal.com/v2`, su default) -- el encargo pide soportar también una
-- instancia self-hosted, mismo criterio de credencial-DEL-TENANT que
-- calcom_event_type_id/calcom_api_key_secret_id: cada negocio conecta su propia
-- cuenta/instancia, nunca una variable de entorno de plataforma.
--
-- `calcom_base_url`, cuando el profesional lo da, pasa por LA MISMA validación
-- SSRF real que `caldav_calendar_collection_url`
-- (@atiende/domain-citas::crearValidadorUrlCaldav / net/ssrf.ts: resuelve el
-- hostname por DNS y rechaza cualquier IP privada/loopback/link-local/metadata de
-- nube) ANTES de guardarse -- ver
-- apps/api/.../citas/calendar-providers.ts::POST .../calcom/connect. NULL (el
-- caso normal) significa "SaaS oficial de Cal.com", sin URL propia que validar.
alter table citas.provider_calcom_accounts
  add column calcom_base_url text check (calcom_base_url is null or length(calcom_base_url) between 1 and 500);
