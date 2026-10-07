# verify-hoteles-configuracion

Verificación contra un Postgres real (mismo patrón que `scripts/verify-hoteles-zona-horaria/`) de
`packages/domain-hoteles/migrations/047_hoteles_configuracion_y_equipo.sql` (H-P3-04): funciones `set_tax_config`,
`set_cancellation_policy`, `set_room_type_overbooking` y `set_rate_price` con su bitácora `hoteles.config_audit_log`.

Uso: `scripts/verify-hoteles-configuracion/run.sh` (Postgres local con `initdb`/`pg_ctl`/`psql`), o el gate de CI
(`scripts/verify-real-postgres-ci/run-gate.mjs`, que lo descubre solo).

Qué prueba (27 escenarios): owner/gm escriben y dejan valor anterior y nuevo en la bitácora; una llamada repetida no duplica la
bitácora; frontdesk, accountant, owner de otra organización, anon y la sesión de sistema no escriben; rangos inválidos (22023);
UPDATE directo a `tax_config` y escritura directa a la bitácora rechazados; la bitácora no se lee cross-tenant; la sobreventa editada
se respeta en `hoteles.book_availability`; el precio fijado a mano con `set_rate_price` bloquea la aplicación automática del motor (`tarifa_manual_vigente`), un alta
de tarifa de staff no bloquea nada, la aprobación humana explícita se aplica y limpia la marca, y el trigger no se deja falsificar; base a medio migrar (42883 y 42703) recuperada con SAVEPOINT.
