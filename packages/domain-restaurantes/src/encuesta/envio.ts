// Barrido de envio de la encuesta post-entrega (R-41): idempotente, sin cron (lo llama el endpoint interno y el boton del panel).
// Por cada pedido candidato, DENTRO de un savepoint por fila: reserva la encuesta (una vez por pedido) y encola el WhatsApp con la liga
// firmada. Si el encolado falla, la reserva se revierte con el savepoint y el pedido vuelve a ser candidato (nunca queda una encuesta
// "enviada" que no salio). Una fila venenosa no revierte las demas.
import { toWhatsAppRecipient } from "../phone.ts";
import type { RestaurantesRepository } from "../repository.ts";
import type { EncuestaCandidata, EncuestaRepository } from "./encuesta.ts";

/** Plantilla HSM (paso externo: crearla y aprobarla en el Business Manager de Meta). Variables: {{1}} nombre, {{2}} sucursal, {{3}} liga. */
export const PLANTILLA_ENCUESTA_ENTREGA = { name: "encuesta_entrega", language: "es_MX" } as const;
export const ENCUESTA_LOTE_MAX = 200;

export type EncuestaOmitidaMotivo = "telefono_invalido" | "sin_canal_whatsapp";

class Omitir extends Error {
  constructor(readonly motivo: EncuestaOmitidaMotivo) {
    super(motivo);
  }
}

export interface EnvioEncuestasDeps {
  readonly encuestas: EncuestaRepository;
  readonly restaurantes: Pick<RestaurantesRepository, "runWithRowSavepoint" | "enqueueMessagingOutbox" | "resolveActiveWhatsAppPhoneNumberId">;
  /** Liga publica y firmada de la encuesta de ese pedido. */
  readonly construirLiga: (candidata: EncuestaCandidata) => string;
}

export interface EnvioEncuestasResultado {
  /** false = la base todavia no tiene la migracion 061 (honesto: no se hizo nada). */
  readonly disponible: boolean;
  readonly candidatas: number;
  readonly encoladas: number;
  readonly yaRegistradas: number;
  readonly omitidas: Readonly<Record<EncuestaOmitidaMotivo, number>>;
  readonly errores: number;
  /** Pedidos cuya encuesta se encolo, por organizacion/sucursal/pedido (sin PII): para bitacora y notificaciones. */
  readonly pedidosEncolados: readonly { readonly organizationId: string; readonly propertyId: string; readonly orderId: string }[];
}

function primerNombre(nombre: string): string {
  const limpio = nombre.replace(/\s+/g, " ").trim();
  return limpio.split(" ")[0] || "cliente";
}

export function mensajeEncuesta(c: EncuestaCandidata, liga: string): string {
  return `Hola ${primerNombre(c.customerName)}, gracias por tu pedido en ${c.sucursal}. ¿Cómo estuvo todo? Cuéntanos en menos de un minuto: ${liga}`;
}

export async function enviarEncuestasPendientes(
  deps: EnvioEncuestasDeps,
  opts: { readonly organizationId: string | null; readonly limite?: number; readonly ahora?: Date },
): Promise<EnvioEncuestasResultado> {
  const limite = Math.min(Math.max(opts.limite ?? 100, 1), ENCUESTA_LOTE_MAX);
  const lectura = await deps.encuestas.candidatas(opts.organizationId, opts.ahora ?? null, limite);
  const omitidas: Record<EncuestaOmitidaMotivo, number> = { telefono_invalido: 0, sin_canal_whatsapp: 0 };
  const pedidosEncolados: { organizationId: string; propertyId: string; orderId: string }[] = [];
  if (!lectura.disponible) return { disponible: false, candidatas: 0, encoladas: 0, yaRegistradas: 0, omitidas, errores: 0, pedidosEncolados };

  let yaRegistradas = 0;
  let errores = 0;
  for (const c of lectura.valor) {
    try {
      const resultado = await deps.restaurantes.runWithRowSavepoint(async () => {
        const nueva = await deps.encuestas.registrarEnvio(c.organizationId, c.orderId);
        if (!nueva) return "ya_registrada" as const;
        // El telefono guardado son 10 digitos nacionales: Meta exige el numero con codigo de pais (ver phone.ts).
        const destinatario = toWhatsAppRecipient(c.customerPhone);
        if (!destinatario) throw new Omitir("telefono_invalido");
        const phoneNumberId = await deps.restaurantes.resolveActiveWhatsAppPhoneNumberId(c.organizationId, c.propertyId);
        if (!phoneNumberId) throw new Omitir("sin_canal_whatsapp");
        const liga = deps.construirLiga(c);
        await deps.restaurantes.enqueueMessagingOutbox(c.organizationId, "whatsapp", "encuesta.entrega", `encuesta-entrega:${c.orderId}`, {
          to: destinatario,
          phone_number_id: phoneNumberId,
          body: mensajeEncuesta(c, liga),
          // Es PROACTIVO y NO es el estado de su pedido: la lista de supresion SI aplica (sin `transaccional`). Plantilla HSM declarada;
          // el gateway la usa solo si el operador la declaro aprobada (WHATSAPP_APPROVED_TEMPLATES), si no sale el texto libre.
          template: { ...PLANTILLA_ENCUESTA_ENTREGA, params: [primerNombre(c.customerName), c.sucursal, liga] },
        });
        return "encolada" as const;
      });
      if (resultado === "ya_registrada") yaRegistradas += 1;
      else pedidosEncolados.push({ organizationId: c.organizationId, propertyId: c.propertyId, orderId: c.orderId });
    } catch (err) {
      if (err instanceof Omitir) omitidas[err.motivo] += 1;
      else {
        errores += 1;
        console.error("encuesta-entrega: no se pudo encolar la encuesta de un pedido (se reintenta en el siguiente barrido):", err);
      }
    }
  }
  return { disponible: true, candidatas: lectura.valor.length, encoladas: pedidosEncolados.length, yaRegistradas, omitidas, errores, pedidosEncolados };
}
