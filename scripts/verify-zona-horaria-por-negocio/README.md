# verify-zona-horaria-por-negocio

Verificación contra Postgres REAL (RLS + GRANT reales — nunca el repositorio en
memoria, que no aplica ninguno de los dos) de la autorización real de las dos
migraciones de FASE 3 (producto, "zona horaria por negocio"):

- `packages/domain-despachos/migrations/012_property_config_zona_horaria.sql`
  (`despachos.property_config`)
- `packages/domain-restaurantes/migrations/022_zona_horaria_branch_detail.sql`
  (`restaurantes.branch_detail.zona_horaria`)

Corre automáticamente en CI (`.github/workflows/postgres-real-gate.yml`, que
descubre cualquier `scripts/verify-*/` con `bootstrap.sql`/`post-migrations.sql`/
`assertions.sql`) y también a mano con `./run.sh`.

## Qué verifica (13 escenarios)

**`despachos.property_config`** — la policy de escritura filtra
`vertical_role = 'admin'` **en SQL**, no solo en la capa TS
(`assertVerticalRole(GESTIONAR_CONFIGURACION_ROLES)` en `configuracion.ts`):

1-2. Positivo: `admin` real de una organización inserta y luego actualiza la
   config de SU property.
3. Negativo: `contador` de la MISMA organización, con acceso a la MISMA
   property, es RECHAZADO por RLS (no solo por el `assertVerticalRole` de la
   ruta HTTP — si algún día un caller nuevo se saltara esa capa, RLS sigue
   siendo la última línea de defensa real).
4. Cross-tenant: staff real de OTRA organización es RECHAZADO.
5. Cross-tenant (lectura): staff de otra organización nunca VE la fila (0
   filas, nunca un error, nunca una fuga).
6-7. Alcance por property: un `admin` real de la organización correcta, pero
   con `membership.property_ids` acotado a OTRA property de esa misma
   organización, es RECHAZADO sobre la property que no le corresponde (6) y
   SÍ puede sobre la que sí le corresponde (7) — prueba que
   `core.has_property_access` manda, no solo "organización + rol correctos".
8a-8b. `anon` no tiene ningún acceso, ni de lectura ni de escritura.

**`restaurantes.branch_detail.zona_horaria`** — a diferencia de
`despachos.property_config`, esta columna se agregó a una tabla YA existente
cuya policy de escritura **no filtra por `vertical_role`** desde antes de esta
fase (mismo criterio que `phone`/`address`/`lat`/`lng` — ver el comentario de
cabecera de la migración 022 para por qué no se angosta aquí):

9. Positivo: staff real de la organización con rol `"staff"` (nunca
   `owner`/`admin`) SÍ puede editar la zona horaria de su sucursal — documenta
   a propósito que la restricción a "owner/gm" de esta fase vive en la capa TS
   (`STAFF_INVITE_ROLES` en `admin-config.ts`), no en RLS, para esta tabla en
   particular.
10. Cross-tenant: staff real de OTRA organización actualiza 0 filas (RLS
    filtra en silencio, nunca lanza una excepción — así se comporta un
    `UPDATE` real cuyo `USING` no matchea ninguna fila, a diferencia del
    `INSERT` de `despachos.property_config`, que sí lanza).
11. `anon` SÍ puede LEER `zona_horaria` (información no sensible de un
    negocio, mismo criterio que `phone`/`address`, ya públicos desde la
    migración 014 — el checkout público necesita leer `branch_detail`).
12. `anon` NUNCA puede ESCRIBIR `zona_horaria` (`permission denied`, ni
    siquiera llega a evaluar RLS — no hay `GRANT UPDATE` para ese rol).

## Cómo correr

```
scripts/verify-zona-horaria-por-negocio/run.sh
```

Requiere `initdb`/`pg_ctl`/`psql` en PATH (Postgres local, p. ej.
`brew install postgresql`). Levanta un Postgres efímero propio (nunca toca el
servicio de Postgres local que ya esté corriendo), aplica **todas** las
migraciones reales de `supabase/migrations/` en orden (esquema completo, no "a
medio migrar" — esa compatibilidad contra una base SIN estas 2 migraciones
aplicadas ya la cubren los tests con `AbortAwareFakeSession`:
`packages/domain-despachos/tests/postgres-repository-property-config-savepoint.spec.ts`
y `packages/domain-restaurantes/tests/zona-horaria-branch-savepoint.spec.ts`),
corre los 13 escenarios y limpia todo al salir.
