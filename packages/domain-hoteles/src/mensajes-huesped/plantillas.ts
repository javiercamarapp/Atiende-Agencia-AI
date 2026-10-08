// H-P3-03 -- catalogo de plantillas HSM de WhatsApp de hoteles (PL-31: core.whatsapp_plantilla, migracion 0050, vertical 'hoteles').
// El hotel aprueba la plantilla en Meta Business Manager (paso externo); aqui solo se registra su nombre, idioma, el ORDEN de sus
// variables y su estado. Una plantilla solo puede usar variables que el productor del evento SABE calcular: si pidiera otra, el envio
// por WhatsApp se descarta y sale por correo (nunca una plantilla incompleta). No se reinventa el catalogo: es el mismo de citas.
import { EVENTOS_MENSAJE_HUESPED, type EventoMensajeHuesped } from "./tipos.ts";

export const PLANTILLA_ESTADOS = ["borrador", "enviada", "aprobada", "rechazada"] as const;
export type EstadoPlantillaWhatsapp = (typeof PLANTILLA_ESTADOS)[number];

export const VARIABLES_HUESPED = ["nombre", "hotel", "llegada", "salida", "total", "vence", "enlace_aviso", "enlace_resena"] as const;
export type VariableHuesped = (typeof VARIABLES_HUESPED)[number];

export interface EventoPlantillaHoteles {
  readonly evento: EventoMensajeHuesped;
  readonly etiqueta: string;
  /** Variables que el productor del evento puede llenar, en el orden en que se sugieren. */
  readonly variables: readonly VariableHuesped[];
}

export const EVENTOS_PLANTILLA_HOTELES: readonly EventoPlantillaHoteles[] = [
  { evento: "hold.aprobado", etiqueta: "Pre-reserva aprobada", variables: ["nombre", "hotel", "llegada", "salida", "total", "vence"] },
  { evento: "hold.rechazado", etiqueta: "Pre-reserva rechazada", variables: ["nombre", "hotel", "llegada", "salida"] },
  { evento: "hold.confirmado", etiqueta: "Pre-reserva confirmada (reserva creada)", variables: ["nombre", "hotel", "llegada", "salida", "total"] },
  { evento: "hold.vencido", etiqueta: "Pre-reserva vencida", variables: ["nombre", "hotel", "llegada", "salida"] },
  { evento: "reserva.confirmada", etiqueta: "Reserva confirmada", variables: ["nombre", "hotel", "llegada", "salida"] },
  { evento: "pre_llegada", etiqueta: "Pre-llegada (antes del check-in)", variables: ["nombre", "hotel", "llegada", "salida", "enlace_aviso"] },
  { evento: "post_estancia", etiqueta: "Post-estancia (agradecimiento y reseña)", variables: ["nombre", "hotel", "enlace_resena"] },
  { evento: "lista_espera.ofrecida", etiqueta: "Oferta de lugar a la lista de espera", variables: ["nombre", "hotel", "llegada", "salida", "vence"] },
];

if (EVENTOS_PLANTILLA_HOTELES.length !== EVENTOS_MENSAJE_HUESPED.length) {
  throw new Error("mensajes-huesped/plantillas: el catalogo de plantillas debe cubrir todos los eventos");
}

export function eventoPlantillaHoteles(evento: string): EventoPlantillaHoteles | undefined {
  return EVENTOS_PLANTILLA_HOTELES.find((e) => e.evento === evento);
}

/** Clave del evento en core.whatsapp_plantilla (vertical 'hoteles'). */
export function claveCatalogoPlantilla(evento: EventoMensajeHuesped): string {
  return `hoteles.${evento}`;
}
export function eventoDeClaveCatalogo(clave: string): EventoMensajeHuesped | undefined {
  const prefijo = "hoteles.";
  if (!clave.startsWith(prefijo)) return undefined;
  const e = clave.slice(prefijo.length);
  return (EVENTOS_MENSAJE_HUESPED as readonly string[]).includes(e) ? (e as EventoMensajeHuesped) : undefined;
}

export const PLANTILLA_NOMBRE_RE = /^[a-z0-9_]{1,512}$/;
export const PLANTILLA_IDIOMA_RE = /^[a-z]{2,3}(_[A-Z]{2})?$/;
export const PLANTILLA_MAX_VARIABLES = 10;
const MAX_PARAM_LENGTH = 1024;

export interface PlantillaWhatsappRecord {
  readonly evento: EventoMensajeHuesped;
  readonly nombre: string;
  readonly idioma: string;
  readonly variables: readonly string[];
  readonly estado: EstadoPlantillaWhatsapp;
  readonly aprobadaEn: string | null;
  readonly actualizadaEn: string;
}

export interface PlantillaWhatsappInput {
  readonly nombre: string;
  readonly idioma: string;
  readonly variables: readonly string[];
  readonly estado: EstadoPlantillaWhatsapp;
}

export type ResultadoValidacionPlantilla = { readonly ok: true; readonly valor: PlantillaWhatsappInput } | { readonly ok: false; readonly error: string };

/** Valida el cuerpo de un alta/edicion para un evento conocido. Nunca lanza. */
export function validarPlantillaWhatsapp(raw: unknown, evento: EventoPlantillaHoteles): ResultadoValidacionPlantilla {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, error: "El cuerpo debe ser un objeto." };
  const r = raw as Record<string, unknown>;
  if (typeof r.nombre !== "string" || !PLANTILLA_NOMBRE_RE.test(r.nombre.trim())) return { ok: false, error: "nombre: el nombre de la plantilla en Meta usa solo minúsculas, dígitos y guion bajo (1 a 512 caracteres)." };
  const idioma = r.idioma === undefined ? "es_MX" : r.idioma;
  if (typeof idioma !== "string" || !PLANTILLA_IDIOMA_RE.test(idioma)) return { ok: false, error: "idioma: usa un código como es_MX." };
  if (!Array.isArray(r.variables) || r.variables.length > PLANTILLA_MAX_VARIABLES || r.variables.some((v) => typeof v !== "string")) {
    return { ok: false, error: `variables: lista de hasta ${PLANTILLA_MAX_VARIABLES} nombres, en el orden de {{1}}, {{2}}...` };
  }
  const variables = r.variables as string[];
  const desconocida = variables.find((v) => !(evento.variables as readonly string[]).includes(v));
  if (desconocida !== undefined) return { ok: false, error: `variables: "${desconocida}" no está disponible para este evento (usa: ${evento.variables.join(", ")}).` };
  if (typeof r.estado !== "string" || !(PLANTILLA_ESTADOS as readonly string[]).includes(r.estado)) return { ok: false, error: `estado: uno de ${PLANTILLA_ESTADOS.join(", ")}.` };
  return { ok: true, valor: { nombre: r.nombre.trim(), idioma, variables, estado: r.estado as EstadoPlantillaWhatsapp } };
}

/** Plantilla APROBADA de una organizacion para un evento (fila de core.whatsapp_plantilla). */
export interface PlantillaWhatsappAprobada {
  readonly name: string;
  readonly language: string;
  /** Nombres de las variables, en el orden de {{1}}, {{2}}... del cuerpo aprobado en Meta. */
  readonly variables: readonly string[];
}

/** Misma forma que `OutboundTemplate` de @atiende/whatsapp-gateway (se escribe tal cual en el payload del outbox). */
export interface PlantillaParaEncolar {
  readonly name: string;
  readonly language: string;
  readonly params: readonly string[];
}

/** Ordena los valores segun las variables de la plantilla. `null` si falta alguno o queda vacio (Meta rechaza variables vacias). */
export function armarParametrosPlantilla(variables: readonly string[], valores: Readonly<Record<string, string | undefined>>): readonly string[] | null {
  if (variables.length > PLANTILLA_MAX_VARIABLES) return null;
  const params: string[] = [];
  for (const nombre of variables) {
    const crudo = valores[nombre];
    if (typeof crudo !== "string") return null;
    const limpio = crudo.replace(/[\r\n\t]+/gu, " ").replace(/\s{2,}/gu, " ").trim().slice(0, MAX_PARAM_LENGTH);
    if (limpio === "") return null;
    params.push(limpio);
  }
  return params;
}
