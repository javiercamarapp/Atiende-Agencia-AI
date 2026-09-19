// Fase 9 licitaciones — mapeo PURO de una fila del CSV real de
// "Convocatorias de Licitaciones Públicas y anuncios de Invitaciones
// Restringidas" (CDMX, dataset `concursos-compras-publicas`) a
// `TenderSourceIngestCandidate`. NO usa el parser OCDS genérico
// (`../map-ocds-release.ts`) -- ver el comentario de cabecera de
// `cdmx-ocds-connector.ts` para la desviación deliberada respecto de la
// premisa inicial ("CDMX ofrece descargas OCDS"): verificado con peticiones
// reales que el portal OCDS-branded de Tianguis Digital no expone un
// endpoint automatizable de forma respetuosa; este CSV (mismo dato,
// publicado por el propio Gobierno de la Ciudad de México en su portal de
// datos abiertos, CKAN) es el contrato real accesible.
import { dateOnlyToMexicoCityIso } from "../../dates.ts";
import type { TenderSourceIngestCandidate } from "../types.ts";

/** Encabezado REAL del CSV, capturado con una petición GET real el 2026-09-19 (ver evidencia en `cdmx-ocds-connector.ts`). Documentado para que un cambio de columnas real se note en el diff de este archivo. */
export const CDMX_CSV_HEADER =
  "post_title,post_date,no_procedimiento,unidad_responsable,id_convocante,entidad_convocante,id,tipo_contratacion,metodo_contratacion,caracter_convocatoria,clasificador_bien_servicio,servidor_nombre,servidor_cargo,lugar_venta,domicilio_venta,primer_entrega,primer_entrega_fin,segunda_entrega,segunda_entrega_fin,tercera_entrega,tercera_entrega_fin,cuarta_entrega,cuarta_entrega_fin,quinta_entrega,quinta_entrega_fin,costo,forma_pago,datos_pago,documento_bases_url,documento_tecnico_url,contratacion_descripcion,unidad_medida,idioma,considera_anticipo,lugar_entrega,fecha_estimada_inicio,fecha_estimada_fin,concurso_lugar,concurso_direccion,concurso_fecha,propuestas_lugar,propuestas_direccion,propuestas_fecha,fallo_lugar,fallo_direccion,fallo_fecha,dias_trans_prop";

const GENERIC_CLASSIFIER_VALUES = new Set(["", "no especificado", "n/a", "na", "ninguno"]);

function firstNonEmpty(...values: (string | undefined)[]): string | undefined {
  for (const value of values) {
    if (value !== undefined && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

/** `propuestas_fecha` viene como `YYYY-MM-DD` (fecha sin hora, sin zona) -- se ancla a America/Mexico_City fin de día (`edge: "end"`, mismo util que `dates.ts` ya usa para `valid_until` -- ver ese archivo para la justificación del offset fijo `-06:00`, México sin horario de verano desde 2022) porque es el LÍMITE para presentar propuestas (equivalente honesto de `tenderPeriod.endDate`), no un inicio de vigencia. Formatos evidentemente inválidos (p. ej. `0000-00-00 00:00:00`, observado en filas reales de "entregas" no usadas) devuelven `null` en vez de fabricar una fecha. */
export function parsePropuestasFechaToDeadline(raw: string | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith("0000-00-00")) return null;
  const match = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  try {
    return dateOnlyToMexicoCityIso(match[0]!, "end");
  } catch {
    return null;
  }
}

function parseClassifier(raw: string | undefined): string[] {
  const trimmed = raw?.trim();
  if (!trimmed) return [];
  if (GENERIC_CLASSIFIER_VALUES.has(trimmed.toLowerCase())) return [];
  return [trimmed];
}

/**
 * Mapea una fila ya alineada del CSV real, o `null` si faltan los campos
 * mínimos obligatorios (identificador y título) -- el llamador reporta el
 * `null` vía `reportDropped` (mismo patrón que
 * `compras-mx-historico.ts::mapComprasMxHistoricoRow`).
 *
 * `budgetAmount` SIEMPRE `null`: el CSV no trae una columna de monto/importe
 * del contrato -- `costo` es el precio de venta de LAS BASES/pliego (ver
 * `forma_pago`/`datos_pago`), un concepto distinto del valor de la
 * contratación. Mapearlo como `budgetAmount` sería inventarle un significado
 * que la fuente no declara (mismo criterio que `compras-mx-historico.ts`
 * nunca reinterpreta `fecha_fin` como plazo de propuestas).
 */
export function mapCdmxCsvRow(row: Record<string, string>, options: { fixedState: string }): TenderSourceIngestCandidate | null {
  const externalId = firstNonEmpty(row.no_procedimiento, row.id);
  const title = firstNonEmpty(row.post_title, row.contratacion_descripcion);
  if (!externalId || !title) return null;

  return {
    externalId,
    title,
    submissionDeadline: parsePropuestasFechaToDeadline(row.propuestas_fecha),
    contractingBody: firstNonEmpty(row.entidad_convocante, row.unidad_responsable) ?? null,
    cpvCodes: parseClassifier(row.clasificador_bien_servicio),
    budgetAmount: null,
    currency: "MXN",
    state: options.fixedState,
    procedureTypeRaw: firstNonEmpty(row.metodo_contratacion, row.tipo_contratacion) ?? null,
  };
}

export function rowRejectionReason(row: Record<string, string>): string {
  const externalId = firstNonEmpty(row.no_procedimiento, row.id);
  if (!externalId) return "Fila sin identificador (no_procedimiento/id ausentes o vacíos).";
  return "Fila sin título (post_title/contratacion_descripcion ausente/vacío).";
}
