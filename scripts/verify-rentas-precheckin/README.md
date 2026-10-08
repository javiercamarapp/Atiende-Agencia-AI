# verify-rentas-precheckin

Verificacion contra Postgres REAL de la migracion `packages/domain-rentas/migrations/036_rentas_precheckin_acceso.sql`
(Rn-P3-08 pre-check-in publico y Rn-P3-09 entrega manual del acceso). Corre en CI por auto-descubrimiento de
`scripts/verify-real-postgres-ci/run-gate.mjs` (y a mano con `./run.sh`, que levanta un Postgres efimero).

Cubre: funciones de sistema (`precheckin_info/verificar/capturar`) solo con `auth.uid()` NULL (anon y staff reciben error);
emparejamiento por codigo + 4 digitos (correcto, telefono distinto, codigo inexistente, reserva pasada, cancelada, de otra
property) con el mismo resultado generico; bloqueo de 1 h tras 5 fallos (tambien para codigos inexistentes) y su vencimiento;
token de un solo uso, vencido, privacidad y reglamento obligatorios, sin sobrescribir un correo del staff ni una captura
previa, forma invalida de correo y WhatsApp; RLS y GRANT por columna de `precheckin_config`/`precheckin_captura` y entre
tenants; tablas de intentos y tokens inaccesibles para authenticated y anon; `acceso_marcar_entregada_manual` (rol, tenant,
idempotencia, la liberacion automatica ya no toma la reserva); una reserva omitida por falta de contacto vuelve a ser candidata
con contacto; purga de retencion del WhatsApp; y 0 funciones `security definer` de rentas sin `search_path` fijo.

Limite declarado: el TypeScript (hash de claves, tiempos de respuesta, mensajes) se prueba en `packages/domain-rentas/tests` y
`apps/api/tests`; aqui solo lo que unicamente Postgres real puede probar (RLS, GRANT, funciones definer, CHECK, purga).
