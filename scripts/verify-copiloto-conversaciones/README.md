# verify-copiloto-conversaciones

Postgres **real** (el gate de CI `scripts/verify-real-postgres-ci/run-gate.mjs` lo descubre solo): migración
`packages/db/migrations/0041_copiloto_conversaciones.sql` (espejo en `supabase/migrations/`).

Cubre `core.data_chat_conversation`, `core.data_chat_message` y `core.append_data_chat_turn` (CHAT-04):

- **Escritura**: solo por `core.append_data_chat_turn`; el autor es `auth.uid()` (sesión de sistema y `anon` no
  escriben); exige membresía vigente (o superadmin vigente para plataforma); la vertical sale de la organización;
  la propiedad debe estar dentro del alcance de la membresía y pertenecer a la organización.
- **Aislamiento**: otro usuario, otra organización y una membresía revocada son indistinguibles de «no existe»
  (`P0002`); el owner NO lee las conversaciones de su staff; el superadmin solo lee las de plataforma que él escribió.
- **Límites**: 200 conversaciones por usuario y organización (`54000` en la 201); al llegar a 100 mensajes el
  siguiente turno abre una conversación de continuación.
- **Renombrar / borrar**: solo `title` es actualizable por el cliente (GRANT a nivel columna); borrar cae en
  cascada a los mensajes; los mensajes no se editan ni se borran uno a uno.
- **Estructura**: sin privilegios para `anon`/`PUBLIC`, RLS activa, `search_path` fijo, ninguna policy `true`.

Manual: `scripts/verify-copiloto-conversaciones/run.sh` (initdb/pg_ctl local).
