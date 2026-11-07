// Adaptador de VOZ sobre el turno de WhatsApp de restaurantes (`createLlmWhatsAppTurnHandler`), SIN tocar el handler:
//  - gateway: agrega el bloque de sistema de la llamada al final del prompt y exige retencion cero (ZDR) en toda llamada al modelo;
//  - repositorio: los pedidos salen con `source: "voice"`, la maquina de estados del pedido usa la llave de la LLAMADA (`call:<id>`, la forma que
//    la migracion 026 reserva para voz) en lugar de la del chat de WhatsApp del mismo numero (`wa:<telefono>`), y los contadores del agente (que
//    viven en la conversacion de WhatsApp de ese numero) no se tocan: el turno cuenta en local;
//  - agente: convierte el hilo de la llamada al historial del handler y devuelve solo lo que el turno de voz necesita.
// Lo que el handler sigue haciendo como canal «whatsapp» (no lo cambia un adaptador sin editar el handler): ver HUECOS_CANAL_VOZ en index.ts.
import type { LlmGateway } from "@atiende/agent-core";
import { lookupCustomerConPedidoReciente } from "../../customers.ts";
import type { ConversationMessage, NewOrderRecord, RestaurantesRepository } from "../../repository.ts";
import type { WhatsAppTurnHandler } from "../../whatsapp/turn-handler.ts";
import { BLOQUE_CANAL_VOZ } from "./texto.ts";
import type { AgenteVoz } from "./turno.ts";

type OpcionesLlamada = Parameters<LlmGateway["complete"]>[0];

/**
 * Gateway para el turno de voz: misma instancia (escaleras, topes, registro de uso, circuit breaker), con el bloque de la llamada al final del
 * sistema y `zdrEstricto` siempre (la ruta solo atiende organizaciones con cerebro v2; sin escalera ZDR la llamada falla cerrada).
 */
export function gatewayDeVoz(base: LlmGateway, bloque: string = BLOQUE_CANAL_VOZ): LlmGateway {
  const envoltura = Object.create(base) as LlmGateway;
  envoltura.complete = (opts: OpcionesLlamada) =>
    base.complete({ ...opts, zdrEstricto: true, request: { ...opts.request, system: `${opts.request.system}\n\n${bloque}` } });
  return envoltura;
}

/** Repositorio para el turno de voz de UNA llamada (ver cabecera). Todo lo demas pasa tal cual a la instancia real. */
export function repoDeVoz(base: RestaurantesRepository, llamada: { readonly telefono: string; readonly callId: string }): RestaurantesRepository {
  const llaveChat = `wa:${llamada.telefono}`;
  const llaveLlamada = `call:${llamada.callId}`;
  const llave = (k: string): string => (k === llaveChat ? llaveLlamada : k);
  const reemplazos: Partial<RestaurantesRepository> = {
    createOrderIdempotent: (order: NewOrderRecord, fingerprint: string, idempotencyKey: string | null) =>
      base.createOrderIdempotent(order.source === "whatsapp" ? { ...order, source: "voice" } : order, fingerprint, idempotencyKey),
    readOrderFlow: (organizationId, flowKey) => base.readOrderFlow(organizationId, llave(flowKey)),
    writeOrderFlow: (organizationId, flowKey, expectedVersion, next, ttlSeconds) => base.writeOrderFlow(organizationId, llave(flowKey), expectedVersion, next, ttlSeconds),
    // null = «no hay donde contar»: el handler usa la cuenta local del turno y no escribe en la conversacion de WhatsApp de ese numero.
    contadorAgenteWhatsApp: async () => null,
  };
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && prop in reemplazos) return reemplazos[prop as keyof RestaurantesRepository];
      const v = Reflect.get(target, prop, receiver) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

/** El turno del agente de voz a partir del handler de WhatsApp de restaurantes (ya construido con `gatewayDeVoz` y `repoDeVoz`). */
export function agenteDeVoz(handler: WhatsAppTurnHandler, repo: RestaurantesRepository, ctx: { readonly organizationId: string; readonly propertyId: string | null; readonly finTurnoMs?: number }): AgenteVoz {
  return async ({ mensajes, telefono, callId, turno }) => {
    const historial: ConversationMessage[] = mensajes.flatMap((m) => (m.role === "user" || m.role === "assistant" ? [{ role: m.role, content: m.content }] : []));
    const r = await handler.handleInboundMessage({
      organizationId: ctx.organizationId,
      phone: telefono,
      messages: historial,
      customer: await lookupCustomerConPedidoReciente(repo, ctx.organizationId, telefono),
      propertyId: ctx.propertyId,
      // Idempotencia de avisos al equipo ante reintentos del mismo turno.
      messageId: `voz:${callId}:${turno}`,
      ...(ctx.finTurnoMs !== undefined ? { finTurnoMs: ctx.finTurnoMs } : {}),
    });
    return { reply: r.reply, orderId: r.orderId };
  };
}
