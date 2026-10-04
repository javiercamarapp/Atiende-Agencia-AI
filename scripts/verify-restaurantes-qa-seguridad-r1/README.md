# verify-restaurantes-qa-seguridad-r1

QA restaurantes ronda 1, lente seguridad y datos: escenarios contra Postgres **real** (RLS y GRANT reales) de
`packages/domain-restaurantes/migrations/064_seguridad_rls_alcance_y_privacidad.sql`. Entra al gate de CI
(`scripts/verify-real-postgres-ci/run-gate.mjs` descubre todo `scripts/verify-*/`).

Qué demuestra (62 escenarios; `S*` eran los defectos abiertos y fallaban antes de la 042, `R*` regresión, `P*` positivos):

1. **Escritura por rol y sucursal** (QA-R1-seguridad-01): pedidos (GRANT por columna, nunca total/items; staff acotado a A1 no toca A2;
   el repartidor solo su pedido asignado y no lo reasigna), catálogo (solo roles gestores), `branch_products`/`branch_detail`
   (rol + sucursal) y promociones (rol + alcance de la membresía).
2. **Promociones sin fuga entre organizaciones** (QA-R1-seguridad-02): la sesión de sistema solo resuelve las activas; un usuario solo ve
   las de su organización y solo si es gestor.
3. **Lectura de datos personales por rol y sucursal** (QA-R1-seguridad-03): pedidos, clientes, direcciones, solicitudes de contacto y
   conversaciones de WhatsApp.
4. **Higiene de permisos** (QA-R1-seguridad-11): sin GRANT de SELECT a `anon`, sin funciones ejecutables por PUBLIC, `demo_limpiar`
   sin `public` en el `search_path`.
5. **Privacidad** (QA-R1-seguridad-06/07/10/14): la cancelación ARCO bloquea (`bloqueada`) o anonimiza (`resuelta`) de verdad los
   datos del titular en todos los canales y deja evidencia; la purga por retención cubre solicitudes de contacto, cola de mensajes,
   comandas del POS, notas y la bitácora de voz, cruza canales por teléfono y avisa cuando queda trabajo.

Uso manual: `scripts/verify-restaurantes-qa-seguridad-r1/run.sh` (initdb efímero) o
`PGHOST=<socket> PGPORT=<puerto> node scripts/verify-real-postgres-ci/run-gate.mjs scripts/verify-restaurantes-qa-seguridad-r1`.
