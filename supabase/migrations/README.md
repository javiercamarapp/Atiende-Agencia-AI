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

## Orden actual (37 migraciones, timestamps 20240101000001 .. 20240101000037)

1. `packages/db/migrations/0001_core_schema.sql` — primero porque todo lo demás depende del schema core.
2. `packages/core-conversation/migrations/001_conversation_state_cas.sql`
3–8. `packages/domain-citas/migrations/001..006_*.sql`
9. `packages/domain-despachos/migrations/001_despachos_schema.sql`
10–14. `packages/domain-hoteles/migrations/001..005_*.sql`
15–23. `packages/domain-licitaciones/migrations/001..009_*.sql`
24–30. `packages/domain-rentas/migrations/001..007_*.sql`
31–36. `packages/domain-restaurantes/migrations/001..006_*.sql`
37. `packages/domain-licitaciones/migrations/010_source_runs_and_tender_versions.sql` — Fase 5 (fuera de la secuencia interna 001-009 de licitaciones porque se agregó después de que rentas/restaurantes ya habían tomado los timestamps siguientes; ver regla de "siguiente timestamp libre" abajo.

Las verticales de dominio no tienen dependencias cruzadas entre sí; se mantuvo el
orden interno de cada una tal como está numerado en su propia carpeta.

Ramas paralelas ya agregaron migraciones 38-40 antes de esta (hoteles/despachos —
`004_despachos_migracion_catalogo_schema.sql`, `006_cfdi_hospedaje.sql`,
`007_fraude_alerta.sql`), y Fase 6 citas agrega 41-43:

41. `packages/domain-citas/migrations/007_crisis_guardrail.sql` — Fase 6 §1 (guardia de crisis: `citas.emergency_escalations`).
42. `packages/domain-citas/migrations/008_calendar_provider_accounts.sql` — Fase 6 §2 (cuentas Cal.com/CalDAV por proveedor).
43. `packages/domain-citas/migrations/009_email_outbox_dispatch.sql` — Fase 6 §3 (dispatcher de correo: `attempts`/`last_error` + claim/complete acotados a channel='email').

## Si agregas una migración nueva a un paquete

1. Crea la migración normalmente dentro de `packages/<paquete>/migrations/`.
2. Cópiala aquí también, renombrada con el **siguiente timestamp libre en la
   secuencia** (el último usado hasta ahora es `20240101000043`; usa
   `20240101000044`, luego `...045`, etc., o cambia a timestamps reales
   `YYYYMMDDHHMMSS` del día en que agregas la migración — lo único que importa es
   que sean estrictamente crecientes respecto a los que ya existen aquí). Revisa
   siempre el listado real de `supabase/migrations/*.sql` antes de asumir cuál es
   el último — ramas en paralelo pueden haber tomado timestamps más nuevos.
3. No edites el contenido SQL al copiarlo: debe ser una copia exacta del original.
4. Actualiza este README si cambia el conteo total o el orden de una vertical.
