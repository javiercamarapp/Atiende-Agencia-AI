# verify-restaurantes-cfo-repos

Verificación **opt-in** (no entra al gate de CI) de la capa TypeScript del CFO de restaurantes (CFO-05) contra un Postgres local real.

`run.sh` levanta un Postgres efímero (solo socket unix, puerto `VERIFY_PGPORT`, 55689 por omisión; **nunca** el 5432 de Homebrew), aplica el mock de
plataforma de `scripts/verify-restaurantes-cfo-ventas/bootstrap.sql` y **todas** las migraciones de `supabase/migrations/` (incluidas 081, 082, 083 y 084), y
corre `apps/api/tests/restaurantes-cfo-real-postgres.spec.ts` con `CFO_REAL_PG=1`.

Qué prueba (todo con el rol `authenticated`, `request.jwt.claim.sub` y RLS reales; cada caso es una transacción que termina en `rollback`):

- `PostgresCfoRepository` devuelve **números** (bigint/numeric llegan como string de node-postgres) y conserva `NULL` ≠ 0.
- Roles: owner y admin ven; admin acotado solo lo suyo (sucursal ajena -> `CfoSinAccesoError`); staff y repartidor -> `CfoSinAccesoError`.
- Rango de más de 400 días y listas inválidas -> `CfoParametroInvalidoError` (22023) y la sesión sigue viva (SAVEPOINT).
- Base sin migrar (se borra una función dentro de la transacción): la lectura devuelve `disponible: false` y la siguiente consulta funciona.
- Escrituras: configuración, costos con versiones, importación de SoftRestaurant idempotente (sin datos de cliente) y bitácora de exportaciones.
- `/resumen` de punta a punta por HTTP con la sesión real: el consolidado es la suma de las sucursales y un admin acotado no ve «No asignado».

Sin la variable `CFO_REAL_PG=1` la prueba se omite (así `npm run test:unit` no necesita Postgres).
