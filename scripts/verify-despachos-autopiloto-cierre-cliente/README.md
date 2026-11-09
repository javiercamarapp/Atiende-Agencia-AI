# verify-despachos-autopiloto-cierre-cliente

Prueba contra Postgres REAL de `packages/domain-despachos/migrations/027_despachos_autopiloto_cierre_cliente.sql` (paridad3 D-31, D-P3-19, D-P3-15, D-P3-21).

- `assertions.sql` (juzgado por `scripts/verify-real-postgres-ci/run-gate.mjs` en CI, que descubre este directorio solo):
  - Barrido SAT priorizado: orden por prioridad (nunca consultados, cancelacion «En proceso», recientes, vigentes dentro de la ventana), tope por cliente y global,
    fuera de la ventana no se reconsulta, detalle de cancelacion persistido, `pendiente` que no pisa lo verificado, `cancelado` terminal, aviso de «En proceso» una sola vez.
  - Automatizacion por cliente: rol admin/contador (auditor y otro despacho rechazados), validaciones (correo, plantilla, opt-in exige correo), sin escritura directa, RLS.
  - Solicitudes de documentos: plantilla por cliente, idempotencia, cuenta enmascarada, «no aplica» con motivo, completar/reabrir, trigger de aceptacion/rechazo del documento,
    portal (solo sistema, documento propio del enlace), recordatorios a los 3/7/10 dias, enlace del aviso.
  - Estado de modulos del cierre: balanza, polizas descuadradas, CFDI sin poliza (reversada libera), conciliacion, papel de pagos provisionales, solicitud; cross-tenant y anon.
  - Auto-completar tareas del cierre (solo con auto-check, atribuido a `sistema`), cierre forzado (solo admin, motivo obligatorio).
  - Entrega al cliente: opt-in apagado por omision, periodo cerrado, PDF con firma, `contenido` fuera del GRANT, portal por enlace vigente.
- `run.sh`: lo mismo contra un Postgres efimero local (`initdb`/`pg_ctl`).
- No llama al SAT ni envia correo: los datos son filas ficticias insertadas por la propia verificacion.
