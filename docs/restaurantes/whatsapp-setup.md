# Alta del agente de WhatsApp (Meta Cloud API)

El agente de restaurantes recibe los mensajes por **un solo webhook compartido** y los rutea al restaurante por el número destino. Esta guía deja listo un
número real. **No** ejecutes pruebas de pedidos contra un número real sin autorización del dueño: para ensayar usa el widget de la demo (`docs/demo-pm/guion.md`).

## 1. Variables (Vercel, no en el frontend ni en el repo)

| Variable | Qué es | Sin ella |
|---|---|---|
| `WHATSAPP_VERIFY_TOKEN` | Lo eliges tú; es el handshake GET del webhook | La API no arranca |
| `WHATSAPP_APP_SECRET` | App Secret de la app de Meta; verifica `X-Hub-Signature-256` sobre el cuerpo crudo | La API no arranca |
| `WHATSAPP_ACCESS_TOKEN` | Token de envío (Graph API). Debe rotarse y tener alerta de expiración | El envío saliente queda apagado; `/internal/whatsapp/dispatch` responde 503 |
| `WHATSAPP_APPROVED_TEMPLATES` | Plantillas HSM aprobadas por Meta (R-27), separadas por comas | Todo sale como texto libre; fuera de la ventana de 24 h Meta lo rechaza |
| `OPENROUTER_API_KEY` | LLM del agente (`docs/LLM-GATEWAY.md`) | El agente no responde con modelo |

Detalle de dónde se obtiene cada una y qué pasa sin ella: `docs/CREDENCIALES.md`. El número emisor (`phone_number_id`) no es una variable: se guarda por
restaurante (tabla `restaurantes.whatsapp_channel_config`) y **solo enruta**; el App Secret de la plataforma verifica todas las firmas.

## 2. Webhook en Meta for Developers

1. App -> WhatsApp -> Configuration -> Webhook: URL `https://<dominio>/v1/restaurantes/whatsapp/webhook`, token = `WHATSAPP_VERIFY_TOKEN`; suscribe el campo `messages`.
2. Conecta el número a la sucursal desde el panel (`PUT .../admin/sucursales/:branchId/whatsapp`, con el `phone_number_id` del número); un número por sucursal.
3. Crea y envía a aprobación las plantillas HSM de estado de pedido (`docs/PLANTILLAS-WHATSAPP.md`); cuando Meta las apruebe, decláralas en `WHATSAPP_APPROVED_TEMPLATES`.

## 3. Qué garantiza el webhook

- Firma HMAC sobre los **bytes crudos** del cuerpo (nunca se parsea antes), tope de 256 KB y límite de 120 mensajes por minuto por número.
- Meta puede reenviar el mismo `message.id`: el servidor deduplica (at-least-once) y toma un lease de 120 segundos por conversación para que dos mensajes casi
  simultáneos no corrompan el historial.
- Se procesan **todos** los mensajes del lote en el orden del payload; si uno falla la respuesta es 5xx y Meta reintenta (los ya procesados se omiten).
- PAN, vencimiento y CVV se redactan **antes** de guardar cualquier mensaje.
- Aviso de privacidad y de asistente virtual: el sistema los antepone una sola vez, en el primer mensaje; "mis datos personales" abre el flujo ARCO (`docs/PRIVACIDAD-PLATAFORMA.md`).
- Una conversación con un humano en curso (handoff) hace que el agente calle; el aviso llega a la campana del staff.
- El aviso de estado del pedido al cliente sale por el outbox de mensajería, que drena `/internal/whatsapp/dispatch` cada 5 minutos (`vercel.json`).

## 4. Verificación sin efectos reales

```bash
npx vitest run apps/api/tests/e2e-ciclo --maxWorkers=2        # ciclo completo con simuladores de Meta, Resend y POS
npx vitest run packages/whatsapp-gateway --maxWorkers=2
```

Usan datos sintéticos y repositorios en memoria; no llaman a Meta, OpenRouter ni a ningún servicio externo. La validación con proveedores reales es una
compuerta aparte y exige un ambiente aislado y autorización.

## 5. Pendientes externos conocidos

- Número real de cada sucursal y credenciales de Meta (dueño + Meta).
- Aprobación de plantillas HSM (Business Manager de Meta): hasta entonces, fuera de la ventana de 24 h el aviso muere `dead` con el código 131047.
