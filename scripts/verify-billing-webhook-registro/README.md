# verify-billing-webhook-registro

Verificación, contra un Postgres **real**, de las 2 funciones nuevas de
`packages/db/migrations/0018_billing_webhook_registro.sql` (bitácora completa
de CADA intento de `POST /billing/webhook`, para el superadmin de
plataforma):

| Función | Qué hace |
|---|---|
| `core.record_billing_webhook_event` | Escritura, solo sesión de SISTEMA (`auth.uid() is null`) — inserta una fila en `core.billing_webhook_log` por cada intento (procesado/ignorado/rechazado/error), con tope anti-inflado para rechazos. |
| `core.list_billing_webhook_log_for_superadmin` | Lectura, atada a `auth.uid() = p_caller_id` real + `core.is_platform_superadmin(p_caller_id)` — filtros opcionales por resultado/tipo/organización/rango de fechas, paginado. |

## Por qué una tabla nueva, nunca se amplía `core.billing_webhook_event`

`core.billing_webhook_event` (`0009_billing_saas_schema.sql`) es la llave de
dedupe atómico de `LedgerStore.marcarVisto` (`insert ... on conflict
(event_id) do nothing`) — su PK es `event_id`. Un evento RECHAZADO (firma
inválida, JSON inválido, sin tenant resuelto) muchas veces no tiene un id de
evento real todavía, o podría traer uno falseado por un atacante que nunca
tuvo el secreto del webhook — insertarlo en la tabla de dedupe lo "gastaría"
y el reintento legítimo de Stripe de ese evento real quedaría descartado como
duplicado. `core.billing_webhook_log` es un log de auditoría aparte, sin
relación de identidad con el ledger: puede haber una fila por cada intento
(exitoso o no), mientras que el ledger solo existe para los que sí llegan a
`markBillingWebhookEventSeen`.

## Qué NUNCA guarda

NUNCA la cabecera `stripe-signature` cruda, NUNCA el payload crudo del
webhook (puede traer PII del customer), NUNCA datos de tarjeta. Solo
metadatos: id de evento (cuando existe), tipo de evento, organización YA
RESUELTA (nullable), resultado, motivo corto y estable (enum/CHECK), y
timestamp — ver el escenario 17 (`assertions.sql`), que verifica esto como
garantía **estructural** (columnas que no existen), no solo de
comportamiento.

## Qué demuestra

17 escenarios (ver `assertions.sql` para el detalle exacto y el porqué de
cada uno):

1. Sesión de SISTEMA (`auth.uid()` null) SÍ puede insertar.
2. Un staff autenticado normal (`auth.uid()` real, nunca sistema) NO puede
   escribir — el patrón exacto que un caller mal armado ejercitaría si
   abriera la sesión del webhook como el caller en vez de como sistema.
3. `anon` no puede ni ejecutar `record_billing_webhook_event`.
4–5. `result`/`reason` fuera de catálogo lanzan (guard explícito + CHECK de
   la tabla, defensa en profundidad).
6. `organization_id` inexistente se guarda como `NULL`, nunca lanza por FK
   rota (best-effort por contrato).
7. Un rechazo con `provider_event_id`/`event_type`/`organization_id` los 3
   `NULL` a la vez (firma inválida real) se inserta igual — sin payload.
8. El MISMO `provider_event_id` insertado 2 veces produce 2 filas — esta
   bitácora es un LOG de auditoría, nunca un dedupe (el dedupe real sigue
   viviendo, sin tocar, en `core.billing_webhook_event`).
9. Tope anti-inflado: 250 intentos de `result = 'rechazado'` en la misma
   ventana de 1 minuto se descartan a partir del 200 — el total nunca pasa
   de 200.
10. El superadmin real, con su propia sesión, ve las filas reales sembradas.
11–12. Filtros por `organization_id`/`result` traen solo lo que matchea.
13. Un staff real (NO superadmin) pasando SU PROPIO id obtiene CERO filas.
14. Ese mismo staff pasando el id de un superadmin real como `p_caller_id`
    (caller-binding) también obtiene CERO filas — el hueco real que esto
    cierra: sin la atadura a `auth.uid()`, cualquier `authenticated` podría
    leer la bitácora completa suplantando al superadmin.
15. Sesión de SISTEMA pasando el id de un superadmin real también obtiene
    CERO filas — el patrón que `apps/api` usaría si `ProductionCoreRepository`
    olvidara abrir la sesión COMO el caller para esta lectura.
16. `anon` no puede ni ejecutar `list_billing_webhook_log_for_superadmin`.
17. `core.billing_webhook_log` nunca tiene columnas de payload/firma cruda.

## Tope anti-inflado — decisión de diseño

`POST /billing/webhook` todavía no tiene ninguna fila en
`@atiende/core-ratelimit::ENDPOINT_POLICIES` — añadir una requeriría wirear
Redis/el limitador distribuido a esta ruta, fuera del alcance de esta tarea.
De los 11 `reason` posibles, solo `firma_invalida` es alcanzable por
cualquiera en internet sin conocer el secreto del webhook. Por eso el tope
vive dentro de `core.record_billing_webhook_event`, acotado a
`result = 'rechazado'`, como una consulta simple sobre el índice
`(result, created_at desc)` que la migración ya crea — verificable contra
Postgres real (escenario 9) sin depender de que Redis esté configurado en el
ambiente.

## Cómo correrlo

```
scripts/verify-billing-webhook-registro/run.sh
```

Requiere `initdb`/`pg_ctl`/`psql` en PATH (Postgres local, p. ej.
`brew install postgresql`). Si faltan, falla explícito en vez de fingir que
corrió algo — no bloquea `npm test`.

`scripts/verify-real-postgres-ci/run-gate.mjs` descubre este directorio
automáticamente (cualquier `scripts/verify-*/` con
`bootstrap.sql`+`post-migrations.sql`+`assertions.sql`) y lo corre en CI
contra el servicio `postgres:` de GitHub Actions — sin intervención manual.
