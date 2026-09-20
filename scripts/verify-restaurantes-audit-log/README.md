# verify-restaurantes-audit-log

Verificación, contra un Postgres **real**, de
`packages/domain-restaurantes/migrations/019_restaurantes_audit_log.sql`: cierra
el hueco de FASE 3 ("restaurantes no tiene bitácora de auditoría propia de las
acciones del staff", copiado del patrón ya en `main` para rentas —
`021_rentas_audit_log.sql` + `022_rentas_audit_log_orden_determinista.sql`, PR
#165/#173).

## Qué demuestra

1. **El actor siempre sale de `auth.uid()`, nunca de un parámetro.** Sin sesión
   autenticada (`auth.uid()` NULL, la sesión de sistema), `restaurantes.
   record_audit_log` rechaza en vez de insertar un actor NULL.
2. **Rol suficiente, validado desde el día uno** (a diferencia de
   `rentas.record_audit_log`, que la revisión de rentas señaló que solo exige
   membership, sin validar rol — no bloqueante #9 de esa ronda): SOLO
   owner/admin/staff (`MANAGER_ROLES`) pueden escribir. Un "repartidor" con
   membership REAL en la organización es RECHAZADO, aunque pertenezca a esa
   misma organización.
3. **Cross-tenant siempre rechazado en la escritura.** Un actor autenticado real
   que NO pertenece a la organización que intenta auditar es rechazado por la
   función, aunque `security definer` bypasse RLS por completo.
4. **Lectura acotada a owner/admin de la organización** — más estricta que
   rentas (que admite cualquier `admin_gestora`): un "staff" real (SÍ puede
   ESCRIBIR, MANAGER_ROLES) NO puede LEER, ni un "repartidor", ni un owner/admin
   de OTRA organización.
5. **`anon` rechazado por completo**, tanto en lectura de la tabla como en la
   ejecución de la función.
6. **Append-only real.** Ni UPDATE ni DELETE están permitidos para ningún rol —
   ni siquiera el superusuario que corre este script — los triggers de bloqueo
   lo impiden incondicionalmente.
7. **Sin bypass de la función.** `authenticated` no puede insertar directo en la
   tabla (sin policy de INSERT, deny-by-default real).
8. **Catálogo cerrado de `entity_type`.** Un valor fuera de la lista es
   rechazado por el CHECK antes de llegar a insertar nada.
9. **Truncamiento defensivo desde el día uno** (rentas lo agregó recién en
   revisión, r5 bloqueante 1): `campo`/`antes`/`despues` de más de
   200/500/500 caracteres nunca violan el CHECK — la función trunca con
   `left()` antes del INSERT.
10. **Orden total determinista y paginación estable desde el día uno** (`seq
    bigint generated always as identity` ya vive en la migración 019 — a
    diferencia de rentas, que lo agregó en una segunda migración, `022`, tras
    un bug real + test flaky en el PR #173). `now()` (created_at) es constante
    dentro de una transacción; el desempate por `seq` da un orden EXACTO (nunca
    al azar) y hace que la paginación por offset sobre ese empate no repita ni
    pierda filas entre páginas. La premisa (mismo `created_at`) y el orden
    exacto se combinan en un solo booleano con un único alias
    `deberia_ser_N` — a diferencia del escenario 17 original de rentas (dos
    alias en el mismo bloque), que la revisión r6 señaló como no evaluado por
    completo en el gate automático (`run-gate.mjs` solo lee el primer alias de
    cada bloque).

22 escenarios cubren `019_restaurantes_audit_log.sql` (ver `assertions.sql` para
el detalle exacto de cada uno) — cada uno corre en su propio
`begin; ... rollback;`; las fixtures (2 organizaciones, 5 staff con roles
distintos, 1 fila de bitácora real) persisten (insertadas directo, como el
superusuario que corre el script).

El caso "019 no aplicada todavía" (esquema de producción a medio migrar, regla
dura de esta fase — ver AGENTS.md "REGLA DURA DE COMPATIBILIDAD CON LA BASE SIN
MIGRAR") NO se prueba aquí — este runner siempre aplica TODAS las migraciones de
`supabase/migrations/`, sin forma de saltarse una a propósito (ver la nota al
final de `assertions.sql`). Esa cobertura vive en
`packages/domain-restaurantes/tests/audit-log-savepoint.spec.ts`
(`AbortAwareFakeSession`, SQLSTATE 42883/42P01 sobre `registrarAuditoria` y
`listAuditoria`) — mismo criterio que el resto de "compatibilidad con la base
sin migrar" de esta fase.

## Cómo correrlo

```
scripts/verify-restaurantes-audit-log/run.sh
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
