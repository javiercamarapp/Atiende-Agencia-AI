// Anti-eco de 3 capas independientes — port literal de
// rentas/packages/adapters/src/sync/antiEco.ts (repo origen, D-004, H-029):
//   1. `UID`/namespace propio reconocible en el evento entrante.
//   2. Hash de contenido `(unidad, DTSTART, DTEND, razón)` coincide con lo que
//      nosotros mismos exportamos recientemente, A CUALQUIER CANAL, para esa unidad.
//   3. Metadato "exportado_a": el bloqueo interno candidato (por rango exacto) ya
//      declara que fue exportado a ALGÚN canal (no necesariamente el canal por el que
//      estamos importando ahora).
// Un evento entrante que coincide con CUALQUIERA de las tres nunca se convierte en un
// nuevo bloqueo `RESERVA_CANAL` — evita el bucle "exportamos un bloqueo -> el canal
// nos lo refleja en su propio feed -> lo reimportamos como si fuera una reserva
// nueva".
//
// Deliberadamente SIN filtro por canal: un bloqueo que exportamos a un canal A y que
// un canal B nos devuelve reflejado (por ejemplo porque el propietario también
// conectó B directamente contra A, fuera de este sistema) también debe detectarse
// como eco — ambas capas comparan contra el conjunto de TODO lo exportado por
// nosotros a cualquier canal para esa unidad, el canal de origen del rebote es
// irrelevante para reconocer contenido que nosotros mismos generamos.
import { esUidNamespacePropio } from "../ical/exportador.ts";

export type CapaAntiEco = 1 | 2 | 3;

export interface ResultadoDeteccionEco {
  esEco: boolean;
  capa: CapaAntiEco | null;
  motivo: string;
}

export interface EntradaDeteccionEco {
  uidEntrante: string;
  hashContenidoEntrante: string;
  /** Hashes de bloqueos que ESTE sistema exportó recientemente a CUALQUIER canal para
   * esta unidad (capa 2) — típicamente la columna `hash_contenido` de
   * `rentas.bloqueo_exportado` filtrada solo por unidad, sin filtrar por canal. */
  hashesExportadosRecientes: readonly string[];
  /** Para cada bloqueo interno cuyo rango coincide exactamente con el evento
   * entrante, la lista de canales a los que se exportó (capa 3). Basta con que la
   * lista sea no vacía (se exportó a ALGÚN canal) para considerarlo eco — no hace
   * falta que sea el canal actual. */
  canalesExportadosDeRangoCoincidente: readonly string[];
}

export function detectarEco(entrada: EntradaDeteccionEco): ResultadoDeteccionEco {
  if (esUidNamespacePropio(entrada.uidEntrante)) {
    return { esEco: true, capa: 1, motivo: "UID entrante lleva el namespace propio de exportación" };
  }
  if (entrada.hashesExportadosRecientes.includes(entrada.hashContenidoEntrante)) {
    return { esEco: true, capa: 2, motivo: "hash de contenido coincide con un bloqueo que exportamos recientemente a algún canal" };
  }
  if (entrada.canalesExportadosDeRangoCoincidente.length > 0) {
    return { esEco: true, capa: 3, motivo: "el rango coincide exactamente con un bloqueo interno ya exportado a algún canal" };
  }
  return { esEco: false, capa: null, motivo: "no coincide con ninguna señal de eco" };
}
