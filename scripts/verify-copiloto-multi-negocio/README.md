# verify-copiloto-multi-negocio

Postgres **real** (el gate de CI `scripts/verify-real-postgres-ci/run-gate.mjs` lo descubre solo): migración
`packages/db/migrations/0056_copiloto_superadmin_multi_negocio.sql` (espejo en `supabase/migrations/`).

Cubre `core.get_operaciones_por_organizacion_for_superadmin`, `core.log_superadmin_org_access`,
`core.list_superadmin_org_access_for_superadmin` y la tabla append-only `core.superadmin_org_access_log`:

- **Agregados por organización**: una fila por cada organización (las SIN actividad salen con 0, no se omiten);
  pedidos que no cuentan (cancelados), ingresos, escalaciones, abiertos y vencidos por vertical; el rango de fechas
  y el filtro por una organización.
- **Acceso**: solo el superadmin completo. El rol `finanzas`, un miembro de una organización, una persona sin rol,
  un `p_caller_id` ajeno, la sesión de sistema y `anon` reciben cero filas o error, nunca datos.
- **Bitácora**: una fila por organización consultada (quién, qué organización, qué herramienta, cuándo); las
  organizaciones inexistentes se ignoran; nadie registra a nombre de otro; no se lee ni se escribe directo
  (sin GRANT) y es append-only (UPDATE y DELETE bloqueados por trigger).
- **Fijados de plataforma** (`core.copiloto_pin` con organización NULL y `core.copiloto_pin_create_plataforma`): solo el
  autor superadmin los ve, renombra y borra; no se comparten; ni un miembro de una organización, ni otro superadmin, ni
  `anon`, ni la sesión de sistema los leen o crean; alta solo por la función (tope de 50, sin duplicados, conversación
  propia); CHECK de coherencia organización/vertical; un superadmin degradado pierde el acceso.
- **Estructura**: funciones `security definer` con `search_path` fijo, sin EXECUTE para `anon`/PUBLIC, tabla con
  RLS y sin policies.

Manual: `scripts/verify-copiloto-multi-negocio/run.sh` (initdb/pg_ctl local).
