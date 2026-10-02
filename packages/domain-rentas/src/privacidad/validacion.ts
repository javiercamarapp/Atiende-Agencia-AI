import { ARCO_CANALES, ARCO_DERECHOS, ARCO_ESTADOS_DESTINO, ARCO_RECEPCION_MAX_DIAS_ATRAS } from "./tipos.ts";
import type { ArcoCanal, ArcoDerecho, ArcoEstadoDestino, EntradaSolicitudArco } from "./tipos.ts";

export type ValidacionArco<T> = { readonly ok: true; readonly valor: T } | { readonly ok: false; readonly error: string };

const NOMBRE_MAX = 120;
const CONTACTO_MAX = 160;
const DETALLE_MAX = 500;
const NOTA_MAX = 1000;

function texto(v: unknown, campo: string, max: number, obligatorio: boolean): ValidacionArco<string | null> {
  if (v === undefined || v === null || (typeof v === "string" && v.trim() === "")) {
    return obligatorio ? { ok: false, error: `${campo}: es obligatorio.` } : { ok: true, valor: null };
  }
  if (typeof v !== "string") return { ok: false, error: `${campo}: se esperaba texto.` };
  const t = v.trim();
  if (t.length > max) return { ok: false, error: `${campo}: maximo ${max} caracteres.` };
  return { ok: true, valor: t };
}

export function validarSolicitudArco(body: unknown, ahora: Date = new Date()): ValidacionArco<EntradaSolicitudArco> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false, error: "El cuerpo debe ser un objeto JSON." };
  const b = body as Record<string, unknown>;
  if (typeof b.derecho !== "string" || !(ARCO_DERECHOS as readonly string[]).includes(b.derecho)) return { ok: false, error: `derecho: se esperaba uno de ${ARCO_DERECHOS.join(", ")}.` };
  if (typeof b.canal !== "string" || !(ARCO_CANALES as readonly string[]).includes(b.canal)) return { ok: false, error: `canal: se esperaba uno de ${ARCO_CANALES.join(", ")}.` };
  const nombre = texto(b.solicitanteNombre, "solicitanteNombre", NOMBRE_MAX, true);
  if (!nombre.ok) return nombre;
  const contacto = texto(b.solicitanteContacto, "solicitanteContacto", CONTACTO_MAX, true);
  if (!contacto.ok) return contacto;
  const detalle = texto(b.detalle, "detalle", DETALLE_MAX, false);
  if (!detalle.ok) return detalle;
  let recibidaEn: string | null = null;
  if (b.recibidaEn !== undefined && b.recibidaEn !== null && b.recibidaEn !== "") {
    if (typeof b.recibidaEn !== "string" || !Number.isFinite(Date.parse(b.recibidaEn))) return { ok: false, error: "recibidaEn: se esperaba una fecha ISO valida." };
    const ms = Date.parse(b.recibidaEn);
    if (ms > ahora.getTime() + 5 * 60_000) return { ok: false, error: "recibidaEn: no puede ser futura." };
    if (ms < ahora.getTime() - ARCO_RECEPCION_MAX_DIAS_ATRAS * 24 * 3600 * 1000) return { ok: false, error: `recibidaEn: no puede ser anterior a ${ARCO_RECEPCION_MAX_DIAS_ATRAS} dias.` };
    recibidaEn = new Date(ms).toISOString();
  }
  return { ok: true, valor: { derecho: b.derecho as ArcoDerecho, canal: b.canal as ArcoCanal, solicitanteNombre: nombre.valor as string, solicitanteContacto: contacto.valor as string, detalle: detalle.valor, recibidaEn } };
}

export function validarCambioEstadoArco(body: unknown): ValidacionArco<{ estado: ArcoEstadoDestino; nota: string | null }> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false, error: "El cuerpo debe ser un objeto JSON." };
  const b = body as Record<string, unknown>;
  if (typeof b.estado !== "string" || !(ARCO_ESTADOS_DESTINO as readonly string[]).includes(b.estado)) return { ok: false, error: `estado: se esperaba uno de ${ARCO_ESTADOS_DESTINO.join(", ")}.` };
  const nota = texto(b.nota, "nota", NOTA_MAX, false);
  if (!nota.ok) return nota;
  if (b.estado === "rechazada" && nota.valor === null) return { ok: false, error: "Para rechazar una solicitud indica el motivo en `nota`." };
  return { ok: true, valor: { estado: b.estado as ArcoEstadoDestino, nota: nota.valor } };
}
