# verify-restaurantes-autopiloto

Verificacion contra Postgres real de `packages/domain-restaurantes/migrations/050_autopiloto_aprobaciones_y_estados.sql`
(espejo: `supabase/migrations/20240101000324_050_autopiloto_aprobaciones_y_estados.sql`): autopiloto de restaurantes.

Cubre: historial append-only de transiciones de estado (una fila por transicion, actor valido, aislado por tenant), configuracion por
sucursal (valores seguros por omision, solo owner/admin guarda), pedido grande retenido en `por_aprobar` (solo sistema, idempotente),
resolucion de solicitudes (aprobar/rechazar con motivo de lista cerrada, doble clic = un efecto, cross-tenant, fuera de alcance, sistema y
anon rechazados), cancelacion (solo si el pedido no salio), compensacion (descuento de un solo uso con tope, reposicion de $0
idempotente), escalado de solicitudes sin respuesta (una sola vez), barrido de estados sin clic (limpieza por tiempo, aceptacion
automatica con bandera y comanda capturada, compare-and-set), regreso automatico del handoff (una sola vez, no con pedido por aprobar,
no con respuesta humana reciente, frase fija solo dentro de 24 h), agotado solo por hoy (se repone al cambiar el dia de la zona horaria
de la sucursal, no el de UTC), muestras de tiempo de entrega y base sin migrar (42883 recuperable con subtransaccion).

- Manual: `scripts/verify-restaurantes-autopiloto/run.sh` (levanta un Postgres efimero con `initdb`; ademas corre la prueba de
  CONCURRENCIA con dos conexiones simultaneas aprobando la misma solicitud: una aplica, la otra espera el bloqueo y recibe el resultado ya resuelto).
- CI: lo descubre automaticamente `scripts/verify-real-postgres-ci/run-gate.mjs` (mismo contrato de 3 archivos). La prueba de concurrencia
  de dos conexiones solo corre en el manual porque el gate ejecuta cada escenario como una conexion aislada.
