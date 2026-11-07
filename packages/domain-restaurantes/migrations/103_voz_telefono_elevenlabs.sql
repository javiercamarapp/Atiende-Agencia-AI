-- 103 — Voz TELEFONICA por sucursal (ElevenLabs) para la cascada v2 de la llamada.
--
-- Contexto: el stack de voz elegido el 6-nov-2026 para Los Taquitos de PM es una cascada (STT Scribe v2 Realtime -> LLM -> TTS eleven_v4_turbo).
-- `branch_voice_config.voice_id` sigue siendo la voz de Gemini Live (catalogo de 30 voces, validado por la API): no sirve para ElevenLabs, cuyos ids son
-- de 20 caracteres alfanumericos. Esta columna guarda la voz de ElevenLabs que el dueno eligio en el panel (biblioteca de voces mexicanas); NULL = la de la
-- plataforma (Regina - Contact Center). El worker la recibe en el contexto de la llamada.
--
-- Aditiva y opcional: el codigo nuevo captura 42703 (columna ausente) y cae a la voz de la plataforma; el guardado desde el panel responde 503 honesto
-- ("no disponible aun") mientras la base no tenga la columna.

-- CHECK: solo el formato de un id de ElevenLabs (20 alfanumericos) o NULL. Nada de texto libre que viaje a la URL del proveedor.
alter table restaurantes.branch_voice_config
  add column if not exists tts_voice_id text
    check (tts_voice_id is null or tts_voice_id ~ '^[A-Za-z0-9]{20}$');

comment on column restaurantes.branch_voice_config.tts_voice_id is
  'Voz de ElevenLabs (id de 20 alfanumericos) para el TTS de la llamada telefonica; NULL = la voz de la plataforma. La de Gemini Live sigue en voice_id.';

-- Seguridad: GRANT por COLUMNA a authenticated, igual que el resto de columnas editables de la tabla (025/053). Las policies existentes de INSERT/UPDATE
-- ya limitan la escritura a owner/admin de la organizacion de la sucursal (RLS por membership); staff, otra organizacion y anon siguen sin poder escribir.
-- Sin GRANT a anon (la tabla ya revoca public/anon). service_role conserva su grant de tabla completa (lo usa el worker por la API interna).
grant insert (tts_voice_id) on restaurantes.branch_voice_config to authenticated;
grant update (tts_voice_id) on restaurantes.branch_voice_config to authenticated;
