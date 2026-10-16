// Tipos y contrato del repositorio del autopiloto (migracion 050). Todo dato "no disponible aun" (base sin migrar) se expresa con
// `disponible: false`: el llamador cae al comportamiento anterior o muestra un estado honesto, nunca un 500.
import type { CanalPedido, OrderStatus } from "../types.ts";

export interface Lectura<T> {
  readonly disponible: boolean;
  readonly valor: T;
}

export interface AutopilotoConfig {
  /** Cancelacion automatica antes de cocina (decide PM; por omision NO). */
  readonly cancelacionAuto: boolean;
  /** Sin POS: pending -> preparando en cuanto la comanda se imprime o se captura (por omision NO). */
  readonly aceptacionAuto: boolean;
  readonly aprobacionMinutos: number;
  readonly handoffRegresoMinutos: number;
  readonly noRecogidoMinutos: number;
  readonly completadoHoras: number;
  /** Tope (porcentaje) del descuento de una compensacion. */
  readonly compensacionTopePct: number;
  readonly saturacionUmbral1: number | null;
  readonly saturacionUmbral2: number | null;
  readonly saturacionExtraMinutos: number;
  /** `false` = sin fila: son los valores por omision seguros. */
  readonly configurada: boolean;
}

export const AUTOPILOTO_CONFIG_POR_OMISION: AutopilotoConfig = {
  cancelacionAuto: false,
  aceptacionAuto: false,
  aprobacionMinutos: 10,
  handoffRegresoMinutos: 15,
  noRecogidoMinutos: 60,
  completadoHoras: 6,
  compensacionTopePct: 20,
  saturacionUmbral1: null,
  saturacionUmbral2: null,
  saturacionExtraMinutos: 15,
  configurada: false,
};

export type SolicitudTipo = "pedido_grande" | "cancelacion" | "compensacion" | "pausa_sucursal";
export type SolicitudDecision = "aprobar" | "rechazar" | "cancelar" | "mantener" | "sin_compensacion" | "reponer_producto" | "descuento_proximo" | "pausar" | "descartar";

export const DECISIONES_POR_TIPO: Readonly<Record<SolicitudTipo, readonly SolicitudDecision[]>> = {
  pedido_grande: ["aprobar", "rechazar"],
  cancelacion: ["cancelar", "mantener"],
  compensacion: ["sin_compensacion", "reponer_producto", "descuento_proximo"],
  pausa_sucursal: ["pausar", "descartar"],
};

export interface SolicitudVista {
  readonly id: string;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly tipo: SolicitudTipo;
  readonly estado: "pendiente" | "resuelta";
  readonly orderId: string | null;
  /** Solo codigos y cifras (total, peso, subtipo); sin PII. */
  readonly detalle: Readonly<Record<string, unknown>>;
  readonly decision: SolicitudDecision | null;
  readonly motivoResolucion: string | null;
  readonly codigoDescuento: string | null;
  readonly solicitadaAt: string;
  readonly escaladaAt: string | null;
  readonly resueltaAt: string | null;
  /** Datos del pedido para decidir con un clic (el staff ya los ve en Pedidos). */
  readonly pedido: {
    readonly numero: number | null;
    readonly total: number;
    readonly status: OrderStatus;
    readonly clienteNombre: string;
    readonly canal: CanalPedido | null;
    readonly renglones: readonly { readonly indice: number; readonly nombre: string; readonly cantidad: number }[];
  } | null;
}

export interface FiltroSolicitudes {
  readonly propertyIds: readonly string[] | null;
  readonly estado: "pendiente" | "resuelta";
  readonly limite: number;
}

export interface ResultadoRetener {
  readonly estado: "creada" | "existente" | "no_disponible";
  readonly solicitudId: string | null;
  readonly propertyId: string | null;
}

/**
 * Lo que `crear_pedido` (WhatsApp y voz) necesita del autopiloto para dejar un pedido grande en `por_aprobar` en vez de mandarlo a cocina.
 * `disponible` se consulta ANTES de crear el pedido (base sin la migracion 050 = `false`: el agente sigue por el aviso de siempre); `retener` corre
 * DESPUES de crearlo, en la misma transaccion, y si falla se revierte tambien el pedido.
 */
export interface PedidoGrandeHook {
  disponible(organizationId: string, propertyId: string): Promise<boolean>;
  retener(input: { readonly organizationId: string; readonly orderId: string; readonly detalle: Readonly<Record<string, unknown>> }): Promise<{ readonly estado: "por_aprobar"; readonly solicitudId: string } | { readonly estado: "no_disponible" }>;
}

export interface ResultadoCrearSolicitud {
  readonly estado: "creada" | "existente" | "no_disponible";
  readonly solicitudId: string | null;
}

export interface OpcionesResolver {
  readonly motivo?: string | null;
  /** Porcentaje del descuento ("descuento_proximo"). */
  readonly valor?: number | null;
  /** Indices (base 0) de los renglones del pedido a reponer ("reponer_producto"). */
  readonly indices?: readonly number[] | null;
}

export interface ResultadoResolver {
  /** `false` = ya estaba resuelta (doble clic o carrera): no se repiten los efectos. */
  readonly aplicado: boolean;
  readonly tipo: SolicitudTipo;
  readonly decision: SolicitudDecision | null;
  readonly orderId: string | null;
  readonly propertyId: string;
  readonly estadoPedido: OrderStatus | null;
  readonly codigoDescuento: string | null;
  readonly reposicionOrderId: string | null;
  /** Por que se cerro asi (codigo de lista cerrada, `no_cancelable_<estado>` o `pedido_ya_no_estaba_por_aprobar`). `null`/ausente = sin motivo o base con la 050 original (sin la 073). */
  readonly motivo?: string | null;
}

export interface SolicitudPorEscalar {
  readonly id: string;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly tipo: SolicitudTipo;
  readonly orderId: string | null;
  readonly minutos: number;
}

export interface CandidatoEstado {
  readonly orderId: string;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly desde: OrderStatus;
  readonly hacia: OrderStatus;
  readonly motivo: string;
}

export interface ComandaParaAvance {
  readonly orderId: string;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly folio: string;
  readonly status: OrderStatus;
  readonly canal: CanalPedido | null;
}

export interface HandoffDevuelto {
  readonly handoffId: string;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly conversationId: string;
  readonly minutos: number;
  /** `true` si salio la frase fija al cliente (solo dentro de la ventana de 24 h). */
  readonly avisado: boolean;
}

/** Toma de conversacion PENDIENTE (nadie la tomo) que ya paso el umbral: se avisa al owner una sola vez (QA R2 viaje-06). */
export interface HandoffPendienteSinTomar {
  readonly handoffId: string;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly conversationId: string;
  readonly canal: "whatsapp" | "voz";
  readonly minutos: number;
}

export interface AgotadoRepuesto {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly productId: string;
  readonly agotadoHasta: string;
}

export interface MuestrasTiempo {
  readonly muestras: readonly number[];
  readonly abiertos: number;
}

export interface EventoEstadoPedido {
  readonly desde: OrderStatus | null;
  readonly hacia: OrderStatus;
  readonly actor: string;
  readonly motivo: string | null;
  readonly at: string;
}

export type ResultadoCancelarCliente = { readonly aplicado: boolean; readonly estado: string } | null;

/** Reglas de TODA la organizacion (no por sucursal). */
export interface AutopilotoOrgConfig {
  /** El agente de WhatsApp gestiona las cancelaciones que pide el cliente (crea la solicitud o cancela solo si la sucursal lo permite). Apagada por omision. */
  readonly cancelacionAgente: boolean;
}

export interface AutopilotoRepository {
  leerConfig(organizationId: string, propertyId: string): Promise<Lectura<AutopilotoConfig>>;
  guardarConfig(organizationId: string, propertyId: string, config: Omit<AutopilotoConfig, "configurada">): Promise<{ readonly disponible: boolean }>;
  leerConfigOrg(organizationId: string): Promise<Lectura<AutopilotoOrgConfig>>;
  /** Solo owner/admin de alcance organizacional (lo exige la base). */
  guardarConfigOrg(organizationId: string, config: AutopilotoOrgConfig): Promise<{ readonly disponible: boolean }>;
  /** Solo sistema: convierte un pedido recien creado en `por_aprobar` y crea su solicitud (una sola transaccion, idempotente). */
  retenerPedidoGrande(organizationId: string, orderId: string, detalle: Readonly<Record<string, unknown>>): Promise<ResultadoRetener>;
  crearSolicitud(organizationId: string, propertyId: string, tipo: Exclude<SolicitudTipo, "pedido_grande">, orderId: string | null, detalle: Readonly<Record<string, unknown>>): Promise<ResultadoCrearSolicitud>;
  listarSolicitudes(organizationId: string, filtro: FiltroSolicitudes): Promise<Lectura<readonly SolicitudVista[]>>;
  /** Solo una persona: aprobar es una decision humana. `null` = base sin migrar. */
  resolverSolicitud(organizationId: string, solicitudId: string, decision: SolicitudDecision, opciones: OpcionesResolver): Promise<ResultadoResolver | null>;
  solicitudesPorEscalar(ahora: Date, limite: number): Promise<Lectura<readonly SolicitudPorEscalar[]>>;
  candidatosEstados(ahora: Date, limite: number): Promise<Lectura<readonly CandidatoEstado[]>>;
  aplicarTransicion(organizationId: string, orderId: string, desde: OrderStatus, hacia: OrderStatus, actor: "agente" | "pos" | "sistema", motivo: string): Promise<boolean>;
  comandasParaAvance(limite: number): Promise<Lectura<readonly ComandaParaAvance[]>>;
  devolverHandoffsVencidos(ahora: Date, limite: number): Promise<Lectura<readonly HandoffDevuelto[]>>;
  /** Solo sistema: marca (una sola vez) las tomas PENDIENTES que llevan N minutos sin que nadie las tome y las devuelve para avisar al owner. */
  handoffsPendientesPorEscalar(ahora: Date, limite: number): Promise<Lectura<readonly HandoffPendienteSinTomar[]>>;
  cancelarPorCliente(organizationId: string, orderId: string, motivo: string): Promise<ResultadoCancelarCliente>;
  /** Dia de NEGOCIO de la sucursal (YYYY-MM-DD): la cola de un turno que cruza la medianoche es del dia en que empezo. `null` = base sin migrar. */
  diaNegocio(organizationId: string, propertyId: string): Promise<string | null>;
  /** El staff imprimio el ticket de cocina de un pedido pending: habilita la aceptacion automatica sin POS. `disponible: false` = base sin migrar. */
  registrarTicketImpreso(organizationId: string, orderId: string): Promise<{ readonly disponible: boolean; readonly registrado: boolean }>;
  marcarAgotado(organizationId: string, propertyId: string, productId: string, hasta: string, hastaCalendario?: string): Promise<{ readonly disponible: boolean; readonly aplicado: boolean }>;
  reponerAgotados(ahora: Date): Promise<Lectura<readonly AgotadoRepuesto[]>>;
  muestrasTiempo(organizationId: string, propertyId: string, canal: CanalPedido, ahora: Date): Promise<Lectura<MuestrasTiempo>>;
  historialEstados(organizationId: string, orderId: string): Promise<Lectura<readonly EventoEstadoPedido[]>>;
}

/** Error de regla de negocio traducido desde Postgres (22023): la ruta lo devuelve como 422/400, nunca como 500. */
export class AutopilotoValidacionError extends Error {}
/** Sin acceso (42501): la ruta lo devuelve como 403. */
export class AutopilotoAccesoError extends Error {}
