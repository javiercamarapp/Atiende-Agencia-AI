// H-P3-03 -- valores y textos de los mensajes al huesped. Puro. Mismo estilo que emails/guest-templates.ts (trato de "tu"; todo dato
// dinamico pasa por escapeHtml; montos y fechas ya formateados). El texto libre es el respaldo de WhatsApp (dentro de la ventana de 24 h
// de Meta) y el cuerpo del correo; la plantilla HSM, cuando existe, lleva los MISMOS valores en el orden que declara el catalogo.
import { escapeHtml, renderCorreo } from "../emails/layout.ts";
import { resolverZonaHorariaNegocio } from "@atiende/core-tenancy";
import type { CandidatoMensajeHuesped, EventoMensajeHuesped } from "./tipos.ts";
import type { VariableHuesped } from "./plantillas.ts";

export type ValoresMensaje = Readonly<Partial<Record<VariableHuesped, string>>>;

export interface ContextoTextos {
  /** `APP_BASE_URL` sin diagonal final; con el slug de la organizacion arma el enlace del aviso publico del hotel. */
  readonly appBaseUrl: string;
}

const FECHA = new Intl.DateTimeFormat("es-MX", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long", year: "numeric" });
const MONTO = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" });

/** `YYYY-MM-DD` (fecha calendario pura) -> "martes, 4 de julio de 2031", sin correr el dia por la zona del servidor. */
export function formatearFechaCalendario(fecha: string): string {
  return FECHA.format(new Date(`${fecha}T00:00:00Z`));
}

/** Instante -> "3 de julio, 19:00" en la zona de la propiedad. */
export function formatearInstanteLocal(iso: string, zonaHoraria: string): string {
  const fmt = new Intl.DateTimeFormat("es-MX", { timeZone: resolverZonaHorariaNegocio(zonaHoraria), day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  return fmt.format(new Date(iso));
}

export function formatearMontoCentavos(centavos: number): string {
  return MONTO.format(centavos / 100);
}

export function urlAvisoPrivacidad(appBaseUrl: string, orgSlug: string): string {
  // Sin expresion regular (CodeQL js/polynomial-redos): se recortan las diagonales finales con un recorrido lineal.
  let fin = appBaseUrl.length;
  while (fin > 0 && appBaseUrl.charCodeAt(fin - 1) === 47) fin -= 1;
  return `${appBaseUrl.slice(0, fin)}/hoteles/${encodeURIComponent(orgSlug)}/aviso`;
}

/** Valores que ESTE candidato sabe calcular. Una variable que no se pueda llenar no aparece (la plantilla que la pida se descarta). */
export function valoresDelCandidato(c: CandidatoMensajeHuesped, ctx: ContextoTextos): ValoresMensaje {
  const v: Partial<Record<VariableHuesped, string>> = {
    nombre: nombreCorto(c.huespedNombre),
    hotel: c.propiedadNombre,
    llegada: formatearFechaCalendario(c.llegada),
    salida: formatearFechaCalendario(c.salida),
    enlace_aviso: urlAvisoPrivacidad(ctx.appBaseUrl, c.orgSlug),
  };
  if (c.totalCentavos !== null) v.total = formatearMontoCentavos(c.totalCentavos);
  if (c.venceEn !== null) v.vence = formatearInstanteLocal(c.venceEn, c.zonaHoraria);
  if (c.resenaUrl !== null) v.enlace_resena = c.resenaUrl;
  return v;
}

/** Primer nombre (el nombre del huesped llega tal cual lo capturo recepcion o el agente: se acota y se limpia). */
export function nombreCorto(nombre: string | null): string {
  const limpio = (nombre ?? "").replace(/[\r\n\t]+/gu, " ").replace(/\s+/gu, " ").trim();
  if (limpio === "") return "huésped";
  return (limpio.split(" ")[0] as string).slice(0, 40);
}

export interface MensajeComponido {
  /** Texto libre: respaldo de WhatsApp dentro de la ventana de 24 h y cuerpo de texto del correo. */
  readonly texto: string;
  readonly asunto: string;
  readonly html: string;
}

const PIE = (hotel: string): string => `Recibes este correo porque tienes una reserva, pre-reserva o solicitud en ${hotel} a través de atiende.`;

function faltante(nombre: VariableHuesped, v: ValoresMensaje): string {
  const valor = v[nombre];
  return valor === undefined ? "" : valor;
}

export function componerMensaje(evento: EventoMensajeHuesped, v: ValoresMensaje): MensajeComponido {
  const nombre = faltante("nombre", v);
  const hotel = faltante("hotel", v);
  const llegada = faltante("llegada", v);
  const salida = faltante("salida", v);
  const total = v.total;
  const vence = v.vence;
  const aviso = v.enlace_aviso;
  const resena = v.enlace_resena;

  const html = (titulo: string, etiqueta: string, parrafo: string, filas: readonly { etiqueta: string; valor: string }[], nota?: string): string =>
    renderCorreo({
      titulo,
      preheader: `${hotel} — ${titulo}`,
      etiqueta: { texto: etiqueta, color: "#1D4ED8" },
      parrafosHtml: [parrafo],
      ...(filas.length > 0 ? { tabla: { filas } } : {}),
      ...(nota ? { nota: escapeHtml(nota) } : {}),
      piePorQueLlego: PIE(hotel),
    });
  const fechas = [
    { etiqueta: "Llegada", valor: llegada },
    { etiqueta: "Salida", valor: salida },
  ];

  switch (evento) {
    case "hold.aprobado": {
      const filas = [...fechas, ...(total ? [{ etiqueta: "Total estimado", valor: total }] : []), ...(vence ? [{ etiqueta: "Apartada hasta", valor: vence }] : [])];
      return {
        asunto: `Pre-reserva aprobada · ${hotel}`,
        texto: `Hola ${nombre}, ${hotel} aprobó tu pre-reserva (llegada ${llegada}, salida ${salida}${total ? `, total ${total}` : ""}).${vence ? ` La habitación queda apartada hasta el ${vence}.` : ""} Una persona del hotel te dará los siguientes pasos.`,
        html: html("Tu pre-reserva fue aprobada", "Pre-reserva aprobada", `Hola ${escapeHtml(nombre)}, <strong>${escapeHtml(hotel)}</strong> aprobó tu pre-reserva.`, filas, "Una persona del hotel te dará los siguientes pasos."),
      };
    }
    case "hold.rechazado":
      return {
        asunto: `Tu pre-reserva no pudo aceptarse · ${hotel}`,
        texto: `Hola ${nombre}, lamentamos avisarte que ${hotel} no pudo aceptar tu pre-reserva del ${llegada} al ${salida}. Si quieres, escríbenos para buscar otras fechas.`,
        html: html("No pudimos aceptar tu pre-reserva", "Pre-reserva rechazada", `Hola ${escapeHtml(nombre)}, lamentamos avisarte que <strong>${escapeHtml(hotel)}</strong> no pudo aceptar tu pre-reserva.`, fechas, "Si quieres, escríbenos para buscar otras fechas."),
      };
    case "hold.confirmado": {
      const filas = [...fechas, ...(total ? [{ etiqueta: "Total estimado", valor: total }] : [])];
      return {
        asunto: `Reserva confirmada · ${hotel} · ${llegada}`,
        texto: `Hola ${nombre}, tu reserva en ${hotel} quedó confirmada: llegada ${llegada}, salida ${salida}${total ? `, total ${total}` : ""}.`,
        html: html("Tu reserva quedó confirmada", "Reserva confirmada", `Hola ${escapeHtml(nombre)}, tu reserva en <strong>${escapeHtml(hotel)}</strong> quedó confirmada.`, filas),
      };
    }
    case "hold.vencido":
      return {
        asunto: `Tu pre-reserva venció · ${hotel}`,
        texto: `Hola ${nombre}, tu pre-reserva en ${hotel} (del ${llegada} al ${salida}) venció y la habitación se liberó. Escríbenos si aún la quieres.`,
        html: html("Tu pre-reserva venció", "Pre-reserva vencida", `Hola ${escapeHtml(nombre)}, tu pre-reserva en <strong>${escapeHtml(hotel)}</strong> venció y la habitación se liberó.`, fechas, "Escríbenos si aún la quieres."),
      };
    case "reserva.confirmada":
      return {
        asunto: `Reserva confirmada · ${hotel} · ${llegada}`,
        texto: `Hola ${nombre}, tu reserva en ${hotel} quedó confirmada: llegada ${llegada}, salida ${salida}.`,
        html: html("Tu reserva quedó confirmada", "Reserva confirmada", `Hola ${escapeHtml(nombre)}, tu reserva en <strong>${escapeHtml(hotel)}</strong> quedó confirmada.`, fechas),
      };
    case "pre_llegada":
      return {
        asunto: `Te esperamos en ${hotel}`,
        texto: `Hola ${nombre}, te esperamos en ${hotel} el ${llegada} (salida ${salida}).${aviso ? ` Aviso de privacidad: ${aviso}` : ""}`,
        html: html("Te esperamos pronto", "Antes de tu llegada", `Hola ${escapeHtml(nombre)}, te esperamos en <strong>${escapeHtml(hotel)}</strong>.`, fechas, aviso ? `Aviso de privacidad: ${aviso}` : undefined),
      };
    case "post_estancia":
      return {
        asunto: `Gracias por hospedarte en ${hotel}`,
        texto: `Hola ${nombre}, gracias por hospedarte en ${hotel}. Esperamos verte pronto.${resena ? ` Cuéntanos tu experiencia: ${resena}` : ""}`,
        html: html("Gracias por tu visita", "Gracias por hospedarte", `Hola ${escapeHtml(nombre)}, gracias por hospedarte en <strong>${escapeHtml(hotel)}</strong>. Esperamos verte pronto.`, [], resena ? `Cuéntanos tu experiencia: ${resena}` : undefined),
      };
    case "lista_espera.ofrecida": {
      const filas = [...fechas, ...(vence ? [{ etiqueta: "Oferta vigente hasta", valor: vence }] : [])];
      return {
        asunto: `Se liberó lugar en ${hotel}`,
        texto: `Hola ${nombre}, se liberó lugar en ${hotel} del ${llegada} al ${salida}.${vence ? ` La oferta está vigente hasta el ${vence}.` : ""} Responde este mensaje o llama al hotel para reservar.`,
        html: html("Se liberó lugar para tus fechas", "Lista de espera", `Hola ${escapeHtml(nombre)}, se liberó lugar en <strong>${escapeHtml(hotel)}</strong> para las fechas que esperabas.`, filas, "Responde este correo o llama al hotel para reservar."),
      };
    }
  }
}
