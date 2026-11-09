// Puerto de `b2b_ai/features/reconciliation_agent/matching_engine.py` — motor de
// conciliación bancaria progresivo de niveles. El origen define 4 niveles:
//   1. Exact       — mismo monto (±0.01) + misma fecha (o ±1 día) + referencia.
//   2. Fuzzy       — monto ±tolerancia%, fecha ±tolerancia días, similitud de texto.
//   3. Multi-línea — un pago bancario cubre varios registros contables (subset sum).
//   4. LLM         — razonamiento de IA para casos ambiguos (`enable_llm`).
//
// Fase 5 portó los niveles 1-3 —lógica propia 100% determinística y portable— y
// DELIBERADAMENTE NO portó el nivel 4 en ese momento: no era una regla de negocio
// verificable con un golden-set (no hay "resultado correcto" determinístico que
// comparar byte a byte contra el intérprete Python — depende del proveedor de LLM que
// se conecte), y portarlo sin un contrato de verificación habría fingido paridad que
// no se podía demostrar.
//
// El nivel 4 SÍ está portado ahora, como la capacidad aparte con su propio adaptador
// que este comentario ya anticipaba: ver `llm-matching-agent.ts`
// (`sugerirMatchesLLM`/`aprobarSugerenciaLLM`), que opera sobre `unmatchedBank`/
// `unmatchedBooks` — el resultado de este motor determinístico — sin tocar ni
// mezclarse con `conciliarMovimientos`. Mismo patrón fail-closed que el resto del
// monorepo (`@atiende/agent-core::LlmGateway`, sin credenciales → `undefined`, ver
// `apps/api/src/production/llm-gateway.ts`), y con una diferencia de diseño
// DELIBERADA frente al `_pass_ai` del origen: el origen auto-aplica un match con
// `confianza >= 50`; aquí NUNCA se auto-aplica — toda sugerencia del nivel 4 exige
// aprobación humana explícita (`aprobarSugerenciaLLM`, rol en `CONCILIACION_ROLES`)
// antes de convertirse en algo con la forma de un `CoincidenciaConciliacion` real
// (ver cabecera de `llm-matching-agent.ts` para el detalle completo).
//
// Todas las tolerancias/umbrales numéricos son EXACTOS al origen (ver
// `OpcionesMatchingEngine` en `types.ts`): dateToleranceDays=3, montoTolerancePct=5.0,
// fuzzyThreshold=80. La comparación de texto del nivel 2 usa `partialRatio` de
// `text-similarity.ts` — ver ese archivo para el análisis honesto de fidelidad frente
// a `rapidfuzz.fuzz.partial_ratio` (aproximación verificada, no byte-exacta).
import type { AmbiguoMultilinea, CoincidenciaConciliacion, MotivoSinConciliar, MovimientoBancario, OpcionesMatchingEngine, RegistroConciliable, ResultadoConciliacion, SinConciliarMovimiento } from "./types.ts";
import { partialRatio } from "./text-similarity.ts";
import { fechaDiff } from "./fechas.ts";
import { aCentavos, buscarSubconjuntos } from "./subset-sum.ts";

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

/** D-P3-11: dirección contable de un cruce. Abono (cobro) <-> CFDI emitido; cargo (pago) <-> CFDI recibido. `indeterminado` se propone, pero
 * solo con revisión humana. Registro sin `direccion` = llamador heredado sin ese dato: sin filtro. */
export type CompatibilidadDireccion = "compatible" | "revision" | "incompatible";
export function compatibilidadDireccion(mov: MovimientoBancario, rec: RegistroConciliable): CompatibilidadDireccion {
  const d = rec.direccion;
  if (d === undefined || d === null) return "compatible";
  if (d === "indeterminado") return "revision";
  if (mov.monto > 0) return d === "emitido" ? "compatible" : "incompatible";
  if (mov.monto < 0) return d === "recibido" ? "compatible" : "incompatible";
  return "compatible";
}

interface ResultadoNivel {
  readonly matches: CoincidenciaConciliacion[];
  readonly freeMovs: number[];
  readonly freeRecs: number[];
  readonly ambiguos?: AmbiguoMultilinea[];
  readonly motivos?: Map<number, MotivoSinConciliar>;
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
      const dir = compatibilidadDireccion(mov, rec);
      if (dir === "incompatible") continue;
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
          ...(dir === "revision" ? { requiereRevision: true } : {}),
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
      if (compatibilidadDireccion(mov, rec) === "incompatible") continue;

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
        ...(compatibilidadDireccion(mov, rec) === "revision" ? { requiereRevision: true } : {}),
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

const MAX_CANDIDATOS_POR_DEFECTO = 60;
const TOLERANCIA_PCT_POR_DEFECTO = 1.0;
const MAX_CERCANOS = 5;

/** Nivel 3: multi-línea (un movimiento bancario cubre varios registros), D-P3-10. Montos en centavos enteros; solo candidatos de la misma
 * dirección y dentro de la ventana de fechas; techo de candidatos; tamaño 2..15; meet-in-the-middle sobre 40 candidatos; presupuesto de
 * nodos. Se buscan TODAS las combinaciones (las exactas, dentro de `toleranciaCentavos`, tienen prioridad sobre las que solo caben en la
 * tolerancia del 1 %): ninguna -> sin conciliar con motivo; 2 o más -> ambiguo (nunca se propone una al azar); exactamente una -> se propone.
 * Solo se intenta para movimientos con |monto| >= 100 (evita ruido en montos pequeños, igual que el origen). */
function emparejarMultilinea(
  movements: readonly MovimientoBancario[],
  records: readonly RegistroConciliable[],
  freeMovsIn: readonly number[],
  freeRecsIn: readonly number[],
  dateToleranceDays: number,
  opciones: NonNullable<OpcionesMatchingEngine["subsetSum"]>,
): ResultadoNivel {
  const matches: CoincidenciaConciliacion[] = [];
  const ambiguos: AmbiguoMultilinea[] = [];
  const motivos = new Map<number, MotivoSinConciliar>();
  const usedMov = new Set<number>();
  const usedRecs = new Set<number>();
  const maxCandidatos = opciones.maxCandidatos ?? MAX_CANDIDATOS_POR_DEFECTO;
  const toleranciaExacta = Math.max(0, Math.trunc(opciones.toleranciaCentavos ?? 0));
  const toleranciaPct = Math.max(0, opciones.toleranciaPct ?? TOLERANCIA_PCT_POR_DEFECTO);

  for (const mi of freeMovsIn) {
    const mov = movements[mi]!;
    const montoMov = Math.abs(mov.monto);
    if (montoMov < 100 || usedMov.has(mi)) continue;

    const candidatos: Array<{ id: number; centavos: number }> = [];
    const revision = new Set<number>();
    for (const ri of freeRecsIn) {
      if (usedRecs.has(ri)) continue;
      const rec = records[ri]!;
      const dir = compatibilidadDireccion(mov, rec);
      if (dir === "incompatible") continue;
      const centavos = aCentavos(Math.abs(montoRegistro(rec) ?? 0));
      const dayDiff = fechaDiff(mov.fecha, fechaRegistro(rec));
      if (centavos > 0 && dayDiff !== null && dayDiff <= dateToleranceDays) {
        candidatos.push({ id: ri, centavos });
        if (dir === "revision") revision.add(ri);
      }
    }

    if (candidatos.length < 2) {
      motivos.set(mi, "pocos_candidatos");
      continue;
    }
    if (candidatos.length > maxCandidatos) {
      motivos.set(mi, "demasiados_candidatos");
      continue;
    }

    const objetivo = aCentavos(montoMov);
    const ancha = Math.max(toleranciaExacta, Math.floor((objetivo * toleranciaPct) / 100));
    const busqueda = buscarSubconjuntos(candidatos, objetivo - ancha, objetivo + ancha, {
      ...(opciones.minTamano !== undefined ? { minTamano: opciones.minTamano } : {}),
      ...(opciones.maxTamano !== undefined ? { maxTamano: opciones.maxTamano } : {}),
      ...(opciones.maxNodos !== undefined ? { maxNodos: opciones.maxNodos } : {}),
      ...(opciones.maxCombinaciones !== undefined ? { maxCombinaciones: opciones.maxCombinaciones } : {}),
    });
    if (busqueda.estado === "presupuesto_agotado") {
      motivos.set(mi, "presupuesto_agotado");
      continue;
    }
    if (busqueda.combinaciones.length === 0) {
      motivos.set(mi, "sin_combinacion");
      continue;
    }

    const centavosDe = new Map(candidatos.map((c) => [c.id, c.centavos]));
    const suma = (comb: readonly number[]): number => comb.reduce((acc, ri) => acc + centavosDe.get(ri)!, 0);
    const exactas = busqueda.combinaciones.filter((c) => Math.abs(suma(c) - objetivo) <= toleranciaExacta);
    const decision = exactas.length > 0 ? exactas : busqueda.combinaciones;

    if (busqueda.truncado || decision.length >= 2) {
      ambiguos.push({ movementIdx: mi, combinaciones: decision, truncado: busqueda.truncado, exactas: exactas.length > 0, montoBanco: mov.monto });
      motivos.set(mi, "ambiguo");
      continue;
    }

    const combo = decision[0]!;
    const comboTotalCents = suma(combo);
    const comboTotal = comboTotalCents / 100;
    const diffPct = (Math.abs(objetivo - comboTotalCents) / 100 / Math.max(montoMov, 1)) * 100;
    const score = Math.min(round1(Math.max(70, 95 - diffPct * 10)), 95);
    matches.push({
      movementIdx: mi,
      registroIdx: null,
      registroIndices: combo,
      level: "multi_linea",
      score,
      detail: `Multi-línea: ${combo.length} registros suman $${comboTotal.toFixed(2)} ≈ $${montoMov.toFixed(2)}`,
      montoBanco: mov.monto,
      montoRegistro: comboTotal,
      fechaBanco: mov.fecha,
      fechaRegistro: fechaRegistro(records[combo[0]!]!),
      ...(combo.some((ri) => revision.has(ri)) ? { requiereRevision: true } : {}),
    });
    usedMov.add(mi);
    for (const ri of combo) usedRecs.add(ri);
  }

  return {
    matches,
    ambiguos,
    motivos,
    freeMovs: freeMovsIn.filter((m) => !usedMov.has(m)),
    freeRecs: freeRecsIn.filter((r) => !usedRecs.has(r)),
  };
}

/** Los registros individuales libres y de dirección compatible más cercanos en monto al movimiento (para que la UI explique por qué quedó
 * sin conciliar). Nunca se usa para decidir un cruce. */
function registrosMasCercanos(mov: MovimientoBancario, records: readonly RegistroConciliable[], freeRecs: readonly number[]): Array<{ registroIdx: number; diferenciaCentavos: number }> {
  const objetivo = aCentavos(Math.abs(mov.monto));
  const out: Array<{ registroIdx: number; diferenciaCentavos: number }> = [];
  for (const ri of freeRecs) {
    const rec = records[ri]!;
    if (compatibilidadDireccion(mov, rec) === "incompatible") continue;
    const m = montoRegistro(rec);
    if (m === null) continue;
    out.push({ registroIdx: ri, diferenciaCentavos: Math.abs(aCentavos(Math.abs(m)) - objetivo) });
  }
  out.sort((a, b) => a.diferenciaCentavos - b.diferenciaCentavos || a.registroIdx - b.registroIdx);
  return out.slice(0, MAX_CERCANOS);
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

  const l3 = emparejarMultilinea(movements, records, freeMovs, freeRecs, dateToleranceDays, opciones.subsetSum ?? {});
  matches.push(...l3.matches);
  freeMovs = l3.freeMovs;
  freeRecs = l3.freeRecs;

  const elapsedMs = performance.now() - start;

  const sinConciliar: SinConciliarMovimiento[] = freeMovs.map((mi) => ({
    movementIdx: mi,
    motivo: l3.motivos?.get(mi) ?? "sin_candidato",
    cercanos: registrosMasCercanos(movements[mi]!, records, freeRecs),
  }));
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
    ambiguos: l3.ambiguos ?? [],
    sinConciliar,
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
