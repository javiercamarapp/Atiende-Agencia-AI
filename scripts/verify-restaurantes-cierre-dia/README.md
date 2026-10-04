# verify-restaurantes-cierre-dia

Verificacion contra Postgres real de `packages/domain-restaurantes/migrations/041_cierre_dia_resumen_semanal.sql`
(espejo: `supabase/migrations/20240101000313_041_cierre_dia_resumen_semanal.sql`): cierre del dia y resumen semanal por sucursal
(`restaurantes.cierre_reporte`, `generar_cierre`, `cierre_sucursales_sistema`).

Cubre: agregados exactos del dia (pedidos, ventas en centavos, ticket, cancelados, no recogidos, programado excluido y promovido
incluido, trafico demo 0009 excluido, otra sucursal excluida, bordes 23:59 / 00:00 locales, por canal, tiempos de entrega con
promedio/mediana/p90, comparativo), semana lunes-domingo con `por_dia`, idempotencia por fecha de negocio (una fila, `creado = false`
al repetir, reporte congelado), barrido de sistema que no deja filas vacias, periodo sin terminar / semana que no empieza en lunes /
tipo invalido rechazados (22023), staff de piso / repartidor / admin fuera de alcance / otro tenant / anon / sistema cruzando tenants
rechazados (42501), tabla de solo lectura e aislada por tenant, lista de barrido solo de sistema y sin organizaciones demo, y base
sin migrar (42883 recuperable con subtransaccion).

- Manual: `scripts/verify-restaurantes-cierre-dia/run.sh` (levanta un Postgres efimero con `initdb`).
- CI: lo descubre automaticamente `scripts/verify-real-postgres-ci/run-gate.mjs` (mismo contrato de 3 archivos).
