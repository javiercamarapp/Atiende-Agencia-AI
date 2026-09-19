# verify-migration-versions

Guard agregado tras un bug real: dos PRs paralelos (#119 `001_folio_stamp_reservation`,
#120 `0008_auth_exchange_code`) mergearon a `main` con el mismo prefijo de timestamp
en `supabase/migrations/` (`20240101000120_...`) — la TERCERA colisión de numeración
de migraciones en un día en este repo, pero la primera que se coló a `main` sin que
nadie la detectara a mano antes de mergear.

Supabase CLI usa ese prefijo como `version` (llave primaria de
`supabase_migrations.schema_migrations`), así que dos archivos con el mismo valor
hacen que `supabase db push`/`migration up` falle o ignore uno de los dos. El gate de
CI existente (`.github/workflows/postgres-real-gate.yml`, vía
`scripts/verify-real-postgres-ci/run-gate.mjs`) **no detectaba esto** porque aplica
cada archivo de `supabase/migrations/` con `psql -f` uno por uno, en orden alfabético,
contra un Postgres real — dos archivos con nombre completo distinto (aunque compartan
prefijo) se aplican sin conflicto ahí, porque `psql` no tiene ninguna noción de
"version". Solo la CLI real de Supabase (o un check explícito como este) lo detecta.

## Qué verifica

`check-migration-versions.ts` expone dos checks puros (sin tocar disco más que
leer), reutilizados tanto por el test unitario como por la CLI:

1. **`findDuplicateVersions`** — ¿dos o más archivos `.sql` de
   `supabase/migrations/` comparten el mismo prefijo de versión (todo antes del
   primer `_`)? Este es el check que habría atrapado el bug real de #119/#120.
2. **`findMirrorDivergences`** — `supabase/migrations/` es, por convención de este
   repo (ver su propio `README.md`), un espejo **byte-idéntico** de migraciones
   reales que viven en `packages/*/migrations/` (incluyendo rutas anidadas como
   `packages/mcp-servers/cfdi/migrations/`). Para cada archivo del espejo, busca
   candidatos con el mismo nombre base (sin el prefijo de timestamp) bajo cualquier
   `migrations/` de `packages/`, y exige que el contenido coincida con **al menos
   uno** de los candidatos encontrados — nunca exige un candidato único, porque
   varios paquetes de dominio reutilizan nombres base genéricos a propósito (p. ej.
   `014_email_outbox_authenticated_grants.sql` existe en más de un
   `domain-*/migrations/`, cada uno con su propio contenido) y este check no debe
   producir falsos positivos por esa ambigüedad. Sin ningún candidato, no hay nada
   que comparar y no se reporta nada (puede ser una migración sin fuente de paquete,
   fuera del alcance de este guard).

## Cómo se conecta

- **`npm run test:unit`** — `packages/db/tests/migration-versions-guard.spec.ts`
  importa las funciones de este módulo y las corre contra fixtures en un directorio
  temporal (`mkdtempSync`), nunca contra `supabase/migrations/` real — incluye un
  caso que reproduce exactamente la colisión real de #119/#120 y confirma que el
  guard la detecta.
- **`.github/workflows/postgres-real-gate.yml`** — corre
  `npm run verify:migration-versions` (que ejecuta este script contra el árbol real
  del repo) como paso propio, **antes** de instalar el cliente `psql` y de esperar a
  que el servicio Postgres acepte conexiones: falla rápido y barato, sin gastar el
  tiempo de levantar Postgres y aplicar 100+ migraciones reales si el problema es
  simplemente un nombre de archivo.

## Uso manual

```
npm run verify:migration-versions
```

o directamente:

```
node scripts/verify-migration-versions/check-migration-versions.ts
```

Sale con código `0` y un mensaje `OK` si no encuentra ningún problema; con código
`1` y el detalle de cada versión duplicada / espejo divergente si encuentra alguno.
