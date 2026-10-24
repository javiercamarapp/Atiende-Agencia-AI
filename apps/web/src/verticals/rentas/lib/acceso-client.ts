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

export type EventoAcceso = "liberada" | "omitida_sin_contacto" | "omitida_sin_instrucciones" | "error_envio" | "entregada_manual" | "precheckin_capturado";
export const ETIQUETA_EVENTO_ACCESO: Record<EventoAcceso, string> = {
  liberada: "Instrucciones enviadas",
  omitida_sin_contacto: "No enviada: sin correo del huésped",
  omitida_sin_instrucciones: "No enviada: la unidad no tiene instrucciones",
  error_envio: "Error al enviar (se reintenta)",
  entregada_manual: "Entregada a mano por la plataforma de la reserva",
  precheckin_capturado: "El huésped completó su pre-check-in",
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

// ---- Rn-P3-08/09 (migracion 036) ----

/** Reserva proxima cuyo acceso se omitio por falta de correo del huesped y que nadie ha entregado. */
export interface PendienteEntrega {
  readonly reservaId: string;
  readonly unidadId: string;
  readonly unidadNombre: string;
  readonly canal: string;
  readonly checkIn: string;
  readonly checkOut: string;
  readonly huespedNombre: string | null;
  readonly omitidaEn: string;
}

export interface ConfigPrecheckin {
  /** `false` = la base todavia no tiene la migracion 036. */
  readonly disponible: boolean;
  readonly enlacePublico: string | null;
  readonly textoSugerido: string | null;
  readonly reglamento: string | null;
  readonly reglamentoVersion: number;
}

interface ConfigPrecheckinWire {
  readonly disponible: boolean;
  readonly enlace_publico: string | null;
  readonly texto_sugerido: string | null;
  readonly reglamento: string | null;
  readonly reglamento_version: number;
}
const mapConfigPrecheckin = (w: ConfigPrecheckinWire): ConfigPrecheckin => ({ disponible: w.disponible, enlacePublico: w.enlace_publico, textoSugerido: w.texto_sugerido, reglamento: w.reglamento, reglamentoVersion: w.reglamento_version });

export async function fetchConfigPrecheckin(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<ConfigPrecheckin> {
  return mapConfigPrecheckin(await fetchJson<ConfigPrecheckinWire>(fetchImpl, `${base(apiBaseUrl, propertyId)}/acceso-huesped/precheckin`, token));
}

export async function guardarReglamentoPrecheckin(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, reglamento: string | null): Promise<ConfigPrecheckin> {
  return mapConfigPrecheckin(await sendJson<ConfigPrecheckinWire>(fetchImpl, `${base(apiBaseUrl, propertyId)}/acceso-huesped/precheckin`, token, "PUT", { reglamento }));
}

export async function fetchPendientesEntrega(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<{ disponible: boolean; pendientes: readonly PendienteEntrega[] }> {
  const b = await fetchJson<{
    disponible: boolean;
    pendientes: readonly { reserva_id: string; unidad_id: string; unidad_nombre: string; canal: string; check_in: string; check_out: string; huesped_nombre: string | null; omitida_en: string }[];
  }>(fetchImpl, `${base(apiBaseUrl, propertyId)}/acceso-huesped/pendientes`, token);
  return {
    disponible: b.disponible,
    pendientes: b.pendientes.map((p) => ({ reservaId: p.reserva_id, unidadId: p.unidad_id, unidadNombre: p.unidad_nombre, canal: p.canal, checkIn: p.check_in, checkOut: p.check_out, huespedNombre: p.huesped_nombre, omitidaEn: p.omitida_en })),
  };
}

/** Mensaje con las instrucciones DESCIFRADAS (la lectura queda en la bitacora). El servidor responde `Cache-Control: no-store`: no se guarda en ningun lado. */
export async function fetchMensajeOta(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, reservaId: string): Promise<string | null> {
  const b = await fetchJson<{ disponible: boolean; mensaje: string | null }>(fetchImpl, `${base(apiBaseUrl, propertyId)}/reservas/${reservaId}/acceso-mensaje`, token);
  return b.disponible ? b.mensaje : null;
}

export async function marcarEntregadaManual(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, reservaId: string): Promise<void> {
  await sendJson<{ entregada: boolean }>(fetchImpl, `${base(apiBaseUrl, propertyId)}/reservas/${reservaId}/entrega-manual`, token, "POST", {});
}
