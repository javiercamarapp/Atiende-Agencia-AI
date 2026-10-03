// ═══════════════════════════════════════════════════════════════════════════
// D-13 (carga masiva de CFDI) — piezas PURAS del lote: contrato del resultado por archivo, totales y la lectura barata del
// tipo de comprobante para enrutar cada XML ANTES de parsearlo. Sin base de datos, sin red y sin `node:*` (el cliente web
// también importa este paquete). La ingesta real de cada XML la hace la MISMA función que `POST .../cfdi/importar-xml`
// (apps/api .../despachos/cfdi.ts::ingestarXmlCfdiDespachos); aquí no se valida ni se interpreta ningún dato fiscal.
// ═══════════════════════════════════════════════════════════════════════════

/** Tope de XML por petición (multipart) o por ZIP: cada XML ingerido son varias consultas y la función serverless dura 30 s. */
export const MAX_ARCHIVOS_LOTE = 50;

/** Resultado por archivo. `ingerido` = CFDI nuevo sin revisión pendiente; `en_revision` = CFDI nuevo que quedó en la cola de
 * revisión humana; `duplicado` = el UUID ya existía (idempotente, no se duplica ni se sobrescribe); `rechazado` = no se guardó nada. */
export type EstadoArchivoLote = "ingerido" | "en_revision" | "duplicado" | "rechazado";

/** `cfdi` = factura/nota de crédito/traslado (despachos.invoice); `rep` = complemento de pago 2.0 (D-23). */
export type ClaseArchivoLote = "cfdi" | "rep";

export interface ResultadoArchivoLote {
  /** Nombre tal como llegó (saneado para mostrarlo: sin caracteres de control y truncado). */
  readonly archivo: string;
  readonly estado: EstadoArchivoLote;
  readonly clase: ClaseArchivoLote | null;
  /** UUID del timbre cuando se pudo leer; null si el XML no llegó a parsearse. */
  readonly folioFiscal: string | null;
  /** Obligatorio en `rechazado`, `duplicado` y `en_revision`; opcional en `ingerido` (p. ej. cuántos pagos registró un REP). */
  readonly motivo: string | null;
}

export interface TotalesLote {
  readonly recibidos: number;
  readonly ingeridos: number;
  readonly enRevision: number;
  readonly duplicados: number;
  readonly rechazados: number;
  /** Cuántos del total son complementos de pago (REP). */
  readonly reps: number;
}

export function totalesDeLote(resultados: readonly ResultadoArchivoLote[]): TotalesLote {
  let ingeridos = 0;
  let enRevision = 0;
  let duplicados = 0;
  let rechazados = 0;
  let reps = 0;
  for (const r of resultados) {
    if (r.estado === "ingerido") ingeridos += 1;
    else if (r.estado === "en_revision") enRevision += 1;
    else if (r.estado === "duplicado") duplicados += 1;
    else rechazados += 1;
    if (r.clase === "rep") reps += 1;
  }
  return { recibidos: resultados.length, ingeridos, enRevision, duplicados, rechazados, reps };
}

/** Suma de totales de varias tandas (el cliente envía el ZIP descomprimido en tandas de MAX_ARCHIVOS_LOTE). */
export function sumarTotalesLote(partes: readonly TotalesLote[]): TotalesLote {
  return partes.reduce<TotalesLote>(
    (acc, t) => ({
      recibidos: acc.recibidos + t.recibidos,
      ingeridos: acc.ingeridos + t.ingeridos,
      enRevision: acc.enRevision + t.enRevision,
      duplicados: acc.duplicados + t.duplicados,
      rechazados: acc.rechazados + t.rechazados,
      reps: acc.reps + t.reps,
    }),
    { recibidos: 0, ingeridos: 0, enRevision: 0, duplicados: 0, rechazados: 0, reps: 0 },
  );
}

/** Nombre de archivo apto para mostrar y para devolver en la respuesta: sin ruta, sin caracteres de control, truncado. */
export function nombreArchivoParaMostrar(nombre: string): string {
  // eslint-disable-next-line no-control-regex
  const limpio = nombre.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\\/g, "/").split("/").filter((p) => p !== "").pop() ?? "";
  const recortado = limpio.length > 120 ? `${limpio.slice(0, 117)}...` : limpio;
  return recortado === "" ? "(sin nombre)" : recortado;
}

const ESPACIO = /\s/;

/** Recorrido lineal (sin expresiones regulares sobre la entrada: no hay riesgo de backtracking polinomial con XML hostil). */
function leerEtiquetaRaiz(xml: string): { readonly nombre: string; readonly atributos: Map<string, string> } | null {
  let i = xml.charCodeAt(0) === 0xfeff ? 1 : 0;
  const n = xml.length;
  for (;;) {
    while (i < n && ESPACIO.test(xml[i]!)) i += 1;
    if (xml.startsWith("<?", i)) {
      const fin = xml.indexOf("?>", i + 2);
      if (fin < 0) return null;
      i = fin + 2;
    } else if (xml.startsWith("<!--", i)) {
      const fin = xml.indexOf("-->", i + 4);
      if (fin < 0) return null;
      i = fin + 3;
    } else break;
  }
  if (xml[i] !== "<") return null;
  i += 1;
  let j = i;
  while (j < n && !ESPACIO.test(xml[j]!) && xml[j] !== ">" && xml[j] !== "/") j += 1;
  const nombreCompleto = xml.slice(i, j);
  const dosPuntos = nombreCompleto.indexOf(":");
  const nombre = dosPuntos < 0 ? nombreCompleto : nombreCompleto.slice(dosPuntos + 1);
  const atributos = new Map<string, string>();
  i = j;
  while (i < n) {
    while (i < n && (ESPACIO.test(xml[i]!) || xml[i] === "/")) i += 1;
    if (i >= n || xml[i] === ">") break;
    let k = i;
    while (k < n && !ESPACIO.test(xml[k]!) && xml[k] !== "=" && xml[k] !== ">" && xml[k] !== "/") k += 1;
    const clave = xml.slice(i, k);
    i = k;
    while (i < n && ESPACIO.test(xml[i]!)) i += 1;
    if (xml[i] !== "=") {
      if (clave === "") i += 1;
      continue;
    }
    i += 1;
    while (i < n && ESPACIO.test(xml[i]!)) i += 1;
    const comilla = xml[i];
    if (comilla !== '"' && comilla !== "'") continue;
    const cierre = xml.indexOf(comilla, i + 1);
    if (cierre < 0) return null;
    if (clave !== "" && !atributos.has(clave)) atributos.set(clave, xml.slice(i + 1, cierre));
    i = cierre + 1;
  }
  return { nombre, atributos };
}

/**
 * Lee `TipoDeComprobante` del elemento raiz `Comprobante` SIN parsear el XML completo (sirve para enrutar REP/nomina antes de gastar el
 * parser). Solo mira la etiqueta de apertura de la raiz, saltando la declaracion XML y los comentarios iniciales. Devuelve null si no
 * se encuentra (el parser real dara el error con su mensaje). NO valida nada: la decision fiscal sigue en el parser.
 */
export function tipoComprobanteDeXml(xml: string): string | null {
  const raiz = leerEtiquetaRaiz(xml);
  if (!raiz || raiz.nombre !== "Comprobante") return null;
  const valor = (raiz.atributos.get("TipoDeComprobante") ?? "").trim().toUpperCase();
  return valor === "" ? null : valor;
}
