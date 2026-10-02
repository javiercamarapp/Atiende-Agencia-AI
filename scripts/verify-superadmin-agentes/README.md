# verify-superadmin-agentes

Verificacion contra Postgres real de `packages/db/migrations/0044_superadmin_corridas_y_panel_agentes.sql`
(bitacora de corridas `core.agent_run` y catalogo `core.agent_definition`).

Los repositorios en memoria nunca aplican GRANT ni RLS: este directorio es la prueba de que las garantias de la
migracion se cumplen contra privilegios reales.

## Que cubre (47 escenarios, auto-descubiertos por `scripts/verify-real-postgres-ci/run-gate.mjs`)

- **Escritura solo-sistema** (`core.record_agent_run`): la sesion de sistema escribe; un staff, un superadmin real y
  `anon` son rechazados; estado, disparo y tareas incoherentes los rechazan los CHECK; el correo y el telefono del
  error se redactan en la base y un error de 900 caracteres se guarda en 500.
- **Sin acceso directo**: ni `authenticated` (aun superadmin) ni `anon` leen o escriben `core.agent_run` /
  `core.agent_definition` (RLS sin politicas + REVOKE).
- **Lecturas con caller-binding** (`list_agent_runs_for_superadmin`, `get_agent_panel_for_superadmin`): el superadmin ve
  datos; un staff, el OWNER de otra organizacion (cross-tenant), un `sub` que no coincide con `p_caller_id` y la
  sesion de sistema reciben CERO filas; `anon` no puede ni ejecutar; limites y rango acotados.
- **Cuadre de 30 dias**: exito (corridas ok / corridas) sale de `core.agent_run` y el costo de `core.llm_usage_daily`
  (rol y rol escalado); las corridas de 40 y 100 dias quedan fuera de la ventana; un agente sin datos sale en ceros.
- **Retencion y purga**: la clase `plataforma_agent_run` (90 dias) esta registrada; `core.system_purge_agent_runs`
  borra solo lo anterior a la retencion y solo la ejecuta la sesion de sistema.
- **`core.system_agent_is_live`**: solo-sistema; decide si el fallo de un agente avisa a los superadmins.

## Correr a mano

    scripts/verify-superadmin-agentes/run.sh

En CI lo corre el job `Postgres real (gate)` (`.github/workflows/postgres-real-gate.yml`).
