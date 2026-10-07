# verify-rentas-limpieza-autopiloto

Verificación contra Postgres real de
`packages/domain-rentas/migrations/033_rentas_limpieza_autopiloto.sql`
(paridad3 rentas: responsable de limpieza por omisión, validación del asignado, cola de avisos
in-app y SQL del barrido de limpieza por propiedad).

Se auto-descubre en CI (`scripts/verify-real-postgres-ci/run-gate.mjs`); a mano:
`scripts/verify-rentas-limpieza-autopiloto/run.sh` (requiere `initdb`/`pg_ctl`/`psql`).

## Qué cubre (`assertions.sql`)

- A. Responsable por omisión: lo fijan admin_gestora y operador:acceso_total; lo rechazan el operador de
  calendario, limpieza, otra organización, el sistema y anon; el responsable debe ser miembro operativo de la
  propiedad; la columna no admite UPDATE directo; dar de baja al responsable no deja una referencia colgante.
- B. `responsable_limpieza_vigente`: el barrido lo ve; un staff ajeno y un ex-miembro reciben null.
- C. `puede_operar_limpieza` y `listar_asignables_limpieza`: acceso a la propiedad y rol de gestión; sin sondeo
  entre organizaciones.
- D. `notificacion_tarea` como cola de avisos: sistema inserta/lee/marca; cross-tenant; solo la columna
  `notificada_in_app_en` admite UPDATE; anon sin acceso.
- E. definer + search_path fijo, EXECUTE revocado, índices presentes.
- F. SQL real del barrido por propiedad bajo la sesión de sistema (candidatos a tarea por propiedad, buffer pendiente, tareas de reservas
  canceladas o desfasadas, mañana sin responsable), creación de la tarea con responsable y aviso en la cola, y los rechazos cross-tenant.

## Qué NO cubre

- El TypeScript en vivo: los escenarios reproducen el SQL literal del barrido (`barrerLimpiezaPendiente`, con `current_date + 1` en lugar de la cota calculada en TS) (misma limitación estructural que
  el resto de `scripts/verify-*/`); la lógica de dominio se prueba en `packages/domain-rentas/tests/limpieza/` y
  `apps/api/tests/`.
