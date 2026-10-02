# Runbook de despachos

Operación del vertical de despachos contables: primera ingesta de la lista 69-B, validación de la DIOT, alta de clientes, cierre
mensual, estados de cuenta, portal del cliente, crons y qué hacer cuando algo falla. Mismo patrón que `docs/DEPLOY.md` y
`docs/CRONS.md`; las rutas y límites de abajo salen del código de `apps/api/src/routes/verticals/despachos/`.

> Regla de oro: nada de esto se ejecuta contra la base real sin una decisión humana explícita. Este documento no aplica nada.
> Las fichas normativas (`packages/domain-despachos/normas/`) están todas `por_verificar`: ninguna cifra fiscal que el sistema
> produzca es un dictamen. Las dudas abiertas viven en `docs/despachos/PREGUNTAS-AL-FISCALISTA.md`.

## 0. Requisitos y estado de la base

- `INTERNAL_SECRET` definido en el entorno de la API (`apps/api/src/env.ts:210`); es el mismo valor que `CRON_SECRET` de Vercel.
- `RESEND_API_KEY` solo si se quiere envío real de correo (`env.ts:222`). Sin ella el outbox no se toca (ver sección 8).
- Las migraciones de `packages/domain-despachos/migrations/` (hoy hasta la `020`) se aplican a la base como decisión aparte
  (`docs/DEPLOY.md`). Contra una base sin migrar las rutas degradan a "no disponible" en lugar de fallar; si algo responde
  "no disponible", lo primero es revisar si falta la migración correspondiente.

## 1. Primera ingesta real de la lista 69-B

La ruta es interna y no es agendable por Vercel (`docs/CRONS.md`, sección "No agendados a propósito").

1. Descarga del SAT el CSV público "Listado completo 69-B" del mes. Tope: **4 MB** (`MAX_EFOS_CSV_BYTES`,
   `apps/api/src/routes/verticals/despachos/efos.ts:24`); un archivo mayor se rechaza con 413. Si el SAT lo publica en codificación
   distinta a UTF-8 el lector la decodifica (`decodificarListado69B`, `packages/domain-despachos/src/cfdi/efos.ts:82`).
2. Revisa a ojo la cabecera: el lector exige una fila con las columnas RFC y Situación del contribuyente
   (`efos.ts:180`). Si no la encuentra responde 400 con ese mensaje. Las columnas oficiales están en la pregunta 2 de
   `PREGUNTAS-AL-FISCALISTA.md`.
3. Envía el archivo como cuerpo de un POST, con el secreto en `Authorization: Bearer <INTERNAL_SECRET>` o en el encabezado
   `x-atiende-internal-secret` (`apps/api/src/http-security.ts:52`):

   ```
   curl -X POST "https://<dominio>/internal/despachos/efos-69b/ingestar?periodo=2026-09" \
     -H "Authorization: Bearer $INTERNAL_SECRET" --data-binary @listado-69b.csv
   ```

   `periodo` es obligatorio con formato `YYYY-MM`. Sin secreto responde 401. El secreto va en tu shell, nunca en el historial
   del repositorio.
4. Lee la respuesta: `ok`, `periodo`, `resultado`, `filas`, `descartadas` (con hasta 50 renglones en `detalle_descartadas`) y
   `fuente_sha256`. La ingesta es idempotente por el SHA del archivo: repetir el mismo CSV no duplica filas.
5. Verifica con un usuario del despacho: `GET /despachos/<propertyId>/efos/estado` debe mostrar el periodo, las filas y la fecha de
   ingesta; `GET /despachos/<propertyId>/efos/alertas` lista las facturas ya ingeridas cuyo emisor figura como presunto o
   definitivo. Si el estado dice `no_disponible`, falta la migración 014 del paquete: no es una lista vacía ni "sin hallazgos".
6. Un error 503 en la ingesta significa que la base no tiene la estructura de la lista (migración pendiente). No reintentes en
   bucle.

## 2. Validar la DIOT con el validador del SAT

El archivo es solo para revisión y carga asistida: no se firma ni se envía desde el sistema (`diot-layout.ts:5`). La versión del
layout se llama `diot-batch-sin-cotejar-con-validador-sat` (`diot-layout.ts:40`) a propósito: nadie ha cotejado todavía el
formato con el validador.

1. Genera el archivo del periodo: `GET /despachos/<propertyId>/declaraciones/diot/<YYYY-MM>/layout`. Devuelve el TXT delimitado
   por `|` y el XML, más `omitidos` (terceros que no se pudieron capturar, por ejemplo RFC genéricos) y `advertencias`.
2. Lee `omitidos` y `advertencias` antes de nada: el sistema deja vacías las columnas que no conoce (extranjeros, IVA no
   acreditable, importaciones, devoluciones) en lugar de inventarlas.
3. Carga el TXT en el validador oficial de la DIOT del SAT, en la computadora del contador.
4. Registra el resultado (versión del validador, errores) en la pregunta 1 de `PREGUNTAS-AL-FISCALISTA.md`. Si el validador
   rechaza el archivo, el ajuste va en la tabla `COLUMNAS_DIOT` (`diot-layout.ts:49`), en un PR aparte con su prueba.
5. Presentar la declaración ante el SAT con e.firma queda fuera del sistema.

## 3. Alta de un cliente (cartera)

1. Alta del cliente: `POST /v1/despachos/<orgSlug>/admin/cartera` (`routes/verticals/despachos/cartera.ts:99`) con RFC, tipo de
   persona, razón social, regímenes fiscales, código postal fiscal, periodicidad y responsable. Un RFC repetido en el despacho se
   rechaza con 409. Lista: `GET` en la misma ruta.
2. Ficha posterior: `GET`/`PUT /despachos/<propertyId>/cartera/ficha` (`cartera.ts:121`, `:127`).
3. Constancia de situación fiscal (CSF) y opinión de cumplimiento 32-D: **hoy son manuales**. La ficha de cartera no tiene campos
   para esos documentos (`packages/domain-despachos/src/cartera/types.ts`); el despacho los consulta en el portal del SAT y los
   guarda fuera del sistema. Es un hueco conocido, no un olvido; hay que crearlo como tarea si se quiere llevarlo dentro.
4. Tras el alta, los vencimientos se calculan por régimen con día hábil (`vencimientos/calendario-fiscal.ts`). Un régimen no
   soportado se avisa, no se inventa.

## 4. Cierre mensual, paso a paso

Rutas en `routes/verticals/despachos/cierre-mensual.ts`; todas bajo `/despachos/<propertyId>/cierre-mensual/`.

1. Abrir el periodo: `POST periodos`.
2. Ver el periodo y sus tareas: `GET periodos` y `GET periodos/<periodoId>`.
3. Ejecutar las comprobaciones automáticas: `POST periodos/<periodoId>/auto-check`. Validaciones sueltas disponibles:
   `validaciones/balance`, `polizas`, `nomina`, `iva`, `isr` y `bancos`.
4. Completar a mano cada tarea pendiente: `POST periodos/<periodoId>/tareas/<tareaId>/completar`. El actor sale de la sesión.
5. Revisar el reporte: `GET periodos/<periodoId>/reporte`.
6. Cerrar: `POST periodos/<periodoId>/cerrar` con `{"confirmacion": "<año>-<mes con dos dígitos>"}`, por ejemplo `2026-09`
   (`cierre-mensual.ts:225`). El cierre es **irreversible**: no existe reapertura implementada. Si el texto de confirmación no
   coincide con el periodo, responde 400 y no cierra.
7. Antes de cerrar, confirma que las cifras de ISR dependan de datos capturados (coeficiente de utilidad, pérdidas pendientes) y
   no solo de los motores: ver la pregunta 6 de `PREGUNTAS-AL-FISCALISTA.md`.

## 5. Importación de estados de cuenta

Rutas en `routes/verticals/despachos/conciliacion.ts`; web: `pages/ImportarEstadoCuenta.tsx`.

1. Vista previa: `POST /despachos/<propertyId>/conciliacion/importar-estado-de-cuenta` con JSON (`contenido`, `formato`, `banco`,
   `cuenta` y tolerancias opcionales). Tope del cuerpo: **2 MB** (`conciliacion.ts:63`). No guarda nada: devuelve movimientos,
   coincidencias propuestas con facturas y cartera, y los ya importados (por hash).
2. Revisa la vista previa. Los renglones duplicados por hash se señalan.
3. Guardar: `POST .../importar-estado-de-cuenta/guardar` (`conciliacion.ts:219`).
4. Después, `POST .../conciliacion/matching`, `clasificar-deposito`, `verificar-spei` y `alertas` según el caso. Ninguna
   clasificación de depósito es una determinación fiscal firme (`devolucion-iva/workpaper.ts:27`).

## 6. Portal del cliente

Rutas en `routes/verticals/despachos/portal-cliente.ts`; el cliente entra por la página pública `/portal/cliente`
(`apps/web/src/App.tsx:1172`).

1. El despacho crea un enlace: `POST /despachos/<propertyId>/portal-cliente/enlaces` con `etiqueta` (1 a 80 caracteres) y `dias`
   (entero de 1 a 365, 30 por omisión). El token se genera una sola vez; el sistema guarda su hash. Cópialo en ese momento: no se
   puede recuperar después.
2. Entrega el enlace al cliente por un canal que ya uses con él.
3. Para cortar el acceso: `POST .../portal-cliente/enlaces/<enlaceId>/revocar`. Lista de enlaces: `GET .../portal-cliente/enlaces`.
4. Documentos y mensajes: `GET .../portal-cliente/documentos`, `.../descargar`, `.../aceptar`, `.../rechazar`, y
   `GET`/`POST .../portal-cliente/mensajes`. Cada creación de enlace deja registro en la bitácora.

## 7. Crons de despachos y su kill switch

Tabla completa en `docs/CRONS.md`. Los dos de despachos (`vercel.json`, líneas 80 y 81):

| Path | Hora UTC | Qué hace |
|---|---|---|
| `/internal/despachos/cobranza-reminders` | 14:25 | Barrido de recordatorios de cobranza, una transacción por organización |
| `/internal/despachos/email-dispatch` | 14:30 | Drena el outbox de correo de despachos |

- Ambos rechazan con 401 sin secreto y corren dentro de `withHeartbeat`; el latido se ve en `/superadmin/salud/crons`.
- **Kill switch:** superadmin, Interruptores, cron `<path>` (o el global `crons`). Pausado responde 200 con
  `{"skipped":"kill_switch"}`. Ambos paths están en `SWITCHABLE_CRONS` (`apps/api/src/platform-switches.ts`).
- Verificación manual: `curl -H "Authorization: Bearer $CRON_SECRET" https://<dominio>/internal/despachos/email-dispatch`
  (acepta GET y POST). No lo hagas contra producción con correo real si no quieres enviar mensajes.
- La ingesta de la 69-B no es un cron (sección 1).

## 8. Si falla el outbox de correo

Síntomas y causas, en el orden en que conviene revisarlas:

1. **Respuesta `status: "not_configured"`** del cron de correo: falta `RESEND_API_KEY`. Es el estado esperado sin la clave: no se
   reclamó ni se gastó ningún intento (`email-dispatch.ts:6` a `:27`). Configurar la clave es un cambio aparte.
2. **`failed` creciendo:** Resend rechazó el envío; el trabajo se reintenta con espera. Cada trabajo admite 5 intentos
   (`MAX_EMAIL_DISPATCH_ATTEMPTS`, `email-dispatch.ts:29`). La respuesta del cron lista `errors` con el `job_id` y el motivo.
3. **`dead`:** agotó los 5 intentos o el destinatario estaba suprimido (`email-dispatch.ts:47`). Un humano debe revisarlo; el
   sistema no los reenvía. Un correo nunca se marca `sent` si Resend no lo aceptó.
4. **Pausar mientras se investiga:** kill switch del cron `/internal/despachos/email-dispatch` (sección 7). La cola se queda
   intacta en `pending`/`failed`.
5. Estados posibles del trabajo en la tabla de la cola: `pending`, `processing`, `sent`, `failed`, `dead`
   (`packages/domain-despachos/migrations/005_email_outbox_and_notificaciones.sql:42`). Reencolar un `dead` requiere acción
   directa en la base y una decisión humana; este documento no da el comando.
6. Los envíos usan la llave de idempotencia `outbox/<id>` (`email-dispatch.ts:85`), así que reintentar el mismo trabajo no
   duplica el correo.

## 9. Rollback

- **Código:** revertir el PR en `main` (revert por merge, sin reescribir historia). El despliegue de Vercel vuelve a la versión
  anterior; los crons de despachos se registran desde `vercel.json`, así que revertir un PR que los cambió los quita.
- **Mientras se decide:** pausa los crons de la sección 7 con el kill switch; es inmediato y no requiere despliegue.
- **Base de datos:** las migraciones de `packages/domain-despachos/migrations/` no tienen reversa automática. No apliques SQL de
  deshacer sin una decisión humana; el código está escrito para seguir funcionando contra una base sin migrar, así que el
  rollback de código no obliga a tocar la base.
- **Lista 69-B:** la ingesta es idempotente por SHA; si cargaste una edición equivocada, vuelve a ingerir la correcta con su
  `periodo`. No hay borrado por la API.
- **Cierre mensual:** un periodo cerrado no se puede reabrir desde el sistema (sección 4).
