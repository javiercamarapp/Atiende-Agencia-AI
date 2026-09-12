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
37. `packages/domain-despachos/migrations/002_despachos_migracion_catalogo_schema.sql` — Fase 5 despachos (esta lista quedó desactualizada respecto al conteo real de archivos en esta carpeta antes de esta edición; no se reconstruye retroactivamente el detalle de las entradas 37-40 agregadas por otras fases, solo se documenta la 41 nueva de esta fase — ver los propios nombres de archivo en esta carpeta para el detalle exacto y actual).
38. `packages/domain-hoteles/migrations/006_cfdi_hospedaje.sql` — Fase 5 hoteles.
39. `packages/domain-hoteles/migrations/007_fraude_alerta.sql` — Fase 5 hoteles.
40. `packages/domain-licitaciones/migrations/010_source_runs_and_tender_versions.sql` — Fase 5 licitaciones.
41. `packages/domain-restaurantes/migrations/007_admin_backoffice_grants_and_policies.sql` — Fase 5 restaurantes (back-office CORE: GRANTs + policies de staff para catálogo/sucursales/pedidos que antes eran de solo lectura).

Las verticales de dominio no tienen dependencias cruzadas entre sí; se mantuvo el
orden interno de cada una tal como está numerado en su propia carpeta.

## Si agregas una migración nueva a un paquete

1. Crea la migración normalmente dentro de `packages/<paquete>/migrations/`.
2. Cópiala aquí también, renombrada con el **siguiente timestamp libre en la
   secuencia** (el último usado hasta ahora es `20240101000041`; usa
   `20240101000042`, luego `...043`, etc., o cambia a timestamps reales
   `YYYYMMDDHHMMSS` del día en que agregas la migración — lo único que importa es
   que sean estrictamente crecientes respecto a los que ya existen aquí). Verifica
   siempre el último archivo real con `ls supabase/migrations/` antes de elegir el
   tuyo — esta sección de "orden actual" puede desactualizarse entre fases.
3. No edites el contenido SQL al copiarlo: debe ser una copia exacta del original.
4. Actualiza este README si cambia el conteo total o el orden de una vertical.
