// Tipos del parser ICS RFC 5545 — port literal de
// rentas/packages/adapters/src/ical/tipos.ts (repo origen, H-023, REQ-027/028/029/179).
// Sin evaluación de nada ejecutable: iCalendar es texto plano por líneas, el parser
// solo tokeniza `NAME;PARAM=VALUE:VALOR` y agrupa componentes `BEGIN`/`END` — nunca
// interpreta ni ejecuta el contenido de ningún campo.

export type CodigoErrorIcs =
  | "tamano_excedido"
  | "demasiados_eventos"
  | "linea_demasiado_larga"
  | "estructura_desbalanceada"
  | "campo_requerido_ausente"
  | "valor_fecha_invalido"
  | "duration_invalida"
  | "zona_horaria_invalida";

export class IcsParseError extends Error {
  readonly codigo: CodigoErrorIcs;
  constructor(codigo: CodigoErrorIcs, mensaje: string) {
    super(mensaje);
    this.name = "IcsParseError";
    this.codigo = codigo;
  }
}

/** Valor de fecha normalizado de un VEVENT, sin resolver todavía a la fecha de
 * calendario de la propiedad (eso lo hace `resolverFechaLocal`, con la zona horaria
 * de la propiedad/unidad). */
export type ValorFechaIcs =
  | { tipo: "DATE"; fecha: string } // YYYY-MM-DD
  | { tipo: "DATE-TIME-UTC"; instanteIso: string }
  | { tipo: "DATE-TIME-TZID"; tzid: string; fechaHoraLocal: string } // YYYY-MM-DDTHH:mm:ss, sin offset
  | { tipo: "DATE-TIME-FLOTANTE"; fechaHoraLocal: string };

export type EstadoEventoIcs = "TENTATIVE" | "CONFIRMED" | "CANCELLED" | null;

export interface VEventNormalizado {
  uid: string;
  /** `null` cuando el feed no expone SEQUENCE (no confiable fuera de flujos iTIP). */
  sequence: number | null;
  /** ISO 8601 UTC — DTSTAMP es obligatorio en RFC 5545 y siempre UTC. */
  dtstamp: string;
  lastModifiedIso: string | null;
  dtstart: ValorFechaIcs;
  /** Siempre presente tras normalizar DTEND/DURATION. */
  dtend: ValorFechaIcs;
  status: EstadoEventoIcs;
  summary: string | null;
  /** Propiedades no reconocidas se toleran ("tolerancia a campos desconocidos") pero
   * no se exponen individualmente — solo su presencia queda implícita al no fallar el
   * parseo. */
}

export interface CalendarioIcsNormalizado {
  eventos: VEventNormalizado[];
}

export interface LimitesParserIcs {
  /** Tamaño máximo del cuerpo en bytes antes de intentar parsear. */
  maxBytes: number;
  /** Número máximo de VEVENT tolerados en un solo feed. */
  maxEventos: number;
  /** Longitud máxima de una línea YA des-plegada (unfolded); protege contra un
   * `SUMMARY`/`DESCRIPTION` patológicamente largo usado como vector de DoS de
   * memoria (RFC 5545 no impone límite). */
  maxLongitudLineaDesplegada: number;
}

export const LIMITES_ICS_POR_DEFECTO: LimitesParserIcs = {
  maxBytes: 2 * 1024 * 1024, // 2 MiB
  maxEventos: 5000,
  maxLongitudLineaDesplegada: 8000,
};
