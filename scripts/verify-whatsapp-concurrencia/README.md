# verify-whatsapp-concurrencia

Prueba de carga **reproducible** del webhook de WhatsApp de restaurantes. Cubre el P0 de la cuenta real de PM:
"6 o más mensajes simultáneos devuelven HTTP 500 tras 10 s (10 de 10 con 10 concurrentes)".

## Qué corre

`run.sh` levanta un Postgres efímero **con TLS** (el motor de producción lo exige), aplica las migraciones reales de
`supabase/migrations/`, siembra una organización mínima (`seed.sql`) y ejecuta `carga.ts`: la API real de producción
(`buildProductionDeps` + `buildApp`: mismo motor y pool, turn handler real, gateway de LLM real con su presupuesto y
uso en Postgres). Solo se **simulan** las dos salidas de red: OpenRouter (respuesta fija con latencia configurable) y la
Graph API de Meta (servidor local). Nada sale a internet.

## Qué exige

Para 1, 4, 6, 10 y 20 mensajes simultáneos (teléfonos distintos), contra el pool por omisión de 10 conexiones:

- todos los webhooks responden HTTP 200;
- cada mensaje queda procesado exactamente una vez en `whatsapp_inbound_events` (ninguno perdido);
- cada mensaje genera exactamente una respuesta en `messaging_outbox` (ninguna perdida ni duplicada);
- el reenvío del mismo `message.id` (Meta entrega al menos una vez), incluso 3 veces a la vez, responde 200 y no genera otra respuesta.

También imprime el pico de conexiones activas del pool.

## Causa que atrapa

Cada turno del agente retiene 3 conexiones del mismo pool durante la espera del LLM (sesión del webhook, sesión
propia del turn handler y sesiones cortas de presupuesto/uso del gateway). Con pocos turnos simultáneos el pool se llena
de sesiones que esperan a otras y el request muere por `connectionTimeoutMillis` (5 s, dos veces por turno).
Antes del arreglo (`packages/db/src/managed-postgres-engine.ts`, admisión por nivel): 6 simultáneos → 4/6 con 200,
10 simultáneos → 0/10, 20 simultáneos → 0/20. Después: todos con 200.

## Cómo correrlo

- Local: `bash scripts/verify-whatsapp-concurrencia/run.sh [LLM_MS]` (requiere `initdb`/`pg_ctl`/`psql`/`openssl` y `npm ci`).
- CI: job `whatsapp-concurrencia-gate` de `.github/workflows/postgres-real-gate.yml`.
- No usa `assertions.sql` a propósito: `run-gate.mjs` solo auto-descubre los `verify-*` de una conexión.
