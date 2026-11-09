# WhatsApp Embedded Signup: el restaurante conecta su propio número

Desde **Sucursales → reglas de la sucursal → «Conectar mi número con Meta»**, el dueño o un administrador conecta un número de WhatsApp Business. El número puede ser propio o uno nuevo. Ya no hace falta que la plataforma lo dé de alta a mano en su WABA.

La función está **apagada por omisión**. Mientras falte algo, el panel muestra «no disponible aún» con los **nombres** de las variables que faltan, nunca sus valores.

Código:

- servidor: `apps/api/src/routes/verticals/restaurantes/whatsapp-embedded-signup.ts`;
- cliente de Meta: `packages/whatsapp-gateway/src/providers/meta-embedded-signup.ts`;
- navegador: `apps/web/src/verticals/restaurantes/lib/whatsapp-embedded-signup.ts`.

## Qué pasa al conectar

1. El navegador carga el SDK de Facebook (`connect.facebook.net`) y abre el flujo de Embedded Signup con el `config_id`.
2. El dueño elige su negocio y su cuenta de WhatsApp Business (WABA), y verifica su número.
3. Meta devuelve al navegador un `code` de un solo uso más `waba_id` y `phone_number_id`. El navegador los manda a la API.
4. La API hace estos pasos con Meta:
   1. canjea el `code` por el token de integración del negocio (`/oauth/access_token`, con el App Secret);
   2. comprueba que el número pertenece a esa WABA;
   3. da al **usuario de sistema de la plataforma** acceso `MANAGE` sobre la WABA (`/{waba}/assigned_users`);
   4. suscribe la app a los webhooks de la WABA (`/{waba}/subscribed_apps`);
   5. registra el número en la Cloud API con un **PIN nuevo de 6 dígitos** (`/{phone}/register`).
5. Guarda el ruteo `phone_number_id → sucursal` en `restaurantes.whatsapp_branch_channel`, la misma tabla que ya usa el webhook. Deja bitácora `configuracion.whatsapp_embedded_signup`.
6. El panel muestra el PIN **una sola vez** para que el dueño lo guarde. El PIN no se guarda ni se registra en logs.

**No se guardan tokens de clientes.** El token del negocio vive solo en memoria durante esa llamada, y los mensajes de error de Meta salen redactados. La plataforma sigue enviando con su token de siempre (`WHATSAPP_ACCESS_TOKEN`) porque su usuario de sistema ya tiene acceso a la WABA del cliente.

## Lo que tiene que dar el dueño de la app de Meta (una sola vez, para toda la plataforma)

Todo se hace en la **misma app de Meta** que ya recibe el webhook (la de `WHATSAPP_APP_SECRET`).

1. **App de tipo Business** con el producto **WhatsApp** agregado. Meta for Developers → tu app → *Settings → Basic*:
   - **App ID**: va en `META_APP_ID`. Es público; lo usa el SDK.
   - **App Secret**: ya debería estar en `WHATSAPP_APP_SECRET`. Se usa para canjear el `code`. **Nunca** va al navegador.
2. **Verificación del negocio** de la empresa dueña de la app (Business Manager → *Security Center*) y alta como **Tech Provider**: WhatsApp → *Overview* → «Become a Tech Provider». Sin esto, el flujo solo funciona con cuentas de prueba.
3. **Configuración de Embedded Signup.** *Facebook Login for Business → Configurations → Create*:
   - variante de inicio de sesión: **WhatsApp Embedded Signup**;
   - activos: WhatsApp accounts;
   - permisos: `whatsapp_business_management` y `whatsapp_business_messaging`.

   El **Configuration ID** va en `WHATSAPP_ES_CONFIG_ID`.
4. **Dominios permitidos.** *Facebook Login for Business → Settings*:
   - agrega el dominio del panel en *Allowed Domains for the JavaScript SDK*;
   - activa *Login with the JavaScript SDK*.
5. **Usuario de sistema de la plataforma.** Business Manager → *Users → System users*. Es el usuario de sistema (rol Admin) cuyo token permanente ya está en `WHATSAPP_ACCESS_TOKEN`, con `whatsapp_business_management` y `whatsapp_business_messaging`. Su **ID** va en `WHATSAPP_SYSTEM_USER_ID`.
6. **Webhook de la app** ya configurado (`/v1/restaurantes/whatsapp/webhook`, campo `messages`), como en `docs/restaurantes/whatsapp-setup.md`. Las WABAs nuevas lo heredan al suscribirse (paso 4.4 de arriba).
7. **Encender:** `WHATSAPP_EMBEDDED_SIGNUP=true` en Vercel (Production). Apagar es quitarla o ponerla en `false`.

Las variables se cargan en Vercel. Nunca se escriben valores en el repo, PRs ni chats (`docs/CREDENCIALES.md`).

## Política de seguridad del navegador (CSP)

Hoy la CSP del panel está en modo `Report-Only`. Si se activa en modo estricto (PR de `fix/csp-enforce`), hay que permitir:

- `script-src https://connect.facebook.net`;
- `frame-src https://www.facebook.com https://web.facebook.com`;
- `connect-src https://graph.facebook.com`.

Si no se permiten, el botón no abre la ventana de Meta.

## Límites y errores

- Solo **owner/admin** con acceso a esa sucursal. Tope de 10 intentos por hora por organización.
- Si Meta rechaza un paso, el panel lo explica en lenguaje llano, por ejemplo «el número está en uso en la app de WhatsApp» o «el código venció». El log guarda el paso, el código de Meta y el mensaje redactado.
- Un número que ya está conectado a otra sucursal de cualquier organización se rechaza con 409. Es la misma regla que al capturarlo a mano.
- Desconectar es lo mismo que hoy: borrar el número en la misma pantalla. Para quitar el acceso de la plataforma a la WABA, el cliente lo hace en su Business Manager.
