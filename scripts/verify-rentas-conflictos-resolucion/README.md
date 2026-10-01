# verify-rentas-conflictos-resolucion

Verificación contra Postgres real de
`packages/domain-rentas/migrations/026_rentas_conflictos_estado_bitacora.sql`
(Rn-02: conflictos de calendario con estado abierto/resuelto/ignorado con motivo, bitácora
de cada decisión y acción de resolución segura).

Se auto-descubre en CI (`scripts/verify-real-postgres-ci/run-gate.mjs`); a mano:
`scripts/verify-rentas-conflictos-resolucion/run.sh` (requiere `initdb`/`pg_ctl`/`psql`).

## Qué cubre (31 escenarios en `assertions.sql`)

- A. positivo (1-4): ignorar con motivo, resolver cuando el solape ya no existe, resolver
  un conflicto sin segunda ocupación; cada decisión deja su fila de bitácora atribuida a
  `auth.uid()`.
- B. regla segura (5-12): "resuelto" se rechaza mientras las dos ocupaciones sigan cruzadas;
  ignorar exige motivo de 3 a 500 caracteres; acción fuera de catálogo; un conflicto ya
  cerrado no se decide otra vez; resolver nunca toca las reservas.
- C. autorización (13-17): otra organización, otra property de la misma organización, un
  rol de solo lectura, la sesión de sistema y anon.
- D. GRANT/RLS (18-25): el UPDATE directo de 024 está cerrado; la bitácora es solo lectura
  para el staff de la property (sin INSERT/UPDATE/DELETE), otra organización y anon no la ven.
- E. CHECKs y definer (26-31): abierto <=> sin resolución, ignorado con motivo, función
  `security definer` con `search_path` fijo y EXECUTE revocado a public/anon.

## Qué NO cubre

- La concurrencia real de dos decisiones simultáneas sobre el mismo conflicto (el
  `for update` de la función las serializa; cada escenario corre en una sola transacción).
- La lógica TypeScript: la cubren las pruebas de `@atiende/domain-rentas`, `apps/api` y `apps/web`.
