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
import { FUNCION_ASINCRONA_MAX_MS, FUNCION_MAX_MS, LEASE_TURNO_ASINCRONO_SEGUNDOS, esperaEfectivaMs, extractMetaInboundMessages, procesarEstadosEntrega, liberarTurnoTrasFalloDeFaseB, extractMetaPhoneNumberId, extractMetaEchoes, registrarEcoDeApp, registrarMotivoNotaDeVoz, LIMITE_NOTAS_POR_ORGANIZACION_DIA, handleInboundWhatsAppMessage, recibirMensajeConEspera, resolveAgentConfig, responderTrasEspera, splitMetaPayloadByChannel, verifyMetaSignature, revocarMarketingPorTelefono } from "@atiende/domain-restaurantes";
import { rateLimit } from "@atiende/core-ratelimit";
import { extractMetaStatuses } from "@atiende/whatsapp-gateway";
import type { EventoEntregaFallida } from "@atiende/domain-restaurantes";
import { emitirNotificacion } from "@atiende/db";
import { constantTimeEqual, requestActor } from "../../../http-security.ts";
import { triggerRestaurantesWhatsAppDispatchInline } from "../../internal/whatsapp-dispatch.ts";
import { triggerRestaurantesEmailDispatchInline } from "./email-dispatch.ts";
import type { AppDeps } from "../../../deps.ts";
import { waitUntilDeVercel } from "../../../en-segundo-plano.ts";
import { barrerTurnosHuerfanosWhatsApp } from "./whatsapp-turnos-huerfanos.ts";
import { ALTA_CONFIRMADA_TEXTO, BAJA_CONFIRMADA_TEXTO, esPalabraBaja, procesarBajaOAlta } from "../../../supresion/index.ts";

const MAX_BODY_BYTES = 256 * 1024;
/** El webhook solo barre un turno huerfano si a su funcion le quedan al menos esto (un turno del agente + cierre). */
const MARGEN_BARRIDO_EN_WEBHOOK_MS = 25_000;

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
    //
    // TURNO ASINCRONO (cerebro v2 o `WHATSAPP_TURNO_ASINCRONO`): TODO mensaje de esa organizacion va por este camino diferido aunque la espera sea 0, y su
    // fase B corre DESPUES del 200 a Meta (`waitUntil` de Vercel) con la vida extendida de la funcion (FUNCION_ASINCRONA_MAX_MS): el turno de Luna por Azure
    // ZDR (2-5 vueltas de 3-6 s) ya no se corta a los 18 s. Sin contexto de Vercel (local, arnes de medicion) la fase B se espera antes de responder, con el
    // mismo presupuesto extendido, para que el arnes lea la respuesta en la misma peticion.
    type Diferido = { organizationId: string; messageId: string; phone: string; phoneNumberId: string; propertyId: string | null; esperaSegundos: number; asincrono: boolean; recibidoEnMs?: number };
    const diferidos: Diferido[] = [];

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
      // Coexistencia: un eco de la app que no se pudo guardar pide reintento de Meta (el wamid vuelve a reclamarse sin duplicar).
      let ecoFallo = false;
      const channelCache = new Map<string, Awaited<ReturnType<typeof repo.resolveWhatsAppChannel>>>();
      // Una lectura de la bandera por organizacion y POST (en savepoint: un error de Postgres no aborta el lote; ante la duda, el camino de siempre).
      const asincronoPorOrg = new Map<string, boolean>();
      const esAsincrono = async (organizationId: string): Promise<boolean> => {
        if (!deps.turnoAsincrono) return false;
        if (!asincronoPorOrg.has(organizationId)) {
          const leer = deps.turnoAsincrono;
          asincronoPorOrg.set(organizationId, await repo.runWithRowSavepoint(() => leer(db, organizationId)).catch(() => false));
        }
        return asincronoPorOrg.get(organizationId) === true;
      };
      for (const batch of splitMetaPayloadByChannel(payload)) {
        if (!batch.phoneNumberId) continue;
        const incomingMessages = extractMetaInboundMessages(batch.payload);
        // Estados de entrega de mensajes SALIENTES (delivered/read/failed): no son mensajes del cliente.
        const estadosEntrega = extractMetaStatuses(batch.payload);
        // Coexistencia (`smb_message_echoes`): lo que el personal contesta desde la app de WhatsApp Business. `history` y `smb_app_state_sync` siguen acusandose sin escribir (PR-14).
        const { ecos } = extractMetaEchoes(batch.payload);
        if (incomingMessages.length === 0 && estadosEntrega.length === 0 && ecos.length === 0) continue;
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
        for (const eco of ecos) {
          // El tenant y la sucursal salen del `phone_number_id` firmado, igual que los mensajes de clientes.
          const resultado = await registrarEcoDeApp(repo, { organizationId, propertyId: channel?.propertyId ?? null, eco, handoffGate: deps.handoffGate?.(db) });
          if (resultado === "fallo") ecoFallo = true;
        }
        // Un webhook solo de statuses (o solo de ecos) no toca el ledger de entrada de clientes ni el turno del agente.
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
          const asincrono = await esAsincrono(organizationId);
          if (esperaSegundos > 0 || asincrono) {
            const recepcion = await recibirMensajeConEspera(repo, {
              organizationId,
              messageId: message.id,
              phone: `+${message.from}`,
              body: message.body,
              ...(transcripcion ? { transcripcion } : {}),
              ...(message.botonId ? { botonId: message.botonId } : {}),
              // El turno de responder debe seguir tomado mientras la funcion larga pueda estar viva.
              ...(asincrono ? { leaseSegundos: LEASE_TURNO_ASINCRONO_SEGUNDOS } : {}),
            });
            if (recepcion.estado === "responder") {
              // Asincrono: la conversacion guarda desde ya la sucursal de entrada. Si el PRIMER turno muere, el barredor de turnos huerfanos (migracion 192)
              // saca de aqui el numero emisor de la sucursal; sin esto solo tendria el numero por defecto de la organizacion. Best-effort en savepoint.
              if (asincrono && channel?.propertyId) {
                const propertyId = channel.propertyId;
                await repo.runWithRowSavepoint(() => repo.whatsappAppendTurn(organizationId, `+${message.from}`, [], null, null, propertyId)).catch(() => undefined);
              }
              diferidos.push({ organizationId, messageId: message.id, phone: `+${message.from}`, phoneNumberId: phoneNumberIdOfBatch, propertyId: channel?.propertyId ?? null, esperaSegundos, asincrono, ...(message.recibidoEnMs !== undefined ? { recibidoEnMs: message.recibidoEnMs } : {}) });
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
            // B03: toque a «Confirmar pedido» / «Cambiar algo» (id atado a un resumen) y cuando lo envio el cliente (ventana de 24 h de los botones).
            ...(message.botonId ? { botonId: message.botonId } : {}),
            ...(message.recibidoEnMs !== undefined ? { recibidoEnMs: message.recibidoEnMs } : {}),
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
        return ecoFallo ? { ack: false as const, hadRetryableFailure: true } : { ack: true as const };
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

      return { ack: false as const, hadRetryableFailure: hadRetryableFailure || ecoFallo };
    });
    if (fase1.ack) return c.json({ ok: true });
    let hadRetryableFailure = fase1.hadRetryableFailure;

    // Fase 2 de la espera de rafagas: despues de la espera (sin transaccion abierta) se responde, en una transaccion nueva, TODO lo que
    // llego a cada telefono durante ella. Devuelve true si algun mensaje quedo para reintento.
    const faseB = async (lista: readonly Diferido[], turnoAsincrono: boolean): Promise<boolean> => {
      const esperar = deps.esperarRafaga ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
      // La espera se recorta para que la fase B (turnos del LLM) todavia quepa en la vida de la funcion; sin tiempo, se responde de inmediato. En modo
      // asincrono se recorta igual (contra los 30 s de siempre): los 30 s extra de la funcion son para el turno, no para esperar mas.
      const esperaMs = esperaEfectivaMs(Math.max(...lista.map((d) => d.esperaSegundos)), (deps.relojMs ?? Date.now)() - inicioMs);
      if (esperaMs > 0) await esperar(esperaMs);
      try {
        return await deps.engine.withAppSession({ userId: null }, async (db) => {
          const repo = deps.restaurantesRepo(db);
          let hayReintento = false;
          for (const d of lista) {
            const outcome = await responderTrasEspera(repo, deps.turnHandler, {
              organizationId: d.organizationId,
              messageId: d.messageId,
              phone: d.phone,
              phoneNumberId: d.phoneNumberId,
              propertyId: d.propertyId,
              ...(deps.privacidadRepo ? { privacy: deps.privacidadRepo(db) } : {}),
              handoffGate: deps.handoffGate?.(db),
              finFuncionMs: inicioMs + (turnoAsincrono ? FUNCION_ASINCRONA_MAX_MS : FUNCION_MAX_MS),
              reloj: deps.relojMs ?? Date.now,
              ...(turnoAsincrono ? { turnoAsincrono: true } : {}),
              ...(d.recibidoEnMs !== undefined ? { recibidoEnMs: d.recibidoEnMs } : {}),
            });
            if (outcome.retryable) hayReintento = true;
          }
          await triggerRestaurantesWhatsAppDispatchInline(deps, db, repo);
          await triggerRestaurantesEmailDispatchInline(deps, db, repo);
          return hayReintento;
        });
      } catch {
        // La transaccion de la fase B no pudo confirmar (su `failed` se revirtio con ella): se suelta el turno que confirmo la fase A para que
        // Meta reintente (o, en modo asincrono, el barredor de turnos huerfanos lo retome) y los mensajes siguientes no se absorban sin respuesta.
        try {
          await deps.engine.withAppSession({ userId: null }, async (db) => {
            const repo = deps.restaurantesRepo(db);
            for (const d of lista) await liberarTurnoTrasFalloDeFaseB(repo, { organizationId: d.organizationId, messageId: d.messageId, phone: d.phone });
          });
        } catch {
          // Sin base no se puede liberar: manda el vencimiento del lease (45 s; 90 s en modo asincrono).
        }
        return true;
      }
    };

    const sincronos = diferidos.filter((d) => !d.asincrono);
    const asincronos = diferidos.filter((d) => d.asincrono);
    if (sincronos.length > 0 && (await faseB(sincronos, false))) hadRetryableFailure = true;
    if (asincronos.length > 0) {
      const enSegundoPlano = deps.enSegundoPlano ?? waitUntilDeVercel();
      const tarea = (async () => {
        // «Escribiendo» + leido al tomar el turno: el cliente ve que se le atiende aunque el turno tarde. Sin await: nunca retrasa ni rompe el turno.
        if (deps.escribiendoWhatsApp) {
          for (const d of asincronos) void deps.escribiendoWhatsApp({ phoneNumberId: d.phoneNumberId, messageId: d.messageId }).catch(() => undefined);
        }
        const reintento = await faseB(asincronos, true);
        // Con tiempo de sobra en la funcion, se recoge UN turno huerfano de esta organizacion (una funcion anterior que murio tras su 200): sin cron,
        // en horas con trafico el huerfano se contesta en segundos. Solo en segundo plano (nunca retrasa la respuesta del arnes local) y best-effort.
        if (enSegundoPlano && (deps.relojMs ?? Date.now)() - inicioMs <= FUNCION_ASINCRONA_MAX_MS - MARGEN_BARRIDO_EN_WEBHOOK_MS) {
          await barrerTurnosHuerfanosWhatsApp(deps, { inicioMs, organizationId: asincronos[0]!.organizationId, limite: 1 }).catch(() => undefined);
        }
        return reintento;
      })();
      if (enSegundoPlano) {
        // Meta ya tiene su 200 (sin reintento): un fallo aqui deja el mensaje `failed` / con el lease vencido y lo retoma el barredor
        // `/internal/restaurantes/whatsapp/turnos-huerfanos`. La promesa nunca rechaza (faseB atrapa todo), pero se blinda igual.
        enSegundoPlano(tarea.catch(() => true));
      } else if (await tarea) {
        // Sin Vercel (local / arnes): mismo contrato que el camino sincrono, Meta (o el arnes) ve el 500 y reintenta.
        hadRetryableFailure = true;
      }
    }

    // Meta reintenta el batch firmado completo ante cualquier respuesta no-2xx. Los
    // mensajes ya procesados quedan idempotentemente saltados por el ledger de
    // entrada; los fallidos/ocupados se pueden reclamar en el reintento.
    return c.json({ ok: !hadRetryableFailure }, hadRetryableFailure ? 500 : 200);
  });

  return app;
}
