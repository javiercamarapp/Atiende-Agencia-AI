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

## Orden actual (41 migraciones, timestamps 20240101000001 .. 20240101000041)

1. `packages/db/migrations/0001_core_schema.sql` — primero porque todo lo demás depende del schema core.
2. `packages/core-conversation/migrations/001_conversation_state_cas.sql`
3–8. `packages/domain-citas/migrations/001..006_*.sql`
9. `packages/domain-despachos/migrations/001_despachos_schema.sql`
10–14. `packages/domain-hoteles/migrations/001..005_*.sql`
15–23. `packages/domain-licitaciones/migrations/001..009_*.sql`
24–30. `packages/domain-rentas/migrations/001..007_*.sql`
31–36. `packages/domain-restaurantes/migrations/001..006_*.sql`
37. `packages/domain-licitaciones/migrations/010_source_runs_and_tender_versions.sql` — Fase 5 (fuera de la secuencia interna 001-009 de licitaciones porque se agregó después de que rentas/restaurantes ya habían tomado los timestamps siguientes; ver regla de "siguiente timestamp libre" abajo).
38–40. `002_despachos_migracion_catalogo_schema.sql` (Fase 5, despachos)/`006_cfdi_hospedaje.sql`/`007_fraude_alerta.sql`/`010_source_runs_and_tender_versions.sql` — **nota**: estos tres timestamps (38-40) ya existían al llegar a esta fase pero este README no se había actualizado para reflejarlos (drift preexistente, no introducido por esta fase — se documenta en vez de reescribir en silencio la sección "orden actual" de fases pasadas que no se auditaron aquí).
41. `packages/domain-despachos/migrations/003_cierre_mensual_schema.sql` — Fase 6 (checklist de cierre mensual: `despachos.periodo_cierre`/`periodo_cierre_tarea`). Nota de numeración interna: la "002" de despachos (migración de catálogo contable, Fase 5) nunca se agregó a `packages/domain-despachos/migrations/` — solo su copia en el timestamp 38 de esta carpeta existe; esta migración de Fase 6 usa "003" como siguiente número libre de esa secuencia interna, documentado también en la cabecera del propio archivo SQL.

Las verticales de dominio no tienen dependencias cruzadas entre sí; se mantuvo el
orden interno de cada una tal como está numerado en su propia carpeta.

## Si agregas una migración nueva a un paquete

1. Crea la migración normalmente dentro de `packages/<paquete>/migrations/`.
2. Cópiala aquí también, renombrada con el **siguiente timestamp libre en la
   secuencia** (el último usado hasta ahora es `20240101000036`; usa
   `20240101000037`, luego `...038`, etc., o cambia a timestamps reales
   `YYYYMMDDHHMMSS` del día en que agregas la migración — lo único que importa es
   que sean estrictamente crecientes respecto a los que ya existen aquí).
3. No edites el contenido SQL al copiarlo: debe ser una copia exacta del original.
4. Actualiza este README si cambia el conteo total o el orden de una vertical.
