// CFO-04 · consolidación TOTAL vs. SUCURSALES (diseño §3.4 y §3.5).
//
// Regla de oro: consolidado = Σ sucursales + «No asignado». Solo se suman columnas ADITIVAS (sumas y conteos).
// Las razones se calculan DESPUÉS, desde las sumas (Σ numerador / Σ denominador, nunca promedio de razones).
// Los percentiles y los conteos distintos (clientes únicos) NO son aditivos: `consolidar` se niega a sumarlos y el
// total de clientes se calcula con `consolidarClientes`, que muestra «X compraron en más de una sucursal».
import type { FilaClientesResumen } from "./tipos.ts";
import { formatoEntero, pct1 } from "./util.ts";

/** Columnas que NUNCA se suman entre sucursales. */
export const COLUMNAS_NO_ADITIVAS: ReadonlySet<string> = new Set([
  // percentiles / medianas
  "p50Min",
  "p90Min",
  "diasEntrePedidosMediana",
  // conteos distintos de clientes (un cliente compra en dos sucursales)
  "clientesConPedido",
  "nuevos",
  "recurrentes",
  "activos",
  "dormidos",
  "perdidos",
  "frecuentes",
  "recuperados",
  "recuperadosPorCampana",
  "multiSucursal",
  "clientes",
  // razones y promedios (se recalculan desde sumas)
  "netaTop10pctCentavos",
  "pedidosPorCliente12mPromedio",
]);

export class ColumnaNoAditivaError extends Error {
  readonly columnas: readonly string[];
  constructor(columnas: readonly string[]) {
    super(`Columnas no aditivas: ${columnas.join(", ")}. No se suman entre sucursales (percentiles y conteos distintos).`);
    this.name = "ColumnaNoAditivaError";
    this.columnas = columnas;
  }
}

export class ErrorAditividad extends Error {
  readonly detalles: ReadonlyArray<{ columna: string; total: number | null; sumaSucursales: number; noAsignado: number }>;
  constructor(detalles: ErrorAditividad["detalles"]) {
    super(`Aditividad rota: ${detalles.map((d) => `${d.columna} (total ${d.total} ≠ Σ ${d.sumaSucursales} + no asignado ${d.noAsignado})`).join("; ")}`);
    this.name = "ErrorAditividad";
    this.detalles = detalles;
  }
}

export interface RenglonConsolidado<K extends string> {
  /** null en «No asignado» y en «Total». */
  readonly propertyId: string | null;
  /** null = ninguna fila aportó dato a esa columna (sin dato, no 0). */
  readonly valores: Readonly<Record<K, number | null>>;
  /** Cuántas filas de entrada aportó. 0 = sucursal sin datos. */
  readonly filas: number;
  /** Columnas donde algunas filas venían null (p. ej. sin tipo de cambio): el valor es parcial. */
  readonly parciales: readonly K[];
}

export interface Consolidado<K extends string> {
  readonly columnas: readonly K[];
  readonly sucursales: readonly RenglonConsolidado<K>[];
  /** Siempre presente; con `filas: 0` y valores null si no hubo nada sin asignar. */
  readonly noAsignado: RenglonConsolidado<K>;
  readonly total: RenglonConsolidado<K>;
  /** Filas descartadas por estar fuera del alcance (sucursal no permitida o «No asignado» vetado). */
  readonly filasFueraDeAlcance: number;
}

export interface OpcionesConsolidar {
  /** Sucursales a mostrar, en orden. Las que no tengan filas salen con valores null (sucursal sin datos). Si se omite, las que aparezcan. */
  readonly sucursales?: readonly string[];
  /** false = el actor no puede ver «No asignado» (admin acotado): esas filas se descartan y NO entran al total. Default true. */
  readonly permitirNoAsignado?: boolean;
}

interface Acumulador<K extends string> {
  filas: number;
  suma: Record<string, number>;
  conDato: Record<string, number>;
  nulos: Record<string, number>;
  columnas: readonly K[];
}

function nuevoAcumulador<K extends string>(columnas: readonly K[]): Acumulador<K> {
  return { filas: 0, suma: {}, conDato: {}, nulos: {}, columnas };
}

function acumular<K extends string>(a: Acumulador<K>, fila: Record<string, unknown>): void {
  a.filas += 1;
  for (const c of a.columnas) {
    const v = fila[c];
    if (v == null) {
      a.nulos[c] = (a.nulos[c] ?? 0) + 1;
      continue;
    }
    if (typeof v !== "number" || !Number.isFinite(v)) throw new TypeError(`Columna ${c}: valor no numérico`);
    a.suma[c] = (a.suma[c] ?? 0) + v;
    a.conDato[c] = (a.conDato[c] ?? 0) + 1;
  }
}

function aRenglon<K extends string>(propertyId: string | null, a: Acumulador<K>): RenglonConsolidado<K> {
  const valores = {} as Record<K, number | null>;
  const parciales: K[] = [];
  for (const c of a.columnas) {
    valores[c] = (a.conDato[c] ?? 0) > 0 ? (a.suma[c] ?? 0) : null;
    if ((a.conDato[c] ?? 0) > 0 && (a.nulos[c] ?? 0) > 0) parciales.push(c);
  }
  return { propertyId, valores, filas: a.filas, parciales };
}

/**
 * Un renglón por sucursal, otro «No asignado» y el total.
 * El total se acumula directo desde las filas (camino independiente de las sumas por sucursal): así
 * `verificarAditividad` compara dos cálculos distintos y no es una tautología.
 */
export function consolidar<T extends object, K extends keyof T & string>(
  filas: readonly T[],
  claves: { readonly propertyId: keyof T & string },
  columnasAditivas: readonly K[],
  opciones: OpcionesConsolidar = {},
): Consolidado<K> {
  const vetadas = columnasAditivas.filter((c) => COLUMNAS_NO_ADITIVAS.has(c));
  if (vetadas.length > 0) throw new ColumnaNoAditivaError(vetadas);

  const permitirNoAsignado = opciones.permitirNoAsignado ?? true;
  const permitidas = opciones.sucursales ? new Set(opciones.sucursales) : null;
  const porSucursal = new Map<string, Acumulador<K>>();
  for (const id of opciones.sucursales ?? []) porSucursal.set(id, nuevoAcumulador(columnasAditivas));
  const noAsignado = nuevoAcumulador(columnasAditivas);
  const total = nuevoAcumulador(columnasAditivas);
  let fuera = 0;

  for (const fila of filas) {
    const rec = fila as unknown as Record<string, unknown>;
    const pid = rec[claves.propertyId];
    if (pid == null) {
      if (!permitirNoAsignado) { fuera += 1; continue; }
      acumular(noAsignado, rec);
      acumular(total, rec);
      continue;
    }
    if (typeof pid !== "string") throw new TypeError("propertyId debe ser string o null");
    if (permitidas && !permitidas.has(pid)) { fuera += 1; continue; }
    let acc = porSucursal.get(pid);
    if (!acc) { acc = nuevoAcumulador(columnasAditivas); porSucursal.set(pid, acc); }
    acumular(acc, rec);
    acumular(total, rec);
  }

  const ids = opciones.sucursales ? [...opciones.sucursales] : [...porSucursal.keys()].sort();
  const resultado: Consolidado<K> = {
    columnas: columnasAditivas,
    sucursales: ids.map((id) => aRenglon(id, porSucursal.get(id) ?? nuevoAcumulador(columnasAditivas))),
    noAsignado: aRenglon(null, noAsignado),
    total: aRenglon(null, total),
    filasFueraDeAlcance: fuera,
  };
  verificarAditividad(resultado);
  return resultado;
}

/** Lanza `ErrorAditividad` si, para alguna columna, total ≠ Σ sucursales + «No asignado». Ambos lados null = correcto. */
export function verificarAditividad<K extends string>(c: Consolidado<K>, columnas: readonly K[] = c.columnas): void {
  const vetadas = columnas.filter((col) => COLUMNAS_NO_ADITIVAS.has(col));
  if (vetadas.length > 0) throw new ColumnaNoAditivaError(vetadas);
  const malas: Array<{ columna: string; total: number | null; sumaSucursales: number; noAsignado: number }> = [];
  for (const col of columnas) {
    let suma = 0;
    let alguno = false;
    for (const s of c.sucursales) {
      const v = s.valores[col];
      if (v != null) { suma += v; alguno = true; }
    }
    const na = c.noAsignado.valores[col];
    if (na != null) { suma += na; alguno = true; }
    const t = c.total.valores[col];
    const ok = alguno ? t === suma : t === null;
    if (!ok) malas.push({ columna: col, total: t, sumaSucursales: suma - (na ?? 0), noAsignado: na ?? 0 });
  }
  if (malas.length > 0) throw new ErrorAditividad(malas);
}

/**
 * Razón consolidada desde SUMAS: Σ numerador / Σ denominador, en porcentaje con 1 decimal. null si el denominador es 0 o falta.
 * Nunca es el promedio de las razones de cada sucursal.
 */
export function razonPct<K extends string>(r: RenglonConsolidado<K>, numerador: K, denominador: K): number | null {
  const n = r.valores[numerador];
  const d = r.valores[denominador];
  if (n == null || d == null) return null;
  return pct1(n, d);
}

/** Nearest-rank (p entre 0 y 100) sobre valores crudos del CONJUNTO. Los percentiles no se obtienen de los de cada sucursal. */
export function percentil(valores: readonly number[], p: number): number | null {
  if (valores.length === 0) return null;
  if (!(p >= 0 && p <= 100)) throw new RangeError("percentil fuera de 0..100");
  const orden = [...valores].sort((a, b) => a - b);
  const rango = Math.max(1, Math.ceil((p / 100) * orden.length));
  return orden[rango - 1] ?? null;
}

// ---- Clientes únicos: nunca se suman entre sucursales ------------------------------------------------------------------------------------

export interface ClientesConsolidado {
  readonly porSucursal: readonly FilaClientesResumen[];
  /** Renglón del conjunto (clientes únicos de todo el alcance). null si no se puede calcular sin sumar. */
  readonly conjunto: FilaClientesResumen | null;
  /** Σ clientes_con_pedido de las sucursales − clientes únicos del conjunto. null si no hay conjunto. */
  readonly multiSucursal: number | null;
  /** Σ de las sucursales (SOLO informativo para la prueba: NO es el total de clientes). */
  readonly sumaClientesPorSucursal: number;
  readonly texto: string | null;
}

/** «X clientes compraron en más de una sucursal» (concordancia en singular). null si no hay cifra. */
export function textoMultiSucursal(n: number | null): string | null {
  if (n == null) return null;
  if (n === 0) return "Ningún cliente compró en más de una sucursal";
  if (n === 1) return "1 cliente compró en más de una sucursal";
  return `${formatoEntero(n)} clientes compraron en más de una sucursal`;
}

export function consolidarClientes(filas: readonly FilaClientesResumen[]): ClientesConsolidado {
  const porSucursal = filas.filter((f) => f.alcance === "sucursal" && f.propertyId !== null);
  const conjuntos = filas.filter((f) => f.alcance === "conjunto");
  if (conjuntos.length > 1) throw new Error("cfo_clientes_resumen: más de un renglón de conjunto");
  const suma = porSucursal.reduce((s, f) => s + f.clientesConPedido, 0);
  // Con una sola sucursal, sus clientes únicos SON el conjunto. Con varias y sin renglón de conjunto no se inventa: se queda null.
  const conjunto: FilaClientesResumen | null = conjuntos[0] ?? (porSucursal.length === 1 ? { ...porSucursal[0]!, alcance: "conjunto", propertyId: null, multiSucursal: 0 } : null);
  const multi = conjunto ? suma - conjunto.clientesConPedido : null;
  if (conjunto && conjunto.multiSucursal != null && multi !== conjunto.multiSucursal) {
    throw new ErrorAditividad([{ columna: "multiSucursal", total: conjunto.multiSucursal, sumaSucursales: multi ?? 0, noAsignado: 0 }]);
  }
  if (multi != null && multi < 0) {
    throw new ErrorAditividad([{ columna: "clientesConPedido", total: conjunto?.clientesConPedido ?? null, sumaSucursales: suma, noAsignado: 0 }]);
  }
  return { porSucursal, conjunto, multiSucursal: multi, sumaClientesPorSucursal: suma, texto: textoMultiSucursal(multi) };
}
