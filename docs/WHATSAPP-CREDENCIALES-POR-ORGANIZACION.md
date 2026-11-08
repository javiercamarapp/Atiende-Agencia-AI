# WhatsApp: credenciales de Meta por organización (varias apps a la vez)

Migración `packages/db/migrations/0090_whatsapp_credenciales_meta.sql` · código en `apps/api/src/whatsapp-credenciales/`,
`packages/whatsapp-gateway/src/providers/cliente-por-numero.ts`, `apps/api/src/routes/superadmin-whatsapp-meta.ts` y la pantalla
`/superadmin/organizaciones/:id/whatsapp`.

## Para qué sirve

Hasta ahora la plataforma tenía **un** token (`WHATSAPP_ACCESS_TOKEN`) y **un** secreto de app (`WHATSAPP_APP_SECRET`). Un negocio
que registra sus números en **su propio** portafolio de Meta (su WABA y su app tipo Business) trae su propio token y su propio
secreto. Con esto la plataforma atiende varias apps de Meta a la vez:

- **Envío**: cada mensaje sale con el token de la app dueña del número remitente. Un número sin app propia sale con el token de
  plataforma, como antes.
- **Webhook entrante** (`/v1/restaurantes/whatsapp/webhook`): la firma `X-Hub-Signature-256` se acepta si es de la app de plataforma
  **o** de la app propia de una organización. Cada app solo puede hablar por sus números: la de plataforma por los que no tienen app
  propia y la de una organización por los que tiene asignados. Lo demás se acusa con 200 sin procesar. Sin firma o con firma
  inválida, 401, igual que antes.
- **Verify token**: la misma URL sirve a varias apps. El `GET` acepta el `WHATSAPP_VERIFY_TOKEN` de plataforma o el verify token
  propio de cualquier app registrada.
- **Notas de voz**: la media se descarga con el token de la app dueña del número.

**Si no se configura nada, nada cambia.** Sin `WHATSAPP_CREDENTIALS_KEY` (o con la migración sin aplicar) todo sigue con las
variables de plataforma.

## Seguridad

- El token y el secreto se cifran **en la API** con AES-256-GCM (`WHATSAPP_CREDENTIALS_KEY`, 32 bytes en base64). La base solo guarda
  el sobre cifrado, con AAD que lo ata a la credencial, la organización y el campo. El verify token se guarda como SHA-256.
- Las tablas no tienen ningún GRANT, ni para `service_role`. Los sobres solo salen por
  `core.whatsapp_meta_credenciales_para_sistema()`, que exige la sesión de sistema de la API (`auth.uid()` nulo).
- Registrar, rotar, revocar y asignar números: solo un superadmin sin restricción de solo lectura (caller-binding en SQL), con
  **step-up MFA**, límite de frecuencia y bitácora append-only (`core.whatsapp_meta_evento`, sin secretos).
- Los secretos son **de solo escritura**: ninguna respuesta de la API los devuelve. Para cambiarlos se rotan.
- La firma se compara en tiempo constante contra cada secreto candidato, sin salir antes de tiempo.
- Verificación contra Postgres real: `scripts/verify-whatsapp-credenciales-meta/` (gate de CI).

## Orden de despliegue (con OK de Javier en cada paso)

1. Aplicar la migración `0090_whatsapp_credenciales_meta` en la base real.
2. Generar la llave (`openssl rand -base64 32`), guardarla en el gestor de secretos con respaldo y ponerla en Vercel como
   `WHATSAPP_CREDENTIALS_KEY` (Production). `WHATSAPP_CREDENTIALS_KEY_VERSION` puede quedar vacía (vale 1).
3. Redesplegar la API.

El código tolera cualquier orden: sin la migración responde «no disponible» y sin la llave sigue con las variables de plataforma.
**Perder la llave vuelve ilegibles las credenciales guardadas**: habría que volver a capturarlas.

## Paso a paso: la app de Meta en el portafolio de PM

Recomendación del análisis `WHATSAPP-SIN-VERIFICACION.md`: los números de Los Taquitos de PM se registran en el **portafolio de PM**.
Un número no se puede mover de portafolio. Si se registra en el de Atiende sin verificar, queda atrapado ahí.

### 1. Portafolio y acceso

1. El dueño de PM entra a business.facebook.com con su cuenta y crea el portafolio de PM (o usa el que ya tiene).
2. **Configuración del negocio → Usuarios → Personas → Agregar**: agrega a la persona de Atiende que lo va a operar como
   **administrador** (control total). Sin esto Atiende no puede crear la app ni el usuario de sistema.
3. Opcional, en paralelo: **Centro de seguridad → Verificación del negocio** con el RFC o la constancia de PM. Sin verificar, el
   portafolio tiene **2 números** y **250 conversaciones que inicia el negocio** por cada 24 h. Las respuestas a quien escribió no
   cuentan contra ese límite. Para las 7 sucursales hace falta verificar.

### 2. App tipo Business con WhatsApp

1. En developers.facebook.com → **Mis apps → Crear app** → tipo **Business**. Como **portafolio empresarial**, elige el de **PM**.
2. Agrega el producto **WhatsApp**. Meta crea o vincula la cuenta de WhatsApp Business (WABA) del portafolio.
3. La app y la WABA son del mismo negocio, así que es «direct developer»: **no hace falta App Review** ni acceso avanzado.
4. Anota:
   - **App ID**: Configuración → Básica.
   - **Clave secreta de la app**: Configuración → Básica → Mostrar.
   - **ID de la cuenta de WhatsApp Business (WABA)**: WhatsApp → Configuración de la API.

### 3. Números (y coexistencia)

1. En WhatsApp → Configuración de la API → **Agregar número**. Registra 1 o 2 sucursales (T7 y otra). Anota el **phone_number_id**
   de cada número: no es el teléfono, es el ID que aparece junto al número.
2. **Si el número hoy vive en la app WhatsApp Business del celular de la sucursal**:
   - **Coexistencia** (preferida): el número sigue funcionando en la app y la API recibe una copia de lo que el personal contesta. Se
     conecta desde el flujo de registro de Meta con la opción de conectar una cuenta existente de la app WhatsApp Business (código
     QR en el celular). La plataforma ya procesa esos ecos (`smb_message_echoes`): el agente se calla cuando contesta una persona.
     Hazlo primero en **una** sucursal. Su disponibilidad en México no está verificada.
   - **Migrar sin coexistencia borra el historial del chat** y el número deja de funcionar en la app. Úsalo solo si PM lo acepta.
3. Nombre visible: sin verificar, el cliente ve el número y no «Los Taquitos de PM» en su lista de chats, hasta que Meta apruebe el
   nombre.

### 4. Usuario de sistema y token permanente

1. **Configuración del negocio → Usuarios → Usuarios del sistema → Agregar**, con rol **Administrador**.
2. **Asignar activos**: la **app** (control total) y la **cuenta de WhatsApp** (control total).
3. **Generar token**: elige la app, caducidad **Nunca** y los permisos `whatsapp_business_messaging` y
   `whatsapp_business_management`. Copia el token: Meta no lo vuelve a mostrar.
4. Suscribe la app a la WABA para que lleguen los webhooks. Con el token del usuario de sistema, haz un
   `POST https://graph.facebook.com/v21.0/<WABA_ID>/subscribed_apps`. Se comprueba con `GET` sobre la misma ruta.

### 5. Webhook de la app

En la app → **WhatsApp → Configuración → Webhook**:

- **URL de devolución de llamada**: `https://<dominio-de-la-api>/v1/restaurantes/whatsapp/webhook`, la misma que usa la
  plataforma.
- **Token de verificación**: tienes dos opciones.
  - Usar el mismo `WHATSAPP_VERIFY_TOKEN` de la plataforma.
  - Inventar uno propio (16 caracteres o más) y capturarlo en Atiende **antes** de pulsar «Verificar y guardar» (paso 7).
- **Campos**: suscribe `messages`. Con coexistencia, suscribe también `smb_message_echoes`.

### 6. Método de pago (obligatorio)

En el **Administrador de WhatsApp de PM → Configuración de pago**, agrega la tarjeta de PM a su WABA.

- Desde el 1-oct-2026 Meta cobra los mensajes de servicio. Hay **1,000 gratis por número al mes**.
- Las plantillas *utility* se cobran aunque vayan dentro de la ventana de 24 h.
- **Sin método de pago, Meta puede dejar de entregar** a partir del mensaje 1,001.
- El cargo de Meta va a la tarjeta de PM, no a la de Atiende.

### 7. Conectarlo en Atiende

1. Superadmin → **Organizaciones → Los Taquitos de PM → Credenciales de WhatsApp**.
2. **Registrar app de Meta**: captura nombre interno, App ID, WABA, clave secreta, token del usuario de sistema y, si aplica, el
   verify token propio. Te pide el código MFA. Los secretos no se vuelven a mostrar.
3. Si elegiste un verify token propio, ahora sí pulsa «Verificar y guardar» en Meta (paso 5).
4. En **Números por sucursal → Asignar**: escribe el `phone_number_id` de la sucursal y elige la app de PM. Esto conecta el número a
   la sucursal (el mismo ruteo de `restaurantes.whatsapp_branch_channel`) y decide con qué app sale y se verifica.
5. Las otras instancias de la API ven el cambio en 60 segundos o menos (caché por instancia). La instancia donde guardaste lo ve al
   instante.

### 8. Plantillas

Las plantillas se crean y aprueban en el Administrador de WhatsApp **de PM**, porque viven en su WABA. Una vez aprobadas, se declaran
como hoy: en el catálogo por organización o en `WHATSAPP_APPROVED_TEMPLATES` (ver `docs/PLANTILLAS-WHATSAPP.md`). Si más adelante PM
comparte su cuenta con la app de Atiende, la calidad de las plantillas se reinicia (2 a 4 semanas).

### 9. Prueba

1. Desde un celular, escribe al número de la sucursal. El webhook responde 200 y el agente contesta desde ese número.
2. Si no llega nada, revisa:
   - Que la app esté suscrita a la WABA (paso 4.4) y al campo `messages`.
   - Que el `phone_number_id` asignado sea el correcto.
   - Los logs de la API: un 401 es una firma que no coincide (secreto equivocado o sin capturar). Un 503 «Credentials temporarily
     unavailable» es que la base no respondió, y Meta reintenta.
3. El botón «Probar» de Meta manda un número ficticio: se acusa con 200 sin procesar, y es lo correcto.

## Rotar y revocar

- **Token**:
  1. Genera uno nuevo para el usuario de sistema.
  2. Pégalo en **Rotar** y guarda.
  3. Después revoca el viejo en Meta.

  No hay corte.
- **Clave secreta de la app**:
  1. Restablécela en Meta (Configuración → Básica).
  2. Pégala en **Rotar** de inmediato.

  Mientras tanto los webhooks de esa app reciben 401 y Meta los reintenta, así que no se pierden si lo haces en minutos.
- **Revocar**: borra el token, la clave secreta y el verify token guardados. Sus números vuelven a la plataforma. Úsalo si la app se
  da de baja o se filtró algo. Después, en Meta, quita la suscripción de la app a la WABA, o los webhooks de esa app recibirán 401.

## Límites y huecos conocidos

- La firma por app solo está en el webhook de **restaurantes**. Citas, hoteles y licitaciones siguen solo con la app de plataforma.
- La alerta de token por vencer (`saludMeta`) solo vigila el token de plataforma. Los tokens de usuario de sistema con caducidad
  «Nunca» no vencen, pero si se revocan en Meta los envíos fallan con el código 190 (queda en el outbox como fallo del proveedor).
- Si la base no responde, un número con app propia **no** cae al token de plataforma: el envío se reintenta.
- Revertir: quitar `WHATSAPP_CREDENTIALS_KEY` regresa todo a la plataforma sin tocar la base. El SQL de reversa está en la cabecera
  de la migración 0090.
