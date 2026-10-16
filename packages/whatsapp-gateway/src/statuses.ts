// Estados de entrega que Meta reporta DESPUES del envio: `entry[].changes[].value.statuses[]`.
//
// Meta acepta un envio con 200 y un wamid, pero muchos fallos llegan despues por el webhook (131047 fuera de la ventana de 24 h,
// 131026 numero no entregable, 132xxx plantilla pausada o con parametros mal, 131049 limite de marketing). Este modulo es PURO:
// extrae esos estados y define el orden en que avanzan; no toca red ni base de datos.
//
// Privacidad: el extractor NO devuelve el texto de ningun mensaje (un `status` no lo trae) y el `recipient_id` (telefono del cliente) se
// entrega solo para que el llamador decida si lo necesita; el procesador de restaurantes NO lo guarda ni lo registra.

export const ESTADOS_ENTREGA = ["sent", "delivered", "read", "failed"] as const;
export type EstadoEntrega = (typeof ESTADOS_ENTREGA)[number];

export interface MetaDeliveryStatus {
  /** `phone_number_id` del `change` que lo trajo (rutea al tenant); null si el change no lo trae. */
  readonly phoneNumberId: string | null;
  /** wamid del mensaje saliente (`id` del status); 1-255 caracteres. */
  readonly wamid: string;
  readonly status: EstadoEntrega;
  /** Momento del evento segun Meta (epoch en segundos -> ISO). Null si falta o no es valido. */
  readonly occurredAt: string | null;
  /** Telefono del destinatario segun Meta. PII: no guardar ni registrar. */
  readonly recipientId: string | null;
  /** Primer error de `errors[]` (solo en `failed`): codigo numerico de Meta, p. ej. 131047. */
  readonly errorCode: number | null;
  /** Titulo corto del error segun Meta (recortado a 120). Texto de Meta, no del cliente. */
  readonly errorTitle: string | null;
}

const WAMID_MAX = 255;
const TITLE_MAX = 120;
const ESTADOS = new Set<string>(ESTADOS_ENTREGA);

function isoDeEpochSegundos(raw: unknown): string | null {
  const n = typeof raw === "string" && /^\d{1,12}$/.test(raw) ? Number(raw) : typeof raw === "number" && Number.isInteger(raw) && raw > 0 ? raw : null;
  if (n === null || n <= 0) return null;
  const d = new Date(n * 1000);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Extrae los `statuses` de un payload firmado de Meta, en el orden del payload. Ignora (sin lanzar) todo lo que no tiene la forma
 *  documentada: un estado desconocido (`deleted`, `warning`), un wamid vacio o demasiado largo, un elemento que no es objeto. Un payload
 *  solo de mensajes devuelve []. */
export function extractMetaStatuses(payload: unknown): MetaDeliveryStatus[] {
  const resultado: MetaDeliveryStatus[] = [];
  const root = payload as { entry?: unknown } | null;
  if (!root || !Array.isArray(root.entry)) return resultado;
  for (const entry of root.entry) {
    const changes = (entry as { changes?: unknown } | null)?.changes;
    if (!Array.isArray(changes)) continue;
    for (const change of changes) {
      const value = (change as { value?: { metadata?: { phone_number_id?: unknown }; statuses?: unknown } } | null)?.value;
      if (!value || !Array.isArray(value.statuses)) continue;
      const rawPhone = value.metadata?.phone_number_id;
      const phoneNumberId = typeof rawPhone === "string" && rawPhone.length > 0 ? rawPhone : null;
      for (const candidato of value.statuses) {
        if (candidato === null || typeof candidato !== "object") continue;
        const s = candidato as { id?: unknown; status?: unknown; timestamp?: unknown; recipient_id?: unknown; errors?: unknown };
        if (typeof s.id !== "string" || s.id.length < 1 || s.id.length > WAMID_MAX) continue;
        if (typeof s.status !== "string" || !ESTADOS.has(s.status)) continue;
        let errorCode: number | null = null;
        let errorTitle: string | null = null;
        if (Array.isArray(s.errors) && s.errors.length > 0 && s.errors[0] !== null && typeof s.errors[0] === "object") {
          const e = s.errors[0] as { code?: unknown; title?: unknown };
          if (typeof e.code === "number" && Number.isInteger(e.code) && e.code >= 0 && e.code <= 2_147_483_647) errorCode = e.code;
          if (typeof e.title === "string" && e.title.trim().length > 0) errorTitle = e.title.trim().slice(0, TITLE_MAX);
        }
        resultado.push({
          phoneNumberId,
          wamid: s.id,
          status: s.status as EstadoEntrega,
          occurredAt: isoDeEpochSegundos(s.timestamp),
          recipientId: typeof s.recipient_id === "string" && s.recipient_id.length > 0 ? s.recipient_id : null,
          errorCode: s.status === "failed" ? errorCode : null,
          errorTitle: s.status === "failed" ? errorTitle : null,
        });
      }
    }
  }
  return resultado;
}

/** Rango de cada estado: `sent` < `delivered` < `read`; `failed` gana sobre todo. */
const RANGO: Record<EstadoEntrega, number> = { sent: 1, delivered: 2, read: 3, failed: 4 };

/** Estado resultante de recibir `nuevo` cuando el mensaje esta en `actual` (null = aun sin estado de entrega). Nunca retrocede
 *  (`read` antes que `delivered` no baja a `delivered`), `failed` gana y es terminal, y repetir el mismo estado no cambia nada.
 *  Espejo exacto de `restaurantes.registrar_estado_entrega_whatsapp` (migracion 066). */
export function avanzarEstadoEntrega(actual: EstadoEntrega | null, nuevo: EstadoEntrega): EstadoEntrega {
  if (actual === null) return nuevo;
  if (actual === "failed") return "failed";
  return RANGO[nuevo] > RANGO[actual] ? nuevo : actual;
}

/** Clasifica un codigo de error de Meta en un motivo corto y estable (sin texto libre) para el panel y la notificacion. */
export type MotivoFalloEntrega = "fuera_de_ventana" | "numero_no_entregable" | "plantilla" | "limite_marketing" | "otro";

export function motivoFalloEntrega(codigo: number | null): MotivoFalloEntrega {
  if (codigo === 131047) return "fuera_de_ventana";
  if (codigo === 131026) return "numero_no_entregable";
  if (codigo === 131049) return "limite_marketing";
  if (codigo !== null && codigo >= 132000 && codigo <= 132999) return "plantilla";
  return "otro";
}
