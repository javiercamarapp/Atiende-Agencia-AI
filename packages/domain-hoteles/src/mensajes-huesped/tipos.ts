// H-P3-03 -- mensajes automaticos al huesped de hoteles: tipos, constantes y reglas puras. Sin I/O.
// La persistencia vive en ./repository.ts (migracion 046). Los eventos se DERIVAN del estado real (hold, reserva, lista de espera):
// ver hoteles.sistema_candidatos_mensajes_huesped.

export const EVENTOS_MENSAJE_HUESPED = [
  "hold.aprobado",
  "hold.rechazado",
  "hold.confirmado",
  "hold.vencido",
  "reserva.confirmada",
  "pre_llegada",
  "post_estancia",
  "lista_espera.ofrecida",
] as const;
export type EventoMensajeHuesped = (typeof EVENTOS_MENSAJE_HUESPED)[number];

export function esEventoMensajeHuesped(valor: unknown): valor is EventoMensajeHuesped {
  return typeof valor === "string" && (EVENTOS_MENSAJE_HUESPED as readonly string[]).includes(valor);
}

export type RefTipoMensaje = "hold" | "reserva" | "lista_espera";

export const REF_TIPO_POR_EVENTO: Readonly<Record<EventoMensajeHuesped, RefTipoMensaje>> = {
  "hold.aprobado": "hold",
  "hold.rechazado": "hold",
  "hold.confirmado": "hold",
  "hold.vencido": "hold",
  "reserva.confirmada": "reserva",
  pre_llegada: "reserva",
  post_estancia: "reserva",
  "lista_espera.ofrecida": "lista_espera",
};

/**
 * Transaccional = respuesta a algo que el propio huesped hizo o espera (pidio apartar, reservo): no se retiene por la ventana de envio de
 * agent_guardrail (una aprobacion que llega de madrugada no debe esperar a la manana: la pre-reserva puede vencer antes). Los demas
 * son proactivos: respetan la ventana de envio.
 */
export const EVENTOS_TRANSACCIONALES: ReadonlySet<EventoMensajeHuesped> = new Set<EventoMensajeHuesped>(["hold.aprobado", "hold.rechazado", "hold.confirmado", "reserva.confirmada"]);
export function esEventoTransaccional(evento: EventoMensajeHuesped): boolean {
  return EVENTOS_TRANSACCIONALES.has(evento);
}

/** Activacion SIN fila de configuracion: encendidos los reactivos, apagados los proactivos de calendario hasta que gerencia los configure. */
export function activoPorOmision(evento: EventoMensajeHuesped): boolean {
  return evento !== "pre_llegada" && evento !== "post_estancia";
}

export const HORAS_ANTES_POR_OMISION = 48;
export const HORAS_ANTES_MIN = 1;
export const HORAS_ANTES_MAX = 336;
/** Hora local del dia del check-out a la que sale el agradecimiento (misma constante en la funcion SQL). */
export const HORA_POST_ESTANCIA = 12;
/** Un evento solo es elegible mientras disparo <= ahora < disparo + gracia: nunca se manda un aviso viejo. */
export const VENTANA_GRACIA_HORAS = 24;
/** Ventana de servicio de Meta (24 h) menos 1 h de margen para la demora del despachador. */
export const VENTANA_SERVICIO_SEGURA_MS = 23 * 60 * 60 * 1000;
export const MAX_MENSAJES_POR_CORRIDA = 100;

export const ESTADOS_ENVIO_MENSAJE = ["encolado", "no_enviado"] as const;
export type EstadoEnvioMensaje = (typeof ESTADOS_ENVIO_MENSAJE)[number];
export type CanalMensaje = "whatsapp" | "email";

/** Por que un mensaje NO salio. Mismos valores que el check de hoteles.mensaje_huesped_envio.motivo. */
export const MOTIVOS_NO_ENVIADO = ["sin_contacto", "baja_whatsapp", "sin_plantilla", "whatsapp_no_disponible", "correo_suprimido"] as const;
export type MotivoNoEnviado = (typeof MOTIVOS_NO_ENVIADO)[number];

export const MOTIVO_TEXTO: Readonly<Record<MotivoNoEnviado, string>> = {
  sin_contacto: "El huésped no dejó teléfono ni correo.",
  baja_whatsapp: "El teléfono pidió BAJA de los avisos por WhatsApp y no hay correo.",
  sin_plantilla: "No hay una plantilla de WhatsApp aprobada para este evento y no hay correo.",
  whatsapp_no_disponible: "WhatsApp no está disponible (canal sin configurar o sin credencial de Meta) y no hay correo.",
  correo_suprimido: "El correo está en la lista de supresión y no hay otro canal.",
};

/** Roles de vertical que ven la configuracion y el historial (hoteles.can_view_agents). */
export const MENSAJES_HUESPED_VER_ROLES = ["owner", "gm", "frontdesk", "reservations", "accountant"] as const;
/** Roles que programan los mensajes (hoteles.can_manage_agents). El catalogo de plantillas de la organizacion es owner/admin (RLS de core.whatsapp_plantilla). */
export const MENSAJES_HUESPED_CONFIG_ROLES = ["owner", "gm"] as const;

export interface ConfigEventoHuesped {
  readonly evento: EventoMensajeHuesped;
  readonly activo: boolean;
  /** Solo pre_llegada. */
  readonly horasAntes: number | null;
  /** Solo post_estancia. */
  readonly resenaUrl: string | null;
  /** `false` = no hay fila: rigen los valores por omision. */
  readonly configurada: boolean;
  readonly actualizadoEn: string | null;
}

export interface EntradaConfigEvento {
  readonly activo: boolean;
  readonly horasAntes: number | null;
  readonly resenaUrl: string | null;
}

export type ResultadoValidacionConfig = { readonly ok: true; readonly valor: EntradaConfigEvento } | { readonly ok: false; readonly error: string };

/** Valida el cuerpo de un PUT de configuracion para un evento. Nunca lanza. */
export function validarConfigEvento(evento: EventoMensajeHuesped, raw: unknown): ResultadoValidacionConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, error: "El cuerpo debe ser un objeto." };
  const r = raw as Record<string, unknown>;
  if (typeof r.activo !== "boolean") return { ok: false, error: "activo: se esperaba true o false." };
  let horasAntes: number | null = null;
  if (r.horasAntes !== undefined && r.horasAntes !== null) {
    if (evento !== "pre_llegada") return { ok: false, error: "horasAntes solo aplica al evento pre_llegada." };
    if (typeof r.horasAntes !== "number" || !Number.isInteger(r.horasAntes) || r.horasAntes < HORAS_ANTES_MIN || r.horasAntes > HORAS_ANTES_MAX) {
      return { ok: false, error: `horasAntes: entero entre ${HORAS_ANTES_MIN} y ${HORAS_ANTES_MAX}.` };
    }
    horasAntes = r.horasAntes;
  }
  let resenaUrl: string | null = null;
  if (r.resenaUrl !== undefined && r.resenaUrl !== null && r.resenaUrl !== "") {
    if (evento !== "post_estancia") return { ok: false, error: "resenaUrl solo aplica al evento post_estancia." };
    if (typeof r.resenaUrl !== "string") return { ok: false, error: "resenaUrl: se esperaba un texto." };
    const url = r.resenaUrl.trim();
    if (url.length > 500 || !/^https:\/\/[^\s]+$/u.test(url)) return { ok: false, error: "resenaUrl: debe ser un enlace https de hasta 500 caracteres." };
    try {
      new URL(url);
    } catch {
      return { ok: false, error: "resenaUrl: enlace invalido." };
    }
    resenaUrl = url;
  }
  return { ok: true, valor: { activo: r.activo, horasAntes, resenaUrl } };
}

/** Candidato que devuelve hoteles.sistema_candidatos_mensajes_huesped (una referencia con un evento por enviar). */
export interface CandidatoMensajeHuesped {
  readonly evento: EventoMensajeHuesped;
  readonly refTipo: RefTipoMensaje;
  readonly refId: string;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly propiedadNombre: string;
  readonly orgSlug: string;
  readonly zonaHoraria: string;
  readonly huespedNombre: string | null;
  readonly telefono: string | null;
  readonly correo: string | null;
  /** YYYY-MM-DD */
  readonly llegada: string;
  readonly salida: string;
  readonly totalCentavos: number | null;
  readonly venceEn: string | null;
  readonly disparoEn: string;
  readonly phoneNumberId: string | null;
  readonly whatsappHabilitado: boolean;
  readonly ultimaEntradaEn: string | null;
  /** "HH:MM[:SS]" */
  readonly ventanaInicio: string;
  readonly ventanaFin: string;
  readonly resenaUrl: string | null;
  readonly horasAntes: number | null;
}

export interface FilaHistorialMensaje {
  readonly id: string;
  readonly evento: EventoMensajeHuesped;
  readonly refTipo: RefTipoMensaje;
  readonly refId: string;
  readonly estado: EstadoEnvioMensaje;
  readonly canal: CanalMensaje | null;
  readonly motivo: MotivoNoEnviado | null;
  /** Estado real del outbox (pending, processing, sent, failed, dead); `null` si no se encolo nada. */
  readonly envio: string | null;
  readonly errorClase: string | null;
  readonly creadoEn: string;
}

/** Resultado de una operacion de staff contra una base que puede no tener aun la migracion 046. */
export type ResultadoMensajes<T> = { readonly disponible: true; readonly valor: T } | { readonly disponible: false };

export class MensajesHuespedUnavailableError extends Error {
  constructor(operacion: string) {
    super(`No disponible aun: ${operacion} requiere la migracion 046 de hoteles.`);
    this.name = "MensajesHuespedUnavailableError";
  }
}
export class MensajesHuespedAccessDeniedError extends Error {
  constructor() {
    super("Tu rol no puede configurar los mensajes automáticos al huésped.");
    this.name = "MensajesHuespedAccessDeniedError";
  }
}

export interface ResumenMensajesHuesped {
  /** `false`: la base aun no tiene la migracion 046 (la corrida no hizo nada). */
  readonly disponible: boolean;
  readonly candidatos: number;
  readonly encolados: number;
  readonly porWhatsapp: number;
  readonly porCorreo: number;
  readonly noEnviados: number;
  /** Fuera de la ventana de envio de agent_guardrail: se reintentan en la siguiente corrida (dentro de su gracia de 24 h). */
  readonly diferidos: number;
  /** Otra corrida ya les dejo marca (idempotencia) o el estado cambio entre listar y emitir. */
  readonly yaProcesados: number;
  readonly errores: number;
  readonly truncada: boolean;
}
