// CFO-08 · importación de reportes de SoftRestaurant EN EL NAVEGADOR: detecta la fila de encabezados, sugiere el mapeo de columnas con los alias
// INFERIDOS del dominio (`ALIAS_SR_INFERIDOS`, no se copian), EXCLUYE las columnas de datos personales y arma la tabla que recibe la API.
//
// Privacidad (diseño §3.7): solo viajan las columnas que la persona mapeó. Una columna de cliente (nombre, teléfono, correo, dirección, RFC…)
// nunca se manda, y tampoco las que no se mapearon. El servidor vuelve a rechazar el archivo si aun así trae una (defensa en profundidad).
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

/** Índices de las columnas de datos personales (nombre, teléfono, correo, dirección, RFC…): se EXCLUYEN siempre. */
export function columnasPersonales(encabezados: readonly string[]): number[] {
  return encabezados.flatMap((h, i) => (h.trim() !== "" && esColumnaPersonal(h) ? [i] : []));
}

/** Sugiere la columna de cada campo con los alias inferidos (en su orden de prioridad); una columna se usa una sola vez y nunca una personal. */
export function sugerirMapeoSr(encabezados: readonly string[], tipo: TipoLayoutSr): MapeoSr {
  const personales = new Set(columnasPersonales(encabezados));
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
  const encabezados = filas[filaEncabezado] ?? [];
  const personales = new Set(columnasPersonales(encabezados));
  const campos = camposDeTipo(tipo).filter((c) => mapeo[c.campo] !== null && mapeo[c.campo] !== undefined);
  for (const c of campos) {
    if (personales.has(mapeo[c.campo] as number)) throw new Error("La columna elegida trae datos personales de tus clientes y no se sube.");
  }
  const tabla = filas.map((fila, i): Array<string | null> => {
    if (i < filaEncabezado) return [];
    if (i === filaEncabezado) return campos.map((c) => aliasDe(tipo, c.campo)[0] ?? c.campo);
    return campos.map((c) => {
      const v = fila[mapeo[c.campo] as number];
      return v === undefined || v === "" ? null : v;
    });
  });
  return { tabla, columnasEnviadas: campos.length, excluidas: [...personales].map((i) => encabezados[i] ?? "") };
}
