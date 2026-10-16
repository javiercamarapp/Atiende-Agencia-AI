-- Ajustes del agente de restaurantes: AMBIENTE de restaurante con presets, SONIDO DE TECLEO mientras el agente anota, y el interruptor de NATURALIDAD
-- (instrucciones de español de Mexico, muletillas escasas y verbalizacion de la espera) que forman el preset 'restaurante-humano'. Prefijo de
-- supabase/migrations asignado: 20240101000398 (interno 087). Extiende la tabla de la migracion 055 (`restaurantes.agent_runtime_settings`, por organizacion, donde
-- ya viven ritmo, estilo y el fondo): NO crea tablas nuevas.
--
-- Solo agrega columnas con valor por omision y CHECK; ninguna restriccion existente cambia, asi que las filas actuales siguen validas (fondo apagado, sin tecleo,
-- sin naturalidad = el comportamiento de siempre). El codigo TypeScript que las lee degrada a esos valores cuando la base todavia no las tiene (SQLSTATE 42703).
--
-- Justificacion de seguridad:
--  * RLS, policies y revoke de la 055 siguen vigentes sin cambio: las columnas nuevas heredan select para `authenticated` (owner/admin o sesion de sistema) y
--    ninguno para `anon`. NO se agrega ninguna policy ni funcion.
--  * GRANT por COLUMNA: se concede insert y update de las CUATRO columnas nuevas a `authenticated` (la API las escribe con el upsert de la 055; la policy de
--    insert/update ya exige owner/admin de la organizacion y `updated_by = auth.uid()`). Sin GRANT a `anon`. `service_role` ya tiene todos los privilegios de la tabla.
--  * CHECK por columna: el preset de ambiente es de una lista cerrada, el volumen del tecleo 0..25 (% de plena escala, siempre por debajo de la voz del agente) y
--    el fondo conserva su tope 0..20. Valores invalidos mueren en la base aunque alguien salte la validacion de la API. Ninguna columna guarda texto libre ni PII.
alter table restaurantes.agent_runtime_settings
  add column voice_background_preset text not null default 'cocina-taqueria' check (voice_background_preset in ('cocina-taqueria', 'sala-tranquila', 'calle-ocupada')),
  add column voice_typing boolean not null default false,
  add column voice_typing_volume smallint not null default 12 check (voice_typing_volume between 0 and 25),
  add column voice_humanize boolean not null default false;

grant insert (voice_background_preset, voice_typing, voice_typing_volume, voice_humanize) on restaurantes.agent_runtime_settings to authenticated;
grant update (voice_background_preset, voice_typing, voice_typing_volume, voice_humanize) on restaurantes.agent_runtime_settings to authenticated;
