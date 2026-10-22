# Login del repartidor con celular y codigo por WhatsApp

Estado: implementado detras de la bandera `LOGIN_CHOFER_WHATSAPP` (apagada por omision). Decision del dueno: los **repartidores** (rol
`repartidor` de restaurantes) entran con su celular y un codigo de 6 digitos que reciben por WhatsApp. Encargado, cajero, administradores,
owners y superadmin **siguen entrando con correo, sin cambios**, y no pueden entrar por esta via aunque tengan un telefono registrado.

## Flujo

1. El encargado/admin registra el celular del repartidor al crear su cuenta (`PUT .../staff/miembros/:userId/telefono-acceso`). Solo aplica a
   cuentas de repartidor; se guarda en E.164 mexicano (`+52` y 10 digitos).
2. El repartidor escribe su celular en la pantalla de acceso (`POST /auth/login-telefono/solicitar`). La respuesta es **siempre la misma**
   (`200 { ok: true }`), exista o no una cuenta de repartidor con ese numero.
3. Si existe, se emite un codigo y se encola en `restaurantes.messaging_outbox` **solo como plantilla aprobada** `codigo_acceso` (categoria
   autenticacion, `es_MX`, `{{1}}` = codigo). Nunca como texto libre.
4. El repartidor escribe el codigo (`POST /auth/login-telefono/verificar`). Si es correcto se emite la sesion con el mismo `issueSession` de
   `/auth/login` (mismos tiempos de vida, registro de sesion, revocacion y refresco).

## Modelo de amenazas

| Amenaza | Control |
|---|---|
| Adivinar el codigo (1 en 1,000,000) | Aleatorio criptografico (`crypto.randomInt`), vigencia 5 min, **maximo 5 intentos por codigo** (el contador sube *antes* de comparar, en un solo `UPDATE` atomico: los intentos en paralelo tambien cuentan) y luego el codigo se invalida; 2 codigos agotados bloquean el telefono 30 min. |
| Robo de la base | El codigo se guarda solo como HMAC-SHA256 con sal aleatoria y una llave de servidor derivada del secreto JWT; vive 5 min y es de un solo uso. |
| Repeticion del codigo | Un solo uso (`pendiente -> usado` atomico: con dos verificaciones simultaneas gana una) y un indice unico garantiza **un solo codigo pendiente por usuario**; emitir uno nuevo invalida el anterior. |
| Temporizacion al comparar | `timingSafeEqual` sobre HMAC de igual longitud; si no hay cuenta o codigo se compara contra un codigo senuelo para igualar el costo. |
| Enumeracion de cuentas | `solicitar` responde igual exista o no la cuenta y cuenta *toda* solicitud contra los limites; `verificar` falla con el mismo `401` para cuenta inexistente, no elegible, codigo vencido, agotado o incorrecto. La indisponibilidad (bandera apagada, plantilla no aprobada en ninguna organizacion) es **global**, no depende de la cuenta. El tiempo de respuesta tampoco distingue: `solicitar` no envia a Meta dentro de la solicitud (solo encola); el despacho sale post-commit y se ejecuta igual para cualquier telefono, con tope de espera y un **piso fijo de 1.5 s** para toda respuesta exitosa (hay prueba). |
| Abuso de envios (costo, acoso por WhatsApp) | 3 solicitudes / 15 min por telefono y 10 / 15 min por IP (en la base, durable entre instancias) mas un limite en memoria/Redis por IP; `429` identico para cualquier numero. Bloqueo temporal silencioso (se responde igual y no se envia). |
| Relleno de texto libre / phishing | El payload lleva `solo_plantilla`: el gateway **rechaza** (sin enviar) si la plantilla no esta aprobada y nunca degrada a texto. El `body` del payload es un texto fijo sin codigo. Sin plantilla aprobada la API responde "no disponible aun" y no envia. |
| Escalada de privilegios | `core.chofer_login_es_elegible` (en la base, en cada paso): membresia `repartidor` de una organizacion de restaurantes activa o en prueba, ****unica membresia** del usuario (ninguna otra organizacion, rol ni vertical; asi el admin de la organizacion B no puede registrar su celular a alguien que tambien es repartidor en A y tomar su sesion) y no superadmin. Se reevalua al reservar el intento y al consumir. Encargado, cajero, admin, owner y superadmin con telefono registrado no resuelven. |
| Baja del chofer | El telefono depende de la membresia (FK en cascada): `remove_membership` borra el telefono y la elegibilidad falla; un codigo emitido antes de la baja no se consume. Las sesiones ya emitidas siguen la revocacion existente (`/auth/revoke-sessions`, `sessions_revoked_at`). |
| Fuga de PII en logs/auditoria | El telefono y la IP solo se guardan como HMAC en `core.chofer_login_evento`; los logs de la API no incluyen telefono ni codigo. El payload del outbox (necesita telefono y codigo hasta enviar) se redacta al pasar a `sent`/`dead` y, ademas, toda fila `auth.codigo_acceso` con mas de 10 min en estado no terminal se mata y se redacta (`purgar_codigos_acceso_vencidos`, migracion 093, llamada tras cada solicitud). La vigencia del codigo la calcula la base con su reloj (sin desfase de la API). |
| Registro del telefono por quien no debe | `chofer_login_telefono_guardar` exige `auth.uid()` real con autoridad (owner/admin de la organizacion o encargado; un `staff` con perfil `cajero` no) y que el objetivo sea un repartidor elegible de **esa** organizacion. Telefono ya usado por otra cuenta: rechazo generico. Auditoria sin telefono. |
| SIM swap / numero reasignado | Riesgo residual del canal (igual que cualquier OTP por SMS/WhatsApp). Mitigacion operativa: quitar el telefono al dar de baja y revocar sesiones; la vigencia de la sesion es la ya existente. |

## Riesgos aceptados (revision independiente de #632)

- **M3, bloqueo/consumo del codigo por un tercero.** Quien conozca el celular de un repartidor puede gastar los 5 intentos de su codigo vigente o provocar el bloqueo de 30 min (2 codigos agotados). Es un riesgo de **disponibilidad**, no de acceso (no revela ni da sesion). Mitigacion: camino de rescate con el encargado, que siempre puede iniciar sesion al repartidor por correo (o quitar y volver a registrar el celular, lo que invalida codigos pendientes) y los eventos `codigo_agotado`/`solicitud_bloqueada` quedan en la auditoria para detectar el abuso.
- **B5, tope diario por telefono.** Hoy el tope es 3 envios / 15 min por telefono (el costo de la plantilla de autenticacion lo paga la organizacion). Un atacante paciente puede pedir ~12 codigos/hora a un numero; mejora futura: tope diario por telefono y por organizacion y alerta de costo.
- **B6, IP compartida.** Si el proxy no entrega cabeceras de IP, `requestActor` usa `unknown` y todos comparten un unico cubo por IP (10 solicitudes / 15 min en la base): protege el costo pero puede degradar a repartidores legitimos. Mitigacion: configurar `TRUSTED_PROXY_IP_HEADER` en el despliegue; el limite por telefono sigue independiente.
- **B2.** Registrado como riesgo aceptado de la misma revision; su texto no estaba en el encargo de correccion, completar aqui con el hallazgo original.
- **SIM swap / numero reasignado**: ver tabla.

## Coordinacion de numeracion

Este PR usa `0059` (core) y `093` (restaurantes). La migracion de RLS del chofer planeada despues (plan del panel del operador) **debe numerarse 094**, no 093.

## Parametros

Codigo de 6 digitos, 5 min (expira por el reloj de la base), 5 intentos, 3 envios/15 min por telefono, 10/15 min por IP, bloqueo 30 min tras 2 codigos agotados.

## Piezas

- Migracion `0059_login_chofer_whatsapp` (tablas `core.chofer_login_*`, funciones `security definer`, solo-sistema o autoridad del caller) y
  `093_outbox_codigo_acceso_sin_residuo`. Verificacion contra Postgres real: `scripts/verify-login-chofer-whatsapp/`.
- Gateway: `solo_plantilla` y boton de codigo de la plantilla de autenticacion (`packages/whatsapp-gateway`).
- API: `apps/api/src/routes/auth-login-telefono.ts`, helpers en `apps/api/src/login-telefono/`.
- Web: pantalla movil `AccesoRepartidor` y campo de celular en el alta del repartidor.

## Orden de despliegue

1. Aprobar en Meta la plantilla `codigo_acceso` (categoria autenticacion, idioma `es_MX`, un parametro de cuerpo = codigo, con boton de
   copiar codigo) y registrarla como `aprobada` en el catalogo (`core.whatsapp_plantilla`, evento `auth.codigo_acceso`, nombre `codigo_acceso`).
2. Fusionar el codigo (la bandera sigue apagada: sin efecto).
3. Aplicar `0059` y `093` (SQL Editor / conector), con el visto bueno del dueno. Antes de aplicarlas la API responde "no disponible aun".
4. Registrar el celular de cada repartidor desde el panel.
5. Encender `LOGIN_CHOFER_WHATSAPP=true` (variable de entorno de la API). Reversa: apagarla; el login por correo nunca se modifica.
