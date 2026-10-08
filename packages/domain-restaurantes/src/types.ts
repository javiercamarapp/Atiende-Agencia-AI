import type { CustomerAddressDetail, TasteProposal } from "./cliente-360/types.ts";
// Tipos de dominio de restaurantes — port de las formas de
// restaurantes/supabase/functions/_shared/create-order-core.ts, renombrando
// restaurant_id -> organizationId y branch_id -> propertyId para integrar con el
// modelo de tenancy de @atiende/core-tenancy (Organization/Property), en vez del
// concepto de tenant aislado (`restaurants`) del origen.
import type { HorarioSucursal } from "./horarios.ts";

import type { PedidoReciente } from "./pedido-reciente.ts";
import type { UbicacionEntrega } from "./whatsapp/location.ts";

export interface Branch {
  readonly propertyId: string;
  readonly organizationId: string;
  readonly name: string;
  readonly slug: string;
  readonly status: "active" | "inactive";
  readonly phone: string | null;
  readonly address: string | null;
  /** Ya vivían en `branch_detail` desde Fase 1 (migrations/001) sin usar por
   * ningún caso de negocio — Fase 2 los expone para buscar_sucursal_cercana
   * (ver nearest-branch.ts). null si la sucursal nunca capturó coordenadas. */
  readonly lat: number | null;
  readonly lng: number | null;
}

/** Forma resumida de sucursal para el bloque dinámico "SUCURSALES REALES" del
 * prompt del agente de WhatsApp (ver whatsapp/llm-turn-handler.ts) — nunca
 * hardcodeado por organización, a diferencia del prompt mono-tenant del
 * origen. */
export interface BranchSummary {
  readonly propertyId: string;
  readonly name: string;
  readonly slug: string;
  readonly address: string | null;
}

/** Resultado real de emparejar una colonia/zona contra `known_zone` y
 * calcular distancia Haversine contra las sucursales activas con lat/lng de
 * la organización — ver nearest-branch.ts. */
export interface NearestBranchMatch {
  readonly branch: Branch;
  readonly distanceKm: number;
  readonly recognizedZoneName: string;
}

/** Tipo de tortilla de un renglon de tacos. `mixta` (mitad maiz, mitad harina) es una opcion
 * normal de PM, sin costo. */
export type TortillaChoice = "maiz" | "harina" | "mixta";
export type CustomerTier = "BLACK" | "PLATINUM" | "GOLD" | "BLUE";

/**
 * Producto disponible en una sucursal (branch_products join products), tal como lo
 * ve la lógica de cotización — port literal de `ProductoEncontrado` del origen.
 */
export interface ProductoEncontrado {
  readonly id: string;
  readonly name: string;
  readonly price: number;
  /**
   * Cantidad fija de piezas del paquete si el producto se vende como paquete
   * indivisible (ej. 3 para "Tacos de Bistec de Res (orden de 3)"), 1 si se vende
   * individual, null si no aplica esa noción (bebidas, kilos, etc.). Calculado del
   * name+description real, nunca inferido por el LLM.
   */
  readonly packSize: number | null;
  readonly requiresAdultConfirmation: boolean;
  /** Regla dura "no se vende a domicilio" (producto o su categoria marcados en
   * `restaurantes.products/categories.no_domicilio`, migracion 023). Ausente/false =
   * sin restriccion (tambien cuando la base todavia no tiene la columna). */
  readonly noDomicilio?: boolean;
  /** El renglon exige elegir tortilla (maiz, harina o mixta): tacos y los platillos que el menu describe "de maiz o harina".
   * Ausente = se decide por el nombre ("taco"), como antes de PM-C4. */
  readonly requiresTortilla?: boolean;
  /** La busqueda NO pudo fijar un unico producto (cantidad sin presentacion exacta, "media orden de bistec"): son candidatas, no una mejor coincidencia. El agente debe
   * preguntar al cliente cual quiere en vez de elegir una; nunca incluye una presentacion de mas peso que el pedido. Ausente = sin ambiguedad extra. */
  readonly ambiguo?: boolean;
  /** Categoria del menu (para reglas por tipo de producto, p. ej. la doble salsa no aplica a un pedido de solo bebidas). Ausente en filas antiguas. */
  readonly categoryName?: string | null;
}

export interface RequestedOrderItemInput {
  readonly productId?: string;
  /** Nombre exacto devuelto por buscar_producto; permite recuperar un id mal copiado. */
  readonly productName?: string;
  readonly requestedQuantity: number;
  readonly tortilla?: TortillaChoice;
}

export interface QuotedOrderLine {
  readonly productId: string;
  readonly name: string;
  readonly price: number;
  readonly requestedQuantity: number;
  readonly packSize: number | null;
  /** Unidades del catálogo que se cobran/guardan (distinto de requestedQuantity cuando packSize>1). */
  readonly quantity: number;
  readonly tortilla: TortillaChoice | null;
  readonly requiresAdultConfirmation: boolean;
  readonly lineTotal: number;
}

export interface OrderQuote {
  readonly lines: readonly QuotedOrderLine[];
  readonly total: number;
  readonly containsAlcohol: boolean;
}

/** Complementos que el cliente puede PEDIR (sin costo). `pina` es la piña picada que acompaña los tacos (gratis si se pide; la doble
 * es el producto "Extra Piña" del catálogo, no un complemento); `salsa_habanero_soasado` es el habanero soasado ("sauceada"). */
export type RequestedComplement =
  | "salsa_habanero"
  | "crema_ajo"
  | "salsa_guacamolera"
  | "salsa_mexicana"
  | "salsa_pina"
  | "pina"
  | "salsa_habanero_soasado";
/** Las 9 salsas/guarniciones incluidas sin costo (PM): roja, verde, mexicana, guacamolera, limones,
 * crema de ajo, cebolla con cilantro, pina y habanero (soasado o picado con limon). `cebolla` es el
 * nombre historico de `cebolla_cilantro` y se sigue aceptando al omitir. */
export type DefaultComplement =
  | "salsa_roja"
  | "salsa_verde"
  | "salsa_mexicana"
  | "salsa_guacamolera"
  | "limones"
  | "crema_ajo"
  | "cebolla_cilantro"
  | "salsa_pina"
  | "salsa_habanero"
  | "cebolla";
/** Salsa de la que el cliente quiere doble porcion (extra COBRADO; las porciones normales van incluidas). */
export type DoubleSalsa = Exclude<DefaultComplement, "cebolla">;

export interface CustomerAddress {
  readonly address: string;
  readonly label: string | null;
  readonly isDefault: boolean;
}

export interface OrderHistoryItem {
  readonly name: string;
  readonly quantity: number;
}

/**
 * Resultado fusionado de lookupCustomer + vipNote + frase de frequent_items del
 * origen (mismo shape que `customer-lookup`/index.ts devuelve, con agentNotes ya
 * listo para inyectar en un prompt).
 */
export type CustomerLookupResult =
  | { readonly isNew: true }
  | {
      readonly isNew: false;
      readonly name: string | null;
      readonly orderCount: number;
      readonly addresses: readonly CustomerAddress[];
      readonly lastOrderItems: readonly OrderHistoryItem[] | null;
      readonly frequentItems: readonly OrderHistoryItem[];
      readonly tier: CustomerTier | null;
      readonly agentNotes: readonly string[];
      /** Pedido de las ultimas 12 h de este telefono con el estado que marco la sucursal (para "¿ya salio?"); ausente/null si no hay. */
      readonly pedidoReciente?: PedidoReciente | null;
      /** Cliente 360 (migracion 049). Ausentes contra una base sin migrar: el agente se comporta como antes. */
      /** Domicilios con etiqueta y referencias, el ULTIMO USADO primero. */
      readonly domicilios?: readonly CustomerAddressDetail[];
      /** Gustos que se le pueden PROPONER (aprendidos de pedidos confirmados; el cliente puede cambiarlos). */
      readonly gustos?: readonly TasteProposal[];
      /** Ultimos pedidos (sin cancelados), el mas reciente primero, para "lo mismo de la vez pasada". */
      readonly pedidosAnteriores?: readonly PedidoAnteriorResumen[];
      /** true = en los ultimos pedidos hubo "no recogido"/pedido falso por encima del umbral: la sucursal confirma el siguiente. */
      readonly requiereConfirmacionSucursal?: boolean;
    };

/** Resumen de un pedido anterior para el agente: sin telefono ni direccion completa. */
export interface PedidoAnteriorResumen {
  readonly numero: number | null;
  readonly fecha: string;
  readonly canal: CanalPedido | null;
  readonly sucursal: string | null;
  readonly total: number;
  readonly productos: readonly OrderHistoryItem[];
}

export interface CreateOrderItemInput {
  readonly productId?: string;
  readonly productName?: string;
  readonly quantity?: number;
  readonly requestedQuantity?: number;
  readonly tortilla?: TortillaChoice;
}

export interface CreateOrderInput {
  readonly organizationId: string;
  readonly branchSlug?: string;
  readonly branchName?: string;
  readonly customerName: string;
  readonly customerPhone: string;
  readonly customerAddress?: string;
  /** Fase de correo — ver migrations/011_email_outbox_dispatch.sql: opcional a
   * propósito (restaurantes es voz/WhatsApp-first, ver validateCreateOrderPayload
   * en orders.ts) — cuando el cliente SÍ lo deja, dispara la confirmación de
   * pedido por correo real (order-notifications.ts). */
  readonly customerEmail?: string;
  readonly items: readonly CreateOrderItemInput[];
  readonly source: "web" | "voice" | "whatsapp" | "admin";
  readonly notes?: string;
  readonly paymentMethod?: "efectivo" | "tarjeta";
  readonly idempotencyKey?: string;
  readonly adultConfirmed?: boolean;
  readonly requestedComplements?: readonly RequestedComplement[];
  readonly omitDefaultComplements?: readonly DefaultComplement[];
  /** Perfil de básicas por omisión del negocio (PM: roja, verde, cebolla con cilantro y limones). Con valor, la comanda separa
   * «Básicas» de «Pedidas»; sin valor (web/checkout histórico) imprime las 9 como incluidas, igual que antes. */
  readonly basicComplements?: readonly DefaultComplement[];
  /** Destino de entrega que dio el cliente (pin de WhatsApp o link de Maps). Viaja en las notas del pedido (sin columna nueva)
   * y la vista del repartidor lo abre en Maps. Solo a domicilio. */
  readonly ubicacionEntrega?: UbicacionEntrega;
  /** Monto con el que paga en efectivo (>= total); la comanda imprime «Paga con» y el cambio que lleva el repartidor. */
  readonly efectivoCon?: number;
  /** El repartidor debe llevar terminal (pago con tarjeta a domicilio). */
  readonly llevarTerminal?: boolean;
  /** Indicaciones de acceso o aviso al llegar ("timbre del depto 6", "avísenme al llegar"); una sola línea, hasta 200 caracteres. */
  readonly indicacionesAcceso?: string;
  /** Segundo teléfono de contacto (10 dígitos). */
  readonly telefonoAlterno?: string;
  /** Doble porcion de salsas (extra cobrado: una pieza del producto "Extra salsa" del catalogo por
   * cada salsa; si la sucursal no lo tiene en catalogo el pedido se rechaza con un mensaje claro). */
  readonly doubleSalsas?: readonly DoubleSalsa[];
  readonly callTranscript?: string;
  readonly callRecordingUrl?: string;
  /** Fase 11 — código de promoción a aplicar al total (ver promotions.ts). Opcional:
   * un pedido sin código nunca pasa por el motor de promociones (mismo criterio que
   * el resto de campos opcionales de este input). */
  readonly promoCode?: string;
  /** Canal del pedido. Default "domicilio" (comportamiento historico). "recoger" no exige
   * direccion, usa el pedido minimo de recoger y no aplica la regla de zona/no_domicilio. */
  readonly canal?: CanalPedido;
  /** Colonia/zona de entrega que dio el cliente (se empareja con `known_zone`). Solo se
   * exige cuando la sucursal tiene cobertura de entrega configurada. */
  readonly colonia?: string;
  /** Pin de ubicacion que el cliente compartio por WhatsApp. Lo pone el SERVIDOR (contexto del turno), nunca el modelo: sirve para
   * asignar por distancia un domicilio de PM cuando la sucursal no tiene zonas cargadas (`pin-reparto.ts`, CR12). */
  readonly ubicacion?: { readonly lat: number; readonly lng: number };
  /** Propina en pesos capturada en terminal. Solo se acepta si la politica de la sucursal
   * lo permite (PM: solo con tarjeta); no modifica `total`, se registra en las notas. */
  readonly propina?: number;
  /** Hora prometida de recogida (ISO 8601 con zona). Solo con canal "recoger". */
  readonly horaRecogida?: string;
  /** R-11 (migracion 034): PEDIDO PROGRAMADO. Fecha y hora (ISO 8601 con zona) para la que el cliente
   * quiere el pedido. Queda en estado `programado` y pasa solo a `pending` poco antes de esa hora. Debe caer
   * dentro del horario de la sucursal (en SU zona horaria) y dentro de la ventana permitida (ver
   * pedidos-programados.ts). Sin esto el pedido es inmediato, como siempre. */
  readonly programadoPara?: string;
  /** Cliente 360 (migracion 049): datos opcionales del domicilio que el cliente dio al confirmar. Solo alimentan la ficha
   * del cliente (cierre del ciclo); no cambian el total ni el dedupe del pedido. */
  readonly addressLabel?: string;
  readonly accessNotes?: string;
  readonly mapsUrl?: string;
}

export type CanalPedido = "domicilio" | "recoger";
export type PropinaPolitica = "nunca" | "siempre" | "solo_tarjeta";

/** Politica por sucursal (`restaurantes.branch_policy`, migracion 023). Todo null = sin
 * politica configurada (comportamiento anterior: sin limite de horario, sin minimo, sin
 * propina). */
export interface BranchPolicy {
  readonly horario: HorarioSucursal | null;
  readonly pedidoMinimoDomicilio: number | null;
  readonly pedidoMinimoRecoger: number | null;
  readonly propinaPolitica: PropinaPolitica | null;
  // Migracion 057 (directorio y domicilio por sucursal). Opcionales: ausentes en una base sin migrar y en
  // quien construye una politica solo con los campos de 023; el valor por omision conserva el comportamiento anterior.
  /** null = sigue a la sucursal activa; true = aparece en el directorio aunque este inactiva; false = oculta. */
  readonly visibleEnDirectorio?: boolean | null;
  /** false = la sucursal no reparte a domicilio (solo recoger). Por omision true. */
  readonly aceptaDomicilio?: boolean;
  /** Dias (0 = domingo .. 6 = sabado) en que reparte a domicilio; null = todos los dias. */
  readonly diasDomicilio?: readonly number[] | null;
  /** Insignia publica "Temporada". Por omision false. */
  readonly deTemporada?: boolean;
}

/** Perfil del agente de WhatsApp: `generico` es el de siempre (tutea, domicilio); `taqueria_pm` es el de
 * Los Taquitos de PM (usted, recoger y domicilio, reglas duras de PM). */
export type PerfilAgenteWhatsApp = "generico" | "taqueria_pm";
export const PERFILES_AGENTE_WHATSAPP: readonly PerfilAgenteWhatsApp[] = ["generico", "taqueria_pm"];
export const TONOS_AGENTE_WHATSAPP = ["calido_cercano", "formal_directo", "profesional_neutro", "divertido_desenfadado"] as const;
export type TonoAgenteWhatsApp = (typeof TONOS_AGENTE_WHATSAPP)[number];

/** Configuracion del agente de WhatsApp por organizacion (`propertyId` null) o por sucursal. Cada campo
 * nulo cae al valor por omision del perfil. */
export interface WhatsAppAgentConfigRow {
  readonly propertyId: string | null;
  readonly perfil: PerfilAgenteWhatsApp;
  readonly agentName: string | null;
  readonly businessName: string | null;
  readonly toneStyle: TonoAgenteWhatsApp | null;
  readonly deliveryTimeText: string | null;
  // Campos de la migracion 033 (R-10). Ausentes en una base sin migrar: todo cae a los valores del perfil.
  /** Saludo propio ("Hola, bienvenido") en lugar del saludo segun la hora. Solo perfil `taqueria_pm`. */
  readonly greetingText?: string | null;
  /** Lista de salsas incluidas sin costo, en texto libre corto. Solo perfil `taqueria_pm`. */
  readonly salsasText?: string | null;
  /** Promociones listadas para recoger, en texto libre corto. Solo perfil `taqueria_pm`. */
  readonly promosText?: string | null;
  /** Motivos de escalacion que el negocio desactivo (solo los de `MOTIVOS_ESCALACION_DESACTIVABLES`). */
  readonly escalationReasonsOff?: readonly MotivoEscalacionDesactivable[];
  /** Version de la fila (sube en cada guardado; control de concurrencia optimista). */
  readonly version?: number;
  // Campos de la migracion 039 (PM-C5). Ausentes en una base sin migrar: todo cae a los valores del perfil.
  /** Umbral de pedido grande en texto corto (por omision `PM_PEDIDO_GRANDE_POR_OMISION`). Solo perfil `taqueria_pm`. */
  readonly largeOrderText?: string | null;
  /** Segundos que el agente espera tras el ultimo mensaje del cliente antes de responder (0 a 30; null = apagado). Solo perfil `taqueria_pm`. */
  readonly replyDebounceSeconds?: number | null;
}

/** Motivos de escalacion que un owner/admin puede apagar. Los demas (queja, alergia, cliente_lo_pide, falla_sistema,
 * transferencia, cancelaciones, reposiciones, etc.) son de seguridad y NO se pueden desactivar (CHECK en la base). */
export const MOTIVOS_ESCALACION_DESACTIVABLES = ["pedido_grande", "zona_ambigua", "producto_agotado", "no_entiende"] as const;
export type MotivoEscalacionDesactivable = (typeof MOTIVOS_ESCALACION_DESACTIVABLES)[number];

export type WhatsAppAgentConfigInput = Omit<WhatsAppAgentConfigRow, "propertyId" | "version">;

export type WhatsAppAgentConfigAccion = "actualizado" | "restablecido";

/** Una entrada del historial de cambios del agente (append-only). `anterior`/`nuevo` son fotos de los campos editables. */
export interface WhatsAppAgentConfigHistorialEntry {
  readonly version: number;
  readonly accion: WhatsAppAgentConfigAccion;
  readonly propertyId: string | null;
  readonly anterior: Readonly<Record<string, unknown>> | null;
  readonly nuevo: Readonly<Record<string, unknown>>;
  readonly actorUserId: string | null;
  readonly actorNombre: string | null;
  readonly creadoAt: string;
}

export const EMPTY_BRANCH_POLICY: BranchPolicy = {
  horario: null,
  pedidoMinimoDomicilio: null,
  pedidoMinimoRecoger: null,
  propinaPolitica: null,
  visibleEnDirectorio: null,
  aceptaDomicilio: true,
  diasDomicilio: null,
  deTemporada: false,
};

/** Resolucion del numero de WhatsApp que recibe un mensaje: organizacion y, cuando el
 * numero pertenece a una sucursal, esa sucursal (`null` = numero por defecto de la
 * organizacion). */
export interface WhatsAppChannelResolution {
  readonly organizationId: string;
  readonly propertyId: string | null;
}

export interface WhatsappBranchChannel {
  readonly propertyId: string;
  readonly phoneNumberId: string;
}

/** Marcas "no_domicilio" del catalogo (migracion 023). */
export interface NoDomicilioMarks {
  readonly productIds: readonly string[];
  readonly categoryIds: readonly string[];
}

export interface Order {
  readonly id: string;
  readonly organizationId: string;
  readonly propertyId: string;
  readonly customerId: string | null;
  readonly customerName: string;
  readonly customerPhone: string;
  readonly customerAddress: string | null;
  /** Fase de correo — ver migrations/011_email_outbox_dispatch.sql. `null` para
   * cualquier pedido creado antes de esta migración o por un canal (voz/
   * WhatsApp) que todavía no lo captura. */
  readonly customerEmail: string | null;
  readonly branch: string | null;
  readonly total: number;
  readonly status: OrderStatus;
  readonly items: readonly PersistedOrderItem[];
  readonly source: "web" | "voice" | "whatsapp" | "admin";
  readonly notes: string | null;
  readonly paymentMethod: "efectivo" | "tarjeta" | null;
  readonly callTranscript: string | null;
  readonly callRecordingUrl: string | null;
  readonly dedupeFingerprint: string | null;
  readonly idempotencyKey: string | null;
  readonly createdAt: string;
  /** Folio corto del pedido (`orders.order_number`). Solo viene en la fila de creacion (`create_order_idempotent` devuelve la fila completa); ausente en
   * lecturas por columnas y en pedidos de prueba. Se usa para el aviso "Recibimos su pedido #folio". */
  readonly orderNumber?: number;
  // ---- Fase 8 — superficie real del rol "repartidor" (ver roles.ts, migrations/008) ----
  /** `core.staff_user.id` del repartidor despachado a este pedido por un
   * MANAGER_ROLES (nunca lo pone el repartidor mismo) — null hasta que se
   * despache. Puerto de `orders.assigned_repartidor_id` del origen. */
  readonly assignedRepartidorId: string | null;
  /** Capturada al despachar (ver `assignRepartidorToOrder`) — puerto literal de
   * `orders.estimated_delivery_at` del origen, usada ahí para calcular la
   * condición "Demorado" en el panel de repartidor. */
  readonly estimatedDeliveryAt: string | null;
  /** Nota libre de la incidencia que el repartidor reportó (status="problema") —
   * puerto literal de `orders.incident_note` del origen. null salvo cuando el
   * pedido está (o estuvo) en "problema". */
  readonly incidentNote: string | null;
  /** Migracion 031. Solo vienen cuando la fila las trae (creacion de pedido con la base migrada);
   * los listados no seleccionan estas columnas para no romper la base sin migrar -- usa
   * `repo.listOrderPickupInfo` para leerlas. */
  readonly canal?: CanalPedido | null;
  readonly propina?: number | null;
  readonly horaRecogida?: string | null;
  /** Migracion 034. Igual que arriba: solo vienen cuando la fila las trae; los listados generales no las
   * seleccionan (la base puede no estar migrada) -- `repo.listOrderScheduleInfo` las lee aparte. */
  readonly programadoPara?: string | null;
  readonly promovidoAt?: string | null;
  /** Solo la trae `listDeliveredOrdersForRepartidor` (columna `delivered_at` de la 001, que se fija al pasar a `entregado`). */
  readonly deliveredAt?: string | null;
}

/** Datos de programacion de un pedido (migracion 034): hora para la que se pidio y cuando se promovio a `pending`. */
export interface OrderScheduleInfo {
  readonly orderId: string;
  readonly programadoPara: string | null;
  readonly promovidoAt: string | null;
}

/** Datos de recoger de un pedido (migracion 031): canal, propina y hora prometida de recogida. */
export interface OrderPickupInfo {
  readonly orderId: string;
  readonly canal: CanalPedido | null;
  readonly propina: number | null;
  readonly horaRecogida: string | null;
}

export interface PersistedOrderItem {
  readonly id: string;
  readonly name: string;
  readonly price: number;
  readonly quantity: number;
  readonly tortilla?: TortillaChoice;
}

export interface Customer {
  readonly id: string;
  readonly organizationId: string;
  readonly phone: string;
  readonly name: string | null;
  readonly orderCount: number;
}

// ---- Fase 5 — back-office CORE (catálogo/sucursales/pedidos/clientes, ver diseño §1) ----

export interface Category {
  readonly id: string;
  readonly organizationId: string;
  readonly name: string;
  readonly slug: string;
  readonly displayOrder: number;
}

export interface NewCategoryInput {
  readonly name: string;
  readonly slug: string;
  readonly displayOrder?: number;
}

export interface CategoryPatch {
  readonly name?: string;
  readonly slug?: string;
  readonly displayOrder?: number;
}

/** Catálogo real de un producto (organization-wide) — NO trae precio/disponibilidad
 * por sucursal (eso vive en `branch_products`, ver `BranchProductState` y
 * product-search.ts): `price` aquí es el precio BASE del producto
 * (`restaurantes.products.price`), el mismo que el origen usa como default al
 * darlo de alta en una sucursal nueva. */
export interface Product {
  readonly id: string;
  readonly organizationId: string;
  readonly categoryId: string | null;
  readonly categoryName: string | null;
  readonly name: string;
  readonly description: string | null;
  readonly price: number;
  readonly imageUrl: string | null;
  readonly isPopular: boolean;
  readonly isAvailable: boolean;
  readonly displayOrder: number;
  readonly searchKeywords: readonly string[];
}

export interface NewProductInput {
  readonly categoryId?: string | null;
  readonly name: string;
  readonly description?: string | null;
  readonly price: number;
  readonly imageUrl?: string | null;
  readonly isPopular?: boolean;
  readonly isAvailable?: boolean;
  readonly displayOrder?: number;
  readonly searchKeywords?: readonly string[];
}

export interface ProductPatch {
  readonly categoryId?: string | null;
  readonly name?: string;
  readonly description?: string | null;
  readonly price?: number;
  readonly imageUrl?: string | null;
  readonly isPopular?: boolean;
  readonly isAvailable?: boolean;
  readonly displayOrder?: number;
  readonly searchKeywords?: readonly string[];
}

/** Precio/disponibilidad REAL de un producto en UNA sucursal (`branch_products` —
 * fuente de verdad de precio/disponibilidad que ya usa searchProducts/quoteOrder,
 * ver product-search.ts). `null` cuando el producto nunca se dio de alta en esa
 * sucursal (nunca se asume un precio/disponibilidad por defecto). */
export interface BranchProductState {
  readonly propertyId: string;
  readonly productId: string;
  readonly price: number;
  readonly isAvailable: boolean;
  /** Autopiloto (migración 050): día de negocio (YYYY-MM-DD) en que el cron `agotados_reponer` lo devuelve a la venta. Solo lo
   * trae `getBranchProductState`; `null` si no hay reposición programada o la base no tiene la 050. */
  readonly agotadoHasta?: string | null;
}

/** `listo_para_recoger` y `no_recogido` (migracion 031) son los estados del canal recoger: el pedido
 * esta listo en mostrador y, si el cliente no llega, queda `no_recogido` y puede volver a cocina. */
export type OrderStatus =
  | "pending"
  | "preparando"
  | "en_camino"
  | "entregado"
  | "cancelado"
  | "completado"
  | "problema"
  | "listo_para_recoger"
  | "no_recogido"
  /** R-11 (migracion 034): pedido dejado para una hora futura; fuera de cocina hasta que se promueve a `pending`. */
  | "programado"
  /** Autopiloto (migracion 050): pedido grande retenido sin comanda ni cocina hasta que una persona lo aprueba (un clic) o lo rechaza. */
  | "por_aprobar";

export interface OrderListFilter {
  readonly propertyIds: readonly string[] | null;
  readonly status?: OrderStatus;
  readonly dateFrom?: Date;
  readonly dateTo?: Date;
  readonly limit: number;
  readonly cursor?: string;
}

export interface OrderListPage {
  readonly orders: readonly Order[];
  readonly nextCursor: string | null;
}

/** Frecuencia de la cartera: `una_vez` = exactamente 1 pedido; `recurrentes` = 2 o mas. */
export type CustomerFrecuencia = "una_vez" | "recurrentes";
export const CUSTOMER_FRECUENCIAS: readonly CustomerFrecuencia[] = ["una_vez", "recurrentes"];
export const CUSTOMER_TIERS: readonly CustomerTier[] = ["BLACK", "PLATINUM", "GOLD", "BLUE"];

export interface CustomerListFilter {
  readonly search?: string;
  readonly limit: number;
  readonly cursor?: string;
  /** Migracion 054: nivel (`calc_customer_tier`). Sin la migracion, la pagina responde `filtrosDisponibles: false`. */
  readonly nivel?: CustomerTier;
  readonly frecuencia?: CustomerFrecuencia;
  /** Sin pedir en los ultimos N dias (quien nunca ha pedido cuenta). */
  readonly inactivoDias?: number;
  /** Clientes que han pedido en esa sucursal. */
  readonly propertyId?: string;
}

/** Un cliente del listado de cartera. `tier`/`lastOrderAt` salen de la migracion 054; sin ella son `null`. */
export interface CustomerListItem extends Customer {
  readonly tier: CustomerTier | null;
  readonly lastOrderAt: string | null;
}

export interface CustomerListPage {
  readonly customers: readonly CustomerListItem[];
  readonly nextCursor: string | null;
  /** `false` solo cuando se pidio un filtro nuevo y la base aun no tiene la migracion 054 (lista vacia + estado "no disponible aun"). */
  readonly filtrosDisponibles: boolean;
}

/** KPIs de la cartera (migracion 054). `disponible: false` = la base aun no la tiene. */
export type CarteraKpis =
  | { readonly disponible: false }
  | {
      readonly disponible: true;
      readonly total: number;
      readonly recurrentes: number;
      /** Promedio del total de pedidos vigentes con cliente conocido; `null` si aun no hay pedidos. */
      readonly ticketPromedio: number | null;
      /** Cliente con mas pedidos; `null` si nadie ha pedido. */
      readonly masFrecuente: { readonly customerId: string; readonly orderCount: number; readonly ultimoPedidoEn: string | null } | null;
    };

/** Un renglon YA normalizado de la importacion de cartera (`importar_clientes`, migracion 054). */
export interface FilaImportacionCliente {
  /** 10 digitos (`canonicalizeMexicanPhone`). */
  readonly phone: string;
  readonly name: string | null;
  readonly address: string | null;
  readonly notes: string | null;
}

export type ResultadoImportacionClientes =
  | { readonly disponible: false }
  | {
      readonly disponible: true;
      /** El archivo (misma huella) ya se habia importado: nada se volvio a escribir; las cifras son las de la primera vez. */
      readonly yaImportado: boolean;
      readonly total: number;
      readonly creados: number;
      readonly actualizados: number;
      readonly sinCambios: number;
      readonly rechazados: number;
    };

export interface CallbackRequestInput {
  readonly organizationId: string;
  readonly propertyId?: string | null;
  readonly customerName: string;
  readonly customerPhone: string;
  readonly reason?: string;
  readonly message?: string;
  readonly source: "voice" | "whatsapp" | "web" | "admin";
  /** Id opaco del evento que origino el aviso (id del mensaje de Meta o de la llamada, mas el motivo): el mismo evento nunca crea dos
   * avisos (migracion 047). Solo lo usan los avisos del agente (`voice`/`whatsapp`). */
  readonly sourceEventId?: string | null;
}

/** Que paso con un aviso del agente: `nuevo` = se creo; `evento_repetido` = el mismo evento ya estaba registrado (no se hizo nada);
 * `nota_agregada` = habia un aviso abierto del mismo canal, telefono y motivo y se le agrego una nota. */
export type CallbackRegistro = "nuevo" | "evento_repetido" | "nota_agregada";

// ---- R-38 (migracion 062): marca publica del storefront por organizacion. Todos los campos son opcionales (null = sin valor). ----
export interface StorefrontMarcaInput {
  readonly titular: string | null;
  readonly eslogan: string | null;
  /** Descripcion corta ("about") de la portada. */
  readonly about: string | null;
  /** URL https de la imagen de portada. */
  readonly portadaUrl: string | null;
  readonly logoUrl: string | null;
  readonly instagramUrl: string | null;
  readonly facebookUrl: string | null;
  readonly tiktokUrl: string | null;
}

export interface StorefrontMarca extends StorefrontMarcaInput {
  /** null = nunca se guardo (o la base aun no tiene la migracion 062). */
  readonly updatedAt: string | null;
}

/** R-43: solicitud publica de evento/catering ya validada (ver storefront-marca.ts::validarSolicitudEvento). */
export interface SolicitudEventoInput {
  readonly nombre: string;
  /** 10 digitos nacionales. */
  readonly telefono: string;
  /** YYYY-MM-DD. */
  readonly fechaEvento: string;
  readonly personas: number;
  readonly sucursalSlug: string;
  readonly comentario: string | null;
}

export interface CallbackRequest extends CallbackRequestInput {
  readonly id: string;
  readonly resolved: boolean;
  readonly createdAt: string;
  readonly registro?: CallbackRegistro;
}

// ---- Fase 11 — promociones/marketing: motor real de código de descuento (ver
// promotions.ts). El original (`restaurantes/supabase/migrations/20251204004242_
// remix_migration_from_pg_dump.sql`) solo tenía `public.promos`: un banner
// puramente informativo (title/description/image_url/discount_text libre/
// is_active/display_order) SIN ninguna aplicación real a un pedido — `orders` del
// origen no tiene columna de descuento/promo_id, y `discount_text` es texto libre
// ("2x1", "20% off") que nunca se calcula, solo se muestra (confirmado también en
// `supabase/functions/_shared/whatsapp-agent-core.ts` del origen: el agente solo
// MENCIONA la promo, nunca la aplica). Este módulo es deliberadamente nuevo
// respecto al origen — documentado así a propósito, nunca presentado como port de
// una regla de negocio verificada — porque el gap real auditado pedía la
// aplicación real al total de un pedido, que el origen nunca tuvo. Una sola
// promoción por pedido a propósito: no hay evidencia en el origen de una regla de
// combinabilidad, así que no se inventa una.
export type PromotionType = "percentage" | "fixed" | "bogo" | "cortesia";

export interface Promotion {
  readonly id: string;
  readonly organizationId: string;
  /** Siempre en mayúsculas (normalizado al crear/editar) — único por organización. */
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
  readonly type: PromotionType;
  /** Porcentaje (1-100) si type==='percentage', pesos (>0) si type==='fixed', siempre 1 si
   * type==='bogo' (el 2x1 no usa el valor). */
  readonly value: number;
  /** Total mínimo del pedido (antes de descuento) para que el código aplique — null
   * = sin mínimo. */
  readonly minOrderTotal: number | null;
  readonly startsAt: string | null;
  readonly endsAt: string | null;
  /** 0=domingo..6=sábado (mismo criterio que `Date#getDay()`) — null/vacío = todos
   * los días. */
  readonly daysOfWeek: readonly number[] | null;
  /** "HH:MM" en hora local del servidor — null = sin restricción de hora. */
  readonly startTime: string | null;
  readonly endTime: string | null;
  /** Límite total de usos reales (organization-wide) — null = ilimitado. */
  readonly maxUses: number | null;
  readonly timesUsed: number;
  readonly isActive: boolean;
  /** Canales de pedido donde aplica (migracion 027) — null = todos. PM: las promociones solo valen
   * en `recoger`, nunca a `domicilio`. */
  readonly channels: readonly CanalPedido[] | null;
  /** Productos elegibles (ids de `restaurantes.products`, migracion 027) — null = todos los
   * renglones del pedido. */
  readonly productIds: readonly string[] | null;
  /** Migracion 031 -- se aplica SOLA (sin codigo) cuando el pedido cumple dia/hora/canal/productos.
   * Exige `channels` explicito (las promociones de PM valen solo para recoger, nunca a domicilio).
   * `false` contra la base sin migrar. */
  readonly autoApply: boolean;
  /** Solo type==='cortesia': productos que el cliente puede elegir gratis (p. ej. las aguas). Los
   * productos que DISPARAN la cortesia (p. ej. nachos de pastor) son `productIds`. */
  readonly courtesyProductIds: readonly string[] | null;
  /** Solo type==='cortesia': piezas gratis POR cada unidad disparadora en el pedido (1..10). */
  readonly courtesyQuantity: number | null;
  /** Migracion 038 (PM-C2) -- sucursales (`core.property.id`) donde vale la promocion: `null`/ausente = todas (conducta
   * anterior; tambien contra la base SIN migrar, donde no hay alcance que leer). Una lista = SOLO esas sucursales; una
   * lista vacia no vale en ninguna (la base la rechaza con CHECK, pero el motor cierra por defecto). */
  readonly propertyIds?: readonly string[] | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface NewPromotionInput {
  readonly code: string;
  readonly name: string;
  readonly description?: string | null;
  readonly type: PromotionType;
  readonly value: number;
  readonly minOrderTotal?: number | null;
  readonly startsAt?: string | null;
  readonly endsAt?: string | null;
  readonly daysOfWeek?: readonly number[] | null;
  readonly startTime?: string | null;
  readonly endTime?: string | null;
  readonly maxUses?: number | null;
  readonly isActive?: boolean;
  readonly channels?: readonly CanalPedido[] | null;
  readonly productIds?: readonly string[] | null;
  readonly autoApply?: boolean;
  readonly courtesyProductIds?: readonly string[] | null;
  readonly courtesyQuantity?: number | null;
  /** Migracion 038: sucursales donde vale (`null` = todas). */
  readonly propertyIds?: readonly string[] | null;
}

export interface PromotionPatch {
  readonly code?: string;
  readonly name?: string;
  readonly description?: string | null;
  readonly type?: PromotionType;
  readonly value?: number;
  readonly minOrderTotal?: number | null;
  readonly startsAt?: string | null;
  readonly endsAt?: string | null;
  readonly daysOfWeek?: readonly number[] | null;
  readonly startTime?: string | null;
  readonly endTime?: string | null;
  readonly maxUses?: number | null;
  readonly isActive?: boolean;
  readonly channels?: readonly CanalPedido[] | null;
  readonly productIds?: readonly string[] | null;
  readonly autoApply?: boolean;
  readonly courtesyProductIds?: readonly string[] | null;
  readonly courtesyQuantity?: number | null;
  /** Migracion 038: sucursales donde vale (`null` = todas). */
  readonly propertyIds?: readonly string[] | null;
}

// ---------------------------------------------------------------------------
// FASE 3 (producto) — bitácora de auditoría del staff, ver
// migrations/019_restaurantes_audit_log.sql. Mismo shape exacto que
// domain-rentas/src/types.ts (RegistrarAuditoriaInput/RentasAuditLog*) — copiado
// a propósito para que ambas verticales se lean igual, ver comentario de cabecera
// de esa migración para las 2 correcciones que nacen resueltas aquí (orden total
// desde el día uno, validación de rol). 'configuracion' ya tiene caller real
// desde FASE 3 (producto): `admin-config.ts::PUT .../admin/config/whatsapp` y
// `POST`/`DELETE .../admin/config/zonas` — ver `migrations/
// 021_restaurantes_config_editable_y_search_path_fix.sql`. Horarios de
// atención/configuración de voz siguen sin ruta (ninguna tabla existe todavía
// en el schema base para ninguno de los dos — ver el comentario de cabecera de
// esa migración).
// ---------------------------------------------------------------------------
export type RestaurantesAuditEntityType = "producto" | "promocion" | "pedido" | "repartidor" | "staff" | "configuracion" | "exportacion";

export interface RegistrarAuditoriaInput {
  readonly organizationId: string;
  /** Usado SOLO por `InMemoryRestaurantesRepository` (sin `auth.uid()`) para
   *  poblar `actorUserId` en sus fixtures de prueba. `PostgresRestaurantesRepository`
   *  lo IGNORA por completo al armar la llamada SQL -- `restaurantes.record_audit_log`
   *  (security definer) captura el actor real vía `auth.uid()` dentro de la
   *  función, nunca confía en un parámetro de este lado. */
  readonly actorUserId: string;
  readonly action: string;
  readonly entityType: RestaurantesAuditEntityType;
  readonly entityId: string | null;
  readonly campo?: string | null;
  readonly antes?: string | null;
  readonly despues?: string | null;
}

export interface RestaurantesAuditLogRow {
  readonly id: string;
  readonly actorUserId: string;
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string | null;
  readonly campo: string | null;
  readonly antes: string | null;
  readonly despues: string | null;
  readonly createdAtMs: number;
}

export interface RestaurantesAuditLogFiltro {
  readonly entityType?: RestaurantesAuditEntityType | null;
  /** `YYYY-MM-DD`, inclusive. */
  readonly desde?: string | null;
  /** `YYYY-MM-DD`, inclusive. */
  readonly hasta?: string | null;
}

export interface RestaurantesAuditLogPaginacion {
  readonly limit?: number;
  readonly offset?: number;
}

export interface RestaurantesAuditLogPagina {
  /** `false` cuando `restaurantes.audit_log`/`restaurantes.record_audit_log`
   *  todavía no existen en esta base (SQLSTATE 42883/42P01/42703, ver
   *  postgres-repository.ts) -- la pantalla debe mostrar "no disponible aún",
   *  nunca confundirlo con una bitácora real pero vacía
   *  (`disponible: true, items: []`). */
  readonly disponible: boolean;
  readonly items: readonly RestaurantesAuditLogRow[];
  readonly total: number;
  readonly nextOffset: number | null;
}

// ---------------------------------------------------------------------------
// FASE 3 (producto) -- configuración editable del panel (owner/admin), ver
// migrations/021_restaurantes_config_editable_y_search_path_fix.sql. Conecta
// tablas que YA EXISTÍAN sin ninguna ruta de escritura -- ver el comentario de
// cabecera de esa migración para el porqué de cada una.
// ---------------------------------------------------------------------------

/** `restaurantes.whatsapp_channel_config` (migrations/001/017) -- `null` cuando
 *  la organización nunca conectó un número (mismo criterio "honesto" que
 *  `resolveActiveWhatsAppPhoneNumberId`: nunca un objeto fingido). */
export interface WhatsappChannelConfig {
  readonly phoneNumberId: string | null;
}

/** `restaurantes.known_zone` (migrations/005/016) -- fila completa para el
 *  listado de administración (a diferencia de `NearestBranchMatch`, que solo
 *  expone el nombre reconocido de la zona que matcheó). */
export interface KnownZone {
  readonly id: string;
  readonly organizationId: string;
  readonly name: string;
  /** `null` = colonia sin coordenadas propias (migracion 056: las colonias del piloto original vienen sin lat/lng y NO se inventan).
   * Empareja el nombre y cuenta para la cobertura de entrega, pero no sirve de punto para calcular distancias. Ambas o ninguna. */
  readonly lat: number | null;
  readonly lng: number | null;
  readonly createdAt: string;
}

/** Lo que el piloto original dijo de una colonia (migracion 056): sucursal mas cercana y segunda con sus km, y como se asigno hoy. Solo lectura. */
export interface ColoniaReferencia {
  readonly zoneId: string;
  readonly name: string;
  readonly lat: number | null;
  readonly lng: number | null;
  readonly fuente: string | null;
  readonly asignacionFuente: string | null;
  readonly refSucursalSlug: string | null;
  readonly refKm: number | null;
  readonly ref2SucursalSlug: string | null;
  readonly ref2Km: number | null;
}

/** `disponible:false` = la base todavia no tiene la migracion 056 (el reporte lo dice, nunca finge una lista vacia). */
export interface ColoniasReferenciaLectura {
  readonly disponible: boolean;
  readonly zonas: readonly ColoniaReferencia[];
}

export interface NewKnownZoneInput {
  readonly name: string;
  readonly lat: number;
  readonly lng: number;
}

/** FASE 3 (producto) -- zona horaria por negocio (migración 022,
 * `restaurantes.branch_detail.zona_horaria`). `null` cuando la sucursal nunca
 * configuró una zona real todavía (o la columna aún no existe en la base --
 * ver `PostgresRestaurantesRepository.findBranchZonaHoraria`, degrada a `null`
 * en 42501/42883/42P01/42703, NUNCA lanza) -- el caller SIEMPRE resuelve el
 * default de plataforma vía
 * `@atiende/core-tenancy::resolverZonaHorariaNegocio(config.zonaHoraria)`,
 * nunca hardcodea `"America/Mexico_City"` directo. */
export interface BranchTimezoneConfig {
  readonly zonaHoraria: string | null;
}

// ---------------------------------------------------------------------------
// Voz: secretos por sucursal y bitacora de herramientas (migracion 026).
// ---------------------------------------------------------------------------
/** Resultado de comprobar el secreto de voz presentado contra los secretos por sucursal.
 * `unavailable` = la base todavia no tiene la tabla (migracion 026 sin aplicar): el llamador cae al
 * secreto global legado. */
export type VoiceSecretMatch = { readonly status: "match"; readonly propertyId: string } | { readonly status: "no_match" } | { readonly status: "unavailable" };

export type VoiceToolAuditOutcome = "ok" | "denied" | "error" | "rate_limited" | "token_issued";

export interface VoiceToolAuditInput {
  readonly organizationId: string;
  readonly propertyId: string | null;
  readonly callId: string | null;
  readonly tool: string;
  readonly outcome: VoiceToolAuditOutcome;
  /** sha256 del telefono del llamante (nunca el numero). */
  readonly phoneHash: string | null;
  /** Motivo corto, sin datos personales (maximo 300 caracteres). */
  readonly detail: string | null;
}

/** Excepcion de horario por FECHA de una sucursal (migracion 031): "puentes". Dentro de
 * [fechaDesde, fechaHasta] (fechas locales de la sucursal, inclusive) rige `horario` en lugar del
 * horario semanal de `BranchPolicy`. */
export interface BranchHoursException {
  readonly id: string;
  readonly propertyId: string;
  readonly fechaDesde: string;
  readonly fechaHasta: string;
  readonly horario: HorarioSucursal;
  readonly motivo: string | null;
}

export interface NewBranchHoursExceptionInput {
  readonly propertyId: string;
  readonly fechaDesde: string;
  readonly fechaHasta: string;
  readonly horario: HorarioSucursal;
  readonly motivo?: string | null;
}

// ---------------------------------------------------------------------------
// R-09 -- storefront publico (menu, carrito, checkout, rastreo por token).
// ---------------------------------------------------------------------------
/** Renglon del menu publico de UNA sucursal: incluye los productos "de hoy no hay"
 * (`isAvailable: false`) para mostrarlos deshabilitados, a diferencia de
 * `listAvailableProductsForBranch` (solo disponibles, usado para cotizar). El precio
 * es SIEMPRE el de la sucursal (`branch_products.price`). */
export interface StorefrontCatalogRow {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly price: number;
  readonly imageUrl: string | null;
  readonly isPopular: boolean;
  /** Disponibilidad en vivo en ESTA sucursal (`branch_products.is_available`). */
  readonly isAvailable: boolean;
  readonly categoryId: string | null;
  readonly categoryName: string | null;
  readonly categoryDisplayOrder: number;
  readonly displayOrder: number;
  /** Producto o categoria marcados "no se vende a domicilio" (alcohol en PM). */
  readonly noDomicilio: boolean;
}

/** Vista PUBLICA de un pedido para la pagina de rastreo: sin nombre, telefono, direccion,
 * correo ni notas del cliente (ver migracion 032). */
export interface StorefrontOrderTracking {
  readonly status: OrderStatus;
  readonly branch: string | null;
  readonly total: number;
  readonly paymentMethod: "efectivo" | "tarjeta" | null;
  readonly canal: CanalPedido;
  readonly createdAt: string;
  readonly items: ReadonlyArray<{ readonly name: string; readonly quantity: number; readonly tortilla: TortillaChoice | null }>;
}

/** `disponible: false` = la base todavia no tiene la funcion de rastreo (42883, migracion 032 sin
 * aplicar): la pagina debe decir "rastreo no disponible aun", nunca confundirlo con "no existe". */
export interface StorefrontTrackingResult {
  readonly disponible: boolean;
  readonly pedido: StorefrontOrderTracking | null;
}
