// Layouts de exportación CSV de los bancos mexicanos principales. IMPORTANTE (honestidad
// de alcance): no existe un estándar público único; cada banco (y cada producto:
// Net Cash, Banorte en Línea, Supernet, Scotia en Línea, etc.) exporta encabezados
// ligeramente distintos y los cambia sin avisar. En lugar de codificar posiciones fijas
// por banco (frágil), el parser reconoce las COLUMNAS por su encabezado (alias
// normalizados sin acentos ni mayúsculas) y el perfil por banco solo aporta (a) palabras
// clave para identificar el banco en el preámbulo del archivo, (b) firmas de encabezado
// y (c) nada más: cuando hay varias columnas de fecha se prefiere SIEMPRE la fecha de
// operación (cuándo ocurrió el movimiento) sobre la de aplicación/valor. Los alias salen de
// los nombres de columna habituales de las exportaciones empresariales; los fixtures de
// pruebas son SINTÉTICOS (sin datos de clientes) y NO se han contrastado con un archivo
// real de cada banco. Un banco/layout no reconocido cae al perfil "generico" con los
// mismos alias, y el contador siempre puede forzar el banco desde la pantalla.
import type { BancoMx } from "./types.ts";

export type CampoCsv = "fecha" | "descripcion" | "referencia" | "cargo" | "abono" | "importe" | "tipo" | "saldo" | "cuenta";

/** Minúsculas, sin acentos, sin puntuación (salvo "/"), espacios colapsados. */
export function normalizarEncabezado(h: string): string {
  return h
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[."'`:*()]/g, "")
    .replace(/\s*\/\s*/g, "/")
    .replace(/\s+/g, " ")
    .trim();
}

/** Alias EXACTOS (ya normalizados) por campo. El orden dentro de cada lista es la
 * prioridad cuando varias columnas del mismo archivo caben en el mismo campo. */
export const ALIAS_COLUMNAS: Readonly<Record<CampoCsv, readonly string[]>> = {
  fecha: ["fecha de operacion", "fecha operacion", "fecha", "fecha de movimiento", "fecha movimiento", "fecha contable", "fecha valor", "fecha de aplicacion", "fecha de registro", "f operacion", "date"],
  descripcion: ["descripcion", "concepto", "descripcion del movimiento", "descripcion de la operacion", "concepto/referencia", "detalle", "leyenda", "descripcion detallada", "movimiento", "description"],
  referencia: ["referencia", "referencia numerica", "numero de referencia", "no de referencia", "num de referencia", "referencia alfanumerica", "folio", "num referencia", "no referencia", "ref", "clave de rastreo", "reference"],
  cargo: ["cargo", "cargos", "retiro", "retiros", "debito", "debitos", "importe cargo", "monto cargo", "salidas", "retiros/cargos", "cargos/retiros", "debit"],
  abono: ["abono", "abonos", "deposito", "depositos", "credito", "creditos", "importe abono", "monto abono", "entradas", "depositos/abonos", "abonos/depositos", "credit"],
  importe: ["importe", "monto", "amount"],
  tipo: ["cargo/abono", "tipo", "tipo de movimiento", "tipo movimiento", "naturaleza", "signo", "c/a"],
  saldo: ["saldo", "saldo final", "saldo disponible", "saldo en cuenta", "saldo contable", "balance"],
  cuenta: ["cuenta", "numero de cuenta", "no de cuenta", "clabe", "account"],
};

export interface PerfilBanco {
  readonly id: BancoMx;
  readonly nombre: string;
  /** Texto (sin acentos, minúsculas) que, si aparece en el preámbulo, identifica al banco. */
  readonly palabrasClave: readonly string[];
  /** Encabezados normalizados cuya presencia delata el layout aunque no haya preámbulo. */
  readonly firmasEncabezado: readonly string[];
}

export const PERFILES_BANCO: Readonly<Record<BancoMx, PerfilBanco>> = {
  bbva: { id: "bbva", nombre: "BBVA México", palabrasClave: ["bbva", "bancomer"], firmasEncabezado: ["concepto/referencia"] },
  banorte: { id: "banorte", nombre: "Banorte", palabrasClave: ["banorte", "ixe banco"], firmasEncabezado: ["cod transac", "descripcion detallada"] },
  santander: { id: "santander", nombre: "Santander", palabrasClave: ["santander"], firmasEncabezado: ["cargo/abono"] },
  hsbc: { id: "hsbc", nombre: "HSBC México", palabrasClave: ["hsbc"], firmasEncabezado: [] },
  scotiabank: { id: "scotiabank", nombre: "Scotiabank", palabrasClave: ["scotiabank", "scotia"], firmasEncabezado: [] },
  banamex: { id: "banamex", nombre: "Citibanamex", palabrasClave: ["banamex", "citibanamex", "citi banamex"], firmasEncabezado: [] },
  inbursa: { id: "inbursa", nombre: "Inbursa", palabrasClave: ["inbursa"], firmasEncabezado: [] },
  generico: { id: "generico", nombre: "Genérico", palabrasClave: [], firmasEncabezado: [] },
};

function sinAcentos(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** Identifica el banco por el preámbulo o por la firma de los encabezados. */
export function detectarBanco(preambulo: string, encabezadosNormalizados: readonly string[]): BancoMx | null {
  const texto = sinAcentos(preambulo);
  for (const perfil of Object.values(PERFILES_BANCO)) {
    if (perfil.id === "generico") continue;
    if (perfil.palabrasClave.some((p) => new RegExp(`(^|[^a-z])${p}([^a-z]|$)`).test(texto))) return perfil.id;
  }
  for (const perfil of Object.values(PERFILES_BANCO)) {
    if (perfil.firmasEncabezado.some((f) => encabezadosNormalizados.includes(f))) return perfil.id;
  }
  return null;
}

/** Mapa campo → índice de columna (primer alias que coincide, en orden de prioridad). */
export function mapearColumnas(encabezadosNormalizados: readonly string[]): Partial<Record<CampoCsv, number>> {
  const mapa: Partial<Record<CampoCsv, number>> = {};
  const usadas = new Set<number>();
  const orden: CampoCsv[] = ["tipo", "fecha", "cargo", "abono", "importe", "saldo", "referencia", "cuenta", "descripcion"];
  for (const campo of orden) {
    for (const a of ALIAS_COLUMNAS[campo]) {
      const idx = encabezadosNormalizados.findIndex((h, i) => h === a && !usadas.has(i));
      if (idx !== -1) {
        mapa[campo] = idx;
        usadas.add(idx);
        break;
      }
    }
  }
  return mapa;
}

/** Una fila es el encabezado si reconoce fecha + (cargo|abono|importe). */
export function esFilaEncabezado(encabezadosNormalizados: readonly string[]): boolean {
  const mapa = mapearColumnas(encabezadosNormalizados);
  return mapa.fecha !== undefined && (mapa.importe !== undefined || mapa.cargo !== undefined || mapa.abono !== undefined);
}

/** Dígito verificador de una CLABE (18 dígitos, ponderadores 3-7-1, Circular 14/2017 Banxico). */
export function clabeValida(clabe: string): boolean {
  if (!/^\d{18}$/.test(clabe)) return false;
  const pesos = [3, 7, 1];
  let suma = 0;
  for (let i = 0; i < 17; i++) suma += ((Number(clabe[i]) * pesos[i % 3]!) % 10);
  const dv = (10 - (suma % 10)) % 10;
  return dv === Number(clabe[17]);
}

/** Clave de institución (3 primeros dígitos de la CLABE, catálogo público de Banxico/ABM). */
const CLAVE_BANCO_CLABE: Readonly<Record<string, BancoMx>> = {
  "002": "banamex",
  "012": "bbva",
  "014": "santander",
  "021": "hsbc",
  "036": "inbursa",
  "044": "scotiabank",
  "072": "banorte",
};

/** Banco por los 3 primeros dígitos de una CLABE VÁLIDA (dígito verificador correcto). */
export function bancoPorClabe(clabe: string | null): BancoMx | null {
  if (clabe === null || !clabeValida(clabe)) return null;
  return CLAVE_BANCO_CLABE[clabe.slice(0, 3)] ?? null;
}
