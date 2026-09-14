// Motor de resolución de versión `UID -> SEQUENCE -> DTSTAMP` + hash de contenido
// como respaldo — port literal de rentas/packages/domain/src/resolucionVersion.ts
// (repo origen, H-006, REQ-028/167/179). Función pura: no parsea ICS (eso es
// ../ical/parser.ts), solo decide qué hacer dado un evento "actual" (o ausente) y uno
// "entrante" ya normalizados por el llamador (./motor.ts).
//
// Justificación del orden: `SEQUENCE` es la señal de versión recomendada por RFC
// 5545, pero NO hay evidencia primaria de que los canales la incrementen de forma
// fiable en feeds `PUBLISH` (sin `METHOD` iTIP) — se trata como señal oportunista,
// nunca como única fuente de verdad. `DTSTAMP` desempata cuando `SEQUENCE` no decide.
// El hash de contenido `(unidad, DTSTART, DTEND, razón)` detecta reimportaciones sin
// cambio real (no-op, anti-eco) y UID reciclado.
import { rangosSeSuperponen } from "../fechas.ts";
import type { RangoFechas } from "../tipos.ts";

export interface VersionEvento {
  uid: string;
  /** `null` cuando el feed de origen no expone SEQUENCE de forma confiable. */
  sequence: number | null;
  /** Instante UTC en formato ISO 8601. */
  dtstamp: string;
  /** Hash de `(unidad, DTSTART, DTEND, razón)` — ver ../ical/exportador.ts::calcularHashContenidoBloqueo. */
  hash: string;
  /** Rango de fechas `[dtstart, dtend)` de esta versión del evento, cuando el
   * llamador lo tiene disponible (señal independiente del hash para la heurística de
   * "UID reciclado" sin `SEQUENCE` comparable). Opcional: sin él, esa rama conserva el
   * comportamiento por defecto (nunca marca sospecha adicional por rango). */
  rango?: RangoFechas;
}

export type AccionResolucion = "aplicar" | "descartar" | "sin_cambio" | "revisar_uid_reciclado";

export interface ResultadoResolucion {
  accion: AccionResolucion;
  /** Explicación legible para auditoría/logs (nunca datos de huésped). */
  motivo: string;
}

function sonRangosContiguos(a: RangoFechas, b: RangoFechas): boolean {
  return a.fin === b.inicio || b.fin === a.inicio;
}

/** `true` cuando ambos rangos están disponibles y no comparten ninguna relación
 * razonable (ni se solapan ni son contiguos) — sin información de rango en cualquiera
 * de los dos lados, no hay base para sospechar y se devuelve `false`. */
function esCambioDeRangoSospechoso(anterior: RangoFechas | undefined, entrante: RangoFechas | undefined): boolean {
  if (!anterior || !entrante) return false;
  if (rangosSeSuperponen(anterior, entrante)) return false;
  if (sonRangosContiguos(anterior, entrante)) return false;
  return true;
}

export function resolverVersionEvento(actual: VersionEvento | null, entrante: VersionEvento): ResultadoResolucion {
  if (actual === null) {
    return { accion: "aplicar", motivo: "no existe versión previa para este UID" };
  }
  if (actual.uid !== entrante.uid) {
    throw new Error(`resolverVersionEvento recibió UIDs distintos ("${actual.uid}" vs "${entrante.uid}"); el llamador debe agrupar por UID antes de invocar esta función`);
  }

  // Reimportación exacta (mismo contenido) -> no-op explícito, nunca crea un segundo
  // bloqueo (anti-eco).
  if (actual.hash === entrante.hash) {
    return { accion: "sin_cambio", motivo: "hash de contenido idéntico al almacenado" };
  }

  const secuenciaComparable = actual.sequence !== null && entrante.sequence !== null;

  if (secuenciaComparable && entrante.sequence !== actual.sequence) {
    // SEQUENCE mayor gana, sin importar el orden de llegada real (un CANCEL con
    // SEQUENCE menor que un CREATE/UPDATE posterior nunca se aplica como estado
    // final, aunque llegue después).
    if (entrante.sequence! > actual.sequence!) {
      // Heurística de UID reciclado: un SEQUENCE mayor pero un DTSTAMP anterior al
      // almacenado, con contenido completamente distinto, es más consistente con
      // "este UID se reutilizó para una reserva nueva y no relacionada" que con "esta
      // es una revisión legítima más nueva de la misma reserva" — nunca se fusiona en
      // silencio, se marca para revisión humana.
      if (entrante.dtstamp < actual.dtstamp) {
        return { accion: "revisar_uid_reciclado", motivo: "SEQUENCE entrante mayor pero DTSTAMP anterior al almacenado, con contenido distinto" };
      }
      return { accion: "aplicar", motivo: "SEQUENCE entrante mayor" };
    }
    return { accion: "descartar", motivo: "SEQUENCE entrante menor o igual, evento desordenado" };
  }

  // SEQUENCE no comparable (ausente en uno de los dos, o feed sin garantía) o
  // SEQUENCE igual: DTSTAMP decide.
  if (entrante.dtstamp > actual.dtstamp) {
    // La heurística de "rango completamente disjunto" de abajo solo aplica cuando
    // SEQUENCE NO es comparable en absoluto (ausente en alguno de los dos lados) —
    // ese es el caso en el que un DTSTAMP más reciente por sí solo no distingue
    // "modificación legítima de la misma reserva" de "el canal recicló este UID para
    // una reserva nueva y no relacionada". Cuando SEQUENCE SÍ es comparable pero
    // igual (el canal reenvía el mismo UID+SEQUENCE con contenido distinto), el
    // propio SEQUENCE idéntico ya es la señal de "sigue siendo la misma versión
    // lógica" — no se aplica esta sospecha adicional por rango.
    if (!secuenciaComparable && esCambioDeRangoSospechoso(actual.rango, entrante.rango)) {
      return {
        accion: "revisar_uid_reciclado",
        motivo: "DTSTAMP entrante más reciente, SEQUENCE no comparable, y el rango de fechas entrante es completamente disjunto y no contiguo con el anterior",
      };
    }
    return { accion: "aplicar", motivo: "DTSTAMP entrante más reciente" };
  }
  if (entrante.dtstamp < actual.dtstamp) {
    return { accion: "descartar", motivo: "DTSTAMP entrante más antiguo" };
  }

  // SEQUENCE igual (o no comparable) y DTSTAMP igual, pero hash distinto: dos eventos
  // afirman ser exactamente la misma versión con contenido distinto — ambigüedad
  // genuina, nunca se resuelve por inferencia silenciosa.
  return { accion: "revisar_uid_reciclado", motivo: "SEQUENCE y DTSTAMP idénticos con hash de contenido distinto" };
}
