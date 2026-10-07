// GET|POST /v1/restaurantes/whatsapp/webhook — port de
// restaurantes/supabase/functions/whatsapp-webhook/index.ts. Sin authMiddleware, sin
// Supabase Auth de usuario: verificación propia por firma HMAC (X-Hub-Signature-256)
// sobre los BYTES CRUDOS del body (ver diseño Fase 1 §4.3b).
//
// CRÍTICO (detalle real que causó bugs reales, según la investigación de patrones):
// esta ruta lee el body con `c.req.raw.arrayBuffer()`, NUNCA `.text()`/`.json()` de
// Hono ni ningún middleware de parseo de JSON montado antes — si algo ya consumió el
// stream del Request, la verificación HMAC falla en falso (o peor, valida un body
// distinto del que Meta realmente firmó). Por eso apps/api/src/app.ts monta este
// sub-Hono ANTES/SIN heredar ningún middleware global de body-parsing, y este archivo
// nunca importa ni usa `c.req.json()`.
import { Hono } from "hono";
import { FUNCION_MAX_MS, esperaEfectivaMs, extractMetaInboundMessages, procesarEstadosEntrega, liberarTurnoTrasFalloDeFaseB, extractMetaPhoneNumberId, registrarMotivoNotaDeVoz, LIMITE_NOTAS_POR_ORGANIZACION_DIA, handleInboundWhatsAppMessage, recibirMensajeConEspera, resolveAgentConfig, responderTrasEspera, splitMetaPayloadByChannel, verifyMetaSignature, revocarMarketingPorTelefono } from "@atiende/domain-restaurantes";
import { rateLimit } from "@atiende/core-ratelimit";
import { extractMetaStatuses } from "@atiende/whatsapp-gateway";
import type { EventoEntregaFallida } from "@atiende/domain-restaurantes";
import { emitirNotificacion } from "@atiende/db";
import { constantTimeEqual, requestActor } from "../../../http-security.ts";
import { triggerRestaurantesWhatsAppDispatchInline } from "../../internal/whatsapp-dispatch.ts";
import { triggerRestaurantesEmailDispatchInline } from "./email-dispatch.ts";
import type { AppDeps } from "../../../deps.ts";
import { ALTA_CONFIRMADA_TEXTO, BAJA_CONFIRMADA_TEXTO, esPalabraBaja, procesarBajaOAlta } from "../../../supresion/index.ts";

const MAX_BODY_BYTES = 256 * 1024;

/** Dia calendario (America/Merida) para la clave de dedupe de la notificacion de tope. */
const diaMerida = (): string => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Merida", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

// Hallazgo de auditoría (ALTO, "packages/core-ratelimit cataloga la categoría
// 'conversation:inbound-webhook' -- ABIERTA (degrada a memoria, nunca a cero) ver
// endpoint-policy.ts -- pero ningún webhook real la invocaba"). La firma HMAC ya
// garantiza que el remitente es Meta real -- este límite es la segunda línea que la
// propia fila de la tabla documenta: acotar la ráfaga de procesamiento (turn handler
// -> LLM -> outbox) por número de WhatsApp de esta organización, nunca dejarla sin
// tope. Ante negativa, 429 (no 200 silencioso ni 5xx) -- Meta reintenta con 429 igual
// que con 5xx.
const INBOUND_WEBHOOK_RATE_LIMIT = { max: 120, windowMs: 60_000 } as const;

/** Eventos del catalogo de notificaciones que este webhook produce cuando Meta reporta una entrega fallida (`statuses[].status = "failed"`).
 *  Sin PII: solo un codigo de motivo o un conteo. El catalogo y docs/NOTIFICACIONES.md los listan como conectados a ESTE archivo. */
const EVENTOS_ENTREGA_FALLIDA = [
  "restaurantes.whatsapp.entrega_fallida_pedido",
  "restaurantes.whatsapp.entrega_fallida",
  "restaurantes.whatsapp.entregas_fallidas_varias",
] as const satisfies readonly EventoEntregaFallida[];

export function restaurantesWhatsAppRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  // Handshake de verificación real de Meta: GET con
  // hub.mode/hub.verify_token/hub.challenge.
  app.get("/v1/restaurantes/whatsapp/webhook", (c) => {
    const mode = c.req.query("hub.mode");
    const token = c.req.query("hub.verify_token");
    const challenge = c.req.query("hub.challenge");
    if (mode === "subscribe" && constantTimeEqual(token ?? null, deps.env.whatsappVerifyToken)) {
      return c.text(challenge ?? "");
    }
    return c.text("Forbidden", 403);
  });

  app.post("/v1/restaurantes/whatsapp/webhook", async (c) => {
    // El reloj del presupuesto de 30 s arranca al entrar al handler: la lectura del body y la verificacion de firma ya cuentan.
    const inicioMs = (deps.relojMs ?? Date.now)();
    const declaredLength = Number(c.req.header("content-length") ?? 0);
    if (!Number.isFinite(declaredLength) || declaredLength < 0 || declaredLength > MAX_BODY_BYTES) {
      return c.text("Payload too large", 413);
    }
    const rawBody = new Uint8Array(await c.req.raw.arrayBuffer());
    if (rawBody.byteLength > MAX_BODY_BYTES) return c.text("Payload too large", 413);

    if (!deps.env.whatsappAppSecret) return c.text("Webhook not configured", 503);
    if (!(await verifyMetaSignature(rawBody, c.req.header("x-hub-signature-256") ?? null, deps.env.whatsappAppSecret))) {
      return c.text("Invalid signature", 401);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder().decode(rawBody));
    } catch {
      return c.text("Invalid JSON", 400);
    }

    const phoneNumberId = extractMetaPhoneNumberId(payload);

    // Hallazgo de auditoría (ALTO) — ver comentario de cabecera del archivo.
    // Evaluado DESPUÉS de verificar la firma (para no gastar cupo en tráfico que ni
    // siquiera prueba ser de Meta) pero ANTES de abrir sesión de base de datos.
    const inboundAllowed = await rateLimit(
      `conversation:inbound-webhook:${requestActor(c.req.raw, phoneNumberId ?? "sin-numero")}`,
      INBOUND_WEBHOOK_RATE_LIMIT.max,
      INBOUND_WEBHOOK_RATE_LIMIT.windowMs,
      { category: "conversation:inbound-webhook" },
    );
    if (!inboundAllowed) return c.text("Too Many Requests", 429);

    // PM-C5 (espera de rafagas): los mensajes de un telefono con `replyDebounceSeconds` > 0 se reciben en una transaccion que SE CONFIRMA, el
    // webhook espera SIN transaccion abierta y recien entonces responde todo junto en otra transaccion. Con la espera apagada (lo normal)
    // este arreglo queda vacio y el camino es exactamente el de antes.
    const diferidos: Array<{ organizationId: string; messageId: string; phone: string; phoneNumberId: string; propertyId: string | null; esperaSegundos: number }> = [];

    // Webhook público/de sistema, sin authMiddleware/dbSession -- abre su propia
    // sesión de sistema (`userId: null`), igual que public.ts/voice-tools.ts.
    const fase1 = await deps.engine.withAppSession({ userId: null }, async (db) => {
      const repo = deps.restaurantesRepo(db);
      // Modelo PM: un numero de WhatsApp por sucursal. `resolveWhatsAppChannel` devuelve la
      // organizacion y, si el numero pertenece a una sucursal, esa sucursal; contra una base
      // sin la migracion 023 cae al numero por defecto de la organizacion (mismo
      // comportamiento de antes).
      //
      // Un POST firmado puede traer varios `changes`, cada uno con SU phone_number_id: cada
      // mensaje se rutea con el numero que lo recibio (nunca con el del primer change). Un change
      // sin numero o con numero desconocido se acusa en silencio sin arrastrar sus mensajes a otro tenant.
      let hadRetryableFailure = false;
      let processedAny = false;
      // Correos de respaldo encolados por entregas fallidas (el WhatsApp no llego): se despachan al final aunque el webhook solo traiga statuses.
      let correosDeRespaldo = 0;
      const channelCache = new Map<string, Awaited<ReturnType<typeof repo.resolveWhatsAppChannel>>>();
      for (const batch of splitMetaPayloadByChannel(payload)) {
        if (!batch.phoneNumberId) continue;
        const incomingMessages = extractMetaInboundMessages(batch.payload);
        // Estados de entrega de mensajes SALIENTES (delivered/read/failed): no son mensajes del cliente.
        const estadosEntrega = extractMetaStatuses(batch.payload);
        if (incomingMessages.length === 0 && estadosEntrega.length === 0) continue;
        if (!channelCache.has(batch.phoneNumberId)) channelCache.set(batch.phoneNumberId, await repo.resolveWhatsAppChannel(batch.phoneNumberId));
        const channel = channelCache.get(batch.phoneNumberId) ?? null;
        const organizationId = channel?.organizationId ?? null;
        // Número no configurado en la plataforma: ack silencioso, no reintento (tambien para sus statuses: ningun wamid ajeno se procesa).
        if (!organizationId) continue;
        if (estadosEntrega.length > 0) {
          // El tenant sale del `phone_number_id` firmado: un wamid de otra organizacion nunca coincide. Un fallo aqui jamas cambia la respuesta a Meta.
          const resumen = await procesarEstadosEntrega(
            repo,
            organizationId,
            estadosEntrega.map((e) => ({ wamid: e.wamid, status: e.status, errorCode: e.errorCode, errorTitle: e.errorTitle })),
            {
              emitir: async (e) => {
                if (!EVENTOS_ENTREGA_FALLIDA.includes(e.evento)) return;
                await emitirNotificacion(db, { evento: e.evento, organizationId: e.organizationId, clave: e.clave, parametros: e.parametros, entidadTipo: e.entidadTipo ?? null, entidadId: e.entidadId ?? null });
              },
            },
          );
          correosDeRespaldo += resumen.correosEncolados;
        }
        // Un webhook solo de statuses no toca el ledger de entrada ni el turno del agente.
        if (incomingMessages.length === 0) continue;
        processedAny = true;
        const phoneNumberIdOfBatch = batch.phoneNumberId;

        for (const message of incomingMessages) {
          // R-32: nota de voz. Con el puerto (token de Meta + gateway LLM) se transcribe DESPUES de reclamar el mensaje (ver domain-restaurantes
          // whatsapp/nota-de-voz.ts); sin puerto se conserva la nota que pide escribir y se registra el motivo (sin PII).
          if (message.audio && !deps.notasDeVoz) registrarMotivoNotaDeVoz("no_configurado", organizationId);
          // Tope diario de la organizacion alcanzado -> notificacion in-app (catalogo `restaurantes.voz.tope_notas_alcanzado`): una por dia, sin PII.
          // `emitirNotificacion` corre en SAVEPOINT: nunca aborta la transaccion del webhook ni cambia la respuesta a Meta.
          const transcripcion = message.audio && deps.notasDeVoz
            ? {
                audio: message.audio,
                puerto: deps.notasDeVoz,
                alTopeDeOrganizacion: async () => {
                  await emitirNotificacion(db, { evento: "restaurantes.voz.tope_notas_alcanzado", organizationId, clave: diaMerida(), parametros: { cantidad: LIMITE_NOTAS_POR_ORGANIZACION_DIA } });
                },
              }
            : undefined;
          // Autopiloto 2: BAJA / ALTO tambien REVOCA el consentimiento de marketing de ese telefono en esta organizacion y mata los mensajes de campana
          // aun pendientes (la lista de supresion de plataforma, de abajo, ya los frena en el despachador). Best-effort con SAVEPOINT: base sin la 052 ->
          // no hace nada; nunca altera el turno ni la respuesta a Meta.
          if (esPalabraBaja(message.body)) await revocarMarketingPorTelefono(db, organizationId, `+${message.from}`);
          // SA-L-46: BAJA / STOP -> lista de supresion de plataforma + UNA confirmacion; PL-32: ALTA la reactiva. No pasa al agente.
          const atendida = await procesarBajaOAlta(db, {
            telefono: `+${message.from}`,
            texto: message.body,
            origen: "whatsapp.restaurantes",
            organizationId,
            confirmarBaja: () =>
              repo.enqueueMessagingOutbox(organizationId, "whatsapp", "whatsapp.baja_confirmada", `baja-confirmada:${message.id}`, { to: `+${message.from}`, phone_number_id: phoneNumberIdOfBatch, body: BAJA_CONFIRMADA_TEXTO, transaccional: true }),
            confirmarAlta: () =>
              repo.enqueueMessagingOutbox(organizationId, "whatsapp", "whatsapp.alta_confirmada", `alta-confirmada:${message.id}`, { to: `+${message.from}`, phone_number_id: phoneNumberIdOfBatch, body: ALTA_CONFIRMADA_TEXTO, transaccional: true }),
          });
          if (atendida) continue;
          // La lectura de la config va en savepoint: un error de Postgres aqui no aborta la transaccion del lote ni lo tumba con 500; solo ese mensaje
          // cae al camino sin espera (el de siempre).
          const esperaSegundos = await repo
            .runWithRowSavepoint(async () => (await resolveAgentConfig(repo, organizationId, channel?.propertyId ?? null)).replyDebounceSeconds ?? 0)
            .catch(() => 0);
          if (esperaSegundos > 0) {
            const recepcion = await recibirMensajeConEspera(repo, { organizationId, messageId: message.id, phone: `+${message.from}`, body: message.body, ...(transcripcion ? { transcripcion } : {}) });
            if (recepcion.estado === "responder") {
              diferidos.push({ organizationId, messageId: message.id, phone: `+${message.from}`, phoneNumberId: phoneNumberIdOfBatch, propertyId: channel?.propertyId ?? null, esperaSegundos });
            } else if (recepcion.estado === "fallo") {
              hadRetryableFailure = true;
            }
            continue;
          }
          const outcome = await handleInboundWhatsAppMessage(repo, deps.turnHandler, {
            organizationId,
            messageId: message.id,
            phone: `+${message.from}`,
            body: message.body,
            ...(transcripcion ? { transcripcion } : {}),
            phoneNumberId: phoneNumberIdOfBatch,
            propertyId: channel?.propertyId ?? null,
            // PM PR-9: aviso de privacidad en el primer mensaje + fast-path ARCO (opcional en tests).
            ...(deps.privacidadRepo ? { privacy: deps.privacidadRepo(db) } : {}),
            // R-21: con una toma de handoff abierta el agente calla; sin la migración 028 el gate devuelve null.
            handoffGate: deps.handoffGate?.(db),
          });
        // El envío real de `outcome.reply` vía Graph API ya no vive fuera de fase:
        // `handleInboundWhatsAppMessage` lo encola en `restaurantes.messaging_outbox`
        // (ver whatsapp/inbound.ts) y `POST /internal/whatsapp/dispatch`
        // (@atiende/whatsapp-gateway::WhatsAppOutboundDispatcher) lo drena de
        // verdad vía Graph API.
        //
        // Fase 2 (integridad) — tope de reintentos (`migrations/
        // 020_whatsapp_retry_cap.sql`): un mensaje que agotó `MAX_WHATSAPP_ATTEMPTS`
        // ya no lo reclama `claimWhatsAppMessage` (`restaurantes.
        // claim_whatsapp_message` lo transiciona a `attempts_exhausted`) --
        // `outcome.retryable` viene `false` para ese caso EXACTAMENTE igual que para
        // un mensaje ya `'processed'` (`handleInboundWhatsAppMessage` corta con
        // `claimed = false` antes de tocar `turnHandler`), así que este loop ya
        // responde 200 a Meta sin ningún cambio aquí -- Meta deja de reintentar, sin
        // volver a gastar ningún turno de LLM.
        if (outcome.retryable) hadRetryableFailure = true;
        }
      }
      // Nada que procesar (sin mensajes de texto validos o ningun numero reconocido): ack silencioso.
      if (!processedAny) {
        if (correosDeRespaldo > 0) await triggerRestaurantesEmailDispatchInline(deps, db, repo);
        return { ack: true as const };
      }

      // Cluster #3 (CRÍTICO) de la auditoría final — mismo disparo inline
      // best-effort que citas/whatsapp.ts, ver comentario de cabecera de
      // whatsapp-dispatch.ts. También cubre el caso real de que el turno del
      // agente haya creado un pedido dentro de ESTA misma conversación
      // (llm-turn-handler.ts::createOrder), que además de la respuesta de texto
      // puede encolar una confirmación por correo — ver
      // triggerRestaurantesEmailDispatchInline en email-dispatch.ts.
      await triggerRestaurantesWhatsAppDispatchInline(deps, db, repo);
      await triggerRestaurantesEmailDispatchInline(deps, db, repo);

      return { ack: false as const, hadRetryableFailure };
    });
    if (fase1.ack) return c.json({ ok: true });
    let hadRetryableFailure = fase1.hadRetryableFailure;

    // Fase 2 de la espera de rafagas: despues de la espera (sin transaccion abierta) se responde, en una transaccion nueva, TODO lo que
    // llego a cada telefono durante ella.
    if (diferidos.length > 0) {
      const esperar = deps.esperarRafaga ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
      // La espera se recorta para que la fase B (turnos del LLM) todavia quepa en la vida de la funcion; sin tiempo, se responde de inmediato.
      const esperaMs = esperaEfectivaMs(Math.max(...diferidos.map((d) => d.esperaSegundos)), (deps.relojMs ?? Date.now)() - inicioMs);
      if (esperaMs > 0) await esperar(esperaMs);
      try {
        const reintento = await deps.engine.withAppSession({ userId: null }, async (db) => {
          const repo = deps.restaurantesRepo(db);
          let hayReintento = false;
          for (const d of diferidos) {
            const outcome = await responderTrasEspera(repo, deps.turnHandler, {
              organizationId: d.organizationId,
              messageId: d.messageId,
              phone: d.phone,
              phoneNumberId: d.phoneNumberId,
              propertyId: d.propertyId,
              ...(deps.privacidadRepo ? { privacy: deps.privacidadRepo(db) } : {}),
              handoffGate: deps.handoffGate?.(db),
              finFuncionMs: inicioMs + FUNCION_MAX_MS,
              reloj: deps.relojMs ?? Date.now,
            });
            if (outcome.retryable) hayReintento = true;
          }
          await triggerRestaurantesWhatsAppDispatchInline(deps, db, repo);
          await triggerRestaurantesEmailDispatchInline(deps, db, repo);
          return hayReintento;
        });
        if (reintento) hadRetryableFailure = true;
      } catch {
        // La transaccion de la fase B no pudo confirmar (su `failed` se revirtio con ella): se suelta el turno que confirmo la fase A para que
        // Meta reintente y los mensajes siguientes no se absorban sin respuesta.
        hadRetryableFailure = true;
        try {
          await deps.engine.withAppSession({ userId: null }, async (db) => {
            const repo = deps.restaurantesRepo(db);
            for (const d of diferidos) await liberarTurnoTrasFalloDeFaseB(repo, { organizationId: d.organizationId, messageId: d.messageId, phone: d.phone });
          });
        } catch {
          // Sin base no se puede liberar: manda el vencimiento del lease (45 s).
        }
      }
    }

    // Meta reintenta el batch firmado completo ante cualquier respuesta no-2xx. Los
    // mensajes ya procesados quedan idempotentemente saltados por el ledger de
    // entrada; los fallidos/ocupados se pueden reclamar en el reintento.
    return c.json({ ok: !hadRetryableFailure }, hadRetryableFailure ? 500 : 200);
  });

  return app;
}
