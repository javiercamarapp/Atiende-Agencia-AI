# verificar-meta-whatsapp

Comprobación de **solo lectura** de la conexión con Meta (WhatsApp Business): confirma, sin enviar nada, que la WABA y los números existen, su calidad, si están en coexistencia con la app WhatsApp Business, el límite de mensajería, las plantillas y que la app esté suscrita a la WABA.

## Solo lectura (política)

- Hace únicamente `GET` a Graph API, por medio de `MetaGraphWhatsAppReader` (`packages/whatsapp-gateway/src/providers/meta-graph-reader.ts`), que lanza una excepción ante cualquier otro método antes de tocar la red. Hay pruebas que lo verifican.
- **No** envía mensajes, **no** registra, verifica ni agrega números, **no** configura webhooks, **no** crea, edita ni borra plantillas, **no** suscribe apps.
- El token se lee **solo** de la variable de entorno `WHATSAPP_ACCESS_TOKEN` de tu terminal. El script no lee archivos de secretos ni imprime el token (ni en la tabla, ni en el JSON, ni en errores).
- No se corre en CI: las pruebas usan un `fetch` falso.

## Uso

```bash
export WHATSAPP_ACCESS_TOKEN=...        # solo en tu terminal; no lo pegues en el repo ni en chats
export META_APP_ID=...                  # para comprobar subscribed_apps

node scripts/verificar-meta-whatsapp/verificar.ts \
  --waba 1234567890 \
  --numero 1098765432100=T7 \
  --numero 1098765432101=T3
```

(Node 22.6+ con `--experimental-strip-types`, o Node 23.6+ directamente. Si tienes `tsx`, `npx tsx scripts/verificar-meta-whatsapp/verificar.ts ...` también sirve.)

| Opción | Qué hace |
|---|---|
| `--waba <id>` | WABA a revisar (repetible). Por defecto, `WHATSAPP_WABA_IDS` (separadas por comas). |
| `--numero <phone_number_id>=<etiqueta>` | Número a revisar con su etiqueta de sucursal (repetible). |
| `--version v23.0` | Versión de Graph API. Por defecto `WHATSAPP_GRAPH_API_VERSION` o `v21.0`. Formato `^v\d{2}\.0$`. |
| `--sin-coexistencia` | No exige `is_on_biz_app` (número que no usa la app WhatsApp Business). |
| `--json` | Emite el informe completo en JSON. |
| `--help` | Ayuda. |

Variables: `WHATSAPP_ACCESS_TOKEN` (obligatoria), `META_APP_ID`, `WHATSAPP_WABA_IDS`, `WHATSAPP_GRAPH_API_VERSION` (ver `docs/CREDENCIALES.md`).

## Qué imprime

- Por número: etiqueta, número visible, nombre verificado, calidad, `platform_type`, `is_on_biz_app`, throughput, estado y estado del nombre.
- Por WABA: límite de mensajería (si Meta lo informa), plantillas por estado, el estado de cada plantilla que espera el producto (`PLANTILLAS_ESTADO_PEDIDO` y `PLANTILLAS_AUTOPILOTO`, ver `docs/PLANTILLAS-WHATSAPP.md`) y si `META_APP_ID` aparece en `subscribed_apps`.
- Al final, un **semáforo** y el código de salida.

## Semáforo y código de salida

| Código | Semáforo | Cuándo |
|---|---|---|
| `0` | verde | Todo en orden. |
| `1` | amarillo | `is_on_biz_app` no es `true` (si se esperaba coexistencia), calidad `YELLOW` o no informada, estado distinto de `CONNECTED`, plantillas esperadas sin aprobar o ausentes, falta `META_APP_ID` o `--waba`, o una lectura falló por 429, 5xx o red (no se pudo verificar). |
| `2` | rojo | Token inválido (Graph 190 o 401; corta la verificación), número o WABA inexistente o sin acceso, app no suscrita, o calidad `RED`. |
| `3` | (uso) | Argumentos inválidos o falta `WHATSAPP_ACCESS_TOKEN`. No llama a Meta. |

## Endpoints que llama (todos `GET`)

Con `https://graph.facebook.com/{versión}`:

| Endpoint | Para qué |
|---|---|
| `/{phone_number_id}?fields=display_phone_number,verified_name,quality_rating,code_verification_status,name_status,status,platform_type,throughput,is_on_biz_app,account_mode` | Estado de cada número |
| `/{waba_id}?fields=name,currency,timezone_id,message_template_namespace,whatsapp_business_manager_messaging_limit` | WABA y límite de mensajería |
| `/{waba_id}/message_templates?fields=name,language,status,category,quality_score&limit=100` | Plantillas (sigue `paging.next`) |
| `/{waba_id}/subscribed_apps` | Apps suscritas |

El lector (`numerosDeWaba`) también sabe consultar `/{waba_id}/phone_numbers`, que este script no usa todavía.

## Pruebas

`npx vitest run packages/whatsapp-gateway --maxWorkers=2` (`tests/meta-graph-reader.spec.ts` y `tests/verificar-meta-whatsapp.spec.ts`).
