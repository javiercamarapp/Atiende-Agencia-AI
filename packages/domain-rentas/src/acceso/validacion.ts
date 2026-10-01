// Rn-04 -- validación de las entradas de staff (política e instrucciones). Sin IO.
import { HORAS_ANTES_MAX, HORAS_ANTES_MIN } from "./tipos.ts";

const HORA_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export interface EntradaPolitica {
  readonly activo: boolean;
  readonly horasAntesCheckin: number;
  readonly horaCheckin: string;
  readonly exigirPago: boolean;
  readonly otaCuentaComoPagada: boolean;
}

export function validarPolitica(raw: unknown): { ok: true; valor: EntradaPolitica } | { ok: false; error: string } {
  if (typeof raw !== "object" || raw === null) return { ok: false, error: "Se esperaba un objeto JSON." };
  const o = raw as Record<string, unknown>;
  for (const campo of ["activo", "exigir_pago", "ota_cuenta_como_pagada"]) {
    if (typeof o[campo] !== "boolean") return { ok: false, error: `${campo}: se esperaba true o false.` };
  }
  const horas = o.horas_antes_checkin;
  if (typeof horas !== "number" || !Number.isInteger(horas) || horas < HORAS_ANTES_MIN || horas > HORAS_ANTES_MAX) {
    return { ok: false, error: `horas_antes_checkin: se esperaba un entero entre ${HORAS_ANTES_MIN} y ${HORAS_ANTES_MAX}.` };
  }
  const hora = o.hora_checkin;
  if (typeof hora !== "string" || !HORA_RE.test(hora)) return { ok: false, error: "hora_checkin: se esperaba HH:MM (24 h)." };
  return { ok: true, valor: { activo: o.activo as boolean, horasAntesCheckin: horas, horaCheckin: hora, exigirPago: o.exigir_pago as boolean, otaCuentaComoPagada: o.ota_cuenta_como_pagada as boolean } };
}

export interface EntradaInstruccion {
  readonly direccionExacta: string;
  readonly codigoAcceso: string | null;
  readonly instrucciones: string | null;
}

function textoOpcional(v: unknown, campo: string, max: number): { ok: true; valor: string | null } | { ok: false; error: string } {
  if (v === undefined || v === null) return { ok: true, valor: null };
  if (typeof v !== "string") return { ok: false, error: `${campo}: se esperaba texto.` };
  const t = v.trim();
  if (t === "") return { ok: true, valor: null };
  if (t.length > max) return { ok: false, error: `${campo}: máximo ${max} caracteres.` };
  return { ok: true, valor: t };
}

export function validarInstruccion(raw: unknown): { ok: true; valor: EntradaInstruccion } | { ok: false; error: string } {
  if (typeof raw !== "object" || raw === null) return { ok: false, error: "Se esperaba un objeto JSON." };
  const o = raw as Record<string, unknown>;
  if (typeof o.direccion_exacta !== "string" || o.direccion_exacta.trim() === "") return { ok: false, error: "direccion_exacta: es obligatoria." };
  const direccion = o.direccion_exacta.trim();
  if (direccion.length > 500) return { ok: false, error: "direccion_exacta: máximo 500 caracteres." };
  const codigo = textoOpcional(o.codigo_acceso, "codigo_acceso", 100);
  if (!codigo.ok) return codigo;
  const instr = textoOpcional(o.instrucciones, "instrucciones", 2000);
  if (!instr.ok) return instr;
  return { ok: true, valor: { direccionExacta: direccion, codigoAcceso: codigo.valor, instrucciones: instr.valor } };
}
