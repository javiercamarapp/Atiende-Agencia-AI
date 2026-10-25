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
import { descripcionSeguraDeError } from "../log-seguro.ts";
import { createHash } from "node:crypto";
import { registerCallbackRequest } from "../callback-requests.ts";
import { MOTIVOS_AVISO_CON_PEDIDO, armarBloquePedidoParaAviso, componerMensajeAviso } from "../aviso-pedido-gerente.ts";
import { cargarMemoria, evaluarReincidencia } from "../cliente-360/memoria.ts";
import { elegirPedido, repetirPedido } from "../cliente-360/repetir.ts";
import { getCustomerDetailById, lookupCustomerConPedidoReciente } from "../customers.ts";
import { buscarPedidoRecienteConSucursal } from "../pedido-reciente.ts";
import { fusionarRenglonesPorProducto } from "../promotions.ts";
import { aclararGuacamoleExtra } from "../whatsapp/guards.ts";
import { sanitizeInlineText } from "../text-sanitize.ts";
import { OrderValidationError, esGuardaSqlDeNegocioDePedido } from "../errors.ts";
import { normalizePhone, toWhatsAppRecipient } from "../phone.ts";
import { resolverMenuPdf } from "../menu-pdf.ts";
import { mismosRenglones, VENTANA_PEDIDO_IGUAL_MIN } from "../pedido-igual-reciente.ts";
import { PROPINA_PORCENTAJE_MAX } from "../whatsapp/guards.ts";
import { composicionParaProducto, pesoPedidoEnConsulta } from "../peso-composicion.ts";
import { pesoDeProductoEnGramos, unidadDeVenta } from "../product-search.ts";
import { avisoUnidadPorTabla } from "../unidades-pm.ts";
import { canonicalRequestedComplement, complementosExcluidosEnNotas, COMPLEMENTOS_PEDIBLES, DEFAULT_COMPLEMENTS, etiquetaComplementoResumen, isTortillaChoice, normalizarTortilla, PM_BASIC_COMPLEMENTS } from "../order-quote.ts";
import { componentesLocales, estaAbiertoAhora, aperturaConExcepciones, evaluarUltimoPedido, fechaLocal, fraseUltimoPedido, horaHablada, horaLegible, tieneUltimoPedidoPorTipo } from "../horarios.ts";
import { evaluarDomicilioSucursal } from "../domicilio-sucursal.ts";
import { resolverZonaHorariaNegocio } from "@atiende/core-tenancy";
import { assignBranch, radioRepartoDelPerfil } from "../branch-assignment.ts";
import { COORDENADAS_PROPUESTAS_PM, coordenadasPropuestasActivas } from "../coordenadas-sucursales.ts";
import { evaluarDireccionEntrega, faltantesEnUnMensaje } from "../direccion-pin-tablaje.ts";
import { geocercasActivas } from "../geocercas.ts";
import { GEOCERCAS_PM } from "../seed/geocercas-pm.ts";
import { kmAproxTexto } from "../nearest-branch.ts";
import { SUCURSALES_QUE_NO_REPARTEN_PM } from "../sugerencia-despacho.ts";
import { formatUbicacionEntregaNota, type UbicacionEntrega } from "../whatsapp/location.ts";
import { knownAmountsOfQuote, requierePinAntesDeCrear } from "../whatsapp/guards.ts";
import { CATEGORIAS_SIN_SALSA, createOrder, prepareCreateOrder, quoteOrder, searchProducts, type PreparedOrder, type QuotePolicyInfo, type QuotePromotionInfo } from "../orders.ts";
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
  rechazaElResumen,
  resumenMostradoEnHistorial,
  esRespuestaDePagoOPropina,
  asistentePidioConfirmarResumen,
  warnOrderFlowUnavailable,
  type OrderFlowContext,
  type OrderFlowRef,
  type OrderFlowSnapshot,
  type OrderFlowState,
  type OrderFlowViolationCode,
  type QuotedItem,
} from "./order-flow.ts";
import {
  cierreMaquinaActiva,
  clasificarRespuestaCierre,
  datosDeCierreDeContexto,
  datosDeCierreDeEntrada,
  decidirConfirmacion,
  etiquetaHoraEntrega,
  firmaDeCierre,
  horaCotizadaContradiceAlCliente,
  mensajeDatosCambiaron,
  resumenCanonico,
  sanearNotaDeResumen,
} from "./cierre-maquina.ts";
import { datosCierreDeCotizacion, type DatosCierre } from "./cierre-determinista.ts";
import type {
  CanalPedido,
  CreateOrderInput,
  DefaultComplement,
  DoubleSalsa,
  Order,
  OrderQuote,
  RequestedComplement,
  RequestedOrderItemInput,
  TortillaChoice,
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
  | "enviar_menu"
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
  /** Ultimos mensajes (cliente y agente) de esta conversacion de WhatsApp. Solo lo fija el servidor; alimenta guardas que comparan lo que dijo el cliente, y si ya se le aclaro, con lo que cotiza el
   * modelo (p. ej. «guacamole» contra «Extra Guacamole»). Ausente (voz, camino legado) = esas guardas no opinan. */
  readonly conversacionReciente?: readonly { readonly role: "user" | "assistant"; readonly content: string }[];
  /** Base https publica donde estan los PDF del menu por sucursal (`PM_MENU_PDF_BASE_URL`). Solo la fija el servidor. Ausente = `enviar_menu` comparte el enlace de la pagina oficial del menu. */
  readonly menuPdfBaseUrl?: string | null;
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

/** Motivos que el sistema usa por su cuenta (vueltas agotadas, limites de la llamada) y que NO se ofrecen al modelo: PM Ronda 12 (T7-008 Luna r1) el modelo escalaba
 * `no_puedo_resolver` ante un producto que no existe ("chistorra") y la toma callaba al agente. Siguen siendo motivos validos (`normalizarMotivoEscalacion`). */
export const MOTIVOS_SOLO_DEL_SISTEMA: ReadonlySet<string> = new Set(["no_puedo_resolver"]);

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

/** PM-R20: tope de consultas extra de `buscar_producto` en una sola llamada (cada una es una lectura barata sin efectos). */
export const MAX_CONSULTAS_ADICIONALES_BUSCAR_PRODUCTO = 5;
const MAX_LARGO_CONSULTA_BUSCAR_PRODUCTO = 200;

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
      "Busca productos del menú real de la sucursal por nombre, sinónimo o palabra clave. Devuelve id, nombre, precio real de esa sucursal, pack_size y requires_adult_confirmation. Lista vacía significa que ese producto no existe en el menú. Si ningún resultado coincide exactamente con lo que pidió el cliente (o hay varios parecidos), no elijas ni sustituyas por él: pregúntale cuál prefiere entre 2 o 3 opciones de la lista. Si algún resultado trae ambiguo: true, la búsqueda NO pudo fijar un único producto (por ejemplo «media orden» de algo que también se vende por kilo, o un peso que no existe): NO elijas por el cliente, pregúntale cuál presentación quiere antes de cotizar. ÚNICA excepción: en un renglón por peso que trae composicion_peso de tipo composicion, el ambiguo solo significa que el peso pedido no es una presentación exacta y la combinación YA está armada con precios del menú: no preguntes cuál presentación, dile al cliente la composición y su total (tal cual vienen) y espera su sí; si el tipo es preguntar, pregunta cuánto quiere.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "texto a buscar, ej. 'pastor' o 'kilo arrachera'" },
        branch_slug: { type: "string", description: "El branch_slug de la sucursal ya confirmada. Si todavía no se confirma la sucursal, no llames esta herramienta." },
        consultas_adicionales: { type: "array", maxItems: MAX_CONSULTAS_ADICIONALES_BUSCAR_PRODUCTO, items: { type: "string" }, description: "Opcional: otros productos del MISMO pedido para buscar en esta misma llamada (uno por producto, hasta 5). Con ellas la respuesta trae un resultado por consulta (query incluida) en vez de la lista sola; ahorra una ida al modelo por producto." },
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
        requested_complements: { type: "array", items: { type: "string", enum: [...COMPLEMENTOS_PEDIBLES] }, description: "Mismos complementos que mandará en crear_pedido (salsas pedidas, sin costo): mándelos AQUÍ para que el resumen los muestre al cliente antes de su sí. No cambia el total." },
        omit_default_complements: { type: "array", items: { type: "string", enum: [...DEFAULT_COMPLEMENTS, "cebolla"] }, description: "Mismas salsas que el cliente quitó y que mandará en crear_pedido; mándelas AQUÍ para que el resumen las muestre." },
        notes: { type: "string", description: "Mismos ajustes que mandará en crear_pedido (por ejemplo «sin cebolla»); mándelos AQUÍ para que el resumen se los muestre al cliente. Sin teléfonos ni datos personales." },
        otro_pedido: { type: "boolean", description: "true SOLO si el cliente pidió expresamente OTRO pedido igual al que ya quedó registrado. Un 'sí' de más o repetir el resumen NO es otro pedido: no lo mande." },
        efectivo_con: { type: "number", description: "Solo pago en efectivo: monto con el que paga el cliente ('cambio de 500' = 500). Mándelo AQUÍ en cuanto lo dé para que el resumen lo muestre." },
        propina: { type: "number", description: "Propina en pesos que dio el cliente (solo si preguntar_propina fue true). No suma al total. Mándela aquí en cuanto la dé para que el resumen la muestre." },
        propina_porcentaje: { type: "number", description: "Propina como PORCENTAJE del total ('de propina 10%' = 10), solo con tarjeta. Mándela aquí en cuanto la dé para que el resumen la muestre." },
        programado_para: { type: "string", description: "Solo si el cliente quiere dejar el pedido para después (otro día o dentro de MÁS de 30 minutos con hora exacta): fecha y hora ISO 8601 con el offset de la SUCURSAL (por ejemplo 2026-10-03T14:00:00-06:00 en Mérida; nunca Z ni UTC: un offset distinto se rechaza), con al menos 30 minutos de anticipación y máximo 7 días. La sucursal debe estar abierta a esa hora. Debe ser la MISMA que usaste al cotizar. Si el cliente pasa 'en cuanto esté', 'ahorita' o 'en 20 minutos', NO mandes este campo (omítelo; no mandes texto vacío)." },
        minutos_para_recoger: { type: "integer", description: "Solo canal 'recoger': si el cliente dijo un PLAZO (\"en 40 minutos\", \"en media hora\" = 30, \"dentro de una hora\" = 60), mande ESOS minutos en vez de calcular hora_recogida: el servidor calcula la hora con su reloj. Mande el mismo valor en cotizar_pedido y en crear_pedido. Para una hora exacta (\"a las 8:30\") use hora_recogida; con \"en cuanto esté\" no mande ninguno." },
        hora_recogida: { type: "string", description: "Solo canal 'recoger' y SIN programado_para: la hora a la que pasará el cliente (por ejemplo 'en 40 minutos'), en ISO 8601 con el offset de la SUCURSAL (Mérida -06:00; un offset distinto, Z o UTC se rechaza), calculada con la HORA LOCAL de la sucursal. El servidor la valida (no pasada, de hoy, dentro del horario). Omítela si pasa 'en cuanto esté'." },
        customer_name: { type: "string", description: "Opcional: nombre del cliente si ya lo dio. No cambia el total; el sistema lo guarda (solo WhatsApp) para poder registrar el pedido ya confirmado si el turno se corta." },
        customer_address: { type: "string", description: "Opcional, solo domicilio: dirección completa que dio el cliente. No cambia el total; se guarda igual que el nombre." },
        indicaciones_acceso: { type: "string", description: "Opcional, solo domicilio: cómo llegar o avisar (una línea). Se guarda igual que el nombre." },
        referencias_acceso: { type: "string", description: "Opcional: referencias para llegar que dio el cliente. Se guarda igual que el nombre." },
        direccion_etiqueta: { type: "string", description: "Opcional: cómo llama el cliente a este domicilio (casa, oficina). Se guarda igual que el nombre." },
        maps_url: { type: "string", description: "Opcional: link de Google Maps/Waze que el cliente mandó por escrito (https). Nunca lo inventes." },
        usar_ubicacion_compartida: { type: "boolean", description: "Opcional: true solo si el cliente compartió su ubicación por WhatsApp y es la de este domicilio." },
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
        hora_recogida: { type: "string", description: "Solo canal 'recoger': hora a la que el cliente pasará, en ISO 8601 con el offset de la SUCURSAL (por ejemplo 2026-09-30T20:30:00-06:00 en Mérida; Z o un offset distinto se rechaza). Si el cliente dijo una hora o un plazo (\"en 40 minutos\", \"a las 2\") MÁNDELA igual que en cotizar_pedido; nunca vacía: omítala solo si pasa 'en cuanto esté'." },
        direccion_etiqueta: { type: "string", description: "Opcional: como llama el cliente a este domicilio (casa, oficina...). Solo si lo dijo." },
        referencias_acceso: { type: "string", description: "Opcional: referencias para llegar (porton, timbre, entre calles). Solo si las dio el cliente." },
        maps_url: { type: "string", description: "Opcional: link de Google Maps/Waze que el cliente mando por escrito (https). Nunca lo inventes." },
        usar_ubicacion_compartida: { type: "boolean", description: "true solo si el cliente compartio su ubicacion por WhatsApp Y es la de este domicilio de entrega; el sistema usa las coordenadas reales del mensaje." },
        programado_para: { type: "string", description: "Solo si el cliente quiere dejar el pedido para después: fecha y hora ISO 8601 con el offset de la SUCURSAL (por ejemplo 2026-10-03T14:00:00-06:00 en Mérida; nunca Z ni UTC: un offset distinto se rechaza), con al menos 30 minutos de anticipación y máximo 7 días. La sucursal debe estar abierta a esa hora. Debe ser la MISMA que usaste al cotizar." },
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
    name: "enviar_menu",
    description:
      "Manda al cliente por WhatsApp el menú en PDF de UNA sucursal (el publicado en internet por esa sucursal). Úsela cuando pida el menú o la carta; no lo pegue en texto. Devuelve enviado 'pdf' (ya salió el documento), 'enlace' (no hay PDF: comparta ese enlace oficial tal cual) o 'sin_menu' (esa sucursal no tiene menú publicado). Solo WhatsApp.",
    parameters: {
      type: "object",
      properties: { branch_slug: { type: "string", description: "Sucursal cuyo menú pide el cliente (la del chat por omisión; si pide otra, esa). Solo slugs de la lista de sucursales." } },
      required: ["branch_slug"],
    },
    channels: ["whatsapp"],
  },
  {
    name: "escalar_a_humano",
    description:
      "Pasa la conversación a una persona del restaurante cuando el cliente lo pide o hay una queja. Lo que sí puedes resolver (un producto que no existe, una duda de menú, un ajuste) lo resuelves tú con las demás herramientas. Deja un aviso con el motivo para que alguien le responda.",
    parameters: {
      type: "object",
      properties: {
        customer_name: { type: "string" },
        motivo: {
          type: "string",
          enum: MOTIVOS_ESCALACION.filter((m) => !MOTIVOS_SOLO_DEL_SISTEMA.has(m)),
          description:
            "Motivo del aviso (llamala UNA sola vez por conversacion y motivo): transferencia (quiere pagar por transferencia), modificacion_platillo (pide cambiar ingredientes o receta de un platillo), alergia_salud, cancelacion_modificacion (cancelar o cambiar un pedido ya confirmado), producto_agotado, zona_no_reconocida (colonia no reconocida dos veces), no_entiende (no se le entiende dos veces), falla_sistema, pedido_grande / tiempos_entrega (pedido muy grande o exige un tiempo concreto), cobro_duplicado, urgencia, privacidad_arco (derechos ARCO / datos personales).",
        },
        resumen: { type: "string", description: "Una o dos frases con lo que necesita el cliente. Si quiere CANCELAR un pedido ya registrado, diga «cancelar» en el resumen (el sistema usa la frase de cancelación); si solo agrega o cambia algo, no use esa palabra." },
      },
      required: ["motivo"],
    },
    channels: ["whatsapp", "voz"],
  },
];

/** Definiciones visibles para un canal (ninguna parametro de telefono, por diseño). */
export function toolDefinitionsForChannel(channel: AgentChannel): readonly AgentToolDefinition[] {
  const defs = AGENT_TOOL_DEFINITIONS.filter((t) => t.channels.includes(channel));
  if (channel !== "voz") return defs;
  // PM R18: los datos opcionales del cliente en `cotizar_pedido` son solo de WhatsApp (cierre determinista); la voz no los ve ni los guarda.
  return defs.map((t) => {
    if (t.name !== "cotizar_pedido") return t;
    const properties = Object.fromEntries(Object.entries(t.parameters.properties).filter(([k]) => !CAMPOS_DATOS_CLIENTE_EN_COTIZAR.has(k)));
    return { ...t, parameters: { ...t.parameters, properties } } as AgentToolDefinition;
  });
}

/** Campos de `cotizar_pedido` que solo existen en WhatsApp (los guarda el flujo para el cierre determinista). */
const CAMPOS_DATOS_CLIENTE_EN_COTIZAR: ReadonlySet<string> = new Set(["customer_name", "customer_address", "indicaciones_acceso", "referencias_acceso", "direccion_etiqueta", "maps_url", "usar_ubicacion_compartida"]);

/** Datos de cierre de la cotizacion: solo en WhatsApp; en voz el flujo no guarda nada nuevo. */
function datosDeCierreSiWhatsapp(ctx: AgentToolContext, input: Record<string, unknown>, previo: DatosCierre | undefined): DatosCierre | undefined {
  return ctx.channel === "whatsapp" ? datosCierreDeCotizacion(input, previo) : previo;
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
  // Solo WhatsApp (no se exporta al manifiesto de voz): la ruta existe unicamente porque el Record exige todas las tools.
  enviar_menu: "/menu/send",
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
function tortillaDeEntrada(raw: unknown): TortillaChoice | undefined {
  const t = normalizarTortilla(raw);
  return isTortillaChoice(t) ? t : undefined;
}

/** R11-11: solo un numero o una cadena de digitos ("2", " 3 ") es una cantidad. `true`, `[2]`, "0x10", "1e3" o "" ya no se coercionan en silencio: dan NaN y el
 * dominio (voz/web) o la validacion lenient (WhatsApp) los rechazan con un error accionable. */
function cantidadEstricta(valor: unknown): number {
  if (typeof valor === "number") return valor;
  if (typeof valor === "string" && /^\s*\d+\s*$/.test(valor)) return Number(valor);
  return Number.NaN;
}

export function toRequestedItems(raw: unknown, lenient: boolean): RequestedOrderItemInput[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => {
    const item = (entry ?? {}) as RawItemInput;
    const qty = cantidadEstricta(item.requested_quantity);
    if (lenient && (!Number.isInteger(qty) || qty < 1)) throw new OrderValidationError(CANTIDAD_NO_NUMERICA_MENSAJE);
    return {
      productId: typeof item.product_id === "string" ? item.product_id : undefined,
      productName: typeof item.product_name === "string" ? item.product_name : undefined,
      requestedQuantity: qty,
      tortilla: tortillaDeEntrada(item.tortilla),
    };
  });
}

/** `unidad_de_venta` sale para flautas (1 flauta grande por orden) y para productos por orden sin piezas confirmadas (ver product-search.ts::unidadDeVenta). */
function unidadDeVentaWire(product: Parameters<typeof unidadDeVenta>[0]): { unidad_de_venta?: string } {
  const unidad = unidadDeVenta(product) ?? avisoUnidadPorTabla(product);
  return unidad ? { unidad_de_venta: unidad } : {};
}

export function quoteToWire(quote: OrderQuote & Partial<QuotePolicyInfo> & Partial<QuotePromotionInfo>) {
  return {
    lines: quote.lines.map((line) => ({
      product_id: line.productId,
      name: line.name,
      price: line.price,
      requested_quantity: line.requestedQuantity,
      pack_size: line.packSize,
      ...unidadDeVentaWire({ name: line.name, packSize: line.packSize }),
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
    ...(quote.abiertoAhora !== undefined && quote.abiertoAhora !== null ? { abierto_ahora: quote.abiertoAhora, cierra_a: quote.cierraA ?? null, cierra_a_texto: quote.cierraA ? horaLegible(quote.cierraA) : null } : {}),
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

/**
 * QA-PM-R5-reglas-02: en RECOGER, `programado_para` y `hora_recogida` son la misma hora (el modelo cotiza con una y crea con la otra, o con las dos y despues con una).
 * Para la huella del pedido se usa un solo instante (al minuto, ISO UTC): el programado si vino, si no la hora de recogida. Fuera de recoger no se toca.
 */
function horaUnificadaRecoger(input: Record<string, unknown>): string | undefined {
  if (input.canal !== "recoger") return undefined;
  const programado = toProgramadoPara(input.programado_para);
  return programado ? new Date(programado).toISOString().slice(0, 16) : toHoraRecogida(input.hora_recogida);
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

const UBICACION_IMPLAUSIBLE_MENSAJE =
  "La ubicación recibida no parece estar en la zona de las sucursales (probablemente llegó mal formada). NO diga a qué sucursal corresponde, NO diga distancias, NO escale a una persona por esto y NO repita esas coordenadas: " +
  "dígale al cliente, con amabilidad, que no pudo recibir bien su ubicación y pídale que la comparta de nuevo o que le diga su colonia y calle; después vuelva a llamar buscar_sucursal_cercana con la colonia. Si no puede, ofrezca recoger en sucursal.";

const PIN_ANTES_DE_CREAR_MENSAJE =
  "El cliente describió su casa solo con referencias visuales (sin número ni cruzamientos) y todavía no hay pin de ubicación. Antes de registrar, pídale UNA vez que comparta su ubicación de WhatsApp (botón o clip) o un enlace de Google Maps, " +
  "para que el repartidor llegue directo; guarde la referencia visual en referencias_acceso. Si responde que no puede o no quiere, vuelva a llamar crear_pedido con los mismos datos y se registra sin pin. No escale por esto.";

/** La sucursal asignada al domicilio cuando NO es la de este chat (`entryPropertyId`); `null` si coincide o no hay sucursal de entrada. */
async function sucursalDeOtroChat(repo: RestaurantesRepository, ctx: AgentToolContext, organizationId: string, branchSlug: string, confirmada = true): Promise<Record<string, unknown> | null> {
  if (!ctx.entryPropertyId) return null;
  const asignada = await repo.findBranch(organizationId, { slug: branchSlug });
  if (!asignada || asignada.propertyId === ctx.entryPropertyId) return null;
  const delChat = await repo.findBranchById(organizationId, ctx.entryPropertyId);
  const tel = asignada.phone ? ` (${asignada.phone})` : "";
  if (!confirmada) {
    return {
      branch_slug: asignada.slug,
      branch_name: asignada.name,
      ...(asignada.phone ? { telefono: asignada.phone } : {}),
      aviso: `La referencia (NO confirmada) apunta a ${asignada.name}${tel}, que no es la sucursal de este chat. No diga que entregan ni que le toca esa sucursal; ofrezca recoger en la sucursal de este chat y, si insiste en domicilio, escale UNA vez (zona_ambigua).`,
    };
  }
  return {
    branch_slug: asignada.slug,
    branch_name: asignada.name,
    ...(asignada.phone ? { telefono: asignada.phone } : {}),
    ...(delChat ? { chat_de: delChat.name } : {}),
    aviso:
      `Este chat es de ${delChat?.name ?? "otra sucursal"}, pero ese domicilio lo atiende ${asignada.name}${tel}. NO tome el pedido a domicilio desde este chat y NO conteste «sí, entregamos» ni «sí, desde aquí»: ` +
      `dígale con calidez que su zona la atiende ${asignada.name}, dele ${asignada.phone ? `el teléfono ${asignada.phone}` : "el teléfono de esa sucursal (lista de DATOS DEL NEGOCIO)"} y conteste lo que preguntó (precio o tiempo). ` +
      `Ofrezca recoger en ${delChat?.name ?? "la sucursal de este chat"}. Si insiste una primera vez, mantenga la postura (las zonas de reparto son fijas) y ofrezca recoger otra vez; si insiste de nuevo, escale UNA vez con motivo zona_ambigua (el cliente insiste en otra sucursal para domicilio). No escale antes de eso.`,
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
      tortilla: tortillaDeEntrada(item.tortilla),
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

/** 0, "0", "0%" o vacio = "sin propina" (el modelo rellena asi el campo cuando no hay propina: QA-PM-R5-reglas-01). Solo se rechazan negativos, > maximo y no numericos. */
function esSinPropina(valor: unknown): boolean {
  if (valor === undefined || valor === null || valor === 0 || valor === false) return true;
  // [] y {} vacios tambien son relleno ("no hay dato"); true y los arreglos u objetos con contenido siguen siendo invalidos.
  if (Array.isArray(valor)) return valor.length === 0;
  if (typeof valor === "object") return Object.keys(valor as object).length === 0;
  if (typeof valor !== "string") return false;
  // Sin regex con \s* anidados (ReDoS): se recorta una sola vez y se comparan formas fijas.
  let t = valor.trim().toLowerCase();
  if (t.endsWith("%")) t = t.slice(0, -1);
  else if (t.endsWith("por ciento")) t = t.slice(0, -"por ciento".length);
  t = t.trim();
  return t === "" || /^0+(?:[.,]0+)?$/.test(t);
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
  if (!esSinPropina(pctCrudo) && porcentajeDePropina(pctCrudo) === null) {
    throw new OrderValidationError(`propina_porcentaje debe ser un número entre 1 y ${PROPINA_PORCENTAJE_MAX} (por ejemplo 10 para el 10 %). Si el cliente dio pesos, mande propina en pesos.`);
  }
  const propina = input.propina;
  if (typeof propina === "string" && porcentajeDePropina(propina) !== null) return;
  if (!esSinPropina(propina) && (typeof propina !== "number" || !Number.isFinite(propina))) {
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
    // R12-16: en WhatsApp solo un TEXTO es un nombre. `String({})`, `String(["Ana","Beto"])` o `String(true)` daban «[object Object]», «Ana,Beto» o «true» como nombre del cliente en la comanda.
    customerName: lenient ? (typeof input.customer_name === "string" ? input.customer_name : "") : (str(input.customer_name) ?? ""),
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
    // Un 0 es "sin propina" (el modelo lo manda junto con propina_porcentaje): no debe tapar el porcentaje, que solo se convierte cuando propina es undefined.
    propina: typeof input.propina === "number" && input.propina !== 0 ? input.propina : undefined,
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
  // Campos que solo trae el canal de voz (correo, transcripcion, idempotencia, nombre de sucursal).
  return {
    ...base,
    // Un valor que no es hora (numero, objeto) se rechaza con 400 en vez de ignorarse y mandar el pedido a cocina de inmediato.
    programadoPara: toProgramadoPara(input.programado_para),
    branchName: str(input.branch_name),
    customerEmail: str(input.customer_email),
    idempotencyKey: str(input.idempotency_key),
    callTranscript: str(input.call_transcript),
    callRecordingUrl: str(input.call_recording_url),
    // R12-13: NO se lee `promo_code` del modelo ni de quien le habla (decision T-AB01: ninguna herramienta acepta promocion, descuento ni total). Un codigo valido que el modelo mencionara bajaba
    // el total por debajo de lo que el cliente confirmo y permitia canjear el codigo de compensacion de OTRO telefono. El servidor aplica solo lo automatico y el codigo emitido a ESTE telefono.
  };
}

/**
 * Ejecuta UNA tool del registro. Lanza `OrderValidationError` ante errores de negocio (el
 * envoltorio de WhatsApp los convierte en `{error}`; el HTTP de voz en 400). No abre SAVEPOINT:
 * quien ejecute dentro de una transaccion compartida debe envolver la llamada (ver
 * `executeAgentToolSafely`).
 */
/** `rechazoComoResultado`: el rechazo `resumen_no_mostrado` se DEVUELVE como resultado `{error}` en vez de lanzarse. Lo usa `executeAgentToolSafely`: ahi cada tool call corre dentro de un SAVEPOINT
 * que se revierte ante CUALQUIER excepcion, y el marcador del rechazo (la salida contra el deadlock) se perderia junto con el throw. */
export interface InvokeAgentToolOpts {
  readonly rechazoComoResultado?: boolean;
}

/** Hora ISO 8601 con zona (`Z` u offset) como la manda el modelo: grupos = fecha, hora:min[:seg] y offset. Mismo formato que acepta `parsearProgramadoPara`, tambien con espacio en vez de «T». */
const ISO_CON_ZONA_DEL_MODELO = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i;

function minutosDeOffset(texto: string): number {
  if (texto.toUpperCase() === "Z") return 0;
  const signo = texto.startsWith("-") ? -1 : 1;
  const digitos = texto.slice(1).replace(":", "");
  return signo * (Number(digitos.slice(0, 2)) * 60 + Number(digitos.slice(2, 4)));
}

function textoDeOffset(minutos: number): string {
  const abs = Math.abs(minutos);
  return `${minutos < 0 ? "-" : "+"}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

/** Componentes de pared de un instante en la zona, para armar el ISO local y sacar el offset VIGENTE en esa fecha (horario de verano incluido). */
function paredEnZona(ms: number, zona: string): { readonly texto: string; readonly offsetMin: number } {
  const partes = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: zona, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .formatToParts(new Date(ms))
      .map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  const offsetMin = Math.round((Date.UTC(Number(partes.year), Number(partes.month) - 1, Number(partes.day), Number(partes.hour), Number(partes.minute), Number(partes.second)) - Math.floor(ms / 1000) * 1000) / 60_000);
  return { texto: `${partes.year}-${partes.month}-${partes.day}T${partes.hour}:${partes.minute}:${partes.second}${textoDeOffset(offsetMin)}`, offsetMin };
}

/**
 * R13/T7-026: `programado_para` / `hora_recogida` con un offset que NO es el de la zona de la sucursal en ese instante se RECHAZAN (antes se aceptaba cualquier offset: «19:00-05:00»,
 * el horario de verano que Merida ya no usa, se guardaba como las 18:00 y el cliente que pidio 7 pm recibia su pedido una hora antes; «19:00Z» era 13:00 local). El servidor NO adivina
 * cual hora quiso el modelo (reinterpretar en silencio podria cambiar un instante que si era correcto): devuelve el offset esperado y las dos lecturas posibles para que reintente.
 * Excepciones: el eco de la hora YA cotizada en este flujo (el servidor la devuelve en UTC) y lo que no es una hora ISO con zona (otras reglas ya lo rechazan con su propio mensaje).
 * Solo el modelo pasa por aqui (WhatsApp, llamada y API de voz); la hora que calcula el servidor con `minutos_para_recoger` se agrega despues y no se valida.
 */
async function exigirOffsetDeLaSucursal(repo: RestaurantesRepository, ctx: AgentToolContext, name: string, entrada: Record<string, unknown>): Promise<void> {
  if (name !== "cotizar_pedido" && name !== "crear_pedido") return;
  const campos = (["programado_para", "hora_recogida"] as const).filter((c) => typeof entrada[c] === "string" && ISO_CON_ZONA_DEL_MODELO.test((entrada[c] as string).trim()));
  if (campos.length === 0) return;
  const zona = await zonaDeSucursal(repo, ctx, entrada.branch_slug);
  if (zona === null) return;
  for (const campo of campos) {
    const texto = (entrada[campo] as string).trim();
    const m = ISO_CON_ZONA_DEL_MODELO.exec(texto)!;
    const ms = Date.parse(texto.replace(" ", "T"));
    if (Number.isNaN(ms)) continue;
    const local = paredEnZona(ms, zona);
    if (minutosDeOffset(m[4]!) === local.offsetMin) continue;
    if (ctx.flow) {
      const cotizado = (await repo.readOrderFlow(ctx.organizationId, ctx.flow.key))?.context;
      const minuto = new Date(ms).toISOString().slice(0, 16);
      if ((cotizado?.programadoPara && cotizado.programadoPara.slice(0, 16) === minuto) || cotizado?.horaRecogida === minuto) continue;
    }
    const esperado = textoDeOffset(local.offsetMin);
    const comoLaEscribio = `${m[1]}T${m[2]}:${m[3] ?? "00"}${esperado}`;
    throw new OrderValidationError(
      `${campo} "${texto}" no lleva el offset de la sucursal: ${String(entrada.branch_slug)} está en ${zona} (UTC${esperado}) y otro offset cambia la hora real del pedido. ` +
        `Mande la hora LOCAL de la sucursal con ${esperado}: si la hora que dijo el cliente es ${m[2]}, mande ${comoLaEscribio}; si calculó la hora desde otra zona, ese mismo instante en hora de la sucursal es ${local.texto}. ` +
        `Confirme con lo que dijo el cliente y reintente con ese offset (igual en cotizar_pedido y en crear_pedido). Si el cliente dio un plazo ("en 40 minutos"), mande minutos_para_recoger en vez de la hora.`,
    );
  }
}

export async function invokeAgentTool(repo: RestaurantesRepository, ctx: AgentToolContext, name: string, rawInput: Record<string, unknown>, opts: InvokeAgentToolOpts = {}): Promise<AgentToolOutcome> {
  const def = AGENT_TOOL_DEFINITIONS.find((t) => t.name === name);
  if (!def || !def.channels.includes(ctx.channel)) throw new OrderValidationError(`Herramienta desconocida: ${name}`);
  // `plazo_minutos_servidor` es un campo INTERNO que solo pone `conHoraDeRecogidaRelativa`: lo que mande el modelo se descarta.
  const { plazo_minutos_servidor: _interno, ...entrada } = rawInput;
  // QA-PM-R4-reglas-11: una hora_recogida que no es texto (un epoch numerico) se ignoraba en silencio y el pedido salia sin hora (cocina lo trata como "para ya").
  if ((name === "cotizar_pedido" || name === "crear_pedido") && entrada.hora_recogida !== undefined && entrada.hora_recogida !== null && typeof entrada.hora_recogida !== "string") {
    throw new OrderValidationError("hora_recogida debe ser texto en ISO 8601 con zona (por ejemplo 2026-09-30T20:30:00-06:00), no un número. Si el cliente dio un plazo (\"en 40 minutos\"), mande minutos_para_recoger.");
  }
  await exigirOffsetDeLaSucursal(repo, ctx, name, entrada);
  // QA-PM-R5-reglas-02 (revision): en RECOGER son la misma hora; si el modelo manda las dos y NO coinciden, el pedido guardaria dos horas contradictorias. Se rechaza con
  // un mensaje accionable (las iguales y las que vienen de una sola fuente pasan como antes).
  if ((name === "cotizar_pedido" || name === "crear_pedido") && entrada.canal === "recoger") {
    const programado = toProgramadoPara(entrada.programado_para);
    const hora = toHoraRecogida(entrada.hora_recogida);
    const textoHora = textoOpcional(entrada.hora_recogida)?.trim() ?? "";
    // Una hora ISO sin zona NO es "distinta": le falta la zona (se interpretaria en la zona del proceso). Mensaje propio para que el modelo la corrija.
    if (programado !== undefined && textoHora !== "" && /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(textoHora)) {
      throw new OrderValidationError("hora_recogida debe incluir la zona horaria (por ejemplo 2026-10-06T15:00:00-06:00). En recoger es la misma hora que programado_para: mande la misma con zona, o solo programado_para.");
    }
    if (programado !== undefined && hora !== undefined && new Date(programado).toISOString().slice(0, 16) !== hora) {
      throw new OrderValidationError("programado_para y hora_recogida son distintas: en recoger son la misma hora. Mande solo la hora que dijo el cliente (programado_para) o la misma en las dos, tanto en cotizar_pedido como en crear_pedido.");
    }
  }
  const input = await conHoraDeRecogidaRelativa(repo, ctx, name, entrada);
  if (!ctx.flow || (name !== "cotizar_pedido" && name !== "confirmar_resumen" && name !== "crear_pedido" && name !== "repetir_pedido")) {
    return dispatchTool(repo, ctx, name, input);
  }
  return runWithOrderFlow(repo, ctx, ctx.flow, name, input, opts);
}


/** Zona horaria de la sucursal por su slug (la de plataforma si no hay dato o la base no tiene la migracion de zona). `null` = la sucursal no existe: otra regla se encarga del error. */
async function zonaDeSucursal(repo: RestaurantesRepository, ctx: AgentToolContext, slug: unknown): Promise<string | null> {
  if (typeof slug !== "string" || slug.trim() === "") return null;
  const branch = await repo.findBranch(ctx.organizationId, { slug });
  if (!branch) return null;
  return resolverZonaHorariaNegocio((await repo.findBranchZonaHoraria(branch.propertyId)).zonaHoraria);
}

/**
 * R13/T7-026: la hora que el CLIENTE debe ver en el resumen canonico, en la zona de la sucursal, y la direccion que el servidor conoce (colonia y pin) si es a domicilio.
 * La hora sale de lo ya cotizado (`hora` = recoger, ISO UTC al minuto o el programado) para que el resumen y el pedido guardado digan lo mismo.
 */
async function horaYDireccionDeResumen(
  repo: RestaurantesRepository,
  ctx: AgentToolContext,
  input: Record<string, unknown>,
  horaCotizada: string | undefined,
  ahoraMs: number,
  calle?: string,
): Promise<{ readonly hora?: string; readonly direccion?: string; readonly contradiceAlCliente?: string }> {
  const programado = input.canal === "recoger" ? undefined : toProgramadoPara(input.programado_para);
  const crudo = programado ?? horaCotizada;
  const instante = crudo === undefined ? NaN : Date.parse(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(crudo) ? `${crudo}:00.000Z` : crudo);
  const zona = (await zonaDeSucursal(repo, ctx, input.branch_slug)) ?? resolverZonaHorariaNegocio(null);
  const hora = Number.isNaN(instante) ? undefined : etiquetaHoraEntrega(instante, zona, ahoraMs);
  // R21 (T7-026): el cliente cambio la hora («mejor a las 5 pm») y la cotizacion siguio con la anterior (el pedido quedaba a las 7 pm).
  const contradice = Number.isNaN(instante) || !ctx.conversacionReciente ? null : horaCotizadaContradiceAlCliente(instante, zona, ctx.conversacionReciente);
  const partes: string[] = [];
  const colonia = input.canal === "recoger" ? undefined : textoOpcional(input.colonia_entrega)?.trim();
  // R21 (T7-001/T7-038): la direccion completa que el cliente dio (la calle, el numero, las referencias) va en el resumen que confirma; antes solo salia la colonia.
  const direccionCompleta = input.canal === "recoger" || !calle ? undefined : sanearNotaDeResumen(calle, { direccion: true });
  if (direccionCompleta) partes.push(direccionCompleta);
  if (colonia && !(direccionCompleta && direccionCompleta.toLowerCase().includes(colonia.toLowerCase()))) partes.push(`colonia ${colonia}`);
  if (input.canal !== "recoger" && ctx.ubicacionEntrega) partes.push("pin de ubicación recibido");
  return { ...(hora ? { hora } : {}), ...(partes.length > 0 ? { direccion: partes.join(", ") } : {}), ...(contradice ? { contradiceAlCliente: contradice.dicha } : {}) };
}

/**
 * R15/T7-001: lo que el cliente pidio y NO cambia el total pero SI el pedido (salsas pedidas, salsas quitadas, notas ya capturadas) para que el resumen canonico se lo muestre antes de su sí.
 * Solo lee lo que el modelo manda en cotizar_pedido (no entra a la huella ni a la firma de cierre): si no lo manda, el resumen queda como siempre.
 */
function detallesDeResumen(
  input: Record<string, unknown>,
  previo?: { readonly salsas?: readonly string[]; readonly sinSalsas?: readonly string[]; readonly notas?: string },
): { readonly salsas?: readonly string[]; readonly sinSalsas?: readonly string[]; readonly notas?: string } {
  const etiquetas = (v: unknown, canon: (x: unknown) => unknown): string[] => {
    if (!Array.isArray(v)) return [];
    const vistas = new Set<string>();
    for (const x of v) {
      const c = canon(x);
      const e = c === null ? null : etiquetaComplementoResumen(c);
      if (e) vistas.add(e);
    }
    return [...vistas];
  };
  // Como pago y propina: un campo que el modelo NO manda en esta cotizacion se hereda de la cotizacion vigente; uno mandado (incluso vacio) lo sustituye.
  // `null` es el relleno del modelo para «sin dato» (igual que omitir el campo): hereda. Vacio ([] o «») es una respuesta: sustituye.
  const salsas = input.requested_complements != null ? etiquetas(input.requested_complements, canonicalRequestedComplement) : [...(previo?.salsas ?? [])];
  const sinSalsas = input.omit_default_complements != null ? etiquetas(input.omit_default_complements, (x) => (typeof x === "string" && x.trim() !== "" ? x.trim() : null)) : [...(previo?.sinSalsas ?? [])];
  const notas = input.notes != null ? sanearNotaDeResumen(input.notes) : previo?.notas;
  return { ...(salsas.length > 0 ? { salsas } : {}), ...(sinSalsas.length > 0 ? { sinSalsas } : {}), ...(notas ? { notas } : {}) };
}

/** Respaldo SOLO para renglones sin categoria en el catalogo (filas antiguas): la regla principal es la categoria del producto (`CATEGORIAS_SIN_SALSA`). */
const SIN_SALSA_POR_NOMBRE = /\b(?:coca|cola|agua|refresco|jarritos|cerveza|limonada|topo\s+chico|sprite|fanta|boing|jugo|cafe|te\s+helado|sidral|pepsi|mineral|postre|flan|helado|pastel)\b/i;
/** Los crujientes (y las alitas) no traen las salsas basicas del taco; se reconocen por nombre aunque su categoria no sea de bebidas o postres. */
const CRUJIENTE_POR_NOMBRE = /\b(?:crujientes?)\b/i;

/** ¿El renglon lleva las salsas basicas? Por categoria del producto cuando se conoce; por nombre solo como respaldo. */
function renglonLlevaSalsas(l: { readonly name: string; readonly categoryName?: string | null }): boolean {
  if (CRUJIENTE_POR_NOMBRE.test(l.name)) return false;
  if (typeof l.categoryName === "string" && l.categoryName.trim() !== "") return !CATEGORIAS_SIN_SALSA.test(l.categoryName.trim());
  return !SIN_SALSA_POR_NOMBRE.test(l.name);
}

/** R21: salsas BASICAS del perfil que van en el pedido (las del perfil menos las que el cliente quito o excluyo en las notas), con su nombre para el cliente. Solo si algun renglon las lleva. */
function salsasBasicasDeResumen(input: Record<string, unknown>, previo: { readonly resumenBase?: { readonly sinSalsas?: readonly string[] } } | undefined, renglones: readonly { readonly name: string; readonly categoryName?: string | null }[]): readonly string[] {
  // Un pedido sin ningun renglon que lleve salsa (solo bebidas, postres o crujientes) no las muestra.
  if (renglones.length > 0 && !renglones.some(renglonLlevaSalsas)) return [];
  const quitadas = new Set<string>();
  const omitidas = input.omit_default_complements != null ? (Array.isArray(input.omit_default_complements) ? input.omit_default_complements : []) : [];
  for (const o of omitidas) if (typeof o === "string") quitadas.add(o === "cebolla" ? "cebolla_cilantro" : o);
  for (const x of complementosExcluidosEnNotas(input.notes)) quitadas.add(x);
  const etiquetasPrevias = new Set(input.omit_default_complements != null ? [] : (previo?.resumenBase?.sinSalsas ?? []));
  return PM_BASIC_COMPLEMENTS.filter((c) => !quitadas.has(c))
    .map((c) => etiquetaComplementoResumen(c))
    .filter((e): e is string => e !== null && !etiquetasPrevias.has(e));
}

function avisoHoraDistinta(dicha: string): string {
  return `La última hora que dijo el cliente es ${dicha}, pero esta cotización quedó con otra. NO muestre este resumen todavía: vuelva a llamar cotizar_pedido con la hora del cliente (hora_recogida o programado_para; en recoger la misma hora en las dos llamadas). Si el cliente hablaba de otra cosa y la hora cotizada es la correcta, ignore este aviso.`;
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
  const plazoValido = Number.isFinite(minutos) && Number.isInteger(minutos) && minutos >= 1 && minutos <= MINUTOS_PARA_RECOGER_MAX;
  // QA-PM-R5-reglas-08: un plazo invalido (negativo, fraccion, texto, gigante) se ignoraba en silencio y el pedido salia "para ya". 0, vacio o null siguen siendo "sin dato".
  const sinDato = crudo === undefined || crudo === null || crudo === 0 || (typeof crudo === "string" && (crudo.trim() === "" || Number(crudo) === 0));
  if (!plazoValido && !sinDato) {
    throw new OrderValidationError(`minutos_para_recoger debe ser un número entero de minutos entre 1 y ${MINUTOS_PARA_RECOGER_MAX} (por ejemplo 40). Si el cliente no dio un plazo ("en cuanto esté"), no mande el campo; si dio una hora exacta, mande hora_recogida.`);
  }
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

/** Forma de pago y efectivo_con de una cotizacion: lo que manda el modelo; si lo omite se conserva el de la cotizacion vigente. Tarjeta descarta el efectivo_con (es relleno). */
function pagoDeCotizacion(input: Record<string, unknown>, previo: OrderFlowContext | undefined): { quotedPago?: "efectivo" | "tarjeta"; quotedEfectivoCon?: number } {
  const dado = input.payment_method === "efectivo" || input.payment_method === "tarjeta" ? input.payment_method : undefined;
  const quotedPago = dado ?? previo?.quotedPago;
  const efDado = typeof input.efectivo_con === "number" && input.efectivo_con > 0 ? input.efectivo_con : undefined;
  const quotedEfectivoCon = quotedPago === "tarjeta" ? undefined : (efDado ?? previo?.quotedEfectivoCon);
  return { ...(quotedPago ? { quotedPago } : {}), ...(quotedEfectivoCon !== undefined ? { quotedEfectivoCon } : {}) };
}

/** R11: propina de una cotizacion (pesos o porcentaje). Lo que manda el modelo; si no la menciona se conserva la de la cotizacion vigente; 0 / "sin propina" la quita. */
function propinaDeCotizacion(input: Record<string, unknown>, previo: OrderFlowContext | undefined): { quotedPropinaMxn?: number; quotedPropinaPct?: number } {
  const hayMonto = input.propina !== undefined && input.propina !== null;
  const hayPct = input.propina_porcentaje !== undefined && input.propina_porcentaje !== null;
  if (!hayMonto && !hayPct) {
    return { ...(previo?.quotedPropinaMxn !== undefined ? { quotedPropinaMxn: previo.quotedPropinaMxn } : {}), ...(previo?.quotedPropinaPct !== undefined ? { quotedPropinaPct: previo.quotedPropinaPct } : {}) };
  }
  if (typeof input.propina === "number" && input.propina > 0) return { quotedPropinaMxn: input.propina };
  const pct = porcentajeDePropina(input.propina_porcentaje) ?? (typeof input.propina === "string" ? porcentajeDePropina(input.propina) : null);
  return pct !== null ? { quotedPropinaPct: pct } : {};
}

/** Texto que acompana a `resumen_canonico` (solo con la maquina de cierre activa). */
const INSTRUCCION_RESUMEN_CANONICO =
  "Cuando ya tenga todos los datos (producto, entrega, pago y, si aplica, propina), muéstrele al cliente el RESUMEN COPIANDO `resumen_canonico` TAL CUAL (puede anteponer una frase corta y amable; no cambie renglones, cifras ni la pregunta final). No llame confirmar_resumen en este turno: espere el «sí» del cliente en su mensaje siguiente. El resumen solo muestra las salsas pedidas (requested_complements), las quitadas (omit_default_complements) y las notas (notes) que usted mandó en cotizar_pedido: mándelos ahí con los mismos valores que mandará en crear_pedido. Si el cliente quita o cambia una salsa o una nota, mande la lista completa (incluso vacía) en cotizar_pedido; omitir el campo conserva lo anterior. Un dato de pago o propina NO es el «sí»: guárdelo, vuelva a llamar cotizar_pedido con ese dato (payment_method, efectivo_con, propina o propina_porcentaje) y muestre el resumen nuevo.";

const CONFLICT_MESSAGE ="La conversación se está procesando en otro lugar; vuelve a intentar en un momento.";

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
async function runWithOrderFlow(repo: RestaurantesRepository, ctx: AgentToolContext, flow: OrderFlowRef, name: string, input: Record<string, unknown>, opts: InvokeAgentToolOpts = {}): Promise<AgentToolOutcome> {
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
    // QA-PM-R5-reglas-03: la tortilla elegida para un kilo se guarda en el renglon cotizado (sin tocar la huella) para que llegue a la comanda al crear.
    const quotedItems = resolverRenglonesCotizados(itemsCotizados, quotedQuote.lines)?.map((q, idx) =>
      q.tortilla === null && itemsCotizados[idx]?.tortilla && pesoDeProductoEnGramos(q.name) !== null ? { ...q, tortillaKilo: itemsCotizados[idx]!.tortilla as string } : q,
    );
    const huellaCotizacion = (hora: string | undefined): string =>
      fingerprintOrder({
        branchSlug: String(input.branch_slug ?? ""),
        canal: canalOf(input.canal),
        adultConfirmed: input.adult_confirmed === true,
        items: quotedItems ? itemsDeHuella(quotedItems) : itemsCotizados,
        doubleSalsas: toDoubleSalsas(input.doble_salsas),
        programadoPara: input.canal === "recoger" ? undefined : toProgramadoPara(input.programado_para),
        horaRecogida: input.canal === "recoger" && toProgramadoPara(input.programado_para) ? horaUnificadaRecoger(input) : hora,
      });
    const plazoServidor = typeof input.plazo_minutos_servidor === "number" ? input.plazo_minutos_servidor : undefined;
    let horaCotizacion = input.canal === "recoger" ? horaUnificadaRecoger(input) : toHoraRecogida(input.hora_recogida);
    // R13: tambien a domicilio se guarda la hora cotizada (el eco de crear_pedido en UTC no se rechaza); la lectura de crear solo la usa en recoger.
    const programadoCotizado = toProgramadoPara(input.programado_para);
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
      // QA-PM-R6-voz-01: un pedido IGUAL del mismo telefono de hace pocos minutos (otra llamada / otro chat) no se duplica en silencio: el modelo debe preguntar si es el mismo.
      // Solo con un flujo SIN estado (llamada o chat nuevo): dentro de un mismo flujo ya rigen `ya_registrado` y `otro_pedido`.
      // Con telefono DECLARADO por el cliente (caller ID no confiable) no se consulta nada del numero: seria filtrar pedidos de un tercero.
      if (!snap.state && input.otro_pedido !== true && ctx.phone && !ctx.phoneDeclared && ctx.modo !== "preview") {
        const reciente = await repo.findLatestOrderByPhone(ctx.organizationId, normalizePhone(ctx.phone), new Date(flowNow(flow) - VENTANA_PEDIDO_IGUAL_MIN * 60_000).toISOString());
        if (reciente && reciente.status !== "cancelado" && reciente.status !== "no_recogido" && mismosRenglones(reciente.items, quotedQuote.lines)) {
          const hace = Math.max(0, Math.round((flowNow(flow) - Date.parse(reciente.createdAt)) / 60_000));
          throw new OrderValidationError(
            `Este cliente ya tiene un pedido IGUAL registrado hace ${hace} minuto(s)${reciente.orderNumber ? ` (folio #${reciente.orderNumber})` : ""} por $${reciente.total}. NO lo cotice ni lo cree otra vez. Dígale que ese pedido ya está registrado y pregúntele si es el mismo o si quiere OTRO igual; solo si pide otro, vuelva a llamar cotizar_pedido con otro_pedido: true.`,
          );
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
      // Pago y efectivo_con NO entran a la huella, pero son parte de lo que el cliente debe ver y aceptar: cotizar temprano (sin pago) y re-cotizar con pago en el turno del "confirmo" ya no
      // hereda el turno de la cotizacion anterior (si no, confirmar_resumen y crear_pedido pasaban sin que el cliente viera nunca el resumen con su pago). Omitirlos conserva los previos.
      const previoVigente = previo && (snap.state === "cotizado" || snap.state === "confirmado") && flowNow(flow) - previo.quotedAtMs <= QUOTE_TTL_MS ? previo : undefined;
      const pagoCotizado = pagoDeCotizacion(input, previoVigente);
      const propinaCotizada = propinaDeCotizacion(input, previoVigente);
      // R11: con la maquina de cierre activa el SERVIDOR arma el texto del resumen (renglones, entrega, pago, propina y total) y se lo entrega al modelo para que lo pegue tal cual.
      const datosVigentes = ctx.channel === "whatsapp" ? datosDeCierreSiWhatsapp(ctx, input, previoVigente?.datosCierre) : undefined;
      const horaYDireccion = cierreMaquinaActiva() && ctx.channel === "whatsapp" ? await horaYDireccionDeResumen(repo, ctx, input, horaCotizacion, flowNow(flow), datosVigentes?.customerAddress) : {};
      const resumenBase =
        cierreMaquinaActiva() && ctx.channel === "whatsapp"
          ? {
              // R15/T7-001: la tortilla de un KILO no vive en el renglon cotizado (`tortilla` es null): sale de lo que el cliente eligio (`quotedItems[idx].tortillaKilo`, por indice: dos renglones del mismo producto con tortillas distintas no se mezclan).
              lineas: quotedQuote.lines.map((l, idx) => ({ name: l.name, quantity: l.quantity, lineTotal: l.lineTotal, tortilla: l.tortilla ?? (quotedItems?.[idx]?.id === l.productId ? quotedItems[idx]!.tortillaKilo : undefined) ?? null })),
              ...detallesDeResumen(input, previoVigente?.resumenBase),
              total: quotedQuote.total,
              descuento: quotedQuote.descuento,
              canal: canalOf(input.canal),
              ...(({ contradiceAlCliente: _c, ...resto }) => resto)(horaYDireccion),
              basicas: salsasBasicasDeResumen(input, previoVigente, quotedQuote.lines),
            }
          : undefined;
      const canonico = resumenBase
        ? resumenCanonico({ ...resumenBase, datos: { pago: pagoCotizado.quotedPago, efectivoCon: pagoCotizado.quotedEfectivoCon, propinaMxn: propinaCotizada.quotedPropinaMxn, propinaPct: propinaCotizada.quotedPropinaPct } })
        : undefined;
      // R21: si el cliente dijo otra hora que la cotizada, el resultado lo avisa para que el modelo vuelva a cotizar con la hora del cliente ANTES de mostrar el resumen.
      // Tope: UNA sola vez por turno. Si ya hubo una cotizacion en ESTE turno (la que disparo el aviso), la re-cotizacion no lo repite: evita ciclos de recotizacion si el modelo insiste en la hora cotizada.
      const yaCotizadoEnEsteTurno = flow.turn !== null && previo?.quotedTurn === flow.turn;
      const avisoHora = !yaCotizadoEnEsteTurno && "contradiceAlCliente" in horaYDireccion && horaYDireccion.contradiceAlCliente ? { hora_distinta_a_la_del_cliente: true, aviso_hora: avisoHoraDistinta(horaYDireccion.contradiceAlCliente) } : {};
      const conCanonico = (r: object, texto: string | undefined = canonico): object => (texto ? { ...r, ...avisoHora, resumen_canonico: texto, instruccion_resumen: INSTRUCCION_RESUMEN_CANONICO } : { ...r, ...avisoHora });
      if (
        previo &&
        (snap.state === "cotizado" || snap.state === "confirmado") &&
        previo.quoteHash === quoteHash &&
        previo.quotedPrices === quotedPrices &&
        previo.quotedTotal === quotedQuote.total &&
        previo.quotedPago === pagoCotizado.quotedPago &&
        previo.quotedEfectivoCon === pagoCotizado.quotedEfectivoCon &&
        previo.quotedPropinaMxn === propinaCotizada.quotedPropinaMxn &&
        previo.quotedPropinaPct === propinaCotizada.quotedPropinaPct &&
        flowNow(flow) - previo.quotedAtMs <= QUOTE_TTL_MS
      ) {
        // El historial de WhatsApp no trae los resultados de herramientas: en el turno del "si" el modelo busca y cotiza de nuevo y despues repite el resumen
        // en vez de cerrar (R2W14: 4 turnos de resumen sin crear). Si esta cotizacion YA se mostro en un turno anterior, se le dice el siguiente paso.
        // Una cotizacion TEMPRANA (antes del resumen) no es "ya mostrada": con historial disponible (WhatsApp) solo cuenta si un mensaje del asistente trae su total.
        const vistoEnHistorial = resumenMostradoEnHistorial(previo.quotedTotal, ctx.conversacionReciente);
        const yaMostrada = previo.quotedTurn !== null && flow.turn !== null && previo.quotedTurn !== flow.turn && vistoEnHistorial !== false;
        const aviso = yaMostrada ? { ya_mostrada_al_cliente: true, siguiente_paso: SIGUIENTE_PASO_COTIZACION_REPETIDA } : {};
        // R15: si esta re-cotizacion cambia lo que el resumen muestra (salsas, «Sin», notas) y el cliente AUN no lo ha visto (estado «cotizado»), el servidor guarda el resumen nuevo (sin tocar
        // el turno de la cotizacion): el que se muestre y el que se compare al confirmar son el mismo. Si ya se mostro, o ya esta «confirmado» (la firma no cubre salsas ni notas), NO se reescribe
        // y se devuelve el texto GUARDADO: el modelo nunca pega una version distinta a la que el servidor compara. Si la escritura no se guarda, no se devuelve el resumen nuevo.
        let textoVigente = canonico;
        // PM R18: una re-cotizacion identica puede traer datos nuevos (nombre, direccion...): se guardan para el cierre determinista sin tocar la cotizacion ni su turno.
        const datosFusionados = datosDeCierreSiWhatsapp(ctx, input, previo.datosCierre);
        let versionVigente = snap.version;
        let previoVigenteEscrito: OrderFlowContext = previo;
        if (JSON.stringify(datosFusionados ?? {}) !== JSON.stringify(previo.datosCierre ?? {})) {
          previoVigenteEscrito = { ...previo, datosCierre: datosFusionados };
          const guardado = await writeFlow(repo, ctx, flow, snap.version, snap.state, previoVigenteEscrito);
          if (guardado === "conflict") continue;
          if (guardado === "written") versionVigente = snap.version + 1;
          else previoVigenteEscrito = previo;
        }
        if (canonico && resumenBase && canonico !== previo.resumenCanonico) {
          if (yaMostrada || snap.state !== "cotizado") {
            textoVigente = previo.resumenCanonico;
          } else {
            const reescrito = await writeFlow(repo, ctx, flow, versionVigente, snap.state, { ...previoVigenteEscrito, resumenCanonico: canonico, resumenBase });
            if (reescrito === "conflict") continue;
            if (reescrito === "unavailable") return outcome;
          }
        }
        return { ...outcome, result: conCanonico({ ...(outcome.result as object), quote_hash: quoteHash, ...aviso }, textoVigente), quoteHash };
      }
      const res = await writeFlow(repo, ctx, flow, snap.version, "cotizado", {
        quoteHash,
        quotedAtMs: flowNow(flow),
        quotedTurn: flow.turn,
        quotedPrices,
        ...(pagoCotizado.quotedPago ? { quotedPago: pagoCotizado.quotedPago } : {}),
        ...(pagoCotizado.quotedEfectivoCon !== undefined ? { quotedEfectivoCon: pagoCotizado.quotedEfectivoCon } : {}),
        ...propinaCotizada,
        ...(canonico && resumenBase ? { resumenCanonico: canonico, resumenBase } : {}),
        ...(quotedItems ? { quotedItems, quotedBranchSlug: String(input.branch_slug ?? ""), quotedCanal: canalOf(input.canal), ...(cartHash ? { cartHash } : {}) } : {}),
        datosCierre: datosDeCierreSiWhatsapp(ctx, input, previoVigente?.datosCierre),
        ...(horaCotizacion ? { horaRecogida: horaCotizacion } : {}),
        ...(programadoCotizado ? { programadoPara: programadoCotizado } : {}),
        ...(horaCotizacion && plazoServidor !== undefined ? { minutosPlazo: plazoServidor } : {}),
        quotedTotal: quotedQuote.total,
        quotedAmounts: knownAmountsOfQuote(quotedQuote).slice(0, 60),
        ...(snap.context?.sessionTotal ? { sessionTotal: snap.context.sessionTotal, sessionPesoKg: snap.context.sessionPesoKg ?? 0, sessionPedidos: snap.context.sessionPedidos ?? 0, ...(snap.context.sessionUltimoPedidoId ? { sessionUltimoPedidoId: snap.context.sessionUltimoPedidoId } : {}) } : {}),
      });
      if (res === "written") return { ...outcome, result: conCanonico({ ...(outcome.result as object), quote_hash: quoteHash }), quoteHash };
      if (res === "unavailable") return outcome;
    }
    throw new OrderValidationError(CONFLICT_MESSAGE);
  }

  if (name === "confirmar_resumen") {
    // QA-PM-R6 (A13): en WhatsApp, si el ultimo mensaje del cliente rechaza el resumen no se confirma (el modelo lo confirmaba tras «No, así no»).
    const ultimoDelCliente = ctx.channel === "whatsapp" ? [...(ctx.conversacionReciente ?? [])].reverse().find((m) => m.role === "user")?.content : undefined;
    if (rechazaElResumen(ultimoDelCliente)) {
      throw new OrderFlowViolationError("cliente_rechazo_resumen", "El último mensaje del cliente rechaza o corrige el resumen: NO confirmes ni crees el pedido. Pregúntale qué desea cambiar (sin discutir el precio), vuelve a cotizar con lo que corrija y pide su confirmación otra vez. No digas que el pedido quedó registrado.");
    }
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
      // R11: cierre como maquina de estados. Con historial de WhatsApp el servidor exige que el ULTIMO mensaje del asistente sea el resumen vigente y que el ultimo del cliente sea un «si»
      // explicito. La negativa se devuelve como RESULTADO (no como excepcion): el SAVEPOINT revertiria la marca de «ambiguo» que habilita la salida segura del turno siguiente.
      const cierreOn = cierreMaquinaActiva() && ctx.channel === "whatsapp" && ctx.conversacionReciente !== undefined;
      if (cierreOn) {
        const decision = decidirConfirmacion({ ctx: current, historial: ctx.conversacionReciente!, turn: flow.turn, canonico: current.resumenCanonico });
        if (!decision.ok) {
          // Respuesta de pago / propina: el servidor ADOPTA el dato (avanza), vuelve a `cotizado` y rearma el resumen; el modelo solo lo muestra. Nunca confirma.
          if (decision.datosNuevos && current.resumenBase) {
            const d = decision.datosNuevos;
            const nuevo = resumenCanonico({ ...current.resumenBase, datos: d });
            await writeFlow(repo, ctx, flow, snap.version, "cotizado", {
              ...current,
              ...(d.pago ? { quotedPago: d.pago } : {}),
              quotedEfectivoCon: d.efectivoCon,
              quotedPropinaMxn: d.propinaMxn,
              quotedPropinaPct: d.propinaPct,
              resumenCanonico: nuevo,
              cierreAmbiguoTurn: undefined,
            });
            return {
              result: { error: `${decision.mensaje} El sistema ya guardó el dato (pago / efectivo / propina) y actualizó el resumen. Muéstreselo AHORA al cliente, copiado tal cual, y espere su sí en el mensaje siguiente:\n${nuevo}`, resumen_canonico: nuevo, resumen_total: current.resumenBase.total },
              orderId: null,
              propertyId: null,
              rechazoDelFlujo: decision.code,
            };
          }
          if (decision.marcarAmbiguo && flow.turn !== null && current.cierreAmbiguoTurn === undefined) {
            await writeFlow(repo, ctx, flow, snap.version, "cotizado", { ...current, cierreAmbiguoTurn: flow.turn });
          } else if (decision.marcarNoVisto && flow.turn !== null && current.cierreNoVistoTurn === undefined) {
            await writeFlow(repo, ctx, flow, snap.version, "cotizado", { ...current, cierreNoVistoTurn: flow.turn });
          }
          return { result: { error: decision.mensaje, ...(current.resumenCanonico ? { resumen_canonico: current.resumenCanonico, ...(current.resumenBase ? { resumen_total: current.resumenBase.total } : {}) } : {}) }, orderId: null, propertyId: null, rechazoDelFlujo: decision.code };
        }
      }
      const res = await writeFlow(repo, ctx, flow, snap.version, "confirmado", {
        ...current,
        confirmedAtMs: flowNow(flow),
        ...(cierreOn ? { confirmedFirma: firmaDeCierre(datosDeCierreDeContexto(current)), ...(flow.turn !== null ? { confirmedTurn: flow.turn } : {}) } : {}),
      });
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
      // Con hora cotizada, en recoger la hora es una sola (horaRecogida); sin ella, un programado agregado al crear SI cambia el pedido y obliga a re-cotizar.
      programadoPara: input.canal === "recoger" && horaRecogida !== undefined ? undefined : toProgramadoPara(input.programado_para),
      horaRecogida,
    });
  let claimed: { version: number; context: OrderFlowContext } | null = null;
  for (let attempt = 0; attempt < 3 && !claimed; attempt++) {
    const snap = await readFlow(repo, ctx, flow);
    if (snap === null) return dispatchTool(repo, ctx, name, input); // base sin migrar: camino anterior
    // La hora de recogida solo cuenta si la cotizacion la llevaba (una hora que el modelo agrega al crear la valida el servidor, pero no cambia lo que el cliente vio);
    // si crear la omite se entiende la cotizada. Una hora DISTINTA a la cotizada obliga a re-cotizar.
    const horaCotizada = snap.context?.horaRecogida;
    // QA-PM-R5-reglas-02: si la cotizacion fue PROGRAMADA y el modelo crea con la misma hora (como hora_recogida, o sin ninguna), el pedido se crea como programado con la hora cotizada.
    const programadoCotizado = snap.context?.programadoPara;
    if (input.canal === "recoger" && programadoCotizado && horaCotizada) {
      const efectiva = horaUnificadaRecoger(input);
      if (efectiva === undefined || efectiva === horaCotizada) input = { ...input, programado_para: programadoCotizado };
    }
    const cotizados = snap.context?.quotedItems && snap.context.quotedItems.length > 0 ? snap.context.quotedItems : undefined;
    // Revision de #528: la tortilla de un KILO no entra a la huella; si el cliente la cambia al crear (cotizo harina, crea maiz) la comanda llevaria la cotizada sin avisar.
    // Se rechaza ANTES de reclamar el pedido y se pide re-cotizar con la tortilla que el cliente quiere.
    if (cotizados?.some((q) => q.tortillaKilo)) {
      const pedidos = toRequestedItems(input.items, lenient);
      cotizados.forEach((q, idx) => {
        const alCrear = pedidos[idx]?.tortilla;
        if (q.tortillaKilo && alCrear && alCrear !== q.tortillaKilo) {
          throw new OrderValidationError(`La tortilla de "${q.name}" cambió (se cotizó ${q.tortillaKilo} y ahora piden ${alCrear}). Vuelva a cotizar el pedido con la tortilla que quiere el cliente y pida su confirmación.`);
        }
      });
    }
    const fingerprint = huellaConHora(horaCotizada ? ((input.canal === "recoger" ? horaUnificadaRecoger(input) : toHoraRecogida(input.hora_recogida)) ?? horaCotizada) : undefined, cotizados, await ajenosAlCotizar(cotizados));
    // Voz: un reintento del MISMO pedido ya creado (el worker corto la espera y el servidor si lo registro) devuelve el pedido
    // existente con su id, para que la llamada cuente el objetivo y el agente no le diga al cliente que fallo.
    if (ctx.channel === "voz" && snap.state === "creado" && snap.context?.orderId && snap.context.quoteHash === fingerprint) {
      const existente = await repo.findOrderById(ctx.organizationId, snap.context.orderId);
      if (existente) return { result: { order: orderToWire(existente), ya_registrado: true }, raw: existente, orderId: existente.id, propertyId: existente.propertyId, yaRegistrado: true };
    }
    const current = assertCanCreate(snap, { now: flowNow(flow), turn: flow.turn, fingerprint });
    // R11: cierre como maquina de estados. (1) pago / efectivo / propina deben ser los del resumen confirmado; (2) si la confirmacion es de un turno ANTERIOR y el cliente despues rechazo o
    // cambio el pedido, se vuelve a cotizado. Resultados (no excepciones) por el SAVEPOINT. Un reclamo viejo (`creando`) que se retoma NO se vuelve a revisar: ya paso por aqui.
    if (cierreMaquinaActiva() && ctx.channel === "whatsapp" && snap.state === "confirmado" && current.confirmedFirma !== undefined) {
      const datos = datosDeCierreDeEntrada(input, current);
      if (firmaDeCierre(datos) !== current.confirmedFirma) {
        // El servidor adopta el dato nuevo, vuelve a `cotizado` y rearma el resumen: el modelo solo tiene que mostrarlo y esperar el sí (no depende de que re-cotice bien).
        const nuevoCanonico = current.resumenBase ? resumenCanonico({ ...current.resumenBase, datos }) : undefined;
        await writeFlow(repo, ctx, flow, snap.version, "cotizado", {
          ...current,
          ...(datos.pago ? { quotedPago: datos.pago } : {}),
          quotedEfectivoCon: datos.efectivoCon,
          quotedPropinaMxn: datos.propinaMxn,
          quotedPropinaPct: datos.propinaPct,
          quotedTurn: flow.turn,
          confirmedAtMs: undefined,
          confirmedFirma: undefined,
          confirmedTurn: undefined,
          cierreAmbiguoTurn: undefined,
          ...(nuevoCanonico ? { resumenCanonico: nuevoCanonico } : {}),
        });
        return {
          result: { error: mensajeDatosCambiaron(nuevoCanonico), ...(nuevoCanonico ? { resumen_canonico: nuevoCanonico, resumen_total: current.resumenBase!.total } : {}) },
          orderId: null,
          propertyId: null,
          rechazoDelFlujo: "cierre_datos_cambiaron",
        };
      }
      if (ctx.conversacionReciente !== undefined && flow.turn !== null && current.confirmedTurn !== flow.turn) {
        const ultimoCliente = [...ctx.conversacionReciente].reverse().find((m) => m.role === "user")?.content;
        const clase = clasificarRespuestaCierre(ultimoCliente, { despuesDelResumen: false });
        if (clase === "no" || clase === "cambio") {
          await writeFlow(repo, ctx, flow, snap.version, "cotizado", { ...current, confirmedAtMs: undefined, confirmedFirma: undefined, confirmedTurn: undefined, quotedTurn: flow.turn });
          return {
            result: { error: "NO se creó el pedido: después de confirmar, el cliente rechazó o quiere cambiar algo. Aplique el cambio, vuelva a llamar cotizar_pedido, muéstrele el resumen nuevo y espere su sí.", ...(current.resumenCanonico ? { resumen_canonico_anterior: current.resumenCanonico } : {}) },
            orderId: null,
            propertyId: null,
            rechazoDelFlujo: "cierre_sin_si_explicito",
          };
        }
      }
      // La propina que el cliente vio en el resumen viaja al pedido aunque el modelo no la repita.
      if (datos.heredaPropina && (datos.propinaMxn !== undefined || datos.propinaPct !== undefined)) {
        input = { ...input, ...(datos.propinaMxn !== undefined ? { propina: datos.propinaMxn } : { propina_porcentaje: datos.propinaPct }) };
      }
    }
    // Guarda de #566 / QA-PM-R10 §6. Corre con la maquina de cierre APAGADA, o encendida pero con una confirmacion que no paso por ella (sin `confirmedFirma`).
    // Con la maquina encendida y su firma, el bloque de arriba la sustituye (misma idea, mas estricta) y esta NO corre: asi las dos guardas nunca se contradicen.
    // Con historial de WhatsApp, el cliente tiene que haber VISTO el resumen y su ultimo mensaje no puede ser solo el pago o la propina. Sin historial (voz) no aplica.
    // Dos causas de rechazo, con UNA misma salida acotada contra el deadlock:
    //  - totalNoVisto: ningun mensaje del asistente trae el total (heuristica de texto con falsos negativos: total en letras, otro formato, resumen fuera de la ventana).
    //  - soloPago: el ultimo mensaje del cliente es solo pago/propina Y el ultimo mensaje del asistente NO traia el total (no era el resumen). Si el asistente acababa de mostrar el resumen y pedir confirmacion,
    //    «No gracias» / «Efectivo» / «con 600» son la respuesta a su «¿Es correcto?», es decir el sí, y NO se rechazan (antes: deadlock sin limite).
    //  El primer rechazo guarda el turno en el flujo (sobrevive al SAVEPOINT); en un turno POSTERIOR ya no se rechaza. El cierre se retrasa a lo mucho un turno, nunca se traba.
    else if (snap.state === "confirmado" && flow.turn !== null && ctx.conversacionReciente !== undefined) {
      const ultimoDelCliente = [...ctx.conversacionReciente].reverse().find((m) => m.role === "user")?.content;
      const ultimoDelAsistente = [...ctx.conversacionReciente].reverse().find((m) => m.role === "assistant")?.content;
      const soloPago = esRespuestaDePagoOPropina(ultimoDelCliente) && !asistentePidioConfirmarResumen(current.quotedTotal, ultimoDelAsistente);
      const totalNoVisto = resumenMostradoEnHistorial(current.quotedTotal, ctx.conversacionReciente) === false;
      const salidaAbierta = current.resumenRechazadoTurn !== undefined && current.resumenRechazadoTurn !== flow.turn;
      if ((soloPago || totalNoVisto) && !salidaAbierta) {
        if (current.resumenRechazadoTurn === undefined) await writeFlow(repo, ctx, flow, snap.version, "confirmado", { ...current, resumenRechazadoTurn: flow.turn });
        const mensaje =
          "El cliente todavía no ha visto el resumen final con el total, o su último mensaje es solo el pago o la propina (eso NO es el sí). NO se creó el pedido. Muéstrele ahora el resumen completo en lista (renglones, total a pagar, forma de pago) y pregúntele si confirma; espere su sí en el mensaje siguiente y entonces llame crear_pedido.";
        if (opts.rechazoComoResultado) return { result: { error: mensaje }, orderId: null, propertyId: null, rechazoDelFlujo: "resumen_no_mostrado" };
        throw new OrderFlowViolationError("resumen_no_mostrado", mensaje);
      }
    }
    const claimCtx: OrderFlowContext = { ...current, claimedAtMs: flowNow(flow) };
    const res = await writeFlow(repo, ctx, flow, snap.version, "creando", claimCtx);
    if (res === "written") claimed = { version: snap.version + 1, context: claimCtx };
    else if (res === "unavailable") return dispatchTool(repo, ctx, name, input);
  }
  if (!claimed) throw new OrderValidationError(CONFLICT_MESSAGE);

  try {
    // El pedido se crea con los renglones COTIZADOS (id y nombre del catalogo): si el modelo mando `product_id` vacio o un nombre aproximado, no se rechaza ni se reintenta (QA-PM-R3-whatsapp-07).
    const conciliados = claimed.context.quotedItems?.length ? reconciliarConCotizacion(toRequestedItems(input.items, lenient), claimed.context.quotedItems, await ajenosAlCotizar(claimed.context.quotedItems)) : null;
    const cotizadosReclamados = claimed.context.quotedItems;
    const inputConciliado: Record<string, unknown> = conciliados
      ? {
          ...input,
          items: conciliados.map((i, idx) => {
            // Kilo de carne: la tortilla viene del renglon cotizado o, si no, de lo que mande el modelo al crear (el renglon no la exige pero la comanda debe llevarla).
            const tortillaKilo = i.tortilla ? undefined : (cotizadosReclamados?.find((q) => q.id === i.productId && q.tortillaKilo)?.tortillaKilo ?? (pesoDeProductoEnGramos(i.productName ?? "") !== null ? toRequestedItems(input.items, lenient)[idx]?.tortilla : undefined));
            return { product_id: i.productId, product_name: i.productName, requested_quantity: i.requestedQuantity, ...(i.tortilla ? { tortilla: i.tortilla } : tortillaKilo ? { tortilla: tortillaKilo } : {}) };
          }),
        }
      : input;
    let outcome = await dispatchTool(repo, ctx, name, inputConciliado, claimed.context.quotedPrices, { total: claimed.context.sessionTotal ?? 0, pesoKg: claimed.context.sessionPesoKg ?? 0, pedidos: claimed.context.sessionPedidos ?? 0, ...(claimed.context.sessionUltimoPedidoId ? { ultimoPedidoId: claimed.context.sessionUltimoPedidoId } : {}) }, claimed.context.quotedTotal);
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
    // PM R18: ya creado, el nombre y la direccion guardados para el cierre determinista dejan de hacer falta (el pedido los tiene): no se arrastran en el estado.
    const { datosCierre: _datosYaUsados, ...contextoCreado } = claimed.context;
    await writeFlow(repo, ctx, flow, claimed.version, "creado", { ...contextoCreado, ...acumulado, orderId: outcome.orderId ?? undefined });
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
/** R12-03: el cliente confirmo un TOTAL (con la promocion de ese momento). Los precios de renglon pueden seguir iguales y aun asi el total subir (la promocion vencio, cambio de dia, la apagaron):
 * cobrar mas de lo confirmado se rechaza y se pide re-cotizar. Un total MENOR (descuento nuevo) no perjudica al cliente y se deja pasar. */
function assertTotalNoSubio(prepared: { readonly total: number }, expectedTotal: number | undefined): void {
  if (typeof expectedTotal === "number" && Number.isFinite(expectedTotal) && prepared.total > expectedTotal + 0.004) {
    throw new OrderFlowViolationError("precio_cambio", `El total cambió después de que el cliente confirmó (era $${expectedTotal.toFixed(2)} y ahora sería $${prepared.total.toFixed(2)}: una promoción o un precio ya no aplica). Vuelva a cotizar, dígale el total actualizado y pida su confirmación otra vez.`);
  }
}

async function simulatePreviewOrder(repo: RestaurantesRepository, ctx: AgentToolContext, createInput: CreateOrderInput, expectedPrices: string | undefined, expectedTotal?: number): Promise<AgentToolOutcome> {
  const prepared = await prepareCreateOrder(repo, createInput);
  if (expectedPrices && priceSignature(prepared.orderItems) !== expectedPrices) {
    throw new OrderFlowViolationError("precio_cambio", "Los precios del menú cambiaron después de que confirmaste. Vuelve a revisar tu pedido para ver el total actualizado.");
  }
  assertTotalNoSubio(prepared, expectedTotal);
  // Pedido grande (PM): el preview muestra lo mismo que haria el real (el pedido NO se crea), pero sin dejar el aviso para la sucursal.
  try {
    await assertNoEsPedidoGrande(repo, prepared);
  } catch (err) {
    if (!(err instanceof PedidoGrandeRetenidoError)) throw err;
    const retenido = { pedido_grande: true, escalado: true, estado: "por_confirmar_por_la_sucursal", simulado: true, mensaje: "Este pedido supera el umbral de pedido grande: en el servicio real NO se mandaría a cocina y se avisaría a la sucursal para confirmarlo (en el preview no se crea ningún aviso).", mensaje_al_cliente: MENSAJE_PEDIDO_GRANDE_PENDIENTE };
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
    items: prepared.renglonesPersistidos,
    ...(prepared.payload.propina ? { propina: prepared.payload.propina } : {}),
    ...(prepared.payload.horaRecogida ? { hora_recogida: prepared.payload.horaRecogida } : {}),
    ...(prepared.payload.programadoPara ? { programado_para: prepared.payload.programadoPara } : {}),
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
  /** Total que el cliente vio y confirmo (solo crear_pedido con maquina de estados activa). Si al crear el total CALCULADO es mayor (una promocion dejo de aplicar), se pide re-cotizar. */
  expectedTotal?: number,
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
      const consulta = await lookupCustomerConPedidoReciente(repo, organizationId, ctx.phone);
      // QA-PM-R5-voz-04: sin `pedidoReciente` el resultado NO trae el estado de cocina y el modelo lo inventaba por voz («ya se esta preparando»). El servidor se lo dice en el propio resultado.
      const result = !consulta.isNew && consulta.pedidoReciente === undefined ? { ...consulta, aviso_estado_pedido: AVISO_SIN_ESTADO_DE_PEDIDO } : consulta;
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
      let ultimoPedido: ReturnType<typeof evaluarUltimoPedido> | null = null;
      const zonaCruda = (await repo.findBranchZonaHoraria(branch.propertyId)).zonaHoraria;
      const ahora = new Date();
      if (policy.horario && policy.horario.length > 0) {
        const estado = estaAbiertoAhora(policy.horario, ahora, zonaCruda);
        abierto = estado.abierto;
        cierraA = estado.cierraA;
        ultimoPedido = evaluarUltimoPedido(policy.horario, ahora, zonaCruda);
      }
      // Reloj LOCAL de la sucursal: el modelo (sobre todo el de voz, que no trae la hora en su prompt) calculaba "en 40 minutos" con la hora UTC y guardaba
      // la recogida 6 h tarde, o "hoy" dos dias atras (QA-PM-R2-voz-03 / reglas-04). Con esto calcula sobre la hora de la sucursal.
      const zona = resolverZonaHorariaNegocio(zonaCruda);
      // Ultimo pedido por TIPO (hora fija por sucursal: domicilio vs recoger). Sin hora fija configurada, todo sigue el margen general y estos campos repiten los de arriba.
      const up = ultimoPedido;
      const porTipo = up !== null && tieneUltimoPedidoPorTipo(up);
      const ultimoGeneralA = up === null ? null : porTipo ? (up.recoger.ultimoPedidoA ?? up.domicilio.ultimoPedidoA) : up.ultimoPedidoA;
      // Dia de NEGOCIO (no calendario): a las 00:30 del martes con turno del lunes abierto, "hoy" para diasDomicilio es lunes (mismo criterio que reglas-pedido.ts).
      const diaNegocioAhora = policy.horario && policy.horario.length > 0 ? aperturaConExcepciones(policy.horario, [], ahora, zonaCruda).diaNegocio : componentesLocales(ahora, zona).dia;
      const domicilioDisponible = evaluarDomicilioSucursal(policy, diaNegocioAhora).acepta;
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
        // Ultimo pedido (30 min antes del cierre por omision): abierta no es lo mismo que "todavia toma pedidos". Aditivo.
        // Con hora fija por tipo, `acepta_pedidos` = todavia se toma algun tipo y `ultimo_pedido_a` = el del tipo que cierra mas tarde (recoger); el detalle va en los campos por tipo.
        acepta_pedidos: up === null ? null : porTipo ? (domicilioDisponible && up.domicilio.aceptaPedidos) || up.recoger.aceptaPedidos : up.aceptaPedidos,
        ultimo_pedido_a: ultimoGeneralA,
        acepta_pedidos_domicilio: ultimoPedido ? domicilioDisponible && ultimoPedido.domicilio.aceptaPedidos : null,
        ultimo_pedido_domicilio_a: ultimoPedido && domicilioDisponible ? ultimoPedido.domicilio.ultimoPedidoA : null,
        acepta_pedidos_recoger: ultimoPedido ? ultimoPedido.recoger.aceptaPedidos : null,
        ultimo_pedido_recoger_a: ultimoPedido?.recoger.ultimoPedidoA ?? null,
        ultimo_pedido_por_tipo_configurado: porTipo ? true : false,
        // Frase lista para "¿siguen abiertos?" (cierre + ultimo pedido de cada tipo); null si la sucursal solo tiene el margen general. Misma frase en WhatsApp y voz.
        ultimo_pedido_frase: ultimoPedido ? fraseUltimoPedido(ultimoPedido, horaLegible, { domicilioDisponible }) : null,
        margen_ultimo_pedido_min: ultimoPedido?.margenMin ?? null,
        // Aditivo: "00:00" es la medianoche; el modelo debe decir "12 de la noche"/"medianoche", nunca "a las 00:00".
        cierra_a_texto: cierraA ? horaLegible(cierraA) : null,
        ultimo_pedido_a_texto: ultimoGeneralA ? horaLegible(ultimoGeneralA) : null,
        ultimo_pedido_domicilio_a_texto: ultimoPedido?.domicilio.ultimoPedidoA && domicilioDisponible ? horaLegible(ultimoPedido.domicilio.ultimoPedidoA) : null,
        ultimo_pedido_recoger_a_texto: ultimoPedido?.recoger.ultimoPedidoA ? horaLegible(ultimoPedido.recoger.ultimoPedidoA) : null,
        // Solo en voz: las horas ya dichas con palabras ("doce y media de la noche"); el sintetizador lee "00:30" como cifras sueltas.
        ...(ctx.channel === "voz"
          ? {
              hora_local_hablada: horaHablada(parte({ hour: "2-digit", minute: "2-digit" })),
              cierra_a_hablada: cierraA ? horaHablada(cierraA) : null,
              ultimo_pedido_a_hablada: ultimoGeneralA ? horaHablada(ultimoGeneralA) : null,
              ultimo_pedido_domicilio_a_hablada: ultimoPedido?.domicilio.ultimoPedidoA && domicilioDisponible ? horaHablada(ultimoPedido.domicilio.ultimoPedidoA) : null,
              ultimo_pedido_recoger_a_hablada: ultimoPedido?.recoger.ultimoPedidoA ? horaHablada(ultimoPedido.recoger.ultimoPedidoA) : null,
              ultimo_pedido_frase_hablada: ultimoPedido ? fraseUltimoPedido(ultimoPedido, horaHablada, { domicilioDisponible }) : null,
            }
          : {}),
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
        ...(perfilAgente === "taqueria_pm" && geocercasActivas() ? { geocercas: GEOCERCAS_PM } : {}), // paquete B: cobertura por poligono (PM)
        ...(ctx.entryPropertyId ? { sucursalDeEntregaPreferidaPropertyId: ctx.entryPropertyId } : {}),
        colonia: typeof input.colonia === "string" ? input.colonia : undefined,
        ...(lat !== undefined || lng !== undefined ? { lat, lng } : {}),
        ...(typeof input.max_km === "number" && Number.isFinite(input.max_km) && input.max_km > 0 ? { maxKm: input.max_km } : {}),
      });
      // QA-PM-R5-whatsapp-08: una colonia ESCRITA manda sobre el pin compartido (la colonia dicha despues del pin es una correccion), pero el servidor no sabe en que orden llegaron.
      // Si el pin compartido cae en OTRA sucursal que la de la colonia, se avisa al modelo para que le pregunte al cliente cual vale en vez de asignar en silencio.
      let conflictoPin: { readonly slug: string; readonly nombre: string } | null = null;
      if (match.estado === "asignada" && coloniaDicha && !coordenadasValidas && ctx.sharedLocation) {
        const porPin = await assignBranch(repo, {
          organizationId,
          radioMaximoKm: radioRepartoDelPerfil(perfilAgente, configAgente?.radioRepartoKm),
          ...(usarPropuestas ? { coordenadasPropuestas: COORDENADAS_PROPUESTAS_PM } : {}),
          ...(perfilAgente === "taqueria_pm" ? { sucursalesQueNoReparten: SUCURSALES_QUE_NO_REPARTEN_PM } : {}),
          ...(perfilAgente === "taqueria_pm" && geocercasActivas() ? { geocercas: GEOCERCAS_PM } : {}),
          lat: ctx.sharedLocation.lat,
          lng: ctx.sharedLocation.lng,
        });
        if (porPin.estado === "asignada" && porPin.branchSlug !== match.branchSlug) conflictoPin = { slug: porPin.branchSlug, nombre: porPin.branchName };
      }
      // H17 (QA-PM-R8 G5/T7-026/T7-049..051): si la sucursal que le toca al domicilio NO es la de este chat, el servidor lo dice con nombre y telefono para que el modelo no conteste
      // «si, entregamos» desde la sucursal equivocada ni omita el telefono.
      const otraSucursal = match.estado === "asignada" ? await sucursalDeOtroChat(repo, ctx, organizationId, match.branchSlug) : null;
      const otraReferencia = match.estado === "sugerida" && match.sugerida ? await sucursalDeOtroChat(repo, ctx, organizationId, match.sugerida.slug, false) : null;
      const result =
        match.estado === "asignada"
          ? {
              encontrada: true,
              estado: match.estado,
              ...(otraSucursal ? { atiende_otra_sucursal: otraSucursal } : {}),
              ...(conflictoPin
                ? {
                    pin_y_colonia_difieren: {
                      sucursal_por_pin: { branch_slug: conflictoPin.slug, branch_name: conflictoPin.nombre },
                      aviso: "La colonia que escribió el cliente y el pin que compartió caen en sucursales distintas. NO afirme cuál le toca ni una distancia: pregúntele cuál es la dirección de entrega correcta (la escrita o el pin) y vuelva a llamar buscar_sucursal_cercana con la que confirme (si es el pin, sin colonia).",
                    },
                  }
                : {}),
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
          : match.estado === "fuera_de_zona" && match.ubicacionImplausible
            ? // QA-PM-R8 T7-002: pin a mas de 150 km de toda sucursal (coordenada mal formada o de otra ciudad). Sigue siendo `fuera_de_zona` y no se asigna, pero NO se nombra sucursal ni
              // distancia (el agente escalaba «por 2,922 km») y se le dice como pedir la ubicacion de nuevo.
              { encontrada: false, estado: match.estado, reparto: "ubicacion_implausible", ubicacion_sospechosa: true, mensaje: UBICACION_IMPLAUSIBLE_MENSAJE }
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
                  ...(otraReferencia ? { referencia_otra_sucursal: otraReferencia } : {}),
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
      const buscarUna = async (consulta: string) => {
      const productos = await searchProducts(repo, { propertyId: branch.propertyId, query: consulta });
      // QA-PM-R5-voz-01 / reglas-05: el modelo buscaba "arrachera kilo", veia solo "Arrachera — 1 kg" y cotizaba el kilo cuando el cliente pidio tres cuartos ($350 de mas), o decia que
      // "no existe" 1.25 kg. Cada renglon por peso lleva las presentaciones REALES del mismo platillo y la regla para fracciones que no existen.
      const hayPeso = productos.some((p) => pesoDeProductoEnGramos(p.name) !== null);
      const catalogo = hayPeso ? await repo.listAvailableProductsForBranch(branch.propertyId) : [];
      const baseDePeso = (nombre: string) => nombre.replace(/[—–-]\s*\d+(?:[.,]\d+)?\s*(?:kg|g|gr)\b.*$/i, "").trim().toLowerCase();
      const presentaciones = (nombre: string): string[] =>
        catalogo
          .filter((c) => pesoDeProductoEnGramos(c.name) !== null && baseDePeso(c.name) === baseDePeso(nombre))
          .sort((a, b) => (pesoDeProductoEnGramos(a.name) ?? 0) - (pesoDeProductoEnGramos(b.name) ?? 0))
          .map((c) => `${c.name} ($${Number(c.price)})`);
      // L2b: un peso que no es presentacion exacta (1.25 kg) llega ya armado con presentaciones reales y precio proporcional, para decirlo ANTES del si.
      const pesoPedido = hayPeso ? pesoPedidoEnConsulta(consulta) : null;
      return productos.map((p) => {
        const otras = pesoDeProductoEnGramos(p.name) !== null ? presentaciones(p.name) : [];
        const composicion = pesoPedido !== null && otras.length > 1 ? composicionParaProducto(catalogo, p.name, pesoPedido) : null;
        return {
          id: p.id,
          name: p.name,
          price: p.price,
          pack_size: p.packSize,
          requires_adult_confirmation: p.requiresAdultConfirmation,
          ...unidadDeVentaWire(p),
          ...(p.ambiguo === true ? { ambiguo: true } : {}),
          ...(otras.length > 1
            ? {
                presentaciones_por_peso: otras,
                ...(composicion ? { composicion_peso: composicion } : {}),
                aviso_peso: "Cotice la presentación del peso que pidió el cliente (cuarto = 250 g, medio = 500 g, tres cuartos = 750 g); no cotice el kilo si pidió una fracción. Si pidió un peso que no existe (1 1/4 kg, 3 kg), arme la combinación con estas presentaciones (por ejemplo 1 kg + 250 g) y no diga que no se maneja. Si trae composicion_peso tipo composicion, esa es la combinación exacta a precio del menú y NO hay que preguntar cuál presentación (aunque venga ambiguo: true): dígasela al cliente con ese total ANTES del sí (por ejemplo «le armo 1 kg + 250 g, $1,125»; es el mismo total que dará cotizar_pedido, que es quien cobra) y cotice cada parte como renglón, sin redondear a otro peso ni calcular usted otro total; si es tipo preguntar (peso que no es múltiplo de 250 g, aproximado o muy grande) NO invente: pregunte cuánto quiere.",
              }
            : {}),
        };
      });
      };
      const result = await buscarUna(String(input.query ?? ""));
      // PM-R20: consultas extra del mismo pedido en UNA llamada (ahorra una vuelta al modelo por producto). Sin ellas la forma del resultado no cambia. Solo lecturas, en orden.
      const extras = Array.isArray(input.consultas_adicionales)
        ? input.consultas_adicionales.filter((c): c is string => typeof c === "string" && c.trim() !== "").map((c) => c.slice(0, MAX_LARGO_CONSULTA_BUSCAR_PRODUCTO)).slice(0, MAX_CONSULTAS_ADICIONALES_BUSCAR_PRODUCTO)
        : [];
      if (extras.length === 0) return { result, raw: result, orderId: null, propertyId: null };
      const porConsulta = [{ query: String(input.query ?? ""), productos: result }];
      for (const consulta of extras) porConsulta.push({ query: consulta, productos: await buscarUna(consulta) });
      const agrupado = { resultados: porConsulta };
      return { result: agrupado, raw: agrupado, orderId: null, propertyId: null };
    }
    case "cotizar_pedido": {
      // QA-PM-R5-reglas-11: un complemento inexistente ("chimichurri") se rechaza al COTIZAR, antes de que el cliente vea y confirme un total (antes solo fallaba al crear).
      assertEntradasReconocidas(input);
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
      const aclaracionGuacamole = aclararGuacamoleExtra(quote.lines.map((l) => l.name), ctx.conversacionReciente);
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
      let esPerfilPm = false;
      if (mappedBase.basicComplements) {
        const config = await repo.findWhatsAppAgentConfig(ctx.organizationId, ctx.entryPropertyId ?? ctx.lockedPropertyId ?? null);
        esPerfilPm = config?.perfil === "taqueria_pm";
        if (!esPerfilPm) mapped = { ...mappedBase, basicComplements: undefined };
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
      // Paquete B (bandera RESTAURANTES_GEOCERCAS): con el pin compartido (o un tablaje) la direccion ya esta dada; si solo falta la referencia se pide ESO, una vez, y no la calle y el numero.
      if (geocercasActivas() && esPerfilPm && ctx.channel === "whatsapp" && (createInput.canal ?? "domicilio") === "domicilio" && ctx.sharedLocation) {
        const dir = evaluarDireccionEntrega({ direccion: createInput.customerAddress, tienePin: true });
        if (!dir.suficiente) throw new OrderValidationError(`${faltantesEnUnMensaje({ referencia: true }) ?? ""} NO pida calle ni número: el cliente ya compartió su ubicación (pin); pida solo la referencia, una vez, y mándela en customer_address junto con el tablaje o la privada.`);
      }
      // QA-PM-R8 T7-014: domicilio de PM con una casa descrita por referencias visuales y SIN pin ni enlace de Maps: se pide el pin una vez antes de registrar (ver `requierePinAntesDeCrear`).
      if (esPerfilPm && ctx.channel === "whatsapp" && (createInput.canal ?? "domicilio") === "domicilio" && !ctx.sharedLocation && !ctx.ubicacionEntrega && !createInput.mapsUrl && requierePinAntesDeCrear(ctx.conversacionReciente, createInput.customerAddress)) {
        throw new OrderValidationError(PIN_ANTES_DE_CREAR_MENSAJE);
      }
      if (ctx.modo === "preview") return simulatePreviewOrder(repo, ctx, createInput, expectedPrices, expectedTotal);
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
            assertTotalNoSubio(prepared, expectedTotal);
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
        // D31 (QA-PM-R5-voz-19): un pedido grande SIEMPRE pasa por la sucursal. Con el autopiloto el pedido queda `por_aprobar` y la solicitud llega al panel, pero ni en voz ni en WhatsApp
        // quedaba ningun aviso (callback) para la persona de la sucursal (solo sin autopiloto lo dejaba `escalada:pedido_grande`). Se registra en el SERVIDOR, en el mismo SAVEPOINT
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
    case "enviar_menu":
      return enviarMenuPdf(repo, ctx, input);
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
      const motivoEscalada = esEscalada ? normalizarMotivoEscalacion(input.motivo) : null;
      // R16 (T7-017/021/043): el folio, la direccion y los renglones del pedido reciente los pone el SERVIDOR (no el modelo) en las escaladas que hablan de un pedido.
      const bloquePedido = motivoEscalada && MOTIVOS_AVISO_CON_PEDIDO.has(motivoEscalada) ? await armarBloquePedidoParaAviso(repo, organizationId, ctx.phone) : null;
      const detalleModelo = esEscalada ? (typeof input.resumen === "string" ? input.resumen : undefined) : typeof input.message === "string" ? input.message : undefined;
      await registerCallbackRequest(repo, {
        organizationId,
        propertyId: ctx.lockedPropertyId ?? ctx.entryPropertyId ?? null,
        customerName: textoOpcional(input.customer_name)?.trim() || "Cliente", // "" (el modelo no sabe el nombre) -> "Cliente": antes lanzaba y el cliente leia "Error interno"
        customerPhone: ctx.phone,
        reason,
        sourceEventId: ctx.sourceEventId ? `${ctx.sourceEventId}:${reason ?? ""}`.slice(0, 255) : null,
        message: componerMensajeAviso(bloquePedido, detalleModelo, motivoEscalada ?? ""),
        source: ctx.channel === "voz" ? "voice" : "whatsapp",
      });
      // QA-PM-R5-voz-05: por voz el agente escalaba y colgaba SIN decirle nada al cliente. El resultado trae la frase que debe decir (en WhatsApp el agente ya la escribe en el mismo turno).
      // Cancelar NO es agregar: la frase de agregados («alcanza a salir») no aplica. Cancelacion = el `resumen` del modelo habla de cancelar/anular (la herramienta no tiene otro campo).
      const esCancelacion = motivoEscalada === "cancelacion_modificacion" && ES_CANCELACION.test(textoOpcional(input.resumen) ?? "");
      const aviso = esEscalada && ctx.channel === "voz"
        ? motivoEscalada !== "cancelacion_modificacion"
          ? { mensaje_al_cliente: MENSAJE_ESCALACION_VOZ, instruccion: INSTRUCCION_ESCALACION_VOZ }
          : esCancelacion
            ? { mensaje_al_cliente: MENSAJE_CANCELACION_PEDIDO_ENVIADO, instruccion: INSTRUCCION_ESCALACION_VOZ }
            : { mensaje_al_cliente: MENSAJE_CAMBIO_PEDIDO_ENVIADO, instruccion: INSTRUCCION_ESCALACION_VOZ }
        : {};
      // R16 (T7-043, decision de Javier): al agregar/cambiar algo de un pedido ya enviado a cocina la hora la confirma la SUCURSAL; el agente no inventa minutos.
      const horaDelRestaurante = motivoEscalada === "cancelacion_modificacion" ? { instruccion: esCancelacion ? INSTRUCCION_CANCELACION_SUCURSAL : INSTRUCCION_CAMBIO_HORA_SUCURSAL } : {};
      return { result: { ok: true, ...aviso, ...horaDelRestaurante }, raw: { ok: true }, orderId: null, propertyId: null };
    }
  }
}

/**
 * `enviar_menu`: encola el menu en PDF de la sucursal como documento de WhatsApp (outbox, mismo canal y numero del chat; el despachador lo manda con el cliente de Meta).
 * Nunca envia nada real desde aqui: solo escribe en el outbox. Sin base de PDF configurada o con una sucursal sin menu, NO encola y devuelve el enlace oficial / `sin_menu`
 * para que el agente lo diga en texto. Idempotente por mensaje del cliente y sucursal (un reintento del turno no manda dos PDF).
 */
async function enviarMenuPdf(repo: RestaurantesRepository, ctx: AgentToolContext, input: Record<string, unknown>): Promise<AgentToolOutcome> {
  const slug = typeof input.branch_slug === "string" ? input.branch_slug.trim() : "";
  const branch = slug ? await repo.findBranch(ctx.organizationId, { slug }) : null;
  if (!branch || branch.status !== "active") {
    throw new OrderValidationError(`Sucursal '${slug}' no encontrada o inactiva: use un branch_slug de la lista de sucursales (o pregunte al cliente de cuál quiere el menú).`);
  }
  const menu = resolverMenuPdf(branch.slug, ctx.menuPdfBaseUrl);
  const hecho = (result: Record<string, unknown>, simulated = false): AgentToolOutcome => ({ result, raw: result, orderId: null, propertyId: branch.propertyId, ...(simulated ? { simulated: true } : {}) });
  if (menu.tipo === "sin_menu") {
    return hecho({ ok: true, enviado: "sin_menu", branch_slug: branch.slug, instruccion: "Esa sucursal no tiene menú publicado: diga que la sucursal se lo puede enviar y deje el aviso con registrar_contacto (reason menu_pdf)." });
  }
  if (menu.tipo === "enlace") {
    return hecho({ ok: true, enviado: "enlace", branch_slug: branch.slug, enlace: menu.paginaWeb, instruccion: `Comparta ESTE enlace tal cual: es la página oficial con el menú de ${menu.etiqueta}. No invente otro.` });
  }
  // Vista previa del dueño: exito simulado, sin encolar nada.
  if (ctx.modo === "preview") return hecho({ ok: true, simulado: true, enviado: "pdf", branch_slug: branch.slug, archivo: menu.archivo, instruccion: "Diga que ya le mandó el menú en PDF." }, true);
  if (!ctx.phone) throw new OrderValidationError("No se conoce el teléfono de esta conversación; no se puede mandar el menú.");
  const to = toWhatsAppRecipient(ctx.phone);
  if (!to) throw new OrderValidationError("El teléfono de esta conversación no es válido para WhatsApp; no se puede mandar el menú.");
  const phoneNumberId = await repo.resolveActiveWhatsAppPhoneNumberId(ctx.organizationId, ctx.entryPropertyId ?? ctx.lockedPropertyId ?? null);
  if (!phoneNumberId) {
    // Sin numero activo no hay por donde mandar el documento: el agente comparte el enlace oficial en texto.
    return hecho({ ok: true, enviado: "enlace", branch_slug: branch.slug, enlace: menu.paginaWeb, instruccion: `No se pudo mandar el PDF. Comparta ESTE enlace tal cual: es la página oficial con el menú de ${menu.etiqueta}.` });
  }
  const bucket = Math.floor(Date.now() / (10 * 60 * 1000));
  const dedupeKey = `menu-pdf:${ctx.sourceEventId ?? `${to}:${bucket}`}:${branch.slug}`.slice(0, 255);
  await repo.enqueueMessagingOutbox(ctx.organizationId, "whatsapp", "whatsapp.menu_pdf", dedupeKey, {
    to,
    phone_number_id: phoneNumberId,
    body: `Menú de Los Taquitos de PM · ${menu.etiqueta}`,
    documento: { url: menu.url, filename: menu.archivo, fallbackUrl: menu.paginaWeb },
    transaccional: true, // lo pidio el cliente en esta conversacion (ventana de 24 h abierta): la supresion de plataforma no lo bloquea
  });
  return hecho({ ok: true, enviado: "pdf", branch_slug: branch.slug, archivo: menu.archivo, instruccion: `Ya se le manda el menú en PDF de ${menu.etiqueta}. Dígaselo en una frase (llegará como documento) y pregunte qué se le antoja; no pegue el menú.` });
}

/** Resultado de buscar_cliente sin `pedidoReciente`: no hay dato del estado en cocina. */
export const AVISO_SIN_ESTADO_DE_PEDIDO = "Este resultado NO trae el estado del pedido en cocina ni si ya salió. Si el cliente pregunta si ya está en cocina o si se está preparando, diga solo que el pedido figura registrado (con su total y hora, si los tiene) y que la sucursal le confirma el estado; NUNCA «ya se está preparando» ni «ya salió».";

/** Lo que el agente de VOZ le dice al cliente tras escalar a una persona (SOLO la frase literal: `mensaje_al_cliente` se lee tal cual). */
export const MENSAJE_ESCALACION_VOZ = "Ya avisé al gerente de la sucursal; le responden en cuanto puedan.";
/** Decision del dueño (chats de voz y WhatsApp): agregados a un pedido ya enviado, SIN minutos. Misma frase en los dos canales. */
export const MENSAJE_CAMBIO_PEDIDO_ENVIADO = "Lo paso ahorita a la sucursal; ellos le confirman si alcanza a salir con su pedido, y si ya salió se lo pueden enviar aparte. Le confirmo en un momento.";
/** Tras escalar un cambio (agregar, cancelar...) a un pedido ya enviado a cocina: el aviso ya salio; la hora la confirma el restaurante. */
export const INSTRUCCION_CAMBIO_HORA_SUCURSAL = `Ya se avisó a la sucursal con el detalle. Dígale al cliente: «${MENSAJE_CAMBIO_PEDIDO_ENVIADO}» La hora y si alcanza a salir con su pedido los confirma la sucursal: NO dé minutos, horas ni «aproximadamente» y no prometa que ya quedó agregado.`;

/** Cancelacion de un pedido ya registrado (frase PROPIA, distinta de la de agregados): se avisa a la sucursal y ella confirma si todavia se puede cancelar. Misma frase en voz y WhatsApp. */
export const MENSAJE_CANCELACION_PEDIDO_ENVIADO = "Ya avisé a la sucursal que quiere cancelar su pedido; ellos le confirman si todavía se puede cancelar, porque si ya está en preparación o ya salió puede que no. Le confirmo en un momento.";
export const INSTRUCCION_CANCELACION_SUCURSAL = `Ya se avisó a la sucursal con el detalle. Dígale al cliente: «${MENSAJE_CANCELACION_PEDIDO_ENVIADO}» Si todavía se puede cancelar lo confirma la SUCURSAL: NO diga que ya quedó cancelado, ni prometa reembolso, ni dé minutos.`;
const ES_CANCELACION = /\b(?:cancel\w*|anul\w*)/i;

/** Instruccion para el MODELO (no para el cliente): va en `instruccion`, nunca dentro de `mensaje_al_cliente`. */
export const INSTRUCCION_ESCALACION_VOZ = "Dígale al cliente el mensaje_al_cliente, de usted, ANTES de despedirse o cortar; no prometa hora ni resultado.";

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
    customerName: textoOpcional(input.customer_name)?.trim() || "Cliente", // R12-17: solo un texto es un nombre ("[object Object]" nunca llega al panel)
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
  if (!reciente || reciente.canal !== "recoger" || (reciente.estado !== "registrado" && reciente.estado !== "preparando" && reciente.estado !== "listo_para_recoger" && reciente.estado !== "programado")) {
    return { result: { ok: false, motivo: "sin_pedido_para_recoger", instruccion: MENSAJE_LLEGADA_SIN_PEDIDO }, raw: { ok: false }, orderId: null, propertyId: null };
  }
  const identificacion = typeof input.message === "string" ? sanitizeInlineText(input.message, 200) : "";
  await registerCallbackRequest(repo, {
    organizationId: ctx.organizationId,
    propertyId: encontrado?.propertyId ?? ctx.lockedPropertyId ?? ctx.entryPropertyId ?? null,
    customerName: textoOpcional(input.customer_name)?.trim() || "Cliente", // R12-17: solo un texto es un nombre ("[object Object]" nunca llega al panel)
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
    // Lo unico que el cliente lee de este pedido retenido: si el modelo no alcanza a redactar la respuesta (vueltas agotadas, proveedor caido, texto vacio) el turno
    // usa este texto en vez de dejar al cliente sin mensaje o con un texto de fallo.
    mensaje_al_cliente: MENSAJE_PEDIDO_REINCIDENTE_RETENIDO,
  };
  return { result, raw: result, orderId: null, propertyId: prepared.branch.propertyId, pedidoRetenido: true };
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

/** Pedido retenido por reincidencia: el pedido NO esta creado, no se explica el motivo ni se menciona historial y no se promete hora. */
export const MENSAJE_PEDIDO_REINCIDENTE_RETENIDO = "La sucursal confirma su pedido en un momento. Todavía no está en cocina.";

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
    return await repo.runWithRowSavepoint(() => invokeAgentTool(repo, ctx, name, input, { rechazoComoResultado: true }));
  } catch (err) {
    // QA-PM-R3-reglas-10: la guarda SQL `raise exception ... using errcode = '22023'` (p. ej. "programado_para debe ser una hora futura") es una REGLA de negocio con un mensaje
    // pensado para el agente: antes salia como "Error interno" (y como fallo del sistema, que sube de rol), sin dejar rastro de la causa.
    const reglaSql = esGuardaSqlDeNegocioDePedido(err);
    const esRegla = err instanceof OrderValidationError || reglaSql;
    if (!esRegla) {
      // Solo la clase y el codigo (SQLSTATE): ni argumentos de la herramienta ni el mensaje, que en Postgres trae valores de la fila (datos del cliente).
      console.error(`[agent-tools] ${name} fallo con error interno: ${descripcionSeguraDeError(err)}`);
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
