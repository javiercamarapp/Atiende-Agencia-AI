# verify-rentas-finanzas-autopiloto

Verificacion contra Postgres REAL de la migracion `packages/domain-rentas/migrations/035_rentas_finanzas_autopiloto.sql`
(Rn-P3-05/06/07). 39 escenarios; corre en CI por auto-descubrimiento de `scripts/verify-real-postgres-ci/run-gate.mjs`
(y a mano con `./run.sh`, que levanta un Postgres efimero).

Cubre: forma de `codigo_confirmacion` y `telefono_ultimos4`; RLS de `importacion_pagos(+_linea)` por rol (admin_gestora escribe,
contador lee, operador no ve) y entre tenants; anon; unique por huella; GRANT por columna (solo se reevalua resultado, nota y
ocupacion); trigger que marca `requiere_revision` al cambiar fechas o cancelar aunque quien lo haga no pueda escribir
`reserva_financiero`; `rentas.system_reservas_sin_movimiento` (solo sesion de sistema, ventana acotada); purga de
`rentas_huesped_pii` con `telefono_ultimos4`; y que el statement del mes incluye los movimientos creados por la importacion.

Limite declarado: la idempotencia del importador completo (parser + emparejamiento + repositorio) se prueba en
`packages/domain-rentas/tests/finanzas/importacion-pagos.spec.ts` y `apps/api/tests/rentas-finanzas-autopiloto.spec.ts` con el
repositorio en memoria; aqui se prueba lo que solo Postgres real puede probar (unique, RLS, GRANT, trigger, funciones).
