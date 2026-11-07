// Coexistencia (PR-1/PR-2): el personal contesta desde la app de WhatsApp Business y Meta reenvia ese mensaje por el campo `smb_message_echoes`.
// Aqui se extrae (defensivo: la forma sale de la documentacion de Meta y del simulador, NO esta probada contra Meta real) y se guarda en el hilo
// de la conversacion como mensaje del asistente con `autor: "humano_app"`, su hora real y su wamid. Nunca toca mensajes de clientes.
//
// Reglas (revision independiente):
//  * Un eco de lo que mando la PROPIA plataforma (asistente, acuse, plantilla, respuesta del panel) se descarta: su wamid ya esta en el outbox enviado.
//  * Un eco NUNCA crea la conversacion ni toca `updated_at`/`property_id` (ancla de la ventana de 24 h, KPIs): sin conversacion se acusa y se cuenta como descartado.
//  * Un error real (no «no aplica») devuelve `fallo` para que Meta reintente; el reintento es idempotente (wamid).
//  * La hora real de Meta solo se guarda en `at`; para el silencio se acota a [ahora - 5 min, ahora + 1 min].
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

/** Margen del instante de silencio respecto del reloj del servidor. */
export const ECO_SILENCIO_MAX_ANTIGUEDAD_MS = 5 * 60_000;
export const ECO_SILENCIO_MAX_ADELANTO_MS = 60_000;

const NOTA_ARCHIVO = (tipo: string): string => `[El personal envió un mensaje de tipo «${tipo}» desde la app de WhatsApp Business; su contenido no se guarda aquí.]`;

/** Un NUL (\u0000) hace fallar jsonb de Postgres (500 hasta agotar reintentos): se quita antes de guardar. */
export const sanearTexto = (t: string): string => t.split("\u0000").join("");

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
          if (typeof body !== "string" || sanearTexto(body).trim().length < 1 || body.length > META_TEXT_MAX_CHARS) {
            descartados += 1;
            continue;
          }
          ecos.push({ id: m.id, to: m.to, body: sanearTexto(body), atMs: ms(m.timestamp), type });
        } else {
          ecos.push({ id: m.id, to: m.to, body: NOTA_ARCHIVO(sanearTexto(type)), atMs: ms(m.timestamp), type });
        }
      }
    }
  }
  return { ecos, descartados };
}

/**
 * `guardado` = quedo en el hilo; `duplicado` = ya procesado (reintento de Meta); `propio` = lo mando la plataforma (descartado); `sin_conversacion` = no hay hilo donde
 * guardarlo, o la base no tiene la migracion 101 (descartado); `fallo` = error real, Meta debe reintentar.
 */
export type ResultadoEco = "guardado" | "duplicado" | "propio" | "sin_conversacion" | "fallo";

/** Instante de silencio: la hora de Meta acotada para que un eco viejo o con reloj adelantado no fije el silencio en el pasado/futuro lejano. */
export function instanteDeSilencio(atMs: number | null, ahoraMs: number): number {
  return Math.min(ahoraMs + ECO_SILENCIO_MAX_ADELANTO_MS, Math.max(ahoraMs - ECO_SILENCIO_MAX_ANTIGUEDAD_MS, atMs ?? ahoraMs));
}

export async function registrarEcoDeApp(
  repo: RestaurantesRepository,
  args: { readonly organizationId: string; readonly propertyId: string | null; readonly eco: EcoDeApp; readonly handoffGate?: HandoffAgentGate; readonly ahoraMs?: () => number },
): Promise<ResultadoEco> {
  const { organizationId, propertyId, eco } = args;
  const phone = `+${eco.to}`;
  const phoneHash = actorHash(phone);
  const ahoraMs = (args.ahoraMs ?? Date.now)();
  if (!(await repo.claimWhatsAppMessage(organizationId, eco.id, phoneHash))) return "duplicado";
  try {
    // Lo que mando la propia plataforma tambien vuelve como eco: no es del personal, no se guarda ni silencia al asistente.
    if (await repo.wamidSalienteConocido(organizationId, eco.id)) {
      await repo.finishWhatsAppMessage(organizationId, eco.id, phoneHash, "processed", null);
      return "propio";
    }
    const mensaje: ConversationMessage = { role: "assistant", content: eco.body, autor: "humano_app", wamid: eco.id, at: new Date(eco.atMs ?? ahoraMs).toISOString() };
    const guardado = await repo.appendEcoWhatsApp(organizationId, phone, mensaje);
    if (guardado === "sin_conversacion" || guardado === "no_disponible") {
      await repo.finishWhatsAppMessage(organizationId, eco.id, phoneHash, "processed", null);
      return "sin_conversacion";
    }
    // El eco calla al asistente (toma `tomada` por la app; regresa por inactividad humana). `null` = no aplica (sin sucursal, base sin migrar); un error real LANZA y se reintenta
    // (el reintento no duplica el mensaje: el append es idempotente por wamid).
    if (args.handoffGate?.tomarPorEcoDeApp) {
      await args.handoffGate.tomarPorEcoDeApp({ organizationId, propertyId, phone, atMs: instanteDeSilencio(eco.atMs, ahoraMs) });
    }
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
