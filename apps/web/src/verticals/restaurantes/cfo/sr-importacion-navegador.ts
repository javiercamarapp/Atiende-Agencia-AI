// CFO-08 · importación de reportes de SoftRestaurant EN EL NAVEGADOR: detecta la fila de encabezados, sugiere el mapeo de columnas con los alias
// INFERIDOS del dominio (`ALIAS_SR_INFERIDOS`, no se copian), EXCLUYE las columnas de datos personales y arma la tabla que recibe la API.
//
// Privacidad (diseño §3.7): solo viajan las columnas que la persona mapeó. Una columna de cliente (nombre, teléfono, correo, dirección, RFC…)
// nunca se manda: se marca como personal si CUALQUIER renglón con forma de encabezado (hasta el renglón elegido o entre los primeros 15) trae una palabra
// personal en esa posición, así que elegir otro renglón como encabezado no la libera. Como defensa extra, antes de armar la tabla se revisan los valores
// de los campos de texto mapeados (folio, tipo de servicio, forma de pago, cancelada): si alguno parece un teléfono o un correo, no se envía nada.
// El servidor además rechaza un archivo con encabezados personales, pero solo ve los encabezados que le llegan ya renombrados: la barrera real es esta.
// La lectura del archivo (CSV/XLSX, tope de 5 MB, huella) es la de `lib/clientes-importacion.ts`; aquí no se vuelve a escribir.
import { ALIAS_SR_INFERIDOS, esColumnaPersonal, normalizarEncabezado } from "@atiende/domain-restaurantes/cfo";
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

const FILAS_REVISADAS = 15;

/**
 * Índices de las columnas de datos personales (nombre, teléfono, correo, dirección, RFC…): se EXCLUYEN siempre. Una columna es personal si en esa posición
 * alguna fila con forma de encabezado (2 o más celdas llenas) tiene un encabezado personal: las filas hasta la elegida y las primeras 15, para que cambiar el
 * renglón de encabezados no la deje pasar. Los títulos de una sola celda no cuentan.
 */
export function columnasPersonales(filas: readonly (readonly string[])[], filaEncabezado: number): number[] {
  return [...nombresPersonales(filas, filaEncabezado).keys()];
}

/** Columna personal -> el encabezado que la delata (nunca un valor de datos: es lo que se le muestra a la persona como «excluida»). */
export function nombresPersonales(filas: readonly (readonly string[])[], filaEncabezado: number): Map<number, string> {
  const hasta = Math.min(filas.length - 1, Math.max(filaEncabezado, FILAS_REVISADAS - 1));
  const out = new Map<number, string>();
  for (let r = 0; r <= hasta; r++) {
    const fila = filas[r] ?? [];
    if (r !== filaEncabezado && fila.filter((c) => c.trim() !== "").length < 2) continue;
    fila.forEach((h, i) => {
      if (h.trim() !== "" && esColumnaPersonal(h) && !out.has(i)) out.set(i, h.trim());
    });
  }
  return new Map([...out.entries()].sort((x, y) => x[0] - y[0]));
}

const CAMPOS_TEXTO = ["folio", "servicio", "forma_pago", "cancelada"] as const;
const RE_CORREO = /[^\s@]+@[^\s@]+\.[^\s@]+/;
/** Teléfono: con separadores o +52, 10 dígitos que no empiezan con 0 (un folio relleno con ceros no lo es), o 12 y 13 con prefijo 52 / 521. */
export function pareceTelefono(valor: string): boolean {
  const v = valor.trim();
  if (!/^\+?[\d\s().-]{10,20}$/.test(v)) return false;
  const digitos = v.replace(/\D/g, "");
  if (digitos.length === 10) return !digitos.startsWith("0");
  return (digitos.length === 12 && digitos.startsWith("52")) || (digitos.length === 13 && digitos.startsWith("521"));
}

export interface DatoPersonalDetectado {
  readonly campo: string;
  /** Renglón del archivo (1 = primero). */
  readonly renglon: number;
}

/** Primer valor con forma de teléfono o correo en una columna mapeada a un campo de texto (folio, tipo de servicio, forma de pago, cancelada). */
export function valorPersonalEnMapeo(filas: readonly (readonly string[])[], filaEncabezado: number, tipo: TipoLayoutSr, mapeo: MapeoSr): DatoPersonalDetectado | null {
  const activos = camposDeTipo(tipo).filter((c) => (CAMPOS_TEXTO as readonly string[]).includes(c.campo) && mapeo[c.campo] !== null && mapeo[c.campo] !== undefined);
  for (let r = filaEncabezado + 1; r < filas.length; r++) {
    for (const c of activos) {
      const v = filas[r]?.[mapeo[c.campo] as number] ?? "";
      if (RE_CORREO.test(v) || pareceTelefono(v)) return { campo: c.campo, renglon: r + 1 };
    }
  }
  return null;
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

export const MENSAJE_VALOR_PERSONAL = (d: DatoPersonalDetectado): string =>
  `El renglón ${d.renglon} trae algo que parece un teléfono o un correo en la columna elegida para «${d.campo}». No se sube nada: revisa el mapeo (no subimos datos de tus clientes).`;

export interface TablaSr {
  readonly tabla: Array<Array<string | null>>;
  /** Cuántas columnas del archivo viajan. */
  readonly columnasEnviadas: number;
  /** Encabezados de las columnas de datos personales que NO se suben. */
  readonly excluidas: readonly string[];
}

/**
 * Tabla para la API: conserva el número de cada renglón del archivo (los de arriba del encabezado van vacíos y los errores del servidor apuntan al
 * renglón real), renombra las columnas mapeadas al alias canónico del dominio y NO incluye ninguna otra. Si el mapeo toca una columna personal, falla.
 */
export function construirTablaSr(filas: readonly (readonly string[])[], filaEncabezado: number, tipo: TipoLayoutSr, mapeo: MapeoSr): TablaSr {
  const personales = new Set(columnasPersonales(filas, filaEncabezado));
  const campos = camposDeTipo(tipo).filter((c) => mapeo[c.campo] !== null && mapeo[c.campo] !== undefined);
  for (const c of campos) {
    if (personales.has(mapeo[c.campo] as number)) throw new Error("La columna elegida trae datos personales de tus clientes y no se sube.");
  }
  const hallado = valorPersonalEnMapeo(filas, filaEncabezado, tipo, mapeo);
  if (hallado) throw new Error(MENSAJE_VALOR_PERSONAL(hallado));
  const tabla = filas.map((fila, i): Array<string | null> => {
    if (i < filaEncabezado) return [];
    if (i === filaEncabezado) return campos.map((c) => aliasDe(tipo, c.campo)[0] ?? c.campo);
    return campos.map((c) => {
      const v = fila[mapeo[c.campo] as number];
      return v === undefined || v === "" ? null : v;
    });
  });
  return { tabla, columnasEnviadas: campos.length, excluidas: [...nombresPersonales(filas, filaEncabezado).values()] };
}
