# Rotación de llaves y secretos (PL-18)

Cómo rotar cada secreto de la plataforma **sin imprimirlo ni pegarlo en ningún lado**. Este documento nunca contiene valores.
Los nombres y su efecto están en [`docs/CREDENCIALES.md`](../CREDENCIALES.md); la respuesta a un incidente en [`INCIDENTES.md`](INCIDENTES.md).

## Reglas comunes

- Genera el valor nuevo en tu máquina y pásalo directo al destino sin mostrarlo: p. ej. `openssl rand -hex 32 | vercel env add NOMBRE production`
  (pide el valor por stdin) o pégalo en el panel de Vercel. No lo escribas en un archivo del repo, un chat, un issue ni un PR.
- Un cambio de variable en Vercel **solo aplica tras un nuevo despliegue** (redespliega Producción).
- Guarda el valor viejo en el gestor de secretos hasta verificar el nuevo; bórralo después.
- **Verifica sin imprimir**: comprueba el efecto (un 200/401, un `ok`), no el valor. Para ver que una variable existe usa `vercel env ls` (lista nombres, no valores).
- Si la rotación es por exposición, **rota primero y averigua el alcance después**, y registra el incidente (`INCIDENTES.md`).
- Anota fecha y motivo en el wiki (sin el valor).

## Resumen

| Secreto | Dónde vive | Impacto de rotarlo | Dificultad |
|---|---|---|---|
| `OPENROUTER_API_KEY` | Vercel (+ copia local de evals `~/.atiende-secrets/`, permisos 600) | Los agentes LLM fallan hasta redesplegar | Baja |
| `CRON_SECRET` + `INTERNAL_SECRET` | Vercel (**mismo valor**) | Los crons y las rutas `/internal/*` dan 401 hasta que ambos coincidan | Baja, pero van juntos |
| `JWT_SECRET` | Vercel | Cierra todas las sesiones; sin `SUPERADMIN_MFA_ENCRYPTION_KEY` propia también invalida la MFA enrolada | Media |
| `SUPERADMIN_MFA_ENCRYPTION_KEY` | Vercel | Los secretos TOTP guardados dejan de descifrar: re-enrolar la MFA de cada superadmin | Media |
| `HOTELES_IDENTITY_KEY` (+ `_VERSION`) | Vercel + gestor de secretos con respaldo | **Los documentos de identidad ya guardados dejan de poder leerse** | **Alta: sin re-cifrador hoy** (ver abajo) |
| `DATABASE_URL` (contraseña de Postgres) | Vercel | La API no conecta hasta redesplegar | Media |
| Service role / anon de Supabase | Panel de Supabase | Ningún código del repo los lee | Baja |
| Meta / WhatsApp | Vercel + Meta for Developers | Webhook y envío saliente dejan de funcionar hasta alinear ambos lados | Media |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Vercel + Stripe | Checkout y webhook de cobro fallan hasta alinear | Media |
| `RESEND_API_KEY` | Vercel + Resend | El outbox de correo falla explícito y reintenta (`attempts < 5`) | Baja |

## OPENROUTER_API_KEY (pendiente: rotar, se pegó en un chat)

Pendiente de Javier: la llave que se compartió por chat debe considerarse comprometida.

1. En openrouter.ai crea una llave nueva **con límite de gasto** y la política de datos sin entrenamiento ni retención (`docs/LLM-GATEWAY.md`).
2. Actualízala en Vercel (`OPENROUTER_API_KEY`, Producción) y, si haces evals locales, en `~/.atiende-secrets/OPENROUTER_API_KEY.txt` (permisos 600).
3. Redespliega.
4. **Revoca la llave vieja** en el panel de OpenRouter.
5. Verifica: un turno de un agente (o el data-chat) responde; el consumo aparece en la llave nueva y la vieja ya no recibe llamadas.

## CRON_SECRET e INTERNAL_SECRET (van juntos)

Vercel Cron manda `Authorization: Bearer $CRON_SECRET`; la API compara contra `INTERNAL_SECRET` (`http-security.ts::internalOrCronSecretMatches`).
Deben tener **exactamente el mismo valor** o cada cron recibe 401. Son también la llave de la purga de retención por GET (PL-35).

1. Genera un valor (`openssl rand -hex 32`) y cárgalo en las dos variables de Producción sin mostrarlo.
2. Redespliega (ambas cambian en el mismo despliegue).
3. Quien llame a mano con `x-atiende-internal-secret` (scripts, curl) debe actualizar su copia.
4. Verifica: espera el siguiente ciclo de un cron frecuente (p. ej. `/internal/whatsapp/dispatch`, cada 5 min) y confirma latido `ok` en `/superadmin/salud/crons`; un 401 en el latido significa que no coinciden.

## JWT_SECRET y SUPERADMIN_MFA_ENCRYPTION_KEY

- `JWT_SECRET` firma los tokens de acceso: rotarlo cierra todas las sesiones (es lo esperado). Si `SUPERADMIN_MFA_ENCRYPTION_KEY` no está definida, la clave de cifrado de la MFA se **deriva** de `JWT_SECRET` y rotarlo obliga a re-enrolar la MFA de cada superadmin.
- Definir `SUPERADMIN_MFA_ENCRYPTION_KEY` propia (distinta de `JWT_SECRET`, `openssl rand -hex 32`) evita ese acoplamiento, pero **cambiarla** invalida los factores TOTP ya guardados: re-enrola a cada superadmin (coordina antes, no actives `SUPERADMIN_MFA_REQUIRED` en medio de la rotación).
- Verifica: login de staff funciona con sesión nueva y cada superadmin completa el paso MFA.

## HOTELES_IDENTITY_KEY (con respaldo y re-cifrado)

La bóveda de identidad de hoteles cifra con AES-256-GCM en la aplicación; el sobre guarda `v<versión>` y se liga a (fila, propiedad).

**Estado real del código hoy (verificado en `packages/domain-hoteles/src/identity/cipher.ts`):** el cifrador abre **una sola** versión de llave; un sobre de otra
versión responde `llave_version_no_disponible` y no hay doble llave ni un script de re-cifrado en el repo. Por eso:

1. **Respaldo obligatorio antes de tocar nada**: la llave actual (base64 de 32 bytes) debe existir en el gestor de secretos **fuera de la Mac y de Vercel**, con la versión (`HOTELES_IDENTITY_KEY_VERSION`) anotada. Sin ella los documentos ya capturados son irrecuperables.
2. **No cambies el valor de `HOTELES_IDENTITY_KEY` en Producción mientras haya sobres con la llave vieja**: la revelación (`.../revelar`) fallaría para todos ellos.
3. **Rotación planeada** (no por compromiso): requiere un re-cifrador de un solo uso que lea con la llave vieja y escriba con la nueva y `key_version` + 1, en una transacción por fila, ensayado primero sobre un respaldo restaurado. **Ese re-cifrador no existe aún** (hueco declarado en el PR de PL-18): constrúyelo como PR con pruebas antes de rotar.
4. **Rotación por compromiso confirmado**: congela captura y revelación (la API responde 503 sin llave), exporta por la vía legal lo que haga falta, y decide con asesoría si se purgan las identidades vencidas (`/internal/hoteles/identidad-purga`) y se re-captura; no improvises SQL.
5. Tras cualquier cambio: `HOTELES_IDENTITY_KEY_VERSION` debe corresponder a la llave puesta; verifica con una captura y una revelación de prueba en un entorno **no productivo** y confirma que la lista de identidades no avisa `llaveConfigurada:false`.

## DATABASE_URL (contraseña de Postgres) y llaves de Supabase

- La API conecta con `DATABASE_URL` (pooler de transacción, puerto 6543). `SUPABASE_URL`, `SUPABASE_ANON_KEY` y `SUPABASE_SERVICE_ROLE_KEY` **no las lee ningún código del repo** (`docs/CREDENCIALES.md`).
- Rotar la contraseña: Supabase → Project Settings → Database → Reset database password; actualiza `DATABASE_URL` en Vercel y redespliega. Hay una ventana de errores entre el reseteo y el despliegue: hazlo en horario de baja carga y pausa los crons (interruptor global `crons`).
- Service role / anon: si alguna vez se expusieron, regenera las llaves en el panel (Project Settings → API). Como el código no las usa, no hay otro paso; si en el futuro algo las usa, actualiza esta sección.
- Verifica: `/health` responde y un flujo de lectura autenticado funciona; reanuda los crons.

## Meta / WhatsApp (`WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`)

- `WHATSAPP_ACCESS_TOKEN` (envío): genera un token nuevo en Meta for Developers (WhatsApp → API Setup; usa un token de sistema permanente), cárgalo en Vercel, redespliega y revoca el viejo. Verifica con el siguiente ciclo de `/internal/whatsapp/dispatch` (latido `ok`, sin 503).
- `WHATSAPP_APP_SECRET` (firma del webhook): se rota en Settings → Basic de la app de Meta. Cambia el valor en Vercel y en Meta **en la misma ventana**; mientras no coincidan, los webhooks entrantes se rechazan. Verifica enviando un mensaje de prueba.
- `WHATSAPP_VERIFY_TOKEN`: lo eliges tú; cámbialo en Vercel y en la configuración del webhook de Meta a la vez, y re-verifica el webhook.

## Stripe (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`)

- La llave secreta se rota con "Roll key" en Developers → API keys (Stripe permite un periodo de gracia: úsalo para cambiar Vercel y redesplegar antes de que venza la vieja).
- El secreto del webhook (`whsec_…`) es **por endpoint** y no rota junto con la llave: "Roll secret" en el endpoint, actualízalo en Vercel y redespliega. Mientras estén desalineados el webhook de facturación se rechaza (firma inválida).
- Verifica reenviando un evento de prueba desde el panel de Stripe (respuesta 2xx).

## Resend (`RESEND_API_KEY`)

Crea una llave nueva (Resend → API Keys, con el permiso mínimo de envío), cárgala en Vercel, redespliega y elimina la vieja. Verifica con el siguiente ciclo de un `*/email-dispatch`
(latido `ok`, jobs del outbox pasan a `sent`); los jobs que fallaron entre tanto se reintentan hasta `attempts < 5`.

## Después de cualquier rotación

- [ ] Redespliegue de Producción hecho y `/health` en verde (`scripts/smoke-post-deploy`).
- [ ] Secreto viejo revocado en su proveedor y borrado del gestor.
- [ ] Latidos de los crons que usan el secreto en `ok`.
- [ ] Nota en el wiki: qué, cuándo y por qué (sin valores).
- [ ] Si fue por exposición: postmortem (`INCIDENTES.md`) y revisión de `secret-scan.yml`.
