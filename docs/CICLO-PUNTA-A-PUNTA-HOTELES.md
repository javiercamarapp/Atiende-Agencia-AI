# Ciclo del huesped de punta a punta - Hoteles

Que parte de cada etapa del huesped esta **medida** hoy con una corrida real, cual solo esta **calculada** y cual esta **pendiente de una credencial**
(o de construir). La evidencia es el ledger de la simulacion de un mes de un hotel sintetico:
[`docs/qa/2026-10-03-simulacion-mes-hoteles/ledger.json`](qa/2026-10-03-simulacion-mes-hoteles/ledger.json) (30 dias, 3 707 eventos, 453 asserts duros, 0 fallidos), generado por
`scripts/simular-mes-hoteles/run.sh --dias=30` (ver [su README](../scripts/simular-mes-hoteles/README.md)) contra la API real y un Postgres efimero con
las migraciones reales. Documento hermano: [COSTO-PUNTA-A-PUNTA-HOTELES.md](COSTO-PUNTA-A-PUNTA-HOTELES.md). Formato igual al de Likida
(`docs/asistencia/CICLO-PUNTA-A-PUNTA.md`).

## Como leer los estados

| Estado | Significa |
|---|---|
| **MEDIDO** | Ocurrio en la corrida: hay filas/eventos en el ledger y el assert duro correspondiente pasa. Se cita la tabla o el evento. |
| **CALCULADO** | El numero sale de unidades medidas por una tarifa citada del repo (p. ej. tokens x precio del gateway), no de una factura. |
| **PENDIENTE DE CREDENCIAL** | El codigo existe y se ejercito con un doble en el borde de red, pero el servicio real (Meta, PAC, Stripe, Resend, OpenRouter) no esta contratado/configurado. Nada de lo cobrado/enviado es real. |
| **NO CONSTRUIDO** | No existe el flujo en el codigo (hueco de producto), no es solo falta de credencial. |

Los dobles en uso: LLM guionado sobre el proveedor y el gateway reales, `FakeWhatsAppGraphClient`, PAC falso (`DualPacCfdiPort` con adaptadores fake) y
`InMemoryPaymentsPort`; cualquier otro host sale bloqueado y contado (assert `cero-llamadas-externas`).

## Etapas

| # | Etapa | Estado | Medido en el ledger | Codigo (archivo:linea) | Pendiente |
|---|---|---|---|---|---|
| 1 | Descubrimiento (el prospecto pregunta por WhatsApp) | MEDIDO con LLM guionado / PENDIENTE DE CREDENCIAL (Meta, OpenRouter) | 119 mensajes entrantes por el webhook firmado; 59 llamadas a `consultar_disponibilidad` y 60 a `registrar_contacto_no_operativo`; filas `whatsapp_conversations` +210, `whatsapp_inbound_events` +258 | `apps/api/src/routes/verticals/hoteles/whatsapp.ts:50`; `packages/domain-hoteles/src/reservas-agente/herramientas.ts:49` | Numero de Meta y `OPENROUTER_API_KEY` reales; la calidad de un modelo real no se mide aqui |
| 2 | Cotizacion | MEDIDO (individual por agente, grupo por API) | 59 llamadas a `cotizar_estancia`; 3 cotizaciones de grupo (3 enviadas, 1 aceptada, 1 rechazada, 1 vencida por el cron) | `packages/domain-hoteles/src/reservas-agente/herramientas.ts:64`; `apps/api/src/routes/verticals/hoteles/grupos.ts:199` | - |
| 3 | Reserva | MEDIDO | 339 reservas directas aceptadas y 11 rechazadas por inventario (409); `reservation` +368 filas contando las pre-reservas confirmadas; 59 pre-reservas del agente (`booking_hold` +59), 46 aprobadas, 13 rechazadas, 29 confirmadas a reserva; grupo: 1 bloqueo (6 noches), anticipo y rooming; 12 cancelaciones libres y 6 con penalizacion. Assert `cero-sobreventa-*` en verde los 30 dias | `reservas.ts:214`, `reservas.ts:354` (cancelar); `reservas-agente.ts:134` (decidir), `:153` (confirmar); `grupos.ts:256` (aceptar), `:263` (anticipos), `:287` (rooming); `grupos-liberacion-cron.ts:75` | Cobro del anticipo en linea (Stripe) y link de pago real |
| 4 | Pre-llegada (recordatorio, pre-check-in) | NO CONSTRUIDO | Solo existe el correo de reserva creada: 955 filas en `messaging_outbox` (correo + WhatsApp) en el mes | `reservas.ts:291` (`reservation.created`); no hay cron ni plantilla de pre-llegada en `docs/CRONS.md` | Construir el flujo; el envio de correo ademas requiere `RESEND_API_KEY` |
| 5 | Check-in | MEDIDO | 264 check-in por recepcion; 134 capturas de identidad en la boveda cifrada (`identity_vault` +134); 32 llegadas sin habitacion lista (registradas como evento, ver Limites) | `recepcion.ts:191`; `identidad.ts:206` | - |
| 6 | Estancia (limpieza, F&B, mantenimiento por WhatsApp) | MEDIDO con LLM guionado | 81 pedidos de F&B por WhatsApp (`fnb_order` +81, 81 confirmaciones de cocina; assert `alergia-sin-promesa-de-seguridad`); 58 reportes de falla; 60 rondas de limpieza (`housekeeping_task` +868) | `llm-turn-handler.ts:150`/`:166` (herramientas); `pedidosFnb.ts:94`; `housekeeping.ts:193` (mantenimiento), `:447` (generar tareas), `:545` (inspeccionar) | Agente real |
| 7 | Cargos y night audit | MEDIDO, con hallazgo **H-NA-1** | `charge` +1 065 filas; 30 corridas de night audit, una por noche, todas por el disparo manual de gerencia porque el cron falla (ver Hallazgos); asserts `noche-posteada-una-vez`, `noche-posteada-completa`, `hospedaje-igual-a-tarifa`, `iva-ish-cuadran` y `no-show-procesado` en verde | `folios.ts:186` (cargos); `night-audit.ts:81` (cron), `:134` (manual); `postgres-repository.ts:1857` | Arreglar H-NA-1 (migracion de policy) |
| 8 | Tickets y SLA | MEDIDO | 55 tickets (`guest_ticket_event` +138), 14 asignados, 14 iniciados, 22 cerrados; barrido de SLA diario; assert `sla-vencido-escalado` | `tickets.ts:159`; `tickets-sla-cron.ts:72` | Aviso in-app de escalamiento (notificaciones) no se mide aqui |
| 9 | Check-out y pago | MEDIDO el flujo / PENDIENTE DE CREDENCIAL el cobro real | 246 check-out; 246 pagos (efectivo, transferencia y tarjeta con `InMemoryPaymentsPort`); 246 folios cerrados en cero (assert `folios-en-cero-al-checkout`) | `recepcion.ts:257`; `folios.ts:472` (pagos), `:539` (cerrar); `production/deps.ts:350` | Stripe real; ademas **H-PAG-1** (500 en vez de 503 sin la llave) |
| 10 | CFDI | MEDIDO el flujo / PENDIENTE DE CREDENCIAL el timbre | 112 timbrados con PAC falso (`cfdi_emision` +112), 11 reintentos idempotentes sin segundo timbre, 9 cancelaciones; asserts `cfdi-un-vigente-por-folio` y `cfdi-total-cuadra` | `cfdi.ts:188` (emitir), `:439` (cancelar); `cfdi.ts:322` (correo `cfdi.issued`) | CSD y cuenta de Finkok/SW Sapien: sin ellas el timbre real responde 503 |
| 11 | Resena | MEDIDO la encuesta propia / PENDIENTE DE CREDENCIAL las resenas publicas | 68 resenas capturadas (22 negativas), 22 tickets creados desde resena | `reputacion.ts:126`; `tickets.ts:240` | Captura automatica de Google/Booking/TripAdvisor: hoy es manual |
| 12 | ARCO y purga | MEDIDO | 5 solicitudes ARCO (2 llevadas a ejecutada el dia 1); 102 purgas de identidad con doble control (solicita gerencia, decide la duena) y cron diario | `privacidad.ts:238` (alta), `:249` (avanzar); `identidad.ts:293`; `identidad-purga-cron.ts:59` | El plazo ARCO solo se recorre completo el dia 1 (ver Limites) |
| T | Revenue (transversal) | MEDIDO los insumos, **H-REV-1** bloquea el motor | 4 reglas de precio, 60 tarifas de competencia, 1 evento local, gate en `shadow`; el cron corre 30 veces y omite la property todos los dias | `revenue-recommendations-cron.ts:239`; `postgres-repository.ts:2360`; `011_revenue_engine_gate.sql:330` | Arreglar H-REV-1 |

## Hallazgos reales que la simulacion expuso (no se arreglan en este cambio)

### H-NA-1 (alta) - El cron de night audit (sesion de sistema) nunca puede abrir su corrida: INSERT ... RETURNING sobre hoteles.night_audit_run viola RLS

POST /internal/hoteles/night-audit responde 200 con ok=false y error "new row violates row-level security policy for table "night_audit_run"" para la noche 2026-10-02. Reproducido en psql contra las migraciones reales: como rol authenticated con auth.uid() nulo, el INSERT de claimNightAuditRun pasa SIN RETURNING y falla CON RETURNING, porque la policy de SELECT de night_audit_run (008_night_audit.sql:58, hoteles.can_access_money) no tiene el escape de sistema que si tiene la de INSERT/UPDATE (008:70-72). Efecto: el cron no postea hospedaje ni procesa no-shows; solo funciona el disparo manual de gerencia.

Reproducido los dias 1, 2, 3, 4, 5, 6... (30 de 30). Camino alterno del simulador: POST /hoteles/:propertyId/night-audit como gerente (sesion de staff) para la misma noche.

### H-REV-1 (alta) - El cron de recomendaciones de revenue no ve el gate de ninguna property (siempre 'sin_gate_inicializado')

La property tiene su fila en hoteles.revenue_engine_gate (creada por POST /revenue/gate), pero /internal/hoteles/revenue-recommendations la reporta omitida con skippedReason sin_gate_inicializado todos los dias: la sesion de sistema (auth.uid() es null) no pasa la unica policy de SELECT del gate (core.has_property_access, migrations/011_revenue_engine_gate.sql:330), a diferencia de rate_recommendation que si admite auth.uid() is null (029:446). Resultado: el motor de recomendaciones nunca propone nada en produccion.

Reproducido los dias 1, 2, 3, 4, 5, 6... (30 de 30). Camino alterno del simulador: ninguno: el simulador no puede generar recomendaciones; la decision humana (aprobar/descartar) queda sin ejercitar.

### H-PAG-1 (media) - Cobro con tarjeta sin STRIPE_SECRET_KEY responde 500 en vez de un 503 'no disponible aun'

POST /hoteles/:propertyId/folios/:folioId/pagos con metodo tarjeta contra buildProductionDeps() sin credenciales respondio 500 ({"code":"internal_error","message":"Error interno"}); lo esperable por la regla de compatibilidad es 503 honesto, como hace CFDI con PortUnavailableError.

Reproducido los dias 3 (1 de 30). Camino alterno del simulador: el simulador usa InMemoryPaymentsPort en el borde de pagos; el sondeo no altera datos (la peticion falla antes de escribir).

## Limites de la medicion

- **Reloj**: el simulador mueve el reloj de la API y del worker; el `now()` de Postgres sigue siendo el real. Por eso el mes arranca hoy, los SLA de tickets (que nacen de `now()`) vencen todos en el siguiente barrido una vez que el reloj simulado pasa de la hora real, y el avance de una solicitud ARCO (la base exige fecha de negocio = fecha del servidor) solo se recorre completo el dia 1.
- **LLM guionado**: prueba herramientas, presupuesto, registro de uso y costo; no la calidad de un modelo real. Tokens estimados por longitud (caracteres / 4) de la peticion real y de la respuesta guionada.
- **Llegadas sin habitacion lista**: 32 de 296 llegadas no encontraron una habitacion `disponible` del tipo reservado (el detalle por tipo esta en el evento); el simulador no reasigna de tipo, la reserva queda confirmada. Es una limitacion del guion de recepcion, no un assert.
- **Voz y PMS**: no se simulan. **Sin timbre fiscal real**: el PAC es falso.
