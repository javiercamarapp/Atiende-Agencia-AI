// CFO-04 · normalizador de exportaciones de SoftRestaurant (lado servidor; lo usa CFO-05 antes de llamar a `sr_importar`).
//
// ┌──────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
// │ ALIAS INFERIDOS. No existe documentación pública del esquema ni de un export real de SoftRestaurant (diseño §2).   │
// │ Los alias de encabezado de abajo son una INFERENCIA razonable (vocabulario de SR: «cuenta», «cheque», «folio»,    │
// │ «tipo de servicio»…) y deben confirmarse con un archivo real. Por eso la importación es con MAPEO ASISTIDO y el   │
// │ resultado lleva `inferido: true` y el mapeo aplicado, para que la UI lo muestre y el dueño lo corrija.            │
// └──────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
//
// Dos layouts: `resumen_servicio` (un renglón por día × tipo de servicio × forma de pago) y `cuentas` (un renglón por cuenta/ticket con folio).
// Reglas: montos «$1,234.50» / «1234,50» -> centavos enteros; fechas dd/mm/aaaa y aaaa-mm-dd -> día de negocio (con hora y corte si vienen);
// columnas de datos personales (nombre, teléfono, correo, dirección, RFC…) -> se RECHAZA el archivo (no se descarta en silencio);
// tipo de servicio desconocido -> `otro`. Sin I/O ni reloj.
import type { FilaSrResumen, FilaSrTicket, TipoLayoutSr, TipoServicioSr } from "./tipos.ts";
import { cmp, fechaNegocioValida, sumarDiasFecha } from "./util.ts";

/** Alias de encabezados INFERIDOS hasta recibir un export real. Cada lista va en orden de prioridad (ya normalizados: sin acentos, minúsculas). */
export const ALIAS_SR_INFERIDOS = {
  inferidos: true,
  aviso: "Alias de columnas inferidos hasta recibir un export real de SoftRestaurant: confirme el mapeo antes de importar.",
  cuentas: {
    folio: ["folio", "cuenta", "ticket", "cheque", "no cuenta", "no de cuenta", "numero de cuenta", "num cuenta", "no ticket", "no de ticket", "numero de ticket", "folio cuenta", "folio ticket", "no cheque", "numero de cheque", "folio cheque"],
    fecha: ["fecha cierre", "fecha de cierre", "fecha", "fecha apertura", "fecha de apertura", "fecha venta", "dia"],
    hora: ["hora cierre", "hora de cierre", "hora", "hora apertura", "hora de apertura"],
    servicio: ["tipo de servicio", "servicio", "tipo servicio", "tipo"],
    total: ["total", "importe total", "total cuenta", "venta total", "total venta", "importe"],
    subtotal: ["subtotal", "sub total", "importe sin impuestos"],
    descuento: ["descuento", "descuentos", "desc", "importe descuento", "total descuentos"],
    propina: ["propina", "propinas", "total propinas"],
    forma_pago: ["forma de pago", "forma pago", "tipo de pago", "metodo de pago", "pago"],
    cancelada: ["cancelada", "cancelado", "estatus", "estado", "status", "cancelacion"],
    impuesto: ["impuesto", "iva", "impuestos"],
  },
  resumen_servicio: {
    fecha: ["fecha", "dia", "fecha venta", "fecha de venta"],
    servicio: ["tipo de servicio", "servicio", "tipo servicio", "tipo", "area servicio"],
    tickets: ["tickets", "cuentas", "no de cuentas", "numero de cuentas", "num cuentas", "cantidad de cuentas", "no cuentas", "numero de tickets", "no de tickets", "cheques", "numero de cheques"],
    subtotal: ["subtotal", "sub total", "venta bruta", "consumo"],
    descuento: ["descuento", "descuentos", "desc", "importe descuento", "total descuentos"],
    cancelado: ["cancelado", "cancelados", "cancelaciones", "importe cancelado", "total cancelado", "cancelada"],
    propina: ["propina", "propinas", "total propinas"],
    impuesto: ["impuesto", "iva", "impuestos", "total iva"],
    total: ["total", "venta total", "venta neta", "total venta", "importe total", "total general", "importe"],
    forma_pago: ["forma de pago", "forma pago", "tipo de pago", "metodo de pago", "pago"],
  },
} as const;

/** Palabras que delatan una columna de datos personales (se comparan contra el encabezado normalizado, palabra completa). */
export const PALABRAS_PERSONALES: readonly string[] = ["nombre", "cliente", "telefono", "tel", "celular", "movil", "whatsapp", "correo", "email", "mail", "direccion", "calle", "colonia", "rfc", "curp"];

export interface RenglonSrCuenta {
  readonly folio: string;
  readonly diaNegocio: string;
  readonly horaLocal: string | null;
  readonly tipoServicio: TipoServicioSr;
  readonly totalCentavos: number;
  readonly descuentoCentavos: number;
  readonly propinaCentavos: number;
  readonly formaPago: string | null;
  readonly cancelado: boolean;
}

export interface RenglonSrResumen {
  readonly diaNegocio: string;
  readonly tipoServicio: TipoServicioSr;
  readonly formaPago: string | null;
  readonly tickets: number;
  readonly brutaCentavos: number;
  readonly descuentoCentavos: number;
  readonly canceladoCentavos: number;
  readonly propinaCentavos: number;
  readonly ivaCentavos: number | null;
  readonly netaCentavos: number;
}

export interface ErrorRenglonSr {
  /** Número de renglón en el archivo (1 = primera fila del archivo). */
  readonly renglon: number;
  readonly campo: string;
  readonly motivo: string;
}

interface Base {
  readonly inferido: true;
  readonly avisoAlias: string;
  /** campo canónico -> encabezado ORIGINAL del archivo que se usó. */
  readonly mapeo: Readonly<Record<string, string>>;
  readonly ignoradas: readonly string[];
  readonly advertencias: readonly string[];
  readonly errores: readonly ErrorRenglonSr[];
  readonly rechazados: number;
  readonly omitidos: number;
  readonly fechaMin: string | null;
  readonly fechaMax: string | null;
}

export type ResultadoNormalizacionSr =
  | (Base & { readonly ok: true; readonly tipo: "cuentas"; readonly renglones: readonly RenglonSrCuenta[]; readonly aceptados: number })
  | (Base & { readonly ok: true; readonly tipo: "resumen_servicio"; readonly renglones: readonly RenglonSrResumen[]; readonly aceptados: number })
  | { readonly ok: false; readonly motivo: "columnas_personales"; readonly columnas: readonly string[]; readonly inferido: true }
  | { readonly ok: false; readonly motivo: "sin_encabezado" | "faltan_columnas"; readonly faltan: readonly string[]; readonly inferido: true }
  | { readonly ok: false; readonly motivo: "demasiados_renglones"; readonly maximo: number; readonly recibidos: number; readonly mensaje: string; readonly inferido: true };

/** Topes de `sr_importar` (brief CFO-03): 1..20,000 cuentas o 1..2,000 renglones de resumen por archivo. */
export const MAX_RENGLONES_SR = { cuentas: 20000, resumen_servicio: 2000 } as const;

// ---- Texto -------------------------------------------------------------------------------------------------------------------------------

export function normalizarEncabezado(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9#]+/g, " ")
    .replace(/#/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

const FRASES_PERSONALES: readonly string[] = ["razon social", "domicilio de entrega", "domicilio entrega", "domicilio del cliente", "domicilio cliente", "codigo postal", "nombre del cliente"];
const RAICES_PERSONALES: readonly string[] = ["telefono", "celular", "correo", "direccion"];

export function esColumnaPersonal(encabezado: string): boolean {
  const norm = normalizarEncabezado(encabezado);
  if (FRASES_PERSONALES.some((f) => norm.includes(f))) return true;
  return norm.split(" ").some(
    (p) => PALABRAS_PERSONALES.includes(p) || /^(tel|cel)\d*$/.test(p) || RAICES_PERSONALES.some((r) => p.startsWith(r)) || /^(email|mail|correo)\d*$/.test(p),
  );
}

/** comedor/mesa · para llevar/mostrador · domicilio/delivery · rápido · lo demás -> otro. */
export function normalizarTipoServicio(texto: string | null | undefined): TipoServicioSr {
  const t = normalizarEncabezado(texto ?? "");
  if (t === "") return "otro";
  if (t.includes("domicilio") || t.includes("delivery")) return "domicilio";
  if (t.includes("llevar") || t.includes("mostrador")) return "para_llevar";
  if (t.includes("comedor") || t === "mesa" || t.startsWith("mesa ")) return "comedor";
  if (t.includes("rapido")) return "rapido";
  return "otro";
}

export function normalizarFormaPago(texto: string | null | undefined): string | null {
  const t = (texto ?? "").trim().replace(/\s+/g, " ").toLowerCase().slice(0, 40);
  return t === "" ? null : t;
}

function esVerdadero(texto: string): boolean {
  const t = normalizarEncabezado(texto);
  return t.includes("cancel") || ["si", "s", "1", "true", "verdadero", "x", "yes"].includes(t);
}

// ---- Montos ------------------------------------------------------------------------------------------------------------------------------

/** «$1,234.50» · «1234,50» · «1.234,50» · «(12.50)» -> centavos enteros (half away from zero en el 3.er decimal). null = no es un monto. */
export function parsearMontoCentavos(entrada: string | number | null | undefined): number | null {
  if (entrada == null) return null;
  let texto: string;
  if (typeof entrada === "number") {
    if (!Number.isFinite(entrada)) return null;
    texto = entrada.toFixed(6);
  } else texto = entrada;
  let t = texto.normalize("NFKC").trim();
  if (t === "") return null;
  let negativo = false;
  if (/^\(.*\)$/.test(t)) { negativo = true; t = t.slice(1, -1); }
  if (t.startsWith("-")) { negativo = !negativo; t = t.slice(1); }
  if (t.endsWith("-")) { negativo = !negativo; t = t.slice(0, -1); }
  t = t.replace(/mxn|mn|pesos?|\$/gi, "").replace(/[\s\u00a0']/g, "");
  if (t === "" || !/^[\d.,]+$/.test(t) || !/\d/.test(t)) return null;

  const ultimaComa = t.lastIndexOf(",");
  const ultimoPunto = t.lastIndexOf(".");
  const comas = (t.match(/,/g) ?? []).length;
  const puntos = (t.match(/\./g) ?? []).length;
  let sepDecimal: "," | "." | null = null;
  if (comas > 0 && puntos > 0) sepDecimal = ultimaComa > ultimoPunto ? "," : ".";
  else if (comas > 0) {
    const tras = t.length - ultimaComa - 1;
    const antes = ultimaComa;
    sepDecimal = comas === 1 && !(tras === 3 && antes >= 1 && antes <= 3) ? "," : null;
  } else if (puntos > 0) {
    sepDecimal = puntos === 1 ? "." : null;
  }
  let entero: string;
  let fraccion = "";
  if (sepDecimal) {
    const i = t.lastIndexOf(sepDecimal);
    entero = t.slice(0, i).replace(/[.,]/g, "");
    fraccion = t.slice(i + 1).replace(/[.,]/g, "");
  } else {
    entero = t.replace(/[.,]/g, "");
  }
  if (entero === "") entero = "0";
  if (!/^\d+$/.test(entero) || (fraccion !== "" && !/^\d+$/.test(fraccion))) return null;
  const f2 = (fraccion + "00").slice(0, 2);
  let centavos = Number(entero) * 100 + Number(f2);
  if (fraccion.length > 2 && Number(fraccion[2]) >= 5) centavos += 1;
  if (!Number.isSafeInteger(centavos)) return null;
  return negativo && centavos !== 0 ? -centavos : centavos;
}

// ---- Fechas ------------------------------------------------------------------------------------------------------------------------------

export interface FechaSr {
  /** Día calendario tal como viene. */
  readonly fecha: string;
  /** HH:MM (24 h) si el archivo la trae. */
  readonly hora: string | null;
}

const HORA_RE = /(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(?:([ap])\.?\s?m\.?)?/i;

function parseHora(t: string): string | null {
  const m = HORA_RE.exec(t);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  const ampm = m[4]?.toLowerCase();
  if (ampm) {
    if (h < 1 || h > 12) return null;
    if (ampm === "p" && h < 12) h += 12;
    if (ampm === "a" && h === 12) h = 0;
  }
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

/** dd/mm/aaaa · dd-mm-aaaa · dd/mm/aa · aaaa-mm-dd (con o sin hora) · serie de Excel. */
export function parsearFechaSr(entrada: string | number | null | undefined): FechaSr | null {
  if (entrada == null) return null;
  if (typeof entrada === "number" || /^\d{5}(\.\d+)?$/.test(String(entrada).trim())) {
    const serie = Number(entrada);
    if (Number.isFinite(serie) && serie >= 20000 && serie < 80000) {
      const dias = Math.floor(serie);
      const fecha = sumarDiasFecha("1899-12-30", dias);
      const seg = Math.round((serie - dias) * 86400);
      const hora = seg > 0 ? `${String(Math.floor(seg / 3600) % 24).padStart(2, "0")}:${String(Math.floor((seg % 3600) / 60)).padStart(2, "0")}` : null;
      return fechaNegocioValida(fecha) ? { fecha, hora } : null;
    }
    if (typeof entrada === "number") return null;
  }
  const t = String(entrada).trim();
  if (t === "") return null;
  let fecha: string | null = null;
  let resto = t;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(.*)$/.exec(t);
  if (m) {
    fecha = `${m[1]}-${m[2]!.padStart(2, "0")}-${m[3]!.padStart(2, "0")}`;
    resto = m[4]!;
  } else {
    m = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4}|\d{2})(.*)$/.exec(t);
    if (m) {
      const anio = m[3]!.length === 2 ? `20${m[3]}` : m[3]!;
      fecha = `${anio}-${m[2]!.padStart(2, "0")}-${m[1]!.padStart(2, "0")}`;
      resto = m[4]!;
    }
  }
  if (!fecha || !fechaNegocioValida(fecha)) return null;
  const rest = resto.replace(/^[T\s,]+/, "");
  const hora = rest === "" ? null : parseHora(rest);
  if (rest !== "" && hora === null) return null;
  return { fecha, hora };
}

/**
 * Día de negocio: una hora ANTERIOR al corte (p. ej. 00:30 con corte 01:00) pertenece al día previo; a partir del corte, al día nuevo.
 * Sin hora, el día calendario es el día de negocio.
 */
export function diaDeNegocio(fecha: string, hora: string | null, corte: string): string {
  if (hora == null) return fecha;
  return hora < corte ? sumarDiasFecha(fecha, -1) : fecha;
}

// ---- CSV ---------------------------------------------------------------------------------------------------------------------------------

function partirLineas(texto: string, delim: string): string[][] {
  const filas: string[][] = [];
  let fila: string[] = [];
  let campo = "";
  let comillas = false;
  const t = texto.replace(/^\uFEFF/, "");
  for (let i = 0; i < t.length; i++) {
    const c = t[i]!;
    if (comillas) {
      if (c === '"') {
        if (t[i + 1] === '"') { campo += '"'; i++; } else comillas = false;
      } else campo += c;
    } else if (c === '"') comillas = true;
    else if (c === delim) { fila.push(campo); campo = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && t[i + 1] === "\n") i++;
      fila.push(campo); campo = "";
      filas.push(fila); fila = [];
    } else campo += c;
  }
  if (campo !== "" || fila.length > 0) { fila.push(campo); filas.push(fila); }
  return filas.filter((f) => f.some((c) => c.trim() !== ""));
}

/** CSV con delimitador detectado (, ; tab |), comillas, BOM y renglones de título arriba. */
export function parsearCsvSr(texto: string): string[][] {
  let mejor: { delim: string; filas: string[][]; puntaje: number } | null = null;
  for (const delim of [",", ";", "\t", "|"]) {
    const filas = partirLineas(texto, delim);
    const conteo = new Map<number, number>();
    for (const f of filas) conteo.set(f.length, (conteo.get(f.length) ?? 0) + 1);
    let puntaje = 0;
    for (const [cols, n] of conteo) if (cols >= 2) puntaje = Math.max(puntaje, cols * n);
    if (!mejor || puntaje > mejor.puntaje) mejor = { delim, filas, puntaje };
  }
  return mejor?.filas ?? [];
}

// ---- Mapeo de encabezados ----------------------------------------------------------------------------------------------------------------

type CampoCuentas = keyof typeof ALIAS_SR_INFERIDOS.cuentas;
type CampoResumen = keyof typeof ALIAS_SR_INFERIDOS.resumen_servicio;

function mapear(encabezados: readonly string[], aliases: Readonly<Record<string, readonly string[]>>): { mapeo: Map<string, number>; usadas: Set<number> } {
  const norm = encabezados.map(normalizarEncabezado);
  const mapeo = new Map<string, number>();
  const usadas = new Set<number>();
  for (const [campo, lista] of Object.entries(aliases)) {
    let mejor: { idx: number; prioridad: number } | null = null;
    norm.forEach((n, idx) => {
      if (usadas.has(idx)) return;
      const prioridad = lista.indexOf(n);
      if (prioridad >= 0 && (!mejor || prioridad < mejor.prioridad)) mejor = { idx, prioridad };
    });
    if (mejor) {
      const elegido = mejor as { idx: number; prioridad: number };
      mapeo.set(campo, elegido.idx);
      usadas.add(elegido.idx);
    }
  }
  return { mapeo, usadas };
}

function coincidencias(encabezados: readonly string[]): number {
  const norm = new Set(encabezados.map(normalizarEncabezado));
  const todos = new Set<string>([...Object.values(ALIAS_SR_INFERIDOS.cuentas).flat(), ...Object.values(ALIAS_SR_INFERIDOS.resumen_servicio).flat()]);
  let n = 0;
  for (const h of norm) if (todos.has(h)) n += 1;
  return n;
}

function celda(fila: readonly (string | number | null)[], idx: number | undefined): string | number | null {
  return idx === undefined ? null : (fila[idx] ?? null);
}

function texto(v: string | number | null): string {
  return v == null ? "" : String(v).trim();
}

const MAX_ERRORES = 50;

export interface EntradaNormalizarSr {
  /** Tabla ya leída (CSV o XLSX): la primera(s) fila(s) pueden ser títulos; el encabezado se detecta solo. */
  readonly tabla: readonly (readonly (string | number | null)[])[];
  /** Hora de corte del día de negocio de la sucursal, `HH:MM` (p. ej. "01:00" en PM). */
  readonly corte: string;
  /** Si no se da, se detecta: con una columna de folio/cuenta/ticket es `cuentas`; si no, `resumen_servicio`. */
  readonly tipo?: TipoLayoutSr;
}

/** Normaliza una exportación de SR (alias INFERIDOS). Rechaza el archivo completo si trae columnas de datos personales. */
export function normalizarExportSr(entrada: EntradaNormalizarSr): ResultadoNormalizacionSr {
  if (!/^\d{2}:\d{2}$/.test(entrada.corte)) throw new RangeError(`corte inválido: ${entrada.corte}`);
  // 1) Encabezado: la fila (entre las primeras 15) con más coincidencias de alias, mínimo 2.
  let hIdx = -1;
  let hMax = 1;
  entrada.tabla.slice(0, 15).forEach((fila, i) => {
    const n = coincidencias(fila.map(texto));
    if (n > hMax) { hMax = n; hIdx = i; }
  });
  if (hIdx < 0) return { ok: false, motivo: "sin_encabezado", faltan: ["encabezado reconocible"], inferido: true };
  const encabezados = entrada.tabla[hIdx]!.map(texto);

  // 2) Datos personales -> rechazo.
  const personales = encabezados.filter((h) => h !== "" && esColumnaPersonal(h));
  if (personales.length > 0) return { ok: false, motivo: "columnas_personales", columnas: personales, inferido: true };

  // 3) Layout y mapeo.
  const normSet = new Set(encabezados.map(normalizarEncabezado));
  const tieneFolio = ALIAS_SR_INFERIDOS.cuentas.folio.some((a) => normSet.has(a));
  const tipo: TipoLayoutSr = entrada.tipo ?? (tieneFolio ? "cuentas" : "resumen_servicio");
  const { mapeo, usadas } = mapear(encabezados, tipo === "cuentas" ? ALIAS_SR_INFERIDOS.cuentas : ALIAS_SR_INFERIDOS.resumen_servicio);
  const requeridas = tipo === "cuentas" ? ["folio", "fecha", "total"] : ["fecha", "servicio", "total"];
  const faltan = requeridas.filter((c) => !mapeo.has(c));
  if (faltan.length > 0) return { ok: false, motivo: "faltan_columnas", faltan, inferido: true };
  const mapeoOriginal: Record<string, string> = {};
  for (const [campo, idx] of mapeo) mapeoOriginal[campo] = encabezados[idx]!;
  const ignoradas = encabezados.filter((h, i) => h !== "" && !usadas.has(i));
  const base = { inferido: true as const, avisoAlias: ALIAS_SR_INFERIDOS.aviso, mapeo: mapeoOriginal, ignoradas };

  const filas = entrada.tabla.slice(hIdx + 1);
  const maximo = MAX_RENGLONES_SR[tipo];
  const noVacias = filas.filter((f) => !f.every((c) => texto(c) === "")).length;
  if (noVacias > maximo) {
    return { ok: false, motivo: "demasiados_renglones", maximo, recibidos: noVacias, inferido: true, mensaje: `El archivo trae ${noVacias} renglones y el máximo por importación es ${maximo}. Divídalo por periodos e impórtelo en partes.` };
  }
  const errores: ErrorRenglonSr[] = [];
  let erroresTotal = 0;
  let omitidos = 0;
  const advertencias: string[] = [];
  const error = (renglon: number, campo: string, motivo: string): void => {
    erroresTotal += 1;
    if (errores.length < MAX_ERRORES) errores.push({ renglon, campo, motivo });
  };
  const gi = (campo: string): number | undefined => mapeo.get(campo);

  const resolverFecha = (fila: readonly (string | number | null)[], renglon: number): { dia: string; hora: string | null } | null => {
    const f = parsearFechaSr(celda(fila, gi("fecha")));
    if (!f) { error(renglon, "fecha", "fecha inválida (use dd/mm/aaaa o aaaa-mm-dd)"); return null; }
    let hora = f.hora;
    if (hora == null && gi("hora") !== undefined) {
      const raw = texto(celda(fila, gi("hora")));
      if (raw !== "") {
        hora = parseHora(raw);
        if (hora == null) { error(renglon, "hora", "hora inválida"); return null; }
      }
    }
    return { dia: diaDeNegocio(f.fecha, hora, entrada.corte), hora };
  };
  const monto = (fila: readonly (string | number | null)[], campo: string, renglon: number, requerido: boolean): number | null | "error" => {
    if (gi(campo) === undefined) return requerido ? "error" : 0;
    const raw = celda(fila, gi(campo));
    if (raw == null || texto(raw) === "") {
      if (requerido) { error(renglon, campo, "monto vacío"); return "error"; }
      return 0;
    }
    const c = parsearMontoCentavos(raw);
    if (c == null) { error(renglon, campo, "monto inválido"); return "error"; }
    if (c < 0) { error(renglon, campo, "monto negativo no permitido"); return "error"; }
    return c;
  };
  const esTotal = (fila: readonly (string | number | null)[]): boolean => {
    const primera = normalizarEncabezado(texto(fila.find((c) => texto(c) !== "") ?? ""));
    return /^(total|totales|suma|gran total|subtotal)( |$)/.test(primera);
  };

  const rangos = { min: null as string | null, max: null as string | null };
  const marca = (dia: string): void => {
    if (rangos.min === null || dia < rangos.min) rangos.min = dia;
    if (rangos.max === null || dia > rangos.max) rangos.max = dia;
  };

  if (tipo === "cuentas") {
    const out: RenglonSrCuenta[] = [];
    const folios = new Set<string>();
    filas.forEach((fila, i) => {
      const renglon = hIdx + 2 + i;
      if (fila.every((c) => texto(c) === "")) return;
      if (esTotal(fila)) { omitidos += 1; return; }
      const folio = texto(celda(fila, gi("folio")));
      if (folio === "") { error(renglon, "folio", "folio vacío"); return; }
      if (folio.length > 40) { error(renglon, "folio", "folio de más de 40 caracteres"); return; }
      const f = resolverFecha(fila, renglon);
      if (!f) return;
      const total = monto(fila, "total", renglon, true);
      const desc = monto(fila, "descuento", renglon, false);
      const prop = monto(fila, "propina", renglon, false);
      if (total === "error" || total === null || desc === "error" || desc === null || prop === "error" || prop === null) return;
      if (folios.has(folio)) { error(renglon, "folio", `folio duplicado en el archivo (${folio})`); return; }
      folios.add(folio);
      out.push({
        folio,
        diaNegocio: f.dia,
        horaLocal: f.hora,
        tipoServicio: normalizarTipoServicio(texto(celda(fila, gi("servicio")))),
        totalCentavos: total,
        descuentoCentavos: desc,
        propinaCentavos: prop,
        formaPago: normalizarFormaPago(texto(celda(fila, gi("forma_pago")))),
        cancelado: gi("cancelada") !== undefined ? esVerdadero(texto(celda(fila, gi("cancelada")))) : false,
      });
      marca(f.dia);
    });
    if (gi("servicio") === undefined) advertencias.push("El archivo no trae tipo de servicio: todas las cuentas se importan como «otro».");
    if (gi("descuento") === undefined) advertencias.push("El archivo no trae descuento: se importa como $0.00.");
    return { ...base, ok: true, tipo: "cuentas", renglones: out, aceptados: out.length, rechazados: erroresTotal, omitidos, errores, advertencias, fechaMin: rangos.min, fechaMax: rangos.max };
  }

  // resumen_servicio: se AGREGA por (día, servicio, forma de pago) porque la base admite un solo renglón vigente por llave.
  const agg = new Map<string, RenglonSrResumen>();
  let derivoBruta = false;
  filas.forEach((fila, i) => {
    const renglon = hIdx + 2 + i;
    if (fila.every((c) => texto(c) === "")) return;
    if (esTotal(fila)) { omitidos += 1; return; }
    const f = resolverFecha(fila, renglon);
    if (!f) return;
    const neta = monto(fila, "total", renglon, true);
    const desc = monto(fila, "descuento", renglon, false);
    const canc = monto(fila, "cancelado", renglon, false);
    const prop = monto(fila, "propina", renglon, false);
    const sub = gi("subtotal") !== undefined ? monto(fila, "subtotal", renglon, false) : null;
    const iva = gi("impuesto") !== undefined ? monto(fila, "impuesto", renglon, false) : null;
    if (neta === "error" || neta === null || desc === "error" || desc === null || canc === "error" || canc === null || prop === "error" || prop === null || sub === "error" || iva === "error") return;
    let tickets = 0;
    if (gi("tickets") !== undefined) {
      const raw = texto(celda(fila, gi("tickets")));
      const n = raw === "" ? 0 : Number(raw.replace(/[,\s]/g, ""));
      if (!Number.isInteger(n) || n < 0) { error(renglon, "tickets", "número de cuentas inválido"); return; }
      tickets = n;
    }
    const bruta = sub !== null && sub > 0 ? sub : neta + desc;
    if (sub === null || sub === 0) derivoBruta = true;
    const servicio = normalizarTipoServicio(texto(celda(fila, gi("servicio"))));
    const forma = normalizarFormaPago(texto(celda(fila, gi("forma_pago"))));
    const llave = `${f.dia}|${servicio}|${forma ?? ""}`;
    const prev = agg.get(llave);
    agg.set(llave, {
      diaNegocio: f.dia,
      tipoServicio: servicio,
      formaPago: forma,
      tickets: (prev?.tickets ?? 0) + tickets,
      brutaCentavos: (prev?.brutaCentavos ?? 0) + bruta,
      descuentoCentavos: (prev?.descuentoCentavos ?? 0) + desc,
      canceladoCentavos: (prev?.canceladoCentavos ?? 0) + canc,
      propinaCentavos: (prev?.propinaCentavos ?? 0) + prop,
      ivaCentavos: iva === null ? null : (prev?.ivaCentavos ?? 0) + iva,
      netaCentavos: (prev?.netaCentavos ?? 0) + neta,
    });
    marca(f.dia);
  });
  if (gi("tickets") === undefined) advertencias.push("El archivo no trae número de cuentas: los tickets se importan como 0.");
  if (derivoBruta) advertencias.push("La venta bruta no viene en el archivo: se estimó como total + descuento.");
  const renglones = [...agg.values()].sort((a, b) => cmp(a.diaNegocio, b.diaNegocio) || cmp(a.tipoServicio, b.tipoServicio) || cmp((a.formaPago ?? ""), b.formaPago ?? ""));
  return { ...base, ok: true, tipo: "resumen_servicio", renglones, aceptados: renglones.length, rechazados: erroresTotal, omitidos, errores, advertencias, fechaMin: rangos.min, fechaMax: rangos.max };
}

// ---- Salida hacia SQL / dominio ----------------------------------------------------------------------------------------------------------

/** snake_case exactamente como espera `restaurantes.sr_importar` (083) para `cuentas`. Sin llaves de cliente. */
export function renglonesSqlCuentas(r: readonly RenglonSrCuenta[]): Array<Record<string, string | number | boolean | null>> {
  return r.map((x) => ({
    folio: x.folio,
    dia_negocio: x.diaNegocio,
    hora_local: x.horaLocal,
    tipo_servicio: x.tipoServicio,
    total_centavos: x.totalCentavos,
    descuento_centavos: x.descuentoCentavos,
    propina_centavos: x.propinaCentavos,
    forma_pago: x.formaPago,
    cancelado: x.cancelado,
  }));
}

/** snake_case para `resumen_servicio`. */
export function renglonesSqlResumen(r: readonly RenglonSrResumen[]): Array<Record<string, string | number | null>> {
  return r.map((x) => ({
    dia_negocio: x.diaNegocio,
    tipo_servicio: x.tipoServicio,
    forma_pago: x.formaPago,
    tickets: x.tickets,
    bruta_centavos: x.brutaCentavos,
    descuento_centavos: x.descuentoCentavos,
    cancelado_centavos: x.canceladoCentavos,
    propina_centavos: x.propinaCentavos,
    iva_centavos: x.ivaCentavos,
    neta_centavos: x.netaCentavos,
  }));
}

/** Renglones normalizados -> filas del dominio (para cuadre y pruebas), asignándoles la sucursal. */
export function aFilasSrResumen(propertyId: string, r: readonly RenglonSrResumen[]): FilaSrResumen[] {
  return r.map((x) => ({ propertyId, diaNegocio: x.diaNegocio, tipoServicio: x.tipoServicio, formaPago: x.formaPago, tickets: x.tickets, brutaCentavos: x.brutaCentavos, descuentoCentavos: x.descuentoCentavos, canceladoCentavos: x.canceladoCentavos, propinaCentavos: x.propinaCentavos, ivaCentavos: x.ivaCentavos, netaCentavos: x.netaCentavos }));
}

export function aFilasSrTicket(propertyId: string, r: readonly RenglonSrCuenta[]): FilaSrTicket[] {
  return r.map((x) => ({ propertyId, folio: x.folio, diaNegocio: x.diaNegocio, horaLocal: x.horaLocal, tipoServicio: x.tipoServicio, totalCentavos: x.totalCentavos, descuentoCentavos: x.descuentoCentavos, propinaCentavos: x.propinaCentavos, formaPago: x.formaPago, cancelado: x.cancelado }));
}

/** Resume una lista de cuentas en renglones de resumen (Σ por día, servicio y forma de pago), igual que hace `sr_importar` en la base. */
export function derivarResumenDeCuentas(propertyId: string, cuentas: readonly RenglonSrCuenta[]): FilaSrResumen[] {
  const agg = new Map<string, FilaSrResumen>();
  for (const c of cuentas) {
    if (c.cancelado) continue; // las canceladas no son venta; su monto se reporta en `cancelado_centavos`
    const llave = `${c.diaNegocio}|${c.tipoServicio}|${c.formaPago ?? ""}`;
    const p = agg.get(llave);
    agg.set(llave, {
      propertyId,
      diaNegocio: c.diaNegocio,
      tipoServicio: c.tipoServicio,
      formaPago: c.formaPago,
      tickets: (p?.tickets ?? 0) + 1,
      brutaCentavos: (p?.brutaCentavos ?? 0) + c.totalCentavos + c.descuentoCentavos,
      descuentoCentavos: (p?.descuentoCentavos ?? 0) + c.descuentoCentavos,
      canceladoCentavos: p?.canceladoCentavos ?? 0,
      propinaCentavos: (p?.propinaCentavos ?? 0) + c.propinaCentavos,
      ivaCentavos: null,
      netaCentavos: (p?.netaCentavos ?? 0) + c.totalCentavos,
    });
  }
  for (const c of cuentas) {
    if (!c.cancelado) continue;
    const llave = `${c.diaNegocio}|${c.tipoServicio}|${c.formaPago ?? ""}`;
    const p = agg.get(llave);
    if (p) agg.set(llave, { ...p, canceladoCentavos: p.canceladoCentavos + c.totalCentavos });
    else agg.set(llave, { propertyId, diaNegocio: c.diaNegocio, tipoServicio: c.tipoServicio, formaPago: c.formaPago, tickets: 0, brutaCentavos: 0, descuentoCentavos: 0, canceladoCentavos: c.totalCentavos, propinaCentavos: 0, ivaCentavos: null, netaCentavos: 0 });
  }
  return [...agg.values()].sort((a, b) => cmp(a.diaNegocio, b.diaNegocio) || cmp(a.tipoServicio, b.tipoServicio) || cmp((a.formaPago ?? ""), b.formaPago ?? ""));
}

export type { CampoCuentas, CampoResumen };
