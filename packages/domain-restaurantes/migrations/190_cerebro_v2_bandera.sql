-- Bandera por ORGANIZACION del «cerebro v2» del agente de WhatsApp de restaurantes: las reglas medidas del repo suelto (emergencias y alergia con aviso URGENTE,
-- cancelacion/retractacion con «¿mantengo o cancelo?», guardia del texto final, faltante vs pedido aparte, pago, busqueda, dedupe de avisos y politicas del
-- 31-oct como datos), el modelo principal GPT-6 Luna con respaldo Claude Haiku 5.5 y el enrutamiento con retencion cero (ZDR) en OpenRouter.
-- Prefijo de supabase/migrations asignado: 20240101000821 (interno 190). Extiende `restaurantes.agent_runtime_settings` (migracion 055, una fila por organizacion):
-- NO crea tablas.
--
-- Solo agrega UNA columna boolean con valor por omision false: ninguna fila existente cambia de comportamiento (todas las organizaciones siguen con el agente de
-- siempre). El codigo TypeScript la lee aparte con SAVEPOINT y trata SQLSTATE 42703/42P01 como «apagada», asi que el despliegue del codigo antes que esta migracion
-- es inocuo.
--
-- Justificacion de seguridad:
--  * RLS, policies y revoke de la 055 siguen vigentes sin cambio: la columna hereda el select de la tabla para `authenticated` (owner/admin o sesion de sistema) y
--    ninguno para `anon`. NO se agrega ninguna policy ni funcion.
--  * SIN GRANT de insert/update a `authenticated`: encender el cerebro v2 es una decision de plataforma (se mide antes), no un ajuste que el dueno cambie desde el
--    panel. Solo `service_role` (que ya tiene todos los privilegios de la tabla) puede escribirla. La columna no guarda texto libre ni PII.
alter table restaurantes.agent_runtime_settings
  add column cerebro_v2 boolean not null default false;

comment on column restaurantes.agent_runtime_settings.cerebro_v2 is
  'Cerebro v2 del agente de WhatsApp (reglas medidas del repo suelto + Luna/Haiku con ZDR). Apagado por omision; solo service_role lo enciende.';
