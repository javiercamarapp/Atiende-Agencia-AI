// Rn-04 -- cliente de la liberación de instrucciones de acceso al huésped
// (apps/api/src/routes/verticals/rentas/acceso-huesped.ts). Separado de
// pages/AccesoHuesped.tsx para probarlo en entorno "node".
import { fetchJson, sendJson } from "./admin-client.ts";

export interface PoliticaAcceso {
  readonly activo: boolean;
  readonly horasAntesCheckin: number;
  readonly horaCheckin: string;
  readonly exigirPago: boolean;
  readonly otaCuentaComoPagada: boolean;
}

export interface InstruccionAcceso {
  readonly direccionExacta: string;
  readonly codigoAcceso: string | null;
  readonly instrucciones: string | null;
}

export type EventoAcceso = "liberada" | "omitida_sin_contacto" | "omitida_sin_instrucciones" | "error_envio";
export const ETIQUETA_EVENTO_ACCESO: Record<EventoAcceso, string> = {
  liberada: "Instrucciones enviadas",
  omitida_sin_contacto: "No enviada: sin correo del huésped",
  omitida_sin_instrucciones: "No enviada: la unidad no tiene instrucciones",
  error_envio: "Error al enviar (se reintenta)",
};

export interface EventoBitacoraAcceso {
  readonly id: string;
  readonly reservaId: string;
  readonly evento: EventoAcceso;
  readonly creadoEn: string;
}

export interface ReservaAcceso {
  readonly reservaId: string;
  readonly unidadId: string;
  readonly unidadNombre: string;
  readonly canal: string;
  readonly checkIn: string;
  readonly checkOut: string;
  readonly huespedNombre: string | null;
  readonly pagoConfirmado: boolean;
  readonly liberada: boolean;
}

interface PoliticaWire {
  readonly activo: boolean;
  readonly horas_antes_checkin: number;
  readonly hora_checkin: string;
  readonly exigir_pago: boolean;
  readonly ota_cuenta_como_pagada: boolean;
}
interface InstruccionWire {
  readonly direccion_exacta: string;
  readonly codigo_acceso: string | null;
  readonly instrucciones: string | null;
}

const mapPolitica = (w: PoliticaWire): PoliticaAcceso => ({ activo: w.activo, horasAntesCheckin: w.horas_antes_checkin, horaCheckin: w.hora_checkin, exigirPago: w.exigir_pago, otaCuentaComoPagada: w.ota_cuenta_como_pagada });
const mapInstruccion = (w: InstruccionWire): InstruccionAcceso => ({ direccionExacta: w.direccion_exacta, codigoAcceso: w.codigo_acceso, instrucciones: w.instrucciones });

const base = (apiBaseUrl: string, propertyId: string) => `${apiBaseUrl}/rentas/${propertyId}`;

/** `disponible: false` = la base todavía no tiene la migración 025. */
export async function fetchPoliticaAcceso(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<{ disponible: boolean; configurada: boolean; politica: PoliticaAcceso | null }> {
  const b = await fetchJson<{ disponible: boolean; configurada: boolean; politica: PoliticaWire | null }>(fetchImpl, `${base(apiBaseUrl, propertyId)}/acceso-huesped/politica`, token);
  return { disponible: b.disponible, configurada: b.configurada, politica: b.politica ? mapPolitica(b.politica) : null };
}

export async function guardarPoliticaAcceso(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, p: PoliticaAcceso): Promise<PoliticaAcceso> {
  const b = await sendJson<{ politica: PoliticaWire }>(fetchImpl, `${base(apiBaseUrl, propertyId)}/acceso-huesped/politica`, token, "PUT", {
    activo: p.activo,
    horas_antes_checkin: p.horasAntesCheckin,
    hora_checkin: p.horaCheckin,
    exigir_pago: p.exigirPago,
    ota_cuenta_como_pagada: p.otaCuentaComoPagada,
  });
  return mapPolitica(b.politica);
}

export async function fetchInstruccionAcceso(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, unidadId: string): Promise<{ disponible: boolean; instrucciones: InstruccionAcceso | null }> {
  const b = await fetchJson<{ disponible: boolean; instrucciones: InstruccionWire | null }>(fetchImpl, `${base(apiBaseUrl, propertyId)}/unidades/${unidadId}/acceso-instrucciones`, token);
  return { disponible: b.disponible, instrucciones: b.instrucciones ? mapInstruccion(b.instrucciones) : null };
}

export async function guardarInstruccionAcceso(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, unidadId: string, i: InstruccionAcceso): Promise<InstruccionAcceso> {
  const b = await sendJson<{ instrucciones: InstruccionWire }>(fetchImpl, `${base(apiBaseUrl, propertyId)}/unidades/${unidadId}/acceso-instrucciones`, token, "PUT", {
    direccion_exacta: i.direccionExacta,
    codigo_acceso: i.codigoAcceso,
    instrucciones: i.instrucciones,
  });
  return mapInstruccion(b.instrucciones);
}

export async function fetchReservasAcceso(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<{ disponible: boolean; reservas: readonly ReservaAcceso[] }> {
  const b = await fetchJson<{
    disponible: boolean;
    reservas: readonly { reserva_id: string; unidad_id: string; unidad_nombre: string; canal: string; check_in: string; check_out: string; huesped_nombre: string | null; pago_confirmado: boolean; liberada: boolean }[];
  }>(fetchImpl, `${base(apiBaseUrl, propertyId)}/acceso-huesped/reservas`, token);
  return {
    disponible: b.disponible,
    reservas: b.reservas.map((r) => ({ reservaId: r.reserva_id, unidadId: r.unidad_id, unidadNombre: r.unidad_nombre, canal: r.canal, checkIn: r.check_in, checkOut: r.check_out, huespedNombre: r.huesped_nombre, pagoConfirmado: r.pago_confirmado, liberada: r.liberada })),
  };
}

export async function confirmarPagoReserva(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, reservaId: string, confirmado: boolean): Promise<boolean> {
  const b = await sendJson<{ pago_confirmado: boolean }>(fetchImpl, `${base(apiBaseUrl, propertyId)}/reservas/${reservaId}/pago-confirmado`, token, "POST", { confirmado });
  return b.pago_confirmado;
}

export async function fetchBitacoraAcceso(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<{ disponible: boolean; eventos: readonly EventoBitacoraAcceso[] }> {
  const b = await fetchJson<{ disponible: boolean; eventos: readonly { id: string; reserva_id: string; evento: EventoAcceso; creado_en: string }[] }>(fetchImpl, `${base(apiBaseUrl, propertyId)}/acceso-huesped/bitacora?limite=30`, token);
  return { disponible: b.disponible, eventos: b.eventos.map((e) => ({ id: e.id, reservaId: e.reserva_id, evento: e.evento, creadoEn: e.creado_en })) };
}
