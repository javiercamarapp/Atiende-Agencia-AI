# verify-rentas-seed (Rn-33 / Rn-36)

Verifica contra **Postgres real** (todas las migraciones de `supabase/migrations/`, RLS/GRANT/`auth.uid()` reales) el seed de la cuenta demo de
rentas (`scripts/seed-rentas-demo`) y las consultas del checklist de onboarding (`GET /v1/rentas/:propertyId/admin/onboarding`).

- `escenarios.sql`: fixtures (dueño, otra organizacion con su staff) y escenarios; cada uno corre en su `begin; ... rollback;` ejecutando el seed
  dentro. El gate evalua un valor por escenario (`..._deberia_ser_N`) o un error esperado (`should_fail`).
- `assertions.sql`: **GENERADO** = funciones `public.seed_rentas_demo()`, `public.seed_rentas_demo_sin_duena()` y `public.limpiar_rentas_demo()`
  (cuerpo REAL del seed y de la limpieza) + `escenarios.sql`. Regenerar con
  `node --experimental-strip-types scripts/verify-rentas-seed/generar-assertions.ts`; un test de vitest falla si se desincroniza del seed o de los `.ics`.
- Cobertura: A resultado (conteos, marca demo, coherencia financiera); B lo que ven el Resumen, los reportes, el monitor y el checklist como el staff
  autenticado; C idempotencia (no duplica, no pisa ediciones del usuario); D aborta con un slug de otra vertical o un dueño inexistente, cross-tenant,
  anon, limpieza completa y propietarios compartidos.
- Ejecucion: `scripts/verify-rentas-seed/run.sh` (Postgres efimero local) o el gate de CI (`node scripts/verify-real-postgres-ci/run-gate.mjs scripts/verify-rentas-seed`).
