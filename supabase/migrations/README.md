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

## Orden actual (58 migraciones, timestamps 20240101000001 .. 20240101000058)

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
58. `packages/domain-rentas/migrations/009_rentas_mensajeria_schema.sql` — Fase 7 rentas: mensajería con huésped (borrador de IA + aprobación humana obligatoria) — `rentas.conversacion`/`rentas.mensaje`/`rentas.borrador_mensaje` (property-scoped) + `rentas.plantilla_mensaje` (organization-scoped).

Las verticales de dominio no tienen dependencias cruzadas entre sí; se mantuvo el
orden interno de cada una tal como está numerado en su propia carpeta.

## Si agregas una migración nueva a un paquete

1. Crea la migración normalmente dentro de `packages/<paquete>/migrations/`.
2. Cópiala aquí también, renombrada con el **siguiente timestamp libre en la
   secuencia** (el último usado hasta ahora es `20240101000057`; usa
   `20240101000058`, luego `...059`, etc., o cambia a timestamps reales
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
