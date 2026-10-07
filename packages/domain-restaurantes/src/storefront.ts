// R-09 -- storefront publico (menu, carrito, checkout, rastreo). Este modulo concentra lo que la
// pagina publica necesita y que NO es el flujo de pedido en si (ese reutiliza el registro unico de
// tools: cotizar_pedido -> confirmar_resumen -> crear_pedido con canal "web", ver agent-tools/registry.ts):
//   * `buildStorefrontBranches`/`buildStorefrontMenu`: vistas de lectura, solo datos publicos.
//   * `assertWebOrderRules`: reglas duras propias del checkout web (direccion a domicilio, telefono de
//     10 digitos, forma de pago obligatoria, promociones solo para recoger).
//   * `previewPromotion`: vista previa honesta del descuento (la validacion real vuelve a correr en
//     `createOrder`; esto nunca cambia el total que se cobra).
// Todas las lecturas pasan por `repo.*`, que degradan con SAVEPOINT contra la base sin migrar.
import { resolverZonaHorariaNegocio } from "@atiende/core-tenancy";
import { OrderValidationError, PromotionError } from "./errors.ts";
import { insigniaDomicilio } from "./domicilio-sucursal.ts";
import { estaAbiertoAhora, type HorarioSucursal } from "./horarios.ts";
import { MAX_PIEZAS_POR_RENGLON_WEB, mensajeCantidadInvalida } from "./order-quote.ts";
import { canonicalizeMexicanPhone } from "./phone.ts";
import { enlaceWhatsapp } from "./storefront-marca.ts";
import { extraerPackSize, requiresAdultConfirmation, requiresTortillaChoice } from "./product-search.ts";
import { applyPromotionToOrder, normalizePromotionCode } from "./promotions.ts";
import type { RestaurantesRepository } from "./repository.ts";
import type { Branch, CanalPedido, CreateOrderInput, PersistedOrderItem, PropinaPolitica, StorefrontCatalogRow } from "./types.ts";

export interface StorefrontBranchView {
  readonly slug: string;
  readonly name: string;
  readonly address: string | null;
  readonly phone: string | null;
  /** wa.me de la sucursal con texto prellenado (R-38); null si la sucursal no tiene un numero valido. */
  readonly whatsappUrl: string | null;
  /** null = la sucursal no tiene horario configurado (no se afirma ni abierto ni cerrado). */
  readonly abiertoAhora: boolean | null;
  readonly cierraA: string | null;
  readonly proximaApertura: { readonly dia: string; readonly hora: string; readonly hoy: boolean } | null;
  readonly pedidoMinimoDomicilio: number | null;
  readonly pedidoMinimoRecoger: number | null;
  readonly propinaPolitica: PropinaPolitica | null;
  /** Nombres de las zonas de reparto de la sucursal (vacio = sin cobertura configurada). */
  readonly zonasReparto: readonly string[];
  /** Migracion 057. false = solo recoger. */
  readonly aceptaDomicilio: boolean;
  /** Dias (0 = domingo .. 6) en que reparte; null = todos. */
  readonly diasDomicilio: readonly number[] | null;
  /** "Domicilio vie-dom" cuando reparte solo algunos dias; null si reparte todos los dias o es solo recoger. */
  readonly domicilioTexto: string | null;
}

async function vistaDeSucursal(repo: RestaurantesRepository, branch: Branch, now: Date): Promise<StorefrontBranchView> {
  const policy = await repo.findBranchPolicy(branch.propertyId);
  let abiertoAhora: boolean | null = null;
  let cierraA: string | null = null;
  let proximaApertura: StorefrontBranchView["proximaApertura"] = null;
  if (policy.horario && policy.horario.length > 0) {
    const zona = (await repo.findBranchZonaHoraria(branch.propertyId)).zonaHoraria;
    const estado = estaAbiertoAhora(policy.horario, now, zona);
    abiertoAhora = estado.abierto;
    cierraA = estado.cierraA;
    proximaApertura = estado.proximaApertura;
  }
  const zoneIds = await repo.listBranchDeliveryZoneIds(branch.propertyId);
  let zonasReparto: string[] = [];
  if (zoneIds.length > 0) {
    const zones = await repo.listKnownZones(branch.organizationId);
    zonasReparto = zones.filter((z) => zoneIds.includes(z.id)).map((z) => z.name).sort((a, b) => a.localeCompare(b, "es"));
  }
  return {
    slug: branch.slug,
    name: branch.name,
    address: branch.address,
    phone: branch.phone,
    whatsappUrl: enlaceWhatsapp(branch.phone, `Hola, quiero información de ${branch.name}.`),
    abiertoAhora,
    cierraA,
    proximaApertura,
    pedidoMinimoDomicilio: policy.pedidoMinimoDomicilio,
    pedidoMinimoRecoger: policy.pedidoMinimoRecoger,
    propinaPolitica: policy.propinaPolitica,
    zonasReparto,
    aceptaDomicilio: policy.aceptaDomicilio !== false,
    diasDomicilio: policy.diasDomicilio ?? null,
    domicilioTexto: policy.aceptaDomicilio === false ? null : insigniaDomicilio(policy),
  };
}

/** Sucursales ACTIVAS de la organizacion con su estado de apertura y reglas publicas. */
export async function buildStorefrontBranches(repo: RestaurantesRepository, organizationId: string, now: Date = new Date()): Promise<StorefrontBranchView[]> {
  const branches = (await repo.listBranchesForOrganizationAdmin(organizationId)).filter((b) => b.status === "active");
  const views: StorefrontBranchView[] = [];
  for (const branch of branches) views.push(await vistaDeSucursal(repo, branch, now));
  return views;
}

/** Una sucursal en el directorio publico `/pedir/:org/sucursales`. Solo datos publicos (nada de ids, coordenadas ni minimos). */
export interface StorefrontDirectorioItem {
  readonly slug: string;
  readonly name: string;
  readonly address: string | null;
  readonly phone: string | null;
  /** Turnos semanales tal como los configuro el negocio; null = sin horario publicado. */
  readonly horario: HorarioSucursal | null;
  /** null = sin horario configurado (no se afirma abierto ni cerrado). */
  readonly abiertoAhora: boolean | null;
  /** Solo las sucursales activas llevan a pedir en linea. */
  readonly pideEnLinea: boolean;
  readonly soloRecoger: boolean;
  /** "Domicilio vie-dom" cuando reparte solo algunos dias; null si reparte todos los dias o es solo recoger. */
  readonly insigniaDomicilio: string | null;
  readonly deTemporada: boolean;
  /** Visible pero inactiva: se informa, no se puede pedir. */
  readonly soloInformativa: boolean;
  /** Enlace de Maps construido con nombre y direccion del negocio (sin datos del cliente). */
  readonly comoLlegarUrl: string | null;
}

/** Enlace "Como llegar" de Google Maps con el nombre y la direccion publicos de la sucursal. */
export function enlaceComoLlegar(nombre: string, direccion: string | null): string | null {
  const dir = direccion?.trim();
  if (!dir) return null;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${nombre} ${dir}`)}`;
}

/**
 * Directorio publico: TODAS las sucursales con `visible_en_directorio` (por omision, las activas), activas o no.
 * Las inactivas se marcan "solo informativa" y no llevan a pedir. Nunca expone ids ni politica interna.
 */
export async function buildStorefrontDirectorio(repo: RestaurantesRepository, organizationId: string, now: Date = new Date()): Promise<StorefrontDirectorioItem[]> {
  const branches = await repo.listBranchesForOrganizationAdmin(organizationId);
  const items: StorefrontDirectorioItem[] = [];
  for (const branch of branches) {
    const policy = await repo.findBranchPolicy(branch.propertyId);
    const activa = branch.status === "active";
    if (!(policy.visibleEnDirectorio ?? activa)) continue;
    let abiertoAhora: boolean | null = null;
    if (activa && policy.horario && policy.horario.length > 0) {
      const zona = (await repo.findBranchZonaHoraria(branch.propertyId)).zonaHoraria;
      abiertoAhora = estaAbiertoAhora(policy.horario, now, zona).abierto;
    }
    const soloRecoger = policy.aceptaDomicilio === false;
    items.push({
      slug: branch.slug,
      name: branch.name,
      address: branch.address,
      phone: branch.phone,
      horario: policy.horario && policy.horario.length > 0 ? policy.horario : null,
      abiertoAhora,
      pideEnLinea: activa,
      soloRecoger,
      insigniaDomicilio: soloRecoger ? null : insigniaDomicilio(policy),
      deTemporada: policy.deTemporada === true,
      soloInformativa: !activa,
      comoLlegarUrl: enlaceComoLlegar(branch.name, branch.address),
    });
  }
  return items;
}

export interface StorefrontMenuItem {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly price: number;
  readonly imageUrl: string | null;
  readonly isPopular: boolean;
  /** false = "hoy no hay": se muestra pero no se puede agregar al carrito. */
  readonly available: boolean;
  /** Piezas por orden (3 para "orden de 3"), 1 individual, null = sin nocion de paquete. */
  readonly packSize: number | null;
  /** Alcohol: exige confirmar mayoria de edad. */
  readonly requiresAdultConfirmation: boolean;
  /** Tacos y platillos "de maiz o harina" del menu: exige elegir tortilla. */
  readonly requiresTortilla: boolean;
  /** No se vende a domicilio (solo recoger). */
  readonly noDomicilio: boolean;
}

export interface StorefrontMenuCategory {
  readonly id: string | null;
  readonly name: string;
  readonly items: readonly StorefrontMenuItem[];
}

/** Menu por categorias con los precios de LA sucursal. Las categorias sin productos no aparecen. */
export function groupStorefrontMenu(rows: readonly StorefrontCatalogRow[]): StorefrontMenuCategory[] {
  const categories: { id: string | null; name: string; items: StorefrontMenuItem[] }[] = [];
  const byKey = new Map<string, (typeof categories)[number]>();
  for (const row of rows) {
    const key = row.categoryId ?? "__sin_categoria__";
    let cat = byKey.get(key);
    if (!cat) {
      cat = { id: row.categoryId, name: row.categoryName ?? "Otros", items: [] };
      byKey.set(key, cat);
      categories.push(cat);
    }
    cat.items.push({
      id: row.id,
      name: row.name,
      description: row.description,
      price: row.price,
      imageUrl: row.imageUrl,
      isPopular: row.isPopular,
      available: row.isAvailable,
      packSize: extraerPackSize(row.name, row.description),
      requiresAdultConfirmation: requiresAdultConfirmation(row.name, row.categoryName),
      requiresTortilla: requiresTortillaChoice(row.name, row.description),
      noDomicilio: row.noDomicilio,
    });
  }
  return categories;
}

export async function buildStorefrontMenu(repo: RestaurantesRepository, propertyId: string): Promise<StorefrontMenuCategory[]> {
  return groupStorefrontMenu(await repo.listStorefrontCatalog(propertyId));
}

/**
 * Reglas duras del checkout WEB que `createOrder` no exige a la fuente "web" (un pedido capturado por
 * staff o integraciones historicas sigue sin ellas): direccion a domicilio, telefono mexicano de 10
 * digitos, forma de pago y promociones solo para recoger. Devuelve el input con el telefono canonico.
 */
/** El checkout web conserva su tope de 100 piezas por renglon (no tiene la retencion de pedido grande de los canales de agente). */
export function assertCantidadesWeb(cantidades: readonly unknown[]): void {
  for (const q of cantidades) {
    if (typeof q === "number" && q > MAX_PIEZAS_POR_RENGLON_WEB) throw new OrderValidationError(mensajeCantidadInvalida(q, MAX_PIEZAS_POR_RENGLON_WEB));
  }
}

/** Forma exacta de los codigos que emite `solicitud_resolver` (decision descuento_proximo): GRACIAS- y 8 caracteres hexadecimales en mayusculas. */
export const CODIGO_COMPENSACION_RE = /^GRACIAS-[A-Z0-9]{8}$/;
export function esCodigoDeCompensacion(code: string): boolean {
  return CODIGO_COMPENSACION_RE.test(code.trim().toUpperCase());
}

export function assertWebOrderRules(input: CreateOrderInput): CreateOrderInput {
  const canal: CanalPedido = input.canal === "recoger" ? "recoger" : "domicilio";
  if (input.canal !== undefined && input.canal !== "recoger" && input.canal !== "domicilio") {
    throw new OrderValidationError("El canal del pedido debe ser 'domicilio' o 'recoger'.");
  }
  const phone = canonicalizeMexicanPhone(input.customerPhone ?? "");
  if (!phone) throw new OrderValidationError("Escribe un teléfono de 10 dígitos para avisarte de tu pedido.");
  if (input.paymentMethod !== "efectivo" && input.paymentMethod !== "tarjeta") {
    throw new OrderValidationError("Elige cómo vas a pagar en la sucursal: efectivo o tarjeta.");
  }
  if (canal === "domicilio" && !(typeof input.customerAddress === "string" && input.customerAddress.trim())) {
    throw new OrderValidationError("Escribe la dirección completa de entrega.");
  }
  // Las promociones de PM valen solo para recoger. QA R2 features-07: el codigo de COMPENSACION (GRACIAS-XXXXXXXX, de un solo uso, lo emite
  // el sistema tras una queja resuelta) si vale tambien a domicilio: el cliente lo recibe con el aviso «use el codigo en su proximo pedido».
  if (canal === "domicilio" && typeof input.promoCode === "string" && input.promoCode.trim() && !esCodigoDeCompensacion(input.promoCode)) {
    throw new OrderValidationError("Las promociones solo aplican para pedidos que recoges en la sucursal.");
  }
  assertCantidadesWeb(input.items.map((i) => i.requestedQuantity ?? i.quantity));
  return { ...input, customerPhone: phone, canal };
}

export interface PromotionPreview {
  readonly valida: boolean;
  readonly codigo: string;
  readonly descuento: number;
  readonly totalConDescuento: number;
  readonly mensaje: string | null;
}

/** Vista previa del descuento de un codigo para un carrito YA cotizado. Nunca lanza por una promocion
 * invalida: devuelve `valida: false` con el motivo, para que el carrito lo muestre sin romper la cotizacion. */
export async function previewPromotion(
  repo: RestaurantesRepository,
  args: { readonly organizationId: string; readonly propertyId: string; readonly rawCode: string; readonly canal: CanalPedido; readonly total: number; readonly items: readonly PersistedOrderItem[]; readonly now?: Date },
): Promise<PromotionPreview> {
  const codigo = normalizePromotionCode(args.rawCode);
  const invalida = (mensaje: string): PromotionPreview => ({ valida: false, codigo, descuento: 0, totalConDescuento: args.total, mensaje });
  if (args.canal !== "recoger" && !esCodigoDeCompensacion(codigo)) return invalida("Las promociones solo aplican para pedidos que recoges en la sucursal.");
  const promotion = await repo.findPromotionByCode(args.organizationId, codigo);
  if (!promotion) return invalida(`El código "${codigo}" no existe.`);
  try {
    const zona = resolverZonaHorariaNegocio((await repo.findBranchZonaHoraria(args.propertyId)).zonaHoraria);
    const applied = applyPromotionToOrder({ promotion, orderTotal: args.total, items: args.items, canal: args.canal, now: args.now ?? new Date(), zonaHoraria: zona, propertyId: args.propertyId });
    return { valida: true, codigo, descuento: applied.discount, totalConDescuento: applied.total, mensaje: null };
  } catch (err) {
    if (err instanceof PromotionError) return invalida(err.message);
    throw err;
  }
}
