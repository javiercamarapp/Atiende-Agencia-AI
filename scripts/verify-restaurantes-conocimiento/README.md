# verify-restaurantes-conocimiento

Verificacion contra Postgres real de `packages/domain-restaurantes/migrations/053_conocimiento_negocio_y_control_agente.sql`
(espejo: `supabase/migrations/20240101000323_053_conocimiento_negocio_y_control_agente.sql`).

Tres piezas: `restaurantes.conocimiento_negocio` (politicas, FAQ y avisos temporales), `restaurantes.whatsapp_sucursal_control`
(interruptor duro del agente de WhatsApp por sucursal) y `branch_voice_config.mensaje_inicial_interrumpible`.

- Positivos: owner crea/edita/borra conocimiento general y de sucursal, sustitucion de una entrada general por una de sucursal, la sesion de
  sistema (webhook, sin usuario) lee el conocimiento y el interruptor, el upsert exacto del repositorio del interruptor, la bandera de voz.
- Negativos: CHECK de longitud/tipo/prioridad/vigencia invertida, `reemplaza_id` hacia una entrada de otra organizacion, staff sin permiso
  (0 filas), cross-tenant (0 filas y `with check`), sucursal ajena, `anon` sin lectura ni escritura.
- Base sin migrar: sin la tabla el SELECT falla con 42P01 y `SAVEPOINT` recupera la transaccion.

- Manual: `scripts/verify-restaurantes-conocimiento/run.sh`.
- CI: lo descubre `scripts/verify-real-postgres-ci/run-gate.mjs` (mismo contrato de archivos que los demas `verify-*`).
