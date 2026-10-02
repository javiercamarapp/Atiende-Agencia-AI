# Lista de supresion de plataforma (SA-L-46)

Lista unica de contactos (telefono o correo) a quienes la plataforma NO manda avisos proactivos. Hoy el opt-out
solo existia por vertical (`licitaciones.whatsapp_opt_out*`, migracion 030); esta lista es de plataforma.

## Que es y como se guarda

- Tabla `core.supresion_contacto` (migracion `0042_supresion_contacto_plataforma.sql`, espejo
  `supabase/migrations/20240101000271_...`): `tipo` (telefono | correo), `valor_hash`, `motivo` (baja | queja |
  rebote | solicitud_arco | no_contactar), `origen`, `organization_id` (informativo), `creado_en`.
- **Nunca el valor en claro.** `valor_hash` = SHA-256 en hex de `atiende:supresion:v1:<tipo>:<valor normalizado>`
  (el prefijo separa el dominio). El API normaliza y hashea; la base solo recibe el hash.
- Normalizacion (`apps/api/src/supresion/normalizar.ts`): telefono en E.164 con lada MX (+52) por defecto
  (`+52 55 1234 5678`, `5512345678`, `044 55 1234 5678`, `+52 1 55 ...` y `525512345678` dan el mismo hash);
  correo en minusculas y sin espacios.
- La supresion es GLOBAL por contacto: si pidio no ser contactado, no se le mandan avisos proactivos de ninguna
  organizacion. `organization_id` solo registra donde ocurrio el evento.
- Acceso: RLS habilitado SIN politicas y sin GRANT a ningun rol; solo funciones `security definer` con
  `search_path` fijo: `core.registrar_supresion` y `core.esta_suprimido` (solo sistema: `auth.uid() is null`),
  `core.list_supresiones_for_superadmin` y `core.agregar_no_contactar_for_superadmin` (superadmin, con
  caller-binding `auth.uid() = p_caller_id`). Justificacion linea por linea en la cabecera de la migracion.

## Donde se aplica

| Salida | Punto unico | Guard |
| --- | --- | --- |
| WhatsApp proactivo (citas, hoteles, licitaciones, restaurantes) | `dispatchWhatsAppVertical` y `triggerInline` en `apps/api/src/routes/internal/whatsapp-dispatch.ts` | `WhatsAppOutboundDispatcher.dispatchPending(..., { suppression })` |
| Correo (citas, despachos, hoteles, licitaciones, restaurantes, rentas) | `runXxxEmailDispatch` y `triggerXxxEmailDispatchInline` de cada vertical | `dispatchPendingEmailJobs(..., { suppression })` de cada paquete `domain-*` |

- Un mensaje suprimido se marca `dead` con `last_error = 'suprimido'`, sin reintento y sin llamar al proveedor.
- **FAIL-CLOSED**: si la lectura de la lista falla (cualquier error que no sea "no migrada"), NO se envia. En
  WhatsApp el mensaje vuelve a la cola sin quemar un intento; en correo el job se trata como un fallo de envio
  (reintento con backoff, `dead` al agotar).
- **Excepcion documentada**: SQLSTATE `42P01`/`42883`/`42703` (tabla o funciones aun no migradas) permite el envio y
  escribe el log `supresion_no_migrada` (sin valores), para no detener los avisos entre el deploy y el `db push`.
  El acceso corre dentro de SAVEPOINT (`runWithSavepointFallback`) porque la sesion del despachador es una sola
  transaccion.
- Un destino que no se puede interpretar como telefono o correo no se consulta (lo rechaza el proveedor).

## Criterio transaccional (NO se suprime)

Se exenta lo que el cliente pidio en la conversacion en curso: confirmacion de pedido o de cita, estado de SU
pedido, respuesta del agente a su mensaje, acceso a SU reserva. Los productores de esas respuestas marcan
`payload.transaccional = true` en el outbox; el despachador salta el guard solo si es exactamente `true`.
Todo lo demas (recordatorios, alertas, avisos, resumenes, campañas) es proactivo y se suprime. Un productor nuevo
de respuesta a una peticion del cliente debe poner la marca; si la olvida el efecto es seguro (se trata como
proactivo).

## Alimentacion

- **BAJA / STOP por WhatsApp** (citas, hoteles, restaurantes): el mensaje de texto COMPLETO `baja`, `stop`, `alto`,
  `ya no`, `dar de baja`, `darme de baja` o `cancelar suscripcion` (sin importar mayusculas, acentos ni signos)
  registra la supresion (motivo `baja`, origen `whatsapp.<vertical>`) y encola UNA confirmacion marcada
  transaccional. Repetirlo no vuelve a confirmar (`registrar_supresion` es idempotente y devuelve si la fila es
  nueva). No pasa al agente. Riesgo conocido: `alto` o `ya no` como respuesta a una pregunta del agente cuenta como
  baja (solo con el mensaje completo; una frase no la activa).
- **"No contactar" manual**: `POST /superadmin/supresion/no-contactar` (step-up MFA) y la pagina
  `/superadmin/supresion`.
- Base sin migrar: BAJA sigue al camino anterior del webhook (sin supresion, con log `supresion_no_migrada`).

## Superadmin

`GET /superadmin/supresion`: conteos por motivo y origen, nunca valores ni hashes. Base sin migrar: 200 con
`disponible: false`. `POST /superadmin/supresion/no-contactar`: hashea aqui, 503 honesto si la base no esta migrada.

## Huecos declarados

- **Fuerza bruta**: el espacio de telefonos MX es chico; un SHA-256 con prefijo fijo se invierte por enumeracion si
  alguien obtiene la tabla. Hoy lo mitiga el control de acceso (sin GRANT, sin politicas). Mejora pendiente: HMAC
  con llave propia de plataforma (`v2`), que exige rehashear la lista.
- **Productores fuera de los despachadores** (envian directo a Resend, sin pasar por la lista): el resumen diario
  (`apps/api/src/resumen-diario/correo.ts`) y las alertas operativas (`apps/api/src/alertas/canales.ts`), ambos
  dirigidos al personal de la propia organizacion, y los correos de autenticacion (`auth-magic-link.ts`,
  `auth-account.ts`), que son transaccionales por definicion. No se encontro otro productor de WhatsApp proactivo
  fuera de `WhatsAppOutboundDispatcher`.
- **Licitaciones**: conserva su opt-out por vertical (`whatsapp_opt_out*`) y su webhook no escribe aun en la lista de
  plataforma; sus avisos si respetan la lista de plataforma.
- **ARCO**: oposicion/cancelacion aceptadas aun no escriben `solicitud_arco` (no se encontro un punto unico seguro);
  el motivo existe en la tabla y en `registrarSupresion`.
- **Quejas y rebotes de correo** (webhook de Resend): el motivo existe, pero el webhook no esta conectado.
- **PL-32** (BAJA/STOP por telefono en la vertical plataforma): este PR cubre BAJA en los webhooks de WhatsApp de
  citas, hoteles y restaurantes y la lista unificada; queda licitaciones (migrar su opt-out) y los demas canales.
