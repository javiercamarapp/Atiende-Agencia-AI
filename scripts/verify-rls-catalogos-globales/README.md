# verify-rls-catalogos-globales

Gate contra Postgres **real** de las dos únicas tablas de los schemas del repo que no tenían RLS:

- `hoteles.reservation_status_transition`: catálogo de las 8 transiciones válidas de la máquina de estados
  (espejo de `packages/domain-hoteles/src/reservationStateMachine.ts`); la lee el trigger SECURITY INVOKER
  `hoteles.reservation_validate_transition` bajo `authenticated`.
- `rentas.canal`: catálogo de los 4 canales (airbnb, vrbo, booking, manual); lo leen el repositorio de rentas y
  «Chatea con tus datos» bajo `authenticated`.

Ninguna tiene columnas de tenant. El arreglo habilita RLS con una policy de **solo lectura** para `authenticated`
cuyo predicado enumera el dominio cerrado del catálogo (no `using (true)`): sin policy de escritura, ninguna
escritura de `authenticated` pasa aunque un GRANT futuro la abriera, y una fila agregada fuera de una migración
revisada no la ve la app. `service_role` (BYPASSRLS) y el dueño de las tablas no cambian.

**Al agregar un canal o una transición** en una migración, amplía la policy en la misma migración: los
escenarios 6-7 se ponen rojos si una fila sembrada por migraciones queda oculta.

Migraciones: `packages/domain-hoteles/migrations/052_hoteles_rls_reservation_status_transition.sql`
(espejo `20240101000835_…`) y `packages/domain-rentas/migrations/039_rentas_rls_canal.sql` (espejo `20240101000836_…`).

```
scripts/verify-rls-catalogos-globales/run.sh
RLS_CATALOGOS_SKIP_FIX=1 scripts/verify-rls-catalogos-globales/run.sh   # antes del fix: 1, 8 y 9 fallan
```
