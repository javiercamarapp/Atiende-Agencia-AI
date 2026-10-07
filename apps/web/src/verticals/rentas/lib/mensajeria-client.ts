// Lógica de datos de la bandeja de aprobación de mensajería (hallazgo de auditoría
// ALTA "Mensajería con aprobación humana obligatoria: la cola de aprobación no tiene
// botón de aprobar"). Consume los endpoints ya montados y probados de
// apps/api/src/routes/verticals/rentas/mensajeria-conversaciones.ts y
// mensajeria-borradores.ts — ninguno es nuevo en esta fase, solo faltaba el cliente
// web. Mismo criterio de aislamiento que calendario-client.ts/pricing-client.ts:
// tipos redeclarados aquí (apps/web no depende de @atiende/domain-rentas), separado
// de pages/Aprobaciones.tsx para poder probarlo con vitest en entorno "node".
//
// `CanalMensajeriaCodigo`/`EstadoBorrador`/etc. son un subconjunto DELIBERADAMENTE
// más chico que packages/domain-rentas/src/mensajeria/tipos.ts: esta bandeja solo
// necesita lo que ya viaja en el JSON de ConversacionRecord/BorradorRecord, nunca las
// funciones puras de la máquina de estados (esas viven y se re-validan SIEMPRE en el
// servidor, ver mensajeria-borradores.ts).
import { fetchJson, sendJson } from "./admin-client.ts";
import { fetchUnidades } from "./calendario-client.ts";
import type { UnidadOption } from "./calendario-client.ts";

export { fetchUnidades };
export type { UnidadOption };

export const CANALES_MENSAJERIA = ["airbnb", "vrbo", "booking"] as const;
export type CanalMensajeriaCodigo = (typeof CANALES_MENSAJERIA)[number];

export const CANAL_LABELS: Record<CanalMensajeriaCodigo, string> = {
  airbnb: "Airbnb",
  vrbo: "Vrbo",
  booking: "Booking",
};

export type EstadoBorrador = "pendiente_aprobacion" | "aprobado" | "rechazado" | "enviado";

export const ESTADO_BORRADOR_LABELS: Record<EstadoBorrador, string> = {
  pendiente_aprobacion: "Pendiente de aprobación",
  aprobado: "Aprobado",
  rechazado: "Rechazado",
  enviado: "Enviado",
};

export type GeneradoPorBorrador = "motor_borrador" | "agente_llm";

/** Espejo de `SenalEscalamiento` (packages/domain-rentas/src/mensajeria/tipos.ts). */
export type SenalEscalamiento = "queja" | "emergencia" | "reembolso" | "vip";
export const SENALES_ESCALAMIENTO: readonly SenalEscalamiento[] = ["emergencia", "queja", "reembolso", "vip"];
export const SENAL_LABELS: Record<SenalEscalamiento, string> = { queja: "Queja", emergencia: "Emergencia", reembolso: "Reembolso", vip: "VIP" };

export interface ConversacionRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly unidadId: string;
  readonly canal: CanalMensajeriaCodigo;
  readonly ocupacionId: string | null;
  readonly huespedMinimoId: string | null;
  readonly propiedadNombre: string;
  readonly huespedNombre: string | null;
  readonly fechaCheckIn: string | null;
  readonly fechaCheckOut: string | null;
  readonly reservaConfirmada: boolean;
  readonly creadoEn: string;
}

export interface BorradorRecord {
  readonly id: string;
  readonly conversacionId: string;
  readonly mensajeEntranteId: string | null;
  readonly canal: CanalMensajeriaCodigo;
  readonly texto: string;
  readonly estado: EstadoBorrador;
  readonly generadoPor: GeneradoPorBorrador;
  readonly redactado: boolean;
  /** Persistido al generar (migración rentas 034). Una base sin migrar responde `false` y `[]`. */
  readonly necesitaEscalamiento: boolean;
  readonly senales: readonly SenalEscalamiento[];
  readonly aprobadoPor: string | null;
  readonly aprobadoEn: string | null;
  readonly rechazadoPor: string | null;
  readonly rechazadoEn: string | null;
  readonly motivoRechazo: string | null;
  readonly mensajeEnviadoId: string | null;
  readonly creadoEn: string;
  readonly actualizadoEn: string;
}

export async function fetchConversaciones(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  unidadId: string,
): Promise<readonly ConversacionRecord[]> {
  const body = await fetchJson<{ conversaciones: readonly ConversacionRecord[] }>(
    fetchImpl,
    `${apiBaseUrl}/rentas/${propertyId}/unidades/${unidadId}/conversaciones`,
    token,
  );
  return body.conversaciones;
}

/** Defensa ante una respuesta anterior a la migración 034 (o un API aún sin desplegar): sin los campos, "sin escalamiento". */
function normalizarBorrador(b: BorradorRecord): BorradorRecord {
  return { ...b, necesitaEscalamiento: b.necesitaEscalamiento === true, senales: Array.isArray(b.senales) ? b.senales : [] };
}

export async function fetchBorradores(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  conversacionId: string,
): Promise<readonly BorradorRecord[]> {
  const body = await fetchJson<{ borradores: readonly BorradorRecord[] }>(
    fetchImpl,
    `${apiBaseUrl}/rentas/${propertyId}/conversaciones/${conversacionId}/borradores`,
    token,
  );
  return body.borradores.map(normalizarBorrador);
}

export type DireccionMensaje = "entrante" | "saliente";
export type OrigenMensaje = "canal" | "simulador" | "manual";
export const ORIGEN_MENSAJE_LABELS: Record<OrigenMensaje, string> = { canal: "Canal", simulador: "Simulador", manual: "Registro manual" };

export interface MensajeRecord {
  readonly id: string;
  readonly conversacionId: string;
  readonly direccion: DireccionMensaje;
  readonly origen: OrigenMensaje;
  readonly texto: string;
  readonly redactado: boolean;
  readonly creadoEn: string;
}

export interface HiloRecord {
  readonly conversacion: ConversacionRecord;
  readonly mensajes: readonly MensajeRecord[];
  readonly borradores: readonly BorradorRecord[];
}

/** GET .../conversaciones/:conversacionId/hilo -- la conversación con sus mensajes (entrantes y salientes, en orden) y sus borradores.
 * 404 si la conversación no es de esta property. */
export async function fetchHilo(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, conversacionId: string): Promise<HiloRecord> {
  const hilo = await fetchJson<HiloRecord>(fetchImpl, `${apiBaseUrl}/rentas/${propertyId}/conversaciones/${conversacionId}/hilo`, token);
  return { ...hilo, borradores: hilo.borradores.map(normalizarBorrador) };
}

export interface PoliticaCanal {
  readonly canal: CanalMensajeriaCodigo;
  readonly maxCaracteres: number;
  readonly permiteContactoDirectoPreReserva: boolean;
  readonly permiteAutomatizacionPreReserva: boolean;
  readonly accionAntePreReservaProhibida: "bloquear" | "redactar";
}

/** GET .../mensajeria/politicas -- lo que cada canal permite al aprobar un mensaje (límite, contacto antes de la reserva). */
export async function fetchPoliticas(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<readonly PoliticaCanal[]> {
  const body = await fetchJson<{ politicas: readonly PoliticaCanal[] }>(fetchImpl, `${apiBaseUrl}/rentas/${propertyId}/mensajeria/politicas`, token);
  return body.politicas;
}

/** Aviso honesto de lo que el canal hace con el mensaje, derivado de su política (sin texto inventado: solo lo que la política declara). */
export function avisoPoliticaCanal(p: PoliticaCanal): string {
  const partes = [`${CANAL_LABELS[p.canal]}: límite de ${new Intl.NumberFormat("es-MX").format(p.maxCaracteres)} caracteres por mensaje.`];
  if (!p.permiteContactoDirectoPreReserva) {
    partes.push(
      p.accionAntePreReservaProhibida === "bloquear"
        ? "Antes de confirmar la reserva no se puede compartir contacto ni pago fuera de la plataforma: el mensaje se bloquea."
        : "Antes de confirmar la reserva el contacto y los datos de pago se enmascaran en el mensaje.",
    );
  }
  if (!p.permiteAutomatizacionPreReserva) partes.push("No se automatizan mensajes antes de que exista una reserva confirmada.");
  return partes.join(" ");
}

/** POST .../borradores/:id/aprobar -- ÚNICA ruta que puede terminar en un mensaje
 * saliente real (ver cabecera de mensajeria-borradores.ts). El borrador vuelve con
 * `estado: "enviado"` -- no hay un paso intermedio "aprobado" visible para el staff,
 * la transición pendiente_aprobacion -> aprobado -> enviado ocurre completa en esta
 * sola llamada. */
export async function aprobarBorrador(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, borradorId: string): Promise<BorradorRecord> {
  return sendJson(fetchImpl, `${apiBaseUrl}/rentas/${propertyId}/borradores/${borradorId}/aprobar`, token, "POST", {});
}

export async function rechazarBorrador(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, borradorId: string, motivo: string): Promise<BorradorRecord> {
  return sendJson(fetchImpl, `${apiBaseUrl}/rentas/${propertyId}/borradores/${borradorId}/rechazar`, token, "POST", { motivo });
}

/** Une, para una property completa, cada conversación con sus borradores todavía
 * `pendiente_aprobacion` — la bandeja real: sin este agregador, un operador tendría
 * que revisar unidad por unidad y conversación por conversación para encontrar algo
 * que aprobar (justo el hallazgo que esta fase cierra). El backend NUNCA expuso un
 * GET "borradores pendientes de toda la property" (`listBorradores` exige
 * `conversacionId`, ver packages/domain-rentas/src/mensajeria/repository.ts) -- se
 * arma aquí en el cliente recorriendo unidades -> conversaciones -> borradores con
 * los 3 GET ya existentes, aceptable para el volumen de una property de rentas
 * (unas pocas unidades, cada una con pocas conversaciones activas). */
export interface ItemBandeja {
  readonly unidad: UnidadOption;
  readonly conversacion: ConversacionRecord;
  readonly pendientes: readonly BorradorRecord[];
  /** El resto de los borradores de la misma conversación (aprobados/enviados/
   * rechazados) -- ya vino en la misma llamada a `fetchBorradores`, se conserva para
   * un historial de contexto sin pedirlo dos veces. */
  readonly historial: readonly BorradorRecord[];
}

export type FiltroPendientes = "todas" | "con_pendientes";

export interface FiltrosBandeja {
  readonly canal: CanalMensajeriaCodigo | "";
  readonly conPendientes: boolean;
  readonly requiereAtencion: boolean;
  readonly busqueda: string;
}

export const FILTROS_VACIOS: FiltrosBandeja = { canal: "", conPendientes: false, requiereAtencion: false, busqueda: "" };

/** El estado de los filtros vive en la URL (query string): `canal`, `pendientes=1`, `atencion=1`, `q`. Un canal desconocido se ignora. */
export function filtrosDesdeQuery(params: URLSearchParams): FiltrosBandeja {
  const canal = params.get("canal") ?? "";
  return {
    canal: (CANALES_MENSAJERIA as readonly string[]).includes(canal) ? (canal as CanalMensajeriaCodigo) : "",
    conPendientes: params.get("pendientes") === "1",
    requiereAtencion: params.get("atencion") === "1",
    busqueda: (params.get("q") ?? "").slice(0, 100),
  };
}

export function filtrosAQuery(f: FiltrosBandeja): URLSearchParams {
  const params = new URLSearchParams();
  if (f.canal) params.set("canal", f.canal);
  if (f.conPendientes) params.set("pendientes", "1");
  if (f.requiereAtencion) params.set("atencion", "1");
  if (f.busqueda.trim()) params.set("q", f.busqueda.trim());
  return params;
}

/** Una conversación "requiere atención" si tiene un borrador PENDIENTE escalado (los ya decididos no urgen). */
export function requiereAtencion(item: ItemBandeja): boolean {
  return item.pendientes.some((b) => b.necesitaEscalamiento);
}

/** Señales distintas de los borradores pendientes de una conversación, en el orden de gravedad de SENALES_ESCALAMIENTO. */
export function senalesPendientes(item: ItemBandeja): readonly SenalEscalamiento[] {
  const presentes = new Set(item.pendientes.flatMap((b) => b.senales));
  return SENALES_ESCALAMIENTO.filter((s) => presentes.has(s));
}

const sinAcentos = (t: string) => t.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

export function filtrarBandeja(items: readonly ItemBandeja[], f: FiltrosBandeja): readonly ItemBandeja[] {
  const q = sinAcentos(f.busqueda.trim());
  return items.filter((item) => {
    if (f.canal && item.conversacion.canal !== f.canal) return false;
    if (f.conPendientes && item.pendientes.length === 0) return false;
    if (f.requiereAtencion && !requiereAtencion(item)) return false;
    if (q && !sinAcentos(`${item.conversacion.huespedNombre ?? ""} ${item.unidad.nombre}`).includes(q)) return false;
    return true;
  });
}

/** Orden de la bandeja: primero lo que requiere atención humana, luego lo que tiene pendientes, luego lo más reciente. */
export function ordenarBandeja(items: readonly ItemBandeja[]): ItemBandeja[] {
  return [...items].sort((a, b) => {
    const ea = requiereAtencion(a) ? 1 : 0;
    const eb = requiereAtencion(b) ? 1 : 0;
    if (ea !== eb) return eb - ea;
    if (a.pendientes.length !== b.pendientes.length) return b.pendientes.length - a.pendientes.length;
    return b.conversacion.creadoEn.localeCompare(a.conversacion.creadoEn);
  });
}

export async function fetchBandejaAprobacion(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<readonly ItemBandeja[]> {
  const unidades = await fetchUnidades(fetchImpl, apiBaseUrl, token, propertyId);
  const items: ItemBandeja[] = [];

  for (const unidad of unidades) {
    const conversaciones = await fetchConversaciones(fetchImpl, apiBaseUrl, token, propertyId, unidad.id);
    for (const conversacion of conversaciones) {
      const borradores = await fetchBorradores(fetchImpl, apiBaseUrl, token, propertyId, conversacion.id);
      const pendientes = borradores.filter((b) => b.estado === "pendiente_aprobacion");
      const historial = borradores.filter((b) => b.estado !== "pendiente_aprobacion");
      if (pendientes.length === 0 && historial.length === 0) continue;
      items.push({ unidad, conversacion, pendientes, historial });
    }
  }

  // Es una bandeja de aprobación, no un log: lo escalado primero, luego lo que tiene pendientes.
  return ordenarBandeja(items);
}
