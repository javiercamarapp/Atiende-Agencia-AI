// Export de feed `.ics` propio por unidad/canal — port ~literal de
// rentas/packages/adapters/src/ical/exportador.ts (repo origen, H-026, D-004 capa 1
// del anti-eco). El `UID` exportado lleva SIEMPRE el namespace
// `NAMESPACE_UID_EXPORT` — es la señal que la capa 1 de anti-eco reconoce si el canal
// alguna vez "rebota" este mismo evento de vuelta en su import (ver ../sync/anti-eco.ts).
import { createHash } from "node:crypto";
import type { FechaLocal, Razon } from "../tipos.ts";

export const NAMESPACE_UID_EXPORT = "atiende-rentas";
const DOMINIO_UID_EXPORT = "atiende-rentas.internal";

export function construirUidExportado(ocupacionId: string): string {
  return `${NAMESPACE_UID_EXPORT}-${ocupacionId}@${DOMINIO_UID_EXPORT}`;
}

/** `true` si el `UID` lleva el namespace/dominio propio de exportación — capa 1 del
 * anti-eco (ver ../sync/anti-eco.ts). */
export function esUidNamespacePropio(uid: string): boolean {
  return uid.startsWith(`${NAMESPACE_UID_EXPORT}-`) && uid.endsWith(`@${DOMINIO_UID_EXPORT}`);
}

export interface EntradaHashBloqueo {
  unidadId: string;
  dtstart: FechaLocal;
  dtend: FechaLocal;
  /** Acepta un sufijo (`"RESERVA_CANAL:CANCELLED"`) para que un CANCEL sobre el mismo
   * rango produzca un hash de VERSIÓN distinto al de creación — ver ../sync/motor.ts. */
  razon: Razon | `${Razon}:CANCELLED`;
}

/** Hash de contenido `(unidad, DTSTART, DTEND, razón)` — determinístico, usado tanto
 * para el anti-eco (capa 2) como para la resolución de versión del motor de sync. NO
 * depende del `UID`/`SEQUENCE`/`DTSTAMP` del feed: dos eventos con el mismo rango y
 * razón siempre producen el mismo hash, sin importar de dónde vinieron. */
export function calcularHashContenidoBloqueo(entrada: EntradaHashBloqueo): string {
  const payload = JSON.stringify({ unidadId: entrada.unidadId, dtstart: entrada.dtstart, dtend: entrada.dtend, razon: entrada.razon });
  return createHash("sha256").update(payload).digest("hex");
}

/** Texto genérico y NUNCA con datos de huésped: SUMMARY es solo la razón de bloqueo
 * interna. */
function summaryParaRazon(razon: Razon): string {
  switch (razon) {
    case "RESERVA_CANAL":
      return "Reservado";
    case "BLOQUEO_PROPIETARIO":
      return "Bloqueado por el propietario";
    case "MANTENIMIENTO":
      return "Mantenimiento";
    case "BUFFER_LIMPIEZA":
      return "Buffer de limpieza";
  }
}

function comoDtIcs(fecha: FechaLocal): string {
  return fecha.replaceAll("-", "");
}

/** Pliega (fold) una línea a un máximo de 75 octetos, RFC 5545 §3.1: cada
 * continuación empieza con un único espacio. */
function plegarLinea(linea: string): string {
  const LIMITE = 75;
  if (Buffer.byteLength(linea, "utf8") <= LIMITE) return linea;
  const partes: string[] = [];
  let resto = linea;
  let primero = true;
  while (Buffer.byteLength(resto, "utf8") > (primero ? LIMITE : LIMITE - 1)) {
    const maxLen = primero ? LIMITE : LIMITE - 1;
    let corte = maxLen;
    // Nunca cortar en medio de un carácter UTF-8 multi-byte.
    while (corte > 0 && Buffer.byteLength(resto.slice(0, corte), "utf8") > maxLen) corte--;
    partes.push((primero ? "" : " ") + resto.slice(0, corte));
    resto = resto.slice(corte);
    primero = false;
  }
  partes.push(" " + resto);
  return partes.join("\r\n");
}

export interface BloqueoExportable {
  ocupacionId: string;
  unidadId: string;
  rango: { inicio: FechaLocal; fin: FechaLocal };
  razon: Razon;
  sequence: number;
}

export interface FeedExportado {
  contenidoIcs: string;
  /** Hash de contenido por bloqueo exportado, indexado por `ocupacionId` — se
   * persiste en `rentas.bloqueo_exportado` para la capa 2 del anti-eco (comparación
   * de hash). */
  hashesPorOcupacion: Map<string, string>;
}

export function exportarFeedIcs(nombreCalendario: string, bloqueos: readonly BloqueoExportable[]): FeedExportado {
  const ahora = new Date().toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
  const lineas: string[] = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Atiende Rentas Vacacionales//Export iCal//ES", "CALSCALE:GREGORIAN", plegarLinea(`X-WR-CALNAME:${nombreCalendario}`)];
  const hashesPorOcupacion = new Map<string, string>();

  for (const b of bloqueos) {
    const hash = calcularHashContenidoBloqueo({ unidadId: b.unidadId, dtstart: b.rango.inicio, dtend: b.rango.fin, razon: b.razon });
    hashesPorOcupacion.set(b.ocupacionId, hash);

    lineas.push("BEGIN:VEVENT");
    lineas.push(plegarLinea(`UID:${construirUidExportado(b.ocupacionId)}`));
    lineas.push(`DTSTAMP:${ahora}`);
    lineas.push(`DTSTART;VALUE=DATE:${comoDtIcs(b.rango.inicio)}`);
    lineas.push(`DTEND;VALUE=DATE:${comoDtIcs(b.rango.fin)}`);
    lineas.push(`SEQUENCE:${b.sequence}`);
    lineas.push("STATUS:CONFIRMED");
    lineas.push(plegarLinea(`SUMMARY:${summaryParaRazon(b.razon)}`));
    lineas.push(`X-ATIENDE-RENTAS-HASH:${hash}`);
    lineas.push("END:VEVENT");
  }

  lineas.push("END:VCALENDAR");
  return { contenidoIcs: lineas.join("\r\n") + "\r\n", hashesPorOcupacion };
}
