# Runbook del agente de restaurantes (WhatsApp y voz) — R-PM-18

Adaptado de `docs/runbooks/operacion.md:56-104` del repo original `atiende-restaurantes`. Complementa `docs/runbooks/INCIDENTES.md` (severidades,
quién decide, comunicación y postmortem), `docs/CRONS.md` y `docs/LLM-GATEWAY.md`. Todas las consultas son de **solo lectura**: se corren
con el SQL editor de Supabase o `psql` por Javier, nunca con un agente de código contra la base real. No pegues teléfonos, textos de
clientes, tokens ni respuestas completas del proveedor en tickets o chats (el repo es público).

> Regla de oro: primero detener el daño (interruptor del agente, pausa del cron), luego investigar. Nunca `UPDATE`/`DELETE` improvisados:
> los estados se corrigen con el procedimiento aprobado y dejando evidencia.

## Señales que ya emite el sistema

| Señal | Dónde | Qué dice |
|---|---|---|
| `whatsapp_turno` (una línea JSON por turno) | stdout de la función en Vercel (R-PM-15) | `correlationId`, `organizationId`, `propertyId`, `rolModelo`, `vueltas`, `latenciaTotalMs`, `tools[{tool,latenciaMs,resultado}]`, `resultado`, `motivoEscalacion`, `motivoEscaladaDeRol`, `telefonoHash` |
| `whatsapp_tool` (una línea JSON por herramienta) | idem | mismo `correlationId`, `tool`, `vuelta`, `latenciaMs`, `resultado` (`ok`, `error_regla`, `error_sistema`) |
| Latido y cadencia de los crons | `/superadmin/salud/crons` | si `/internal/whatsapp/dispatch` (cada 5 min) dejó de correr |
| Gasto de API | superadmin → Gasto de API | tope mensual por organización (fail-closed) y topes por rol |

Privacidad de los eventos: nunca llevan el texto del cliente, la respuesta ni los argumentos de las herramientas; el teléfono sale solo como
`tel_<16 hex>` (HMAC con una llave derivada de `WHATSAPP_APP_SECRET`) o se omite si el secreto no está configurado. Un `resultado` de turno puede ser
`ok`, `escalado_alto_riesgo`, `error_proveedor`, `presupuesto_agotado`, `loop_agotado` o `error_sistema`.

## Incidente: pedidos duplicados

1. Confirma con el cliente o la sucursal qué pedidos parecen el mismo (sin copiar sus datos a tickets).
2. En `restaurantes.orders` de esa organización, agrupa por `dedupe_fingerprint` (misma intención) y revisa `idempotency_key` (la llave de reintento
   del canal; una misma llave con contenido distinto se rechaza con `PT409`, por diseño). Mira `created_at`, `status` y `source`.
3. Compara con `restaurantes.customers.order_count`: un solo pedido por intención debe sumar una sola vez.
4. En `whatsapp_inbound_events`, el mismo `message_id` de Meta nunca debe tener dos turnos; `attempts > 1` indica reintentos legítimos de Meta.
5. Contén: si el agente duplica por un bucle, apaga el interruptor del agente (superadmin → Interruptores → `restaurantes:whatsapp_agent`).
6. No borres filas: marca y reconcilia (cancelar el pedido sobrante con el flujo normal del panel) y deja nota de incidencia.
7. Prueba de regresión que protege esto: `packages/domain-restaurantes/tests/regresiones-original/` (X08, X09, X19, X31) y, contra Postgres real
   con conexiones simultáneas, `scripts/verify-restaurantes-whatsapp-concurrencia/run.sh`.

## Incidente: WhatsApp atrasado o sin responder

1. `restaurantes.whatsapp_inbound_events`: revisa `status` y antigüedad. `processing` con `claimed_at` de más de 5 minutos es reclamable de nuevo;
   `failed` es reclamable hasta 5 intentos y luego queda en `attempts_exhausted` (no se reintenta más). Un `processed` **no se reabre**.
2. `restaurantes.whatsapp_conversation_leases`: un lease vencido (`locked_until` en el pasado) no bloquea; uno vigente de más de 120 s por conversación
   indica un turno colgado. Un mensaje que choca con el lease responde 5xx reintentable y Meta lo reenvía.
3. `restaurantes.messaging_outbox`: `pending`/`failed` viejos, `processing` con lease vencido y `dead` (agotó intentos o payload inválido).
   Revisa `last_error_class`; no registres cuerpos ni teléfonos.
4. Comprueba el cron `/internal/whatsapp/dispatch` en `/superadmin/salud/crons` y que `WHATSAPP_ACCESS_TOKEN` y `WHATSAPP_APP_SECRET` existan (503 explícito
   sin el token). Un token vencido produce `dead` con error de autenticación de Graph API: rota el token (sección siguiente).
5. Meta entrega por lote: si un elemento falla, la función responde 5xx y Meta reenvía el lote; el replay omite los ids ya procesados y reclama solo los fallidos.
6. **Límite conocido:** Meta no ofrece aquí una llave idempotente de envío. Una caída entre el 2xx de Meta y el ack local puede duplicar UNA respuesta al cliente;
   reconcilia por `source_message_id` y conserva la evidencia. Tampoco hay hoy un despachador "uno por uno" con cerca (QA automatizacion-01): un error a medias
   del lote puede reenviar mensajes ya enviados; mientras entra ese arreglo, vigila `dead` y duplicados tras un error del cron.

## Incidente: proveedor de IA lento o caído

- Umbral de alerta: **más de 1 % de turnos con `resultado = error_proveedor` en 10 minutos, o 5 turnos seguidos con ese resultado** (eventos `whatsapp_turno`).
  Hoy no hay alerta automática configurada: se revisa en los logs de Vercel y, al confirmarlo, se declara SEV2 (`INCIDENTES.md`).
- El gateway cae por la escalera de proveedores del rol (`docs/LLM-GATEWAY.md`); si toda la escalera falla, el cliente recibe el mensaje honesto de problema técnico (nunca silencio ni un
  "registrado" falso) y, si el pedido ya se creó en ese turno, la confirmación de éxito.
- Un turno completo tiene un presupuesto de 45 s (`presupuesto_agotado`); en Vercel la función dura menos (QA agentes-19, caos-15): un `presupuesto_agotado` frecuente apunta a proveedor lento, no a un bug del turno.
- No hagas rollback por un proveedor lento: revisa su página de estado y espera o cambia el orden de la escalera con el procedimiento aprobado.

## Incidente: agente callado (no responde a un cliente concreto o a todos)

Revisa en este orden, de lo más amplio a lo más específico:

1. **Interruptor global o del rol:** superadmin → Interruptores (`llm`, `restaurantes:whatsapp_agent` y `restaurantes:whatsapp_agent_escalated`). Pausado devuelve `skipped: kill_switch`.
2. **Tope de gasto:** superadmin → Gasto de API: el tope mensual por organización es fail-closed; agotado, el gateway rechaza el turno y el cliente recibe el mensaje de problema técnico.
3. **Handoff abierto:** en `restaurantes.conversation_handoff` un registro en `pendiente` o `tomada` para esa conversación hace que el agente **calle** a propósito hasta que una persona la devuelva (`devuelta`) o la cierre (`cerrada`).
4. **Número sin canal:** el `phone_number_id` debe existir en `restaurantes.whatsapp_channel_config` (o en `restaurantes.whatsapp_branch_channel` si es un número por sucursal); un número desconocido se acusa sin responder.
5. **Motivo de alto riesgo:** quejas, cancelaciones, cobro, ARCO, alergias y transferencia se responden con texto fijo y se escalan sin llamar al modelo (`escalado_alto_riesgo`): no es un fallo.

## Después de cambiar la configuración del agente, releer la versión guardada (bug `609c3d6`)

En el original un `curl` revirtió un cambio del prompt en silencio y la API respondió `ok: true`. Procedimiento tras CUALQUIER cambio de la config (panel de agente de WhatsApp o API):

1. Vuelve a abrir la pantalla (o `GET` de la configuración) y confirma que la **versión subió** y que el texto leído es **exactamente el enviado**.
2. Revisa el historial (`restaurantes.whatsapp_agent_config_history`, una entrada append-only por guardado, con actor y foto anterior/nueva).
3. Un guardado con una versión vieja se rechaza como conflicto: recarga y vuelve a aplicar tu cambio; no fuerces.
4. Las reglas duras del perfil PM viven en código, no en la config: ningún guardado puede borrarlas.

Protegido por: `packages/domain-restaurantes/tests/regresiones-original/historial-turno-y-pedidos.spec.ts` (X53).

## Token de Meta: expiración y rotación

- Fechas: anota la expiración del `WHATSAPP_ACCESS_TOKEN` al generarlo y avisa a **14, 7 y 1 día** antes. Hoy **no existe una alerta automática** de expiración en el repo;
  mientras no se configure (canal de alertas y responsable fuera del repositorio), es un recordatorio manual de Javier (SEV3 si vence sin rotar: los envíos pasan a `dead`).
- Rotación: genera el token nuevo en Meta for Developers, actualízalo en los secretos de Vercel (`docs/runbooks/ROTACION-DE-LLAVES.md`), vuelve a desplegar y verifica con un envío sin efecto
  (el siguiente ciclo de `/internal/whatsapp/dispatch` debe terminar sin `dead` nuevos). Al rotar `WHATSAPP_APP_SECRET` cambia también la llave del hash de teléfono de los logs (las correlaciones
  de `telefonoHash` anteriores dejan de coincidir; es esperado).
