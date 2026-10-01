import type { DataChatScope } from "@atiende/agent-core/data-chat";
import {
  DataChatUnavailableError,
  type ConvocatoriaAbiertaRow,
  type FalloRow,
  type GoNoGoRow,
  type LicitacionesDataChatReader,
  type LicitacionesDataChatWindow,
  type PreguntaJuntaRow,
  type PropuestaEstadoRow,
  type RenovacionRow,
  type SemaforoRow,
} from "../../src/data-chat/index.ts";

export const ORG_A = "00000000-0000-0000-0000-0000000000a1";

/** 29-sep-2026 23:30 en Mérida = 30-sep 05:30 UTC (en UTC ya es "mañana"). */
export const NOW = new Date("2026-09-30T05:30:00.000Z");

export const OWNER_SCOPE: DataChatScope = {
  organizationId: ORG_A,
  userId: "user-owner",
  vertical: "licitaciones",
  verticalRole: "owner",
  allowedPropertyIds: null,
  timezone: "America/Merida",
};

export interface Call {
  readonly method: string;
  readonly window?: LicitacionesDataChatWindow;
  readonly extra?: unknown;
}

export class FakeReader implements LicitacionesDataChatReader {
  readonly calls: Call[] = [];
  timezone: string | null = null;
  abiertas: readonly ConvocatoriaAbiertaRow[] = [
    { titulo: "Suministro de uniformes escolares", dependencia: "SEP Yucatán", entidad: "Yucatán", status: "in_progress", fechaLimite: "2026-10-01 10:00", diasRestantes: 2, montoMxn: 1250000.5, moneda: "MXN" },
    { titulo: "Servicio de limpieza hospitalaria", dependencia: "IMSS-Bienestar", entidad: null, status: "in_review", fechaLimite: "2026-10-20 14:00", diasRestantes: 21, montoMxn: 480000, moneda: "MXN" },
    { titulo: "Equipo de cómputo (USD)", dependencia: null, entidad: null, status: "discovered", fechaLimite: null, diasRestantes: null, montoMxn: null, moneda: "USD" },
  ];
  semaforo: readonly SemaforoRow[] = [
    { semaforo: "Vencida sin presentar", convocatorias: 1 },
    { semaforo: "Rojo (3 días o menos)", convocatorias: 2 },
    { semaforo: "Verde (más de 7 días)", convocatorias: 5 },
  ];
  gonogo: readonly GoNoGoRow[] = [
    { titulo: "Suministro de uniformes escolares", decision: "go", elegibilidad: "cumple", puntaje: 87.5, fecha: "2026-09-20", motivo: "Experiencia comprobable" },
    { titulo: "Obra de bacheo", decision: "no_go", elegibilidad: "no_cumple", puntaje: 31, fecha: "2026-09-18", motivo: null },
  ];
  propuestas: readonly PropuestaEstadoRow[] = [
    { status: "submitted", propuestas: 4, presentadas: 4 },
    { status: "in_progress", propuestas: 3, presentadas: 0 },
    { status: "won", propuestas: 2, presentadas: 2 },
  ];
  fallosRows: readonly FalloRow[] = [
    { titulo: "Servicio de limpieza hospitalaria", dependencia: "IMSS-Bienestar", resultado: "won", fecha: "2026-09-10", montoMxn: 900000 },
    { titulo: "Papelería institucional", dependencia: "SEDUMA", resultado: "lost", fecha: "2026-09-02", montoMxn: null },
  ];
  renov: readonly RenovacionRow[] = [
    { contrato: "IMSS-2025-044", titulo: "Servicio de limpieza hospitalaria", dependencia: "IMSS-Bienestar", finVigencia: "2026-11-15", diasRestantes: 47, opcionRenovacion: true, status: "en_ejecucion", alertaPendiente: true },
    { contrato: null, titulo: "Mantenimiento de aires", dependencia: null, finVigencia: "2026-12-01", diasRestantes: 63, opcionRenovacion: false, status: "adjudicado", alertaPendiente: false },
  ];
  junta: readonly PreguntaJuntaRow[] = [
    { titulo: "Suministro de uniformes escolares", pregunta: "¿Se aceptan tallas intermedias en la partida 3?", tema: "tecnico", prioridad: "alta", status: "aprobada", limitePreguntas: "2026-10-02 15:00", diasLimite: 3, junta: "2026-10-05 11:00" },
    { titulo: "Servicio de limpieza hospitalaria", pregunta: "¿El anexo 4 sustituye al formato de la convocatoria?", tema: "administrativo", prioridad: "media", status: "borrador", limitePreguntas: null, diasLimite: null, junta: null },
    { titulo: "Servicio de limpieza hospitalaria", pregunta: "¿Cómo se acredita la experiencia en el apartado legal?", tema: "legal", prioridad: "baja", status: "enviada", limitePreguntas: "2026-10-12 12:00", diasLimite: 13, junta: "2026-10-14 10:00" },
  ];
  failWith: Error | null = null;

  private enter(method: string, window?: LicitacionesDataChatWindow, extra?: unknown): void {
    this.calls.push({ method, window, extra });
    if (this.failWith && method !== "organizationTimezone") throw this.failWith;
  }

  async organizationTimezone(organizationId: string): Promise<string | null> {
    this.enter("organizationTimezone", undefined, { organizationId });
    return this.timezone;
  }
  async convocatoriasAbiertas(w: LicitacionesDataChatWindow, venceEnDias: number | null) {
    this.enter("convocatoriasAbiertas", w, venceEnDias);
    return this.abiertas;
  }
  async plazosSemaforo(w: LicitacionesDataChatWindow) {
    this.enter("plazosSemaforo", w);
    return this.semaforo;
  }
  async goNoGo(w: LicitacionesDataChatWindow) {
    this.enter("goNoGo", w);
    return this.gonogo;
  }
  async propuestasPorEstado(w: LicitacionesDataChatWindow) {
    this.enter("propuestasPorEstado", w);
    return this.propuestas;
  }
  async fallos(w: LicitacionesDataChatWindow) {
    this.enter("fallos", w);
    return this.fallosRows;
  }
  async preguntasJunta(w: LicitacionesDataChatWindow) {
    this.enter("preguntasJunta", w);
    return this.junta;
  }
  async renovaciones(w: LicitacionesDataChatWindow, horizonteDias: number) {
    this.enter("renovaciones", w, horizonteDias);
    return this.renov;
  }
}

export const unavailable = (): DataChatUnavailableError => new DataChatUnavailableError("convocatorias");
