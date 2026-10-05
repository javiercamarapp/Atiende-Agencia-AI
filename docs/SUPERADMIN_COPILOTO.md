# Copiloto de superadmin y Copiloto CFO (CHAT-16)

"Chatea con tus datos" de la **plataforma completa**. El backend es de CHAT-16; la UI (página, panel Cmd+J, tarjeta de acción) y `proponer_accion` son de CHAT-17 (sección «Acciones propuestas» más abajo). Usa el mismo motor que las
seis verticales (`runDataChatTurn`: sin SQL libre, catálogo cerrado, guardia de cifras, transporte NDJSON con abort), pero con un alcance propio:
`PlatformScope` (`apps/api/src/superadmin-copiloto/alcance.ts`), separado de `DataChatScope`.

## Rutas

Van detrás de la cadena de `routes/superadmin.ts` (autenticación, gateo de superadmin, guard de impersonación, zona CFO y step-up).

| Ruta | Qué hace |
| --- | --- |
| `POST /superadmin/copiloto` | Turno del chat. JSON, o NDJSON con `Accept: application/x-ndjson` (se aborta si el cliente corta). Cuerpo: `question`, `history`, `conversationId`, o `tool` + `args` (consulta directa sin modelo). Cualquier otro campo es 400. |
| `GET /superadmin/copiloto/estado` | Disponibilidad, rol (`superadmin` o `finanzas`), si hay step-up, estado del interruptor, gasto del mes frente al tope y herramientas visibles. |
| `GET/PATCH/DELETE /superadmin/copiloto/conversaciones[/:id]` | Conversaciones propias (scope plataforma). Solo el autor las ve; ajena o inexistente = 404. |
| `POST /superadmin/copiloto/conversaciones/:id/reporte?seq=N` | Reporte PDF del mensaje (el «Descargar PDF» de las verticales, CHAT-14). Re-ejecuta las herramientas del mensaje con el alcance actual (jamás `proponer_accion`); las financieras exigen step-up (403 `stepup_required` antes de consultar) y dejan huella en `core.cfo_access_log`; 6 por 10 min por usuario (fail-closed); `finanzas` puede pedir el de su propia conversación. Sin IA, con el interruptor apagado o el tope agotado, el PDF sale solo con datos (`x-reporte-narrativa: no_disponible`). |

Reglas del turno, en orden: impersonación activa -> **409** (chat y estado; el guard común de escrituras exime solo `POST /superadmin/copiloto` para que el rechazo sea este
409); rol efectivo (`core.cfo_zone_resolve_role`); step-up; interruptor `agente superadmin:copiloto`; tope mensual propio; 20 preguntas por minuto por usuario (el motor
responde `rate_limited`); bitácora y conversación.

## Herramientas (solo lectura, parámetros tipados, sin PII ni conversaciones de tenants)

Cada una llama únicamente a funciones `core.*_for_superadmin` ya existentes, con la sesión del superadmin que pregunta (`fuentes.ts`). Una fuente que falta (migración
pendiente, repositorio no configurado, error) produce `No tengo el dato: ...`, nunca una cifra inventada ni un 500.

Operativas (superadmin completo): `organizaciones`, `costos_ia` (por organización, vertical, rol o modelo), `consumo_vs_tope` (tope por organización, de plataforma y propio
del Copiloto), `uso_por_vertical` (consola SA-L-05/06), `agentes_interruptores`, `ultimas_corridas` (latidos de crons), `errores` (crons, colas muertas, fuentes de
licitaciones, denegaciones), `salud_colas`, `planes_y_topes`, `eventos_seguridad`, `prospectos` (sin contacto: ni nombre, ni teléfono, ni correo, ni notas) y `uso_copiloto`.

Financieras, Copiloto CFO (SA-33): `mrr`, `margen_costos_unitarios`, `pyl`, `contratos_por_vencer` y `facturacion_cobranza` (estado de cobro por organización: activa, pago pendiente, cancelada o sin suscripción, con asientos y fin del periodo; sin correos ni ids de Stripe).

* Las ve el superadmin y el rol `finanzas` (solo lectura). `finanzas` **solo** ve estas cinco y su catálogo no contiene ninguna operativa.
* Exigen step-up con la política vigente de `exigirStepUp` (con factor MFA activo, token reciente; `finanzas` no admite degradarse: sin MFA, 403 `mfa_enrollment_required`).
  Consulta directa sin step-up: 403 `stepup_required` antes de abrir el flujo. Si la pide el modelo: la herramienta se niega y no devuelve cifras.
* Cada llamada deja una fila en `core.cfo_access_log` (`consulta`, recurso `copiloto/<herramienta>`, filtros con herramienta y parámetros; o `denegado`) **antes** de leer, en
  una transacción propia. Si no se puede registrar, no se ejecuta. Con la migración 0034 sin aplicar no hay bitácora posible y se conserva el comportamiento anterior.
* La respuesta cita la consulta (`Consulta «mrr» (mes=2026-10): ...`). Sin pagos ni escrituras.

## Gasto del Copiloto y tope mensual propio

Decisión (migración 0048): el gasto del rol `superadmin:copiloto` **no** entra a `core.llm_usage_daily` (su CHECK de vertical ya admite `plataforma` desde la 0040, pero `organization_id` es obligatorio;
registrarlo ahí obligaría a inventar una organización y contaminaría los reportes por cliente) **ni** a los topes por organización. Se mide en la fila de resumen de cada turno de
`core.data_chat_query_log` (vertical `plataforma`, `costo_micro_usd`, modelo, rol). El tope mensual propio compara contra `core.get_copiloto_plataforma_gasto_mes` y contra un
acumulador en memoria de la instancia (cubre la base sin migrar). Al llegar al 80 % y al 100 % avisa a los superadmins (`superadmin.copiloto.tope_mensual`). Al agotarse: modo sin IA (las consultas directas siguen). Valor por defecto provisional: 25 USD
(`TOPE_MENSUAL_COPILOTO_MICRO_USD`); el presupuesto real en producción lo fija Javier (SA-44).

Usa un gateway **dedicado** (`buildSuperadminCopilotoLlmGateway`): su propio circuit breaker, topes de corrida y día en memoria, interruptor de plataforma y la escalera del rol
`superadmin:copiloto` (Claude Sonnet 5.5, respaldo DeepSeek V4 Pro). El rol ya es apagable (`SWITCHABLE_AGENT_ROLES`) y aparece en el panel de agentes (semilla de la migración).

## Datos

* `core.data_chat_query_log` admite filas de plataforma (sin organización) escritas solo por `core.record_data_chat_query` (superadmin vigente); ninguna policy las expone directo.
* Conversaciones: `core.data_chat_conversation` con scope `plataforma` (migración 0041, sin cambios); solo el autor las ve.
* Verificación contra Postgres real: `scripts/verify-superadmin-copiloto/`.

## Huecos conocidos

* SA-44: presupuesto real de gasto del Copiloto en producción (queda para Javier).
* **Fijados en el tablero**: las verticales fijan resultados (`core.copiloto_pin`, por organización). El Copiloto de plataforma NO ofrece «Fijar» (el transporte se crea con `fijados: false`) porque ese servidor no tiene `/pins` ni hay dónde pintar el tablero en el Resumen; requiere migración propia (fijados por superadmin, sin organización) + script verify + sección en el Resumen.
* **Adjuntar archivo**: el chat de las verticales (`ChatDatosShell`) no tiene adjuntos; por eso el de plataforma tampoco. Si se quiere analizar CSV/Excel/PDF en ambos, es una función nueva y común (decisión de producto).
* `prospectos` solo cubre el modelo actual del cerebro de ventas.
* Tu turno (SA-L-19) todavía no existe: la tarjeta de acción enlaza a la bandeja de pendientes actual (`/superadmin/acciones`) hasta que exista.
* Las acciones del catálogo que no están implementadas siguen apareciendo como «no disponible» en `/superadmin/acciones`; el Copiloto no puede proponerlas (el esquema de `proponer_accion` es cerrado).
* Apagar/encender un agente NO es un intent de `core.superadmin_action_intent` (su CHECK de `tipo` solo admite tres tipos y esta tarea no agrega SQL): es una propuesta firmada (ver abajo). Un solo uso por nonce en memoria de la instancia + compare-and-set del estado del interruptor; cuando exista SQL, moverla a un cuarto tipo de intent.
* El motivo de la tarjeta solo se pide en interruptores (es lo único que lo guarda: `core.platform_switch.reason`); los intents del catálogo no tienen dónde registrarlo.
* Notificaciones in-app: solo el tope mensual propio emite aviso (`superadmin.copiloto.tope_mensual`, umbrales 80 y 100, sin PII). Una consulta financiera denegada ya queda en `core.cfo_access_log`, que no tiene aviso in-app (sin evento definido en el catálogo).

## Acciones propuestas (CHAT-17)

El modelo **solo propone**: `proponer_accion` (catálogo del superadmin completo; el rol `finanzas` nunca la recibe) crea una propuesta de 5 minutos y la UI la dibuja como `CopilotoTarjetaAccion`.
Ejecutar exige que la misma persona confirme con un segundo POST, con step-up (MFA reciente) y, para interruptores, motivo de 20 caracteres como mínimo. Cancelar y Escape no envían nada.

| Tipo | Qué crea | Se confirma con |
| --- | --- | --- |
| `reencolar_mensaje_muerto`, `cerrar_prospecto`, `ejecutar_mantenimiento_ahora` | `core.superadmin_action_intent` real (un solo uso en la base, vence a los 5 min, `creado_por = auth.uid()`; payload y resumen validados por `superadmin-acciones/componer.ts`, las mismas reglas que la pantalla de Acciones) | `POST /superadmin/acciones/intents/:id/confirmar` (ya exige step-up) |
| `apagar_agente`, `encender_agente` (solo `SWITCHABLE_AGENT_ROLES`) | Token firmado HMAC-SHA256 (subllave de `JWT_SECRET`) que liga actor + agente + efecto + estado observado + vencimiento + nonce; solo letras minúsculas para que el motor no lo redacte como teléfono | `POST /superadmin/copiloto/acciones/confirmar` `{ propuesta, agente, motivo }` (step-up en `SENSITIVE_ROUTES`) |

* `GET /superadmin/copiloto/acciones/:propuesta[?agente=]` devuelve el estado (`pendiente`, `ejecutada`, `fallida`, `cancelada`, `vencida`, `archivada`) y el efecto calculado por el servidor; al reabrir una conversación la tarjeta ya no ofrece confirmar lo vencido, usado o cambiado.
* Con impersonación activa el Copiloto sigue deshabilitado (409 en `/estado` y en `/acciones/:propuesta`).
* Notificación: `superadmin.copiloto.accion_propuesta` (aprobaciones, atención, enlace `/superadmin/acciones`, clave de dedupe = id del intent o nonce de la propuesta, sin PII).
* UI: `/superadmin/copiloto` (justo debajo de Resumen, en la primera sección del sidebar) y el panel lateral Cmd+J (400 px, 480 ms, no se desmonta al navegar porque `SuperAdminShell` es el layout de todas las rutas `/superadmin/*`; Esc lo cierra; cerrado = ancho 0 e `inert`).
