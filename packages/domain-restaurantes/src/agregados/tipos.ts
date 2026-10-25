// Agregados por validar (migracion 099): el cliente ya tiene un pedido enviado a la sucursal y pide agregar productos por WhatsApp o llamada. El agente
// crea la SOLICITUD; una persona de la sucursal la acepta o la rechaza con motivo. Nunca se acepta sola ni el agente la confirma al cliente.
// Este archivo es PURO (tipos, constantes, reglas del SLA): lo importan el repositorio en memoria, el de Postgres, el servicio, la API y, por copia
// deliberada de sus contratos, la web (apps/web no importa paquetes domain-*).
import type { OrderStatus, PersistedOrderItem } from "../types.ts";

export const ESTADOS_AGREGADO = ["pendiente", "aceptado", "rechazado", "vencido", "cancelado_por_cliente", "no_aplicable"] as const;
export type EstadoAgregado = (typeof ESTADOS_AGREGADO)[number];

export const ESTADOS_AGREGADO_FINALES: readonly EstadoAgregado[] = ["aceptado", "rechazado", "vencido", "cancelado_por_cliente", "no_aplicable"];

/** Lista cerrada de motivos de rechazo (el servidor rechaza cualquier otro valor). */
export const MOTIVOS_RECHAZO_AGREGADO = ["ya_salio_de_cocina", "producto_agotado", "pedido_en_reparto", "fuera_de_horario", "otro"] as const;
export type MotivoRechazoAgregado = (typeof MOTIVOS_RECHAZO_AGREGADO)[number];

export const ETIQUETAS_MOTIVO_RECHAZO: Readonly<Record<MotivoRechazoAgregado, string>> = {
  ya_salio_de_cocina: "Ya salió de cocina",
  producto_agotado: "Producto agotado",
  pedido_en_reparto: "El pedido ya va en reparto",
  fuera_de_horario: "Fuera de horario",
  otro: "Otro motivo",
};

/** Texto del motivo tal como se le dice al cliente (neutral: sin «retraso», sin prometer dinero ni minutos). */
export const FRASE_MOTIVO_AL_CLIENTE: Readonly<Record<MotivoRechazoAgregado, string>> = {
  ya_salio_de_cocina: "el pedido ya salió de cocina",
  producto_agotado: "ya no nos queda ese producto",
  pedido_en_reparto: "el pedido ya va en camino",
  fuera_de_horario: "estamos fuera de horario",
  otro: "la sucursal no pudo agregarlo",
};

export function esMotivoRechazoAgregado(valor: unknown): valor is MotivoRechazoAgregado {
  return typeof valor === "string" && (MOTIVOS_RECHAZO_AGREGADO as readonly string[]).includes(valor);
}

/** Estados del PEDIDO en los que todavia se puede agregar algo (en cocina cabe el aviso ambar; ya en camino o entregado, no). */
export const ESTADOS_PEDIDO_AGREGABLES: readonly OrderStatus[] = ["programado", "pending", "preparando", "listo_para_recoger"];

export function pedidoAceptaAgregado(status: OrderStatus): boolean {
  return ESTADOS_PEDIDO_AGREGABLES.includes(status);
}

/** Topes de la solicitud (espejo de los CHECK de la migracion 099). */
export const AGREGADO_MAX_RENGLONES = 30;
export const AGREGADO_NOTA_MAX = 300;

/**
 * SLA (decision del dueno, DECISIONES-2): la sucursal responde en <= 10 min; a los 10 se avisa al dueno y al cliente UNA vez; a los 20 min sin respuesta el
 * agregado se cierra como `vencido` y se ofrece pedido aparte o recoger. NUNCA se acepta solo. Sin distinguir cajero de encargado: es por sucursal.
 */
export const SLA_AGREGADO = { avisoMin: 10, vencimientoMin: 20 } as const;

export type NivelSlaAgregado = "en_tiempo" | "sin_respuesta" | "vencido";

export interface SlaAgregado {
  readonly segundosEspera: number;
  readonly nivel: NivelSlaAgregado;
  /** Segundos que faltan para el siguiente umbral (10 o 20 min); `null` si ya paso el de vencimiento o la solicitud ya no esta pendiente. */
  readonly segundosParaSiguienteUmbral: number | null;
}

/**
 * Estado DERIVADO por el reloj: no escribe nada. Al LEER, una solicitud `pendiente` con 10+ minutos aparece como `sin_respuesta` y con 20+ como `vencido`
 * aunque el tick de 5 minutos todavia no la haya cerrado en la base (el tick solo confirma y dispara los avisos). Una solicitud ya resuelta no tiene SLA.
 */
export function calcularSla(estado: EstadoAgregado, requestedAtIso: string, ahora: Date): SlaAgregado {
  const espera = Math.max(0, Math.floor((ahora.getTime() - Date.parse(requestedAtIso)) / 1000));
  if (estado !== "pendiente") return { segundosEspera: espera, nivel: "en_tiempo", segundosParaSiguienteUmbral: null };
  const aviso = SLA_AGREGADO.avisoMin * 60;
  const vence = SLA_AGREGADO.vencimientoMin * 60;
  if (espera >= vence) return { segundosEspera: espera, nivel: "vencido", segundosParaSiguienteUmbral: null };
  if (espera >= aviso) return { segundosEspera: espera, nivel: "sin_respuesta", segundosParaSiguienteUmbral: vence - espera };
  return { segundosEspera: espera, nivel: "en_tiempo", segundosParaSiguienteUmbral: aviso - espera };
}

export type CanalAgregado = "whatsapp" | "voice";

/** Lectura que degrada: `disponible: false` = la base aun no tiene la migracion 099 (estado honesto, valor vacio). */
export interface LecturaAgregados<T> {
  readonly disponible: boolean;
  readonly valor: T;
}

/** Una solicitud con los datos del pedido que la decision necesita (se leen del pedido: la solicitud no copia nombre ni telefono). */
export interface AgregadoVista {
  readonly id: string;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly sucursal: string | null;
  readonly orderId: string;
  readonly orderNumber: number | null;
  readonly orderStatus: OrderStatus;
  readonly orderItems: readonly PersistedOrderItem[];
  readonly orderTotal: number;
  readonly orderCreatedAt: string;
  readonly customerName: string;
  readonly customerPhone: string;
  readonly estado: EstadoAgregado;
  readonly channel: CanalAgregado;
  readonly itemsAdded: readonly PersistedOrderItem[];
  readonly totalBefore: number;
  readonly totalAdded: number;
  readonly totalAfter: number;
  readonly customerNote: string | null;
  readonly version: number;
  readonly requestedAt: string;
  readonly firstSeenAt: string | null;
  readonly decidedAt: string | null;
  readonly decidedBy: string | null;
  readonly decidedByName: string | null;
  readonly rejectReason: MotivoRechazoAgregado | null;
  readonly rejectNote: string | null;
  readonly escalationLevel: 0 | 1 | 2;
  readonly escalatedAt: string | null;
}

export interface NuevoAgregado {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly orderId: string;
  readonly channel: CanalAgregado;
  readonly items: readonly PersistedOrderItem[];
  readonly customerNote?: string | null;
  /** Id opaco del evento (mensaje de Meta o llamada): el mismo evento nunca crea dos solicitudes. */
  readonly sourceEventId?: string | null;
}

export type ResultadoCrearAgregado =
  | { readonly estado: "creado" | "fusionado" | "repetido"; readonly agregado: AgregadoVista }
  /** La base aun no tiene la 099: quien llama cae a la escalada de siempre. */
  | { readonly estado: "no_disponible" }
  | { readonly estado: "pedido_no_encontrado" }
  | { readonly estado: "pedido_no_agregable"; readonly orderStatus: OrderStatus };

export type DecisionAgregado =
  | { readonly tipo: "aceptar" }
  | { readonly tipo: "rechazar"; readonly motivo: MotivoRechazoAgregado; readonly nota?: string | null };

export type ResultadoDecidirAgregado =
  | { readonly resultado: "aplicado"; readonly agregado: AgregadoVista }
  /** Doble clic o carrera: otra persona (o el sistema) ya lo resolvio. No se repite ningun efecto. */
  | { readonly resultado: "ya_resuelto"; readonly agregado: AgregadoVista }
  /** Al aceptar, el pedido ya no admite agregados (salio, se entrego o se cancelo): la solicitud queda `no_aplicable` y NO se toca el pedido. */
  | { readonly resultado: "no_aplicable"; readonly agregado: AgregadoVista }
  /** La solicitud seguia `pendiente` pero ya pasaron 20+ minutos: se cerro AHORA como `vencido` (con los mismos efectos que el tick) y NO se acepto ni se rechazo. */
  | { readonly resultado: "vencido"; readonly agregado: AgregadoVista }
  /** La solicitud cambio (el cliente pidio mas y se fusiono, version + 1) despues de que la persona la vio: no se decide nada; debe recargar y volver a decidir. */
  | { readonly resultado: "version_cambio"; readonly agregado: AgregadoVista }
  | { readonly resultado: "no_encontrado" }
  | { readonly resultado: "no_disponible" };

export interface OpcionesDecidir {
  /** Version que la persona vio en pantalla. Si la solicitud ya es otra (fusion), no se decide. Omitida = sin verificacion (solo para pruebas y llamadas internas). */
  readonly versionEsperada?: number;
}

export interface FiltroAgregados {
  /** `null` = todas las sucursales de la organizacion; arreglo = alcance de la membresia (admin acotado / staff de sucursal). */
  readonly propertyIds: readonly string[] | null;
  readonly estados?: readonly EstadoAgregado[];
  /** Solo solicitudes pedidas desde esta marca (ISO); para el historial reciente. */
  readonly desde?: string;
  readonly limite: number;
}

export type EventoAgregado = "creado" | "fusionado" | "visto" | "aceptado" | "rechazado" | "vencido" | "cancelado_por_cliente" | "no_aplicable" | "sin_respuesta_10min" | "cliente_avisado" | "callback_creado";

export interface EventoAgregadoEntrada {
  readonly amendmentId: string;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly tipoEvento: EventoAgregado;
  readonly actor: { readonly tipo: "usuario"; readonly userId: string } | { readonly tipo: "agente" } | { readonly tipo: "sistema" };
  /** Sin PII: ids, cantidades, motivos de lista cerrada. */
  readonly detalle?: Readonly<Record<string, unknown>>;
}

export interface AgregadosRepository {
  crear(input: NuevoAgregado): Promise<ResultadoCrearAgregado>;
  listar(organizationId: string, filtro: FiltroAgregados): Promise<LecturaAgregados<readonly AgregadoVista[]>>;
  obtener(organizationId: string, id: string, propertyIds: readonly string[] | null): Promise<LecturaAgregados<AgregadoVista | null>>;
  /** Marca la primera vez que una persona la vio (idempotente). */
  marcarVisto(organizationId: string, id: string, actorUserId: string, propertyIds: readonly string[] | null): Promise<void>;
  /** Aceptar (aplica los renglones al pedido en la misma transaccion) o rechazar. Compare-and-set sobre `pendiente`: la segunda llamada recibe `ya_resuelto`. */
  decidir(organizationId: string, id: string, decision: DecisionAgregado, actorUserId: string, propertyIds: readonly string[] | null, opciones?: OpcionesDecidir): Promise<ResultadoDecidirAgregado>;
  /** El cliente se arrepiente: cierra la solicitud abierta del pedido. */
  cancelarPorCliente(organizationId: string, orderId: string): Promise<LecturaAgregados<AgregadoVista | null>>;
  /** Solicitudes `pendiente` con `requestedAt <= antesDe` (el barrido del SLA, entre organizaciones, solo sesion de sistema). */
  pendientesAntesDe(antesDeIso: string, limite: number): Promise<LecturaAgregados<readonly AgregadoVista[]>>;
  /** Sube el nivel de escalamiento (0 -> 1) UNA vez: `true` solo para quien gana la carrera. */
  escalarNivel1(organizationId: string, id: string, ahora: Date): Promise<boolean>;
  /** Cierra como `vencido` (sistema, sin decided_by) una solicitud todavia pendiente: `true` solo para quien gana la carrera. */
  vencer(organizationId: string, id: string, ahora: Date): Promise<boolean>;
  registrarEvento(evento: EventoAgregadoEntrada): Promise<void>;
  listarEventos(organizationId: string, id: string, propertyIds: readonly string[] | null): Promise<LecturaAgregados<readonly { readonly evento: EventoAgregado; readonly actor: string; readonly at: string; readonly detalle: Readonly<Record<string, unknown>> }[]>>;
}

/** Lo que la herramienta del agente necesita de los agregados (la fija SOLO el servidor en el contexto, nunca el modelo): crear/fusionar la solicitud (con su aviso a la sucursal) y retirar la abierta. */
export interface AgregadosHook {
  crear(input: NuevoAgregado): Promise<ResultadoCrearAgregado>;
  /** El cliente se arrepintio: cierra la solicitud abierta de ese pedido. `true` si habia una. */
  cancelarPendiente(organizationId: string, orderId: string): Promise<boolean>;
}
