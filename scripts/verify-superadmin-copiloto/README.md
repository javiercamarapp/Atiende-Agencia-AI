# verify-superadmin-copiloto

Postgres **real** (el gate de CI `scripts/verify-real-postgres-ci/run-gate.mjs` lo descubre solo): migración
`packages/db/migrations/0048_copiloto_plataforma.sql` (espejo en `supabase/migrations/20240101000296_0048_copiloto_plataforma.sql`).

Cubre el Copiloto de superadmin (CHAT-16):

- **Bitácora con alcance de plataforma** (`core.data_chat_query_log` + `core.record_data_chat_query` de 11 argumentos): una fila de
  plataforma nace sin organización y solo por un superadmin vigente (el rol `finanzas` también, para que su consulta quede auditada);
  un owner de organización, un staff sin membresía, la sesión de sistema y `anon` no pueden sembrarla; un superadmin sin membresía no
  puede prestarse la identidad de un cliente; el actor es siempre `auth.uid()`; la vertical de un cliente sale de la organización.
  Los CHECK de coherencia (plataforma ⇔ sin organización) rechazan combinaciones falsas; la tabla sigue append-only y sin INSERT directo.
- **RLS**: el owner no ve filas de plataforma; ni el superadmin las lee directo (solo por funciones definer); la bitácora de cada
  organización sigue igual.
- **Gasto mensual propio** (`core.get_copiloto_plataforma_gasto_mes`): suma solo las filas de plataforma del mes en curso; caller-binding
  (`auth.uid() = p_caller_id`); quien no es superadmin, la sesión de sistema y la identidad suplantada reciben 0; `anon` no ejecuta.
- **Reporte de uso** (`core.get_copiloto_uso_for_superadmin`): agregados por vertical/resultado/ruta solo para el superadmin completo (no para
  `finanzas`), con caller-binding y rango acotado.
- **Conversación de plataforma** (`core.append_data_chat_turn`, ya existente): scope/vertical plataforma sin organización, solo el autor la ve
  (ni otro superadmin ni un owner), no se continúa una ajena (`P0002`), sin propiedad (`22023`), solo superadmin (`42501`).
- **Estructura**: `security definer` con `search_path` fijo, sin EXECUTE para `anon`/`PUBLIC`, RLS activa sin policy `true`, y la decisión
  documentada de que `core.llm_usage_daily` conserva `organization_id` obligatorio y no se le agrega ningún CHECK nuevo (el gasto del Copiloto de plataforma se mide en la bitácora).

Manual: `scripts/verify-superadmin-copiloto/run.sh` (initdb/pg_ctl local).
