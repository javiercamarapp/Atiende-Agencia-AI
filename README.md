<p align="center">
  <img src="apps/web/public/atiende-wordmark.svg" alt="Atiende" width="220" />
</p>

# Atiende

Monorepo (npm workspaces) de **Atiende**: un backend Hono (`apps/api`) + una
SPA Vite/React (`apps/web`) + jobs de scheduler (`apps/worker`), únicos para
**6 verticales de negocio** (restaurantes, hoteles, citas, licitaciones,
rentas, despachos) sobre un núcleo compartido de tenancy/auth/gateway de LLM
(`packages/core-*`, `packages/agent-core`), más un back office de plataforma
(**superadmin**) transversal a las 6.

No hay número de migraciones/tests/paquetes escrito aquí a propósito — todos
se pudren rápido con el ritmo de esta rama. Donde este documento necesita uno,
apunta al comando que lo calcula.

## Estado real por vertical (19-sep-2026)

Cada fila resume lo que SÍ funciona de punta a punta contra Postgres real y lo
que sigue honestamente pendiente. Para el detalle completo, fase por fase, ver
el `README.md` de cada `packages/domain-<vertical>/` y de cada
`apps/{api,web,worker}/src/.../<vertical>/`.

| Vertical | Funciona de punta a punta | Pendiente honesto |
|---|---|---|
| **restaurantes** | Catálogo, pedidos, clientes, promociones, repartidor, staff, KPIs, agente de WhatsApp con LLM real (envío vía Meta Graph API, credencial pendiente de pegar). | Agente de voz ElevenLabs completo. Crear un pedido por el checkout público (web/voz/WhatsApp) no funciona hoy contra Postgres real — ver "Problemas conocidos" abajo. |
| **hoteles** | Reservas/folios/CFDI de hospedaje (timbrado real vía Finkok/SW Sapien, credencial pendiente), housekeeping, fraude, P&L (USALI), checador de asistencia. | El gate/estado de **revenue management** (shadow/propone/autopilot) es real, pero **no existe ningún motor que produzca una recomendación de tarifa** — solo la máquina de estados, el backtest y la explicación de un precio ya dado. Reputación clasifica reseñas y responde, pero sin ingesta automática de Google/Booking/TripAdvisor (requiere esas credenciales). |
| **citas** | Agenda, reservar/cancelar/confirmar/completar/no-show, horarios y excepciones editables, staff, sincronización real de calendario — **Google Calendar, Cal.com y CalDAV**, credencial por profesional. | Receptor de webhooks de Google Calendar (hoy solo sincronización por lote). |
| **licitaciones** | Conectores OCDS reales y verificados contra la fuente pública: **Nuevo León** (333 convocatorias vigentes confirmadas). Post-adjudicación, cobranza, inconformidades, renovaciones. | **CDMX**: conector real y completo, pero la fuente pública que consume está estancada desde 2023 (no produce convocatorias vigentes hoy). Cobertura nacional depende de un **agregador comercial de pago sin proveedor elegido todavía** (`LICITACIONES_AGGREGATOR_API_KEY`) — ComprasMX en vivo y el DOF no se automatizan (reCAPTCHA/Akamai). |
| **rentas** | Reservas, bloqueos, pricing, sincronización iCal con Airbnb/Booking/VRBO, finanzas y payouts a propietario, limpieza, onboarding self-service, portal de propietario, break-glass de superadmin (**solo lectura**). | Mensajería con huésped tiene aprobación humana real, pero **ningún cliente HTTP real de partner** (Airbnb/Vrbo/Booking.com) existe todavía — enviar un mensaje aprobado siempre falla hasta que se construya. |
| **despachos** | CFDI/facturación, conciliación bancaria, migración de catálogo contable, cierre mensual, devolución de IVA, nómina, bookkeeping, declaraciones, cobranza, staff — panel completo. Correo real con disparo inline (además del cron diario) desde una acción real de staff, p.ej. `POST .../vencimientos/:id/escalar`. | Sin agente de WhatsApp/voz (es el único vertical solo-correo). Ver "Problemas conocidos" abajo. |

## Voz (patrón oficial)

Las 3 verticales con agente de voz (restaurantes, hoteles, citas) exponen
Server Tools HTTP entrantes (`apps/api/src/routes/verticals/<vertical>/
voice-tools.ts`) que ElevenLabs invoca por webhook durante una llamada en
curso, autenticadas con un secreto dedicado (`x-atiende-tool-secret`,
compartido de plataforma en restaurantes/citas, por-property en hoteles) —
nunca `authMiddleware`/`Origin`, porque ElevenLabs no los manda. Este es el
patrón oficial: **no requiere ninguna API key saliente de ElevenLabs**, el
repo nunca inicia una llamada, solo la recibe.

Existió un paquete `packages/voice-gateway` para la dirección saliente
(signed URL de sesión, listado de voces, config de agente) — se retiró del
árbol por falta de cualquier consumidor real (cero imports fuera de
comentarios, ningún endpoint ni UI que lo llamara) y porque conectarlo de
verdad exigía inventar esas superficies desde cero, fuera del alcance
mecánico de una migración. Detalle completo y evidencia en
`docs/CREDENCIALES.md` §"Voz (ElevenLabs) — patrón oficial".

## Problemas conocidos

**Sesión de sistema sin acceso a `core.property` (verificado contra Postgres
real, arreglo en curso en otra rama).** La policy de SELECT de `core.property`
(`packages/db/migrations/0001_core_schema.sql`) exige `auth.uid()` real —
nunca contempló la sesión de sistema (`auth.uid()` NULL) que usan los flujos
sin usuario autenticado: checkout público, agente de voz, agente de WhatsApp.
Cualquier consulta de ESOS flujos que haga JOIN contra `core.property` recibe
cero filas, en silencio. Impacto demostrado hoy: **crear un pedido por el
checkout público de restaurantes (web, voz o WhatsApp) falla contra Postgres
real para cualquier organización** — ver `scripts/verify-restaurantes-sql/README.md`
para la verificación completa. Es plausible que otros flujos de sistema de
otras verticales con el mismo patrón (JOIN contra `core.property` bajo sesión
de sistema) compartan el mismo gap; no se auditaron todos todavía. Es un bug
de disponibilidad, no de fuga de datos (el resultado es "cero filas", nunca
datos de otro tenant) — invisible para los tests en memoria de este repo
(nunca aplican RLS real), por eso pasó sin detectarse hasta correr contra
Postgres real.

## Superadmin (back office de plataforma)

Dashboard, prospectos, "entrar a un panel" con sesión propia sin datos de
cliente real, Gasto de API (tope de LLM por organización/plataforma),
Integraciones (`GET /superadmin/integraciones`, qué credencial falta pegar),
Break-glass (acceso auditado y de solo lectura a datos de un tenant, hoy solo
para rentas), Facturación (MRR/reconciliación de la suscripción SaaS propia de
Atiende vía Stripe, con bitácora completa y filtrable de CADA intento de
`POST /billing/webhook` — procesado/ignorado/rechazado/error, incluidos los
rechazos por firma inválida que antes no quedaban registrados en ningún
lado — ver `packages/db/migrations/0018_billing_webhook_registro.sql`) y
Salud operativa (`/superadmin/salud`,
`apps/api/src/routes/superadmin-salud.ts`: latidos de los 17 crons de
`vercel.json` vía `withHeartbeat`, salud de las 6 colas `messaging_outbox`
—citas/hoteles/restaurantes/despachos/rentas/licitaciones— y última corrida
por fuente de licitaciones). Todas las funciones `security definer` que
exponen este back office están atadas a `auth.uid()` del caller real — ver
`docs/DEPLOY.md` para la lección de orden de despliegue que dejaron esos
fixes.

## Qué falta para desplegar

**`docs/CREDENCIALES.md`** es la lista única y generada-desde-código de qué
variable de entorno falta pegar para que cada pieza deje de responder 503
honesto. **`docs/DEPLOY.md`** documenta el orden seguro (Supabase + Vercel,
tier free) y las lecciones aprendidas — en particular, que mergear un PR a
`main` **no** aplica sus migraciones a la base real, y que un cambio que toca
a la vez SQL y la sesión con que la API lo invoca se despliega código primero.

## Desarrollo

```
npm install
npm run typecheck
npm run lint
npm run test:unit
```

`npm run test:coverage` corre la misma suite instrumentada con
`@vitest/coverage-v8` — ver `docs/COBERTURA.md` para qué mide, qué NO mide
(no certifica SQL/RLS — eso es el gate de Postgres real de abajo) y de dónde
sale el umbral configurado.

`npm run verify:migration-versions` y `npm run verify:env` son guards propios
de este repo — ver `scripts/README.md`. Los `scripts/verify-*/` que corren
contra Postgres real (RLS/GRANT reales, no el repositorio en memoria) tienen
su propio `run.sh` y corren automáticamente en CI
(`.github/workflows/postgres-real-gate.yml`).
