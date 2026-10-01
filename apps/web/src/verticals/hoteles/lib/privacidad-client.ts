// Lógica de datos de privacidad de hoteles (H-02) — consume
// apps/api/src/routes/verticals/hoteles/privacidad.ts: aviso de privacidad versionado, ledger de
// consentimientos, solicitudes ARCO con plazos, incidentes/vulneraciones, retención legal y
// acceso excepcional a identidades bloqueadas.
//
// AVISO: herramienta de registro y control; NO es asesoría legal. El texto y la lista de "un
// abogado debe confirmar" vienen del servidor (`fetchPrivacidadInfo`).
import { fetchJson, sendJson } from "./admin-client.ts";
import type { DocumentoRevelado, IdentidadSummary } from "./identidad-client.ts";

export type ArcoDerecho = "acceso" | "rectificacion" | "cancelacion" | "oposicion";
export type ArcoEstado = "recibida" | "en_revision" | "procedente" | "improcedente" | "ejecutada";
export type ArcoCanal = "mostrador" | "correo" | "whatsapp" | "web" | "telefono" | "otro";
export type PlazoEstado = "en_plazo" | "por_vencer" | "vencida" | "cerrada";
export type IncidenteTipo = "acceso_no_autorizado" | "perdida_robo" | "alteracion" | "divulgacion" | "otro";
export type IncidenteSeveridad = "baja" | "media" | "alta";
export type IncidenteEstado = "detectada" | "contenida" | "cerrada";
export type AccesoEstado = "pendiente" | "aprobada" | "rechazada" | "usada";

export const ARCO_DERECHO_LABELS: Record<ArcoDerecho, string> = { acceso: "Acceso", rectificacion: "Rectificación", cancelacion: "Cancelación", oposicion: "Oposición" };
export const ARCO_ESTADO_LABELS: Record<ArcoEstado, string> = { recibida: "Recibida", en_revision: "En revisión", procedente: "Procedente", improcedente: "Improcedente", ejecutada: "Ejecutada" };
export const ARCO_CANAL_LABELS: Record<ArcoCanal, string> = { mostrador: "Mostrador", correo: "Correo", whatsapp: "WhatsApp", web: "Web", telefono: "Teléfono", otro: "Otro" };
export const PLAZO_ESTADO_LABELS: Record<PlazoEstado, string> = { en_plazo: "En plazo", por_vencer: "Por vencer", vencida: "Vencida", cerrada: "Cerrada" };
export const INCIDENTE_TIPO_LABELS: Record<IncidenteTipo, string> = {
  acceso_no_autorizado: "Acceso no autorizado", perdida_robo: "Pérdida o robo", alteracion: "Alteración", divulgacion: "Divulgación", otro: "Otro",
};
export const INCIDENTE_ESTADO_LABELS: Record<IncidenteEstado, string> = { detectada: "Detectada", contenida: "Contenida", cerrada: "Cerrada" };
export const CONSENT_CANALES: readonly string[] = ["mostrador", "tableta", "qr", "whatsapp", "web", "telefono", "otro"];
export const CONSENT_METODO_LABELS: Record<string, string> = {
  aviso_simplificado_mostrado: "Aviso simplificado mostrado",
  casilla_electronica: "Casilla electrónica",
  firma_electronica: "Firma electrónica",
  firma_autografa: "Firma autógrafa",
  mecanismo_autenticacion: "Mecanismo de autenticación",
};
/** Métodos que cuentan como consentimiento expreso y por escrito (datos sensibles). Espeja CONSENT_WRITTEN_METHODS del dominio. */
export const CONSENT_METODOS_ESCRITOS: ReadonlySet<string> = new Set(["firma_electronica", "firma_autografa", "mecanismo_autenticacion"]);

export interface Lista<T> {
  /** `false` = la migración 032 aún no está aplicada en esta base (estado "no disponible aún"). */
  readonly disponible: boolean;
  readonly items: readonly T[];
}

export interface PrivacidadInfo {
  readonly avisoLegal: string;
  readonly unAbogadoDebeConfirmar: readonly string[];
  readonly plazos: {
    readonly arcoRespuestaDias: number;
    readonly arcoEjecucionDias: number;
    readonly diasNaturales: boolean;
    readonly prorrogaUnicaPorIgualPlazo: boolean;
    readonly ventanaBloqueoDias: { readonly minimo: number; readonly maximo: number; readonly porDefecto: number };
  };
}

export interface AvisoSummary {
  readonly id: string;
  readonly version: string;
  readonly textoSimplificado: string;
  readonly urlIntegral: string | null;
  readonly finalidadesObligatorias: readonly string[];
  readonly finalidadesOpcionales: readonly string[];
  readonly vigente: boolean;
  readonly publicadoEn: string;
}

export interface ConsentimientoSummary {
  readonly id: string;
  readonly huespedId: string;
  readonly identidadId: string | null;
  readonly versionAviso: string;
  readonly finalidadesObligatorias: readonly string[];
  readonly finalidadesOpcionales: readonly string[];
  readonly canal: string;
  readonly metodo: string;
  readonly datosSensibles: boolean;
  readonly consentidoEn: string;
  readonly capturadoPor: string | null;
  readonly revocadoEn: string | null;
  readonly motivoRevocacion: string | null;
}

export interface ConfiguracionPrivacidad {
  readonly disponible: boolean;
  readonly ventanaBloqueoDias: number;
  readonly esDefault: boolean;
  readonly actualizadoPor: string | null;
  readonly actualizadoEn: string | null;
}

export interface ArcoSummary {
  readonly id: string;
  readonly folio: string;
  readonly derecho: ArcoDerecho;
  readonly huespedId: string | null;
  readonly identidadId: string | null;
  readonly solicitante: string;
  readonly contacto: string | null;
  readonly canal: ArcoCanal;
  readonly descripcion: string | null;
  readonly recibidaEn: string;
  readonly respuestaLimite: string;
  readonly ejecucionLimite: string | null;
  readonly estado: ArcoEstado;
  readonly notaDecision: string | null;
  readonly prorroga: { readonly fase: "respuesta" | "ejecucion"; readonly motivo: string | null } | null;
  readonly plazo: { readonly fase: "respuesta" | "ejecucion" | null; readonly vence: string | null; readonly diasRestantes: number | null; readonly estado: PlazoEstado };
  readonly prorrogaDisponible: { readonly disponible: boolean; readonly dias: number };
}

export interface IncidenteSummary {
  readonly id: string;
  readonly folio: string;
  readonly tipo: IncidenteTipo;
  readonly severidad: IncidenteSeveridad;
  readonly titulo: string;
  readonly descripcion: string;
  readonly detectadoEn: string;
  readonly afectados: number | null;
  readonly riesgoSignificativo: boolean;
  readonly estado: IncidenteEstado;
  readonly notificacion: { readonly en: string; readonly canal: string | null; readonly constancia: string | null } | null;
  readonly motivoNoNotificar: string | null;
  readonly recordatorio: { readonly requerido: boolean; readonly vencido: boolean; readonly horasDesdeDeteccion: number; readonly mensaje: string | null };
}

export interface RetencionSummary {
  readonly id: string;
  readonly identidadId: string;
  readonly incidenteId: string | null;
  readonly folio: string;
  readonly motivo: string;
  readonly autorizacion: string;
  readonly estado: "activa" | "liberada";
  readonly revisarAntesDe: string;
  readonly revision: "vigente" | "revision_proxima" | "revision_vencida" | "liberada";
}

export interface AccesoSummary {
  readonly id: string;
  readonly identidadId: string;
  readonly solicitadaPor: string;
  readonly motivo: string;
  readonly estado: AccesoEstado;
  readonly caducaEn: string | null;
}

export interface EventoSummary {
  readonly id: string;
  readonly tipo: string;
  readonly accion: string;
  readonly nota: string | null;
  readonly actorId: string | null;
  readonly creadaEn: string;
}

const base = (apiBaseUrl: string, propertyId: string) => `${apiBaseUrl}/hoteles/${propertyId}/privacidad`;
const get = <T>(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, path: string) => fetchJson<T>(fetchImpl, `${base(apiBaseUrl, propertyId)}/${path}`, token);
const post = <T>(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, path: string, body: unknown) =>
  sendJson<T>(fetchImpl, `${base(apiBaseUrl, propertyId)}/${path}`, token, "POST", body);

export const fetchPrivacidadInfo = (f: typeof fetch, a: string, t: string, p: string) => get<PrivacidadInfo>(f, a, t, p, "info");
export const fetchConfiguracion = (f: typeof fetch, a: string, t: string, p: string) => get<ConfiguracionPrivacidad>(f, a, t, p, "configuracion");
export const saveVentanaBloqueo = (f: typeof fetch, a: string, t: string, p: string, dias: number) => sendJson<{ ventanaBloqueoDias: number }>(f, `${base(a, p)}/configuracion`, t, "PUT", { dias });

export const fetchAvisos = (f: typeof fetch, a: string, t: string, p: string) => get<Lista<AvisoSummary>>(f, a, t, p, "avisos");
export interface NuevoAvisoInput {
  readonly version: string;
  readonly textoSimplificado: string;
  readonly finalidadesObligatorias: readonly string[];
  readonly finalidadesOpcionales: readonly string[];
  readonly urlIntegral?: string;
}
export const publishAviso = (f: typeof fetch, a: string, t: string, p: string, input: NuevoAvisoInput) => post<{ avisoId: string }>(f, a, t, p, "avisos", input);

export const fetchConsentimientos = (f: typeof fetch, a: string, t: string, p: string) => get<Lista<ConsentimientoSummary>>(f, a, t, p, "consentimientos");
export const revokeConsentimiento = (f: typeof fetch, a: string, t: string, p: string, id: string, motivo: string) => post<{ resultado: string }>(f, a, t, p, `consentimientos/${id}/revocar`, { motivo });

export const fetchArco = (f: typeof fetch, a: string, t: string, p: string) => get<Lista<ArcoSummary> & { hoy: string }>(f, a, t, p, "arco");
export interface NuevoArcoInput {
  readonly derecho: ArcoDerecho;
  readonly solicitante: string;
  readonly canal: ArcoCanal;
  readonly contacto?: string;
  readonly descripcion?: string;
  readonly huespedId?: string;
  readonly identidadId?: string;
}
export const openArco = (f: typeof fetch, a: string, t: string, p: string, input: NuevoArcoInput) => post<{ solicitudId: string; solicitud: ArcoSummary | null }>(f, a, t, p, "arco", input);
export const advanceArco = (f: typeof fetch, a: string, t: string, p: string, id: string, estado: Exclude<ArcoEstado, "recibida">, nota: string) =>
  post<{ resultado: string; solicitud: ArcoSummary | null }>(f, a, t, p, `arco/${id}/avanzar`, { estado, nota });
export const extendArco = (f: typeof fetch, a: string, t: string, p: string, id: string, motivo: string) => post<{ solicitud: ArcoSummary | null }>(f, a, t, p, `arco/${id}/prorroga`, { motivo });

export const fetchIncidentes = (f: typeof fetch, a: string, t: string, p: string) => get<Lista<IncidenteSummary>>(f, a, t, p, "incidentes");
export interface NuevoIncidenteInput {
  readonly tipo: IncidenteTipo;
  readonly severidad: IncidenteSeveridad;
  readonly titulo: string;
  readonly descripcion: string;
  readonly riesgoSignificativo: boolean;
  readonly afectados?: number;
}
export const reportIncidente = (f: typeof fetch, a: string, t: string, p: string, input: NuevoIncidenteInput) => post<{ incidenteId: string }>(f, a, t, p, "incidentes", input);
export type IncidenteAccion =
  | { readonly accion: "contener"; readonly nota?: string }
  | { readonly accion: "registrar_notificacion"; readonly canal: string; readonly constancia: string }
  | { readonly accion: "cerrar"; readonly nota: string; readonly motivoNoNotificar?: string };
export const actIncidente = (f: typeof fetch, a: string, t: string, p: string, id: string, accion: IncidenteAccion) => post<{ incidente: IncidenteSummary | null }>(f, a, t, p, `incidentes/${id}/accion`, accion);

export const fetchRetenciones = (f: typeof fetch, a: string, t: string, p: string) => get<Lista<RetencionSummary>>(f, a, t, p, "retenciones");
export const placeRetencion = (f: typeof fetch, a: string, t: string, p: string, identidadId: string, input: { folio: string; motivo: string; autorizacion: string; incidenteId?: string }) =>
  post<{ retencionId: string }>(f, a, t, p, `identidades/${identidadId}/retencion`, input);
export const releaseRetencion = (f: typeof fetch, a: string, t: string, p: string, id: string, nota: string) => post<{ retencion: RetencionSummary | null }>(f, a, t, p, `retenciones/${id}/liberar`, { nota });

export const blockIdentidad = async (f: typeof fetch, a: string, t: string, p: string, identidadId: string, motivo: string): Promise<IdentidadSummary | null> =>
  (await post<{ identidad: IdentidadSummary | null }>(f, a, t, p, `identidades/${identidadId}/bloquear`, { motivo })).identidad;

export const requestAccesoExcepcional = (f: typeof fetch, a: string, t: string, p: string, identidadId: string, motivo: string) =>
  post<{ solicitudId: string }>(f, a, t, p, `identidades/${identidadId}/acceso-excepcional`, { motivo });
export const fetchAccesos = (f: typeof fetch, a: string, t: string, p: string) => get<Lista<AccesoSummary>>(f, a, t, p, "accesos-excepcionales");
export const decideAcceso = async (f: typeof fetch, a: string, t: string, p: string, id: string, aprobar: boolean, nota?: string) =>
  (await post<{ resultado: "aprobada" | "rechazada" }>(f, a, t, p, `accesos-excepcionales/${id}/decidir`, { aprobar, nota })).resultado;
export const revealAccesoExcepcional = async (f: typeof fetch, a: string, t: string, p: string, id: string): Promise<DocumentoRevelado> =>
  (await post<{ documento: DocumentoRevelado }>(f, a, t, p, `accesos-excepcionales/${id}/revelar`, {})).documento;

export const fetchBitacora = (f: typeof fetch, a: string, t: string, p: string) => get<Lista<EventoSummary>>(f, a, t, p, "bitacora?limit=50");

/** Etiqueta legible de las horas transcurridas desde la detección de un incidente. */
export function etiquetaHoras(horas: number): string {
  if (horas < 1) return "menos de 1 h";
  if (horas < 48) return `${horas} h`;
  return `${Math.floor(horas / 24)} días`;
}

/** Texto del plazo ARCO para la lista ("Responder antes del 2026-03-21 (quedan 5 d)" / "vencida hace 2 d"). */
export function textoPlazo(p: ArcoSummary["plazo"]): string {
  if (p.estado === "cerrada" || p.vence === null || p.diasRestantes === null) return "Plazo cerrado";
  const fase = p.fase === "ejecucion" ? "Ejecutar" : "Responder";
  return p.diasRestantes < 0 ? `${fase} antes del ${p.vence}: vencida hace ${-p.diasRestantes} d` : `${fase} antes del ${p.vence} (quedan ${p.diasRestantes} d)`;
}
