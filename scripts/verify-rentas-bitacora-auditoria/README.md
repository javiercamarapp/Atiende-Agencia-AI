# verify-rentas-bitacora-auditoria

Verificación, contra un Postgres **real**, de
`packages/domain-rentas/migrations/021_rentas_audit_log.sql`: cierra el hueco
detectado al diseñar el panel de superadmin ("rentas no tiene bitácora de
auditoría propia de las acciones del staff").

## Qué demuestra

1. **El actor siempre sale de `auth.uid()`, nunca de un parámetro.** Sin sesión
   autenticada (`auth.uid()` NULL, la sesión de sistema que usan los crons),
   `rentas.record_audit_log` rechaza en vez de insertar un actor NULL.
2. **Cross-tenant siempre rechazado en la escritura.** Un actor autenticado real
   que NO pertenece a la organización que intenta auditar es rechazado por la
   función, aunque `security definer` bypasse RLS por completo — sin este check
   explícito (no pedido literal por el patrón copiado de despachos/hoteles, pero
   necesario aquí), cualquier staff podría sembrar filas de auditoría falsas en la
   bitácora de un tenant ajeno.
3. **Lectura acotada a `admin_gestora` de la organización.** Un miembro real de la
   misma organización sin ese rol ve RLS filtrar en silencio (0 filas, nunca un
   error); un `admin_gestora` de otra organización tampoco ve nada de esta.
4. **`anon` rechazado por completo**, tanto en lectura de la tabla como en la
   ejecución de la función.
5. **Append-only real.** Ni UPDATE ni DELETE están permitidos para ningún rol —
   ni siquiera el superusuario que corre este script — los triggers de bloqueo lo
   impiden incondicionalmente.
6. **Sin bypass de la función.** `authenticated` no puede insertar directo en la
   tabla (sin policy de INSERT, deny-by-default real).
7. **Catálogo cerrado de `entity_type`.** Un valor fuera de la lista es
   rechazado por el CHECK antes de llegar a insertar nada.

15 escenarios cubren `021_rentas_audit_log.sql` (ver `assertions.sql` para el
detalle exacto de cada uno) — cada uno corre en su propio `begin; ... rollback;`;
las fixtures (2 organizaciones, 3 staff con roles distintos, 1 fila de bitácora
real) persisten (insertadas directo, como el superusuario que corre el script).

## Cómo correrlo

```
scripts/verify-rentas-bitacora-auditoria/run.sh
```

Requiere Postgres instalado localmente (`initdb`/`pg_ctl`/`psql` en PATH). Levanta
un Postgres efímero, aplica el mock mínimo de plataforma
(`bootstrap.sql`) + todas las migraciones reales de `supabase/migrations/` +
el GRANT de schema que en Supabase real pone la plataforma
(`post-migrations.sql`), corre `assertions.sql`, y limpia todo al salir.

Auto-descubierto por `scripts/verify-real-postgres-ci/run-gate.mjs` (y por el gate
de CI `postgres-real-gate.yml`) sin necesitar ningún cambio en ese script/workflow
— cualquier `scripts/verify-*/` con `bootstrap.sql` + `post-migrations.sql` +
`assertions.sql` queda cubierto automáticamente.
