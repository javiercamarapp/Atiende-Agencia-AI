# Panel de agentes y bitacora de corridas (SA-L-07, SA-L-08)

Migracion `packages/db/migrations/0044_superadmin_corridas_y_panel_agentes.sql` (espejo
`supabase/migrations/20240101000281_*`). Pagina web `/superadmin/agentes`
(seccion Agentes). Verificacion contra Postgres real: `scripts/verify-superadmin-agentes/`.

## Que hay

| Pieza | Donde | Para que |
|---|---|---|
| `core.agent_run` | migracion 0044 | Una fila por corrida: agente (rol del gateway o ruta del cron), vertical, organizacion (null en crons de plataforma), disparo (`cron`, `whatsapp`, `voz`, `manual`), estado (`ok`, `parcial`, `fallo`), tareas hechas/total y costo (null = no medido), error redactado de 500 caracteres o menos, inicio y fin. |
| `core.agent_definition` | migracion 0044 | Catalogo declarativo. `id` = rol del gateway (mismo formato que `core.platform_switch` con scope `agente`). Estado `vivo`, `pausado`, `disenado` o `retirado`. Semilla: los 14 roles de `SWITCHABLE_AGENT_ROLES`. |
| `core.record_agent_run` | solo sistema | Escribe una corrida; redacta correos y numeros largos otra vez en la base. |
| `core.system_purge_agent_runs` | solo sistema | Purga por lotes lo anterior a la retencion (clase `plataforma_agent_run`, 90 dias). La invoca el cron de mantenimiento. |
| `core.system_agent_is_live` | solo sistema | Decide si el fallo de un agente avisa a los superadmins. |
| `core.list_agent_runs_for_superadmin` | superadmin | Bitacora filtrable (maximo 200 filas, rango de 400 dias). |
| `core.get_agent_panel_for_superadmin` | superadmin | Una fila por agente: ultima corrida, exito y costo de 30 dias. |

## Dar de alta un agente

Es una fila, no una migracion:

```sql
insert into core.agent_definition (id, nombre, vertical, canal, disparador, modelo_rol, estado)
values ('citas:recordatorios_agent', 'Recordatorios de citas', 'citas', 'cron', 'Cada 15 minutos', 'citas:recordatorios_agent', 'vivo');
```

La palanca del panel solo funciona para roles que existan en `SWITCHABLE_AGENT_ROLES`
(`apps/api/src/platform-switches.ts`): un agente nuevo del catalogo sin rol en esa lista se muestra, pero sin palanca
(la columna Kill switch dice «No disponible aun»). Agregar el rol alli es un cambio de codigo.

## Quien escribe `agent_run`

- **Crons**: `withHeartbeat` (`apps/api/src/salud/with-heartbeat.ts`) en cada corrida real. Una pausa por interruptor no es una corrida.
- **WhatsApp**: el punto unico de salida del turno de restaurantes, hoteles y citas (`production/deps.ts`, via
  `conBitacoraDeTurno`).
- **Rentas**: el borrador de mensajeria pedido a la IA (`routes/verticals/rentas/mensajeria-borradores.ts`).

Escribir la bitacora es **best-effort**: sesion de sistema propia por escritura, errores tragados (solo se registra el
SQLSTATE) y base sin migrar omitida en silencio. Nunca tumba ni altera la corrida.

## Huecos conocidos

- No escriben `agent_run` todavia: los seis `data_chat`, el extractor de requisitos, el borrador de propuesta, las
  preguntas de la junta y la conciliacion con IA de despachos, ni el agente de voz. Sus filas del panel salen
  «Sin corridas» (no 0 %).
- Los turnos de WhatsApp registran estado y duracion; no registran tareas ni costo (`null`, no medido). El costo real
  vive en `core.llm_usage_daily` y el panel lo suma por rol.
- Los crons no cuentan tareas (`tareas` = null).
- Insumos por agente (P3): la columna dice «fuera de alcance».
- El presupuesto/dia se muestra pero no se aplica como tope (hoy el tope se aplica por organizacion y mes en el
  gateway): es un dato declarativo del catalogo.
- No hay pantalla para dar de alta o editar agentes; hoy es una fila.

## Despliegue

Aplicar `0044` (espejo `20240101000281`) antes o despues del codigo: sin ella, el panel responde `disponible: false`
y las corridas no se escriben, sin ningun error en los flujos existentes.

## Fichas de agente y Model Ops (SA-L-09, SA-L-10)

Solo lectura. Rutas web: `/superadmin/agente-extractor`, `/superadmin/agente-conciliacion`, `/superadmin/agente-whatsapp` y `/superadmin/model-ops`
(seccion Agentes de `apps/web/src/superadmin/rutas.ts`). Endpoints: `GET /superadmin/agentes/:ficha` (`extractor`, `conciliacion`, `whatsapp`; cualquier
otro nombre es 404 y `/superadmin/agentes/corridas` sigue siendo la bitacora de corridas) y `GET /superadmin/model-ops`, en
`apps/api/src/routes/superadmin-agentes-fichas.ts`, detras de la misma cadena de `routes/superadmin.ts`.

Fuentes (migracion `0049_superadmin_fichas_agente`, mas `0042` para llamadas por rol y conversaciones de WhatsApp):

| Cifra | Fuente |
| --- | --- |
| Gastado, llamadas, fallbacks (historico) | `core.get_consola_agentes_actividad_for_superadmin` (0042) sobre `core.llm_usage_daily` |
| Costo por modelo (30 dias) y carril real | `core.get_fichas_modelos_por_rol_for_superadmin` |
| Barras de 7 dias | `core.get_fichas_actividad_diaria_for_superadmin` |
| Documentos extraidos | `core.get_fichas_documentos_extraidos_for_superadmin` (requisitos con `extracted_by = 'llm'` no invalidados) |
| Movimientos conciliados | `core.get_fichas_conciliados_for_superadmin` (matches vigentes de `despachos.conciliacion_match`) |
| Minutos y costo de voz | `core.get_fichas_voz_por_vertical_for_superadmin` (`core.usage_cost_event`, categoria `voz`) |
| Conversaciones de WhatsApp | `core.get_consola_conversaciones_wa_for_superadmin` (0042) |
| Modelo y proveedores por rol | `resolveRoleRoute` (defaults + `LLM_MODELS_JSON`), sin secretos |

Reglas: un campo sin fuente es `{ valor: null, codigo, razon }` (la pagina pinta "—" con el motivo, nunca 0); base sin migrar es 200 con `disponible: false`.
La precision del extractor no esta medida (no hay verdad de terreno) y el estado del circuit breaker se muestra "no legible" (vive en memoria de cada instancia o
en Upstash; este endpoint no lo consulta). Model Ops no versiona prompts ni cambia modelos: el modelo de cada rol se cambia con `LLM_MODELS_JSON`.
