# verify-citas-whatsapp-mensajes

Verificación, contra un Postgres **real**, de `packages/domain-citas/migrations/026_citas_whatsapp_mensajes_config.sql`
(C-04: mensajes de WhatsApp editables desde el panel de citas). El repositorio en memoria no aplica RLS, GRANT ni
`auth.uid()`, así que solo esto puede detectar un hueco de seguridad en esa migración.

Qué demuestra (cada escenario en su propio `begin; ... rollback;`):

1. owner y admin guardan; la versión sube (1, 2) y el historial guarda anterior/nuevo y el actor real.
2. `staff` (miembro sin rol de gestión), un owner de OTRA organización, la sesión de sistema y `anon` no guardan (42501).
3. Conflicto de versión (AT409) y primera escritura con versión esperada distinta de 0 (AT409).
4. Restablecer deja los valores de fábrica y agrega una fila al historial con acción `restablecido`.
5. Los CHECK de la tabla rechazan largo > 600, anticipación fuera de 1-72 y ventana invertida (23514).
6. Lectura: owner/admin ven su configuración e historial; `staff`, otra organización y `anon` ven 0 filas; `anon` sin GRANT.
7. Sin escritura directa: ni el owner puede `insert/update/delete` la tabla ni el historial (42501); el historial no se
   reescribe ni se borra (trigger 0A000 incluso para el dueño de la tabla).
8. Lectura para enviar: con `auth.uid()` nulo y un miembro de la organización leen ESA configuración; un usuario de otra organización recibe 42501.
9. Esquema a medias: sin la función, el SQLSTATE es 42883 (el que captura `runWithSavepointFallback` en el repositorio).

Correr a mano: `scripts/verify-citas-whatsapp-mensajes/run.sh` (necesita `initdb`/`pg_ctl`/`psql`). El gate de CI
(`scripts/verify-real-postgres-ci/run-gate.mjs`) lo descubre solo.
