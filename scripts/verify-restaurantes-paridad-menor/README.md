# verify-restaurantes-paridad-menor

Verificación, contra un Postgres **real**, de las migraciones de la paridad menor F4c:

- `packages/domain-restaurantes/migrations/180_producto_archivado.sql` (espejo `20240101000480_...`): `products.archived_at` (soft-delete de un producto con historial).
- `181_voz_idiomas_sucursal.sql` (espejo `...481_...`): idiomas del agente de voz por sucursal.
- `182_conocimiento_archivos.sql` (espejo `...482_...`): registro de PDF/imágenes cargados a la base de conocimiento.
- `183_agente_whatsapp_personalizacion.sql` (espejo `...483_...`): tono y mensaje adicional del dueño.

## Qué demuestra (cada escenario termina en un solo `count(*)` entero o en ERROR)

- **A (180).** Valor por omisión; archivar y borrar solo el owner/admin de SU organización (cross-tenant y `anon` rechazados); el historial se encuentra por `items @> [{id}]`; borrar arrastra la fila por sucursal; base sin migrar (42703 recuperable con SAVEPOINT).
- **B (181).** Valores por omisión; INSERT/UPDATE solo owner/admin de su organización y de una sucursal propia; CHECK de formato, máximo 4 y sin repetir el principal; lectura del sistema; `anon` fuera.
- **C (182).** INSERT/SELECT/DELETE solo owner/admin; sin UPDATE; CHECK de tipo MIME, tamaño y huella; UNIQUE por huella.
- **D (183).** INSERT/UPDATE solo owner/admin; CHECK de tono, largo y caracteres de control; `updated_by` no se falsifica; lectura del sistema.

## Cómo correrlo

- Local: `bash ~/atiende-loop/heavy.sh scripts/verify-restaurantes-paridad-menor/run.sh` (Postgres efímero en el puerto 55789; no toca ninguna base real). Requiere `initdb`/`pg_ctl`/`psql` (esta Mac no los tiene: **no se corrió aquí**).
- CI: lo descubre solo `scripts/verify-real-postgres-ci/run-gate.mjs`.
