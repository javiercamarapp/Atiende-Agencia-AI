// Coexistencia (PR-1): el personal contesta desde la app de WhatsApp Business y Meta reenvia ese mensaje por el campo `smb_message_echoes`.
// Aqui se extrae (defensivo: la forma sale de la documentacion de Meta y del simulador, NO esta probada contra Meta real) y se guarda en el
// hilo de la conversacion como mensaje del asistente con `autor: "humano_app"`, su hora real y su wamid. Nunca toca mensajes de clientes.
import { actorHash } from "../rate-limit.ts";
import type { ConversationMessage, RestaurantesRepository } from "../repository.ts";
import type { HandoffAgentGate } from "../conversaciones/repository.ts";
import { META_TEXT_MAX_CHARS } from "./channel-config.ts";

export interface EcoDeApp {
  /** wamid del mensaje que mando el personal. */
  readonly id: string;
  /** Telefono del cliente (solo digitos, sin `+`). */
  readonly to: string;
  readonly body: string;
  /** Hora real del mensaje en ms; `null` si Meta no la trajo o no es valida. */
  readonly atMs: number | null;
  /** Tipo original de Meta (`text`, `image`...): los que no son texto se guardan como nota honesta. */
  readonly type: string;
}

export interface ExtraccionDeEcos {
  readonly ecos: readonly EcoDeApp[];
  /** Elementos de `message_echoes` que no se pudieron leer (forma desconocida): se cuentan, nunca hacen fallar el webhook. */
  readonly descartados: number;
}

const NOTA_ARCHIVO = (tipo: string): string => `[El personal envió un mensaje de tipo «${tipo}» desde la app de WhatsApp Business; su contenido no se guarda aquí.]`;

function ms(raw: unknown): number | null {
  const n = typeof raw === "string" ? Number(raw) : typeof raw === "number" ? raw : NaN;
  return Number.isFinite(n) && n > 0 ? n * 1000 : null;
}

/** Lee los ecos (`field: "smb_message_echoes"`, `value.message_echoes[]`) de UN payload (normalmente un lote ya separado por numero). Orden del payload. */
export function extractMetaEchoes(payload: unknown): ExtraccionDeEcos {
  const ecos: EcoDeApp[] = [];
  let descartados = 0;
  const entries = (payload as { entry?: unknown } | null)?.entry;
  if (!Array.isArray(entries)) return { ecos, descartados };
  for (const entry of entries) {
    const changes = (entry as { changes?: unknown } | null)?.changes;
    if (!Array.isArray(changes)) continue;
    for (const change of changes) {
      const c = change as { field?: unknown; value?: { message_echoes?: unknown } } | null;
      if (c?.field !== "smb_message_echoes") continue;
      const lista = c.value?.message_echoes;
      if (!Array.isArray(lista)) continue;
      for (const candidate of lista) {
        const m = (candidate ?? null) as { id?: unknown; to?: unknown; type?: unknown; timestamp?: unknown; text?: { body?: unknown } } | null;
        if (!m || typeof m !== "object" || typeof m.id !== "string" || m.id.length < 1 || m.id.length > 255 || typeof m.to !== "string" || !/^\d{7,20}$/.test(m.to)) {
          descartados += 1;
          continue;
        }
        const type = typeof m.type === "string" && m.type.length > 0 && m.type.length <= 40 ? m.type : "desconocido";
        if (type === "text") {
          const body = m.text?.body;
          if (typeof body !== "string" || body.trim().length < 1 || body.length > META_TEXT_MAX_CHARS) {
            descartados += 1;
            continue;
          }
          ecos.push({ id: m.id, to: m.to, body, atMs: ms(m.timestamp), type });
        } else {
          ecos.push({ id: m.id, to: m.to, body: NOTA_ARCHIVO(type), atMs: ms(m.timestamp), type });
        }
      }
    }
  }
  return { ecos, descartados };
}

export type ResultadoEco = "guardado" | "duplicado" | "fallo";

/**
 * Guarda UN eco en el hilo. Idempotente por wamid (reusa el ledger de eventos entrantes: un wamid ya procesado o en curso no se repite, y uno
 * de otra organizacion nunca coincide). La conversacion se crea si el personal le escribio primero a un cliente nuevo.
 * `gate` (opcional, PR-2): si lo implementa, el eco ademas calla al asistente en esa conversacion.
 */
export async function registrarEcoDeApp(
  repo: RestaurantesRepository,
  args: { readonly organizationId: string; readonly propertyId: string | null; readonly eco: EcoDeApp; readonly handoffGate?: HandoffAgentGate; readonly ahoraMs?: () => number },
): Promise<ResultadoEco> {
  const { organizationId, propertyId, eco } = args;
  const phone = `+${eco.to}`;
  const phoneHash = actorHash(phone);
  if (!(await repo.claimWhatsAppMessage(organizationId, eco.id, phoneHash))) return "duplicado";
  try {
    const atMs = eco.atMs ?? (args.ahoraMs ?? Date.now)();
    const mensaje: ConversationMessage = { role: "assistant", content: eco.body, autor: "humano_app", wamid: eco.id, at: new Date(atMs).toISOString() };
    await repo.runWithRowSavepoint(async () => {
      await repo.whatsappAppendTurn(organizationId, phone, [mensaje], null, null, propertyId);
    });
    await repo.finishWhatsAppMessage(organizationId, eco.id, phoneHash, "processed", null);
    return "guardado";
  } catch {
    try {
      await repo.markInboundEventFailed(organizationId, eco.id, "EcoAppFallo");
    } catch {
      // el lease del ledger vence solo
    }
    return "fallo";
  }
}
