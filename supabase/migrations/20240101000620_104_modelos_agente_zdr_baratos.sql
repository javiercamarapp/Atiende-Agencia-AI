-- Modelos por actividad (6-nov-2026): los modelos que una organizacion de restaurantes puede elegir para su agente de WhatsApp y para la cascada
-- de voz quedan acotados en la BASE a la misma lista cerrada del codigo (`MODELOS_AGENTE` / `IDS_MODELOS_AGENTE` de domain-restaurantes):
-- solo modelos BARATOS con endpoint de RETENCION CERO (ZDR) en proveedores de EE.UU. Prefijo de supabase/migrations asignado: 20240101000620
-- (interno 104).
--
-- Que cambia (REVERSIBLE: scripts/rollback/migraciones/104_modelos_agente_zdr_baratos.down.sql):
--  0. RESPALDO: antes de tocar nada, cada fila con un modelo que salio de la lista (Claude Sonnet 5.5: premium; Gemini 2.5 Flash-Lite y Muse
--     Spark 1.3: sin endpoint ZDR; Gemini 3.8 Flash: gama media, solo reportes) se copia con sus valores ORIGINALES (modelo y temperatura de
--     WhatsApp y de voz) a `restaurantes.respaldo_104_modelos_agente`. Reejecutar no pisa el respaldo original (on conflict do nothing).
--  1. WhatsApp: el modelo retirado vuelve a null. En WhatsApp null = la ruta de la plataforma, que es la DECISION DEL DUENO (Luna -> Haiku 5.5).
--     La temperatura de esas filas tambien vuelve a null porque Luna no la admite.
--  2. Voz: OJO, en `voice_cascade_model` null NO es Luna: es `VOZ_PLATAFORMA.cascada.modeloLlm` (Gemini 3.8 Flash). Para no mover en silencio
--     a una organizacion a un modelo que nadie eligio, la cascada con un modelo retirado pasa a la DECISION DEL DUENO para la voz: el rapido,
--     Gemini 3.5 Flash-Lite (el preciso, Luna, sigue siendo elegible en el panel). Su temperatura de voz se conserva en el respaldo; el
--     voice-worker la omite porque 3.5 Flash-Lite no la admite.
--  3. CHECK por columna con la lista exacta. Un valor fuera de la lista muere en la base aunque alguien salte la validacion de la API.
--     Cambiar la lista del codigo exige una migracion nueva con el CHECK actualizado en el MISMO PR (regla del dueno).
--
-- Antes de aplicar, conteo de SOLO LECTURA de las filas que cambian (ver el cuerpo del PR #750).
--
-- Justificacion de seguridad:
--  * `restaurantes.respaldo_104_modelos_agente`: tabla PRIVADA de mantenimiento. RLS habilitado SIN policies y `revoke all` de public, anon y
--    authenticated: ningun usuario de la app la lee ni la escribe; solo el rol que aplica migraciones (y `service_role`) para el rollback. Guarda
--    solo ids de organizacion, ids de modelo y numeros: sin PII ni texto libre.
--  * No se crean funciones, GRANTs ni policies nuevos sobre `agent_runtime_settings`: la RLS y los GRANT de la 055 no cambian. Los UPDATE
--    corren como el rol que aplica la migracion, solo sobre las columnas de modelo/temperatura.
-- Compatibilidad: el TypeScript nuevo no depende de esta migracion (la lista vive en el codigo y la API valida antes de escribir); sin ella la base
-- solo acota el formato, como hasta hoy.

create table if not exists restaurantes.respaldo_104_modelos_agente (
  organization_id uuid primary key,
  whatsapp_model text,
  whatsapp_temperature numeric(3,2),
  voice_cascade_model text,
  voice_temperature numeric(3,2),
  respaldado_at timestamptz not null default now()
);
alter table restaurantes.respaldo_104_modelos_agente enable row level security;
revoke all on restaurantes.respaldo_104_modelos_agente from public, anon, authenticated;
comment on table restaurantes.respaldo_104_modelos_agente is
  'Respaldo privado de la migracion 104 (modelos por actividad): valores originales de las filas reescritas. Lo usa scripts/rollback/migraciones/104_modelos_agente_zdr_baratos.down.sql.';

insert into restaurantes.respaldo_104_modelos_agente (organization_id, whatsapp_model, whatsapp_temperature, voice_cascade_model, voice_temperature)
select organization_id, whatsapp_model, whatsapp_temperature, voice_cascade_model, voice_temperature
  from restaurantes.agent_runtime_settings
 where (whatsapp_model is not null
        and whatsapp_model not in ('openai/gpt-6-luna', 'anthropic/claude-haiku-5.5', 'deepseek/deepseek-v4.1-flash', 'google/gemini-3.5-flash-lite'))
    or (voice_cascade_model is not null
        and voice_cascade_model not in ('openai/gpt-6-luna', 'anthropic/claude-haiku-5.5', 'deepseek/deepseek-v4.1-flash', 'google/gemini-3.5-flash-lite'))
on conflict (organization_id) do nothing;

update restaurantes.agent_runtime_settings
   set whatsapp_model = null,
       whatsapp_temperature = null
 where whatsapp_model is not null
   and whatsapp_model not in ('openai/gpt-6-luna', 'anthropic/claude-haiku-5.5', 'deepseek/deepseek-v4.1-flash', 'google/gemini-3.5-flash-lite');

update restaurantes.agent_runtime_settings
   set voice_cascade_model = 'google/gemini-3.5-flash-lite'
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
