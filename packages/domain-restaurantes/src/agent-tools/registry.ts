// REGISTRO UNICO de tools de dominio del agente de restaurantes, compartido por WhatsApp y
// voz (ADR-PM-001 §5.4, brecha B9). Antes existian dos copias: `TOOLS` + `executeToolCall`
// en whatsapp/llm-turn-handler.ts y los handlers HTTP de apps/api (voice-tools.ts/public.ts).
// Ahora hay UNA definicion tipada (nombre, descripcion, esquema JSON, canales) y UN ejecutor:
// cada canal solo traduce formato (WhatsApp -> `LlmToolDefinition`; voz -> JSON de proveedor
// via `exportVoiceToolManifest`).
//
// Reglas de aislamiento que el registro impone a AMBOS canales:
//   * El telefono del cliente sale del CONTEXTO (`ctx.phone`: remitente de WhatsApp o token
//     de llamada firmado), nunca de los argumentos que escribe el modelo. Ninguna tool
//     declara un parametro de telefono.
//   * Si el contexto fija una sucursal (`ctx.lockedPropertyId`: token de llamada o numero de
//     WhatsApp de sucursal), una tool que apunte a otra sucursal de la organizacion se
//     rechaza.
import { createHash } from "node:crypto";
import { registerCallbackRequest } from "../callback-requests.ts";
import { cargarMemoria, evaluarReincidencia } from "../cliente-360/memoria.ts";
import { elegirPedido, repetirPedido } from "../cliente-360/repetir.ts";
import { getCustomerDetailById, lookupCustomerConPedidoReciente } from "../customers.ts";
import { buscarPedidoRecienteConSucursal } from "../pedido-reciente.ts";
import { fusionarRenglonesPorProducto } from "../promotions.ts";
import { aclararGuacamoleExtra } from "../whatsapp/guards.ts";
import { sanitizeInlineText } from "../text-sanitize.ts";
import { OrderValidationError } from "../errors.ts";
import { normalizePhone } from "../phone.ts";
import { PROPINA_PORCENTAJE_MAX } from "../whatsapp/guards.ts";
import { canonicalRequestedComplement, COMPLEMENTOS_PEDIBLES, DEFAULT_COMPLEMENTS, isTortillaChoice, PM_BASIC_COMPLEMENTS } from "../order-quote.ts";
import { estaAbiertoAhora, fechaLocal } from "../horarios.ts";
import { resolverZonaHorariaNegocio } from "@atiende/core-tenancy";
import { assignBranch, radioRepartoDelPerfil } from "../branch-assignment.ts";
import { COORDENADAS_PROPUESTAS_PM, coordenadasPropuestasActivas } from "../coordenadas-sucursales.ts";
import { kmAproxTexto } from "../nearest-branch.ts";
import { SUCURSALES_QUE_NO_REPARTEN_PM } from "../sugerencia-despacho.ts";
import { formatUbicacionEntregaNota, type UbicacionEntrega } from "../whatsapp/location.ts";
import { knownAmountsOfQuote } from "../whatsapp/guards.ts";
import { createOrder, prepareCreateOrder, quoteOrder, searchProducts, type PreparedOrder, type QuotePolicyInfo, type QuotePromotionInfo } from "../orders.ts";
import { acumuladoReciente, evaluarPedidoGrande, pesoTotalKg, PedidoGrandeRetenidoError, resumenPedidoGrande } from "../pedido-grande.ts";
import type { PedidoGrandeHook } from "../autopiloto/tipos.ts";
import { RestaurantesConfigUnavailableError, type RestaurantesRepository } from "../repository.ts";
import { parsearProgramadoPara } from "../pedidos-programados.ts";
import {
  assertCanConfirm,
  assertCanCreate,
  FLOW_ROW_TTL_SECONDS,
  QUOTE_TTL_MS,
  fingerprintOrder,
  huellaDeCarrito,
  itemsDeHuella,
  MISMO_PEDIDO_VENTANA_MS,
  priceSignature,
  idsDeOtrosProductosReales,
  reconciliarConCotizacion,
  resolverRenglonesCotizados,
  OrderFlowViolationError,
  warnOrderFlowUnavailable,
  type OrderFlowContext,
  type OrderFlowRef,
  type OrderFlowSnapshot,
  type OrderFlowState,
  type OrderFlowViolationCode,
  type QuotedItem,
} from "./order-flow.ts";
import type {
  CanalPedido,
  CreateOrderInput,
  DefaultComplement,
  DoubleSalsa,
  Order,
  OrderQuote,
  RequestedComplement,
  RequestedOrderItemInput,
} from "../types.ts";

/** Canales del agente: WhatsApp y llamada. El pedido en linea (checkout web) ya no existe. */
export type AgentChannel = "whatsapp" | "voz";

/** Modo de ejecucion del registro. `real` (por omision) = comportamiento de siempre. `preview` = prueba del dueno en el
 * panel: las lecturas y la maquina de estados del pedido son reales, pero NINGUNA herramienta escribe pedidos, clientes,
 * comandas, avisos ni correos (ver `crear_pedido` y `registrar_contacto` / `escalar_a_humano` en `dispatchTool`). El modo
 * lo fija SOLO el servidor en el contexto; ninguna herramienta lo lee de los argumentos del modelo (leccion X48 del
 * original: un `modo_prueba` manipulable por el LLM fue un bug real). */
export type AgentToolMode = "real" | "preview";

/** Prefijo de los folios de los pedidos simulados de la preview. */
export const FOLIO_PREVIEW_PREFIJO = "PRUEBA-";

/** Prefijo del rango de telefonos ficticios reservado para las conversaciones de preview (10 digitos nacionales). No es
 * un numero asignable a un cliente real: el 55 5550 se reserva para pruebas y el panel nunca lo muestra como cliente. */
export const TELEFONO_PREVIEW_PREFIJO = "555550";

/** Telefono ficticio estable por sesion de preview: `TELEFONO_PREVIEW_PREFIJO` + 4 digitos derivados de la sesion. */
export function telefonoFicticioPreview(sesionId: string): string {
  let h = 0;
  for (let i = 0; i < sesionId.length; i++) h = (h * 31 + sesionId.charCodeAt(i)) >>> 0;
  return `${TELEFONO_PREVIEW_PREFIJO}${String(h % 10000).padStart(4, "0")}`;
}

export function esTelefonoPreview(telefono: string | null | undefined): boolean {
  return typeof telefono === "string" && /^\d{10}$/.test(telefono) && telefono.startsWith(TELEFONO_PREVIEW_PREFIJO);
}

export type AgentToolName =
  | "buscar_cliente"
  | "historial_pedidos"
  | "repetir_pedido"
  | "consultar_sucursal"
  | "buscar_sucursal_cercana"
  | "buscar_producto"
  | "cotizar_pedido"
  | "confirmar_resumen"
  | "crear_pedido"
  | "registrar_contacto"
  | "escalar_a_humano";

/** Subconjunto de JSON Schema que usan las tools (mismo shape que `LlmToolDefinition.parameters`). */
export interface AgentToolJsonSchema {
  readonly type: "object";
  readonly properties: Readonly<Record<string, unknown>>;
  readonly required?: readonly string[];
}

export interface AgentToolDefinition {
  readonly name: AgentToolName;
  readonly description: string;
  readonly parameters: AgentToolJsonSchema;
  readonly channels: readonly AgentChannel[];
}

export interface AgentToolContext {
  readonly organizationId: string;
  readonly channel: AgentChannel;
  /** Telefono del cliente tomado del CONTEXTO (remitente de WhatsApp / token de llamada).
   * `null` = el canal no lo conoce (voz sin token de llamada, camino legado). */
  readonly phone: string | null;
  /** `true` cuando el telefono lo DICTO el cliente en una llamada cuyo caller ID no era confiable: nadie verifico que sea suyo, asi que las herramientas de
   * Cliente 360 (buscar_cliente, historial_pedidos, repetir_pedido) lo tratan como cliente nuevo y NO devuelven nombre, direcciones ni pedidos de ese numero. */
  readonly phoneDeclared?: boolean;
  /** Sucursal fijada por el contexto (token de llamada / numero de WhatsApp de sucursal). */
  readonly lockedPropertyId?: string | null;
  /** Sucursal del numero de WhatsApp por el que entro el chat. NO fija la sucursal del pedido (el cliente puede pedir en otra): solo
   * identifica a quien le toca el aviso de `escalar_a_humano` / `registrar_contacto` (el callback queda con `property_id`, no solo para la org). */
  readonly entryPropertyId?: string | null;
  /** Maquina de estados del pedido (order-flow.ts). Ausente = sin exigir cotizacion/confirmacion
   * (camino legado: voz con secreto global sin token de llamada). */
  readonly flow?: OrderFlowRef;
  /** Ultima ubicacion que el cliente COMPARTIO por WhatsApp (lat/lng reales del mensaje, no inventadas
   * por el modelo). Alimenta `buscar_sucursal_cercana` cuando el modelo no manda coordenadas. */
  readonly sharedLocation?: { readonly lat: number; readonly lng: number } | null;
  /** Ultimo destino de entrega que dio el cliente (pin de WhatsApp o link de Maps); `crear_pedido` lo guarda en el pedido solo, el modelo no lo repite. */
  readonly ubicacionEntrega?: UbicacionEntrega | null;
  /** Id del evento que origina las llamadas a herramientas (WhatsApp: id del mensaje de Meta; voz: id de la llamada). Hace idempotente
   * el aviso al equipo (`escalar_a_humano` / `registrar_contacto`, migracion 047): el mismo evento y motivo nunca crean dos avisos. */
  readonly sourceEventId?: string | null;
  /** `real` (por omision) o `preview` (sin efectos). SOLO lo fija el servidor, nunca el modelo ni el cliente. */
  readonly modo?: AgentToolMode;
  /** Solo `preview`: cliente de la organizacion que el panel eligio para «simular cliente conocido». `buscar_cliente`
   * lo resuelve con `getCustomerDetailById` (solo lectura, acotado a la organizacion). */
  readonly previewCustomerId?: string | null;
  /** Autopiloto: con el, un pedido grande de WhatsApp/voz se CREA y queda `por_aprobar` (la sucursal lo aprueba con un clic). Sin el (o con la base sin la
   * migracion 050) `crear_pedido` sigue por el aviso `escalada:pedido_grande` de siempre. Solo lo fija el servidor. */
  readonly pedidoGrande?: PedidoGrandeHook;
  /** Mide `buscar_sucursal_cercana` contra los pines propuestos de Google (`COORDENADAS_PROPUESTAS_PM`) en lugar de las coordenadas vigentes. Ausente = la bandera
   * `RESTAURANTES_USAR_COORDENADAS_PROPUESTAS`, APAGADA por omision (decision de Javier). Solo lo fija el servidor. */
  readonly usarCoordenadasPropuestas?: boolean;
  /** Mensajes del CLIENTE de esta conversacion de WhatsApp (los mas recientes). Solo lo fija el servidor; alimenta guardas que comparan lo que dijo el cliente con lo que cotiza el modelo
   * (p. ej. «guacamole» contra «Extra Guacamole»). Ausente (voz, camino legado) = esas guardas no opinan. */
  readonly mensajesDelCliente?: readonly string[];
}

export interface AgentToolOutcome {
  /** `true` cuando la tool corrio en modo preview y simulo su efecto (el pedido/aviso NO existe en la base). */
  readonly simulated?: boolean;
  /** Respuesta "wire" (snake_case) que ve el LLM de WhatsApp; la voz la usa salvo donde su
   * contrato historico difiere y lee `raw`. */
  readonly result: unknown;
  /** Objeto de dominio sin transformar (OrderQuote / Order), para los envoltorios HTTP de voz. */
  readonly raw?: unknown;
  readonly orderId: string | null;
  readonly propertyId: string | null;
  /** true solo cuando `executeAgentToolSafely` atrapo una excepcion que NO es una regla de negocio
   * (p. ej. un error de base de datos). Sirve a la observabilidad para separar `error_sistema` de `error_regla`. */
  readonly fallaSistema?: boolean;
  /** Huella de la cotizacion vigente (solo cotizar_pedido con maquina de estados activa). */
  readonly quoteHash?: string;
  /** crear_pedido de VOZ repetido tras un intento incierto (timeout del worker): devuelve el pedido ya registrado, sin crear otro. */
  readonly yaRegistrado?: boolean;
  /** crear_pedido: el pedido SI se creo pero quedo retenido (`por_aprobar`, pedido grande). Quien llama NO debe encolar su comanda al POS ni avisar "recibido":
   * eso lo hace la aprobacion con un clic. */
  readonly pedidoRetenido?: boolean;
  /** Codigo de la violacion de la maquina de estados que el SERVIDOR rechazo a proposito (solo `executeAgentToolSafely`, con `{error}`). */
  readonly rechazoDelFlujo?: OrderFlowViolationCode;
}

// ─────────────────────────────────────────────────────────────────────────
// Definiciones (una sola fuente)
// ─────────────────────────────────────────────────────────────────────────

/** Motivos con los que el agente pasa una conversacion a una persona. Los cinco primeros son los
 * historicos (genericos); el resto son los de la matriz de escalacion de Los Taquitos de PM (quejas,
 * modificacion de platillos, pago por transferencia, tiempos de entrega, etc.). Un valor fuera de la
 * lista se guarda como `otro`: el motivo viaja a la bandeja del gerente y no puede ser texto libre. */
export const MOTIVOS_ESCALACION = [
  "cliente_lo_pide",
  "queja",
  "no_puedo_resolver",
  "pedido_especial",
  "otro",
  "modificacion_platillo",
  "transferencia",
  "tiempos_entrega",
  "pedido_grande",
  "cancelacion_modificacion",
  "reposicion_descuento",
  "alergia_salud",
  "zona_no_reconocida",
  "zona_ambigua",
  "producto_agotado",
  "no_entiende",
  "falla_sistema",
  "cobro_duplicado",
  "urgencia",
  "privacidad_arco",
] as const;
export type MotivoEscalacion = (typeof MOTIVOS_ESCALACION)[number];

export function normalizarMotivoEscalacion(raw: unknown): MotivoEscalacion {
  return typeof raw === "string" && (MOTIVOS_ESCALACION as readonly string[]).includes(raw) ? (raw as MotivoEscalacion) : "otro";
}

const ITEM_SCHEMA = {
  type: "object",
  properties: {
    product_id: { type: "string" },
    product_name: { type: "string", description: "Nombre exacto devuelto por buscar_producto." },
    requested_quantity: { type: "integer", description: "Cantidad de piezas/unidades que pidio el cliente, no el numero de paquetes." },
    tortilla: { type: "string", enum: ["maiz", "harina", "mixta"] },
  },
  required: ["product_id", "product_name", "requested_quantity"],
} as const;

const DOBLE_SALSAS_SCHEMA = {
  type: "array",
  description: "Salsas de las que el cliente quiere DOBLE porción. Las 9 salsas ya van incluidas sin costo; la doble porción es un extra cobrado. \"Guacamole extra\" / \"extra guacamole\" NO es la doble salsa guacamolera: es el producto Extra Guacamole (buscar_producto).",
  items: { type: "string", enum: [...DEFAULT_COMPLEMENTS] },
} as const;

export const AGENT_TOOL_DEFINITIONS: readonly AgentToolDefinition[] = [
  {
    name: "buscar_cliente",
    description:
      "Devuelve el historial real del cliente que esta hablando (nombre, direcciones, ultimo pedido, lo que mas pide). No recibe telefono: el sistema usa el numero de la conversacion o llamada. Si el cliente DICTO su telefono (la linea no lo identifico), devuelve cliente nuevo: nunca datos de ese numero.",
    parameters: { type: "object", properties: {} },
    channels: ["whatsapp", "voz"],
  },
  {
    name: "historial_pedidos",
    description:
      "Lista los ultimos pedidos del cliente que esta hablando (sin cancelados): numero, fecha, canal, sucursal, productos y total de ESA vez. Sirve para ofrecer 'lo mismo de la vez pasada'. No recibe telefono: el sistema usa el numero de la conversacion o llamada; un cliente nunca ve pedidos de otro numero, y si el telefono lo dicto el cliente (la linea no lo identifico) la lista viene vacia.",
    parameters: { type: "object", properties: {} },
    channels: ["whatsapp", "voz"],
  },
  {
    name: "repetir_pedido",
    description:
      "Repite un pedido anterior del MISMO cliente re-cotizandolo con los precios y la disponibilidad de HOY (nunca el precio de la vez pasada). Devuelve la cotizacion normal (con quote_hash) y 'repeticion.cambios': productos que ya no estan disponibles o que cambiaron de precio, que DEBES avisar al cliente antes de confirmar. Sin pedido_numero repite el mas reciente. Despues sigue el flujo normal: repetir el resumen, confirmar_resumen y crear_pedido.",
    parameters: {
      type: "object",
      properties: {
        branch_slug: { type: "string", description: "Sucursal ya confirmada con el cliente." },
        pedido_numero: { type: "integer", description: "Numero del pedido a repetir (el que devolvio historial_pedidos). Opcional: sin el, el mas reciente." },
        canal: { type: "string", enum: ["domicilio", "recoger"], description: "Opcional: por defecto el mismo canal de la vez pasada." },
        colonia_entrega: { type: "string", description: "Colonia/zona de entrega (solo a domicilio)." },
        payment_method: { type: "string", enum: ["efectivo", "tarjeta"], description: "Forma de pago ya elegida, solo para saber si corresponde preguntar propina." },
        adult_confirmed: { type: "boolean", description: "true únicamente si el pedido incluye alcohol y el cliente confirmó mayoría de edad." },
      },
      required: ["branch_slug"],
    },
    channels: ["whatsapp", "voz"],
  },
  {
    name: "consultar_sucursal",
    description: "Datos reales de una sucursal: direccion, telefono, si esta abierta ahora, horario y pedido minimo por canal.",
    parameters: {
      type: "object",
      properties: { branch_slug: { type: "string", description: "El branch_slug de la sucursal." } },
      required: ["branch_slug"],
    },
    channels: ["whatsapp", "voz"],
  },
  {
    name: "buscar_sucursal_cercana",
    description:
      "Asigna la sucursal de DESPACHO real MÁS CERCANA EN KM al domicilio del cliente (distancia real; no adivines tú cuál está más cerca) y solo si está dentro del radio de reparto. Pásale la colonia/zona/referencia que dio el cliente y, si compartió su ubicación, lat y lng. Si responde asignada, dile al cliente cuál sucursal le atiende y a cuántos km aproximadamente (sin decimales). Si responde fuera_de_zona, di con claridad que queda fuera de la zona habitual de reparto y nombra la sucursal más cercana; nunca prometas el envío (solo el dueño autoriza excepciones): ofrece recoger. Si responde sugerida, la colonia SÍ existe pero no está ubicada con certeza: pide UNA vez la ubicación y, si no la manda, ofrece recoger o pasa con una persona; nunca digas que no reconoces la colonia. Llámala en cuanto tengas la colonia o una referencia clara.",
    parameters: {
      type: "object",
      properties: {
        colonia: { type: "string", description: "La colonia, zona o referencia que dio el cliente, tal cual." },
        lat: { type: "number", description: "Latitud de la ubicación compartida por el cliente (solo junto con lng)." },
        lng: { type: "number", description: "Longitud de la ubicación compartida por el cliente (solo junto con lat)." },
        max_km: { type: "number", description: "Radio máximo de reparto en km, solo si el negocio lo indicó." },
      },
      required: [],
    },
    channels: ["whatsapp", "voz"],
  },
  {
    name: "buscar_producto",
    description:
      "Busca productos del menú real de la sucursal por nombre, sinónimo o palabra clave. Devuelve id, nombre, precio real de esa sucursal, pack_size y requires_adult_confirmation. Lista vacía significa que ese producto no existe en el menú. Si ningún resultado coincide exactamente con lo que pidió el cliente (o hay varios parecidos), no elijas ni sustituyas por él: pregúntale cuál prefiere entre 2 o 3 opciones de la lista. Si algún resultado trae ambiguo: true, la búsqueda NO pudo fijar un único producto (por ejemplo «media orden» de algo que también se vende por kilo, o un peso que no existe): NO elijas por el cliente, pregúntale cuál presentación quiere antes de cotizar.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "texto a buscar, ej. 'pastor' o 'kilo arrachera'" },
        branch_slug: { type: "string", description: "El branch_slug de la sucursal ya confirmada. Si todavía no se confirma la sucursal, no llames esta herramienta." },
      },
      required: ["query", "branch_slug"],
    },
    channels: ["whatsapp", "voz"],
  },
  {
    name: "cotizar_pedido",
    description: "Valida cantidades/presentaciones y calcula el total exacto con precios reales. Debes llamarla antes de decir el total o preguntar la forma de pago.",
    parameters: {
      type: "object",
      properties: {
        branch_slug: { type: "string", description: "Sucursal ya confirmada con el cliente." },
        items: { type: "array", description: "Productos confirmados.", items: ITEM_SCHEMA },
        adult_confirmed: { type: "boolean", description: "true únicamente si el pedido incluye alcohol y el cliente confirmó mayoría de edad." },
        canal: { type: "string", enum: ["domicilio", "recoger"], description: "Si el pedido es a domicilio o para recoger en sucursal. Por defecto 'domicilio'." },
        colonia_entrega: { type: "string", description: "Colonia/zona de entrega que dio el cliente (solo a domicilio); la herramienta verifica que esté dentro de la zona de reparto de la sucursal." },
        payment_method: { type: "string", enum: ["efectivo", "tarjeta"], description: "Forma de pago ya elegida, solo para saber si corresponde preguntar propina." },
        doble_salsas: DOBLE_SALSAS_SCHEMA,
        otro_pedido: { type: "boolean", description: "true SOLO si el cliente pidió expresamente OTRO pedido igual al que ya quedó registrado. Un 'sí' de más o repetir el resumen NO es otro pedido: no lo mande." },
        programado_para: { type: "string", description: "Solo si el cliente quiere dejar el pedido para después (otro día o dentro de MÁS de 30 minutos con hora exacta): fecha y hora ISO 8601 con zona (por ejemplo 2026-10-03T14:00:00-06:00), con al menos 30 minutos de anticipación y máximo 7 días. La sucursal debe estar abierta a esa hora. Debe ser la MISMA que usaste al cotizar. Si el cliente pasa 'en cuanto esté', 'ahorita' o 'en 20 minutos', NO mandes este campo (omítelo; no mandes texto vacío)." },
        minutos_para_recoger: { type: "integer", description: "Solo canal 'recoger': si el cliente dijo un PLAZO (\"en 40 minutos\", \"en media hora\" = 30, \"dentro de una hora\" = 60), mande ESOS minutos en vez de calcular hora_recogida: el servidor calcula la hora con su reloj. Mande el mismo valor en cotizar_pedido y en crear_pedido. Para una hora exacta (\"a las 8:30\") use hora_recogida; con \"en cuanto esté\" no mande ninguno." },
        hora_recogida: { type: "string", description: "Solo canal 'recoger' y SIN programado_para: la hora a la que pasará el cliente (por ejemplo 'en 40 minutos'), en ISO 8601 con zona, calculada con la HORA LOCAL de la sucursal (no UTC). El servidor la valida (no pasada, de hoy, dentro del horario). Omítela si pasa 'en cuanto esté'." },
      },
      required: ["branch_slug", "items"],
    },
    channels: ["whatsapp", "voz"],
  },
  {
    name: "confirmar_resumen",
    description:
      "Registra que el CLIENTE confirmó explícitamente (dijo sí) el resumen completo devuelto por cotizar_pedido. Llámala solo después de repetirle los renglones y el total y de recibir su respuesta en un mensaje posterior; nunca en el mismo turno en que cotizaste. Sin esta confirmación el sistema rechaza crear_pedido.",
    parameters: {
      type: "object",
      properties: { quote_hash: { type: "string", description: "El quote_hash que devolvió cotizar_pedido (opcional; si se manda debe ser el de la última cotización)." } },
    },
    channels: ["whatsapp", "voz"],
  },
  {
    name: "crear_pedido",
    description: "Registra el pedido final en el sistema. Solo llamar cuando el cliente ya confirmó todo, incluyendo la sucursal. El sistema rechaza crear_pedido si antes no hubo cotizar_pedido y confirmar_resumen con los mismos productos.",
    parameters: {
      type: "object",
      properties: {
        branch_slug: { type: "string" },
        customer_name: { type: "string" },
        customer_address: { type: "string", description: "Dirección completa de entrega; obligatoria salvo canal 'recoger'." },
        items: { type: "array", items: ITEM_SCHEMA },
        notes: { type: "string" },
        requested_complements: { type: "array", items: { type: "string", enum: [...COMPLEMENTOS_PEDIBLES] }, description: "Complementos que el cliente PIDIÓ además de las básicas (sin costo): salsa_guacamolera, salsa_mexicana (pico de gallo, xnipec), salsa_pina, pina (piña picada, gratis si se pide), salsa_habanero, salsa_habanero_soasado (sauceada), crema_ajo. La doble porción de una salsa va en doble_salsas, no aquí." },
        omit_default_complements: { type: "array", items: { type: "string", enum: [...DEFAULT_COMPLEMENTS, "cebolla"] } },
        doble_salsas: DOBLE_SALSAS_SCHEMA,
        payment_method: { type: "string", enum: ["efectivo", "tarjeta"] },
        adult_confirmed: { type: "boolean" },
        canal: { type: "string", enum: ["domicilio", "recoger"], description: "Por defecto 'domicilio'. Para 'recoger' no hace falta customer_address." },
        colonia_entrega: { type: "string", description: "Colonia/zona de entrega (solo a domicilio)." },
        propina: { type: "number", description: "Propina en pesos, solo si cotizar_pedido indicó preguntar_propina: true y el cliente la dio. No suma al total." },
        propina_porcentaje: { type: "number", description: "Propina como PORCENTAJE del total ('de propina 10%' = 10), solo con tarjeta y si cotizar_pedido indicó preguntar_propina: true. El servidor calcula los pesos; no haga la cuenta ni mande propina junto con este campo." },
        efectivo_con: { type: "number", description: "Solo pago en efectivo: monto con el que paga el cliente ('cambio de 500' = 500). Debe ser mayor o igual al total de cotizar_pedido." },
        llevar_terminal: { type: "boolean", description: "true si el cliente pide que lleven terminal (pago con tarjeta a domicilio)." },
        indicaciones_acceso: { type: "string", description: "Solo domicilio, una línea corta (máx. 200 caracteres): cómo llegar o avisar ('timbre del depto 6', 'avísenme al llegar'). No pongas aquí la ubicación: el pin ya se guarda solo." },
        telefono_alterno: { type: "string", description: "Segundo teléfono de contacto, 10 dígitos, si el cliente lo da." },
        minutos_para_recoger: { type: "integer", description: "Solo canal 'recoger': si el cliente dijo un PLAZO (\"en 40 minutos\", \"en media hora\" = 30, \"dentro de una hora\" = 60), mande ESOS minutos en vez de calcular hora_recogida: el servidor calcula la hora con su reloj. Mande el mismo valor en cotizar_pedido y en crear_pedido. Para una hora exacta (\"a las 8:30\") use hora_recogida; con \"en cuanto esté\" no mande ninguno." },
        hora_recogida: { type: "string", description: "Solo canal 'recoger': hora a la que el cliente pasará, en ISO 8601 con zona (por ejemplo 2026-09-30T20:30:00-06:00). Si el cliente dijo una hora o un plazo (\"en 40 minutos\", \"a las 2\") MÁNDELA igual que en cotizar_pedido; nunca vacía: omítala solo si pasa 'en cuanto esté'." },
        direccion_etiqueta: { type: "string", description: "Opcional: como llama el cliente a este domicilio (casa, oficina...). Solo si lo dijo." },
        referencias_acceso: { type: "string", description: "Opcional: referencias para llegar (porton, timbre, entre calles). Solo si las dio el cliente." },
        maps_url: { type: "string", description: "Opcional: link de Google Maps/Waze que el cliente mando por escrito (https). Nunca lo inventes." },
        usar_ubicacion_compartida: { type: "boolean", description: "true solo si el cliente compartio su ubicacion por WhatsApp Y es la de este domicilio de entrega; el sistema usa las coordenadas reales del mensaje." },
        programado_para: { type: "string", description: "Solo si el cliente quiere dejar el pedido para después: fecha y hora ISO 8601 con zona (por ejemplo 2026-10-03T14:00:00-06:00), con al menos 30 minutos de anticipación y máximo 7 días. La sucursal debe estar abierta a esa hora. Debe ser la MISMA que usaste al cotizar." },
      },
      required: ["branch_slug", "customer_name", "items", "payment_method"],
    },
    channels: ["whatsapp", "voz"],
  },
  {
    name: "registrar_contacto",
    description:
      "Registra nombre/motivo de un mensaje que NO es para hacer un pedido, para que alguien del restaurante le regrese la llamada. Nunca usar para pedidos normales. Caso especial: reason 'cliente_llego' cuando quien tiene un pedido para RECOGER avisa que ya llegó ('ya llegué, estoy afuera en un auto gris'): avisa de inmediato a la sucursal y devuelve el mensaje fijo que debes dar al cliente; en message va solo cómo identificarlo (auto, ropa, lugar). Caso especial 2: reason 'pedido_telefonico' cuando el cliente ya hizo su pedido POR TELÉFONO con la sucursal y solo quiere pasarle su ubicación o una nota (no crea pedido): deja el aviso con la nota y la ubicación que mandó.",
    parameters: {
      type: "object",
      properties: { customer_name: { type: "string" }, reason: { type: "string" }, message: { type: "string" } },
      required: ["customer_name", "reason"],
    },
    channels: ["whatsapp", "voz"],
  },
  {
    name: "escalar_a_humano",
    description:
      "Pasa la conversación a una persona del restaurante cuando el cliente lo pide, hay una queja, o no puedes resolver lo que necesita. Deja un aviso con el motivo para que alguien le responda.",
    parameters: {
      type: "object",
      properties: {
        customer_name: { type: "string" },
        motivo: {
          type: "string",
          enum: [...MOTIVOS_ESCALACION],
          description:
            "Motivo del aviso (llamala UNA sola vez por conversacion y motivo): transferencia (quiere pagar por transferencia), modificacion_platillo (pide cambiar ingredientes o receta de un platillo), alergia_salud, cancelacion_modificacion (cancelar o cambiar un pedido ya confirmado), producto_agotado, zona_no_reconocida (colonia no reconocida dos veces), no_entiende (no se le entiende dos veces), falla_sistema, pedido_grande / tiempos_entrega (pedido muy grande o exige un tiempo concreto), cobro_duplicado, urgencia, privacidad_arco (derechos ARCO / datos personales).",
        },
        resumen: { type: "string", description: "Una o dos frases con lo que necesita el cliente." },
      },
      required: ["motivo"],
    },
    channels: ["whatsapp", "voz"],
  },
];

/** Definiciones visibles para un canal (ninguna parametro de telefono, por diseño). */
export function toolDefinitionsForChannel(channel: AgentChannel): readonly AgentToolDefinition[] {
  return AGENT_TOOL_DEFINITIONS.filter((t) => t.channels.includes(channel));
}

/** Ruta HTTP (relativa a `/v1/restaurantes/:orgSlug`) con la que el proveedor de voz invoca cada tool. */
export const VOICE_TOOL_HTTP_PATHS: Readonly<Record<AgentToolName, string>> = {
  buscar_cliente: "/customers/lookup",
  historial_pedidos: "/customers/orders",
  repetir_pedido: "/orders/repeat",
  consultar_sucursal: "/branches/info",
  buscar_sucursal_cercana: "/branches/nearest",
  buscar_producto: "/products/search",
  cotizar_pedido: "/orders/quote",
  confirmar_resumen: "/orders/confirm",
  crear_pedido: "/orders",
  registrar_contacto: "/callbacks",
  escalar_a_humano: "/callbacks",
};

/**
 * Definicion en JSON (neutral al proveedor) para configurar el agente de voz: misma fuente
 * que usa WhatsApp, mas metodo/URL. El proveedor agrega la cabecera del token de llamada
 * (`x-atiende-call-token`) y el secreto de sucursal (`x-atiende-tool-secret`).
 */
export function exportVoiceToolManifest(baseUrl: string, orgSlug: string): ReadonlyArray<{
  readonly name: string;
  readonly description: string;
  readonly method: "POST";
  readonly url: string;
  readonly request_body_schema: AgentToolJsonSchema;
}> {
  const root = `${baseUrl.replace(/\/+$/, "")}/v1/restaurantes/${encodeURIComponent(orgSlug)}`;
  return toolDefinitionsForChannel("voz").map((t) => ({
    name: t.name,
    description: t.description,
    method: "POST" as const,
    url: `${root}${VOICE_TOOL_HTTP_PATHS[t.name]}`,
    request_body_schema: t.parameters,
  }));
}

// ─────────────────────────────────────────────────────────────────────────
// Mapeo de entrada/salida (snake_case wire <-> camelCase de dominio)
// ─────────────────────────────────────────────────────────────────────────

interface RawItemInput {
  readonly product_id?: unknown;
  readonly product_name?: unknown;
  readonly requested_quantity?: unknown;
  readonly tortilla?: unknown;
}

/** Mensaje al modelo cuando una cantidad no es un entero positivo: accionable y en usted (el cliente lo lee parafraseado). */
export const CANTIDAD_NO_NUMERICA_MENSAJE =
  "Indique la cantidad con un número entero de piezas (por ejemplo 2). Para medio kilo o una fracción de kilo use el renglón de esa fracción (por ejemplo 'Pastor — 500 g'), no una cantidad decimal ni escrita con letras.";

/** `lenient` (WhatsApp): una cantidad escrita como numero ("2") se acepta, pero una que no es un entero positivo ('medio', 'dos', 0, 1.5, ausente)
 * se RECHAZA con un error accionable. Antes se convertia en silencio a 1 (`Number(x) || 1`): 'medio' kilo se cotizaba como 1 kg. Voz y web dejan
 * pasar el valor para que la validacion de dominio lo rechace. */
export function toRequestedItems(raw: unknown, lenient: boolean): RequestedOrderItemInput[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => {
    const item = (entry ?? {}) as RawItemInput;
    const qty = typeof item.requested_quantity === "number" ? item.requested_quantity : Number(item.requested_quantity);
    if (lenient && (!Number.isInteger(qty) || qty < 1)) throw new OrderValidationError(CANTIDAD_NO_NUMERICA_MENSAJE);
    return {
      productId: typeof item.product_id === "string" ? item.product_id : undefined,
      productName: typeof item.product_name === "string" ? item.product_name : undefined,
      requestedQuantity: qty,
      tortilla: isTortillaChoice(item.tortilla) ? item.tortilla : undefined,
    };
  });
}

export function quoteToWire(quote: OrderQuote & Partial<QuotePolicyInfo> & Partial<QuotePromotionInfo>) {
  return {
    lines: quote.lines.map((line) => ({
      product_id: line.productId,
      name: line.name,
      price: line.price,
      requested_quantity: line.requestedQuantity,
      pack_size: line.packSize,
      quantity: line.quantity,
      tortilla: line.tortilla,
      requires_adult_confirmation: line.requiresAdultConfirmation,
      line_total: line.lineTotal,
    })),
    // `total` es el TOTAL A PAGAR (ya con la promocion automatica, si hubo); `subtotal` es la suma de renglones.
    total: quote.total,
    contains_alcohol: quote.containsAlcohol,
    ...(quote.promocionAplicada
      ? { subtotal: quote.subtotal, descuento: quote.descuento, promocion_aplicada: { code: quote.promocionAplicada.code, name: quote.promocionAplicada.name, type: quote.promocionAplicada.type, descuento: quote.promocionAplicada.descuento } }
      : {}),
    ...(quote.promocionesSugeridas && quote.promocionesSugeridas.length > 0
      ? {
          promociones_sugeridas: quote.promocionesSugeridas.map((s) => ({
            code: s.code,
            name: s.name,
            motivo: s.motivo,
            mensaje: s.mensaje,
            ...(s.opcionesCortesia ? { opciones_cortesia: s.opcionesCortesia.map((o) => ({ product_id: o.productId, name: o.name })), cortesia_por_unidad: s.cortesiaPorUnidad ?? 0 } : {}),
          })),
        }
      : {}),
    // Modelo PM: politica de la sucursal que aplico la herramienta (minimo ya cumplido,
    // propina, horario). Solo se incluye lo que la cotizacion reporto.
    ...(quote.canal ? { canal: quote.canal } : {}),
    ...(quote.pedidoMinimo !== undefined && quote.pedidoMinimo !== null ? { pedido_minimo: quote.pedidoMinimo } : {}),
    ...(quote.propinaPolitica ? { propina_politica: quote.propinaPolitica, preguntar_propina: quote.preguntarPropina === true } : {}),
    ...(quote.programadoPara ? { programado_para: quote.programadoPara } : {}),
    ...(quote.abiertoAhora !== undefined && quote.abiertoAhora !== null ? { abierto_ahora: quote.abiertoAhora, cierra_a: quote.cierraA ?? null } : {}),
  };
}

/** `undefined` si no vino; un valor fuera del catalogo se deja pasar para que la validacion de dominio lo rechace. */
function toDoubleSalsas(raw: unknown): readonly DoubleSalsa[] | undefined {
  // QA-PM-R4-reglas-09: doble_salsas que no es una lista se ignoraba en silencio y el pedido salia sin cobrar ni anotar el extra.
  if (raw !== undefined && raw !== null && raw !== "" && !Array.isArray(raw)) {
    throw new OrderValidationError('doble_salsas debe ser una lista de salsas (por ejemplo ["salsa_roja"]), no un texto. Mándela como lista en cotizar_pedido y en crear_pedido.');
  }
  return Array.isArray(raw) ? (raw as readonly DoubleSalsa[]) : undefined;
}

/** `undefined` si no vino; si vino, se valida y normaliza a ISO UTC (lanza `OrderValidationError`) para que la huella
 * de cotizar y la de crear comparen el mismo instante aunque el modelo cambie el offset. */
function toProgramadoPara(raw: unknown): string | undefined {
  // El modelo manda "" cuando no hay hora programada: es "sin programar", no una hora invalida (QA-PM-R2-reglas-02).
  if (raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "")) return undefined;
  return parsearProgramadoPara(raw);
}

/** Hora de recogida normalizada al minuto en ISO UTC (para la huella del pedido); texto que no es fecha se compara tal cual. `undefined` si no vino. */
function toHoraRecogida(raw: unknown): string | undefined {
  const t = textoOpcional(raw)?.trim();
  if (!t) return undefined;
  const ms = Date.parse(t);
  return Number.isNaN(ms) ? t.toLowerCase() : new Date(ms).toISOString().slice(0, 16);
}

/** Texto en blanco = ausente (el modelo manda "" en vez de omitir el campo). */
function textoOpcional(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

/**
 * QA R2 features-07: el codigo de compensacion («Descuento en el proximo pedido») que el dueno emitio a ESTE cliente se aplica solo, por el
 * SERVIDOR, a su siguiente pedido por WhatsApp o voz. El modelo nunca dicta ni recibe un codigo (decision de PM, T-AB01: ninguna tool acepta
 * promo, descuento ni total): el telefono sale del contexto del canal. Sin telefono, en vista previa del dueno o contra la base sin migrar
 * devuelve `undefined` y el pedido sigue exactamente como antes. Si ademas vino un codigo explicito (voz HTTP) manda ese.
 */
async function compensacionPendiente(repo: RestaurantesRepository, ctx: AgentToolContext): Promise<string | undefined> {
  if (ctx.modo === "preview" || !ctx.phone) return undefined;
  return (await repo.findCompensationCode(ctx.organizationId, ctx.phone)) ?? undefined;
}

const PROGRAMADOS_NO_DISPONIBLES = "Los pedidos programados todavía no están disponibles en este restaurante. Ofrece un pedido normal o pasa la conversación a una persona.";

function toCanal(raw: unknown): CanalPedido | undefined {
  return typeof raw === "string" ? (raw as CanalPedido) : undefined;
}

export function orderToWire(order: Order) {
  return {
    id: order.id,
    branch: order.branch,
    total: order.total,
    status: order.status,
    payment_method: order.paymentMethod,
    items: order.items,
  };
}

/** Una tool apunta a otra sucursal que la fijada por el contexto -> se rechaza (aislamiento entre sucursales). */
async function assertBranchAllowed(repo: RestaurantesRepository, ctx: AgentToolContext, branchSlug: string, branchName?: string): Promise<void> {
  if (!ctx.lockedPropertyId) return;
  const branch = await repo.findBranch(ctx.organizationId, branchSlug ? { slug: branchSlug } : { name: branchName });
  if (branch && branch.propertyId !== ctx.lockedPropertyId) {
    throw new OrderValidationError("Esta llamada o conversación pertenece a otra sucursal; no se puede operar sobre la sucursal indicada.");
  }
}


/**
 * H17 en el SERVIDOR (QA-PM-R3-reglas-05): un chat de WhatsApp que entra por el numero de una sucursal no toma pedidos PARA RECOGER en otra (hasta hoy solo lo
 * pedia el prompt: R76 creaba 3 tacos en Pensiones desde el chat de Garcia Lavin). Se rechaza con el telefono de la sucursal que le toca. El domicilio no se
 * limita aqui: la sucursal la decide la zona (`buscar_sucursal_cercana`). Sin sucursal de entrada (numero unico, vista previa del dueno) no hay nada que comparar.
 */
async function assertRecogerEnSucursalDeEntrada(repo: RestaurantesRepository, ctx: AgentToolContext, branchSlug: string, canal: unknown): Promise<void> {
  if (ctx.channel !== "whatsapp" || ctx.modo === "preview" || !ctx.entryPropertyId || canal !== "recoger") return;
  const branch = await repo.findBranch(ctx.organizationId, { slug: branchSlug });
  if (!branch || branch.propertyId === ctx.entryPropertyId) return;
  // H17 es una regla del perfil `taqueria_pm`: otro perfil conserva el comportamiento de siempre (T-ZS06/P29: entrar por el numero de la sucursal A y pedir en la B).
  const perfil = (await repo.findWhatsAppAgentConfig(ctx.organizationId, ctx.entryPropertyId))?.perfil ?? "generico";
  if (perfil !== "taqueria_pm") return;
  const propia = (await repo.listBranchesForOrganization(ctx.organizationId)).find((b) => b.propertyId === ctx.entryPropertyId);
  throw new OrderValidationError(
    `Este chat es de ${propia?.name ?? "otra sucursal"}: el pedido para recoger en ${branch.name} no se toma aquí (H17). Dele al cliente el teléfono de ${branch.name}${branch.phone ? ` (${branch.phone})` : ""} y dígale con calidez que ahí lo atienden; si prefiere, ofrezca recoger en ${propia?.name ?? "la sucursal de este chat"}.`,
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Ejecutor unico
// ─────────────────────────────────────────────────────────────────────────

/** Renglones de `crear_pedido`. WhatsApp (`lenient`) conserva el redondeo historico a 1; voz conserva el
 * contrato historico del checkout (`quantity` legado + `requested_quantity` opcional). */
function toCreateOrderItems(raw: unknown, lenient: boolean): CreateOrderInput["items"] {
  if (lenient) return toRequestedItems(raw, true);
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => {
    const item = (entry ?? {}) as RawItemInput & { quantity?: unknown };
    return {
      productId: typeof item.product_id === "string" ? item.product_id : undefined,
      productName: typeof item.product_name === "string" ? item.product_name : undefined,
      quantity: typeof item.quantity === "number" ? item.quantity : undefined,
      requestedQuantity: typeof item.requested_quantity === "number" ? item.requested_quantity : undefined,
      tortilla: isTortillaChoice(item.tortilla) ? item.tortilla : undefined,
    };
  });
}


/**
 * QA-PM-R3-reglas-09: dos datos invalidos se descartaban EN SILENCIO y el pedido se creaba igual (la comanda salia sin la salsa que el cliente habia pedido, o sin la
 * propina que dijo): un complemento que no es de la lista cerrada ("chimichurri") y una propina que no es un monto ("veinte"). Para los agentes se rechazan con un
 * mensaje accionable en vez de crear un pedido distinto al que el cliente acepto. El relleno de siempre (propina 0 o vacia, lista vacia) sigue siendo "sin dato".
 */
/** "10%" / "10 %" -> 10; cualquier otra cosa -> null. Un porcentaje valido va de 1 a 100. */
function porcentajeDePropina(valor: unknown): number | null {
  if (typeof valor === "number") return Number.isFinite(valor) && valor > 0 && valor <= PROPINA_PORCENTAJE_MAX ? valor : null;
  if (typeof valor !== "string") return null;
  const m = /^\s*(\d{1,3}(?:[.,]\d{1,2})?)\s*(?:%|por\s*ciento)\s*$/i.exec(valor);
  if (!m) return null;
  const n = Number(m[1]!.replace(",", "."));
  return n > 0 && n <= PROPINA_PORCENTAJE_MAX ? n : null;
}

function esSalsaBasicaIncluida(valor: unknown): boolean {
  return typeof valor === "string" && (DEFAULT_COMPLEMENTS as readonly string[]).includes(valor.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim().replace(/\s+/g, "_"));
}

function assertEntradasReconocidas(input: Record<string, unknown>): void {
  if (Array.isArray(input.requested_complements)) {
    // QA-PM-R4-reglas-10: una salsa BASICA ("salsa_verde") ya viene incluida sin costo: no se rechaza como "no la manejamos"; es un no-op (la comanda ya la lleva).
    const desconocidos = input.requested_complements.filter((c) => typeof c === "string" && c.trim() !== "" && canonicalRequestedComplement(c) === null && !esSalsaBasicaIncluida(c));
    if (desconocidos.length > 0) {
      throw new OrderValidationError(
        `No manejamos ${desconocidos.map((c) => `"${String(c)}"`).join(", ")} como complemento. Los que sí se piden son: ${COMPLEMENTOS_PEDIBLES.join(", ")}. Dígale al cliente que ese no lo manejamos y ofrezca uno de la lista; no lo anote ni lo dé por registrado.`,
      );
    }
  }
  const pctCrudo = input.propina_porcentaje;
  if (pctCrudo !== undefined && pctCrudo !== null && pctCrudo !== "" && porcentajeDePropina(pctCrudo) === null) {
    throw new OrderValidationError(`propina_porcentaje debe ser un número entre 1 y ${PROPINA_PORCENTAJE_MAX} (por ejemplo 10 para el 10 %). Si el cliente dio pesos, mande propina en pesos.`);
  }
  const propina = input.propina;
  if (propina !== undefined && propina !== null && propina !== "" && typeof propina === "string" && porcentajeDePropina(propina) !== null) return;
  if (propina !== undefined && propina !== null && propina !== "" && (typeof propina !== "number" || !Number.isFinite(propina))) {
    throw new OrderValidationError("La propina debe ser un monto numérico en pesos (por ejemplo 20). Pregúntele al cliente cuánto desea dejar y vuelva a mandarla como número.");
  }
}

/** Convierte los argumentos de `crear_pedido` en el input de dominio. El telefono viene del CONTEXTO
 * siempre que el canal lo conoce (WhatsApp: remitente; voz: token de llamada). */
export function mapCreateOrderToolInput(ctx: AgentToolContext, input: Record<string, unknown>, lenient: boolean): CreateOrderInput {
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  assertEntradasReconocidas(input);
  const base: CreateOrderInput = {
    organizationId: ctx.organizationId,
    branchSlug: lenient ? String(input.branch_slug ?? "") : str(input.branch_slug),
    customerName: lenient ? String(input.customer_name ?? "") : (str(input.customer_name) ?? ""),
    customerPhone: ctx.phone ?? (lenient ? "" : (str(input.customer_phone) ?? "")),
    customerAddress: str(input.customer_address),
    items: toCreateOrderItems(input.items, lenient),
    source: ctx.channel === "voz" ? "voice" : "whatsapp",
    notes: str(input.notes),
    paymentMethod: input.payment_method === "efectivo" || input.payment_method === "tarjeta" ? input.payment_method : undefined,
    adultConfirmed: lenient ? input.adult_confirmed === true : typeof input.adult_confirmed === "boolean" ? input.adult_confirmed : undefined,
    requestedComplements: Array.isArray(input.requested_complements)
      ? input.requested_complements.map(canonicalRequestedComplement).filter((c): c is RequestedComplement => c !== null)
      : undefined,
    omitDefaultComplements: Array.isArray(input.omit_default_complements) ? (input.omit_default_complements as readonly DefaultComplement[]) : undefined,
    // Los agentes (WhatsApp/voz) piden la comanda con «Básicas» y «Pedidas»; `crear_pedido` lo restringe despues al perfil `taqueria_pm`
    // (una organizacion con otro perfil conserva las 9 incluidas).
    basicComplements: PM_BASIC_COMPLEMENTS,
    ubicacionEntrega: ctx.ubicacionEntrega ?? undefined,
    // Los agentes rellenan los opcionales que no tienen con 0 o "" (efectivo_con 0, telefono_alterno ""): eso es "sin dato", no un dato invalido
    // (despues de fusionar efectivo_con y telefono_alterno, 15 crear_pedido de la medida fallaban por ese relleno y el cliente se quedaba sin pedido).
    efectivoCon: typeof input.efectivo_con === "number" && (input.efectivo_con > 0 && input.payment_method !== "tarjeta") ? input.efectivo_con : undefined,
    llevarTerminal: input.llevar_terminal === true ? true : undefined,
    indicacionesAcceso: str(input.indicaciones_acceso),
    telefonoAlterno: textoOpcional(input.telefono_alterno)?.trim() || undefined,
    doubleSalsas: toDoubleSalsas(input.doble_salsas),
    canal: toCanal(input.canal),
    colonia: str(input.colonia_entrega),
    ...(ctx.sharedLocation && ctx.channel === "whatsapp" ? { ubicacion: { lat: ctx.sharedLocation.lat, lng: ctx.sharedLocation.lng } } : {}),
    propina: typeof input.propina === "number" ? input.propina : undefined,
    ...(typeof input.propina !== "number" || input.propina === 0
      ? (() => {
          const pct = porcentajeDePropina(input.propina_porcentaje) ?? (typeof input.propina === "string" ? porcentajeDePropina(input.propina) : null);
          return pct !== null ? { propinaPorcentaje: pct } : {};
        })()
      : {}),
    horaRecogida: textoOpcional(input.hora_recogida),
    // Cliente 360: datos opcionales del domicilio (solo alimentan la ficha; nunca cambian el total).
    addressLabel: str(input.direccion_etiqueta),
    accessNotes: str(input.referencias_acceso),
    mapsUrl: str(input.maps_url) ?? (input.usar_ubicacion_compartida === true && ctx.sharedLocation ? `https://www.google.com/maps?q=${ctx.sharedLocation.lat},${ctx.sharedLocation.lng}` : undefined),
    programadoPara: textoOpcional(input.programado_para),
  };
  if (lenient) return base;
  // Campos que solo trae el canal de voz (correo, transcripcion, promo, idempotencia, nombre de sucursal).
  return {
    ...base,
    // Un valor que no es hora (numero, objeto) se rechaza con 400 en vez de ignorarse y mandar el pedido a cocina de inmediato.
    programadoPara: toProgramadoPara(input.programado_para),
    branchName: str(input.branch_name),
    customerEmail: str(input.customer_email),
    idempotencyKey: str(input.idempotency_key),
    callTranscript: str(input.call_transcript),
    callRecordingUrl: str(input.call_recording_url),
    promoCode: str(input.promo_code),
  };
}

/**
 * Ejecuta UNA tool del registro. Lanza `OrderValidationError` ante errores de negocio (el
 * envoltorio de WhatsApp los convierte en `{error}`; el HTTP de voz en 400). No abre SAVEPOINT:
 * quien ejecute dentro de una transaccion compartida debe envolver la llamada (ver
 * `executeAgentToolSafely`).
 */
export async function invokeAgentTool(repo: RestaurantesRepository, ctx: AgentToolContext, name: string, rawInput: Record<string, unknown>): Promise<AgentToolOutcome> {
  const def = AGENT_TOOL_DEFINITIONS.find((t) => t.name === name);
  if (!def || !def.channels.includes(ctx.channel)) throw new OrderValidationError(`Herramienta desconocida: ${name}`);
  // `plazo_minutos_servidor` es un campo INTERNO que solo pone `conHoraDeRecogidaRelativa`: lo que mande el modelo se descarta.
  const { plazo_minutos_servidor: _interno, ...entrada } = rawInput;
  // QA-PM-R4-reglas-11: una hora_recogida que no es texto (un epoch numerico) se ignoraba en silencio y el pedido salia sin hora (cocina lo trata como "para ya").
  if ((name === "cotizar_pedido" || name === "crear_pedido") && entrada.hora_recogida !== undefined && entrada.hora_recogida !== null && typeof entrada.hora_recogida !== "string") {
    throw new OrderValidationError("hora_recogida debe ser texto en ISO 8601 con zona (por ejemplo 2026-09-30T20:30:00-06:00), no un número. Si el cliente dio un plazo (\"en 40 minutos\"), mande minutos_para_recoger.");
  }
  const input = await conHoraDeRecogidaRelativa(repo, ctx, name, entrada);
  if (!ctx.flow || (name !== "cotizar_pedido" && name !== "confirmar_resumen" && name !== "crear_pedido" && name !== "repetir_pedido")) {
    return dispatchTool(repo, ctx, name, input);
  }
  return runWithOrderFlow(repo, ctx, ctx.flow, name, input);
}


/** Maximo de `minutos_para_recoger` (misma cota que la recogida de hoy: `HORA_RECOGIDA_MAX_HORAS`). */
const MINUTOS_PARA_RECOGER_MAX = 12 * 60;

/**
 * QA-PM-R3-voz-02 / reglas-01: el modelo calculaba mal la hora absoluta de "en 40 minutos" (58 de 132 cotizar/crear de voz rechazados por "mas de 12 horas";
 * 8 cotizaciones identicas seguidas = 30 s de silencio; en WhatsApp la hora ya habia pasado). Con `minutos_para_recoger` el modelo manda el PLAZO que dijo el
 * cliente y el SERVIDOR calcula `hora_recogida` con su reloj. En `crear_pedido` se reutiliza la hora ya cotizada (si la hay) para que no cambie por el paso del
 * tiempo entre cotizar y crear. Una `hora_recogida` explicita manda sobre el plazo.
 */
async function conHoraDeRecogidaRelativa(repo: RestaurantesRepository, ctx: AgentToolContext, name: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (name !== "cotizar_pedido" && name !== "crear_pedido") return input;
  if (textoOpcional(input.hora_recogida) || textoOpcional(input.programado_para) || input.canal !== "recoger") return input;
  const crudo = input.minutos_para_recoger;
  const minutos = typeof crudo === "number" ? crudo : typeof crudo === "string" && crudo.trim() !== "" ? Number(crudo) : NaN;
  const plazoValido = Number.isFinite(minutos) && minutos >= 1 && minutos <= MINUTOS_PARA_RECOGER_MAX;
  const { minutos_para_recoger: _omitido, ...resto } = input;
  // Al crear, la hora de recogida COTIZADA gana: no cambia por el paso del tiempo entre cotizar y crear y, si el modelo la omite (o manda ""), el pedido igual la lleva.
  // `horaRecogida` del contexto es la hora normalizada al minuto ("2026-10-06T19:40"): solo se reutiliza si es una fecha valida.
  if (name === "crear_pedido" && ctx.flow) {
    const contexto = (await repo.readOrderFlow(ctx.organizationId, ctx.flow.key))?.context;
    const cotizada = contexto?.horaRecogida;
    // Si el cliente CAMBIO el plazo despues de cotizar ("mejor en 60") y el modelo crea sin re-cotizar, la hora nueva rompe la huella y se exige re-cotizar (como con una hora distinta).
    const plazoCambio = plazoValido && contexto?.minutosPlazo !== undefined && contexto.minutosPlazo !== Math.round(minutos);
    if (!plazoCambio && cotizada && !Number.isNaN(Date.parse(`${cotizada}:00.000Z`))) return { ...resto, hora_recogida: `${cotizada}:00.000Z` };
  }
  if (!plazoValido) return input;
  const ahora = ctx.flow?.now ? ctx.flow.now() : Date.now();
  // En cotizar se marca el plazo (campo interno, no lo manda el modelo) para que `runWithOrderFlow` reconozca una re-cotizacion identica con el mismo plazo.
  return { ...resto, hora_recogida: new Date(ahora + Math.round(minutos) * 60_000).toISOString(), ...(name === "cotizar_pedido" ? { plazo_minutos_servidor: Math.round(minutos) } : {}) };
}

function flowNow(flow: OrderFlowRef): number {
  return (flow.now ?? Date.now)();
}

async function readFlow(repo: RestaurantesRepository, ctx: AgentToolContext, flow: OrderFlowRef): Promise<OrderFlowSnapshot | null> {
  const snap = await repo.readOrderFlow(ctx.organizationId, flow.key);
  if (snap === null) warnOrderFlowUnavailable();
  return snap;
}

async function writeFlow(
  repo: RestaurantesRepository,
  ctx: AgentToolContext,
  flow: OrderFlowRef,
  expectedVersion: number,
  state: OrderFlowState,
  context: OrderFlowContext,
): Promise<"written" | "conflict" | "unavailable"> {
  const res = await repo.writeOrderFlow(ctx.organizationId, flow.key, expectedVersion, { state, context }, FLOW_ROW_TTL_SECONDS);
  if (res === "unavailable") warnOrderFlowUnavailable();
  return res;
}

const CONFLICT_MESSAGE = "La conversación se está procesando en otro lugar; vuelve a intentar en un momento.";

/** Texto que acompana a una re-cotizacion identica de una cotizacion que el cliente ya vio (ver `runWithOrderFlow`). */
const SIGUIENTE_PASO_COTIZACION_REPETIDA =
  "Esta cotización es idéntica a la de un mensaje anterior. Si el último mensaje del cliente es un sí claro (o el botón de confirmar) a un resumen que usted ya le mostró completo, llame confirmar_resumen y enseguida crear_pedido con estos mismos datos, SIN repetir el resumen. Si todavía no le ha mostrado el resumen completo o el cliente cambió algo, atiéndalo normalmente.";

const AVISO_DOBLE_GUACAMOLERA =
  "Ojo: doble_salsas lleva salsa_guacamolera (la doble porción de la SALSA, un extra de pocos pesos). Si el cliente pidió GUACAMOLE extra (para ponerle a los tacos), eso es el producto Extra Guacamole: búsquelo con buscar_producto, agréguelo como renglón, quite salsa_guacamolera de doble_salsas y vuelva a cotizar antes de decir el total. Si pidió doble de la salsa guacamolera, deje la cotización tal cual.";

const SIN_CORTESIAS_AVISO =
  "Esta cotización NO incluye ninguna cortesía, promoción ni descuento: no los prometa ni los mencione (ni \"van de cortesía\", ni \"incluyo\", ni \"gratis\"); el cliente paga exactamente el total. NUNCA agregue renglones ni suba la cantidad de una bebida para \"compensar\" una cortesía (QA-PM-R4-reglas-02: con media orden de nachos se cobraron 4 horchatas en vez de 2): las bebidas son exactamente las que pidió el cliente.";

/** Bebidas por nombre: solo decide si se agrega una frase aclaratoria, nunca un monto. */
const ES_BEBIDA_POR_NOMBRE = /horchata|jamaica|agua|refresco|coca|limonada|naranjada|sprite|fanta|mineral|jugo/i;
const MENSAJE_MEDIA_ORDEN_NACHOS =
  "Con MEDIA orden de nachos NO hay aguas de cortesía: las bebidas del carrito se cobran completas y el total ya las incluye. Si el cliente pregunta por las aguas gratis del martes, dígale solo: «las aguas de cortesía son únicamente con la orden completa de nachos; con la media orden las bebidas se cobran». No agregue bebidas ni cambie cantidades.";

const YA_REGISTRADO_AVISO =
  "Este pedido YA QUEDÓ REGISTRADO hace un momento: no es uno nuevo. No lo cotice de nuevo ni llame confirmar_resumen ni crear_pedido. Dígale al cliente, de usted y sin dudar, que su pedido ya está registrado (con el total y la hora que ya le dio). Solo si el cliente pide EXPRESAMENTE otro pedido igual, vuelva a llamar cotizar_pedido con otro_pedido: true.";

const PEDIDO_RETENIDO_AVISO =
  "Este pedido NO está registrado todavía: quedó pendiente de que la sucursal lo confirme (ya se le avisó y la sucursal contactará al cliente). Dígaselo así, de usted; NO diga que ya quedó registrado ni confirmado, no prometa hora, no lo cotice de nuevo ni llame confirmar_resumen ni crear_pedido.";

/** Aplica la maquina de estados alrededor de cotizar/confirmar/crear. Base sin migrar => camino anterior. */
async function runWithOrderFlow(repo: RestaurantesRepository, ctx: AgentToolContext, flow: OrderFlowRef, name: string, input: Record<string, unknown>): Promise<AgentToolOutcome> {
  const lenient = ctx.channel === "whatsapp";
  const canalOf = (raw: unknown) => (raw === "recoger" ? "recoger" : "domicilio");

  if (name === "repetir_pedido") {
    // Repetir = cotizar: la cotizacion con precios de hoy entra a la misma maquina de estados (quote_hash, confirmacion).
    const { cotizarInput, repeticion } = await prepararRepeticion(repo, ctx, input);
    const outcome = await runWithOrderFlow(repo, ctx, flow, "cotizar_pedido", cotizarInput);
    return { ...outcome, result: { ...(outcome.result as object), repeticion } };
  }

  if (name === "cotizar_pedido") {
    const outcome = await dispatchTool(repo, ctx, name, input);
    const quotedQuote = outcome.raw as OrderQuote & Partial<QuotePromotionInfo>;
    const quotedPrices = priceSignature(quotedQuote.lines);
    // La huella se calcula sobre los renglones RESUELTOS contra el catalogo (QA-PM-R3-whatsapp-01): un modelo que manda la tortilla de una bebida como "mixta" en un turno y
    // "maiz" en el siguiente, o el nombre en vez del id, ya no convierte en "nueva" una cotizacion que el cliente acaba de ver y de aceptar.
    const itemsCotizados = toRequestedItems(input.items, lenient);
    const quotedItems = resolverRenglonesCotizados(itemsCotizados, quotedQuote.lines);
    const huellaCotizacion = (hora: string | undefined): string =>
      fingerprintOrder({
        branchSlug: String(input.branch_slug ?? ""),
        canal: canalOf(input.canal),
        adultConfirmed: input.adult_confirmed === true,
        items: quotedItems ? itemsDeHuella(quotedItems) : itemsCotizados,
        doubleSalsas: toDoubleSalsas(input.doble_salsas),
        programadoPara: toProgramadoPara(input.programado_para),
        horaRecogida: hora,
      });
    const plazoServidor = typeof input.plazo_minutos_servidor === "number" ? input.plazo_minutos_servidor : undefined;
    let horaCotizacion = toHoraRecogida(input.hora_recogida);
    let quoteHash = huellaCotizacion(horaCotizacion);
    const cartHash = quotedItems ? huellaDeCarrito(String(input.branch_slug ?? ""), canalOf(input.canal), quotedItems) : undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      const snap = await readFlow(repo, ctx, flow);
      if (snap === null) return outcome; // base sin migrar: camino anterior
      // QA-PM-R3-whatsapp-02/03: un "si" de sobra (o el modelo que "refresca" la cotizacion) DESPUES de crear el pedido no abre otro: cotizar el MISMO carrito dentro de la
      // ventana devuelve el pedido ya registrado, sin pisar el estado "creado" (antes se reabria la confirmacion, el agente decia "no puedo confirmar que quedo registrado"
      // o, con otra hora de recogida, nacia un segundo pedido). Para un pedido nuevo igual el modelo manda `otro_pedido: true` solo si el cliente lo pidio.
      const creadoPrevio = snap.state === "creado" ? snap.context : null;
      if (
        creadoPrevio &&
        cartHash !== undefined &&
        creadoPrevio.cartHash === cartHash &&
        input.otro_pedido !== true &&
        flowNow(flow) - (creadoPrevio.claimedAtMs ?? creadoPrevio.quotedAtMs) <= MISMO_PEDIDO_VENTANA_MS
      ) {
        // "Ya quedo registrado" solo se dice de un pedido que EXISTE y sigue ACTIVO. Un pedido grande retenido (estado creado SIN orderId, o `por_aprobar`) esta pendiente de que la
        // sucursal lo confirme; uno cancelado / no recogido ya no cuenta y una cotizacion del mismo carrito es normal.
        const existente = creadoPrevio.orderId ? await repo.findOrderById(ctx.organizationId, creadoPrevio.orderId) : null;
        if (!creadoPrevio.orderId || existente?.status === "por_aprobar") {
          return { ...outcome, result: { ...(outcome.result as object), pedido_retenido: true, aviso: PEDIDO_RETENIDO_AVISO } };
        }
        if (existente && existente.status !== "cancelado" && existente.status !== "no_recogido") {
          return {
            ...outcome,
            result: { ...(outcome.result as object), ya_registrado: true, pedido_id: creadoPrevio.orderId, aviso: YA_REGISTRADO_AVISO },
          };
        }
      }
      // QA-PM-R2-whatsapp-01 (P0): el modelo vuelve a cotizar el MISMO carrito en el turno del "si" (para "refrescar" el resumen). Reescribir
      // `quotedTurn` con el turno actual hacia que confirmar_resumen rechazara `confirmacion_mismo_turno` y ningun pedido cerraba (0/36).
      // Una re-cotizacion identica (mismos renglones, mismos precios, mismo total) y todavia vigente CONSERVA la cotizacion y su turno: el
      // cliente ya vio ese resumen. Si algo cambio (carrito, precio, total, hora), si es una cotizacion nueva y el cliente debe volver a aceptar.
      const previo = snap.context;
      // `minutos_para_recoger`: la hora la calcula el servidor con SU reloj en cada llamada, asi que re-cotizar el mismo carrito un minuto despues daba otra hora, otra huella y una
      // "cotizacion nueva" (el bucle de cierre de R2/A45 volvia, tambien con el boton de confirmar). Si el carrito es el mismo y el plazo es el mismo, se conserva la hora cotizada.
      if (
        plazoServidor !== undefined &&
        previo?.horaRecogida &&
        previo.minutosPlazo === plazoServidor &&
        (snap.state === "cotizado" || snap.state === "confirmado") &&
        flowNow(flow) - previo.quotedAtMs <= QUOTE_TTL_MS &&
        huellaCotizacion(previo.horaRecogida) === previo.quoteHash
      ) {
        horaCotizacion = previo.horaRecogida;
        quoteHash = previo.quoteHash;
      }
      if (
        previo &&
        (snap.state === "cotizado" || snap.state === "confirmado") &&
        previo.quoteHash === quoteHash &&
        previo.quotedPrices === quotedPrices &&
        previo.quotedTotal === quotedQuote.total &&
        flowNow(flow) - previo.quotedAtMs <= QUOTE_TTL_MS
      ) {
        // El historial de WhatsApp no trae los resultados de herramientas: en el turno del "si" el modelo busca y cotiza de nuevo y despues repite el resumen
        // en vez de cerrar (R2W14: 4 turnos de resumen sin crear). Si esta cotizacion YA se mostro en un turno anterior, se le dice el siguiente paso.
        const yaMostrada = previo.quotedTurn !== null && flow.turn !== null && previo.quotedTurn !== flow.turn;
        const aviso = yaMostrada ? { ya_mostrada_al_cliente: true, siguiente_paso: SIGUIENTE_PASO_COTIZACION_REPETIDA } : {};
        return { ...outcome, result: { ...(outcome.result as object), quote_hash: quoteHash, ...aviso }, quoteHash };
      }
      const res = await writeFlow(repo, ctx, flow, snap.version, "cotizado", {
        quoteHash,
        quotedAtMs: flowNow(flow),
        quotedTurn: flow.turn,
        quotedPrices,
        ...(quotedItems ? { quotedItems, quotedBranchSlug: String(input.branch_slug ?? ""), quotedCanal: canalOf(input.canal), ...(cartHash ? { cartHash } : {}) } : {}),
        ...(horaCotizacion ? { horaRecogida: horaCotizacion } : {}),
        ...(horaCotizacion && plazoServidor !== undefined ? { minutosPlazo: plazoServidor } : {}),
        quotedTotal: quotedQuote.total,
        quotedAmounts: knownAmountsOfQuote(quotedQuote).slice(0, 60),
        ...(snap.context?.sessionTotal ? { sessionTotal: snap.context.sessionTotal, sessionPesoKg: snap.context.sessionPesoKg ?? 0, sessionPedidos: snap.context.sessionPedidos ?? 0, ...(snap.context.sessionUltimoPedidoId ? { sessionUltimoPedidoId: snap.context.sessionUltimoPedidoId } : {}) } : {}),
      });
      if (res === "written") return { ...outcome, result: { ...(outcome.result as object), quote_hash: quoteHash }, quoteHash };
      if (res === "unavailable") return outcome;
    }
    throw new OrderValidationError(CONFLICT_MESSAGE);
  }

  if (name === "confirmar_resumen") {
    for (let attempt = 0; attempt < 3; attempt++) {
      const snap = await readFlow(repo, ctx, flow);
      if (snap === null) return { result: { confirmado: true, aviso: "confirmación no registrada por el servidor todavía" }, orderId: null, propertyId: null };
      // El historial de WhatsApp no trae los resultados de las herramientas: el modelo no recuerda el hash y manda relleno ("N/A", "", "pendiente"), que rechazaba la confirmacion
      // ("no es el de la ultima cotizacion") y terminaba en falla_sistema con un si claro (R2W11, R2W21). Solo se compara un hash con forma de hash; el pedido que se crea sigue
      // atado a la cotizacion por su huella (assertCanCreate) y la confirmacion exige un turno distinto al de la cotizacion.
      const cited = typeof input.quote_hash === "string" && /^[0-9a-f]{32}$/i.test(input.quote_hash.trim()) ? input.quote_hash.trim().toLowerCase() : undefined;
      const current = assertCanConfirm(snap, { now: flowNow(flow), turn: flow.turn, quoteHashCited: cited });
      if (snap.state !== "cotizado") {
        return { result: { confirmado: true, quote_hash: current.quoteHash }, orderId: null, propertyId: null, quoteHash: current.quoteHash };
      }
      const res = await writeFlow(repo, ctx, flow, snap.version, "confirmado", { ...current, confirmedAtMs: flowNow(flow) });
      if (res === "written") return { result: { confirmado: true, quote_hash: current.quoteHash }, orderId: null, propertyId: null, quoteHash: current.quoteHash };
      if (res === "unavailable") return { result: { confirmado: true }, orderId: null, propertyId: null };
    }
    throw new OrderValidationError(CONFLICT_MESSAGE);
  }

  // crear_pedido: reclamo atomico (confirmado -> creando) ANTES de crear, para que dos llamadas
  // concurrentes no creen dos pedidos.
  const ajenosAlCotizar = async (cotizados: readonly QuotedItem[] | undefined): Promise<Set<string>> =>
    cotizados ? idsDeOtrosProductosReales(toRequestedItems(input.items, lenient), cotizados, async (id) => (await repo.findProduct(ctx.organizationId, id)) !== null) : new Set<string>();
  const huellaConHora = (horaRecogida: string | undefined, cotizados?: readonly QuotedItem[], ajenos?: ReadonlySet<string>): string =>
    fingerprintOrder({
      branchSlug: String(input.branch_slug ?? ""),
      canal: canalOf(input.canal),
      adultConfirmed: input.adult_confirmed === true,
      // Con renglones cotizados guardados, el modelo no tiene que repetir ids ni la tortilla de una bebida: se reconcilia contra la cotizacion (QA-PM-R3-whatsapp-07).
      items: (cotizados ? reconciliarConCotizacion(toRequestedItems(input.items, lenient), cotizados, ajenos) : null) ?? toRequestedItems(input.items, lenient),
      doubleSalsas: toDoubleSalsas(input.doble_salsas),
      programadoPara: toProgramadoPara(input.programado_para),
      horaRecogida,
    });
  let claimed: { version: number; context: OrderFlowContext } | null = null;
  for (let attempt = 0; attempt < 3 && !claimed; attempt++) {
    const snap = await readFlow(repo, ctx, flow);
    if (snap === null) return dispatchTool(repo, ctx, name, input); // base sin migrar: camino anterior
    // La hora de recogida solo cuenta si la cotizacion la llevaba (una hora que el modelo agrega al crear la valida el servidor, pero no cambia lo que el cliente vio);
    // si crear la omite se entiende la cotizada. Una hora DISTINTA a la cotizada obliga a re-cotizar.
    const horaCotizada = snap.context?.horaRecogida;
    const cotizados = snap.context?.quotedItems && snap.context.quotedItems.length > 0 ? snap.context.quotedItems : undefined;
    const fingerprint = huellaConHora(horaCotizada ? (toHoraRecogida(input.hora_recogida) ?? horaCotizada) : undefined, cotizados, await ajenosAlCotizar(cotizados));
    // Voz: un reintento del MISMO pedido ya creado (el worker corto la espera y el servidor si lo registro) devuelve el pedido
    // existente con su id, para que la llamada cuente el objetivo y el agente no le diga al cliente que fallo.
    if (ctx.channel === "voz" && snap.state === "creado" && snap.context?.orderId && snap.context.quoteHash === fingerprint) {
      const existente = await repo.findOrderById(ctx.organizationId, snap.context.orderId);
      if (existente) return { result: { order: orderToWire(existente), ya_registrado: true }, raw: existente, orderId: existente.id, propertyId: existente.propertyId, yaRegistrado: true };
    }
    const current = assertCanCreate(snap, { now: flowNow(flow), turn: flow.turn, fingerprint });
    const claimCtx: OrderFlowContext = { ...current, claimedAtMs: flowNow(flow) };
    const res = await writeFlow(repo, ctx, flow, snap.version, "creando", claimCtx);
    if (res === "written") claimed = { version: snap.version + 1, context: claimCtx };
    else if (res === "unavailable") return dispatchTool(repo, ctx, name, input);
  }
  if (!claimed) throw new OrderValidationError(CONFLICT_MESSAGE);

  try {
    // El pedido se crea con los renglones COTIZADOS (id y nombre del catalogo): si el modelo mando `product_id` vacio o un nombre aproximado, no se rechaza ni se reintenta (QA-PM-R3-whatsapp-07).
    const conciliados = claimed.context.quotedItems?.length ? reconciliarConCotizacion(toRequestedItems(input.items, lenient), claimed.context.quotedItems, await ajenosAlCotizar(claimed.context.quotedItems)) : null;
    const inputConciliado: Record<string, unknown> = conciliados
      ? { ...input, items: conciliados.map((i) => ({ product_id: i.productId, product_name: i.productName, requested_quantity: i.requestedQuantity, ...(i.tortilla ? { tortilla: i.tortilla } : {}) })) }
      : input;
    let outcome = await dispatchTool(repo, ctx, name, inputConciliado, claimed.context.quotedPrices, { total: claimed.context.sessionTotal ?? 0, pesoKg: claimed.context.sessionPesoKg ?? 0, pedidos: claimed.context.sessionPedidos ?? 0, ...(claimed.context.sessionUltimoPedidoId ? { ultimoPedidoId: claimed.context.sessionUltimoPedidoId } : {}) });
    // Un pedido IDENTICO al ultimo de esta sesion (misma ventana de deduplicacion de 5 min) devuelve ese mismo pedido: el agente debe saber que NO se creo otro (QA-PM-R2-reglas-15).
    const repetido = outcome.orderId !== null && outcome.orderId === claimed.context.sessionUltimoPedidoId;
    if (repetido) {
      outcome = {
        ...outcome,
        result: { ...(outcome.result as object), ya_registrado: true, aviso: "Este pedido idéntico ya estaba registrado hace unos minutos: NO se creó otro (en cocina hay uno solo). Dígaselo al cliente; si quiere dos, pase con una persona (escalar_a_humano)." },
        yaRegistrado: true,
      };
    }
    // Un pedido realmente creado suma a lo acumulado de la sesion (un pedido grande retenido o simulado no: no tiene orderId).
    const creado = outcome.orderId ? (outcome.raw as { total?: unknown; items?: readonly { name: string; quantity: number }[] } | undefined) : undefined;
    const acumulado = creado
      ? { sessionTotal: (claimed.context.sessionTotal ?? 0) + (repetido ? 0 : typeof creado.total === "number" ? creado.total : 0), sessionPesoKg: (claimed.context.sessionPesoKg ?? 0) + (repetido ? 0 : pesoTotalKg(creado.items ?? [])), sessionPedidos: (claimed.context.sessionPedidos ?? 0) + (repetido ? 0 : 1), sessionUltimoPedidoId: outcome.orderId ?? undefined }
      : {};
    await writeFlow(repo, ctx, flow, claimed.version, "creado", { ...claimed.context, ...acumulado, orderId: outcome.orderId ?? undefined });
    return outcome;
  } catch (err) {
    // Error de negocio (horario, zona, minimo...): vuelve a "confirmado" para poder corregir/reintentar.
    // Un error real de Postgres aborta la transaccion del request entera (no se puede escribir mas);
    // el rollback de la transaccion deshace tambien el reclamo.
    if (err instanceof OrderValidationError) {
      await writeFlow(repo, ctx, flow, claimed.version, "confirmado", { ...claimed.context, claimedAtMs: undefined });
    }
    throw err;
  }
}

/** `crear_pedido` en modo preview: corre EXACTAMENTE la misma validacion y cotizacion del pedido real
 * (`prepareCreateOrder` -> `validateCreateOrderPayload`, reglas de horario/zona/minimo/precios del catalogo) y devuelve el
 * pedido simulado con el total del servidor. NO llama a `createOrder`: no hay `upsertCustomer`, ni `createOrderIdempotent`
 * (que a su vez encolaria la comanda de SoftRestaurant), ni avisos al staff, ni correo, ni uso de promocion. */
async function simulatePreviewOrder(repo: RestaurantesRepository, ctx: AgentToolContext, createInput: CreateOrderInput, expectedPrices: string | undefined): Promise<AgentToolOutcome> {
  const prepared = await prepareCreateOrder(repo, createInput);
  if (expectedPrices && priceSignature(prepared.orderItems) !== expectedPrices) {
    throw new OrderFlowViolationError("precio_cambio", "Los precios del menú cambiaron después de que confirmaste. Vuelve a revisar tu pedido para ver el total actualizado.");
  }
  // Pedido grande (PM): el preview muestra lo mismo que haria el real (el pedido NO se crea), pero sin dejar el aviso para la sucursal.
  try {
    await assertNoEsPedidoGrande(repo, prepared);
  } catch (err) {
    if (!(err instanceof PedidoGrandeRetenidoError)) throw err;
    const retenido = { pedido_grande: true, escalado: true, estado: "por_confirmar_por_la_sucursal", simulado: true, mensaje: "Este pedido supera el umbral de pedido grande: en el servicio real NO se mandaría a cocina y se avisaría a la sucursal para confirmarlo (en el preview no se crea ningún aviso)." };
    return { result: retenido, raw: retenido, orderId: null, propertyId: null };
  }
  const folio = `${FOLIO_PREVIEW_PREFIJO}${createHash("sha256")
    .update(JSON.stringify([prepared.payload.customerPhone, prepared.branch.propertyId, prepared.orderItems.map((i) => [i.id, i.quantity]), prepared.total]))
    .digest("hex")
    .slice(0, 4)
    .toUpperCase()}`;
  const simulated = {
    id: folio,
    branch: prepared.branch.name,
    total: prepared.total,
    status: "simulado",
    payment_method: prepared.payload.paymentMethod ?? null,
    items: prepared.orderItems,
    simulado: true,
  };
  return { result: { order: simulated }, raw: simulated, orderId: null, propertyId: null, simulated: true };
}

async function dispatchTool(
  repo: RestaurantesRepository,
  ctx: AgentToolContext,
  name: string,
  input: Record<string, unknown>,
  /** Huella de precios que el cliente confirmo (solo crear_pedido con maquina de estados activa). */
  expectedPrices?: string,
  /** Total y kilos de los pedidos ya creados en esta sesion (solo crear_pedido con maquina de estados activa): la guardia de pedido grande los suma. */
  sesionPrevia?: { readonly total: number; readonly pesoKg: number; readonly pedidos: number; readonly ultimoPedidoId?: string },
): Promise<AgentToolOutcome> {
  const def = AGENT_TOOL_DEFINITIONS.find((t) => t.name === name);
  if (!def || !def.channels.includes(ctx.channel)) throw new OrderValidationError(`Herramienta desconocida: ${name}`);
  const lenient = ctx.channel === "whatsapp";
  const { organizationId } = ctx;

  switch (def.name) {
    case "buscar_cliente": {
      if (ctx.modo === "preview") {
        // Preview: un telefono ficticio nunca tiene historial. El panel puede pedir «simular cliente conocido» con un
        // cliente de SU organizacion; se resuelve por id (null si es de otra organizacion => cliente nuevo).
        const known = ctx.previewCustomerId ? await getCustomerDetailById(repo, organizationId, ctx.previewCustomerId) : null;
        const result = known ?? { isNew: true as const };
        return { result, raw: result, orderId: null, propertyId: null, simulated: true };
      }
      if (!ctx.phone) throw new OrderValidationError("No se conoce el teléfono de esta conversación; no se puede consultar el historial.");
      if (ctx.phoneDeclared) {
        const nuevo = { isNew: true as const };
        return { result: nuevo, raw: nuevo, orderId: null, propertyId: null };
      }
      const result = await lookupCustomerConPedidoReciente(repo, organizationId, ctx.phone);
      return { result, raw: result, orderId: null, propertyId: null };
    }
    case "historial_pedidos": {
      if (!ctx.phone) throw new OrderValidationError("No se conoce el teléfono de esta conversación; no se puede consultar el historial.");
      if (ctx.phoneDeclared) {
        const vacio = { pedidos: [], total_pedidos_anteriores: 0 };
        return { result: vacio, raw: vacio, orderId: null, propertyId: null };
      }
      const memoria = await cargarMemoria(repo, organizationId, normalizePhone(ctx.phone));
      if (memoria === undefined) throw new OrderValidationError("El historial de pedidos todavía no está disponible: tome el pedido de forma normal.");
      const pedidos = (memoria?.orders ?? []).slice(0, 5).map((o) => ({
        numero: o.orderNumber,
        fecha: o.createdAt,
        canal: o.canal,
        sucursal: o.branch,
        total: o.total,
        productos: fusionarRenglonesPorProducto(o.items).map((i) => ({ name: i.name, quantity: i.quantity })),
      }));
      const result = { pedidos, total_pedidos_anteriores: pedidos.length };
      return { result, raw: result, orderId: null, propertyId: null };
    }
    case "repetir_pedido": {
      const { cotizarInput, repeticion } = await prepararRepeticion(repo, ctx, input);
      const quoted = await dispatchTool(repo, ctx, "cotizar_pedido", cotizarInput);
      return { ...quoted, result: { ...(quoted.result as object), repeticion } };
    }
    case "consultar_sucursal": {
      const branchSlug = String(input.branch_slug ?? "");
      await assertBranchAllowed(repo, ctx, branchSlug);
      const branch = await repo.findBranch(organizationId, { slug: branchSlug });
      if (!branch || branch.status !== "active") throw new OrderValidationError(`Sucursal '${branchSlug}' no encontrada o inactiva`);
      const policy = await repo.findBranchPolicy(branch.propertyId);
      let abierto: boolean | null = null;
      let cierraA: string | null = null;
      const zonaCruda = (await repo.findBranchZonaHoraria(branch.propertyId)).zonaHoraria;
      const ahora = new Date();
      if (policy.horario && policy.horario.length > 0) {
        const estado = estaAbiertoAhora(policy.horario, ahora, zonaCruda);
        abierto = estado.abierto;
        cierraA = estado.cierraA;
      }
      // Reloj LOCAL de la sucursal: el modelo (sobre todo el de voz, que no trae la hora en su prompt) calculaba "en 40 minutos" con la hora UTC y guardaba
      // la recogida 6 h tarde, o "hoy" dos dias atras (QA-PM-R2-voz-03 / reglas-04). Con esto calcula sobre la hora de la sucursal.
      const zona = resolverZonaHorariaNegocio(zonaCruda);
      const parte = (opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("es-MX", { timeZone: zona, hourCycle: "h23", ...opts }).format(ahora);
      const result = {
        hora_local: parte({ hour: "2-digit", minute: "2-digit" }),
        fecha_local: fechaLocal(ahora, zona),
        dia_semana: parte({ weekday: "long" }),
        zona_horaria: zona,
        utc_offset: parte({ timeZoneName: "longOffset" }).replace(/^.*GMT/, "GMT"),
        branch_slug: branch.slug,
        branch_name: branch.name,
        direccion: branch.address,
        telefono: branch.phone,
        abierto_ahora: abierto,
        cierra_a: cierraA,
        horario: policy.horario,
        pedido_minimo_domicilio: policy.pedidoMinimoDomicilio,
        pedido_minimo_recoger: policy.pedidoMinimoRecoger,
      };
      return { result, raw: result, orderId: null, propertyId: null };
    }
    case "buscar_sucursal_cercana": {
      // El modelo manda relleno cuando solo tiene la colonia (lat 0, lng 0, max_km 0): (0,0) no es un pin (caia a 9,967 km y la zona salia "fuera de zona", R2W36) y un
      // max_km no positivo no es un radio (34 errores por medida). Se ignoran como si no vinieran.
      const coordenadasValidas = typeof input.lat === "number" && typeof input.lng === "number" && Number.isFinite(input.lat) && Number.isFinite(input.lng) && !(input.lat === 0 && input.lng === 0);
      let lat = coordenadasValidas ? (input.lat as number) : undefined;
      let lng = coordenadasValidas ? (input.lng as number) : undefined;
      // Ubicacion compartida por WhatsApp: se usa solo si el modelo no mando coordenadas ni una colonia
      // explicita (una colonia dicha por el cliente despues de compartir manda).
      const coloniaDicha = typeof input.colonia === "string" && input.colonia.trim() !== "";
      if (lat === undefined && lng === undefined && !coloniaDicha && ctx.sharedLocation) {
        lat = ctx.sharedLocation.lat;
        lng = ctx.sharedLocation.lng;
      }
      // El radio de reparto lo fija el SERVIDOR (QA-PM-R2-whatsapp-08): 8 km en el perfil `taqueria_pm`, sin tope duro en los demas, o el que la organizacion configure; el modelo solo puede bajarlo.
      const configAgente = await repo.findWhatsAppAgentConfig(organizationId, null);
      const perfilAgente = configAgente?.perfil ?? "generico";
      // Pines de Google de las sucursales (opt-in, APAGADO por omision: activarlo es decision de Javier; ver coordenadas-sucursales.ts).
      const usarPropuestas = ctx.usarCoordenadasPropuestas ?? coordenadasPropuestasActivas();
      const match = await assignBranch(repo, {
        organizationId,
        radioMaximoKm: radioRepartoDelPerfil(perfilAgente, configAgente?.radioRepartoKm),
        ...(usarPropuestas ? { coordenadasPropuestas: COORDENADAS_PROPUESTAS_PM } : {}),
        ...(perfilAgente === "taqueria_pm" ? { sucursalesQueNoReparten: SUCURSALES_QUE_NO_REPARTEN_PM } : {}),
        ...(ctx.entryPropertyId ? { sucursalDeEntregaPreferidaPropertyId: ctx.entryPropertyId } : {}),
        colonia: typeof input.colonia === "string" ? input.colonia : undefined,
        ...(lat !== undefined || lng !== undefined ? { lat, lng } : {}),
        ...(typeof input.max_km === "number" && Number.isFinite(input.max_km) && input.max_km > 0 ? { maxKm: input.max_km } : {}),
      });
      const result =
        match.estado === "asignada"
          ? {
              encontrada: true,
              estado: match.estado,
              branch_slug: match.branchSlug,
              branch_name: match.branchName,
              distancia_km: match.distanceKm,
              ...(match.distanceKm === null && match.kmReferencia !== null ? { distancia_aprox_km: match.kmReferencia } : {}),
              distancia_texto: match.distanceKm !== null ? kmAproxTexto(match.distanceKm) : match.kmReferencia !== null ? kmAproxTexto(match.kmReferencia) : null,
              colonia_reconocida: match.recognizedZoneName,
              via: match.via,
              origen_asignacion: match.origen,
              ajuste_por_zona: match.ajustePorZona,
              doble_cobertura: match.dobleCobertura,
              ...(match.aproximada ? { medicion_aproximada: true } : {}),
              ...(match.alternativa ? { alternativa: { branch_slug: match.alternativa.slug, branch_name: match.alternativa.nombre, distancia_texto: match.alternativa.kmAprox === null ? null : kmAproxTexto(match.alternativa.kmAprox) } } : {}),
              mensaje: match.message,
            }
          : match.estado === "fuera_de_zona"
            ? {
                encontrada: false,
                estado: match.estado,
                reparto: "fuera_de_zona_habitual",
                mensaje: match.message,
                colonia_reconocida: match.recognizedZoneName,
                // Sin medicion confiable (alguna sucursal de despacho sin coordenada) no se nombra una «mas cercana» ni se dice una distancia.
                ...(match.medicionConfiable
                  ? {
                      branch_slug_mas_cercana: match.branchSlug,
                      sucursal_despacho_mas_cercana: { branch_slug: match.branchSlug, branch_name: match.branchName, distancia_km: match.distanceKm, distancia_texto: kmAproxTexto(match.distanceKm) },
                    }
                  : { medicion_aproximada: true }),
                // Km a la sucursal medible mas cercana (contrato historico de la herramienta); sin medicion confiable NO se nombra ni se le llama «mas cercana».
                distancia_km: match.distanceKm,
                max_km: match.maxKm,
              }
            : match.estado === "sugerida"
              ? {
                  encontrada: false,
                  estado: match.estado,
                  reparto: match.reparto,
                  colonia_reconocida: match.recognizedZoneName,
                  // Solo para ofrecer recoger: sin distancia (la referencia del piloto de una colonia pendiente puede estar equivocada).
                  sucursal_sugerida: match.sugerida ? { branch_slug: match.sugerida.slug, branch_name: match.sugerida.nombre } : null,
                  segunda_opcion: match.segunda ? { branch_slug: match.segunda.slug, branch_name: match.segunda.nombre } : null,
                  ambigua: match.ambigua,
                  ubicacion_recibida: match.conUbicacion,
                  mensaje: match.message,
                }
              : { encontrada: false, estado: match.estado, mensaje: match.message };
      return { result, raw: result, orderId: null, propertyId: null };
    }
    case "buscar_producto": {
      const branchSlug = String(input.branch_slug ?? "");
      await assertBranchAllowed(repo, ctx, branchSlug);
      const branch = await repo.findBranch(organizationId, { slug: branchSlug });
      if (!branch) throw new OrderValidationError(`Sucursal '${branchSlug}' no encontrada`);
      const productos = await searchProducts(repo, { propertyId: branch.propertyId, query: String(input.query ?? "") });
      const result = productos.map((p) => ({ id: p.id, name: p.name, price: p.price, pack_size: p.packSize, requires_adult_confirmation: p.requiresAdultConfirmation, ...(p.ambiguo === true ? { ambiguo: true } : {}) }));
      return { result, raw: result, orderId: null, propertyId: null };
    }
    case "cotizar_pedido": {
      const branchSlug = String(input.branch_slug ?? "");
      await assertBranchAllowed(repo, ctx, branchSlug);
      await assertRecogerEnSucursalDeEntrada(repo, ctx, branchSlug, input.canal);
      const quote = await quoteOrder(repo, {
        organizationId,
        branchSlug,
        items: toRequestedItems(input.items, lenient),
        adultConfirmed: input.adult_confirmed === true,
        canal: toCanal(input.canal),
        colonia: typeof input.colonia_entrega === "string" ? input.colonia_entrega : undefined,
        source: ctx.channel === "voz" ? "voice" : "whatsapp",
        ...(ctx.sharedLocation && ctx.channel === "whatsapp" ? { ubicacion: { lat: ctx.sharedLocation.lat, lng: ctx.sharedLocation.lng } } : {}),
        paymentMethod: input.payment_method === "efectivo" || input.payment_method === "tarjeta" ? input.payment_method : undefined,
        doubleSalsas: toDoubleSalsas(input.doble_salsas),
        programadoPara: toProgramadoPara(input.programado_para),
        promoCode: await compensacionPendiente(repo, ctx),
        horaRecogida: textoOpcional(input.hora_recogida),
      }).catch((err: unknown) => {
        throw err instanceof RestaurantesConfigUnavailableError ? new OrderValidationError(PROGRAMADOS_NO_DISPONIBLES) : err;
      });
      // T7-044: el platillo Guacamole ($142) no se cambia en silencio por Extra Guacamole ($49).
      const aclaracionGuacamole = aclararGuacamoleExtra(quote.lines.map((l) => l.name), ctx.mensajesDelCliente);
      if (aclaracionGuacamole) throw new OrderValidationError(aclaracionGuacamole);
      // QA-PM-R3-voz-03: "guacamole extra" se cobraba como la doble salsa guacamolera ($19) y no como Extra Guacamole ($49). El servidor no puede saber que dijo el
      // cliente, pero si el modelo uso la doble salsa guacamolera se lo hace revisar antes de decir el total.
      const dobleGuacamole = (toDoubleSalsas(input.doble_salsas) ?? []).includes("salsa_guacamolera");
      // QA-PM-R3-reglas-03: por voz el agente prometia las 2 aguas de cortesia del combo del martes con MEDIA orden de nachos aunque el servidor cobraba las bebidas. Si la
      // cotizacion no aplica ni sugiere ninguna promocion, se lo dice la propia herramienta (el cliente solo debe oir lo que el total incluye).
      const sinPromocion = !quote.promocionAplicada && (quote.promocionesSugeridas?.length ?? 0) === 0;
      // QA-PM-R4-reglas-02 (P0): con MEDIA orden de nachos el modelo de voz prometia "las 2 aguas de cortesia" y cotizaba 4 horchatas (+$120). La explicacion va como frase LITERAL de la herramienta.
      const mediaOrdenConBebida = sinPromocion && quote.lines.some((l) => /nachos/i.test(l.name) && /\(1\/2 orden\)/.test(l.name)) && quote.lines.some((l) => ES_BEBIDA_POR_NOMBRE.test(l.name));
      return {
        result: {
          quote: quoteToWire(quote),
          ...(sinPromocion ? { sin_cortesias: SIN_CORTESIAS_AVISO } : {}),
          ...(mediaOrdenConBebida ? { mensaje_media_orden_nachos: MENSAJE_MEDIA_ORDEN_NACHOS } : {}),
          ...(dobleGuacamole ? { aviso_guacamole: AVISO_DOBLE_GUACAMOLERA } : {}),
        },
        raw: quote,
        orderId: null,
        propertyId: null,
      };
    }
    case "confirmar_resumen": {
      // Sin maquina de estados activa (camino legado): no hay nada que registrar.
      return { result: { confirmado: true, aviso: "confirmación no registrada por el servidor" }, orderId: null, propertyId: null };
    }
    case "crear_pedido": {
      const mappedBase = mapCreateOrderToolInput(ctx, input, lenient);
      // Las basicas (comanda con «Básicas»/«Pedidas») son del perfil `taqueria_pm`, no de todo agente: con otro perfil o sin configuracion
      // (base sin migrar) se conservan las 9 incluidas de siempre.
      let mapped = mappedBase;
      if (mappedBase.basicComplements) {
        const config = await repo.findWhatsAppAgentConfig(ctx.organizationId, ctx.entryPropertyId ?? ctx.lockedPropertyId ?? null);
        if (config?.perfil !== "taqueria_pm") mapped = { ...mappedBase, basicComplements: undefined };
      }
      // QA R2 features-07: el codigo de compensacion emitido a ESTE telefono se aplica solo (el modelo no lo dicta; ver `compensacionPendiente`).
      if (!mapped.promoCode) {
        const compensacion = await compensacionPendiente(repo, ctx);
        if (compensacion) mapped = { ...mapped, promoCode: compensacion };
      }
      const createInput = mapped;
      // La sucursal puede venir por slug o por nombre (contrato historico del checkout de voz).
      if (createInput.branchSlug || createInput.branchName) {
        await assertBranchAllowed(repo, ctx, createInput.branchSlug ?? "", createInput.branchName);
        if (createInput.branchSlug) await assertRecogerEnSucursalDeEntrada(repo, ctx, createInput.branchSlug, createInput.canal);
      } else if (ctx.lockedPropertyId) {
        throw new OrderValidationError("Esta llamada está fijada a una sucursal; indica branch_slug.");
      }
      if (ctx.modo === "preview") return simulatePreviewOrder(repo, ctx, createInput, expectedPrices);
      const retenido = await retenerPedidoDeReincidente(repo, ctx, createInput);
      if (retenido) return retenido;
      let order: Order;
      // Pedido grande con autopiloto disponible: se crea y se deja `por_aprobar` (ver `retener` abajo); si no, se lanza el aviso de siempre.
      const grandeAprobable: { error: PedidoGrandeRetenidoError | null } = { error: null };
      const idsEnMemoria = new Set<string>();
      // El ultimo pedido de la sesion puede NO estar en la memoria (la memoria excluye `programado`) y aun asi `create_order_idempotent` lo deduplica ("otro igual"
      // en < 5 min): se marca como ya aceptado para que `retener` no lo pase de `programado` a `por_aprobar`.
      if (sesionPrevia?.ultimoPedidoId) idsEnMemoria.add(sesionPrevia.ultimoPedidoId);
      try {
        order = await createOrder(repo, createInput, {
          beforePersist: async (prepared) => {
            // El precio lo fija SIEMPRE el catalogo vigente, pero el cliente solo acepto los precios que vio: si
            // cambiaron entre confirmar y crear, se pide re-cotizar en vez de cobrar un total distinto.
            if (expectedPrices && priceSignature(prepared.orderItems) !== expectedPrices) {
              throw new OrderFlowViolationError("precio_cambio", "Los precios del menú cambiaron después de que confirmaste. Vuelve a revisar tu pedido para ver el total actualizado.");
            }
            // Pedido grande (decision de PM, 2-oct): lo hace cumplir el SERVIDOR aunque el modelo olvide escalar.
            const grande = await evaluarPedidoGrandeDelPedido(repo, prepared, idsEnMemoria, sesionPrevia);
            if (!grande) return;
            if (ctx.pedidoGrande && (await ctx.pedidoGrande.disponible(prepared.payload.organizationId, prepared.branch.propertyId))) grandeAprobable.error = grande;
            else throw grande;
          },
          retener: async (creado, prepared) => {
            const g = grandeAprobable.error;
            if (!g || !ctx.pedidoGrande) return false;
            // `create_order_idempotent` deduplica ("otro igual" en menos de 5 min): devuelve el pedido YA existente, que ya estaba aceptado (y su comanda
            // puede ir al POS). Ese NO se retiene: el acumulado que disparo la regla lo incluia a el mismo. Se devuelve tal cual, como cualquier reintento.
            if (idsEnMemoria.has(creado.id)) {
              grandeAprobable.error = null;
              return false;
            }
            const r = await ctx.pedidoGrande.retener({
              organizationId: prepared.payload.organizationId,
              orderId: creado.id,
              // Solo codigos y cifras (la solicitud se lee en el panel; sin nombres ni telefonos).
              detalle: { motivo: g.motivo, total: g.total, peso_kg: g.pesoKg, canal: prepared.payload.canal ?? "domicilio", pago: prepared.payload.paymentMethod ?? null },
            });
            // Si la retencion no quedo registrada se lanza: el SAVEPOINT de la herramienta revierte tambien el pedido (nunca queda uno `pending` rumbo a cocina).
            if (r.estado !== "por_aprobar") throw new Error("pedido grande: no se pudo dejar por aprobar; se revierte el pedido");
            return true;
          },
        });
      } catch (err) {
        if (err instanceof PedidoGrandeRetenidoError) return retenerPedidoGrande(repo, ctx, createInput, err);
        // R-11: contra una base sin la migracion 034 el agente recibe un mensaje de negocio, no un error interno.
        if (err instanceof RestaurantesConfigUnavailableError && createInput.programadoPara) {
          throw new OrderValidationError(PROGRAMADOS_NO_DISPONIBLES);
        }
        throw err;
      }
      if (grandeAprobable.error) {
        // D31 (QA-PM-R5-voz-19): un pedido grande SIEMPRE pasa por la sucursal. Con el autopiloto el pedido queda `por_aprobar` y la solicitud llega al panel, pero en voz no
        // quedaba ningun aviso (callback) para la persona de la sucursal; en WhatsApp lo hacia el aviso `escalada:pedido_grande`. Se registra en el SERVIDOR, en el mismo SAVEPOINT
        // que el pedido: si el aviso no se puede dejar, se revierte tambien el pedido (nunca queda un pedido grande retenido sin que nadie en la sucursal lo sepa).
        await avisarPedidoGrandeASucursal(repo, ctx, createInput, grandeAprobable.error, order.propertyId, order.orderNumber ? `Pedido #${order.orderNumber} creado en estado por_aprobar; ` : "Pedido creado en estado por_aprobar; ");
        const result = {
          pedido_grande: true,
          por_aprobar: true,
          estado: "por_aprobar",
          order: orderToWire(order),
          mensaje:
            "Este pedido supera el umbral de pedido grande: está PENDIENTE de confirmación y NO se mandó a cocina todavía. La sucursal lo confirma con un clic y, cuando lo haga, el cliente recibe un WhatsApp. Diga SOLO el mensaje_al_cliente; no diga que quedó registrado, confirmado ni en preparación, no prometa hora y no vuelva a llamar crear_pedido.",
          mensaje_al_cliente: MENSAJE_PEDIDO_GRANDE_PENDIENTE,
        };
        return { result, raw: order, orderId: order.id, propertyId: order.propertyId, pedidoRetenido: true };
      }
      return { result: { order: orderToWire(order) }, raw: order, orderId: order.id, propertyId: order.propertyId };
    }
    case "registrar_contacto":
    case "escalar_a_humano": {
      // Preview: exito simulado, sin crear aviso (callback) ni notificacion para el equipo.
      if (ctx.modo === "preview") {
        // Los motivos con mensaje fijo lo devuelven tambien simulados, para que el dueño vea lo que diria el agente real.
        const fijo = def.name === "registrar_contacto" ? (input.reason === "cliente_llego" ? MENSAJE_LLEGADA_REGISTRADA : input.reason === "pedido_telefonico" ? MENSAJE_PEDIDO_TELEFONICO_REGISTRADO : null) : null;
        const simulado = { ok: true, simulado: true, ...(fijo ? { mensaje_al_cliente: fijo } : {}) };
        return { result: simulado, raw: simulado, orderId: null, propertyId: null, simulated: true };
      }
      if (!ctx.phone) throw new OrderValidationError("No se conoce el teléfono de esta conversación; no se puede dejar aviso.");
      const esEscalada = def.name === "escalar_a_humano";
      if (!esEscalada && input.reason === "cliente_llego") return avisarLlegadaDelCliente(repo, ctx, input);
      if (!esEscalada && input.reason === "pedido_telefonico") return pasarNotaDePedidoTelefonico(repo, ctx, input);
      const reason = esEscalada ? `escalada:${normalizarMotivoEscalacion(input.motivo)}` : typeof input.reason === "string" ? input.reason : undefined;
      await registerCallbackRequest(repo, {
        organizationId,
        propertyId: ctx.lockedPropertyId ?? ctx.entryPropertyId ?? null,
        customerName: textoOpcional(input.customer_name)?.trim() || "Cliente", // "" (el modelo no sabe el nombre) -> "Cliente": antes lanzaba y el cliente leia "Error interno"
        customerPhone: ctx.phone,
        reason,
        sourceEventId: ctx.sourceEventId ? `${ctx.sourceEventId}:${reason ?? ""}`.slice(0, 255) : null,
        message: esEscalada ? (typeof input.resumen === "string" ? input.resumen : undefined) : typeof input.message === "string" ? input.message : undefined,
        source: ctx.channel === "voz" ? "voice" : "whatsapp",
      });
      return { result: { ok: true }, raw: { ok: true }, orderId: null, propertyId: null };
    }
  }
}

/** Texto fijo que se le da al cliente tras el aviso de llegada (no se improvisa ni se prometen minutos). */
export const MENSAJE_LLEGADA_REGISTRADA = "Ya avisé a la sucursal que usted llegó; en un momento le entregan su pedido.";
const MENSAJE_LLEGADA_SIN_PEDIDO = "No encuentro un pedido para recoger a nombre de este número. No avise a la sucursal; pregúntele por su pedido o escale si insiste (otro).";

export const MENSAJE_PEDIDO_TELEFONICO_REGISTRADO = "Listo, ya le pasé ese dato a la sucursal para su pedido.";

/** `registrar_contacto` con `reason: pedido_telefonico`: el pedido NO se creo aqui (lo tomo la sucursal por telefono); solo se le pasa a la sucursal la nota y el
 * pin/link de Maps que el cliente mando por WhatsApp. No crea pedido ni toca el catalogo. */
async function pasarNotaDePedidoTelefonico(repo: RestaurantesRepository, ctx: AgentToolContext, input: Record<string, unknown>): Promise<AgentToolOutcome> {
  const nota = typeof input.message === "string" ? sanitizeInlineText(input.message, 300) : "";
  const pin = ctx.ubicacionEntrega ? formatUbicacionEntregaNota(ctx.ubicacionEntrega) : "";
  const mensaje = [nota, pin].filter(Boolean).join(" | ");
  if (!mensaje) {
    return { result: { ok: false, instruccion: "No hay nada que pasar: pida al cliente la nota o su ubicación (pin de WhatsApp o link de Maps)." }, raw: { ok: false }, orderId: null, propertyId: null };
  }
  await registerCallbackRequest(repo, {
    organizationId: ctx.organizationId,
    propertyId: ctx.lockedPropertyId ?? ctx.entryPropertyId ?? null,
    customerName: String(input.customer_name ?? "Cliente"),
    customerPhone: ctx.phone as string,
    reason: "pedido_telefonico",
    sourceEventId: ctx.sourceEventId ? `${ctx.sourceEventId}:pedido_telefonico`.slice(0, 255) : null,
    message: mensaje,
    source: ctx.channel === "voz" ? "voice" : "whatsapp",
  });
  return { result: { ok: true, mensaje_al_cliente: MENSAJE_PEDIDO_TELEFONICO_REGISTRADO }, raw: { ok: true }, orderId: null, propertyId: null };
}

/** `registrar_contacto` con `reason: cliente_llego`: solo procede si el cliente tiene un pedido vigente para RECOGER confirmado hace poco (la llegada
 * se valida contra el pedido real, nunca contra lo que diga el modelo). Deja el aviso con la sucursal del pedido y una nota de como identificarlo. */
async function avisarLlegadaDelCliente(repo: RestaurantesRepository, ctx: AgentToolContext, input: Record<string, unknown>): Promise<AgentToolOutcome> {
  const encontrado = await buscarPedidoRecienteConSucursal(repo, ctx.organizationId, ctx.phone as string);
  const reciente = encontrado?.reciente;
  // Solo con un pedido CONOCIDO para recoger y aun vigente: canal desconocido (base sin migrar o sin dato) o un estado cerrado/con problema no se avisa como llegada.
  if (!reciente || reciente.canal !== "recoger" || (reciente.estado !== "preparando" && reciente.estado !== "listo_para_recoger" && reciente.estado !== "programado")) {
    return { result: { ok: false, motivo: "sin_pedido_para_recoger", instruccion: MENSAJE_LLEGADA_SIN_PEDIDO }, raw: { ok: false }, orderId: null, propertyId: null };
  }
  const identificacion = typeof input.message === "string" ? sanitizeInlineText(input.message, 200) : "";
  await registerCallbackRequest(repo, {
    organizationId: ctx.organizationId,
    propertyId: encontrado?.propertyId ?? ctx.lockedPropertyId ?? ctx.entryPropertyId ?? null,
    customerName: String(input.customer_name ?? "Cliente"),
    customerPhone: ctx.phone as string,
    reason: "cliente_llego",
    sourceEventId: ctx.sourceEventId ? `${ctx.sourceEventId}:cliente_llego`.slice(0, 255) : null,
    message: identificacion || undefined,
    source: ctx.channel === "voz" ? "voice" : "whatsapp",
  });
  return { result: { ok: true, mensaje_al_cliente: MENSAJE_LLEGADA_REGISTRADA }, raw: { ok: true }, orderId: null, propertyId: null };
}

/** Arma la entrada de `cotizar_pedido` a partir de un pedido anterior del MISMO cliente (el telefono sale del contexto). */
async function prepararRepeticion(repo: RestaurantesRepository, ctx: AgentToolContext, input: Record<string, unknown>) {
  if (!ctx.phone) throw new OrderValidationError("No se conoce el teléfono de esta conversación; no se puede repetir un pedido.");
  if (ctx.phoneDeclared) throw new OrderValidationError("No hay pedidos anteriores que repetir en esta llamada: tome el pedido de forma normal.");
  const branchSlug = String(input.branch_slug ?? "");
  await assertBranchAllowed(repo, ctx, branchSlug);
  const memoria = await cargarMemoria(repo, ctx.organizationId, normalizePhone(ctx.phone));
  if (memoria === undefined) throw new OrderValidationError("El historial de pedidos todavía no está disponible: tome el pedido de forma normal.");
  const numero = typeof input.pedido_numero === "number" && Number.isInteger(input.pedido_numero) ? input.pedido_numero : undefined;
  const pedido = elegirPedido(memoria?.orders ?? [], numero);
  const repetido = await repetirPedido(repo, { organizationId: ctx.organizationId, branchSlug, order: pedido });
  const canal = input.canal === "domicilio" || input.canal === "recoger" ? input.canal : (pedido.canal ?? "domicilio");
  const cotizarInput: Record<string, unknown> = {
    branch_slug: branchSlug,
    canal,
    items: repetido.renglones.map((r) => ({ product_id: r.productId, product_name: r.productName, requested_quantity: r.requestedQuantity, ...(r.tortilla ? { tortilla: r.tortilla } : {}) })),
    ...(input.adult_confirmed === true ? { adult_confirmed: true } : {}),
    ...(typeof input.colonia_entrega === "string" ? { colonia_entrega: input.colonia_entrega } : {}),
    ...(input.payment_method === "efectivo" || input.payment_method === "tarjeta" ? { payment_method: input.payment_method } : {}),
  };
  const repeticion = {
    pedido_numero: repetido.pedido.numero,
    fecha: repetido.pedido.fecha,
    sucursal_anterior: repetido.pedido.sucursal,
    total_anterior: repetido.totalAnterior,
    cambios: repetido.cambios.map((c) => ({ producto: c.producto, motivo: c.motivo, precio_anterior: c.precioAnterior, precio_actual: c.precioActual })),
    aviso:
      repetido.cambios.length > 0
        ? "Avise al cliente de estos cambios (productos que ya no están o que cambiaron de precio) ANTES de confirmar; el total que vale es el de la cotización de hoy, no el de la vez pasada."
        : "Sin cambios: mismos productos disponibles. El total que vale es el de la cotización de hoy.",
  };
  return { cotizarInput, repeticion };
}

/**
 * Reincidentes de "no recogido" / pedido falso: con el umbral de la politica (por omision 2 en 90 dias; 0 = apagada) el
 * pedido NO se crea solo: queda un aviso con TODO el pedido para que la sucursal lo confirme con el cliente. El agente nunca
 * acusa: solo dice que la sucursal confirma el pedido en un momento. Solo agentes (WhatsApp y voz) con telefono conocido.
 */
async function retenerPedidoDeReincidente(repo: RestaurantesRepository, ctx: AgentToolContext, createInput: CreateOrderInput): Promise<AgentToolOutcome | null> {
  if ((ctx.channel !== "whatsapp" && ctx.channel !== "voz") || !ctx.phone) return null;
  const memoria = await cargarMemoria(repo, ctx.organizationId, normalizePhone(ctx.phone));
  const decision = evaluarReincidencia(memoria?.reliability);
  if (!decision.requiereConfirmacion) return null;
  // Misma validacion y cotizacion que un pedido real (horario, zona, minimo, productos): un error de negocio se devuelve igual.
  const prepared = await prepareCreateOrder(repo, createInput);
  const lineas = prepared.orderItems.map((i) => `${i.quantity}x ${i.name}`).join(", ");
  await registerCallbackRequest(repo, {
    organizationId: ctx.organizationId,
    propertyId: prepared.branch.propertyId,
    customerName: prepared.payload.customerName,
    customerPhone: ctx.phone,
    reason: "aprobacion_pedido_cliente",
    message: [
      "PEDIDO RETENIDO: confirmar con el cliente antes de prepararlo (historial de pedidos no recogidos o marcados como falsos dentro de la ventana de la politica de clientes).",
      `Sucursal: ${prepared.branch.name}. Canal: ${prepared.payload.canal === "recoger" ? "recoger" : "domicilio"}.`,
      `Productos: ${lineas}. Total: $${prepared.total.toFixed(2)}.`,
      prepared.payload.customerAddress ? `Entrega: ${prepared.payload.customerAddress}.` : "Para recoger en sucursal.",
      `Pago: ${prepared.payload.paymentMethod ?? "sin definir"}.`,
    ].join("\n"),
    source: ctx.channel === "voz" ? "voice" : "whatsapp",
  });
  const result = {
    pedido_retenido: true,
    mensaje: "La sucursal confirma su pedido en un momento. Dígaselo así, con amabilidad: no explique motivos ni mencione historial; el pedido NO está creado todavía y no debe prometer hora de entrega.",
  };
  return { result, raw: result, orderId: null, propertyId: prepared.branch.propertyId };
}

/** Devuelve el `PedidoGrandeRetenidoError` (sin lanzarlo) si el pedido ya cotizado supera el umbral de pedido grande de PM, o `null`. Solo organizaciones con
 * perfil `taqueria_pm` y con el motivo `pedido_grande` encendido; sin configuracion (base sin migrar) no aplica. El umbral se evalua sobre lo ACUMULADO por el
 * mismo numero: (a) los pedidos de las ultimas horas en la memoria del cliente (`acumuladoReciente`) y (b) los que esta misma conversacion/llamada ya creo
 * (`sesionPrevia`). Partir un pedido grande en varios chicos no lo evade. Los pedidos de la sesion tambien estan en la memoria, asi que NO se suman dos
 * veces: se toma el mayor de los dos acumulados. Sin la memoria del cliente (base sin migrar) manda la sesion; sin ninguno se evalua el pedido solo. */
async function evaluarPedidoGrandeDelPedido(
  repo: RestaurantesRepository,
  prepared: PreparedOrder,
  idsEnMemoria?: Set<string>,
  sesionPrevia?: { readonly total: number; readonly pesoKg: number; readonly pedidos: number },
): Promise<PedidoGrandeRetenidoError | null> {
  const config = await repo.findWhatsAppAgentConfig(prepared.payload.organizationId, prepared.branch.propertyId);
  if (!config || config.perfil !== "taqueria_pm" || (config.escalationReasonsOff ?? []).includes("pedido_grande")) return null;
  const telefono = normalizePhone(prepared.payload.customerPhone);
  const pesoKg = pesoTotalKg(prepared.orderItems);
  const cliente = await repo.findCustomerByPhone(prepared.payload.organizationId, telefono);
  const memoria = await cargarMemoria(repo, prepared.payload.organizationId, telefono);
  const deMemoria = memoria ? acumuladoReciente(memoria.orders, Date.now()) : { total: 0, pesoKg: 0, cuantos: 0 };
  // Ids de los pedidos que ya sumaron al acumulado: si `create_order_idempotent` devuelve uno de ellos, fue una deduplicacion (no un pedido nuevo).
  if (memoria && idsEnMemoria) for (const o of memoria.orders) idsEnMemoria.add(o.id);
  const previos = {
    total: Math.max(deMemoria.total, sesionPrevia?.total ?? 0),
    pesoKg: Math.max(deMemoria.pesoKg, sesionPrevia?.pesoKg ?? 0),
    cuantos: Math.max(deMemoria.cuantos, sesionPrevia?.pedidos ?? 0),
  };
  const pedidosPrevios = cliente?.orderCount ?? 0;
  const total = Math.round((prepared.total + previos.total) * 100) / 100;
  const pesoAcumulado = pesoKg + previos.pesoKg;
  const motivo = evaluarPedidoGrande({
    total,
    pesoKg: pesoAcumulado,
    pagaEfectivo: prepared.payload.paymentMethod === "efectivo",
    // Con la memoria: "sin historial" = todo lo que el numero ha pedido cae dentro de la ventana (no hay pedidos anteriores a ella). Los pedidos creados
    // en ESTA sesion tampoco son historial (R90: un pedido de $126 de hace segundos no apaga la regla de $2,500 en efectivo).
    // Limitacion conocida: `orderCount` puede incluir cancelados que `previos.cuantos` no cuenta.
    sinHistorial: memoria ? pedidosPrevios <= previos.cuantos : !cliente || cliente.orderCount - (sesionPrevia?.pedidos ?? 0) <= 0,
  });
  if (!motivo) return null;
  const resumen = resumenPedidoGrande({
    motivo,
    total,
    totalDeEstePedido: prepared.total,
    pesoKg: pesoAcumulado,
    items: prepared.orderItems,
    canal: prepared.payload.canal,
    paymentMethod: prepared.payload.paymentMethod,
    pedidosPrevios: previos.cuantos,
  });
  return new PedidoGrandeRetenidoError(motivo, total, pesoAcumulado, resumen);
}

/** Lanza el error de pedido grande si aplica (preview y camino de aviso). */
async function assertNoEsPedidoGrande(repo: RestaurantesRepository, prepared: PreparedOrder, sesionPrevia?: { readonly total: number; readonly pesoKg: number; readonly pedidos: number }): Promise<void> {
  const grande = await evaluarPedidoGrandeDelPedido(repo, prepared, undefined, sesionPrevia);
  if (grande) throw grande;
}

/** QA-PM-R4-voz-02: lo unico que el agente le dice al cliente de un pedido grande retenido (el modelo decia "ha quedado registrado" con el texto largo de `mensaje`). */
export const MENSAJE_PEDIDO_GRANDE_PENDIENTE = "Su pedido es grande, así que la sucursal lo tiene que confirmar primero. Todavía no está en cocina; en cuanto lo confirmen le avisan.";

/** Deja el aviso `escalada:pedido_grande` (con el resumen) para la sucursal: lo usan el pedido NO creado y el creado `por_aprobar`. */
async function avisarPedidoGrandeASucursal(repo: RestaurantesRepository, ctx: AgentToolContext, input: CreateOrderInput, retenido: PedidoGrandeRetenidoError, propertyId: string | null | undefined, prefijo = ""): Promise<void> {
  const branch = propertyId ? null : await repo.findBranch(ctx.organizationId, { slug: input.branchSlug, name: input.branchName });
  await registerCallbackRequest(repo, {
    organizationId: ctx.organizationId,
    propertyId: ctx.lockedPropertyId ?? propertyId ?? branch?.propertyId ?? null,
    customerName: input.customerName,
    customerPhone: input.customerPhone,
    reason: "escalada:pedido_grande",
    message: `${prefijo}${retenido.resumen}`.slice(0, 900),
    source: ctx.channel === "voz" ? "voice" : "whatsapp",
  });
}

/** En vez de crear el pedido: deja el aviso `escalada:pedido_grande` (con el resumen) para que la sucursal lo confirme y contacte al
 * cliente. El resultado al modelo NO es un error: no marca fallo de herramienta ni sube al modelo caro. */
async function retenerPedidoGrande(repo: RestaurantesRepository, ctx: AgentToolContext, input: CreateOrderInput, retenido: PedidoGrandeRetenidoError): Promise<AgentToolOutcome> {
  await avisarPedidoGrandeASucursal(repo, ctx, input, retenido, null);
  const result = {
    pedido_grande: true,
    escalado: true,
    estado: "por_confirmar_por_la_sucursal",
    mensaje:
      "Este pedido supera el umbral de pedido grande, así que NO se mandó a cocina todavía: ya se avisó a la sucursal con el resumen para que lo confirme y contacte al cliente. Dígale al cliente, de usted, que la sucursal lo contactará para confirmar su pedido; no le prometa hora ni le diga que ya está en preparación, y no vuelva a llamar crear_pedido.",
    mensaje_al_cliente: MENSAJE_PEDIDO_GRANDE_PENDIENTE,
  };
  return { result, raw: result, orderId: null, propertyId: null };
}

/**
 * Variante para turnos dentro de una transaccion compartida (WhatsApp): SAVEPOINT propio por tool
 * call y errores de negocio convertidos en una respuesta `{error}` normal, nunca en una
 * transaccion abortada ni en una excepcion que tumbe el resto del turno.
 */
export async function executeAgentToolSafely(repo: RestaurantesRepository, ctx: AgentToolContext, name: string, input: Record<string, unknown>): Promise<AgentToolOutcome> {
  try {
    return await repo.runWithRowSavepoint(() => invokeAgentTool(repo, ctx, name, input));
  } catch (err) {
    // QA-PM-R3-reglas-10: la guarda SQL `raise exception ... using errcode = '22023'` (p. ej. "programado_para debe ser una hora futura") es una REGLA de negocio con un mensaje
    // pensado para el agente: antes salia como "Error interno" (y como fallo del sistema, que sube de rol), sin dejar rastro de la causa.
    const reglaSql = !(err instanceof OrderValidationError) && (err as { code?: unknown } | null)?.code === "22023" && err instanceof Error && err.message.trim() !== "";
    const esRegla = err instanceof OrderValidationError || reglaSql;
    if (!esRegla) {
      // Solo la clase, el SQLSTATE y el mensaje de la excepcion (sin argumentos de la herramienta: pueden traer datos del cliente).
      console.error(`[agent-tools] ${name} fallo con error interno: ${err instanceof Error ? err.name : typeof err} ${(err as { code?: unknown } | null)?.code ?? ""} ${err instanceof Error ? err.message.slice(0, 300) : ""}`);
    }
    return {
      result: { error: esRegla ? (err as Error).message : "Error interno al ejecutar la herramienta" },
      orderId: null,
      propertyId: null,
      ...(esRegla ? {} : { fallaSistema: true }),
      ...(err instanceof OrderFlowViolationError ? { rechazoDelFlujo: err.code } : {}),
    };
  }
}
