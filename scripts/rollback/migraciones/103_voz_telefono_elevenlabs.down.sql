-- Reversa de la migracion 103 (`packages/domain-restaurantes/migrations/103_voz_telefono_elevenlabs.sql`): quita la voz telefonica por sucursal.
-- Manual y solo con OK de Javier (ver docs/ROLLBACK.md). Al borrar la columna Postgres retira tambien sus GRANT por columna (insert/update a authenticated).
-- El codigo tolera la base sin la columna (42703): el panel vuelve a «No disponible aun» y la llamada usa la voz de la plataforma (Regina).
alter table restaurantes.branch_voice_config drop column if exists tts_voice_id;
