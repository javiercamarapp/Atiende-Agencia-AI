# Copiloto de superadmin y Copiloto CFO (CHAT-16)

"Chatea con tus datos" de la **plataforma completa**, solo backend (la UI y `proponer_accion` son de la tarea chat-17). Usa el mismo motor que las
seis verticales (`runDataChatTurn`: sin SQL libre, catálogo cerrado, guardia de cifras, transporte NDJSON con abort), pero con un alcance propio:
`PlatformScope` (`apps/api/src/superadmin-copiloto/alcance.ts`), separado de `DataChatScope`.

## Rutas

Van detrás de la cadena de `routes/superadmin.ts` (autenticación, gateo de superadmin, guard de impersonación, zona CFO y step-up).

| Ruta | Qué hace |
| --- | --- |
| `POST /superadmin/copiloto` | Turno del chat. JSON, o NDJSON con `Accept: application/x-ndjson` (se aborta si el cliente corta). Cuerpo: `question`, `history`, `conversationId`, o `tool` + `args` (consulta directa sin modelo). Cualquier otro campo es 400. |
| `GET /superadmin/copiloto/estado` | Disponibilidad, rol (`superadmin` o `finanzas`), si hay step-up, estado del interruptor, gasto del mes frente al tope y herramientas visibles. |
| `GET/PATCH/DELETE /superadmin/copiloto/conversaciones[/:id]` | Conversaciones propias (scope plataforma). Solo el autor las ve; ajena o inexistente = 404. |

Reglas del turno, en orden: impersonación activa -> **409** (chat y estado; el guard común de escrituras exime solo `POST /superadmin/copiloto` para que el rechazo sea este
409); rol efectivo (`core.cfo_zone_resolve_role`); step-up; interruptor `agente superadmin:copiloto`; tope mensual propio; 20 preguntas por minuto por usuario (el motor
responde `rate_limited`); bitácora y conversación.

## Herramientas (solo lectura, parámetros tipados, sin PII ni conversaciones de tenants)

Cada una llama únicamente a funciones `core.*_for_superadmin` ya existentes, con la sesión del superadmin que pregunta (`fuentes.ts`). Una fuente que falta (migración
pendiente, repositorio no configurado, error) produce `No tengo el dato: ...`, nunca una cifra inventada ni un 500.

Operativas (superadmin completo): `organizaciones`, `costos_ia` (por organización, vertical, rol o modelo), `consumo_vs_tope` (tope por organización, de plataforma y propio
del Copiloto), `uso_por_vertical` (consola SA-L-05/06), `agentes_interruptores`, `ultimas_corridas` (latidos de crons), `errores` (crons, colas muertas, fuentes de
licitaciones, denegaciones), `salud_colas`, `planes_y_topes`, `eventos_seguridad`, `prospectos` (sin contacto: ni nombre, ni teléfono, ni correo, ni notas) y `uso_copiloto`.

Financieras, Copiloto CFO (SA-33): `mrr`, `margen_costos_unitarios`, `pyl` y `contratos_por_vencer`.

* Las ve el superadmin y el rol `finanzas` (solo lectura). `finanzas` **solo** ve estas cuatro y su catálogo no contiene ninguna operativa.
* Exigen step-up con la política vigente de `exigirStepUp` (con factor MFA activo, token reciente; `finanzas` no admite degradarse: sin MFA, 403 `mfa_enrollment_required`).
  Consulta directa sin step-up: 403 `stepup_required` antes de abrir el flujo. Si la pide el modelo: la herramienta se niega y no devuelve cifras.
* Cada llamada deja una fila en `core.cfo_access_log` (`consulta`, recurso `copiloto/<herramienta>`, filtros con herramienta y parámetros; o `denegado`) **antes** de leer, en
  una transacción propia. Si no se puede registrar, no se ejecuta. Con la migración 0034 sin aplicar no hay bitácora posible y se conserva el comportamiento anterior.
* La respuesta cita la consulta (`Consulta «mrr» (mes=2026-10): ...`). Sin pagos ni escrituras.

## Gasto del Copiloto y tope mensual propio

Decisión (migración 0048): el gasto del rol `superadmin:copiloto` **no** entra a `core.llm_usage_daily` (su CHECK de vertical ya admite `plataforma` desde la 0040, pero `organization_id` es obligatorio;
registrarlo ahí obligaría a inventar una organización y contaminaría los reportes por cliente) **ni** a los topes por organización. Se mide en la fila de resumen de cada turno de
`core.data_chat_query_log` (vertical `plataforma`, `costo_micro_usd`, modelo, rol). El tope mensual propio compara contra `core.get_copiloto_plataforma_gasto_mes` y contra un
acumulador en memoria de la instancia (cubre la base sin migrar). Al agotarse: modo sin IA (las consultas directas siguen). Valor por defecto provisional: 25 USD
(`TOPE_MENSUAL_COPILOTO_MICRO_USD`); el presupuesto real en producción lo fija Javier (SA-44).

Usa un gateway **dedicado** (`buildSuperadminCopilotoLlmGateway`): su propio circuit breaker, topes de corrida y día en memoria, interruptor de plataforma y la escalera del rol
`superadmin:copiloto` (Claude Sonnet 5.5, respaldo DeepSeek V4 Pro). El rol ya es apagable (`SWITCHABLE_AGENT_ROLES`) y aparece en el panel de agentes (semilla de la migración).

## Datos

* `core.data_chat_query_log` admite filas de plataforma (sin organización) escritas solo por `core.record_data_chat_query` (superadmin vigente); ninguna policy las expone directo.
* Conversaciones: `core.data_chat_conversation` con scope `plataforma` (migración 0041, sin cambios); solo el autor las ve.
* Verificación contra Postgres real: `scripts/verify-superadmin-copiloto/`.

## Huecos conocidos

* SA-44: presupuesto real de gasto del Copiloto en producción (queda para Javier).
* `prospectos` solo cubre el modelo actual del cerebro de ventas.
* `proponer_accion` y la UI son de chat-17.
* Notificaciones in-app: el productor compartido aún no tiene eventos del Copiloto (tope mensual alcanzado, interruptor apagado); listados en el cuerpo de la PR.
