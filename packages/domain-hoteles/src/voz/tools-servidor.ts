// Lo que HACE cada herramienta de voz de hoteles en el servidor, en UN solo lugar: lo usan las rutas HTTP del worker
// (`apps/api/.../hoteles/voice-tools.ts`, que ponen la autenticacion por property, el rate limit y el limite de cuerpo) y el transporte EN PROCESO
// del simulador. Asi la prueba ciega ejercita la misma logica que produccion.
import { randomUUID } from "node:crypto";
import { registerContactoNoOperativo } from "../contacto-no-operativo.ts";
import { resolveAllergyDeclared } from "../fnbAllergyGuard.ts";
import type { HotelesRepository } from "../repository.ts";
import { executeReservasTool, isReservasToolName } from "../reservas-agente/herramientas.ts";
import type { ReservasToolName } from "../reservas-agente/herramientas.ts";
import type { ReservasAgenteRepository } from "../reservas-agente/repository.ts";

export const TOOLS_VOZ_HOTELES = [
  "consultar_disponibilidad",
  "cotizar_estancia",
  "crear_pre_reserva",
  "estado_pre_reserva",
  "cancelar_pre_reserva",
  "derivar_a_humano",
  "crear_ticket_huesped_fnb",
  "registrar_contacto_no_operativo",
] as const;
export type ToolVozHoteles = (typeof TOOLS_VOZ_HOTELES)[number];

export function esToolVozHoteles(nombre: string): nombre is ToolVozHoteles {
  return (TOOLS_VOZ_HOTELES as readonly string[]).includes(nombre);
}

/** Ruta HTTP (relativa a `/v1/hoteles/:propertyId/voz`) de cada herramienta: el manifiesto que comparten el worker y la API. */
export function rutaToolVozHoteles(nombre: ToolVozHoteles): string {
  if (nombre === "crear_ticket_huesped_fnb") return "/tickets-fnb";
  if (nombre === "registrar_contacto_no_operativo") return "/contacto-no-operativo";
  return `/reservas/${nombre}`;
}

/** El cuerpo de una herramienta no cumple su contrato (la ruta responde 400; el transporte en proceso, un `error` para el modelo). */
export class VozToolValidacionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VozToolValidacionError";
  }
}

export interface TicketFnbVozEntrada {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly mensaje: unknown;
  readonly habitacion: unknown;
  readonly alergiaDeclarada: unknown;
}

/** crear_ticket_huesped_fnb: mismo camino que `POST /hoteles/:propertyId/pedidos-fnb`, sin sesion de staff (actor system:voz, createdBy null). NUNCA
 * afirma que un platillo es seguro: eso exige confirmacion humana de cocina (REQ-AB-004). */
export async function crearTicketFnbVoz(repo: HotelesRepository, e: TicketFnbVozEntrada): Promise<{ id: string; alergiaDeclarada: boolean; mensaje: string }> {
  const mensaje = typeof e.mensaje === "string" ? e.mensaje.trim() : "";
  if (!mensaje || mensaje.length > 1000) throw new VozToolValidacionError("mensaje es requerido (máximo 1000 caracteres).");
  const habitacion = typeof e.habitacion === "string" && e.habitacion.trim() ? e.habitacion.trim().slice(0, 50) : null;
  const notes = habitacion ? `Habitación declarada por el huésped vía voz: ${habitacion}` : null;
  const { allergyDeclared, declaredVia } = resolveAllergyDeclared({ structuredFlag: e.alergiaDeclarada === true, freeTextFields: [mensaje, notes] });
  const order = await repo.insertFnbOrder({
    organizationId: e.organizationId,
    propertyId: e.propertyId,
    roomId: null,
    items: [{ nombre: mensaje }],
    notes,
    allergyDeclared,
    allergyDeclaredVia: declaredVia,
    createdBy: null,
  });
  return {
    id: order.id,
    alergiaDeclarada: order.allergyDeclared,
    mensaje: order.allergyDeclared
      ? "Registramos tu pedido y tu alergia/restricción alimentaria. La cocina va a revisarlo antes de prepararlo."
      : "Registramos tu pedido, la cocina lo va a preparar.",
  };
}

export interface ContactoNoOperativoVozEntrada {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly motivo: unknown;
  readonly resumen: unknown;
  readonly telefono: unknown;
}

/** registrar_contacto_no_operativo: lo que no es F&B queda siempre registrado para seguimiento humano. */
export async function registrarContactoNoOperativoVoz(repo: HotelesRepository, e: ContactoNoOperativoVozEntrada): Promise<{ id: string; ok: true }> {
  const motivo = typeof e.motivo === "string" ? e.motivo.trim() : "";
  if (!motivo || motivo.length > 500) throw new VozToolValidacionError("motivo es requerido (máximo 500 caracteres).");
  const contacto = await registerContactoNoOperativo(repo, {
    organizationId: e.organizationId,
    propertyId: e.propertyId,
    guestPhone: typeof e.telefono === "string" ? e.telefono.trim().slice(0, 32) : null,
    guestName: null,
    reason: motivo,
    message: typeof e.resumen === "string" ? e.resumen.trim().slice(0, 1000) : null,
    source: "voice",
  });
  return { id: contacto.id, ok: true };
}

export interface ReservasVozContexto {
  readonly hotelesRepo: HotelesRepository;
  readonly reservas: ReservasAgenteRepository;
  readonly organizationId: string;
  readonly propertyId: string;
  /** Numero de la llamada (del SIP From; obligatorio para apartar/estado/cancelar). */
  readonly telefono: string;
  /** Idempotencia de reintentos dentro de la llamada. */
  readonly llamadaId?: string;
  readonly now?: Date;
}

/** Herramientas de reservas por voz: las MISMAS que el agente de WhatsApp (`executeReservasTool`). Si el hotel no habilito los holds en su politica
 * (o la base no tiene la migracion 037) responde `{error, requiere_humano:true}` en vez de fallar, para que el agente derive a una persona. */
export async function ejecutarReservasVoz(ctx: ReservasVozContexto, herramienta: ReservasToolName, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const policy = await ctx.reservas.agentPolicy(ctx.propertyId).catch(() => null);
  if (!policy || !policy.disponible || !policy.politica.holdsEnabled) {
    return { error: "holds_deshabilitados", mensaje: "El hotel no aparta habitaciones por este canal. Una persona del hotel continuara.", requiere_humano: true };
  }
  const llamadaId = ctx.llamadaId && ctx.llamadaId.trim() ? ctx.llamadaId.trim().slice(0, 64) : randomUUID();
  const outcome = await executeReservasTool(
    { reservas: ctx.reservas, hotelesRepo: ctx.hotelesRepo, organizationId: ctx.organizationId, propertyId: ctx.propertyId, contactPhone: ctx.telefono.slice(0, 40), channel: "voz", turnId: llamadaId, ...(ctx.now ? { now: ctx.now } : {}) },
    herramienta,
    input,
  );
  return outcome.result;
}

/** Despacho EN PROCESO de cualquiera de las 8 herramientas (simulador y pruebas; en produccion el worker usa las rutas HTTP, que llaman a lo mismo). */
export async function ejecutarToolVozHoteles(ctx: ReservasVozContexto, nombre: string, args: Readonly<Record<string, unknown>>): Promise<{ resultado: unknown; entidadId: string | null }> {
  try {
    if (nombre === "crear_ticket_huesped_fnb") {
      const r = await crearTicketFnbVoz(ctx.hotelesRepo, { organizationId: ctx.organizationId, propertyId: ctx.propertyId, mensaje: args.mensaje, habitacion: args.habitacion, alergiaDeclarada: args.alergia_declarada });
      return { resultado: r, entidadId: null };
    }
    if (nombre === "registrar_contacto_no_operativo") {
      const r = await registrarContactoNoOperativoVoz(ctx.hotelesRepo, { organizationId: ctx.organizationId, propertyId: ctx.propertyId, motivo: args.motivo, resumen: args.resumen, telefono: ctx.telefono });
      return { resultado: r, entidadId: null };
    }
    if (isReservasToolName(nombre)) {
      const resultado = await ejecutarReservasVoz(ctx, nombre, { ...args });
      const id = nombre === "crear_pre_reserva" && typeof resultado.pre_reserva_id === "string" && !("error" in resultado) ? resultado.pre_reserva_id : null;
      return { resultado, entidadId: id };
    }
    return { resultado: { error: `Herramienta desconocida: ${nombre}` }, entidadId: null };
  } catch (err) {
    if (err instanceof VozToolValidacionError) return { resultado: { error: err.message }, entidadId: null };
    throw err;
  }
}
