// Rn-18 / Rn-19 -- validacion de las entradas del panel (reglas de comision, propiedades, unidades,
// propietarios). Sin IO. Espejo de las validaciones de la migracion 027: la base las vuelve a aplicar
// (defensa en profundidad), esto da el 400 con un mensaje claro antes de tocarla.
import { MONEDAS_PERMITIDAS } from "./tipos.ts";
import type {
  EntradaActualizarPropiedad,
  EntradaActualizarPropietario,
  EntradaActualizarReglaComision,
  EntradaActualizarUnidad,
  EntradaCrearPropiedad,
  EntradaCrearPropietario,
  EntradaCrearUnidad,
  EntradaReglaComision,
  MonedaPermitida,
} from "./tipos.ts";

type Validacion<T> = { readonly ok: true; readonly valor: T } | { readonly ok: false; readonly error: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODIGO_CANAL_RE = /^[a-z][a-z0-9_]{1,39}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function esUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

/** Una zona IANA que el runtime reconoce (`America/Mexico_City`). Un texto cualquiera no pasa. */
export function esZonaHorariaIana(zona: string): boolean {
  if (zona.length === 0 || zona.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(zona)) return false;
  try {
    new Intl.DateTimeFormat("es-MX", { timeZone: zona });
    return true;
  } catch {
    return false;
  }
}

function esObjeto(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}

function texto(o: Record<string, unknown>, campo: string, min: number, max: number): Validacion<string> {
  const v = o[campo];
  if (typeof v !== "string") return { ok: false, error: `${campo}: se esperaba texto.` };
  const t = v.trim();
  if (t.length < min || t.length > max) return { ok: false, error: `${campo}: se esperaba un texto de ${min} a ${max} caracteres.` };
  return { ok: true, valor: t };
}

function moneda(v: unknown): Validacion<MonedaPermitida> {
  if (typeof v !== "string" || !(MONEDAS_PERMITIDAS as readonly string[]).includes(v)) {
    return { ok: false, error: `moneda: se esperaba una de ${MONEDAS_PERMITIDAS.join(", ")}.` };
  }
  return { ok: true, valor: v as MonedaPermitida };
}

function zona(v: unknown): Validacion<string> {
  if (typeof v !== "string" || !esZonaHorariaIana(v.trim())) return { ok: false, error: "zonaHoraria: se esperaba una zona horaria IANA válida (por ejemplo America/Mexico_City)." };
  return { ok: true, valor: v.trim() };
}

function reglaCampos(o: Record<string, unknown>): Validacion<EntradaActualizarReglaComision> {
  if (typeof o.yaNetoDeComision !== "boolean") return { ok: false, error: "yaNetoDeComision: se esperaba true o false." };
  const bps = o.comisionBasisPoints;
  if (typeof bps !== "number" || !Number.isInteger(bps) || bps < 0 || bps > 10000) {
    return { ok: false, error: "comisionBasisPoints: se esperaba un entero entre 0 y 10000 (1500 = 15.00%)." };
  }
  if (o.yaNetoDeComision && bps !== 0) return { ok: false, error: "comisionBasisPoints: un canal que ya entrega el monto neto de comisión debe tener 0 puntos base." };
  const fuente = texto(o, "fuente", 3, 200);
  if (!fuente.ok) return fuente;
  return { ok: true, valor: { yaNetoDeComision: o.yaNetoDeComision, comisionBasisPoints: bps, fuente: fuente.valor } };
}

export function validarEntradaActualizarRegla(raw: unknown): Validacion<EntradaActualizarReglaComision> {
  if (!esObjeto(raw)) return { ok: false, error: "Se esperaba un objeto JSON." };
  return reglaCampos(raw);
}

export function validarEntradaRegla(raw: unknown): Validacion<EntradaReglaComision> {
  if (!esObjeto(raw)) return { ok: false, error: "Se esperaba un objeto JSON." };
  if (typeof raw.canalCodigo !== "string" || !CODIGO_CANAL_RE.test(raw.canalCodigo)) return { ok: false, error: "canalCodigo: código de canal inválido." };
  if (raw.alcance !== "organizacion" && raw.alcance !== "propiedad") return { ok: false, error: "alcance: se esperaba 'organizacion' o 'propiedad'." };
  const campos = reglaCampos(raw);
  if (!campos.ok) return campos;
  return { ok: true, valor: { alcance: raw.alcance, canalCodigo: raw.canalCodigo, ...campos.valor } };
}

export function validarEntradaCrearPropiedad(raw: unknown): Validacion<EntradaCrearPropiedad> {
  if (!esObjeto(raw)) return { ok: false, error: "Se esperaba un objeto JSON." };
  const nombre = texto(raw, "nombre", 2, 120);
  if (!nombre.ok) return nombre;
  const z = zona(raw.zonaHoraria);
  if (!z.ok) return z;
  const m = moneda(raw.moneda);
  if (!m.ok) return m;
  return { ok: true, valor: { nombre: nombre.valor, zonaHoraria: z.valor, moneda: m.valor } };
}

export function validarEntradaActualizarPropiedad(raw: unknown): Validacion<EntradaActualizarPropiedad> {
  if (!esObjeto(raw)) return { ok: false, error: "Se esperaba un objeto JSON." };
  const valor: { nombre?: string; zonaHoraria?: string; moneda?: MonedaPermitida } = {};
  if (raw.nombre !== undefined) {
    const n = texto(raw, "nombre", 2, 120);
    if (!n.ok) return n;
    valor.nombre = n.valor;
  }
  if (raw.zonaHoraria !== undefined) {
    const z = zona(raw.zonaHoraria);
    if (!z.ok) return z;
    valor.zonaHoraria = z.valor;
  }
  if (raw.moneda !== undefined) {
    const m = moneda(raw.moneda);
    if (!m.ok) return m;
    valor.moneda = m.valor;
  }
  if (Object.keys(valor).length === 0) return { ok: false, error: "Indica al menos un campo a cambiar: nombre, zonaHoraria o moneda." };
  return { ok: true, valor };
}

function minimoNoches(v: unknown): Validacion<number> {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 365) return { ok: false, error: "duracionMinimaNoches: se esperaba un entero entre 1 y 365." };
  return { ok: true, valor: v };
}

export function validarEntradaCrearUnidad(raw: unknown): Validacion<EntradaCrearUnidad> {
  if (!esObjeto(raw)) return { ok: false, error: "Se esperaba un objeto JSON." };
  const nombre = texto(raw, "nombre", 1, 120);
  if (!nombre.ok) return nombre;
  let propietarioId: string | null = null;
  if (raw.propietarioId !== undefined && raw.propietarioId !== null) {
    if (!esUuid(raw.propietarioId)) return { ok: false, error: "propietarioId: se esperaba un UUID." };
    propietarioId = raw.propietarioId;
  }
  let duracionMinimaNoches = 1;
  if (raw.duracionMinimaNoches !== undefined) {
    const d = minimoNoches(raw.duracionMinimaNoches);
    if (!d.ok) return d;
    duracionMinimaNoches = d.valor;
  }
  return { ok: true, valor: { nombre: nombre.valor, propietarioId, duracionMinimaNoches } };
}

export function validarEntradaActualizarUnidad(raw: unknown): Validacion<EntradaActualizarUnidad> {
  if (!esObjeto(raw)) return { ok: false, error: "Se esperaba un objeto JSON." };
  const valor: { nombre?: string; propietarioId?: string | null; duracionMinimaNoches?: number } = {};
  if (raw.nombre !== undefined) {
    const n = texto(raw, "nombre", 1, 120);
    if (!n.ok) return n;
    valor.nombre = n.valor;
  }
  if (raw.propietarioId !== undefined) {
    if (raw.propietarioId !== null && !esUuid(raw.propietarioId)) return { ok: false, error: "propietarioId: se esperaba un UUID o null para quitarlo." };
    valor.propietarioId = raw.propietarioId as string | null;
  }
  if (raw.duracionMinimaNoches !== undefined) {
    const d = minimoNoches(raw.duracionMinimaNoches);
    if (!d.ok) return d;
    valor.duracionMinimaNoches = d.valor;
  }
  if (Object.keys(valor).length === 0) return { ok: false, error: "Indica al menos un campo a cambiar: nombre, propietarioId o duracionMinimaNoches." };
  return { ok: true, valor };
}

function emailOpcional(v: unknown): Validacion<string | null> {
  if (v === null) return { ok: true, valor: null };
  if (typeof v !== "string") return { ok: false, error: "email: se esperaba texto o null." };
  const t = v.trim().toLowerCase();
  if (t === "") return { ok: true, valor: null };
  if (t.length > 200 || !EMAIL_RE.test(t)) return { ok: false, error: "email: correo inválido." };
  return { ok: true, valor: t };
}

export function validarEntradaCrearPropietario(raw: unknown): Validacion<EntradaCrearPropietario> {
  if (!esObjeto(raw)) return { ok: false, error: "Se esperaba un objeto JSON." };
  const nombre = texto(raw, "nombre", 2, 120);
  if (!nombre.ok) return nombre;
  const email = raw.email === undefined ? ({ ok: true, valor: null } as const) : emailOpcional(raw.email);
  if (!email.ok) return email;
  return { ok: true, valor: { nombre: nombre.valor, email: email.valor } };
}

export function validarEntradaActualizarPropietario(raw: unknown): Validacion<EntradaActualizarPropietario> {
  if (!esObjeto(raw)) return { ok: false, error: "Se esperaba un objeto JSON." };
  const valor: { nombre?: string; email?: string | null } = {};
  if (raw.nombre !== undefined) {
    const n = texto(raw, "nombre", 2, 120);
    if (!n.ok) return n;
    valor.nombre = n.valor;
  }
  if (raw.email !== undefined) {
    const e = emailOpcional(raw.email);
    if (!e.ok) return e;
    valor.email = e.valor;
  }
  if (Object.keys(valor).length === 0) return { ok: false, error: "Indica al menos un campo a cambiar: nombre o email." };
  return { ok: true, valor };
}
