# Chatea con tus datos — motor compartido

Pedido de producto: preguntarle a los datos del negocio en español ("¿cuánto vendí esta semana?") y
recibir tablas/gráficas simples, siempre citando de qué datos salen y el periodo. Este documento explica el
motor compartido, su modelo de seguridad y cómo enchufar el catálogo de otra vertical. Piloto: restaurantes.

## Piezas

| Pieza | Dónde |
|---|---|
| Motor (validación, alcance, límites, redacción de PII, bitácora, verificación de cifras) | `packages/agent-core/src/data-chat/` (export `@atiende/agent-core/data-chat`) |
| Catálogo de restaurantes (8 herramientas, SQL de solo lectura) | `packages/domain-restaurantes/src/data-chat/` |
| Ruta HTTP | `apps/api/src/routes/verticals/restaurantes/admin-data-chat.ts` |
| Bitácora de consultas | migración 0029 → `core.data_chat_query_log` + `core.record_data_chat_query` |
| Diálogo (UI) | `@atiende/ui` → `ChatDatosDialog`; conexión en `apps/web/src/components/BotonChatDatos.tsx` |
| Verificación contra Postgres real | `scripts/verify-data-chat/` (lo corre el gate de CI) |

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

- Solo restaurantes tiene catálogo; las demás verticales siguen con el aviso honesto.
- La conversación no se guarda en servidor (el historial vive en la ventana del navegador).
- Las ventas del chat excluyen pedidos cancelados; los tableros de KPIs hoy suman todos los estados: las cifras
  pueden diferir y cada respuesta lo dice en su fuente.
- Sin evaluación con un modelo real (los tests usan guion): la calidad de la elección de herramienta depende del
  proveedor configurado y conviene medirla con preguntas reales antes de anunciarlo.
