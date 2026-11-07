// Barredor de turnos HUERFANOS del turno asincrono de WhatsApp (cerebro v2). Con el turno asincrono Meta recibe su 200 al terminar la fase A, asi que si
// la funcion muere (timeout, crash) o la fase B falla, Meta ya no reintenta y el cliente se quedaria sin respuesta hasta volver a escribir. Aqui:
//   1. `reclamarTurnosHuerfanos`: la migracion 192 reclama de forma atomica (SKIP LOCKED) los mensajes 'processing' con el lease vencido (> 90 s) o 'failed'
//      reintentables de los ultimos 10 min y devuelve telefono y numero emisor. Sin la 192 (base sin migrar) -> null, nada que hacer.
//   2. `retomarTurnoHuerfano`: toma el turno de conversacion (lease largo) y corre `responderTrasEspera`, que relee el historial y contesta SOLO lo
//      pendiente: si alguien ya contesto (otro mensaje tomo el turno) no hay pendientes y solo marca el mensaje procesado. Nunca contesta dos veces.
// Un pedido que el turno muerto alcanzo a crear no se duplica: crear_pedido con cerebro v2 es idempotente por mensaje de Meta (orders.ts).
import { runWithSavepointFallback } from "@atiende/db";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { actorHash } from "../rate-limit.ts";
import type { RestaurantesRepository } from "../repository.ts";
import type { PrivacidadRepository } from "../privacidad/repository.ts";
import type { HandoffAgentGate } from "../conversaciones/repository.ts";
import type { WhatsAppTurnHandler } from "./turn-handler.ts";
import { FUNCION_ASINCRONA_MAX_MS, LEASE_TURNO_ASINCRONO_SEGUNDOS, responderTrasEspera, type InboundMessageOutcome } from "./inbound.ts";

export interface TurnoHuerfano {
  readonly organizationId: string;
  readonly messageId: string;
  /** Telefono del cliente (de la conversacion de la misma organizacion); null = no se encontro la conversacion. */
  readonly phone: string | null;
  readonly propertyId: string | null;
  /** Numero emisor: el de la sucursal de la conversacion o el de la organizacion; null = sin numero configurado. */
  readonly phoneNumberId: string | null;
}

/** Clase de fallo de un huerfano sin conversacion o sin numero: la 192 lo excluye del siguiente barrido (no tiene arreglo reintentando). */
export const CLASE_HUERFANO_SIN_CONVERSACION = "HuerfanoSinConversacion";
/** Clase de fallo cuando otro dueno tiene el turno de la conversacion: el siguiente barrido lo vuelve a intentar (si ese dueno contesto, no habra pendientes). */
export const CLASE_HUERFANO_TURNO_OCUPADO = "HuerfanoTurnoOcupado";
/** Huerfanos por barrido: cada uno puede ser un turno de hasta ~54 s y corren en paralelo dentro de la misma funcion de 60 s. */
export const HUERFANOS_POR_BARRIDO = 3;

const codigo = (err: unknown): string | undefined => (err && typeof err === "object" && "code" in err ? ((err as { code?: unknown }).code as string | undefined) : undefined);
const sinLaMigracion192 = (err: unknown): boolean => ["42883", "42P01", "42703"].includes(codigo(err) ?? "");

/** Reclama (y marca 'processing') hasta `limite` turnos huerfanos. `organizationId` acota a una organizacion; `todas` incluye a las que no tienen cerebro v2
 * (`WHATSAPP_TURNO_ASINCRONO`). null = la base no tiene la 192 (el barredor no esta disponible). Corre en SAVEPOINT: nunca aborta la transaccion de quien llama. */
export async function reclamarTurnosHuerfanos(db: TenantDbSession, opts: { readonly organizationId?: string | null; readonly todas: boolean; readonly limite: number }): Promise<readonly TurnoHuerfano[] | null> {
  return runWithSavepointFallback<readonly TurnoHuerfano[] | null>({
    session: db,
    savepointName: "sp_reclamar_turnos_whatsapp_huerfanos",
    primary: async () => {
      const { rows } = await db.query<{ organization_id: string; message_id: string; phone: string | null; property_id: string | null; phone_number_id: string | null }>(
        `select organization_id, message_id, phone, property_id, phone_number_id from restaurantes.reclamar_turnos_whatsapp_huerfanos($1, $2, $3);`,
        [opts.organizationId ?? null, opts.todas, opts.limite],
      );
      return rows.map((r) => ({ organizationId: r.organization_id, messageId: r.message_id, phone: r.phone, propertyId: r.property_id, phoneNumberId: r.phone_number_id }));
    },
    isRecoverable: sinLaMigracion192,
    fallback: async () => null,
  });
}

/**
 * Re-ejecuta UN turno huerfano ya reclamado. Toma el turno de conversacion con el lease largo; si otro dueno lo tiene, el mensaje queda `failed`
 * (`HuerfanoTurnoOcupado`) para el siguiente barrido. Sin telefono o sin numero emisor no hay a quien contestar: `failed` con una clase que la 192 ya no
 * vuelve a tomar.
 */
export async function retomarTurnoHuerfano(
  repo: RestaurantesRepository,
  turnHandler: WhatsAppTurnHandler,
  h: TurnoHuerfano,
  extras: { readonly inicioMs: number; readonly reloj?: () => number; readonly privacy?: PrivacidadRepository; readonly handoffGate?: HandoffAgentGate },
): Promise<InboundMessageOutcome> {
  if (!h.phone || !h.phoneNumberId) {
    // Sin telefono no hay hash con que soltar un lease; solo se marca el mensaje.
    await repo.finishWhatsAppMessage(h.organizationId, h.messageId, actorHash(h.phone ?? ""), "failed", CLASE_HUERFANO_SIN_CONVERSACION);
    return { ok: false, retryable: false };
  }
  const phoneHash = actorHash(h.phone);
  if (!(await repo.claimWhatsAppConversation(h.organizationId, phoneHash, h.messageId, LEASE_TURNO_ASINCRONO_SEGUNDOS))) {
    await repo.finishWhatsAppMessage(h.organizationId, h.messageId, phoneHash, "failed", CLASE_HUERFANO_TURNO_OCUPADO);
    return { ok: false, retryable: true };
  }
  return responderTrasEspera(repo, turnHandler, {
    organizationId: h.organizationId,
    messageId: h.messageId,
    phone: h.phone,
    phoneNumberId: h.phoneNumberId,
    propertyId: h.propertyId,
    ...(extras.privacy ? { privacy: extras.privacy } : {}),
    ...(extras.handoffGate ? { handoffGate: extras.handoffGate } : {}),
    finFuncionMs: extras.inicioMs + FUNCION_ASINCRONA_MAX_MS,
    reloj: extras.reloj ?? Date.now,
    turnoAsincrono: true,
  });
}
