# verify-citas-agente-whatsapp

Verificación, contra un Postgres **real**, de `packages/domain-citas/migrations/028_citas_agente_whatsapp_config.sql`
(C-15: conectar el número de WhatsApp y editar la personalidad del agente desde el panel de citas). El repositorio en memoria
no aplica RLS, GRANT ni `auth.uid()`, así que solo esto puede detectar un hueco de seguridad en esa migración.

Cada escenario es un `begin; ... rollback;` que el gate (`scripts/verify-real-postgres-ci/run-gate.mjs`) ejecuta entero con
`ON_ERROR_STOP`; los chequeos son bloques `do $$` que lanzan una excepción BLOQUEANTE si el resultado no es el esperado.

Qué demuestra:

1. owner y admin guardan la personalidad; la versión sube (1, 2); las reglas de varias líneas se guardan recortadas y la sesión
   de sistema (webhook) las lee para armar el prompt.
2. `staff` (miembro sin rol de gestión), un owner de OTRA organización, la sesión de sistema y `anon` no guardan (42501).
3. Conflicto de versión y primera escritura con versión distinta de 0 (AT409).
4. Restablecer deja todo vacío y sube la versión.
5. Validación en SQL: tono fuera de lista, más de 5 reglas o reglas de más de 160 caracteres (22023); nombre largo, saludo con
   carácter de control o nombre con salto de línea (23514).
6. Lectura: owner ve su fila; staff y otra organización ven 0; `anon` sin GRANT; nadie escribe la tabla directamente (42501).
7. Lectura para armar el prompt: sistema y miembros de la organización la leen; otra organización recibe 42501.
8. Conexión del número: owner conecta, admin cambia y pausa; el cron (`system_resolve_active_whatsapp_phone_number_id`) y el
   webhook (`system_resolve_organization_by_whatsapp_phone_number_id`) lo ven; un número pausado no se resuelve; `staff`, otra
   organización, sistema y `anon` no conectan ni desconectan (42501); identificador inválido (22023); un número ya conectado a
   otro negocio responde AT410 sin tocar la fila existente; desconectar borra la fila y dice si había número.
9. `citas.whatsapp_config`: los miembros del staff solo la LEEN (ya no pueden escribirla directo); `anon` sin privilegios.
10. Esquema a medias: sin las funciones el SQLSTATE es 42883, el que captura `runWithSavepointFallback` en el repositorio.

Correr a mano: `scripts/verify-citas-agente-whatsapp/run.sh` (necesita `initdb`/`pg_ctl`/`psql`). El gate de CI
(`scripts/verify-real-postgres-ci/run-gate.mjs`) lo descubre solo.
