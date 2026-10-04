// D-P3-10 -- búsqueda de subconjuntos N-a-1 (varios CFDI suman UN movimiento bancario), en CENTAVOS ENTEROS. Puerto de
// `b2b_ai/services/subset_sum.py` (`find_subset_sums`): fuerza bruta con poda hasta MITM_UMBRAL candidatos y meet-in-the-middle
// por encima.
//
// Reglas duras (las mismas del origen, ADR-1/ADR-2):
//   * Si NINGUNA combinación cae en la banda, devuelve vacío: nunca se inventa la "más parecida".
//   * Si 2 o más combinaciones DISTINTAS caen en la banda, se devuelven TODAS (hasta `maxCombinaciones`, con `truncado: true`): quien llama
//     decide; este módulo nunca elige una por su cuenta. El motor anterior devolvía la PRIMERA combinación hallada y no detectaba la
//     ambigüedad: era un defecto (una combinación equivocada se proponía con puntaje alto).
//   * Si se agota el presupuesto de nodos, devuelve `presupuesto_agotado`: "no se terminó de buscar" NO es "no hay combinación" y jamás
//     se devuelve una combinación parcial.

/** Con más candidatos que esto se usa meet-in-the-middle. */
export const MITM_UMBRAL = 40;
/** Presupuesto de nodos visitados por búsqueda (por mitad en MITM). */
export const PRESUPUESTO_NODOS_POR_DEFECTO = 2_000_000;
export const MAX_COMBINACIONES_POR_DEFECTO = 200;

/** Convierte pesos a centavos enteros sin arrastrar el error binario del flotante (`19.99 * 100 = 1998.9999...`). */
export function aCentavos(pesos: number): number {
  return Math.round(Number((pesos * 100).toFixed(4)));
}

export interface ItemSubsetSum {
  /** Identificador opaco del llamador (índice en su arreglo). */
  readonly id: number;
  /** Monto en centavos, entero positivo. */
  readonly centavos: number;
}

export interface OpcionesSubsetSum {
  readonly minTamano?: number; // default 2
  readonly maxTamano?: number; // default 15
  readonly maxNodos?: number;
  readonly maxCombinaciones?: number;
}

export type ResultadoSubsetSum =
  | { readonly estado: "ok"; readonly combinaciones: readonly (readonly number[])[]; readonly truncado: boolean }
  | { readonly estado: "presupuesto_agotado"; readonly nodos: number };

class PresupuestoAgotado extends Error {
  constructor(readonly nodos: number) {
    super("presupuesto de nodos agotado");
  }
}

/** Todas las combinaciones de `items` (tamaño min..max) cuya suma cae en [bajo, alto] (centavos, inclusivo). Cada combinación va como
 * lista de `id` ordenada ascendente; el arreglo de combinaciones sale en orden determinista (por tamaño, luego lexicográfico). */
export function buscarSubconjuntos(items: readonly ItemSubsetSum[], bajo: number, alto: number, opciones: OpcionesSubsetSum = {}): ResultadoSubsetSum {
  const minTamano = Math.max(2, Math.trunc(opciones.minTamano ?? 2));
  const maxTamano = Math.max(minTamano, Math.trunc(opciones.maxTamano ?? 15));
  const maxNodos = opciones.maxNodos ?? PRESUPUESTO_NODOS_POR_DEFECTO;
  const maxCombinaciones = opciones.maxCombinaciones ?? MAX_COMBINACIONES_POR_DEFECTO;
  const limpios = items.filter((i) => Number.isSafeInteger(i.centavos) && i.centavos > 0);
  const piso = Math.max(0, bajo);
  if (limpios.length < minTamano || alto < piso || alto < 0) return { estado: "ok", combinaciones: [], truncado: false };
  try {
    const crudas = limpios.length > MITM_UMBRAL ? meetInTheMiddle(limpios, piso, alto, minTamano, maxTamano, maxNodos, maxCombinaciones) : fuerzaBruta(limpios, piso, alto, minTamano, maxTamano, maxNodos, maxCombinaciones);
    const combinaciones = crudas.lista.map((c) => [...c].sort((a, b) => a - b));
    combinaciones.sort(compararCombinaciones);
    return { estado: "ok", combinaciones, truncado: crudas.truncado };
  } catch (err) {
    if (err instanceof PresupuestoAgotado) return { estado: "presupuesto_agotado", nodos: err.nodos };
    throw err;
  }
}

function compararCombinaciones(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) return a.length - b.length;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return 0;
}

interface Crudas {
  readonly lista: number[][];
  readonly truncado: boolean;
}

function fuerzaBruta(items: readonly ItemSubsetSum[], bajo: number, alto: number, minTamano: number, maxTamano: number, maxNodos: number, maxCombinaciones: number): Crudas {
  const ordenados = [...items].sort((a, b) => a.centavos - b.centavos || a.id - b.id);
  const n = ordenados.length;
  // restante[i] = suma de ordenados[i..n-1]: si ni tomando todo lo que queda se llega a `bajo`, se poda.
  const restante = new Array<number>(n + 1).fill(0);
  for (let i = n - 1; i >= 0; i--) restante[i] = restante[i + 1]! + ordenados[i]!.centavos;
  const lista: number[][] = [];
  const elegidos: number[] = [];
  let nodos = 0;
  let truncado = false;

  const dfs = (inicio: number, suma: number): void => {
    nodos++;
    if (nodos > maxNodos) throw new PresupuestoAgotado(nodos);
    if (truncado) return;
    if (elegidos.length >= minTamano && suma >= bajo && suma <= alto) {
      if (lista.length >= maxCombinaciones) {
        truncado = true;
        return;
      }
      lista.push(elegidos.map((k) => ordenados[k]!.id));
    }
    if (elegidos.length === maxTamano) return;
    for (let i = inicio; i < n; i++) {
      const nueva = suma + ordenados[i]!.centavos;
      if (nueva > alto) break; // ascendente: ninguno posterior sirve
      if (nueva + (restante[i + 1] ?? 0) < bajo) continue; // aun tomando todo lo que queda no se llega al piso
      elegidos.push(i);
      dfs(i + 1, nueva);
      elegidos.pop();
      if (truncado) return;
    }
  };
  dfs(0, 0);
  return { lista, truncado };
}

interface Mitad {
  readonly sumas: number[];
  readonly tamanos: number[];
  /** Máscara de bits de los índices de la mitad (la mitad nunca pasa de ~30 elementos). */
  readonly mascaras: number[];
}

function enumerarMitad(items: readonly ItemSubsetSum[], alto: number, maxTamano: number, maxNodos: number): Mitad {
  const ordenados = items.map((it, idx) => ({ it, idx })).sort((a, b) => a.it.centavos - b.it.centavos);
  const n = ordenados.length;
  const sumas: number[] = [0];
  const tamanos: number[] = [0];
  const mascaras: number[] = [0];
  let nodos = 0;
  const dfs = (inicio: number, suma: number, tam: number, mascara: number): void => {
    nodos++;
    if (nodos > maxNodos) throw new PresupuestoAgotado(nodos);
    if (tam > 0) {
      sumas.push(suma);
      tamanos.push(tam);
      mascaras.push(mascara);
    }
    if (tam === maxTamano) return;
    for (let i = inicio; i < n; i++) {
      const nueva = suma + ordenados[i]!.it.centavos;
      if (nueva > alto) break;
      dfs(i + 1, nueva, tam + 1, mascara | (1 << ordenados[i]!.idx));
    }
  };
  dfs(0, 0, 0, 0);
  return { sumas, tamanos, mascaras };
}

function lowerBound(arr: readonly number[], x: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid]! < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
function upperBound(arr: readonly number[], x: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid]! <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function idsDeMascara(mascara: number, items: readonly ItemSubsetSum[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < items.length; i++) if (mascara & (1 << i)) out.push(items[i]!.id);
  return out;
}

function meetInTheMiddle(items: readonly ItemSubsetSum[], bajo: number, alto: number, minTamano: number, maxTamano: number, maxNodos: number, maxCombinaciones: number): Crudas {
  const mitad = Math.floor(items.length / 2);
  const izquierdaItems = items.slice(0, mitad);
  const derechaItems = items.slice(mitad);
  // Cada mitad cabe en una máscara de 31 bits: el techo de candidatos del motor (60) deja 30 por mitad.
  if (izquierdaItems.length > 31 || derechaItems.length > 31) throw new PresupuestoAgotado(Number.MAX_SAFE_INTEGER);
  const izq = enumerarMitad(izquierdaItems, alto, maxTamano, maxNodos);
  const der = enumerarMitad(derechaItems, alto, maxTamano, maxNodos);
  const orden = izq.sumas.map((_, i) => i).sort((a, b) => izq.sumas[a]! - izq.sumas[b]!);
  const sumasOrdenadas = orden.map((i) => izq.sumas[i]!);
  const lista: number[][] = [];
  let truncado = false;
  let nodos = 0;
  for (let r = 0; r < der.sumas.length && !truncado; r++) {
    const necesitaBajo = bajo - der.sumas[r]!;
    const necesitaAlto = alto - der.sumas[r]!;
    if (necesitaAlto < 0) continue;
    const lo = lowerBound(sumasOrdenadas, necesitaBajo);
    const hi = upperBound(sumasOrdenadas, necesitaAlto);
    for (let j = lo; j < hi; j++) {
      const l = orden[j]!;
      const tam = izq.tamanos[l]! + der.tamanos[r]!;
      if (tam < minTamano || tam > maxTamano) continue;
      nodos++;
      if (nodos > maxNodos) throw new PresupuestoAgotado(nodos);
      if (lista.length >= maxCombinaciones) {
        truncado = true;
        break;
      }
      lista.push([...idsDeMascara(izq.mascaras[l]!, izquierdaItems), ...idsDeMascara(der.mascaras[r]!, derechaItems)]);
    }
  }
  return { lista, truncado };
}
