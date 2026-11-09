# verify-restaurantes-avisos-del-telefono

Verificacion contra Postgres REAL (RLS, GRANT y `auth.uid()` reales, nunca el repositorio en memoria) de
`packages/domain-restaurantes/migrations/193_avisos_del_telefono.sql`: la funcion de sistema con la que el cerebro v2 de WhatsApp lee los avisos
(callback_requests) de un telefono (guarda de alergia en crear_pedido, dedupe por categoria).

Cubre: solo las filas de la organizacion y el telefono pedidos (nunca otro tenant ni otro telefono), del mas reciente al mas viejo, ventana acotada
(p_horas se recorta a 1..48), rechazo de usuarios autenticados (42501), `anon` (42501) y parametros nulos (22023).

Se corre solo en el gate de CI (`scripts/verify-real-postgres-ci/run-gate.mjs` descubre este directorio) o a mano con `./run.sh`
(requiere `initdb`/`pg_ctl`/`psql` locales).
