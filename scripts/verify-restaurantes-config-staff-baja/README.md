# verify-restaurantes-config-staff-baja

Verificación, contra un Postgres **real**, de dos migraciones de esta fase (FASE 3
producto de restaurantes):

- `packages/db/migrations/0024_remove_membership.sql` (`core.remove_membership` —
  baja de un staff YA ACEPTADO, genérico de `core`, expuesto vía
  `apps/api/src/routes/verticals/restaurantes/admin-staff.ts::DELETE
  .../admin/staff/miembros/:userId`).
- `packages/domain-restaurantes/migrations/
  021_restaurantes_config_editable_y_search_path_fix.sql`
  (`whatsapp_channel_config`/`known_zone` — INSERT/UPDATE/DELETE nuevos, owner/admin,
  expuestos vía `admin-config.ts`).

## Qué demuestra

### A) `core.remove_membership`

1. **Positivo real.** Owner Y admin de la organización dan de baja a un staff de
   rango menor — el `core.membership` desaparece de verdad (verificado con un
   `count(*)` dentro de la misma transacción, antes del `rollback`).
2. **Negativo (rol insuficiente).** Un "staff" (rango < admin) nunca puede ejecutar
   la función, ni siquiera contra un target de rango igual o menor. Un "admin"
   nunca puede tocar a un "owner" (rango mayor).
3. **Cross-tenant.** Un owner real de OTRA organización jamás puede dar de baja a
   un staff de esta — rechazado por "no perteneces a esta organización" (la
   función es `security definer`, bypassa RLS, pero re-valida la pertenencia
   DENTRO de sí misma).
4. **`anon` rechazado por completo** — sin `GRANT EXECUTE`.
5. **Auto-baja SIEMPRE bloqueada**, para cualquier rol, incluido el único owner.
6. **"No dejar la organización sin ningún owner" — demostrado por
   EXHAUSTIVIDAD**, no solo por el chequeo explícito de conteo: con Org A en su
   estado normal (un único owner), NINGÚN caller posible puede removerlo — ya lo
   prueban por sí solos "admin no puede tocar a alguien de más alcance" (regla 2)
   y "auto-baja siempre bloqueada" (regla 5); staff/repartidor tienen aún menos
   rango que admin. La invariante "la organización siempre conserva al menos 1
   owner" se sostiene por construcción de las otras dos reglas — el chequeo
   explícito de conteo (`v_owner_count <= 1`) es defensa en profundidad
   documentada como tal, no la única barrera. El escenario 8 demuestra además que
   ese chequeo NO bloquea por error el caso normal: con 2 owners reales, remover a
   uno de ellos sí es legítimo (deja 1, nunca 0).
7. **Esquema de producción a medio migrar** (`0024` no aplicada todavía): el SQL
   REAL que `PostgresCoreRepository.removeMembership` emite, con la función
   eliminada DENTRO de la misma transacción (DDL transaccional, revertido al
   `rollback` final), falla con SQLSTATE 42883 — recuperado con
   `SAVEPOINT`/`ROLLBACK TO SAVEPOINT` (el mismo mecanismo que
   `runWithSavepointFallback` usa en producción, no solo el doble en memoria de
   `packages/db/tests/postgres-core-repository-remove-membership-fallback.spec.ts`).

### B) `whatsapp_channel_config` / `known_zone`

8. **Positivo real.** Owner Y admin (mismo umbral) conectan un número de WhatsApp
   / agregan y borran una zona conocida.
9. **Negativo (rol insuficiente).** Un "staff" o "repartidor" real de la MISMA
   organización es rechazado por RLS (42501) — esta configuración es
   deliberadamente MÁS angosta que `MANAGER_ROLES` (que sí deja a "staff" tocar
   catálogo/precios).
10. **Cross-tenant.** Un owner real de OTRA organización es rechazado.
11. **`anon` rechazado por completo** — sin ningún `GRANT`.
12. **Esquema de producción a medio migrar** (`021` no aplicada todavía): a
    diferencia de `restaurantes.audit_log` (tabla NUEVA), estas dos tablas YA
    EXISTÍAN desde Fase 1/2 — lo que falta al no aplicar `021` es el
    `GRANT`/policy de escritura, así que el SQLSTATE real es 42501
    (`insufficient_privilege`), nunca 42883/42P01/42703. Demostrado revocando el
    `GRANT INSERT` DENTRO de la misma transacción y emitiendo el SQL REAL que
    `PostgresRestaurantesRepository.upsertWhatsappChannelConfig` corre —
    recuperado con el mismo `SAVEPOINT`/`ROLLBACK TO SAVEPOINT`.

18 escenarios en total (ver `assertions.sql` para el detalle exacto de cada uno) —
cada uno corre en su propio `begin; ... rollback;`; las fixtures (2 organizaciones,
6 staff con roles distintos, incluido un segundo owner solo para el escenario 8)
persisten (insertadas directo, como el superusuario que corre el script).

## Cómo correrlo

```
scripts/verify-restaurantes-config-staff-baja/run.sh
```

Requiere Postgres instalado localmente (`initdb`/`pg_ctl`/`psql` en PATH). Levanta
un Postgres efímero, aplica el mock mínimo de plataforma (`bootstrap.sql`) + todas
las migraciones reales de `supabase/migrations/` + el GRANT de schema que en
Supabase real pone la plataforma (`post-migrations.sql`), corre `assertions.sql`, y
limpia todo al salir.

Auto-descubierto por `scripts/verify-real-postgres-ci/run-gate.mjs` (y por el gate
de CI `postgres-real-gate.yml`) sin necesitar ningún cambio en ese script/workflow —
cualquier `scripts/verify-*/` con `bootstrap.sql` + `post-migrations.sql` +
`assertions.sql` queda cubierto automáticamente.
