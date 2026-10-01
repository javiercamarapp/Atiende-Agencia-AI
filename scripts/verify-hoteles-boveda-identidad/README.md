# verify-hoteles-boveda-identidad

Verificación contra Postgres REAL (mismo patrón que `scripts/verify-hoteles-zona-horaria/`)
de `packages/domain-hoteles/migrations/031_hoteles_boveda_identidad.sql` (H-01: bóveda de
identidad, registro migratorio, purga con doble control).

```
scripts/verify-hoteles-boveda-identidad/run.sh        # manual, Postgres efímero local
node scripts/verify-real-postgres-ci/run-gate.mjs scripts/verify-hoteles-boveda-identidad
```

En CI lo ejecuta automáticamente el gate `Postgres real` (auto-descubre `scripts/verify-*`).

## Qué prueba (62 chequeos del gate, 52 escenarios numerados; desde 032 la purga pasa por bloqueo)

- Captura: frontdesk captura en su property; el trigger deriva `organization_id`, sella
  `captured_by`, fuerza `activo`/no verificado; housekeeping y owner de otra organización
  rechazados (RLS); huésped de otra property rechazado (trigger); un `payload_enc` en texto
  plano/JSON rechazado por el CHECK de formato; GRANT de columna (no se puede fijar `status`).
- Lectura: nadie con rol `authenticated` lee `payload_enc` por SELECT (ni owner, ni `select *`);
  cross-tenant ve 0; housekeeping ve 0; UPDATE/DELETE directos cerrados; `anon` rechazado;
  el sobre es inmutable incluso para el superusuario.
- `reveal_identity`: roles owner/gm/frontdesk; `reservations`, cross-tenant, id inexistente,
  `anon` y sesión de sistema rechazados (mismo 42501, sin oráculo de existencia); motivo
  obligatorio; la huella queda en la misma transacción y un intento fallido no deja huella.
- `verify_identity`: sellado server-side; roles sin permiso rechazados.
- Purga con doble control: frontdesk no solicita; el solicitante no puede aprobar ni rechazar
  su propia solicitud; otro owner/gm aprueba y la identidad queda purgada (sobre, last4 y
  nacionalidad anulados) e irrevocable; rechazo deja la identidad intacta; una sola solicitud
  pendiente por identidad; el CHECK `decided_by <> requested_by` impide la auto-aprobación aun
  para el superusuario; cross-tenant rechazado.
- Purga por retención (solo sistema): purga únicamente lo vencido de UNA property, cierra la
  solicitud pendiente y deja huella con actor NULL; un usuario con `auth.uid()` y `anon` rechazados.
- Bitácora: solo owner/gm la leen, append-only (UPDATE rechazado incluso para el superusuario),
  sin escritura directa de `authenticated`.
- Registro migratorio: el trigger copia fechas de la reserva y nacionalidad de la bóveda;
  RLS/GRANT de columna; `reportado` exige constancia y no retrocede; único por reserva+huésped.
- Base sin migrar: con las tablas (42P01) o la función (42883) eliminadas dentro de la misma
  transacción, `SAVEPOINT`/`ROLLBACK TO SAVEPOINT` recupera la sesión (nunca 25P02).
