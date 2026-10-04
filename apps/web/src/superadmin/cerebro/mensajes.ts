// El primer toque del Cerebro: WhatsApp y correo con el texto de los MENSAJES BASE de la taxonomia vigente de la vertical
// (core.cerebro_taxonomia: es-MX, sin promesas de cifras, con la baja "responde BAJA"; los valida el API y el SQL). Sustituye a las
// plantillas de transporte de mensajes.ts de Likida. El cerebro PROPONE y el humano ENVIA: el boton solo abre el WhatsApp o el
// correo de quien opera con el texto cargado y editable; esta pantalla no manda nada por si sola.
//
// REGLAS (todas de seguridad, cada una con su prueba):
//  - Un destino en la lista de supresion de plataforma (SA-L-46) no se abre: ni el boton ni el enlace tel:/mailto: existen (el dato se
//    muestra como texto plano), y se explica por que.
//  - Un contacto legado (sin base de licitud registrada) no se abre.
//  - Si el texto base trae un marcador que el prospecto no puede llenar ({destino} sin ciudad, {giro} sin subtipo), NO se abre
//    con el marcador sin resolver ni con un dato inventado: se dice que falta.
import type { ProspectoMapa, TaxonomiaApi } from "./datos.ts";
import { esEtapaTerminal } from "./embudo.ts";

export type Canal = "whatsapp" | "correo";

export type EstadoMensaje =
  | { readonly tipo: "listo"; readonly texto: string; readonly href: string }
  | { readonly tipo: "bloqueado"; readonly motivo: string }
  | { readonly tipo: "incompleto"; readonly motivo: string }
  | { readonly tipo: "sin_destino" };

const MARCADORES_NEGOCIO = new Set(["restaurante", "hotel", "gestora", "empresa", "negocio"]);

/** Rellena los marcadores {x} del texto base con datos REALES del prospecto; devuelve los que no pudo llenar. */
export function rellenarMarcadores(
  plantilla: string,
  p: ProspectoMapa,
  subtipoNombre: string | null,
): { readonly texto: string; readonly faltan: readonly string[] } {
  const faltan: string[] = [];
  const texto = plantilla.replace(/\{([a-z_]+)\}/gu, (_m, clave: string) => {
    let valor: string | null = null;
    if (clave === "nombre") valor = p.contacto ? p.contacto.split(/\s+/u)[0]! : "equipo de " + p.empresa;
    else if (MARCADORES_NEGOCIO.has(clave)) valor = p.empresa;
    else if (clave === "destino") valor = p.municipio ?? p.ciudad;
    else if (clave === "giro" || clave === "tipo") valor = subtipoNombre;
    if (valor === null || valor === "") {
      if (!faltan.includes(clave)) faltan.push(clave);
      return `{${clave}}`;
    }
    return valor;
  });
  return { texto, faltan };
}

function nombreSubtipo(p: ProspectoMapa, tax: TaxonomiaApi | undefined): string | null {
  if (!p.subtipo) return null;
  return tax?.subtipos.find((s) => s.clave === p.subtipo)?.nombre.toLowerCase() ?? null;
}

function textoBase(tax: TaxonomiaApi | undefined, canal: Canal): string | null {
  const m = tax?.mensajesBase.find((x) => x.canal === canal) ?? (canal === "correo" ? tax?.mensajesBase.find((x) => x.canal === "whatsapp") : undefined);
  return m?.texto ?? null;
}

/** Motivo por el que NO se puede contactar a este prospecto por este canal, o null si se puede. */
export function motivoBloqueo(p: ProspectoMapa, canal: Canal): string | null {
  if (esEtapaTerminal(p.estado)) return "El prospecto ya está en un desenlace final.";
  if (p.contactoLegado || p.baseLicitud === null) return "Sin base de licitud registrada: no contactar hasta registrarla.";
  if (canal === "whatsapp" && p.suprimidoTelefono) return "Este teléfono está en la lista de supresión: no contactar.";
  if (canal === "correo" && p.suprimidoCorreo) return "Este correo está en la lista de supresión: no contactar.";
  if (!p.supresionVerificada) return "No se pudo verificar la lista de supresión (SA-L-46): no contactar hasta que esté disponible.";
  return null;
}

export function hrefWhatsapp(telefono: string, texto: string): string | null {
  const digitos = telefono.replace(/\D/gu, "");
  if (digitos.length < 10) return null;
  const numero = digitos.startsWith("52") && digitos.length >= 12 ? digitos : `52${digitos.slice(-10)}`;
  return `https://wa.me/${numero}?text=${encodeURIComponent(texto)}`;
}

export function hrefCorreo(correo: string, texto: string): string {
  return `mailto:${correo}?body=${encodeURIComponent(texto.replace(/\n/gu, "\r\n"))}`;
}

/** Enlace tel: del telefono, o null si la guarda de contacto lo niega (supresion, sin base de licitud, supresion sin verificar). */
export function hrefTelefonoSiPermitido(p: ProspectoMapa): string | null {
  if (!p.telefono || motivoBloqueo(p, "whatsapp") !== null) return null;
  return `tel:${p.telefono}`;
}

/** Enlace mailto: del correo (sin texto), o null si la guarda de contacto lo niega. */
export function hrefCorreoSiPermitido(p: ProspectoMapa): string | null {
  if (!p.correo || motivoBloqueo(p, "correo") !== null) return null;
  return `mailto:${p.correo}`;
}

/** Lo que muestra y abre el boton de un canal para un prospecto. */
export function estadoMensaje(p: ProspectoMapa, canal: Canal, tax: TaxonomiaApi | undefined): EstadoMensaje {
  const destino = canal === "whatsapp" ? p.telefono : p.correo;
  if (destino === null) return { tipo: "sin_destino" };
  const bloqueo = motivoBloqueo(p, canal);
  if (bloqueo) return { tipo: "bloqueado", motivo: bloqueo };
  const base = textoBase(tax, canal);
  if (base === null) return { tipo: "incompleto", motivo: "La taxonomía de esta vertical todavía no tiene un mensaje base." };
  const { texto, faltan } = rellenarMarcadores(base, p, nombreSubtipo(p, tax));
  if (faltan.length > 0) return { tipo: "incompleto", motivo: `Falta ${faltan.join(", ")} para armar el mensaje: complétalo en la ficha.` };
  const href = canal === "whatsapp" ? hrefWhatsapp(destino, texto) : hrefCorreo(destino, texto);
  if (href === null) return { tipo: "incompleto", motivo: "El teléfono no tiene un formato válido." };
  return { tipo: "listo", texto, href };
}
