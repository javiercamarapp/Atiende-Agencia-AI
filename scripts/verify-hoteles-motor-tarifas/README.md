# verify-hoteles-motor-tarifas

Verificación manual, opt-in, contra un Postgres LOCAL real (mismo patrón que
`scripts/verify-citas-audit-log/`) de que
`packages/domain-hoteles/migrations/029_rate_recommendation_engine.sql` cierra lo
que dice cerrar: RLS/GRANT reales sobre `hoteles.rate_recommendation` /
`hoteles.pricing_rule` / `hoteles.local_event` / `hoteles.competitor_rate`, y la
integración real (no solo unitaria) del trigger de transición de estado de
`rate_recommendation` con el gate y el backtest **ya existentes** de
`011_revenue_engine_gate.sql`.

## Uso

```
scripts/verify-hoteles-motor-tarifas/run.sh
```

Requiere `initdb`/`pg_ctl`/`psql` en PATH (Postgres local, ej. `brew install
postgresql`). Levanta un Postgres efímero, aplica TODAS las migraciones reales de
`supabase/migrations/`, y corre `assertions.sql`.

## Qué prueba (26 escenarios, ver comentario de cabecera de `assertions.sql`)

1. Positivo: staff owner/gm aprueba en "propone"; el sistema aplica después
   (escribe `hoteles.rate_plan` de verdad — efecto real, no solo "no hubo 500").
2. Negativo: rol insuficiente (frontdesk) no puede aprobar/capturar/configurar.
3. Cross-tenant: un owner ajeno no ve ni puede tocar la recomendación de otra
   organización.
4. `anon`: rechazado por completo (lectura y escritura), en las 4 tablas nuevas.
5. Integración con el gate: aprobar en "shadow" — rechazado; aplicar directo en
   "propone" sin pasar por "aprobada" — rechazado.
6. Integración con el backtest: aplicar en "autopilot" cuando el ÚLTIMO backtest ya
   no pasa (aunque el gate se promovió legítimamente con uno anterior) — rechazado.
7. Límite de variación: "autopilot" con backtest OK pero la variación excede
   `propone_max_variation_pct` — rechazado (guarda de seguridad deliberada de v1,
   ver comentario del trigger en la migración).
8. Estado terminal inmutable: una recomendación "descartada" no puede volver a
   transicionar.
9. Esquema de producción a medio migrar: `hoteles.system_apply_rate_recommendation`
   eliminada dentro de la misma transacción → SQLSTATE 42883 real, recuperado con
   `SAVEPOINT`/`ROLLBACK TO SAVEPOINT` reales (mismo mecanismo que
   `runWithSavepointFallback` en producción).

## Hallazgo real que este script encontró (y que un test en memoria no podría)

La policy de SELECT inicial (`using (core.has_property_access(auth.uid(),
property_id))`) rompía silenciosamente el `INSERT ... RETURNING` que la sesión de
sistema (`auth.uid() is null`) necesita para insertar una recomendación nueva:
Postgres exige que la fila insertada también pase la policy de SELECT para poder
incluirla en `RETURNING`, y ninguna fila cumplía `has_property_access(null, ...)`.
Se corrigió permitiendo también `auth.uid() is null` en la policy de SELECT (la
sesión de sistema es un actor interno de confianza, no un extraño anónimo).
