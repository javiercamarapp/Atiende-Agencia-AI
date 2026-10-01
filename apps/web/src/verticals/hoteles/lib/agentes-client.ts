// H-03 -- logica de datos del catalogo de agentes, guardrails, politicas, plantillas de WhatsApp y cola de
// aprobaciones humanas. Consume apps/api/src/routes/verticals/hoteles/agentes.ts. `fetchImpl` inyectado (mismo
// criterio que el resto de lib/*.ts).
import { fetchJson, sendJson } from "./admin-client.ts";

export type AgenteClave = "recepcion_whatsapp" | "revenue" | "reputacion" | "mantenimiento";
export type AgenteEstado = "activo" | "pausado" | "presupuesto_agotado";
export type AccionAprobacion = "descuento_tarifa" | "reembolso" | "respuesta_resena" | "mensaje_masivo" | "cargo_folio";
export type EstadoAprobacion = "pendiente" | "aprobada" | "rechazada" | "expirada" | "ejecutada" | "cancelada" | "bloqueada";
export type EstadoPlantilla = "borrador" | "pendiente" | "aprobada" | "rechazada" | "archivada";
export type ModoPolitica = "siempre_humano" | "auto_bajo_umbral";

export const AGENTE_CLAVES: readonly AgenteClave[] = ["recepcion_whatsapp", "revenue", "reputacion", "mantenimiento"];
export const ACCIONES: readonly AccionAprobacion[] = ["descuento_tarifa", "reembolso", "respuesta_resena", "mensaje_masivo", "cargo_folio"];

export const ACCION_LABELS: Record<AccionAprobacion, string> = {
  descuento_tarifa: "Descuento o cambio de tarifa",
  reembolso: "Reembolso",
  respuesta_resena: "Respuesta a reseña",
  mensaje_masivo: "Mensaje masivo",
  cargo_folio: "Cargo al folio",
};
export const ESTADO_APROBACION_LABELS: Record<EstadoAprobacion, string> = {
  pendiente: "Pendiente",
  aprobada: "Aprobada",
  rechazada: "Rechazada",
  expirada: "Expirada",
  ejecutada: "Ejecutada",
  cancelada: "Cancelada",
  bloqueada: "Bloqueada",
};
export const ESTADO_AGENTE_LABELS: Record<AgenteEstado, string> = { activo: "Activo", pausado: "Pausado", presupuesto_agotado: "Presupuesto agotado" };
export const ESTADO_PLANTILLA_LABELS: Record<EstadoPlantilla, string> = { borrador: "Borrador", pendiente: "En revisión", aprobada: "Aprobada", rechazada: "Rechazada", archivada: "Archivada" };
export const MOTIVO_BLOQUEO_LABELS: Record<string, string> = {
  tope_descuento: "Excede el tope de descuento",
  tope_reembolso: "Excede el tope de reembolso",
  tope_cargo_folio: "Excede el tope de cargo al folio",
  tope_destinatarios: "Excede el tope de destinatarios",
  palabra_bloqueada: "Contiene una palabra bloqueada",
  agente_pausado: "El agente está pausado",
  cola_llena: "La cola de aprobaciones está llena",
};

/** Cosmetico: el servidor es la unica barrera real (403). Espejo de AGENT_*_ROLES. */
export const AGENT_VIEW_ROLES: ReadonlySet<string> = new Set(["owner", "gm", "frontdesk", "reservations", "accountant"]);
export const AGENT_MANAGE_ROLES: ReadonlySet<string> = new Set(["owner", "gm"]);
export const AGENT_AUTHOR_ROLES: ReadonlySet<string> = new Set(["owner", "gm", "frontdesk", "reservations"]);

export interface AgenteCatalogo {
  readonly clave: AgenteClave;
  readonly nombre: string;
  readonly descripcion: string;
  readonly gobernado: boolean;
  readonly activo: boolean;
  readonly estado: AgenteEstado;
  readonly motivoPausa: string | null;
  readonly pausadoEn: string | null;
  readonly presupuestoUsd: number | null;
  readonly gastoUsd: number;
  readonly porcentajeUso: number | null;
  readonly llamadas: number;
  readonly tokensEntrada: number;
  readonly tokensSalida: number;
}
export interface CatalogoAgentes {
  readonly disponible: boolean;
  readonly mes: string;
  readonly agentes: readonly AgenteCatalogo[];
}

export interface Guardrails {
  readonly disponible: boolean;
  readonly configurados: boolean;
  readonly maxDescuentoPct: number;
  readonly maxReembolsoCentavos: number;
  readonly maxCargoFolioCentavos: number;
  readonly maxDestinatariosMasivo: number;
  readonly palabrasBloqueadas: readonly string[];
  readonly ventanaEnvioInicio: string;
  readonly ventanaEnvioFin: string;
}
export type GuardrailsInput = Omit<Guardrails, "disponible" | "configurados">;

export interface Politica {
  readonly accion: AccionAprobacion;
  readonly modo: ModoPolitica;
  readonly configurada: boolean;
  readonly umbralPorcentaje: number | null;
  readonly umbralMontoCentavos: number | null;
  readonly vigenciaMinutos: number;
  readonly aprobadores: readonly string[];
}
export interface PoliticasResultado {
  readonly disponible: boolean;
  readonly politicas: readonly Politica[];
  readonly accionesAutomatizables: readonly AccionAprobacion[];
}

export interface Plantilla {
  readonly id: string;
  readonly agente: AgenteClave;
  readonly nombre: string;
  readonly idioma: string;
  readonly categoria: string;
  readonly cuerpo: string;
  readonly version: number;
  readonly estado: EstadoPlantilla;
  readonly enviadaPor: string | null;
  readonly revisadaPor: string | null;
  readonly motivoRevision: string | null;
}
export interface PlantillasResultado {
  readonly disponible: boolean;
  readonly plantillas: readonly Plantilla[];
}

export interface Aprobacion {
  readonly id: string;
  readonly agente: AgenteClave | "manual";
  readonly accion: AccionAprobacion;
  readonly resumen: string;
  readonly detalle: Record<string, unknown>;
  readonly montoCentavos: number | null;
  readonly porcentaje: number | null;
  readonly destinatarios: number | null;
  readonly contenido: string | null;
  readonly estado: EstadoAprobacion;
  readonly propuestaPor: string | null;
  readonly propuestaPorAgente: boolean;
  readonly autoaprobada: boolean;
  readonly motivoBloqueo: string | null;
  readonly expiraEn: string;
  readonly decididaPor: string | null;
  readonly decididaEn: string | null;
  readonly motivoDecision: string | null;
  readonly ejecutadaEn: string | null;
  readonly referenciaEjecucion: string | null;
  readonly creadaEn: string;
}
export interface AprobacionesResultado {
  readonly disponible: boolean;
  readonly ahora: string;
  readonly aprobaciones: readonly Aprobacion[];
}
export interface AprobacionEvento {
  readonly id: string;
  readonly tipo: string;
  readonly actorId: string | null;
  readonly sistema: boolean;
  readonly detalle: Record<string, unknown>;
  readonly creadoEn: string;
}
export type AprobacionDetalle = Aprobacion & { readonly bitacora: readonly AprobacionEvento[]; readonly bitacoraVisible: boolean };

const agBase = (apiBaseUrl: string, propertyId: string) => `${apiBaseUrl}/hoteles/${propertyId}/agentes`;
const apBase = (apiBaseUrl: string, propertyId: string) => `${apiBaseUrl}/hoteles/${propertyId}/aprobaciones`;

export const fetchAgentes = (f: typeof fetch, api: string, token: string, p: string) => fetchJson<CatalogoAgentes>(f, agBase(api, p), token);

export const actualizarAgente = (f: typeof fetch, api: string, token: string, p: string, clave: AgenteClave, cambio: { activo?: boolean; presupuestoUsd?: number | null; motivo?: string }) =>
  sendJson<CatalogoAgentes & { agente: AgenteCatalogo }>(f, `${agBase(api, p)}/${clave}`, token, "PUT", cambio);

export const fetchGuardrails = (f: typeof fetch, api: string, token: string, p: string) => fetchJson<Guardrails>(f, `${agBase(api, p)}/guardrails`, token);
export const guardarGuardrails = (f: typeof fetch, api: string, token: string, p: string, input: GuardrailsInput) => sendJson<Guardrails>(f, `${agBase(api, p)}/guardrails`, token, "PUT", input);

export const fetchPoliticas = (f: typeof fetch, api: string, token: string, p: string) => fetchJson<PoliticasResultado>(f, `${agBase(api, p)}/politicas`, token);
export const guardarPolitica = (
  f: typeof fetch, api: string, token: string, p: string, accion: AccionAprobacion,
  input: { modo: ModoPolitica; umbralPorcentaje?: number | null; umbralMontoCentavos?: number | null; vigenciaMinutos?: number; aprobadores?: readonly string[] },
) => sendJson<Politica>(f, `${agBase(api, p)}/politicas/${accion}`, token, "PUT", input);

export const fetchPlantillas = (f: typeof fetch, api: string, token: string, p: string) => fetchJson<PlantillasResultado>(f, `${agBase(api, p)}/plantillas`, token);
export const crearPlantilla = (f: typeof fetch, api: string, token: string, p: string, input: { agente: AgenteClave; nombre: string; cuerpo: string; idioma?: string; categoria?: string }) =>
  sendJson<Plantilla>(f, `${agBase(api, p)}/plantillas`, token, "POST", input);
export const accionPlantilla = (f: typeof fetch, api: string, token: string, p: string, id: string, accion: "enviar" | "aprobar" | "rechazar" | "archivar", motivo?: string) =>
  sendJson<Plantilla>(f, `${agBase(api, p)}/plantillas/${id}/${accion}`, token, "POST", motivo ? { motivo } : {});

export function fetchAprobaciones(f: typeof fetch, api: string, token: string, p: string, filtros: { abiertas?: boolean; estado?: EstadoAprobacion } = {}) {
  const qs = new URLSearchParams();
  if (filtros.abiertas) qs.set("abiertas", "1");
  if (filtros.estado) qs.set("estado", filtros.estado);
  const q = qs.toString();
  return fetchJson<AprobacionesResultado>(f, `${apBase(api, p)}${q ? `?${q}` : ""}`, token);
}
export const fetchAprobacion = (f: typeof fetch, api: string, token: string, p: string, id: string) => fetchJson<AprobacionDetalle>(f, `${apBase(api, p)}/${id}`, token);
export const proponerAprobacion = (
  f: typeof fetch, api: string, token: string, p: string,
  input: { accion: AccionAprobacion; resumen: string; porcentaje?: number; montoCentavos?: number; destinatarios?: number; contenido?: string; llaveIdempotencia: string },
) => sendJson<Aprobacion>(f, apBase(api, p), token, "POST", input);
export const decidirAprobacion = (f: typeof fetch, api: string, token: string, p: string, id: string, accion: "aprobar" | "rechazar" | "cancelar", motivo: string) =>
  sendJson<Aprobacion>(f, `${apBase(api, p)}/${id}/${accion}`, token, "POST", { motivo });
export const ejecutarAprobacion = (f: typeof fetch, api: string, token: string, p: string, id: string, referencia?: string) =>
  sendJson<Aprobacion>(f, `${apBase(api, p)}/${id}/ejecutar`, token, "POST", referencia ? { referencia } : {});

// ---- helpers de presentacion (puros, con prueba) ----------------------------------------------------

/** Centavos MXN -> "$1,234.50". */
export function formatearCentavos(centavos: number | null | undefined): string {
  if (centavos == null) return "—";
  return (centavos / 100).toLocaleString("es-MX", { style: "currency", currency: "MXN" });
}

/** Minutos restantes (puede ser negativo) hasta `expiraEn`, o null si ya paso. */
export function minutosParaExpirar(expiraEn: string, ahora: string): number | null {
  const diff = Math.floor((new Date(expiraEn).getTime() - new Date(ahora).getTime()) / 60_000);
  return diff > 0 ? diff : null;
}

export function formatearVigencia(minutos: number | null): string {
  if (minutos === null) return "Vencida";
  if (minutos < 60) return `${minutos} min`;
  const h = Math.floor(minutos / 60);
  const m = minutos % 60;
  return h < 48 ? `${h} h${m ? ` ${m} min` : ""}` : `${Math.floor(h / 24)} d`;
}

/** Lo que la solicitud pide, legible: "10 % de descuento", "$250.00", "120 destinatarios". */
export function describirAlcance(a: Pick<Aprobacion, "accion" | "porcentaje" | "montoCentavos" | "destinatarios">): string {
  if (a.accion === "descuento_tarifa" && a.porcentaje != null) return `${a.porcentaje} % de descuento`;
  if ((a.accion === "reembolso" || a.accion === "cargo_folio") && a.montoCentavos != null) return formatearCentavos(a.montoCentavos);
  if (a.accion === "mensaje_masivo" && a.destinatarios != null) return `${a.destinatarios} destinatarios`;
  return "—";
}

/** Botones de una fila segun estado y rol (cosmetico; el servidor decide con la politica de la accion). */
export function accionesDisponibles(a: Pick<Aprobacion, "estado" | "propuestaPor">, role: string, userId: string | null): readonly ("aprobar" | "rechazar" | "cancelar" | "ejecutar")[] {
  const out: ("aprobar" | "rechazar" | "cancelar" | "ejecutar")[] = [];
  const esPropia = a.propuestaPor !== null && a.propuestaPor === userId;
  if (a.estado === "pendiente" && AGENT_VIEW_ROLES.has(role) && !esPropia) out.push("aprobar", "rechazar");
  if ((a.estado === "pendiente" || a.estado === "aprobada") && (AGENT_MANAGE_ROLES.has(role) || esPropia)) out.push("cancelar");
  if (a.estado === "aprobada" && AGENT_MANAGE_ROLES.has(role)) out.push("ejecutar");
  return out;
}

/** Llave de idempotencia nueva por intento de propuesta (un doble clic reintenta con la MISMA llave). */
export function nuevaLlave(prefijo = "manual"): string {
  const rnd = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefijo}-${rnd}`.slice(0, 120);
}
