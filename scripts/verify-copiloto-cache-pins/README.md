# verify-copiloto-cache-pins

Postgres **real** (el gate de CI `scripts/verify-real-postgres-ci/run-gate.mjs` lo descubre solo): migración
`packages/db/migrations/0045_copiloto_cache_ruta_pins.sql` (espejo en `supabase/migrations/`).

Cubre CHAT-06 / MOD-05 / CHAT-15:

- **Cache** (`core.data_chat_cache`, `data_chat_cache_get/_put/_purge`): solo la sesión de sistema (`auth.uid()` nulo)
  puede usarlas; un usuario autenticado, `anon` y el acceso directo a la tabla fallan; una entrada vencida no se
  devuelve; el TTL se acota a 24 h; el valor se acota a 64 KB y debe ser un objeto; la purga quita lo vencido.
- **Ruta en la bitácora** (`record_data_chat_query` de 8 argumentos): guarda `directa`/`cache`/`llm` (cualquier otro valor
  queda en null); conserva las defensas de la de 7 (actor, membresía, cross-tenant) y la de 7 sigue funcionando.
- **Fijados** (`core.copiloto_pin`, `copiloto_pin_create`): el autor ve los suyos; los compartidos los ve la organización
  SOLO si el autor es owner/admin (y dejan de verse si lo degradan); otra organización, otro usuario sin membresía y
  `anon` no ven nada; compartir exige autor owner/admin; solo `title`/`shared` son actualizables; alta solo por la
  función (actor = `auth.uid()`, conversación propia, tope de 50, deduplicación).
- **Estructura**: RLS activa, sin privilegios para `anon`, `search_path` fijo en las funciones definer, ninguna policy `true`.

Manual: `scripts/verify-copiloto-cache-pins/run.sh` (initdb/pg_ctl local).
