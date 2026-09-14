# Migraciones consolidadas para la Supabase CLI

Los archivos `.sql` de esta carpeta son **copias derivadas, byte-idénticas**, de las
migraciones reales que viven en:

- `packages/db/migrations/`
- `packages/core-conversation/migrations/`
- `packages/domain-citas/migrations/`
- `packages/domain-despachos/migrations/`
- `packages/domain-hoteles/migrations/`
- `packages/domain-licitaciones/migrations/`
- `packages/domain-rentas/migrations/`
- `packages/domain-restaurantes/migrations/`

Existen únicamente porque la Supabase CLI (`supabase db push` / `supabase migration
...`) exige que las migraciones vivan en `supabase/migrations/` con el formato de
nombre `<YYYYMMDDHHMMSS>_<nombre>.sql` y timestamps estrictamente crecientes. El
repo organiza el SQL real por paquete de dominio (monorepo), así que esta carpeta
es solo un espejo renombrado para que la CLI funcione desde la raíz del repo.

**La fuente canónica sigue siendo cada paquete de dominio.** Cada paquete referencia
sus propias migraciones (en su código, tests, docs) usando las rutas originales en
`packages/*/migrations/*.sql` — esos archivos no se tocan ni se eliminan.

## Orden actual (68 migraciones, timestamps 20240101000001 .. 20240101000068)

1. `packages/db/migrations/0001_core_schema.sql` — primero porque todo lo demás depende del schema core.
2. `packages/core-conversation/migrations/001_conversation_state_cas.sql`
3–8. `packages/domain-citas/migrations/001..006_*.sql`
9. `packages/domain-despachos/migrations/001_despachos_schema.sql`
10–14. `packages/domain-hoteles/migrations/001..005_*.sql`
15–23. `packages/domain-licitaciones/migrations/001..009_*.sql`
24–30. `packages/domain-rentas/migrations/001..007_*.sql`
31–36. `packages/domain-restaurantes/migrations/001..006_*.sql`
37. `packages/domain-despachos/migrations/002_despachos_migracion_catalogo_schema.sql` — Fase 5 despachos.
38. `packages/domain-hoteles/migrations/006_cfdi_hospedaje.sql` — Fase 5 hoteles.
39. `packages/domain-hoteles/migrations/007_fraude_alerta.sql` — Fase 5 hoteles.
40. `packages/domain-licitaciones/migrations/010_source_runs_and_tender_versions.sql` — Fase 5 licitaciones (andamiaje de ingesta + historial de versiones de convocatoria).
41. `packages/domain-restaurantes/migrations/007_admin_backoffice_grants_and_policies.sql` — Fase 5 restaurantes (back-office CORE: GRANTs + policies de staff para catálogo/sucursales/pedidos que antes eran de solo lectura).
42–47. `packages/domain-licitaciones/migrations/011..016_*.sql` — Fase 6 licitaciones, seguimiento post-adjudicación (REQ-051..055): máquina de estados del contrato + historial (011), extracción determinista del contrato firmado (012), cobranza/facturas (013), redactor de inconformidades (014), autopsia del fallo + lecciones aprendidas (015), radar de renovaciones (016).
48. `packages/domain-despachos/migrations/003_cierre_mensual_schema.sql` — Fase 6 despachos (checklist de cierre mensual: `despachos.periodo_cierre`/`periodo_cierre_tarea`).
49. `packages/domain-citas/migrations/007_crisis_guardrail.sql` — Fase 6 §1 citas (guardia de crisis: `citas.emergency_escalations`).
50. `packages/domain-citas/migrations/008_calendar_provider_accounts.sql` — Fase 6 §2 citas (cuentas Cal.com/CalDAV por proveedor).
51. `packages/domain-citas/migrations/009_email_outbox_dispatch.sql` — Fase 6 §3 citas (dispatcher de correo: `attempts`/`last_error` + claim/complete acotados a channel='email').
52. `packages/domain-citas/migrations/007_messaging_outbox_dispatch.sql` — dispatcher real transversal de `citas.messaging_outbox` (claim-con-lease + retry/backoff/dead para channel='whatsapp'), pieza compartida por todas las verticales (ver `packages/whatsapp-gateway`). Comparte tabla con la migración 51 (channel='email' vs channel='whatsapp' — ver comentario de cabecera en ambos archivos SQL, sin colisión posible entre ambas).
53. `packages/domain-hoteles/migrations/008_messaging_outbox.sql` — `hoteles.messaging_outbox` completo (hoteles no tenía NINGÚN concepto de outbox antes de esta rama).
54. `packages/domain-restaurantes/migrations/007_messaging_outbox.sql` — `restaurantes.messaging_outbox` completo (mismo caso que hoteles).
55. `packages/domain-hoteles/migrations/008_night_audit.sql` — Fase 6 hoteles (night audit propio, REQ-REV-013).
56. `packages/domain-hoteles/migrations/009_housekeeping_mantenimiento_turnos.sql` — Fase 6 hoteles (tickets de mantenimiento + turnos de camaristas, REQ-HK-008/011).
57. `packages/domain-rentas/migrations/008_ical_sync_schema.sql` — Fase 5 rentas: sincronización de calendario por canal (feeds iCal externos de Airbnb/Booking.com/VRBO, bookkeeping de versión/anti-eco, cuarentena).
58. `packages/domain-citas/migrations/010_appointment_status_transitions.sql` — Fase 7 citas: transición de estado confirmar/completar/no-show desde el panel de staff (`confirm_appointment_from_panel`/`complete_appointment_from_panel`/`mark_appointment_no_show_from_panel`), con evento de auditoría propio (`appointment_audit_events.event_type` ampliado a 'confirmed'/'completed'/'no_show').
59. `packages/domain-rentas/migrations/009_rentas_mensajeria_schema.sql` — Fase 7 rentas: mensajería con huésped (borrador de IA + aprobación humana obligatoria) — `rentas.conversacion`/`rentas.mensaje`/`rentas.borrador_mensaje` (property-scoped) + `rentas.plantilla_mensaje` (organization-scoped).
60. `packages/domain-hoteles/migrations/010_checador_asistencia.sql` — Fase 8 hoteles (REQ-BO-024, LFT art.132 fr.XXXIV): checador de asistencia inalterable (`hoteles.attendance_log`, append-only, encadenado por hash por empleado vía trigger SECURITY DEFINER) + horario programado (`hoteles.staff_schedule`) contra el que se cruza lo trabajado para marcar horas extra no autorizadas — gap real verificado contra el original (`packages/db/migrations/0118_attendance_log.sql`), que no existía en ninguna forma en domain-hoteles antes de esta fase (`housekeeping/turnos-lft.ts` valida la PLANTILLA de turnos, no registra fichaje real).
61. `packages/domain-citas/migrations/011_citas_admin_backoffice_grants_and_policies.sql` — Fase 8 citas: panel admin CRUD real de proveedores/servicios/tenant_config — mismo gap y mismo arreglo que la migración 41 (restaurantes): GRANTs de escritura a `authenticated` sobre `citas.providers`/`citas.services`/`citas.tenant_config` (sus policies `for all` de la migración 3 eran letra muerta sin el GRANT) + GRANT y policy de escritura nuevos para `citas.provider_services` (el checkbox real de asignar servicios a un proveedor), que no tenía ninguno de los dos.
62. `packages/domain-licitaciones/migrations/017_source_ingestion_and_deadline_reminders.sql` — Fase 8 licitaciones: primer conector automatizado REAL (`compras_mx_historico`, histórico de contratos de ComprasMX vía datos.gob.mx) — agrega el id al CHECK de `source_run.source` + `licitaciones.tender_deadline_reminder` (recordatorios de vencimiento próximo, mismo patrón "sin canal de envío real" que `tender_change_notification`).
63. `packages/domain-rentas/migrations/010_rentas_limpieza_schema.sql` — Fase 8 rentas: módulo operativo de limpieza/mantenimiento (tareas, checklist, inventario, incidencias) — cierra el gap donde "limpieza" solo existía como valor del enum `razon` de `rentas.ocupacion` (`BUFFER_LIMPIEZA`). Agrega `rentas.tarea_operativa`/`rentas.item_inventario`/`rentas.incidencia_mantenimiento` (property-scoped) + `rentas.checklist_item_tarea`/`rentas.foto_checklist_item`/`rentas.movimiento_inventario`/`rentas.notificacion_tarea` (hijas, RLS vía join) + 3 columnas nuevas de buffer/SLA sobre `rentas.property_config` (ya existente desde la Fase 1, nunca una tabla de configuración propia).
64. `packages/domain-restaurantes/migrations/008_repartidor_order_assignment.sql` — Fase 8 restaurantes: superficie real del rol "repartidor" — `restaurantes.orders.assigned_repartidor_id`/`estimated_delivery_at`/`incident_note` (dispatch real de un pedido a un repartidor + la incidencia que reporta), sin policies nuevas de RLS a propósito (ver comentario de cabecera del propio archivo SQL: la autorización fina vive en la capa TS, igual que el resto de este vertical).
65. `packages/domain-hoteles/migrations/011_revenue_engine_gate.sql` — Fase 9 hoteles (REQ-REV-003, P0/GOB): motor de revenue management (pricing) — máquina de estados real shadow/propone/autopilot (`hoteles.revenue_engine_gate`) con su autoridad en un trigger de Postgres (nunca un flag de aplicación: exige 90 días mínimos en shadow, un backtest walk-forward vigente que pase, y una aprobación explícita del rol `owner` registrada en un UPDATE previo antes de habilitar autopilot pleno) + historial inmutable de corridas de backtest (`hoteles.revenue_backtest_run`). Gap real verificado contra el original (`packages/db/migrations/0082_revenue_engine_gate.sql`): domain-hoteles no tenía ninguna carpeta `revenue/` antes de esta fase. Diferencia deliberada documentada en la cabecera del propio archivo SQL: usa una aprobación de "owner" en vez del "founder_reserved_category" del original, que fusion no ha portado.
66. `packages/domain-rentas/migrations/011_rentas_email_outbox.sql` — Fase 9 rentas: correo transaccional real al huésped (confirmación de reserva al crearla + recordatorio de check-in 24-48h antes, ambos deterministas/sin IA, distintos del borrador con aprobación humana de la migración 59). Agrega `rentas.messaging_outbox` (mismo shape que `hoteles.messaging_outbox`, partición por `property_id`) + `rentas.claim_email_outbox_batch`/`rentas.complete_email_outbox_job` (mismo patrón acotado a `channel='email'` que la migración 51 de citas) + `rentas.ocupacion.recordatorio_checkin_enviado_en` (belt-and-suspenders sobre el dedupe_key real del outbox, mismo criterio que `citas.appointments.reminder_24h_sent_at`).
67. `packages/domain-restaurantes/migrations/009_order_notifications.sql` — Fase 9 restaurantes: notificaciones reales de cambio de estado de pedido — cliente por WhatsApp real vía `restaurantes.messaging_outbox` (ya existente desde la migración 54, sin tabla nueva) cuando el pedido pasa a preparando/en_camino/entregado/cancelado, y `restaurantes.staff_order_notification` (bandeja nueva, consultable por polling del panel admin — sin push real disponible en este monorepo, mismo criterio "honesto" que `licitaciones.tender_change_notification`) para pedido nuevo/incidencia/asignación a repartidor.

68. `packages/domain-licitaciones/migrations/018_alert_notifications.sql` — Fase 10 licitaciones: despacho proactivo real de `tender_deadline_reminder` (Fase 8) + `renewal_alert` (Fase 6) + facturas vencidas de `contract_invoice` (Fase 6) — hasta esta fase las 3 eran solo registros consultables manualmente. Agrega `licitaciones.messaging_outbox` (organization-scoped, `channel` acotado a `'email'` únicamente porque este vertical NO tiene WhatsApp, a diferencia de citas/hoteles/restaurantes) + `enqueue_messaging_outbox`/`claim_email_outbox_batch`/`complete_email_outbox_job` (mismo patrón exacto que la migración 51 de citas/66 de rentas) + `licitaciones.organization_notification_recipients(org_id)` (resuelve el staff `owner`/`admin` de la organización vía `core.membership`/`core.staff_user`, el "responsable" al que se le manda el correo).

Las verticales de dominio no tienen dependencias cruzadas entre sí; se mantuvo el
orden interno de cada una tal como está numerado en su propia carpeta.

## Si agregas una migración nueva a un paquete

1. Crea la migración normalmente dentro de `packages/<paquete>/migrations/`.
2. Cópiala aquí también, renombrada con el **siguiente timestamp libre en la
   secuencia** (el último usado hasta ahora es `20240101000068`; usa
   `20240101000069`, luego `...070`, etc., o cambia a timestamps reales
   `YYYYMMDDHHMMSS` del día en que agregas la migración — lo único que importa es
   que sean estrictamente crecientes respecto a los que ya existen aquí). Verifica
   siempre el último archivo real con `ls supabase/migrations/` antes de elegir el
   tuyo — esta sección de "orden actual" puede desactualizarse entre fases, y
   **varias ramas construidas en paralelo pueden colisionar en el mismo número**
   (ya pasó varias veces en esta sesión) — si al mergear encuentras dos archivos
   con el mismo prefijo de timestamp, renumera uno de los dos antes de continuar,
   nunca dejes una colisión sin resolver.
3. No edites el contenido SQL al copiarlo: debe ser una copia exacta del original.
4. Actualiza este README si cambia el conteo total o el orden de una vertical.
