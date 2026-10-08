// CFO-08 · importación de reportes de SoftRestaurant EN EL NAVEGADOR: detecta la fila de encabezados, sugiere el mapeo de columnas con los alias
// INFERIDOS del dominio (`ALIAS_SR_INFERIDOS`, no se copian), EXCLUYE las columnas de datos personales y arma la tabla que recibe la API.
//
// Privacidad (diseño §3.7): la barrera es una LISTA BLANCA POR TIPO DE VALOR, no el encabezado. Solo viajan las columnas que la persona mapeó a un campo
// conocido y cada celda pasa por el parser estricto de ese campo (dinero, fecha, hora, entero pequeño, sí/no, enumerado cerrado, folio): lo que no pasa no viaja
// (el renglón entero se deja en blanco y se informa como error por renglón, sin mostrar el valor). Un nombre, un teléfono en cualquier formato, un correo, un RFC o un
// número de tarjeta no entran por ningún campo. La detección de columnas personales por encabezado (`esColumnaPersonal`) es solo ayuda de UX: oculta esas
// columnas de los selectores y las lista (solo nombre o posición); la persona puede recuperarlas con una casilla y siguen sometidas al parser de su campo.
// La lectura del archivo (CSV/XLSX, tope de 5 MB, huella) es la de `lib/clientes-importacion.ts`; aquí no se vuelve a escribir.
import { ALIAS_SR_INFERIDOS, esColumnaPersonal, normalizarEncabezado, normalizarTipoServicio, parsearFechaSr, parsearMontoCentavos } from "@atiende/domain-restaurantes/cfo";
import type { TipoLayoutSr } from "@atiende/domain-restaurantes/cfo";

export { ArchivoImportacionError, IMPORTACION_MAX_BYTES, leerArchivoClientes as leerArchivoSr } from "../lib/clientes-importacion.ts";
export type { ArchivoLeido as ArchivoSrLeido } from "../lib/clientes-importacion.ts";

export const TIPOS_REPORTE_SR: ReadonlyArray<{ readonly valor: TipoLayoutSr; readonly etiqueta: string; readonly ayuda: string }> = [
  { valor: "resumen_servicio", etiqueta: "Ventas por tipo de servicio", ayuda: "Un renglón por día y tipo de servicio (comedor, para llevar, domicilio, rápido)." },
  { valor: "cuentas", etiqueta: "Listado de cuentas / tickets", ayuda: "Un renglón por cuenta, con su folio." },
];

export type CampoSr = string;

export interface DefinicionCampoSr {
  readonly campo: CampoSr;
  readonly etiqueta: string;
  readonly requerido: boolean;
}

const ETIQUETAS: Readonly<Record<string, string>> = {
  folio: "Folio de la cuenta",
  fecha: "Fecha",
  hora: "Hora",
  servicio: "Tipo de servicio",
  total: "Total",
  subtotal: "Subtotal",
  descuento: "Descuento",
  propina: "Propina",
  forma_pago: "Forma de pago",
  cancelada: "Cancelada",
  cancelado: "Importe cancelado",
  impuesto: "Impuesto (IVA)",
  tickets: "Número de cuentas",
};

const REQUERIDOS: Readonly<Record<TipoLayoutSr, readonly string[]>> = { cuentas: ["folio", "fecha", "total"], resumen_servicio: ["fecha", "servicio", "total"] };

export function camposDeTipo(tipo: TipoLayoutSr): readonly DefinicionCampoSr[] {
  const aliases = tipo === "cuentas" ? ALIAS_SR_INFERIDOS.cuentas : ALIAS_SR_INFERIDOS.resumen_servicio;
  return Object.keys(aliases).map((campo) => ({ campo, etiqueta: ETIQUETAS[campo] ?? campo, requerido: REQUERIDOS[tipo].includes(campo) }));
}

const aliasDe = (tipo: TipoLayoutSr, campo: string): readonly string[] => {
  const tabla: Readonly<Record<string, readonly string[]>> = tipo === "cuentas" ? ALIAS_SR_INFERIDOS.cuentas : ALIAS_SR_INFERIDOS.resumen_servicio;
  return tabla[campo] ?? [];
};

/** Mapeo: campo -> índice de columna del archivo (null = no importar ese dato). */
export type MapeoSr = Readonly<Record<CampoSr, number | null>>;

/** Fila de encabezados: la (entre las primeras 15) con más coincidencias con los alias de ambos layouts, mínimo 2. Sin coincidencias = la primera. */
export function detectarFilaEncabezado(filas: readonly (readonly string[])[]): number {
  const todos = new Set<string>([...Object.values(ALIAS_SR_INFERIDOS.cuentas).flat(), ...Object.values(ALIAS_SR_INFERIDOS.resumen_servicio).flat()]);
  let mejor = 0;
  let max = 1;
  filas.slice(0, 15).forEach((f, i) => {
    const n = [...new Set(f.map(normalizarEncabezado))].filter((h) => todos.has(h)).length;
    if (n > max) {
      max = n;
      mejor = i;
    }
  });
  return mejor;
}

/** Layout sugerido: con una columna de folio / cuenta / ticket es el listado de cuentas; si no, el resumen por tipo de servicio. */
export function sugerirTipo(encabezados: readonly string[]): TipoLayoutSr {
  const norm = new Set(encabezados.map(normalizarEncabezado));
  return ALIAS_SR_INFERIDOS.cuentas.folio.some((a) => norm.has(a)) ? "cuentas" : "resumen_servicio";
}

const esEtiqueta = (c: string): boolean => c.trim().endsWith(":");
const llenas = (fila: readonly string[]): number => fila.filter((c) => c.trim() !== "").length;

/** Renglones que cuentan como encabezado para la ayuda de UX: el elegido, el que detecta `detectarFilaEncabezado` y, arriba del elegido, los de la misma tabla (mismo ancho ±1, sin pares «etiqueta:»). */
function filasDeEncabezado(filas: readonly (readonly string[])[], filaEncabezado: number): number[] {
  const elegidas = new Set<number>([filaEncabezado, detectarFilaEncabezado(filas)]);
  const ancho = llenas(filas[filaEncabezado] ?? []);
  for (let r = 0; r < filaEncabezado; r++) {
    const f = filas[r] ?? [];
    if (!f.some(esEtiqueta) && Math.abs(llenas(f) - ancho) <= 1 && llenas(f) >= 2) elegidas.add(r);
  }
  return [...elegidas].filter((r) => r >= 0 && r < filas.length).sort((a, b) => a - b);
}

/**
 * Columna sospechosa de ser de clientes -> cómo mostrarla (el encabezado si parece un nombre, sin dígitos; si no, solo su posición: nunca un valor de datos).
 * SOLO AYUDA DE UX: no es la barrera de privacidad (esa es el parser de valores por campo).
 */
export function nombresPersonales(filas: readonly (readonly string[])[], filaEncabezado: number): Map<number, string> {
  const out = new Map<number, string>();
  for (const r of filasDeEncabezado(filas, filaEncabezado)) {
    (filas[r] ?? []).forEach((h, i) => {
      if (h.trim() !== "" && esColumnaPersonal(h) && !out.has(i)) out.set(i, /\d/.test(h) || h.length > 30 ? `Columna ${i + 1}` : h.trim());
    });
  }
  return new Map([...out.entries()].sort((x, y) => x[0] - y[0]));
}

export function columnasPersonales(filas: readonly (readonly string[])[], filaEncabezado: number): number[] {
  return [...nombresPersonales(filas, filaEncabezado).keys()];
}

// ---- Parsers estrictos por tipo de valor (la barrera) ------------------------------------------------------------------------------------------

type Tipo = "dinero" | "fecha" | "hora" | "entero" | "booleano" | "servicio" | "forma_pago" | "folio";
const TIPO_DE_CAMPO: Readonly<Record<string, Tipo>> = {
  folio: "folio", fecha: "fecha", hora: "hora", servicio: "servicio", total: "dinero", subtotal: "dinero", descuento: "dinero", propina: "dinero", impuesto: "dinero",
  cancelado: "dinero", forma_pago: "forma_pago", cancelada: "booleano", tickets: "entero",
};
const ESPERADO: Readonly<Record<Tipo, string>> = {
  dinero: "un monto como $1,234.50 (sin letras ni espacios)",
  fecha: "una fecha como 21/09/2026 o 2026-09-21 (años 2000 a 2100)",
  hora: "una hora como 14:30",
  entero: "un número entero de hasta 6 dígitos",
  booleano: "Sí o No (o cancelada / activa)",
  servicio: "un tipo de servicio (comedor, para llevar, domicilio, rápido)",
  forma_pago: "una forma de pago (efectivo, tarjeta, transferencia…)",
  folio: "un folio de hasta 24 caracteres con letras, números y guiones, sin espacios y con al menos un número",
};

const RE_CORREO = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const RE_DINERO = [/^[-(]?\$?(\d{1,3}(,\d{3})+|\d+)(\.\d{1,6})?\)?$/, /^-?\$?\d+,\d{1,2}$/, /^-?\$?\d{1,3}(\.\d{3})+,\d{1,2}$/];
const RE_RFC = /^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/i;
const RE_CURP = /^[A-Z]{4}\d{6}[HM][A-Z]{5}[A-Z0-9]\d$/i;
/** Teléfono con formato (separadores, paréntesis o +52) en grupos de teléfono: en el folio pide confirmación; «1234-567-890» no lo es. */
const RE_TEL_CON_FORMATO = /^(\+?5?2?1?[\s.-]?)?(\(\d{2,3}\)|\d{2,3})[\s.-]?\d{3,4}[\s.-]?\d{4}$/;

/** Número de tarjeta: solo dígitos, espacios o guiones y entre 13 y 19 dígitos (defensa PCI barata, en todos los campos). */
export function pareceTarjeta(v: string): boolean {
  const t = v.trim();
  const d = t.replace(/\D/g, "").length;
  return /^[\d\s-]+$/.test(t) && d >= 13 && d <= 19;
}

/** Teléfono con formato: separadores, paréntesis o +52 y 10 dígitos (12/13 con 52/521) que no empiezan con 0. */
export function pareceTelefono(valor: string): boolean {
  const v = valor.trim();
  if (!/^\+?[\d\s().-]{10,20}$/.test(v) || !/[\s().+-]/.test(v)) return false;
  const d = v.replace(/\D/g, "");
  const largo = d.length === 10 ? !d.startsWith("0") : (d.length === 12 && d.startsWith("52")) || (d.length === 13 && d.startsWith("521"));
  return largo && RE_TEL_CON_FORMATO.test(v);
}

function dineroValido(v: string): boolean {
  if (!RE_DINERO.some((r) => r.test(v)) || parsearMontoCentavos(v) === null) return false;
  const limpio = v.replace(/[-()$]/g, "");
  const sinDecimales = /^\d+$/.test(limpio) || /^\d{1,3}(,\d{3})+$/.test(limpio);
  return !(sinDecimales && limpio.replace(/\D/g, "").length >= 10);
}

const FORMAS_PAGO: ReadonlyArray<readonly [RegExp, string]> = [
  [/\befectivo\b/, "efectivo"], [/\b(tarjeta|credito|debito|visa|mastercard|amex)\b/, "tarjeta"], [/\b(transferencia|spei)\b/, "transferencia"], [/\bvales?\b/, "vales"], [/\bcheque\b/, "cheque"],
];
const SERVICIO_ETIQUETA: Readonly<Record<string, string>> = { comedor: "Comedor", para_llevar: "Para llevar", domicilio: "Domicilio", rapido: "Rápido", otro: "Otro" };
const SI = new Set(["si", "s", "1", "true", "verdadero", "x", "yes", "cancelada", "cancelado"]);
const NO = new Set(["no", "n", "0", "false", "falso", "activa", "activo", "pagada", "pagado", "abierta", "cerrada", "cerrado", "vigente"]);

export type ResultadoCelda = { readonly ok: true; readonly valor: string | null } | { readonly ok: false; readonly esperado: string; readonly confirmable?: boolean };

/** Valida y normaliza UNA celda según el tipo de su campo. Texto libre nunca pasa: los enumerados salen de una lista cerrada. */
export function parsearCeldaSr(campo: string, valor: string, opciones: { readonly confirmarFolio?: boolean } = {}): ResultadoCelda {
  const v = valor.trim();
  if (v === "") return { ok: true, valor: null };
  const tipo = TIPO_DE_CAMPO[campo];
  if (!tipo) return { ok: false, esperado: "un dato conocido" };
  const no = (confirmable = false): ResultadoCelda => ({ ok: false, esperado: ESPERADO[tipo], ...(confirmable ? { confirmable: true } : {}) });
  if (RE_CORREO.test(v) || pareceTarjeta(v)) return no();
  const digitos = v.replace(/\D/g, "").length;
  switch (tipo) {
    case "dinero":
      return dineroValido(v) ? { ok: true, valor: v } : no();
    case "fecha":
      return v.length <= 30 && parsearFechaSr(v) !== null ? { ok: true, valor: v } : no();
    case "hora":
      return /^\d{1,2}:\d{2}(:\d{2})?(\s?[ap]\.?\s?m\.?)?$/i.test(v) ? { ok: true, valor: v } : no();
    case "entero":
      return /^\d{1,6}$/.test(v) ? { ok: true, valor: v } : no();
    case "booleano": {
      const n = normalizarEncabezado(v);
      return SI.has(n) ? { ok: true, valor: "Sí" } : NO.has(n) ? { ok: true, valor: "No" } : no();
    }
    case "servicio":
      return digitos >= 7 ? no() : { ok: true, valor: SERVICIO_ETIQUETA[normalizarTipoServicio(v)] ?? "Otro" };
    case "forma_pago": {
      if (digitos >= 7) return no();
      const n = normalizarEncabezado(v);
      return { ok: true, valor: FORMAS_PAGO.find(([re]) => re.test(n))?.[1] ?? "otro" };
    }
    case "folio": {
      if (!/^[A-Za-z0-9][A-Za-z0-9\-_/]{0,23}$/.test(v) || !/\d/.test(v) || RE_RFC.test(v) || RE_CURP.test(v)) return no();
      if (pareceTelefono(v) && !opciones.confirmarFolio) return no(true);
      return { ok: true, valor: v };
    }
  }
}

/** Sugiere la columna de cada campo con los alias inferidos (en su orden de prioridad); una columna se usa una sola vez y nunca una personal. */
export function sugerirMapeoSr(encabezados: readonly string[], tipo: TipoLayoutSr, columnasExcluidas: ReadonlySet<number> = new Set(columnasPersonales([encabezados], 0))): MapeoSr {
  const personales = columnasExcluidas;
  const norm = encabezados.map(normalizarEncabezado);
  const usadas = new Set<number>();
  const out: Record<string, number | null> = {};
  for (const { campo } of camposDeTipo(tipo)) {
    const lista = aliasDe(tipo, campo);
    let mejor: { idx: number; prioridad: number } | null = null;
    norm.forEach((n, idx) => {
      if (usadas.has(idx) || personales.has(idx)) return;
      const prioridad = lista.indexOf(n);
      if (prioridad >= 0 && (mejor === null || prioridad < mejor.prioridad)) mejor = { idx, prioridad };
    });
    const elegido = mejor as { idx: number; prioridad: number } | null;
    out[campo] = elegido ? elegido.idx : null;
    if (elegido) usadas.add(elegido.idx);
  }
  return out;
}

/** Campos requeridos que aún no tienen columna. */
export function camposFaltantes(tipo: TipoLayoutSr, mapeo: MapeoSr): string[] {
  return REQUERIDOS[tipo].filter((c) => mapeo[c] === null || mapeo[c] === undefined);
}

/** Dos campos no pueden leer la misma columna: devuelve los campos que repiten columna. */
export function camposRepetidos(mapeo: MapeoSr): string[] {
  const vistos = new Map<number, string>();
  const repetidos: string[] = [];
  for (const [campo, idx] of Object.entries(mapeo)) {
    if (idx === null || idx === undefined) continue;
    if (vistos.has(idx)) repetidos.push(campo);
    else vistos.set(idx, campo);
  }
  return repetidos;
}

export interface ErrorLocalSr {
  /** Renglón del archivo (1 = primero). */
  readonly renglon: number;
  readonly campo: string;
  /** Etiqueta legible del campo («Forma de pago»). */
  readonly etiqueta: string;
  readonly esperado: string;
  /** Un folio con forma de teléfono con formato: la persona puede confirmar que es un folio. */
  readonly confirmable: boolean;
}

/** «Renglón 5, «Total»: se esperaba un monto… (el valor no se muestra). Corrige esa celda o quita ese renglón del archivo; mientras tanto no se envía.» */
export const MENSAJE_ERROR_LOCAL = (e: ErrorLocalSr): string => `Renglón ${e.renglon}, «${e.etiqueta}»: se esperaba ${e.esperado} (el valor no se muestra). Corrige esa celda o elige otra columna; ese renglón no se envía.`;

export interface TablaSr {
  readonly tabla: Array<Array<string | null>>;
  /** Cuántas columnas del archivo viajan. */
  readonly columnasEnviadas: number;
  /** Celdas que no pasaron su parser: el renglón completo se deja en blanco y no viaja. */
  readonly errores: readonly ErrorLocalSr[];
}

const MAX_ERRORES_LOCALES = 200;

/**
 * Tabla para la API: conserva el número de cada renglón del archivo (los de arriba del encabezado van vacíos), renombra las columnas mapeadas al alias canónico
 * del dominio y NO incluye ninguna otra. Cada celda pasa por el parser de su campo; si una falla, el renglón completo va en blanco (no viaja) y queda en `errores`.
 */
export function construirTablaSr(filas: readonly (readonly string[])[], filaEncabezado: number, tipo: TipoLayoutSr, mapeo: MapeoSr, opciones: { readonly confirmarFolio?: boolean } = {}): TablaSr {
  const campos = camposDeTipo(tipo).filter((c) => mapeo[c.campo] !== null && mapeo[c.campo] !== undefined);
  const errores: ErrorLocalSr[] = [];
  const tabla = filas.map((fila, i): Array<string | null> => {
    if (i < filaEncabezado) return [];
    if (i === filaEncabezado) return campos.map((c) => aliasDe(tipo, c.campo)[0] ?? c.campo);
    const celdas: Array<string | null> = [];
    let rechazado = false;
    for (const c of campos) {
      const r = parsearCeldaSr(c.campo, fila[mapeo[c.campo] as number] ?? "", opciones);
      if (!r.ok) {
        rechazado = true;
        if (errores.length < MAX_ERRORES_LOCALES) errores.push({ renglon: i + 1, campo: c.campo, etiqueta: c.etiqueta, esperado: r.esperado, confirmable: r.confirmable === true });
        break;
      }
      celdas.push(r.valor);
    }
    return rechazado ? [] : celdas;
  });
  return { tabla, columnasEnviadas: campos.length, errores };
}
