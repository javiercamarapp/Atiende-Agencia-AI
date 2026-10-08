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

/** Renglones que cuentan para la ayuda de UX: SOLO el elegido y el que detecta `detectarFilaEncabezado`. Ningún título ni renglón de datos marca columnas. */
function filasDeEncabezado(filas: readonly (readonly string[])[], filaEncabezado: number): number[] {
  return [...new Set([filaEncabezado, detectarFilaEncabezado(filas)])].filter((r) => r >= 0 && r < filas.length).sort((a, b) => a - b);
}

/**
 * Columna sospechosa de ser de clientes -> cómo mostrarla (el encabezado si parece un nombre, sin dígitos; si no, solo su posición: nunca un valor de datos).
 * SOLO AYUDA DE UX: no es la barrera de privacidad (esa es el parser de valores por campo).
 */
export function nombresPersonales(filas: readonly (readonly string[])[], filaEncabezado: number): Map<number, string> {
  const out = new Map<number, string>();
  for (const r of filasDeEncabezado(filas, filaEncabezado)) {
    (filas[r] ?? []).forEach((h, i) => {
      // Solo el renglón ELEGIDO es un encabezado que se puede nombrar; el texto de cualquier otro renglón es dato del negocio: ahí solo la posición.
      if (h.trim() !== "" && esColumnaPersonal(h) && !out.has(i)) out.set(i, r === filaEncabezado && !/\d/.test(h) && h.length <= 30 ? h.trim() : `Columna ${i + 1}`);
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
  dinero: "un monto como $1,234.50 (puede llevar $, signo menos, MXN y separadores de miles)",
  fecha: "una fecha como 21/09/2026 o 2026-09-21 (años 2000 a 2100)",
  hora: "una hora como 14:30",
  entero: "un número entero de hasta 6 dígitos (1,234 también sirve)",
  booleano: "una palabra corta sin números (Sí/No, cancelada, normal…)",
  servicio: "un tipo de servicio (comedor, para llevar, domicilio, rápido)",
  forma_pago: "una forma de pago (efectivo, tarjeta, transferencia…)",
  folio: "un folio de hasta 24 caracteres (letras, números, guiones o #; un solo espacio como en «A 001») con al menos un número",
};

const RE_CORREO = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const RE_DINERO = [/^[-(]?\$?(\d{1,3}(,\d{3})+|\d+)(\.\d{1,6})?\)?$/, /^-?\$?\d+,\d{1,2}$/, /^-?\$?\d{1,3}(\.\d{3})+,\d{1,2}$/];
const RE_FOLIO = /^(#?[A-Za-z0-9][A-Za-z0-9\-_/]*|[A-Za-z]{1,3} #?\d+)$/;
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

const SEPARADOR_MILES = /(?<=\d)[ '’\u00a0\u2009\u202f](?=\d{3}(?!\d))/g;

/** «$ 1,234.50», «$-50.00», «50.00-», «1,234.50 MXN», «1 234.50» y «$1'234.50» -> «1234.50» (centavos exactos); null si no es un monto. Sin letras arbitrarias, sin teléfonos ni enteros de 10 dígitos o más. */
export function normalizarDinero(entrada: string): string | null {
  let v = entrada.trim().replace(/\s*(mxn|mn|pesos?)$/i, "").trim();
  if (v.endsWith("-")) v = `-${v.slice(0, -1).trim()}`;
  v = v.replace(/^(-?)\$\s+/, "$1$").replace(/^\$-/, "-$").replace(SEPARADOR_MILES, ",");
  if (!RE_DINERO.some((r) => r.test(v))) return null;
  const centavos = parsearMontoCentavos(v);
  if (centavos === null) return null;
  const limpio = v.replace(/[-()$]/g, "");
  const sinDecimales = /^\d+$/.test(limpio) || /^\d{1,3}(,\d{3})+$/.test(limpio);
  if (sinDecimales && limpio.replace(/\D/g, "").length >= 10) return null;
  const abs = Math.abs(centavos);
  return `${centavos < 0 ? "-" : ""}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** Catálogo CERRADO de formas de pago (sin acentos ni mayúsculas) y su valor para el servidor. «tarjeta*» y «amex» cuentan como tarjeta para la comisión de terminal; «credito_cliente» es cuenta por cobrar. */
const FORMAS_PAGO: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(tarjeta.*credito|credito.*tarjeta|tdc)\b/, "tarjeta_credito"],
  [/\b(tarjeta.*debito|debito|tdd)\b/, "tarjeta_debito"],
  [/\b(amex|american express)\b/, "amex"],
  [/\b(credito cliente|credito a cliente|cuenta por cobrar|cxc|a credito|credito casa|credito)\b/, "credito_cliente"],
  [/\b(visa|mastercard|master card|tarjeta)\b/, "tarjeta"],
  [/\b(cortesia|cortesias)\b/, "cortesia"],
  [/\b(dolar|dolares|usd)\b/, "dolares"],
  [/\b(transferencia|spei|deposito)\b/, "transferencia"],
  [/\b(uber|rappi|didi|plataforma)\b/, "plataforma"],
  [/\b(mercado pago|mercadopago|codi|paypal)\b/, "mercado_pago"],
  [/\b(monedero|puntos|lealtad)\b/, "monedero"],
  [/\b(mixto|combinado)\b/, "mixto"],
  [/\b(efectivo|cash)\b/, "efectivo"],
  [/\bvales?\b/, "vales"],
  [/\bcheque\b/, "cheque"],
];
const SERVICIO_ETIQUETA: Readonly<Record<string, string>> = { comedor: "Comedor", para_llevar: "Para llevar", domicilio: "Domicilio", rapido: "Rápido", otro: "Otro" };
const SI = new Set(["si", "s", "1", "true", "verdadero", "x", "yes"]);
const NO = new Set(["no", "n", "0", "false", "falso"]);

/** Sí/No de «cancelada»: contiene «cancel» (sin «no»/«sin» delante) -> Sí; cualquier otra palabra corta sin dígitos ni «@» -> No; el resto se rechaza. */
function parsearCancelada(v: string): "Sí" | "No" | null {
  const n = normalizarEncabezado(v);
  if (SI.has(n)) return "Sí";
  if (NO.has(n)) return "No";
  if (/[\d@]/.test(v) || n.length > 20 || n === "") return null;
  if (/^(no|sin)\b/.test(n)) return "No";
  return n.includes("cancel") ? "Sí" : "No";
}

export type ResultadoCelda = { readonly ok: true; readonly valor: string | null } | { readonly ok: false; readonly esperado: string; readonly confirmable?: boolean };

/** Valida y normaliza UNA celda según el tipo de su campo. Texto libre nunca pasa: los enumerados salen de una lista cerrada. */
export function parsearCeldaSr(campo: string, valor: string, opciones: { readonly confirmarFolio?: boolean; /** false = la columna del folio no se llama como un folio: un número de 10 dígitos se toma por teléfono. */ readonly folioEsAlias?: boolean } = {}): ResultadoCelda {
  const v = valor.trim();
  if (v === "") return { ok: true, valor: null };
  const tipo = TIPO_DE_CAMPO[campo];
  if (!tipo) return { ok: false, esperado: "un dato conocido" };
  const no = (confirmable = false): ResultadoCelda => ({ ok: false, esperado: ESPERADO[tipo], ...(confirmable ? { confirmable: true } : {}) });
  if (RE_CORREO.test(v) || pareceTarjeta(v)) return no();
  const digitos = v.replace(/\D/g, "").length;
  switch (tipo) {
    case "dinero":
      { const d = normalizarDinero(v); return d !== null ? { ok: true, valor: d } : no(); }
    case "fecha":
      return v.length <= 30 && parsearFechaSr(v) !== null ? { ok: true, valor: v } : no();
    case "hora":
      return /^\d{1,2}:\d{2}(:\d{2})?(\s?[ap]\.?\s?m\.?)?$/i.test(v) ? { ok: true, valor: v } : no();
    case "entero":
      return /^\d{1,6}$/.test(v) || /^\d{1,3}(,\d{3})+$/.test(v) ? (/^\d{1,3}(,\d{3})+$/.test(v) && v.replace(/,/g, "").length > 6 ? no() : { ok: true, valor: v.replace(/,/g, "") }) : no();
    case "booleano": {
      const b = parsearCancelada(v);
      return b ? { ok: true, valor: b } : no();
    }
    case "servicio":
      return digitos >= 7 ? no() : { ok: true, valor: SERVICIO_ETIQUETA[normalizarTipoServicio(v)] ?? "Otro" };
    case "forma_pago": {
      if (digitos >= 7) return no();
      const n = normalizarEncabezado(v);
      return { ok: true, valor: FORMAS_PAGO.find(([re]) => re.test(n))?.[1] ?? "otro" };
    }
    case "folio": {
      if (v.length > 24 || !RE_FOLIO.test(v) || !/\d/.test(v) || RE_RFC.test(v) || RE_CURP.test(v)) return no();
      if (pareceTelefono(v) && !opciones.confirmarFolio) return no(true);
      // Una columna que no se llama como un folio con un número de teléfono sin formato (10 dígitos, o 12/13 con 52/521) es sospechosa.
      if (!opciones.confirmarFolio && opciones.folioEsAlias === false && /^\d+$/.test(v) && ((v.length === 10 && !v.startsWith("0")) || (v.length === 12 && v.startsWith("52")))) return no(true);
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
  /** Un folio con forma de teléfono: la persona puede confirmar que es un folio. */
  readonly confirmable: boolean;
  /** true = el campo es obligatorio y el renglón NO se envía; false = el campo es opcional: se envía vacío y el renglón se conserva. */
  readonly descartaRenglon: boolean;
}

/** «Renglón 5, «Total»: se esperaba un monto… (el valor no se muestra). …» */
export const MENSAJE_ERROR_LOCAL = (e: ErrorLocalSr): string =>
  `Renglón ${e.renglon}, «${e.etiqueta}»: se esperaba ${e.esperado} (el valor no se muestra). ${e.descartaRenglon ? "Corrige esa celda o elige otra columna; ese renglón no se envía." : "Ese dato se envía vacío y el renglón se conserva."}`;

export interface TablaSr {
  readonly tabla: Array<Array<string | null>>;
  /** Cuántas columnas del archivo viajan. */
  readonly columnasEnviadas: number;
  /** Primeros errores (con tope); los totales van aparte. */
  readonly errores: readonly ErrorLocalSr[];
  /** Renglones que NO viajan (un campo obligatorio no pasó su parser): cuentan como rechazados. */
  readonly renglonesDescartados: number;
  /** Datos opcionales que viajan vacíos (el renglón se conserva). */
  readonly datosVaciados: number;
}

const MAX_ERRORES_LOCALES = 200;

export interface OpcionesTablaSr {
  readonly confirmarFolio?: boolean;
  /** Columnas que el ENCABEZADO marcó como personales: ni con la casilla de recuperar pueden ser el folio (rechazo duro). */
  readonly columnasPersonales?: ReadonlySet<number>;
}

/**
 * Tabla para la API: conserva el número de cada renglón del archivo (los de arriba del encabezado van vacíos), renombra las columnas mapeadas al alias canónico
 * del dominio y NO incluye ninguna otra. Cada celda pasa por el parser de su campo: un dato OPCIONAL que no pasa viaja vacío (el renglón se conserva) y uno
 * OBLIGATORIO deja el renglón completo en blanco (no viaja). Ambos casos quedan en `errores`.
 */
export function construirTablaSr(filas: readonly (readonly string[])[], filaEncabezado: number, tipo: TipoLayoutSr, mapeo: MapeoSr, opciones: OpcionesTablaSr = {}): TablaSr {
  const campos = camposDeTipo(tipo).filter((c) => mapeo[c.campo] !== null && mapeo[c.campo] !== undefined);
  const errores: ErrorLocalSr[] = [];
  let renglonesDescartados = 0;
  let datosVaciados = 0;
  const folioCol = mapeo["folio"];
  const folioPersonal = folioCol !== null && folioCol !== undefined && (opciones.columnasPersonales?.has(folioCol) ?? false);
  const encabezadoFolio = folioCol === null || folioCol === undefined ? "" : normalizarEncabezado(filas[filaEncabezado]?.[folioCol] ?? "");
  const folioEsAlias = aliasDe(tipo, "folio").includes(encabezadoFolio);
  const anotar = (e: ErrorLocalSr): void => {
    if (errores.length < MAX_ERRORES_LOCALES) errores.push(e);
  };
  const tabla = filas.map((fila, i): Array<string | null> => {
    if (i < filaEncabezado) return [];
    if (i === filaEncabezado) return campos.map((c) => aliasDe(tipo, c.campo)[0] ?? c.campo);
    if (fila.every((c) => c.trim() === "")) return [];
    const celdas: Array<string | null> = [];
    let descartar = false;
    for (const c of campos) {
      const crudo = fila[mapeo[c.campo] as number] ?? "";
      const r = c.campo === "folio" && folioPersonal && crudo.trim() !== "" ? ({ ok: false, esperado: "una columna que no sea de clientes (esa columna parece de clientes y no puede ser el folio)" } as const) : parsearCeldaSr(c.campo, crudo, { confirmarFolio: opciones.confirmarFolio === true, folioEsAlias });
      if (r.ok) {
        celdas.push(r.valor);
        continue;
      }
      anotar({ renglon: i + 1, campo: c.campo, etiqueta: c.etiqueta, esperado: r.esperado, confirmable: "confirmable" in r && r.confirmable === true, descartaRenglon: c.requerido });
      if (c.requerido) {
        descartar = true;
        break;
      }
      datosVaciados += 1;
      celdas.push(null);
    }
    if (descartar) {
      renglonesDescartados += 1;
      return [];
    }
    return celdas;
  });
  return { tabla, columnasEnviadas: campos.length, errores, renglonesDescartados, datosVaciados };
}
