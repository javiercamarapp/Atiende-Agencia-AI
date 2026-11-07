-- Modelos por actividad (6-nov-2026): los modelos que una organizacion de restaurantes puede elegir para su agente de WhatsApp y para la cascada
-- de voz quedan acotados en la BASE a la misma lista cerrada del codigo (`MODELOS_AGENTE` / `IDS_MODELOS_AGENTE` de domain-restaurantes):
-- solo modelos BARATOS con endpoint de RETENCION CERO (ZDR) en proveedores de EE.UU. Prefijo de supabase/migrations asignado: 20240101000620
-- (interno 104).
--
-- Que cambia:
--  1. Las filas que hoy guardan un modelo que salio de la lista (Claude Sonnet 5.5: premium; Gemini 2.5 Flash-Lite y Muse Spark 1.3: sin
--     endpoint ZDR; Gemini 3.8 Flash: gama media, solo reportes) vuelven a null = el modelo de la plataforma (Luna -> Haiku 5.5). Es lo mismo
--     que ya hacia el gateway con un id fuera de la lista (lo ignoraba); aqui queda explicito en la base. La temperatura de esas filas tambien
--     vuelve a null porque Luna no la admite.
--  2. CHECK por columna con la lista exacta. Un valor fuera de la lista muere en la base aunque alguien salte la validacion de la API.
--     Cambiar la lista del codigo exige una migracion nueva con el CHECK actualizado en el MISMO PR (regla del dueno).
--
-- Justificacion de seguridad: no se crean tablas, funciones, GRANTs ni policies; los privilegios y la RLS de 055 no cambian. El UPDATE corre como
-- el rol que aplica la migracion, solo sobre las dos columnas de modelo (y la temperatura de WhatsApp) y sin leer ni escribir PII.
-- Compatibilidad: el TypeScript nuevo no depende de esta migracion (la lista vive en el codigo y la API valida antes de escribir); sin ella la base
-- solo acota el formato, como hasta hoy.

update restaurantes.agent_runtime_settings
   set whatsapp_model = null,
       whatsapp_temperature = null
 where whatsapp_model is not null
   and whatsapp_model not in ('openai/gpt-6-luna', 'anthropic/claude-haiku-5.5', 'deepseek/deepseek-v4.1-flash', 'google/gemini-3.5-flash-lite');

update restaurantes.agent_runtime_settings
   set voice_cascade_model = null
 where voice_cascade_model is not null
   and voice_cascade_model not in ('openai/gpt-6-luna', 'anthropic/claude-haiku-5.5', 'deepseek/deepseek-v4.1-flash', 'google/gemini-3.5-flash-lite');

alter table restaurantes.agent_runtime_settings
  add constraint agent_runtime_settings_whatsapp_model_permitido
    check (whatsapp_model is null or whatsapp_model in ('openai/gpt-6-luna', 'anthropic/claude-haiku-5.5', 'deepseek/deepseek-v4.1-flash', 'google/gemini-3.5-flash-lite')),
  add constraint agent_runtime_settings_voice_cascade_model_permitido
    check (voice_cascade_model is null or voice_cascade_model in ('openai/gpt-6-luna', 'anthropic/claude-haiku-5.5', 'deepseek/deepseek-v4.1-flash', 'google/gemini-3.5-flash-lite'));

comment on constraint agent_runtime_settings_whatsapp_model_permitido on restaurantes.agent_runtime_settings is
  'Lista cerrada MODELOS_AGENTE (domain-restaurantes): solo modelos baratos con endpoint ZDR. Cambiarla exige migracion nueva en el mismo PR.';
comment on constraint agent_runtime_settings_voice_cascade_model_permitido on restaurantes.agent_runtime_settings is
  'Lista cerrada MODELOS_AGENTE (domain-restaurantes): solo modelos baratos con endpoint ZDR. Cambiarla exige migracion nueva en el mismo PR.';
