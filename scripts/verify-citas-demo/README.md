# verify-citas-demo

Verificacion contra Postgres real del seed demo de citas (`packages/domain-citas/src/seed/citas-demo.ts`, CLI en
`scripts/seed-citas-demo/`) y de la migracion `030_citas_demo_organization` (`citas.demo_organization`, `citas.demo_limpiar`).

`assertions.sql` es **generado**: crea `public.seed_citas_demo()` (y dos variantes: con `--fecha-base` y con un owner inexistente) con
el cuerpo plpgsql real del seed y lo ejecuta (una y dos veces) dentro de cada escenario contra TODAS las migraciones reales. Regenerar:
`node --experimental-strip-types scripts/verify-citas-demo/generar-assertions.ts` (un test de vitest falla si el archivo commiteado se
desincroniza).

Cubre: resultado (2 organizaciones marcadas, 8 servicios, 6 profesionales, 20 clientes `@example.test`, 49 citas con los 5 estados en
cada negocio, todas dentro del horario del profesional en hora local, pasado/futuro coherentes, 10 filas de lista de espera),
idempotencia (dos corridas, ids/horarios/estados sin cambio, semanas por `--fecha-base`), aislamiento (otra organizacion con los mismos
nombres y telefono intacta, staff ajeno y `anon` no leen lo sembrado, nadie de la aplicacion escribe la marca), limpieza (solo la demo
indicada, sin filas huerfanas, negada a `anon`/`authenticated`/con `auth.uid()` y a organizaciones sin marca) y seguridad del seed (slug de
otra vertical o de una cuenta real aborta, sin owner aborta, atomico).

- Manual: `scripts/verify-citas-demo/run.sh` (levanta un Postgres efimero con `initdb`).
- CI: lo descubre automaticamente `scripts/verify-real-postgres-ci/run-gate.mjs`.
