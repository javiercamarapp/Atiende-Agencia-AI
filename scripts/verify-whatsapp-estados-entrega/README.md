# verify-whatsapp-estados-entrega

Verificacion contra Postgres REAL (RLS, GRANT y `auth.uid()` reales, nunca el repositorio en memoria) de
`packages/domain-restaurantes/migrations/066_whatsapp_estados_entrega.sql`: guardar el wamid al enviar y avanzar el estado de entrega con los
`statuses` que Meta manda por el webhook.

Cubre: cierre como enviado guardando el wamid (y la sobrecarga de un argumento intacta), avance `sent` -> `delivered` -> `read` sin
retroceder, `failed` gana y conserva su primer error, idempotencia (el mismo estado repetido no cambia nada), motivo del fallo (incluida la
plantilla disponible que no se uso), pedido ligado al aviso, cross-tenant (un wamid de la organizacion A no toca a la B aunque el wamid se
repita), sesion de staff y `anon` sin EXECUTE (42501), estado invalido (22023), la tabla cerrada al staff, el KPI diario de entrega por
sucursal (conteos, sucursal ajena, organizacion ajena) y la retencion (la purga de privacidad borra tambien el estado de entrega).

Se corre solo en el gate de CI (`scripts/verify-real-postgres-ci/run-gate.mjs` descubre este directorio) o a mano con `./run.sh`
(requiere `initdb`/`pg_ctl`/`psql` locales).
