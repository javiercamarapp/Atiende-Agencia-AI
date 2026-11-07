-- ROLLBACK MANUAL de packages/domain-restaurantes/migrations/104_modelos_agente_zdr_baratos.sql (espejo supabase 20240101000620).
-- Se corre a mano (psql con el rol de migraciones), nunca en CI ni al fusionar. Ver docs/ROLLBACK.md: un rollback de codigo no
-- revierte la base; esto si.
--
-- Que hace, en UNA transaccion:
--  1. Quita los dos CHECK de la lista cerrada (la base vuelve a acotar solo el formato, como en la 055).
--  2. Restaura, para cada organizacion del respaldo, los valores ORIGINALES de modelo y temperatura de WhatsApp y de voz, SOLO si la fila sigue
--     con el valor que puso la 104 (WhatsApp null / voz Gemini 3.5 Flash-Lite): si el dueno ya eligio otra cosa en el panel despues de la 104, se
--     respeta lo nuevo.
--  3. Conserva la tabla de respaldo (borrarla es un paso aparte y explicito, al final, comentado).
--
-- Ojo: con el codigo de #750 desplegado, el panel y el gateway siguen sin aceptar los modelos retirados (la lista vive en el codigo); este
-- rollback sirve junto con un rollback de codigo (`scripts/rollback/rollback.sh`) o para recuperar lo que tenia cada organizacion.
begin;

alter table restaurantes.agent_runtime_settings
  drop constraint if exists agent_runtime_settings_whatsapp_model_permitido,
  drop constraint if exists agent_runtime_settings_voice_cascade_model_permitido;

update restaurantes.agent_runtime_settings s
   set whatsapp_model = r.whatsapp_model,
       whatsapp_temperature = r.whatsapp_temperature
  from restaurantes.respaldo_104_modelos_agente r
 where s.organization_id = r.organization_id
   and r.whatsapp_model is not null
   and r.whatsapp_model not in ('openai/gpt-6-luna', 'anthropic/claude-haiku-5.5', 'deepseek/deepseek-v4.1-flash', 'google/gemini-3.5-flash-lite')
   and s.whatsapp_model is null;

update restaurantes.agent_runtime_settings s
   set voice_cascade_model = r.voice_cascade_model,
       voice_temperature = r.voice_temperature
  from restaurantes.respaldo_104_modelos_agente r
 where s.organization_id = r.organization_id
   and r.voice_cascade_model is not null
   and r.voice_cascade_model not in ('openai/gpt-6-luna', 'anthropic/claude-haiku-5.5', 'deepseek/deepseek-v4.1-flash', 'google/gemini-3.5-flash-lite')
   and s.voice_cascade_model = 'google/gemini-3.5-flash-lite';

-- Verificacion (solo lectura): cuantas filas quedaron con un modelo retirado restaurado.
select count(*) as filas_restauradas
  from restaurantes.agent_runtime_settings s
  join restaurantes.respaldo_104_modelos_agente r using (organization_id)
 where s.whatsapp_model is not distinct from r.whatsapp_model or s.voice_cascade_model is not distinct from r.voice_cascade_model;

commit;

-- Paso aparte, SOLO cuando ya no haga falta el respaldo:
-- drop table restaurantes.respaldo_104_modelos_agente;
