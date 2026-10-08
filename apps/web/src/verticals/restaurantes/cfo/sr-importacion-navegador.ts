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

/**
 * Índices de las columnas de datos personales (nombre, teléfono, correo, dirección, RFC…): se EXCLUYEN siempre. Una columna es personal si en esa posición
 * una fila con forma de encabezado tiene un encabezado personal. Solo cuentan las filas HASTA la elegida (los renglones de datos de abajo no son encabezados,
 * así que «Calle 60 #123» bajo «Domicilio» o «Crédito cliente» en forma de pago no excluyen nada), de modo que cambiar el renglón de encabezados a uno de
 * datos no libera la columna que un renglón de arriba ya delató.
 */
export function columnasPersonales(filas: readonly (readonly string[])[], filaEncabezado: number): number[] {
  return [...nombresPersonales(filas, filaEncabezado).keys()];
}

const esEtiqueta = (c: string): boolean => c.trim().endsWith(":");

/**
 * ¿Los renglones de arriba del encabezado elegido son encabezados (de grupo) y no títulos? Con 3 o más celdas llenas sí. Con menos: un par «etiqueta: valor»
 * (`R.F.C.:,XAXX…`, `Dirección:,Calle 60…`) es un dato del negocio y se ignora entero, y un título suelto en la columna 1 también; una celda sola en otra
 * columna (`,,,Teléfono`) SÍ es un encabezado de grupo y cuenta.
 */
function celdasDeEncabezado(fila: readonly string[], esElegida: boolean): Array<[number, string]> {
  const llenas = fila.map((c, i) => [i, c.trim()] as [number, string]).filter(([, c]) => c !== "");
  if (esElegida) return llenas.filter(([, c]) => !esEtiqueta(c));
  if (llenas.length >= 3) return llenas.filter(([, c]) => !esEtiqueta(c));
  if (llenas.some(([, c]) => esEtiqueta(c))) return [];
  if (llenas.length === 1 && llenas[0]![0] === 0) return [];
  return llenas.filter(([i]) => i > 0);
}

/** Columna personal -> cómo mostrarla: el encabezado si parece un nombre (sin dígitos) y, si no, solo su posición. Nunca un valor de datos. */
export function nombresPersonales(filas: readonly (readonly string[])[], filaEncabezado: number): Map<number, string> {
  const hasta = Math.min(filas.length - 1, filaEncabezado);
  const out = new Map<number, string>();
  for (let r = 0; r <= hasta; r++) {
    for (const [i, h] of celdasDeEncabezado(filas[r] ?? [], r === filaEncabezado)) {
      if (esColumnaPersonal(h) && !out.has(i)) out.set(i, /\d/.test(h) || h.length > 30 ? `Columna ${i + 1}` : h);
    }
  }
  return new Map([...out.entries()].sort((x, y) => x[0] - y[0]));
}

const CAMPOS_NUMERICOS = ["total", "subtotal", "descuento", "propina", "impuesto", "cancelado", "tickets"] as const;
const RE_CORREO = /[^\s@]+@[^\s@]+\.[^\s@]+/;
/** Con separadores o +52: 10 dígitos en grupos de teléfono (2-3 / 3-4 / 4) o con prefijo 52 / 521. «1234-567-890» no es un teléfono. */
const RE_TEL_CON_FORMATO = /^(\+?5?2?1?[\s.-]?)?(\(\d{2,3}\)|\d{2,3})[\s.-]?\d{3,4}[\s.-]?\d{4}$/;

/** Teléfono: con formato (separadores, paréntesis o +52) o, sin separadores, 10 dígitos que no empiezan con 0 (un folio relleno con ceros no lo es) o 12/13 con prefijo 52/521. */
export function pareceTelefono(valor: string, opciones: { readonly sinFormato?: boolean } = {}): boolean {
  const v = valor.trim();
  if (!/^\+?[\d\s().-]{10,20}$/.test(v)) return false;
  const digitos = v.replace(/\D/g, "");
  const conFormato = /[\s().+-]/.test(v);
  if (conFormato) {
    if (digitos.length === 10) return !digitos.startsWith("0") && RE_TEL_CON_FORMATO.test(v);
    return (digitos.length === 12 && digitos.startsWith("52") || digitos.length === 13 && digitos.startsWith("521")) && RE_TEL_CON_FORMATO.test(v);
  }
  if (opciones.sinFormato === false) return false;
  if (digitos.length === 10) return !digitos.startsWith("0");
  return (digitos.length === 12 && digitos.startsWith("52")) || (digitos.length === 13 && digitos.startsWith("521"));
}

export interface DatoPersonalDetectado {
  readonly campo: string;
  /** Renglón del archivo (1 = primero). */
  readonly renglon: number;
  readonly motivo: "correo" | "telefono" | "numero_largo";
}

export interface OpcionesValorPersonal {
  /** La persona confirmó que la columna del folio no trae teléfonos: se omite la regla de teléfono con formato SOLO para el folio (el correo nunca se omite). */
  readonly confirmarFolio?: boolean;
}

/**
 * Primer valor con forma de dato personal en una columna mapeada, de CUALQUIER campo: un correo (siempre), un teléfono (en un folio solo con formato:
 * 2026092101 es un folio normal) y, en los campos de monto o cantidad, un entero sin decimales de 10 dígitos o más (no es un monto realista: es un teléfono mapeado a «propina»).
 */
export function valorPersonalEnMapeo(filas: readonly (readonly string[])[], filaEncabezado: number, tipo: TipoLayoutSr, mapeo: MapeoSr, opciones: OpcionesValorPersonal = {}): DatoPersonalDetectado | null {
  const activos = camposDeTipo(tipo).filter((c) => mapeo[c.campo] !== null && mapeo[c.campo] !== undefined);
  for (let r = filaEncabezado + 1; r < filas.length; r++) {
    for (const c of activos) {
      const v = (filas[r]?.[mapeo[c.campo] as number] ?? "").trim();
      if (v === "") continue;
      if (RE_CORREO.test(v)) return { campo: c.campo, renglon: r + 1, motivo: "correo" };
      if (c.campo === "folio") {
        if (!opciones.confirmarFolio && pareceTelefono(v, { sinFormato: false })) return { campo: c.campo, renglon: r + 1, motivo: "telefono" };
        continue;
      }
      if (pareceTelefono(v)) return { campo: c.campo, renglon: r + 1, motivo: "telefono" };
      if ((CAMPOS_NUMERICOS as readonly string[]).includes(c.campo) && /^\$?\d{10,}$/.test(v)) return { campo: c.campo, renglon: r + 1, motivo: "numero_largo" };
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
  `El renglón ${d.renglon} trae algo que parece ${d.motivo === "correo" ? "un correo" : d.motivo === "numero_largo" ? "un teléfono (un número de 10 dígitos o más sin decimales)" : "un teléfono"} en la columna elegida para «${d.campo}». No se sube nada: revisa el mapeo (no subimos datos de tus clientes).`;

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
export function construirTablaSr(filas: readonly (readonly string[])[], filaEncabezado: number, tipo: TipoLayoutSr, mapeo: MapeoSr, opciones: OpcionesValorPersonal = {}): TablaSr {
  const personales = new Set(columnasPersonales(filas, filaEncabezado));
  const campos = camposDeTipo(tipo).filter((c) => mapeo[c.campo] !== null && mapeo[c.campo] !== undefined);
  for (const c of campos) {
    if (personales.has(mapeo[c.campo] as number)) throw new Error("La columna elegida trae datos personales de tus clientes y no se sube.");
  }
  const hallado = valorPersonalEnMapeo(filas, filaEncabezado, tipo, mapeo, opciones);
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
