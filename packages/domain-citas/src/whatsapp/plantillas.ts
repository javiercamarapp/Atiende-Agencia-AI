// PL-31 -- catalogo de plantillas HSM de WhatsApp por organizacion (core.whatsapp_plantilla, migracion 0048): eventos de citas que
// pueden salir como plantilla, sus variables permitidas y la validacion del formulario. El producto aprueba la plantilla en Meta
// Business Manager (paso externo); aqui solo se registra su nombre, idioma, orden de variables y estado.
//
// Una plantilla solo puede usar variables que el productor del evento SABE calcular (si pidiera otra, `decidirEnvioProactivo` la
// descartaria: nunca se manda una plantilla incompleta), asi que el formulario las valida contra la lista del evento.
import { VARIABLES_BASE } from "./message-config.ts";

export const PLANTILLA_ESTADOS = ["borrador", "enviada", "aprobada", "rechazada"] as const;
export type EstadoPlantillaWhatsapp = (typeof PLANTILLA_ESTADOS)[number];

export interface EventoPlantillaCitas {
  readonly evento: string;
  readonly etiqueta: string;
  /** Variables que el productor del evento puede llenar, en el orden en que se sugieren. */
  readonly variables: readonly string[];
}

export const EVENTOS_PLANTILLA_CITAS: readonly EventoPlantillaCitas[] = [
  { evento: "appointment.reminder_24h", etiqueta: "Recordatorio de cita (24 horas antes)", variables: VARIABLES_BASE },
  { evento: "waitlist.slot_offered", etiqueta: "Oferta de un espacio liberado a la lista de espera", variables: ["nombre", "negocio"] },
  { evento: "waitlist.slot_available_broadcast", etiqueta: "Aviso manual a la lista de espera", variables: ["nombre", "negocio"] },
];

export const PLANTILLA_NOMBRE_RE = /^[a-z0-9_]{1,512}$/;
export const PLANTILLA_IDIOMA_RE = /^[a-z]{2,3}(_[A-Z]{2})?$/;
export const PLANTILLA_MAX_VARIABLES = 10;

export interface PlantillaWhatsappRecord {
  readonly evento: string;
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

export function eventoPlantillaCitas(evento: string): EventoPlantillaCitas | undefined {
  return EVENTOS_PLANTILLA_CITAS.find((e) => e.evento === evento);
}

/** Valida el cuerpo de un alta/edicion para un evento conocido. Nunca lanza. */
export function validarPlantillaWhatsapp(raw: unknown, evento: EventoPlantillaCitas): ResultadoValidacionPlantilla {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, error: "El cuerpo debe ser un objeto." };
  const r = raw as Record<string, unknown>;
  if (typeof r.nombre !== "string" || !PLANTILLA_NOMBRE_RE.test(r.nombre.trim())) return { ok: false, error: "nombre: el nombre de la plantilla en Meta usa solo minúsculas, dígitos y guion bajo (1 a 512 caracteres)." };
  const idioma = r.idioma === undefined ? "es_MX" : r.idioma;
  if (typeof idioma !== "string" || !PLANTILLA_IDIOMA_RE.test(idioma)) return { ok: false, error: "idioma: usa un código como es_MX." };
  if (!Array.isArray(r.variables) || r.variables.length > PLANTILLA_MAX_VARIABLES || r.variables.some((v) => typeof v !== "string")) {
    return { ok: false, error: `variables: lista de hasta ${PLANTILLA_MAX_VARIABLES} nombres, en el orden de {{1}}, {{2}}...` };
  }
  const variables = r.variables as string[];
  const desconocida = variables.find((v) => !evento.variables.includes(v));
  if (desconocida !== undefined) return { ok: false, error: `variables: "${desconocida}" no está disponible para este evento (usa: ${evento.variables.join(", ")}).` };
  if (typeof r.estado !== "string" || !(PLANTILLA_ESTADOS as readonly string[]).includes(r.estado)) return { ok: false, error: `estado: uno de ${PLANTILLA_ESTADOS.join(", ")}.` };
  return { ok: true, valor: { nombre: r.nombre.trim(), idioma, variables, estado: r.estado as EstadoPlantillaWhatsapp } };
}
