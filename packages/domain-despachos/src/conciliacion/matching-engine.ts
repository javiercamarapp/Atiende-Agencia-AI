// Puerto de `b2b_ai/features/reconciliation_agent/matching_engine.py` — motor de
// conciliación bancaria progresivo de niveles. El origen define 4 niveles:
//   1. Exact       — mismo monto (±0.01) + misma fecha (o ±1 día) + referencia.
//   2. Fuzzy       — monto ±tolerancia%, fecha ±tolerancia días, similitud de texto.
//   3. Multi-línea — un pago bancario cubre varios registros contables (subset sum).
//   4. LLM         — razonamiento de IA para casos ambiguos (`enable_llm`).
//
// Fase 5 (esta fase) porta los niveles 1-3 —lógica propia 100% determinística y
// portable— y DELIBERADAMENTE NO porta el nivel 4: en el origen ya viene deshabilitado
// por default (`enable_llm: bool = False`) y depende de un `LLMService` inyectado que
// hace una llamada de IA generativa con un prompt libre; no es una regla de negocio
// verificable con un golden-set (no hay "resultado correcto" determinístico que
// comparar byte a byte contra el intérprete Python — depende del proveedor de LLM que
// se conecte). Portarlo aquí sin un contrato de verificación sería fingir paridad que
// no se puede demostrar. Si se requiere en el futuro, debe entrar como una capacidad
// aparte con su propio adaptador (mismo patrón fail-closed que el resto del
// monorepo), nunca mezclada en este motor determinístico.
//
// Todas las tolerancias/umbrales numéricos son EXACTOS al origen (ver
// `OpcionesMatchingEngine` en `types.ts`): dateToleranceDays=3, montoTolerancePct=5.0,
// fuzzyThreshold=80. La comparación de texto del nivel 2 usa `partialRatio` de
// `text-similarity.ts` — ver ese archivo para el análisis honesto de fidelidad frente
// a `rapidfuzz.fuzz.partial_ratio` (aproximación verificada, no byte-exacta).
import type { CoincidenciaConciliacion, MovimientoBancario, OpcionesMatchingEngine, RegistroConciliable, ResultadoConciliacion } from "./types.ts";
import { partialRatio } from "./text-similarity.ts";
import { fechaDiff } from "./fechas.ts";

const DEFAULT_DATE_TOLERANCE_DAYS = 3;
const DEFAULT_MONTO_TOLERANCE_PCT = 5.0;
const DEFAULT_FUZZY_THRESHOLD = 80;

/** `_dec` — parsea un monto que puede venir como número o string con formato libre
 * ("$1,234.50", " 1234.50 "). Devuelve `null` si no es parseable, igual que el
 * origen (nunca lanza). */
function dec(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = String(v).trim().replace(/,/g, "").replace(/\$/g, "").replace(/ /g, "");
  if (s === "" || s === "-" || s === "--" || s.toLowerCase() === "n/a") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Primeros 10 caracteres de `rec.fecha` (equivalente a `str(rec.get("fecha",""))[:10]`
 * del origen, que así trunca timestamps ISO completos a solo la fecha). */
function fechaRegistro(rec: RegistroConciliable): string {
  return (rec.fecha ?? "").slice(0, 10);
}

/** `rec.get("monto", rec.get("total"))` del origen. */
function montoRegistro(rec: RegistroConciliable): number | null {
  return dec(rec.monto !== undefined && rec.monto !== null ? rec.monto : rec.total);
}

/** `rec.get("descripcion", rec.get("concepto", rec.get("referencia", "")))` del
 * origen. Nota de fidelidad: el origen usa semántica de `dict.get(key, default)` de
 * Python, que solo cae al fallback si la LLAVE está ausente (no si el valor es
 * explícitamente `None`) — con `None` explícito, `str(None)` produce el string
 * literal `"None"` en el resultado, un artefacto de la librería estándar de Python,
 * no una regla de negocio. Aquí se trata `null`/`undefined` igual (ambos caen al
 * fallback), que es el comportamiento sensato y el único alcanzable en la práctica
 * desde JSON de una API HTTP (nadie envía intencionalmente `descripcion: null` para
 * pedir el string literal "None"). */
function descripcionRegistro(rec: RegistroConciliable): string {
  return String(rec.descripcion ?? rec.concepto ?? rec.referencia ?? "");
}

/** `_check_ref`. */
function checkRef(mov: MovimientoBancario, rec: RegistroConciliable): boolean {
  const movRef = (mov.referencia ?? "").trim().toLowerCase();
  const recRef = String(rec.referencia ?? rec.folioFiscal ?? "").trim().toLowerCase();
  if (!movRef || !recRef) return false;
  return movRef.includes(recRef) || recRef.includes(movRef);
}

function round2(v: number): number {
  return Math.round((v + Number.EPSILON) * 100) / 100;
}
function round1(v: number): number {
  return Math.round((v + Number.EPSILON) * 10) / 10;
}

interface ResultadoNivel {
  readonly matches: CoincidenciaConciliacion[];
  readonly freeMovs: number[];
  readonly freeRecs: number[];
}

/** Nivel 1: exacto. */
function emparejarExacto(movements: readonly MovimientoBancario[], records: readonly RegistroConciliable[], freeMovsIn: readonly number[], freeRecsIn: readonly number[]): ResultadoNivel {
  const matches: CoincidenciaConciliacion[] = [];
  const usedMov = new Set<number>();
  const usedRec = new Set<number>();

  for (const mi of freeMovsIn) {
    const mov = movements[mi]!;
    const montoMov = mov.monto;
    for (const ri of freeRecsIn) {
      if (usedRec.has(ri)) continue;
      const rec = records[ri]!;
      const mRec = montoRegistro(rec);
      if (mRec === null) continue;
      if (Math.abs(Math.abs(montoMov) - Math.abs(mRec)) > 0.01) continue;

      const fRec = fechaRegistro(rec);
      const diff = fechaDiff(mov.fecha, fRec);
      if (diff === null || diff > 1) continue;

      const refMatch = checkRef(mov, rec);
      if (refMatch || diff === 0) {
        matches.push({
          movementIdx: mi,
          registroIdx: ri,
          registroIndices: null,
          level: "exacto",
          score: diff === 0 ? 100 : 97,
          detail: `Monto exacto (${mRec}) y fecha ${diff === 0 ? "igual" : `a ${diff}d`}`,
          montoBanco: montoMov,
          montoRegistro: mRec,
          fechaBanco: mov.fecha,
          fechaRegistro: fRec,
        });
        usedMov.add(mi);
        usedRec.add(ri);
        break;
      }
    }
  }

  return {
    matches,
    freeMovs: freeMovsIn.filter((m) => !usedMov.has(m)),
    freeRecs: freeRecsIn.filter((r) => !usedRec.has(r)),
  };
}

/** Nivel 2: fuzzy (monto ±%, fecha ±días, similitud de descripción). */
function emparejarFuzzy(
  movements: readonly MovimientoBancario[],
  records: readonly RegistroConciliable[],
  freeMovsIn: readonly number[],
  freeRecsIn: readonly number[],
  dateToleranceDays: number,
  montoTolerancePct: number,
  fuzzyThreshold: number,
): ResultadoNivel {
  const matches: CoincidenciaConciliacion[] = [];
  const usedMov = new Set<number>();
  const usedRec = new Set<number>();

  for (const mi of freeMovsIn) {
    const mov = movements[mi]!;
    const montoMov = mov.monto;
    let bestRi: number | null = null;
    let bestScore = 0;

    for (const ri of freeRecsIn) {
      if (usedRec.has(ri)) continue;
      const rec = records[ri]!;
      const mRec = montoRegistro(rec);
      if (mRec === null) continue;

      const absMov = Math.abs(montoMov);
      const absRec = Math.abs(mRec);
      if (absRec === 0) continue;
      const diffPct = (Math.abs(absMov - absRec) / absRec) * 100;
      if (diffPct > montoTolerancePct) continue;

      const fRec = fechaRegistro(rec);
      const dayDiff = fechaDiff(mov.fecha, fRec);
      if (dayDiff === null || dayDiff > dateToleranceDays) continue;

      const descMov = `${mov.descripcion} ${mov.referencia ?? ""}`.trim();
      const descRec = descripcionRegistro(rec).trim();
      const ratioTexto = partialRatio(descMov.toLowerCase(), descRec.toLowerCase());

      if (ratioTexto >= fuzzyThreshold) {
        const amountScore = Math.max(0, 100 - diffPct * 10);
        const dateScore = Math.max(0, 100 - dayDiff * 25);
        let score = ratioTexto * 0.6 + amountScore * 0.25 + dateScore * 0.15;
        score = Math.min(95, Math.max(50, score));
        if (score > bestScore) {
          bestScore = score;
          bestRi = ri;
        }
      }
    }

    if (bestRi !== null) {
      const rec = records[bestRi]!;
      const mRec = montoRegistro(rec)!;
      const fRec = fechaRegistro(rec);
      // Nota de fidelidad: el origen recalcula el texto del `detail` con
      // `fuzz.partial_ratio(mov.descripcion, str(rec.get('descripcion','')))` — SIN
      // incluir `referencia`, SIN el fallback a concepto/referencia, y SIN
      // minúsculas — es decir, con una comparación distinta a la que realmente
      // decidió el match. Es un bug cosmético del origen (el texto mostrado al
      // usuario no siempre coincide con lo que se comparó de verdad para producir el
      // score); aquí se corrige mostrando la comparación REAL usada para el score,
      // documentado en vez de replicar la inconsistencia.
      const descMov = `${mov.descripcion} ${mov.referencia ?? ""}`.trim();
      const descRec = descripcionRegistro(rec).trim();
      const ratioMostrado = round1(partialRatio(descMov.toLowerCase(), descRec.toLowerCase()));
      matches.push({
        movementIdx: mi,
        registroIdx: bestRi,
        registroIndices: null,
        level: "fuzzy",
        score: round1(bestScore),
        detail: `Fuzzy match: descripción similar (${ratioMostrado}%)`,
        montoBanco: montoMov,
        montoRegistro: mRec,
        fechaBanco: mov.fecha,
        fechaRegistro: fRec,
      });
      usedMov.add(mi);
      usedRec.add(bestRi);
    }
  }

  return {
    matches,
    freeMovs: freeMovsIn.filter((m) => !usedMov.has(m)),
    freeRecs: freeRecsIn.filter((r) => !usedRec.has(r)),
  };
}

/** `_find_subset_sum` — combinaciones de tamaño creciente (2..min(8,n)), en el mismo
 * orden que `itertools.combinations` (índices en orden lexicográfico creciente sobre
 * la lista ya ordenada descendentemente por monto), devuelve la PRIMERA combinación
 * cuya suma cae dentro de la tolerancia — no la mejor de todas, la primera hallada en
 * ese orden de enumeración (igual que el origen). */
function encontrarSubsetSum(candidatos: ReadonlyArray<readonly [number, number]>, target: number, tolerancePct = 1.0, maxComboSize = 8): Array<readonly [number, number]> | null {
  const tol = (target * tolerancePct) / 100;
  const sorted = [...candidatos].sort((a, b) => b[1] - a[1]);

  const maxSize = Math.min(maxComboSize + 1, sorted.length + 1);
  for (let size = 2; size < maxSize; size++) {
    if (size > 10) break;
    const combo = new Array<number>(size);
    const resultado = combinacionesRecursivo(sorted, size, 0, combo, 0, target, tol);
    if (resultado) return resultado;
  }
  return null;
}

function combinacionesRecursivo(
  sorted: ReadonlyArray<readonly [number, number]>,
  size: number,
  start: number,
  indices: number[],
  depth: number,
  target: number,
  tol: number,
): Array<readonly [number, number]> | null {
  if (depth === size) {
    let total = 0;
    for (let k = 0; k < size; k++) total += sorted[indices[k]!]![1];
    if (Math.abs(total - target) <= tol) {
      return indices.map((i) => sorted[i]!);
    }
    return null;
  }
  for (let i = start; i <= sorted.length - (size - depth); i++) {
    indices[depth] = i;
    const found = combinacionesRecursivo(sorted, size, i + 1, indices, depth + 1, target, tol);
    if (found) return found;
  }
  return null;
}

/** Nivel 3: multi-línea (un movimiento bancario cubre varios registros — subset sum
 * con tolerancia). Solo se intenta para movimientos con |monto| >= 100 (evita ruido
 * en montos pequeños, igual que el origen). */
function emparejarMultilinea(
  movements: readonly MovimientoBancario[],
  records: readonly RegistroConciliable[],
  freeMovsIn: readonly number[],
  freeRecsIn: readonly number[],
  dateToleranceDays: number,
): ResultadoNivel {
  const matches: CoincidenciaConciliacion[] = [];
  const usedMov = new Set<number>();
  const usedRecs = new Set<number>();

  for (const mi of freeMovsIn) {
    const mov = movements[mi]!;
    const montoMov = Math.abs(mov.monto);
    if (montoMov < 100 || usedMov.has(mi)) continue;

    const candidatos: Array<readonly [number, number]> = [];
    for (const ri of freeRecsIn) {
      if (usedRecs.has(ri)) continue;
      const rec = records[ri]!;
      const mRec = Math.abs(montoRegistro(rec) ?? 0);
      const fRec = fechaRegistro(rec);
      const dayDiff = fechaDiff(mov.fecha, fRec);
      if (mRec > 0 && dayDiff !== null && dayDiff <= dateToleranceDays) {
        candidatos.push([ri, mRec]);
      }
    }

    if (candidatos.length < 2) continue;

    const combo = encontrarSubsetSum(candidatos, montoMov, 1.0);
    if (combo && combo.length >= 2) {
      const comboIndices = combo.map((c) => c[0]);
      const comboTotal = combo.reduce((acc, c) => acc + c[1], 0);
      const diffPct = (Math.abs(montoMov - comboTotal) / Math.max(montoMov, 1)) * 100;
      const score = Math.min(round1(Math.max(70, 95 - diffPct * 10)), 95);

      matches.push({
        movementIdx: mi,
        registroIdx: null,
        registroIndices: comboIndices,
        level: "multi_linea",
        score,
        detail: `Multi-línea: ${combo.length} registros suman $${comboTotal.toFixed(2)} ≈ $${montoMov.toFixed(2)}`,
        montoBanco: mov.monto,
        montoRegistro: comboTotal,
        fechaBanco: mov.fecha,
        fechaRegistro: fechaRegistro(records[comboIndices[0]!]!),
      });
      usedMov.add(mi);
      for (const ri of comboIndices) usedRecs.add(ri);
    }
  }

  return {
    matches,
    freeMovs: freeMovsIn.filter((m) => !usedMov.has(m)),
    freeRecs: freeRecsIn.filter((r) => !usedRecs.has(r)),
  };
}

/** `MatchingEngine.match` — orquesta niveles 1→2→3 sobre los índices libres. */
export function conciliarMovimientos(movements: readonly MovimientoBancario[], records: readonly RegistroConciliable[], opciones: OpcionesMatchingEngine = {}): ResultadoConciliacion {
  const dateToleranceDays = opciones.dateToleranceDays ?? DEFAULT_DATE_TOLERANCE_DAYS;
  const montoTolerancePct = opciones.montoTolerancePct ?? DEFAULT_MONTO_TOLERANCE_PCT;
  const fuzzyThreshold = opciones.fuzzyThreshold ?? DEFAULT_FUZZY_THRESHOLD;

  const start = performance.now();

  let freeMovs = movements.map((_, i) => i);
  let freeRecs = records.map((_, i) => i);
  const matches: CoincidenciaConciliacion[] = [];

  const l1 = emparejarExacto(movements, records, freeMovs, freeRecs);
  matches.push(...l1.matches);
  freeMovs = l1.freeMovs;
  freeRecs = l1.freeRecs;

  const l2 = emparejarFuzzy(movements, records, freeMovs, freeRecs, dateToleranceDays, montoTolerancePct, fuzzyThreshold);
  matches.push(...l2.matches);
  freeMovs = l2.freeMovs;
  freeRecs = l2.freeRecs;

  const l3 = emparejarMultilinea(movements, records, freeMovs, freeRecs, dateToleranceDays);
  matches.push(...l3.matches);
  freeMovs = l3.freeMovs;
  freeRecs = l3.freeRecs;

  const elapsedMs = performance.now() - start;

  const unmatchedBank = freeMovs.map((i) => movements[i]!);
  const unmatchedBooks = freeRecs.map((i) => records[i]!);

  const montoMatched = matches.reduce((acc, m) => acc + Math.abs(m.montoBanco), 0);
  const montoBankTotal = movements.reduce((acc, m) => acc + Math.abs(m.monto), 0);

  const totalMovs = movements.length;
  const totalRecs = records.length;
  const totalMatched = matches.length;
  const matchRate = (totalMatched / Math.max(totalMovs, 1)) * 100;

  const confidence = matches.length > 0 ? matches.reduce((acc, m) => acc + m.score * Math.abs(m.montoBanco), 0) / Math.max(montoBankTotal, 1) : 0;

  return {
    matched: matches,
    unmatchedBank,
    unmatchedBooks,
    confidence: round2(confidence),
    totalMovements: totalMovs,
    totalRecords: totalRecs,
    totalMatched,
    matchRate: round2(matchRate),
    montoMatched: round2(montoMatched),
    montoUnmatchedBank: round2(unmatchedBank.reduce((acc, m) => acc + Math.abs(m.monto), 0)),
    montoUnmatchedBooks: round2(unmatchedBooks.reduce((acc, r) => acc + Math.abs(montoRegistro(r) ?? 0), 0)),
    processingTimeMs: round2(elapsedMs),
  };
}
