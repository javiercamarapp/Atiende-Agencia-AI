# Chatea con tus datos — motor compartido

Pedido de producto: preguntarle a los datos del negocio en español ("¿cuánto vendí esta semana?") y
recibir tablas/gráficas simples, siempre citando de qué datos salen y el periodo. Este documento explica el
motor compartido, su modelo de seguridad y cómo enchufar el catálogo de otra vertical. Piloto: restaurantes.

## Piezas

| Pieza | Dónde |
|---|---|
| Motor (validación, alcance, límites, redacción de PII, bitácora, verificación de cifras) | `packages/agent-core/src/data-chat/` (export `@atiende/agent-core/data-chat`) |
| Catálogo de restaurantes (8 herramientas, SQL de solo lectura) | `packages/domain-restaurantes/src/data-chat/` |
| Catálogo de despachos (8 herramientas) | `packages/domain-despachos/src/data-chat/` |
| Catálogo de licitaciones (7 herramientas) | `packages/domain-licitaciones/src/data-chat/` |
| Rutas HTTP | `apps/api/src/routes/verticals/restaurantes/admin-data-chat.ts`, `.../despachos/chat-datos.ts`, `.../licitaciones/chat-datos.ts` (cuerpo y alcance compartidos en `apps/api/src/data-chat/`) |
| Bitácora de consultas | migración 0029 → `core.data_chat_query_log` + `core.record_data_chat_query` |
| Diálogo (UI) | `@atiende/ui` → `ChatDatosDialog`; conexión en `apps/web/src/components/BotonChatDatos.tsx` |
| Verificación contra Postgres real | `scripts/verify-data-chat/` (restaurantes) y `scripts/verify-data-chat-despachos-licitaciones/` (los corre el gate de CI) |

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
- **Límites.** 50 filas, 8 s (timeout del motor + `statement_timeout` de Postgres), 3 rondas de herramientas, 4
  llamadas por pregunta, pregunta ≤ 600 caracteres, historial ≤ 6 turnos, salida del modelo ≤ 500 tokens.
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
5. **Gateway y apagado.** Registra el rol `<vertical>:data_chat` en `ALL_PRODUCTION_ROLES`
   (`apps/api/src/production/llm-gateway.ts`) y en `SWITCHABLE_AGENT_ROLES`
   (`apps/api/src/platform-switches.ts`; un test exige que coincidan).
6. **UI.** En el shell de la vertical arma un `ChatDatosConexion` (como `RestaurantesShell.tsx`) y pásalo a
   `BotonChatDatos`/`MobileHeaderActions`. Mientras no lo pases, el botón dice "Pronto" y muestra el aviso
   honesto.

## Lo que NO cubre todavía

- Restaurantes, despachos y licitaciones tienen catálogo; hoteles, citas y rentas siguen con el aviso honesto.
- Despachos: sin CFDI emitidos ni carga por contador (el modelo no los guarda); la consulta 69-B revisa a lo
  más 40 clientes por pregunta (lo declara en la respuesta) y toda tabla trae a lo más 50 filas.
- Licitaciones: sin montos por propuesta ni conversión de moneda.
- La conversación no se guarda en servidor (el historial vive en la ventana del navegador).
- Las ventas del chat excluyen pedidos cancelados; los tableros de KPIs hoy suman todos los estados: las cifras
  pueden diferir y cada respuesta lo dice en su fuente.
- Sin evaluación con un modelo real (los tests usan guion): la calidad de la elección de herramienta depende del
  proveedor configurado y conviene medirla con preguntas reales antes de anunciarlo.
