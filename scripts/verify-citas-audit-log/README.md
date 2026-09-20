# verify-citas-audit-log

Verificación, contra un Postgres **real**, de
`packages/domain-citas/migrations/023_citas_audit_log.sql`: cierra el hueco de
FASE 3 ("citas no tiene bitácora de auditoría propia de las acciones del
staff", copiado del patrón ya en `main` para restaurantes —
`019_restaurantes_audit_log.sql`, PR #183, el más reciente y ya corregido — y
rentas — `021_rentas_audit_log.sql` + `022_rentas_audit_log_orden_determinista.sql`,
PR #165/#173).

## Qué demuestra

1. **El actor siempre sale de `auth.uid()`, nunca de un parámetro.** Sin sesión
   autenticada (`auth.uid()` NULL, la sesión de sistema), `citas.
   record_audit_log` rechaza en vez de insertar un actor NULL.
2. **Rol suficiente, validado desde el día uno.** SOLO owner/admin/staff
   (`CITAS_ROLES` completo — citas no tiene un rol disjunto de más bajo
   privilegio como el "repartidor" de restaurantes) pueden escribir. Un
   membership real con un `vertical_role` FUERA de ese catálogo (usa
   `'repartidor'`, nombre de rol genérico ya usado en otras verticales de este
   mismo `core.membership`) es RECHAZADO, aunque pertenezca a esa misma
   organización — demuestra que la función valida el rol de verdad, sin confiar
   en que el resto del código de citas nunca produzca esa fila.
3. **Cross-tenant siempre rechazado en la escritura.** Un actor autenticado real
   que NO pertenece a la organización que intenta auditar es rechazado por la
   función, aunque `security definer` bypasse RLS por completo.
4. **Lectura acotada a owner/admin de la organización** — un "staff" real (SÍ
   puede ESCRIBIR, CITAS_ROLES completo) NO puede LEER, ni un owner/admin de
   OTRA organización.
5. **`anon` rechazado por completo**, tanto en lectura de la tabla como en la
   ejecución de la función.
6. **Append-only real.** Ni UPDATE ni DELETE están permitidos para ningún rol —
   ni siquiera el superusuario que corre este script — los triggers de bloqueo
   lo impiden incondicionalmente.
7. **Sin bypass de la función.** `authenticated` no puede insertar directo en la
   tabla (sin policy de INSERT, deny-by-default real).
8. **Catálogo cerrado de `entity_type`.** Un valor fuera de la lista
   (`servicio`/`cita`/`staff`/`configuracion`/`lista_espera`) es rechazado por
   el CHECK antes de llegar a insertar nada.
9. **Truncamiento defensivo desde el día uno**: `campo`/`antes`/`despues` de más
   de 200/500/500 caracteres nunca violan el CHECK — la función trunca con
   `left()` antes del INSERT.
10. **Orden total determinista y paginación estable desde el día uno** (`seq
    bigint generated always as identity` ya vive en la migración 023 — mismo
    criterio ya corregido para rentas en el PR #173 y aplicado desde el día
    uno en restaurantes/PR #183). `now()` (created_at) es constante dentro de
    una transacción; el desempate por `seq` da un orden EXACTO (nunca al azar)
    y hace que la paginación por offset sobre ese empate no repita ni pierda
    filas entre páginas.

23 escenarios cubren `023_citas_audit_log.sql` (ver `assertions.sql` para el
detalle exacto de cada uno) — cada uno corre en su propio
`begin; ... rollback;`; las fixtures (2 organizaciones, 5 staff con roles
distintos, 1 fila de bitácora real) persisten (insertadas directo, como el
superusuario que corre el script).

El caso "023 no aplicada todavía" (esquema de producción a medio migrar, regla
dura de esta fase — ver AGENTS.md "REGLA DURA DE COMPATIBILIDAD CON LA BASE SIN
MIGRAR") NO se prueba con las migraciones reales aquí — este runner siempre
aplica TODAS las migraciones de `supabase/migrations/`, sin forma de saltarse
una a propósito. En su lugar, los escenarios 22/23 simulan "la migración 023
no aplicada" con un `drop function`/`drop table` TRANSACCIONAL dentro del
propio `begin;`/`rollback;` de cada escenario (revertido al final, mismo
patrón que `scripts/verify-restaurantes-audit-log/assertions.sql` 23/24) —
verificando el SQLSTATE real (42883/42P01) y la recuperación real con
SAVEPOINT. La cobertura EQUIVALENTE contra un doble en memoria vive en
`packages/domain-citas/tests/audit-log-savepoint.spec.ts`
(`AbortAwareFakeSession`) — mismo criterio que el resto de "compatibilidad con
la base sin migrar" de esta fase.

## Cómo correrlo

```
scripts/verify-citas-audit-log/run.sh
```

Requiere Postgres instalado localmente (`initdb`/`pg_ctl`/`psql` en PATH). Levanta
un Postgres efímero, aplica el mock mínimo de plataforma (`bootstrap.sql`) +
todas las migraciones reales de `supabase/migrations/` + el GRANT de schema que
en Supabase real pone la plataforma (`post-migrations.sql`), corre
`assertions.sql`, y limpia todo al salir.

Auto-descubierto por `scripts/verify-real-postgres-ci/run-gate.mjs` (y por el gate
de CI `postgres-real-gate.yml`) sin necesitar ningún cambio en ese script/workflow
— cualquier `scripts/verify-*/` con `bootstrap.sql` + `post-migrations.sql` +
`assertions.sql` queda cubierto automáticamente.
