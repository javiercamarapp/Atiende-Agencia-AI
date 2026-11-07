// H-P3-03 -- decision de canal de UN mensaje al huesped. Funcion PURA: sin red, sin base. Orden:
//   1. WhatsApp: hay telefono, el canal del hotel esta listo (numero habilitado + credencial de Meta), el telefono no pidio BAJA, y
//      (el huesped escribio hace menos de 23 h -> texto libre) o (hay plantilla HSM aprobada con todas sus variables -> plantilla).
//   2. Correo: hay correo y no esta en la lista de supresion (un correo transaccional de SU reserva no la consulta).
//   3. No enviado, con el motivo mas util para el staff.
import type { PlantillaParaEncolar } from "./plantillas.ts";
import type { CanalMensaje, MotivoNoEnviado } from "./tipos.ts";

export interface EntradaDecisionCanal {
  /** E.164 con `+`, ya normalizado, o `null` si el huesped no dejo telefono usable. */
  readonly telefono: string | null;
  readonly correo: string | null;
  /** Canal de WhatsApp del hotel habilitado con numero Y credencial de Meta en la plataforma. */
  readonly whatsappListo: boolean;
  /** El huesped escribio al hotel hace menos de 23 h: se puede mandar texto libre sin plantilla. */
  readonly dentroVentanaServicio: boolean;
  /** Plantilla aprobada de la organizacion ya con sus parametros armados; `null` si no hay plantilla aprobada o falta una variable. */
  readonly plantilla: PlantillaParaEncolar | null;
  readonly telefonoSuprimido: boolean;
  readonly correoSuprimido: boolean;
  /** Evento transaccional (respuesta a algo que el huesped hizo): su correo no consulta la lista de supresion. */
  readonly transaccional: boolean;
}

export type DecisionCanal =
  | { readonly canal: "whatsapp"; readonly modo: "texto" }
  | { readonly canal: "whatsapp"; readonly modo: "plantilla"; readonly plantilla: PlantillaParaEncolar }
  | { readonly canal: "email" }
  | { readonly canal: null; readonly motivo: MotivoNoEnviado };

export function decidirCanal(e: EntradaDecisionCanal): DecisionCanal {
  let motivoWhatsapp: MotivoNoEnviado | null = null;
  if (e.telefono !== null) {
    if (e.telefonoSuprimido) motivoWhatsapp = "baja_whatsapp";
    else if (!e.whatsappListo) motivoWhatsapp = "whatsapp_no_disponible";
    else if (e.dentroVentanaServicio) return { canal: "whatsapp", modo: "texto" };
    else if (e.plantilla !== null) return { canal: "whatsapp", modo: "plantilla", plantilla: e.plantilla };
    else motivoWhatsapp = "sin_plantilla";
  }

  if (e.correo !== null) {
    if (e.transaccional || !e.correoSuprimido) return { canal: "email" };
    return { canal: null, motivo: motivoWhatsapp ?? "correo_suprimido" };
  }
  return { canal: null, motivo: motivoWhatsapp ?? "sin_contacto" };
}

export type { CanalMensaje };

/** Telefono de un huesped a E.164 con `+` para WhatsApp. 10 digitos = Mexico (+52). `null` si no parece un telefono. */
export function normalizarTelefonoWhatsapp(crudo: string | null | undefined): string | null {
  if (typeof crudo !== "string") return null;
  const tienePlus = crudo.trim().startsWith("+");
  const digitos = crudo.replace(/\D/gu, "");
  if (digitos.length === 0) return null;
  if (!tienePlus && digitos.length === 10) return `+52${digitos}`;
  if (digitos.length < 8 || digitos.length > 15) return null;
  return `+${digitos}`;
}

/** Correo plausible (una sola arroba, dominio con punto, sin espacios). `null` si no lo parece. */
export function normalizarCorreo(crudo: string | null | undefined): string | null {
  if (typeof crudo !== "string") return null;
  const c = crudo.trim().toLowerCase();
  return c.length <= 160 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(c) ? c : null;
}
