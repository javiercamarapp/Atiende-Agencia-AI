# verify-restaurantes-seed-pm

Verificacion contra Postgres real del seed de la cuenta demo "Los Taquitos de PM"
(`packages/domain-restaurantes/src/seed/pm-demo.ts`, CLI en `scripts/seed-pm-demo/`).

`assertions.sql` es **generado**: crea `public.seed_pm_demo()` con el cuerpo plpgsql real del seed y lo
ejecuta (una y dos veces) dentro de cada escenario contra TODAS las migraciones reales. Regenerar:
`node --experimental-strip-types scripts/verify-restaurantes-seed-pm/generar-assertions.ts`
(un test de vitest falla si el archivo commiteado se desincroniza).

Cubre: resultado (7 sucursales, solo T1 y T3 activas, 237 productos, 42 de alcohol `no_domicilio`, 669
precios por sucursal con el precio de cada menu impreso, comida regional solo en T1, 0 fracciones de kilo), reglas del modelo (horario, minimo $200, propina solo tarjeta,
2x1 del lunes solo recoger, voz deshabilitada, asignacion por colonia con la funcion SQL real), idempotencia
(dos corridas, no pisa decisiones del dueño, repara precios), aislamiento (otra organizacion con nombres
iguales intacta, slug de otra vertical aborta, staff ajeno y `anon` no leen lo sembrado).

- Manual: `scripts/verify-restaurantes-seed-pm/run.sh` (levanta un Postgres efimero con `initdb`).
- CI: lo descubre automaticamente `scripts/verify-real-postgres-ci/run-gate.mjs`.
