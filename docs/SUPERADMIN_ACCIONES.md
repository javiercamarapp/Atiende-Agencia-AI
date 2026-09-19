# Acciones sugeridas con confirmación (`/superadmin/acciones`)

Tercera y última pieza del "cerebro" de backoffice del superadmin, después
de Salud operativa y Resumen diario. Ver el comentario de cabecera de
`supabase/migrations/20240101000144_0016_superadmin_acciones.sql` para el
diseño técnico completo; este documento es el resumen operativo.

## Principio rector

Viene de un incidente real en otro producto del mismo dueño: un "agente de
backoffice" mandó correos redactados por LLM a terceros sin revisión
humana, porque su ventana de veto tenía default 0 y su interruptor vivía en
una variable de entorno sin bitácora. Por eso, en este sistema:

- **Ninguna acción con efecto real hacia un tercero se ejecuta porque el
  cliente mande un flag.** El servidor siempre crea un **intent** primero
  (`core.superadmin_action_intent`), y exige un **segundo POST explícito**
  del **mismo** superadmin para confirmarlo. El servidor re-valida el
  estado actual del mundo antes de ejecutar — el mundo pudo cambiar desde
  que se creó el intent.
- **Lo automático es mínimo, reversible e interno.** Las dos
  automatizaciones (desatascar outbox colgado, marcar prospectos sin
  movimiento) nunca envían nada a un tercero por sí solas, y cada ejecución
  queda registrada en `core.automation_action_log`.
- **Nada de LLM en este sistema**: ni para decidir qué es una sugerencia ni
  para redactar el resumen que un superadmin lee antes de confirmar. Todo
  es determinista (ver `apps/api/src/superadmin-acciones/sugerencias.ts` y
  `.../resumen.ts`).

## Lo que NUNCA se automatiza ni se ofrece como acción de un clic

La lista completa, con la misma razón repetida en el código
(`apps/api/src/superadmin-acciones/catalogo.ts`, `ACCIONES_NO_DISPONIBLES`):

1. **Envíos redactados por LLM sin aprobación por pieza.**
2. **Cambiar topes de gasto** (de LLM, de plataforma, de cualquier
   organización).
3. **Tocar dinero**: suscripciones, reembolsos, reprocesar webhooks de
   billing, cargos o folios.
4. **Accesos y credenciales**: break-glass, roles, integraciones.
5. **Modificar datos de negocio de un tenant** (reservas, pedidos, clientes
   de un cliente de Atiende).
6. **Publicar o desplegar.**

Cómo se hace cumplir (no es solo una promesa en este documento):

- `apps/api/src/superadmin-acciones/catalogo.ts` declara estas entradas con
  `disponible: false` explícito — la pantalla las muestra como "no
  disponible", nunca oculta que existen como idea.
- `apps/api/tests/superadmin-acciones-catalogo.spec.ts` falla si alguien
  registra un tipo de acción `disponible: true` sin `requiereConfirmacion:
  true` (salvo las dos automatizaciones internas declaradas), y falla si
  alguna entrada que coincide con estas 6 categorías aparece disponible en
  cualquier parte del catálogo.
- El catálogo *ejecutable* real está acotado también en SQL: el `check`
  sobre `core.superadmin_action_intent.tipo` solo admite
  `reencolar_mensaje_muerto`, `cerrar_prospecto` y
  `ejecutar_mantenimiento_ahora` — ningún otro tipo puede llegar a
  ejecutarse aunque alguien se salte la capa TS.

## Las 3 acciones con intent + confirmación (hoy)

| Tipo | Efecto real | Payload |
| --- | --- | --- |
| `reencolar_mensaje_muerto` | Devuelve a `pending` UNA fila `dead` de UNA cola — termina en un envío real cuando corra el dispatcher | `{ queue, mensajeId }` |
| `cerrar_prospecto` | Cambia un prospecto a `perdido`/`descartado` (reutiliza `core.update_prospecto_for_superadmin`) | `{ prospectoId, estado }` |
| `ejecutar_mantenimiento_ahora` | Corre a demanda las dos automatizaciones de abajo | `{}` |

## Las 2 automatizaciones internas (sin intent, corren solas)

1. **Desatascar outbox colgado** — aplica solo donde el esquema permite
   saber con certeza que una fila `processing` está colgada (`claimed_at`
   no nulo y viejo): `citas`, `hoteles`, `restaurantes`, `rentas`.
   `despachos`/`licitaciones` NO tienen columna `claimed_at` — nunca se
   tocan, y el resultado lo reporta explícito (`aplica: false` + motivo) en
   vez de omitirlo en silencio.
2. **Marcar prospectos sin movimiento** — anota
   `necesita_seguimiento_desde` en un prospecto sin movimiento > 14 días
   (estados terminales excluidos). Se desmarca sola en cuanto el prospecto
   cambia. Nunca cambia el `estado` del prospecto ni contacta a nadie.

Cron: `/internal/superadmin/mantenimiento`, cadencia diaria en
`vercel.json` (ver el comentario de ese archivo/de la ruta para por qué —
con un plan de Vercel que permita crons más frecuentes convendría una
cadencia de 15-30 min, más cerca del umbral de 30 min que usa la
automatización).

## Verificación

- `apps/api/tests/superadmin-acciones*.spec.ts` — motores puros y rutas de
  punta a punta contra repos en memoria.
- `scripts/verify-superadmin-acciones/` — 30 escenarios contra Postgres
  real (autorización, máquina de estados, concurrencia, idempotencia).
