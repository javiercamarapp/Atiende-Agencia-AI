# verify-copiloto-presupuesto

Postgres **real** (el gate de CI `scripts/verify-real-postgres-ci/run-gate.mjs` lo descubre solo): migración
`packages/db/migrations/0047_copiloto_presupuesto_y_roles.sql` (espejo en `supabase/migrations/`).

Cubre CHAT-07 / MOD-12:

- **Subtope del Copiloto** (`reserve_llm_monthly_budget` de 4 argumentos): los roles `*:data_chat` y `*:data_chat_retry` no pasan del
  30 % del tope mensual de su organización; otros roles siguen usando el resto del tope; solo la sesión de sistema reserva (un usuario
  real y `anon` fallan); la de 3 argumentos sigue funcionando.
- **Tope diario de turnos por rol** (`consume_llm_role_turn`): el turno N+1 se rechaza sin consumir, un tope propio de la organización
  manda sobre el default, otra organización no se ve afectada; solo sistema.
- **Ventana horaria** (`record_llm_hour_window`): cuenta llamadas y respaldos; solo sistema.
- **Bitácora** (`record_data_chat_query` de 11 argumentos): costo, modelo y rol; rutas `escalado` y `sin_ia`; actor, membresía y
  cross-tenant conservados; las tablas nuevas no se leen ni escriben directo.
- **Back office** (`get_llm_usage_by_org_role_month_for_superadmin`, `set_/list_llm_org_role_limit(s)_for_superadmin`): solo el
  superadmin con `auth.uid() = p_caller_id`; otro usuario recibe cero filas (lectura) o 42501 (escritura).

Manual: `scripts/verify-copiloto-presupuesto/run.sh` (initdb/pg_ctl local).
