// Puerto de lectura del catalogo de licitaciones: el catalogo (catalog.ts) solo habla con esto, nunca con
// SQL. Implementaciones: Postgres (postgres-reader.ts, sesion RLS del usuario) y dobles de prueba.
// El alcance es la ORGANIZACION completa (licitaciones no tiene sucursales ni clientes).

export interface LicitacionesDataChatWindow {
  readonly organizationId: string;
  /** Zona IANA del negocio (tenant_config o America/Merida). Lo fija el servidor. */
  readonly timezone: string;
  /** Instante actual: de aqui salen "hoy" y los dias restantes (en la fecha LOCAL del negocio). */
  readonly ahora: Date;
  /** Ventana [desde, hasta) (solo las consultas con periodo). */
  readonly desde: Date;
  readonly hasta: Date;
  /** Tope de filas (el catalogo pide maxRows + 1 para detectar truncamiento). */
  readonly limit: number;
}

export interface ConvocatoriaAbiertaRow {
  readonly titulo: string;
  readonly dependencia: string | null;
  readonly entidad: string | null;
  readonly status: string;
  /** "AAAA-MM-DD HH:MM" en la zona del negocio, o null sin fecha limite registrada. */
  readonly fechaLimite: string | null;
  readonly diasRestantes: number | null;
  /** Solo si la moneda es MXN; null en otra moneda (no se convierte). */
  readonly montoMxn: number | null;
  readonly moneda: string;
}
export interface SemaforoRow { readonly semaforo: string; readonly convocatorias: number }
export interface GoNoGoRow {
  readonly titulo: string;
  readonly decision: "go" | "no_go";
  readonly elegibilidad: string;
  readonly puntaje: number;
  readonly fecha: string;
  readonly motivo: string | null;
}
export interface PropuestaEstadoRow { readonly status: string; readonly propuestas: number; readonly presentadas: number }
export interface FalloRow {
  readonly titulo: string;
  readonly dependencia: string | null;
  readonly resultado: "won" | "lost";
  readonly fecha: string;
  readonly montoMxn: number | null;
}
export interface RenovacionRow {
  readonly contrato: string | null;
  readonly titulo: string;
  readonly dependencia: string | null;
  readonly finVigencia: string;
  readonly diasRestantes: number;
  readonly opcionRenovacion: boolean;
  readonly status: string;
  readonly alertaPendiente: boolean;
}

export interface PreguntaJuntaRow {
  readonly titulo: string;
  readonly pregunta: string;
  readonly tema: string;
  readonly prioridad: string;
  readonly status: string;
  /** "AAAA-MM-DD HH:MM" en la zona del negocio, o null si la convocatoria no tiene fecha limite de preguntas. */
  readonly limitePreguntas: string | null;
  readonly diasLimite: number | null;
  readonly junta: string | null;
}

/** La base todavia no tiene la tabla/columna/funcion (migracion pendiente): honesto, no un 500. */
export class DataChatUnavailableError extends Error {
  constructor(readonly what: string) {
    super(`data_chat_unavailable:${what}`);
    this.name = "DataChatUnavailableError";
  }
}

export interface LicitacionesDataChatReader {
  /** Zona horaria configurada para la organizacion; null si no hay configuracion (o la base no la tiene aun). */
  organizationTimezone(organizationId: string): Promise<string | null>;
  convocatoriasAbiertas(w: LicitacionesDataChatWindow, venceEnDias: number | null): Promise<readonly ConvocatoriaAbiertaRow[]>;
  plazosSemaforo(w: LicitacionesDataChatWindow): Promise<readonly SemaforoRow[]>;
  goNoGo(w: LicitacionesDataChatWindow): Promise<readonly GoNoGoRow[]>;
  propuestasPorEstado(w: LicitacionesDataChatWindow): Promise<readonly PropuestaEstadoRow[]>;
  fallos(w: LicitacionesDataChatWindow): Promise<readonly FalloRow[]>;
  renovaciones(w: LicitacionesDataChatWindow, horizonteDias: number): Promise<readonly RenovacionRow[]>;
  preguntasJunta(w: LicitacionesDataChatWindow): Promise<readonly PreguntaJuntaRow[]>;
}
