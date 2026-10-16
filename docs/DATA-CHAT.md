# Chatea con tus datos — motor compartido

Pedido de producto: preguntarle a los datos del negocio en español ("¿cuánto vendí esta semana?") y
recibir tablas/gráficas simples, siempre citando de qué datos salen y el periodo. Este documento explica el
motor compartido, su modelo de seguridad y cómo enchufar el catálogo de otra vertical. Piloto: restaurantes;
después se enchufaron hoteles, rentas vacacionales, despachos, licitaciones y citas (ver "Catálogos por vertical").

## Piezas

| Pieza | Dónde |
|---|---|
| Motor (validación, alcance, límites, redacción de PII, bitácora, verificación de cifras) | `packages/agent-core/src/data-chat/` (export `@atiende/agent-core/data-chat`) |
| Catálogo de restaurantes (8 herramientas, SQL de solo lectura; más las 9 `cfo_*` de «Pregunta a tu CFO», que delegan en el `ServicioCfo` vía `reader.cfo` y no tienen SQL propia) | `packages/domain-restaurantes/src/data-chat/` (`cfo-tools.ts` para las del CFO) |
| Catálogo de hoteles (6 herramientas) | `packages/domain-hoteles/src/data-chat/` |
| Catálogo de rentas vacacionales (7 herramientas) | `packages/domain-rentas/src/data-chat/` |
| Catálogo de despachos (8 herramientas) | `packages/domain-despachos/src/data-chat/` |
| Catálogo de licitaciones (7 herramientas) | `packages/domain-licitaciones/src/data-chat/` |
| Catálogo de citas (8 herramientas) | `packages/domain-citas/src/data-chat/` |
| Rutas HTTP | restaurantes: `apps/api/src/routes/verticals/restaurantes/admin-data-chat.ts`; despachos y licitaciones: `.../despachos/chat-datos.ts` y `.../licitaciones/chat-datos.ts`; hoteles, rentas y citas (por propiedad): `.../hoteles/admin-data-chat.ts`, `.../rentas/admin-data-chat.ts` y `.../citas/admin-data-chat.ts` sobre `apps/api/src/data-chat/vertical-routes.ts` (cuerpo y alcance compartidos en `apps/api/src/data-chat/`) |
| Bitácora de consultas | migración 0029 → `core.data_chat_query_log` + `core.record_data_chat_query` |
| Diálogo (UI) | `@atiende/ui` → `ChatDatosDialog`; conexión en `apps/web/src/components/BotonChatDatos.tsx` (hoteles y rentas: `apps/web/src/lib/data-chat-client.ts` + `verticals/<vertical>/lib/data-chat-client.ts`; despachos, licitaciones y citas: `verticals/<vertical>/lib/chat-datos-client.ts`) |
| Verificación contra Postgres real | `scripts/verify-data-chat/` (restaurantes + bitácora), `scripts/verify-data-chat-hoteles/`, `scripts/verify-data-chat-rentas/`, `scripts/verify-data-chat-despachos-licitaciones/`, `scripts/verify-data-chat-citas/` (los corre el gate de CI) |

## Catálogos por vertical

Todos: solo lectura, SQL parametrizado sobre la sesión RLS del usuario, tope de 50 filas / 8 s, montos MXN,
periodo en la zona de la propiedad (restaurantes: `America/Merida` por defecto; hoteles: `hoteles.property_config.timezone`
y, si no está configurada, la zona de plataforma `America/Mexico_City` vía `resolverZonaHorariaNegocio`; rentas:
`rentas.property_config.zona_horaria`), propiedad pedida por
*nombre* y resuelta solo entre las que el usuario ve, y "no hay datos" / "todavía no disponible" cuando toca.

**Hoteles** (`owner`/`gm`; `hoteles:data_chat`): `ocupacion_adr_revpar`, `ingresos_por_periodo`,
`llegadas_y_salidas` (acepta periodos futuros), `cancelaciones`, `tickets_abiertos_sla`, `housekeeping_pendiente`.
Ocupación/ADR/RevPAR salen de las mismas fuentes que el P&L USALI (cargos de hospedaje vigentes = noche ocupada;
`hoteles.availability.total_rooms` = noches disponibles), agregadas en CTE separados y unidas después.
Solo owner/gm: leen dinero (RLS `can_access_money`) y tickets de todos los departamentos; un rol operativo vería
una vista parcial que parecería completa.

**Rentas** (`admin_gestora`/`contador`; `rentas:data_chat`): `ocupacion_por_unidad` (pasado y futuro ya
reservado; la noche se evalúa una vez por unidad y día con `EXISTS`), `ingresos_por_canal`,
`ingresos_por_propietario` (reservas confirmadas atribuidas por su llegada; solo MXN se suma),
`conflictos_calendario_abiertos`, `tareas_pendientes` (sin periodo = todo lo programado hasta hoy, con rezago),
`liquidaciones_propietarios` (solo la última versión de cada liquidación), `pagos_de_canal` (cabecera y líneas
en CTE separados). Solo admin_gestora/contador: lo financiero lo protege la RLS `can_read_finanzas`.

## Flujo de un turno

1. La ruta autentica (JWT → sesión RLS del usuario → membership → `MANAGER_ROLES`) y arma el **alcance**
   (`DataChatScope`: organización, sucursales permitidas, rol, zona horaria). El cuerpo solo trae `question`
   e `history` (texto); cualquier otro campo se rechaza con 400.
2. El motor aplica rate limit (usuario y organización, cerrado ante fallo de Redis) y pasa al modelo la
   pregunta + el **catálogo cerrado** como herramientas (JSON Schema derivado del mismo mini-esquema que
   valida en el servidor).
3. El modelo solo puede nombrar una herramienta y sus parámetros tipados. Cada llamada se valida
   (`parseArgs`: claves desconocidas, tipos, enums y largos se rechazan), se ejecuta con el alcance del
   servidor, con tope de filas y de tiempo, y su resultado vuelve al modelo como **datos no confiables**
   (sanitizados y con PII redactada).
4. La respuesta que ve el usuario sale de los **resultados**: tablas, gráficas, fuente, periodo y alcance son
   deterministas. El texto del modelo solo se muestra si todos sus números existen en los resultados, no tiene
   enlaces y es corto; si no, se muestra el resumen determinista de la herramienta.

## Garantías de seguridad (y dónde se prueban)

- **El LLM nunca escribe SQL ni elige tenant/sucursal/rol.** Solo hay herramientas parametrizadas; ningún
  parámetro acepta ids de organización/sucursal (la sucursal se pide por *nombre* y se resuelve solo entre las
  que el usuario ve). `catalog.spec.ts` lo fija ("ninguna herramienta acepta organización, sucursal por id...").
- **Solo lectura, sesión RLS del usuario.** Nunca sesión de sistema ni `service_role`. Doble candado por
  sucursal: filtro `$2` fijado por el servidor + RLS de `core.property` (`has_property_access`) vía el JOIN de cada
  consulta. `scripts/verify-data-chat` prueba cross-tenant (ambos sentidos), gerente de una sucursal (aunque la
  app pasara `null` o un id ajeno) y `anon`.
- **Límites** (`DEFAULT_DATA_CHAT_LIMITS`, CHAT-05): la tabla y el PDF reciben hasta 50 filas y al modelo le llegan 20 (con aviso
  de recorte para que no calcule totales); 8 s por herramienta (timeout del motor + `statement_timeout` de Postgres), 20 s por
  llamada al modelo y 45 s por turno (pasado el tiempo, o si el modelo se cuelga al redactar, se responde con las cifras
  deterministas sin perder los resultados); 2 llamadas al modelo por turno (elegir herramienta y redactar), 3 consultas por pregunta,
  pregunta ≤ 600 caracteres, historial ≤ 4 turnos (las respuestas viejas del asistente van resumidas a su primera frase), salida
  del modelo ≤ 150 tokens al elegir herramienta y ≤ 350 al redactar (el piso `minMaxTokens` del escalón puede subirlo en modelos que razonan).
- **Cascada y medición.** La narrativa del modelo solo se muestra si pasa la guardia de cifras. Si no pasa, hay EXACTAMENTE UNA
  llamada al modelo escalado (rol `<vertical>:data_chat_retry`, `completeRetry`) y, si tampoco pasa o falla, el resumen determinista;
  nunca una segunda escalada. `onUso` entrega por turno la ruta (`directa`, `barato`, `escalado`, `determinista`), las llamadas al
  modelo y el costo reportado por el proveedor; las rutas de las 6 verticales lo registran como una línea `data_chat_uso` en los logs
  (sin pregunta, filas ni PII). Persistirlo por organización y rol requiere migración (columnas de `core.data_chat_query_log`,
  spec g.5): fuera de este lote.
- **PII.** Las consultas devuelven agregados (clientes recurrentes = solo conteos); además toda celda de texto
  que llega al modelo se sanitiza y se redactan teléfonos, correos, tarjetas y enlaces.
- **Bitácora.** Quién, organización, herramienta, parámetros tipados, resultado como conteo y duración. Nunca
  resultados ni el texto de la pregunta. Lectura solo owner/admin; append-only.
- **Costo.** El proveedor se abstrae con `DataChatCompletion`; en producción es el `LlmGateway` compartido
  (carril interactivo, rol `restaurantes:data_chat`), que ya aplica el tope mensual por organización
  (`core.llm_org_budget`), el tope global de plataforma, el tope diario/por corrida, circuit breaker, registro
  de uso e interruptor de plataforma. Tests y demos usan `scriptedCompletion` (cero red, cero gasto).
- **Nunca inventa cifras.** Verificación de números (`numbers-guard.ts`) + una respuesta sin herramienta solo se
  acepta si es una aclaración corta terminada en "?"; cualquier otra cosa se reemplaza por "fuera de catálogo".
- **Inyección de prompt desde datos.** Nombres/notas son datos: sanitizados, truncados y marcados como no
  confiables; la contención real es estructural (catálogo cerrado, solo lectura, alcance fijado por el servidor,
  cifras verificadas, UI que nunca interpreta HTML).
- **Periodos.** Siempre en la zona del negocio (`America/Merida` por defecto o la de la sucursal), semana de
  lunes a domingo, ventanas `[inicio, fin)`. Un periodo ambiguo pide aclaración, no se adivina.
- **Base sin migrar.** Cada consulta corre en `SAVEPOINT` (`runWithSavepointFallback`): 42P01/42703/42883 →
  "esa información todavía no está disponible", sin abortar la transacción de la request. La bitácora degrada a
  log estructurado. Cubierto con `AbortAwareFakeSession` y con SQLSTATE reales en `verify-data-chat`.

## Transporte NDJSON, cancelación y `/estado`

Las seis rutas (`restaurantes`, `hoteles`, `rentas`, `citas`, `despachos`, `licitaciones`) comparten el parser de cuerpo
(`apps/api/src/data-chat/body.ts::parseDataChatRequest`) y el transporte (`apps/api/src/data-chat/ndjson.ts`).

- **Sin** `Accept: application/x-ndjson`: JSON síncrono idéntico al de siempre (`DataChatAnswer`).
- **Con** el header: flujo `application/x-ndjson`, una línea JSON por evento.
  - `{"t":"paso","fase":"inicio"|"fin","herramienta":"<nombre del catálogo>"}`: cero o más, en vivo (solo el nombre de
    la herramienta; nunca parámetros, filas ni texto del usuario).
  - `{"t":"fin","respuesta":<DataChatAnswer>}`: exactamente uno si el turno terminó. Incluye también el aviso de
    "asistente no activado".
  - `{"t":"error","status":"error","mensaje":"..."}`: si el turno falla ya empezado el flujo; el mensaje es fijo, jamás el
    texto de la excepción.
  - 401, 403 y 400 de validación ocurren antes de abrir el flujo y siguen siendo JSON HTTP con su status.
- **Sesión**: `dbSession` confirma y cierra la sesión RLS del request cuando el handler devuelve su `Response`; por eso el
  turno en modo flujo abre su PROPIA sesión RLS del mismo usuario (`engine.withAppSession`). El alcance (organización,
  membership, zona horaria, rol) lo verifica el handler con la sesión del request antes de abrir el flujo.
- **Cancelación**: cerrar la lectura (Detener) o la conexión aborta el turno (`signal` del motor): no hay más pasos ni
  llamadas al modelo y la sesión se cierra. El motor lanza `DataChatAbortedError` y no escribe bitácora de un turno
  cancelado.
- **`GET .../estado`**: `{ available, permitido, motivo, usoHoyPct }`. `motivo` es `null` o `"no_activado"` /
  `"tope_diario"`. `usoHoyPct` es `null` mientras no haya un lector de uso (`DataChatDeps.usageTodayPct`, hoy sin
  implementación de producción: requiere una función SQL que exponga el uso diario del usuario); la medición corre en
  SAVEPOINT y degrada a `null` en la base sin migrar. El rol sin acceso sigue siendo 403.

## Conversaciones guardadas (CHAT-04)

Migración `0041_copiloto_conversaciones.sql` (tablas `core.data_chat_conversation` / `core.data_chat_message`,
escritura solo por `core.append_data_chat_turn`) y `apps/api/src/data-chat/conversaciones.ts`. Las seis rutas de chat
montan, bajo su base, `GET .../conversaciones`, `GET|PATCH|DELETE .../conversaciones/:id`.

- **Opt-in**: `POST` acepta `conversationId` = `"new"` (conversación nueva) o el id de una propia. Sin el campo todo
  funciona como antes (nada se guarda, el historial lo aporta el cuerpo). Con él, `history` en el cuerpo es 400 y el
  historial del modelo sale de la base. La respuesta (JSON y evento NDJSON `fin`) trae `conversationId` y `seq`
  (el `fin` además `conversacionId`, como `CopilotoTransporte`). Si no se pudo guardar, el turno se responde igual con
  `guardado: false` y `motivoNoGuardado` (`no_disponible`, `limite_conversaciones`, `conversacion_no_encontrada`,
  `sin_acceso`, `error`). Las respuestas de transporte (tope, presupuesto, entrada inválida, no disponible) no se guardan.
- **Quién ve qué**: solo el autor, con membresía vigente en la organización (RLS + filtros por usuario, organización y
  vertical). El owner tampoco lee las conversaciones de su staff (la auditoría sigue en `data_chat_query_log`, sin
  texto). Un id ajeno, de otra organización o inexistente es 404, nunca 403.
- **Qué se guarda**: pregunta redactada (`redactPii`), texto de la respuesta, bloques (celdas de texto redactadas, 50
  filas, ~40 KB) y fuentes, y las herramientas ejecutadas con sus parámetros tipados. No se guardan prompts, salida
  cruda del modelo ni adjuntos. Una consulta directa (botón sin IA) guarda `Consulta directa: <herramienta>`.
- **Límites**: 200 conversaciones por usuario y organización (la 201 no se guarda y lo dice); 100 mensajes por
  conversación (el siguiente turno abre una de continuación).
- **Base sin migrar**: cada acceso va en SAVEPOINT; la lista responde `{ disponible: false, conversaciones: [] }`,
  abrir/renombrar/borrar 404 y continuar una conversación 404 antes de gastar un turno de modelo.
- **Pruebas**: `scripts/verify-copiloto-conversaciones/` (Postgres real, en el gate de CI),
  `apps/api/tests/copiloto-conversaciones-{rutas,repo}.spec.ts`.

## Catálogos de despachos y licitaciones

Ambos son de solo lectura, con parámetros tipados (periodo, cliente por **nombre**, horizonte en días, límite),
periodos y "hoy" en la zona del negocio (`America/Merida` por defecto), montos en MXN y tope de 50 filas / 8 s.
Rutas: `POST /despachos/:propertyId/chat-datos` y `POST /licitaciones/:propertyId/chat-datos` (más `GET .../estado`).
Roles del gateway LLM: `despachos:data_chat` y `licitaciones:data_chat` (tope mensual por organización e
interruptor de plataforma propios). La bitácora `core.data_chat_query_log` ya acepta ambas verticales: **sin
migración nueva**.

**Despachos** (alcance: los clientes de la membership; un cliente = una `core.property`; rol: `VER_DASHBOARD_ROLES`):
`cartera_por_cliente`, `cobranza_antiguedad` (vigente, 1-30, 31-60, 61-90, más de 90 días), `cfdi_por_periodo`,
`impuestos_del_mes` (IVA acreditable de CFDI tipo Ingreso válidos, misma convención que la DIOT del sistema),
`obligaciones_fiscales` (ISR, IVA, DIOT, Nómina por fecha límite; "vencido" se calcula contra hoy),
`cierres_pendientes`, `alertas_efos` (lista 69-B del SAT, solo por las funciones `security definer` de la
migración 014: si la lista no está cargada responde "no disponible", nunca "sin riesgo") y `carga_de_trabajo`.
Lo que el modelo **no** tiene y el chat declara en vez de inventar: CFDI **emitidos** por el cliente (IVA
trasladado, saldo a cargo, ISR) y el **contador responsable** de cada pendiente (la carga es por cliente, no por
contador).

**Licitaciones** (alcance: la organización completa; cualquier rol de la vertical, igual que la RLS de lectura):
`convocatorias_abiertas` (con `vencen_en_dias` para "por vencer"), `plazos_semaforo` (rojo ≤ 3 días, amarillo
≤ 7, verde > 7, vencida sin presentar, sin fecha), `go_no_go`, `propuestas_por_estado`, `fallos`,
`renovaciones` (horizonte inclusivo, por defecto 90 días) y `preguntas_junta_pendientes` (L-04, #240: borrador,
aprobada sin enviar o enviada sin respuesta; nunca respuestas ni actas). Los días restantes se cuentan en fecha
**local** (`licitaciones.tenant_config.timezone`, si no hay, `America/Merida`). El monto solo se muestra si la
convocatoria está en MXN (no se convierte moneda); en `fallos` es el presupuesto de la convocatoria, no el
importe adjudicado. Terminología: ComprasMX, LAASSP, fallo, junta de aclaraciones.

Ambos corren con la sesión RLS del usuario y repiten `organization_id = $1` en cada JOIN; el SQL idéntico vive
en `scripts/verify-data-chat-despachos-licitaciones/assertions.sql` (66 escenarios contra Postgres real:
cross-tenant en ambos sentidos, cross-cliente, `anon`, base sin migrar) y un guard de deriva en
`tests/data-chat/sql-drift.spec.ts` de cada paquete.

## Catálogo de citas (C-10)

Solo lectura, parámetros tipados (periodo, sucursal por **nombre**, agrupación), periodos y días en la zona de la
sucursal activa (`citas.property_config.timezone`; si no hay, `citas.tenant_config.default_timezone`), montos en MXN
(el precio del servicio vive en centavos) y tope de 50 filas / 8 s. Ruta: `POST /citas/:propertyId/chat-datos` (más
`GET .../estado`). Rol del gateway LLM: `citas:data_chat` (tope mensual por organización e interruptor de plataforma
propios). Quién lo usa: solo `owner` y `admin` (`DATA_CHAT_ROLES`): el catálogo lee ingresos, tasas de cancelación por
profesional y el estado de envío de recordatorios, y la RLS de las citas no distingue rol (un `staff` ve las citas de su
sucursal), así que el candado de rol es la ruta y la función de la migración 027 repite la misma regla.
Alcance: la membership (`resolveMembershipPropertyScope`); un admin acotado a una sucursal solo ve esa.

`citas_por_dia` (por día, o semana/mes si el periodo es largo; pasado o ya agendado), `ocupacion` (por profesional o por
sucursal: horas de atención configuradas, con las excepciones del día, frente a las horas con cita viva dentro de ese
horario), `no_shows_y_cancelaciones` (por profesional, con tasas), `ingresos_por_periodo` e `ingresos_por_servicio`,
`clientes_nuevos_vs_recurrentes` (solo conteos), `huecos_libres` (periodos futuros: horario de atención de ahora en
adelante menos citas) y `recordatorios` (citas por atender sin recordatorio enviado + estado de envío por canal).
Definiciones que el chat declara en su fuente: **ingreso** = precio de lista actual del servicio de las citas
**completadas** (la base no registra cobros, descuentos ni propinas); **cita viva** = pendiente, confirmada o completada
(una cancelada o no-show no bloquea horario); **cliente nuevo** = su primera cita viva dentro del alcance cae en el periodo.

Lo que **no** tiene y el chat declara en vez de inventar: dinero cobrado, descuentos, y la duración de cada servicio al
calcular huecos (un hueco corto puede no alcanzar para una cita). Las citas **sin sucursal asignada** (`property_id` nulo)
solo cuentan para quien consulta sin filtro de sucursal; un usuario acotado a sucursales o que nombra una sucursal no las ve.

**Migración 027** (`citas.data_chat_reminder_delivery`): el outbox de mensajes (`citas.messaging_outbox`) no es legible
para `authenticated` y no guarda la sucursal. La función `security definer` devuelve solo conteos por canal y estado de los
recordatorios de las citas del periodo (exige sesión y vertical_role owner/admin, aplica la cobertura por sucursal de las
citas, `revoke` de public y anon). Sin la migración, `recordatorios` responde las citas pendientes y avisa que el detalle de
envío todavía no está disponible; las otras siete herramientas no dependen de ella.

SQL idéntico en `scripts/verify-data-chat-citas/assertions.sql` (47 escenarios contra Postgres real: cross-tenant en ambos
sentidos, cross-sucursal, `anon`, día local de Mérida, la función de entrega y base sin migrar) y un guard de deriva en
`packages/domain-citas/tests/data-chat/sql-drift.spec.ts`. La RLS de `citas.providers` y de las reglas de horario tiene una
lectura pública (catálogo para reservar), así que las consultas de ocupación y huecos repiten dentro del SQL la cobertura de
la membership en lugar de depender de ella.

## Cómo enchufar el catálogo de otra vertical

1. **Herramientas.** En `packages/domain-<vertical>/src/data-chat/` crea un puerto de lectura (como
   `reader.ts`) y las herramientas (`catalog.ts`): cada `DataChatTool` lleva `name`, `label`, `description`,
   `params` (usa `PERIOD_PARAMS` y `resolvePeriod`) y `run(ctx, args)` que devuelve filas con columnas tipadas
   (`mxn`, `integer`, `percent`, `decimal`, `text`), `source`, `periodLabel`, `scopeLabel` y un `summary`
   determinista. Pide `ctx.maxRows + 1` filas para detectar truncamiento. Reglas: sin parámetros de
   organización/sucursal por id, sin PII en las columnas, un `status` honesto (`empty`, `unavailable`,
   `needs_clarification`).
2. **SQL.** Constantes parametrizadas (`$1` organización, `$2` sucursales permitidas, ventana, zona, tope) con
   JOIN a la tabla de propiedades/sucursales para que RLS también acote. Ejecútalas con `runWithSavepointFallback`
   y traduce 42P01/42703/42883 a `unavailable`.
3. **Verify.** Copia el SQL idéntico a un `scripts/verify-<tema>/assertions.sql` (positivo, negativo,
   cross-tenant, cross-sucursal, `anon`, base sin migrar) y agrega un guard de deriva como
   `tests/data-chat/sql-drift.spec.ts`.
4. **Ruta.** Copia `admin-data-chat.ts`: misma cadena de auth, `scope` desde la membership, y
   `buildXDataChatCatalog(reader)`. Agrega `dataChat` equivalente a `AppDeps` (o extiende `DataChatDeps`).
   Para verticales cuyo catálogo es por propiedad (como hoteles, rentas y citas) no copies la ruta: llama a
   `verticalDataChatRoutes(deps, { vertical, roles, catalog, completion, timezone })`
   (`apps/api/src/data-chat/vertical-routes.ts`) y agrega a `DataChatDeps` el lector y la `completion` de tu vertical
   como campos OPCIONALES (si faltan, la ruta responde "no disponible" en vez de fallar). Los parámetros de
   propiedad se piden por nombre con `propertyParam(...)`/`resolvePropertySelection(...)` de
   `@atiende/agent-core/data-chat`; periodos hacia adelante o mixtos: `FORWARD_PERIOD_PARAMS`/`resolveForwardPeriod`
   y `MIXED_PERIOD_PARAMS`/`resolveMixedPeriod`.
5. **Gateway y apagado.** Registra el rol `<vertical>:data_chat` en `ALL_PRODUCTION_ROLES`
   (`apps/api/src/production/llm-gateway.ts`) y en `SWITCHABLE_AGENT_ROLES`
   (`apps/api/src/platform-switches.ts`; un test exige que coincidan).
6. **UI.** En el shell de la vertical arma un `ChatDatosConexion` (como `RestaurantesShell.tsx`) y pásalo a
   `BotonChatDatos`/`MobileHeaderActions`. Mientras no lo pases, el botón dice "Pronto" y muestra el aviso
   honesto.

## Lo que NO cubre todavía

- Restaurantes, hoteles, rentas, despachos, licitaciones y citas tienen catálogo.
- Citas: el ingreso es precio de lista de citas completadas, no dinero cobrado; la zona horaria es la de la sucursal activa (una organización con sucursales en zonas distintas agrupa los días de todas con esa zona); sin recordatorios por otro canal que WhatsApp y correo.
- Hoteles: no hay "reservas por canal" (`hoteles.reservation` no guarda el canal de origen: sin una migración
  que lo capture no se puede responder sin inventar) ni ocupación proyectada futura (solo noches ya cargadas por la
  auditoría nocturna; el día en curso puede aparecer incompleto). Solo owner/gm.
- Rentas: la ocupación cuenta solo reservas `confirmado` (no provisionales ni en conflicto) y los ingresos se
  atribuyen por la fecha de llegada (una reserva que cruza de mes cuenta entera en el mes de su llegada). Lo que
  esté en otra moneda se avisa y no se suma. Solo admin_gestora/contador.
- Despachos: sin CFDI emitidos ni carga por contador (el modelo no los guarda); la consulta 69-B revisa a lo
  más 40 clientes por pregunta (lo declara en la respuesta) y toda tabla trae a lo más 50 filas.
- Licitaciones: sin montos por propuesta ni conversión de moneda.
- Sin `conversationId` la conversación no se guarda en servidor (el historial vive en la ventana del navegador); el
  guardado es opt-in, ver «Conversaciones guardadas». Aún no hay retención automática (90 días), exportar/borrar todo
  (ARCO), PDF ni fijar sobre lo guardado (CHAT-18, CHAT-14, CHAT-15), ni argumentos de herramienta completos para
  re-ejecutar (solo los parámetros tipados que registra la bitácora).
- Las ventas del chat excluyen pedidos cancelados; los tableros de KPIs hoy suman todos los estados: las cifras
  pueden diferir y cada respuesta lo dice en su fuente.
- Sin evaluación con un modelo real (los tests usan guion): la calidad de la elección de herramienta depende del
  proveedor configurado y conviene medirla con preguntas reales antes de anunciarlo.
