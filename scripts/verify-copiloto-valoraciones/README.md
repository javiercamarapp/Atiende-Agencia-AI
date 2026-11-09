# verify-copiloto-valoraciones

Postgres **real** (el gate de CI `scripts/verify-real-postgres-ci/run-gate.mjs` lo descubre solo): migración
`packages/db/migrations/0079_copiloto_valoraciones.sql` (espejo en `supabase/migrations/20240101000810_0079_copiloto_valoraciones.sql`).

Cubre `core.data_chat_feedback` («Útil / No fue útil» de cada respuesta del Copiloto) y sus dos agregados:

- **Escritura (positivo)**: el autor valora una respuesta del asistente de SU conversación y puede cambiarla (upsert); el superadmin valora las de su conversación de plataforma.
- **Escritura (negativo)**: no se valora la pregunta; el owner no valora la conversación de su staff; nadie escribe a nombre de otro; cross-tenant
  (otra organización o vertical) falla; el motivo solo con «No fue útil» y de la lista cerrada (sin texto libre); sin `delete`; `anon` no escribe ni lee.
- **Lectura**: cada quien ve solo sus filas; owner/admin ven el agregado de su organización; un member, otra organización, la sesión de sistema y `anon`
  no; el superadmin ve el agregado de plataforma solo con `p_caller_id = auth.uid()`; el filtro de fecha se aplica.
- **Estructura**: RLS activa, sin privilegios para `anon`, funciones security definer con `search_path` fijo, ninguna policy `true`, y la ruta de base sin migrar (42P01 + SAVEPOINT).

Manual: `scripts/verify-copiloto-valoraciones/run.sh` (initdb/pg_ctl local).
