# @atiende/domain-restaurantes

Empezó como el port de Fase 1 del vertical restaurantes (ver
`docs/REQUISITOS.md` para el detalle de diseño original), pero eso quedó
desactualizado hace varias fases: hoy también incluye KPIs (`kpis.ts` +
`006_kpi_aggregates.sql`), promociones (`promotions.ts`), notificaciones
reales de WhatsApp al cliente por cambio de estado de pedido
(`order-notifications.ts`), asignación de repartidor, correo transaccional
(`email-dispatch.ts`), conversaciones con handoff, voz, comandas al POS
(`src/softrestaurant/`), cierres del día, privacidad/ARCO y perfil del repartidor, con
49 archivos en `migrations/` (la numeración interna llega a la 063, con huecos en la
secuencia; `npm run verify:migration-versions` vigila que no se repita) — ver
`apps/api/src/routes/verticals/restaurantes/README.md` para el mapa completo
de fases (3/5/8/9/11/12) que fue agregando cada pieza.

Tipos, roles, lógica de negocio (búsqueda/cotización de productos con guardia
anti-alucinación de precio, memoria de cliente por teléfono, pedidos idempotentes,
plomería de WhatsApp) portados de `restaurantes/src` +
`restaurantes/supabase/functions`, adaptados al modelo de tenancy de
`@atiende/core-tenancy` (`core.organization`/`core.property`, no una tabla
`restaurants` aislada).

Adaptadores duales (mismo patrón que `@atiende/core-conversation`):
`InMemoryRestaurantesRepository` (tests, dev sin Postgres real) y
`PostgresRestaurantesRepository` (producción, sobre `TenantDbSession`).

Migraciones SQL reales en `migrations/` (schema `restaurantes.*`, requiere
`packages/db/migrations/0001_core_schema.sql` aplicada antes).

Explícitamente fuera de alcance de este paquete todavía: agente de voz
por teléfono (el núcleo de llamada y el simulador ya están en `src/voz/`; falta el worker de telefonía, ver `docs/VOZ-PM.md`), panel de superadmin propio (el back office cruzado de
plataforma vive en `apps/api/src/routes/superadmin*.ts`/
`apps/web/src/superadmin/`, no aquí). El agente de WhatsApp con LLM real y los
dashboards de KPIs, que esta nota marcaba como "fuera de Fase 1", ya se
construyeron en fases posteriores (ver arriba) — dejaron de estar fuera de
alcance.

## Modelo por sucursal (primer cliente: Los Taquitos de PM) — migración 023

Reglas configurables por sucursal, todas OPT-IN (una sucursal sin configurar, o una base sin
la migración 023, se comporta como antes):

- `horarios.ts` — horario por turnos (doble turno, cierre pasada la medianoche) y
  `estaAbiertoAhora` en la zona horaria del negocio (`resolverZonaHorariaNegocio`).
- `reglas-pedido.ts` — aplicadas por `quoteOrder`/`createOrder`: horario, pedido mínimo por
  canal (`domicilio`/`recoger`, sobre el total antes de descuentos), cobertura de entrega
  ("fuera de zona", por colonia contra `known_zone` + `branch_delivery_zone`) y propina
  (PM: solo con tarjeta; se anota en el pedido, no suma al total). Los productos/categorías
  marcados `no_domicilio` se rechazan a domicilio (`order-quote.ts`).
- WhatsApp por sucursal — `whatsapp_branch_channel`; `resolveWhatsAppChannel` resuelve
  organización y sucursal desde el `phone_number_id` que recibió el mensaje.
- Toda lectura/escritura de objetos nuevos pasa por `runWithSavepointFallback`: contra una base
  sin migrar la lectura da "sin configurar" y la escritura lanza
  `RestaurantesConfigUnavailableError` (503), nunca deja la transacción abortada. Cubierto en
  `tests/modelo-pm-savepoint.spec.ts` y en `scripts/verify-restaurantes-modelo-pm/`.

## Privacidad, ARCO, aviso de privacidad y aviso de IA/grabación (PM PR-9) — migración 030

Documentación operativa, NO asesoría legal: cada responsable debe validar su aviso de privacidad y su
procedimiento con su asesor jurídico. Todo vive en `src/privacidad/` y en un `PrivacidadRepository` propio
(no infla `RestaurantesRepository`); contra una base sin la 030 cada operación degrada con SAVEPOINT
(`runWithSavepointFallback`) a "no disponible" y el flujo anterior sigue igual.

- **Aviso simplificado + "asistente virtual"**: `handleInboundWhatsAppMessage` (argumento opcional `privacy`)
  antepone el aviso (`privacyNoticeWhatsApp`) una vez por teléfono-hash y versión del aviso
  (`restaurantes.privacy_notice_deliveries`, evidencia de entrega). Sin la 030 se usa "primer mensaje de la
  conversación".
- **ARCO**: fast-path determinista antes del LLM (`runArcoFastPath`, mismo patrón que citas): el teléfono es el
  que escribe, confirmación explícita ("CONFIRMO") y plazos de 20 + 15 días desde la confirmación;
  `restaurantes.data_rights_requests/events` (bitácora append-only). Por voz el identificador de llamada puede
  falsearse: la solicitud queda con `identity_basis = 'llamada_identificador'` y el panel avisa que se verifique
  al titular por otra vía.
- **Grabación de la llamada**: `voiceOpeningScript` (asistente virtual + aviso + pregunta de grabación) y
  `interpretRecordingConsent` (conservadora: ante la duda no se graba). `voz_registrar_turno` no persiste
  transcripción sin consentimiento (si la organización lo exige) ni con retención de voz 0; negar borra lo ya
  guardado de esa llamada.
- **Retención**: `privacy_config` (conversaciones 30–1095 días, voz 0–365 días; por defecto 180 y 30). La purga
  (`system_purge_expired_privacy_data`, cron interno) vacía `messages` de conversaciones vencidas y borra
  transcripciones de voz vencidas, y no toca a un titular con solicitud ARCO abierta.
- **Minimización del prompt**: el prompt del agente de WhatsApp y el resultado de `buscar_cliente` que ve el
  modelo ya no llevan el texto de la dirección del cliente (solo cuántas direcciones hay y su etiqueta).
- Verificación contra Postgres real: `scripts/verify-restaurantes-privacidad-arco/`.

## Agente de WhatsApp de Los Taquitos de PM

- Perfil por organizacion/sucursal: tabla `restaurantes.whatsapp_agent_config` (migracion 029) y `GET/PUT /v1/restaurantes/:propertyId/admin/config/agente-whatsapp` (owner/admin). Sin fila o con la base sin migrar el agente es el generico de siempre (SAVEPOINT + 42P01/42703/42883/42501).
- Prompt del perfil: `src/whatsapp/perfil-pm.ts` (usted, orden del cuestionario, reglas duras H1-H18), con los nombres del registro unico de tools. Es la UNICA fuente de WhatsApp y de voz: el comportamiento de voz sembrado sale de `src/voz/perfil-voz-pm.ts` (`buildPmSystemPrompt` con `canal: "voz"`, version compacta por el tope de 8000 caracteres de la migracion 025), ya no de un archivo aparte.
- Comanda de SoftRestaurant tambien desde WhatsApp: opcion `encolarComanda` del handler (mismo helper que voz/web).
- Evaluaciones: `src/evals/agente-pm/README.md`.

## Conversaciones, handoff a humano y turnos (R-21, migración 028)

`src/conversaciones/`: bandeja por sucursal (WhatsApp y llamadas), toma de la conversación por una persona (mientras
la tiene, el agente de WhatsApp no responde; `whatsapp/inbound.ts` consulta el `HandoffAgentGate` después de guardar el
mensaje del cliente), devolución al agente, cierre, notas internas, respuesta humana por WhatsApp (vía el outbox
existente), turnos de personal por sucursal (`cobertura.ts`: quién está de guardia en la zona horaria del negocio y
escalación por minutos de espera) y registro de intentos de callback.

- Base sin migrar: lecturas -> `disponible: false` con vacío honesto; escrituras -> `ConversacionesNoDisponibleError`
  (503); el gate del agente -> sin toma (el agente responde como antes). Todo con SAVEPOINT (`runWithSavepointFallback`);
  cubierto en `tests/conversaciones-repository-savepoint.spec.ts`.
- SQL y permisos: `migrations/028_conversaciones_handoff_turnos.sql`, verificado contra Postgres real en
  `scripts/verify-restaurantes-conversaciones-handoff/`.
- Alcance conocido: la escalación se calcula al leer (no hay cron ni aviso saliente al personal); el agente de voz aún no
  abre tomas por sí mismo (no existe el worker de voz): las llamadas aparecen en la bandeja y el staff puede tomarlas.

`src/voz/kpi*.ts`: KPI de voz, costo por día y alertas operativas (R-13, migración 035). SQL agrega por día LOCAL de la
sucursal (`voz_kpis_diarios`; una llamada cuenta en el día en que empezó); la capa pura (`kpi.ts`) suma días, saca
porcentajes (sin denominador = `null`, nunca 0%) y evalúa umbrales con la misma regla que `voz_evaluar_alertas`. Costo
en enteros: micro-USD y centavos MXN con el último `core.fx_rate` (sin tipo de cambio = `null`). Costo por sucursal =
voz en vivo (`voice_conversation`) + telefonía (`core.usage_cost_event`, categoría `telefonia`); el LLM de texto es de la
organización y se muestra aparte. Solo alertas internas (panel + `restaurantes.audit_log`); no envía WhatsApp ni correo.

- Eventos: nada guardaba errores de proveedor ni latencia de herramientas; `voice_event` los recibe por
  `POST /internal/restaurantes/voz/eventos` (solo sistema). Hasta que el servicio de voz los reporte, el p95 y los errores
  salen en cero / "—".
- Base sin migrar: lecturas -> `disponible: false`; escrituras -> `VozNoDisponibleError` (503), con SAVEPOINT; cubierto en
  `tests/voz-kpi-repository-savepoint.spec.ts` y `apps/api/tests/restaurantes-voz-kpi-savepoint.spec.ts`.
- SQL y permisos: `migrations/035_voz_kpi_alertas_costo.sql`, verificado contra Postgres real en
  `scripts/verify-restaurantes-voz-kpi/`.

## Cierre del día y resumen semanal (R-42)

`src/cierres/`: tipos y fechas de negocio puras (`cierre.ts`), `PostgresCierreRepository` (migración 041; SAVEPOINT + degradación a "no disponible"),
`InMemoryCierreRepository` (pruebas) y `barrerCierresSucursal` (barrido idempotente por sucursal que avisa solo al CREAR un cierre). Las definiciones de cada
cifra (venta, ticket, cancelación, tiempo de entrega, comparativo, fecha de negocio) viven en el encabezado de `migrations/041_cierre_dia_resumen_semanal.sql`;
el cálculo es SQL y lo prueba `scripts/verify-restaurantes-cierre-dia/` contra Postgres real.

## Autopiloto del ciclo del pedido (migración 050)

`src/autopiloto/`: el sistema prepara y pide **una aprobación con un clic**; lo que mueve dinero, cancela algo ya en cocina o es un pedido grande **nunca se
automatiza sin humano** (y nada se autoaprueba: sin respuesta solo se escala el aviso al owner). Piezas:

- Estado `por_aprobar` (pedido grande retenido sin comanda ni cocina) y `solicitud_aprobacion` (pedido grande, cancelación pedida por el cliente, compensación
  de una queja). Resolver es idempotente y atómico (bloqueo de fila): dos clics = un efecto. Aprobar encola la comanda al POS (post-commit, sesión de sistema) y
  manda el WhatsApp «confirmado»; rechazar pide un motivo de lista cerrada, avisa con texto honesto y deja un callback.
- Cancelación pedida por el cliente (`solicitarCancelacion`): automática solo si la sucursal lo activó (por omisión **no**), el pedido sigue en `pending`/`programado` y no
  tiene comanda; en cualquier otro caso crea una solicitud. El pedido sale del teléfono del contexto, nunca de un id del modelo.
- Queja con compensación (`registrarQuejaConPedido`): «Sin compensación», «Reponer producto» (pedido de $0 a cocina) o «Descuento en el próximo pedido» (código de un solo uso,
  con tope por sucursal). El dinero solo se registra, nunca se ejecuta.
- Tick (dentro de `/internal/restaurantes/promover-programados`, sin cron nuevo): escalado, `entregado -> completado`, `listo_para_recoger -> no_recogido`, aceptación automática,
  avance desde el POS (solo con adaptador real), regreso de handoffs sin respuesta humana y reposición de «agotado hasta mañana» al cambiar el día de la sucursal.
- Historial append-only de transiciones (`order_status_events`, trigger en `orders`), taxonomía cerrada de quejas y cancelaciones, tiempo prometido aprendido (mediana de la
  franja, nunca menos que el piso del dueño) y confirmación «Recibimos su pedido» para voz y web (solo con plantilla aprobada).
- Base sin migrar: todo degrada a «no disponible» con SAVEPOINT (`tests/autopiloto-savepoint.spec.ts`). SQL y permisos: `scripts/verify-restaurantes-autopiloto/` (Postgres real, incluye
  la prueba de concurrencia con dos conexiones en `run.sh`).
- Agente de WhatsApp (`src/whatsapp/autopiloto-turno.ts`, opción `autopiloto` del turno): **detrás de la bandera por organización `autopiloto_org_config.cancelacion_agente` (apagada por
  omisión)**, una cancelación detectada por el clasificador (que NO cambia) con pedido activo crea la solicitud de aprobación, o cancela sola si la sucursal lo permitió y no hay comanda; con la
  bandera apagada, sin pedido activo, con la base sin migrar o ante un error, el turno sigue por el camino de siempre. Una queja se liga al último pedido (solicitud de compensación), su
  subtipo (`MOTIVOS_QUEJA`) viaja en el aviso al equipo y la respuesta al cliente no cambia.
- **Pendiente de B2 (#421)**: `crear_pedido` que llame a `retenerPedidoGrande` al detectar el pedido grande; y el cableado de la voz (cancelación y queja).

## Cliente 360: memoria del cliente (migración 049)

- Código en `src/cliente-360/`: `types.ts`, `gustos.ts` (observaciones de un pedido confirmado y gustos propuestos), `repetir.ts`
  ("lo mismo de la vez pasada" con precios de hoy), `memoria.ts` (carga, cierre del ciclo y regla de reincidencia), `postgres.ts` (llama a las
  funciones `security definer` dentro de SAVEPOINT) e `in-memory.ts`.
- **Por qué una función de sistema para leer:** la sesión de los canales (WhatsApp, voz, web) entra con `auth.uid()` NULL y las policies de
  `customers`/`orders` exigen membresía, así que no veía ninguna fila. `restaurantes.cliente_memoria(org, telefono)` (solo sistema) devuelve
  cliente, domicilios (el último usado primero), hasta 30 pedidos sin cancelados, gustos y conteos de reincidencia.
- **Cierre del ciclo:** `createOrder` llama a `restaurantes.cliente_registrar_pedido` (solo sistema, idempotente por pedido) con el domicilio y
  las observaciones del pedido (tortilla, salsas, omisiones, nota corta, pago, propina, canal, sucursal). Un gusto se propone desde la 2.ª
  vez; si el más reciente ya se vio 2 veces gana al más visto (gusto cambiado); los descartados nunca se proponen.
- **Herramientas del agente** (WhatsApp y voz, `agent-tools/registry.ts`): `historial_pedidos` y `repetir_pedido` (solo pedidos del mismo
  número; re-cotiza con precios de hoy, entra a la máquina de estados de `cotizar_pedido` y avisa de productos que ya no están o cambiaron de
  precio). `buscar_cliente` devuelve además `domicilios`, `gustos` y `pedidosAnteriores`.
- **Reincidencia:** con `umbral` (por omisión 2, 0 = apagada) "no recogido" + pedidos falsos dentro de la ventana (90 días) el pedido de WhatsApp o voz
  no se crea solo: queda un aviso (`callback_requests`, motivo `aprobacion_pedido_cliente`, con todo el pedido) y el agente solo dice que la
  sucursal lo confirma.
- **Base sin migrar:** `getCustomerMemory`/`registerOrderClosure` devuelven `undefined` (42883/42P01/42703 dentro de SAVEPOINT) y el agente usa
  el camino anterior; las operaciones del staff lanzan `ClienteMemoriaNoDisponibleError` (503 "no disponible aún"). Pruebas:
  `tests/cliente-360-*.spec.ts`; SQL y permisos contra Postgres real en `scripts/verify-restaurantes-cliente-360/`.
