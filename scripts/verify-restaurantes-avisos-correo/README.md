# verify-restaurantes-avisos-correo

Verificacion contra Postgres REAL (RLS, GRANT y `auth.uid()` reales, nunca el repositorio en memoria) de
`packages/domain-restaurantes/migrations/194_avisos_correo_escalera.sql`: la opcion por organizacion `avisos_correo_escalera` y las dos funciones de
sistema con que el tick existente manda por correo los avisos del agente sin atender (escalera del suelto: sucursal, recordatorio, dueno).

Cubre: solo avisos sin resolver de organizaciones con cerebro_v2 Y la opcion encendida, pasado el umbral o urgentes, dentro de 24 h (positivo y negativos);
el equipo solo de la organizacion pedida y solo con la opcion encendida (cross-tenant y apagada -> 0 filas); rechazo de usuarios autenticados (42501),
`anon` (42501) y parametros invalidos (22023); la columna nace apagada y `authenticated` no puede escribirla.

Se corre solo en el gate de CI (`scripts/verify-real-postgres-ci/run-gate.mjs` descubre este directorio) o a mano con `./run.sh`
(requiere `initdb`/`pg_ctl`/`psql` locales).
