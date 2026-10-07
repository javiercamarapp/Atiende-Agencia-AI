// Mundo en memoria de "Los Taquitos de PM" construido a partir del plan del seed (R-01): organizacion, sucursales con su
// catalogo y precio por sucursal, politica (horario 12:00-01:00, minimo $200, propina solo con tarjeta), alcohol `no_domicilio` y la
// promocion 2x1 del lunes. Es el MISMO repositorio en memoria real (`InMemoryRestaurantesRepository`) que usan las pruebas, asi
// que sirve para correr el motor real de pedidos sin base de datos: el seed de volumen lo usa para verificar y para
// generar su SQL de prueba (scripts/verify-restaurantes-demo-volumen).
import { createHash, randomUUID } from "node:crypto";
import { InMemoryRestaurantesRepository } from "../in-memory-repository.ts";
import type { PmSeedPlan } from "./pm-demo.ts";

export interface PmWorld {
  readonly repo: InMemoryRestaurantesRepository;
  readonly organizationId: string;
  readonly propertyBySlug: ReadonlyMap<string, string>;
  readonly productIds: ReadonlyMap<string, string>;
}

/** uuid v4-con-forma derivado de un texto: mismos nombres -> mismos ids (salidas reproducibles byte a byte). */
export function stableUuid(seed: string): string {
  const h = createHash("sha1").update(seed).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export async function buildInMemoryPmWorld(plan: PmSeedPlan, ids: { readonly organizationId?: string; readonly deterministic?: boolean } = {}): Promise<PmWorld> {
  const repo = new InMemoryRestaurantesRepository();
  const newId = (kind: string, key: string) => (ids.deterministic ? stableUuid(`pm-world:${kind}:${key}`) : randomUUID());
  const organizationId = ids.organizationId ?? newId("org", plan.organization.slug);
  repo.seedOrganization({ id: organizationId, slug: plan.organization.slug, name: plan.organization.name });

  const categoryIds = new Map<string, string>();
  for (const c of plan.categories) {
    const id = newId("categoria", c.slug);
    categoryIds.set(c.slug, id);
    repo.seedCategory({ id, organizationId, name: c.name, slug: c.slug, displayOrder: c.displayOrder });
  }
  const productIds = new Map<string, string>();
  for (const p of plan.products) {
    const id = newId("producto", p.name);
    productIds.set(p.name, id);
    repo.seedProduct({ id, organizationId, categoryId: categoryIds.get(p.categorySlug)!, name: p.name, description: p.description, searchKeywords: [...p.searchKeywords], price: p.price, isPopular: p.isPopular, displayOrder: p.displayOrder });
    if (p.noDomicilio) repo.seedNoDomicilio({ productIds: [id] });
  }
  const propertyBySlug = new Map<string, string>();
  for (const b of plan.branches) {
    const propertyId = newId("sucursal", b.slug);
    propertyBySlug.set(b.slug, propertyId);
    repo.seedBranch({ propertyId, organizationId, name: b.name, slug: b.slug, status: b.status, phone: b.phone, address: b.address, lat: b.lat, lng: b.lng });
    // Directorio y domicilio (migracion 057): se siembran aunque la sucursal no tenga catalogo (Galerias es solo informativa).
    const directorio = { visibleEnDirectorio: b.visibleEnDirectorio, aceptaDomicilio: b.aceptaDomicilio, diasDomicilio: b.diasDomicilio, deTemporada: b.deTemporada };
    if (b.catalogSize === 0) {
      repo.seedBranchPolicy(propertyId, directorio);
      continue;
    }
    // Precio y disponibilidad POR SUCURSAL: sin llave en branchPrices el producto no existe en esa sucursal.
    for (const p of plan.products) {
      const price = p.branchPrices[b.id];
      if (price !== undefined) repo.seedBranchProduct({ propertyId, productId: productIds.get(p.name)!, price, isAvailable: true });
    }
    repo.seedBranchPolicy(propertyId, {
      horario: plan.policy.horario as never,
      pedidoMinimoDomicilio: plan.policy.pedidoMinimoDomicilio,
      pedidoMinimoRecoger: plan.policy.pedidoMinimoRecoger,
      propinaPolitica: plan.policy.propinaPolitica as never,
      ...directorio,
    });
  }
  // Zonas conocidas y cobertura de entrega, igual que el SQL del seed (pasos 6, 6b y 6c): puntos de las sucursales con coordenadas y colonias sin
  // coordenadas; cada una cubre solo la sucursal que le asigno el plan (las sin asignar no cubren ninguna).
  const zonaIds = new Map<string, string>();
  const coberturas = new Map<string, string[]>();
  const cubrir = (zoneName: string, branchIds: readonly string[], lat: number | null, lng: number | null, extra: Partial<Parameters<typeof repo.seedKnownZone>[0]> = {}) => {
    const id = newId("zona", zoneName);
    zonaIds.set(zoneName, id);
    repo.seedKnownZone({ id, organizationId, name: zoneName, lat, lng, ...extra });
    // Cobertura multiple: una fila por sucursal (igual que el SQL del seed).
    for (const branchId of branchIds) {
      const slug = plan.branches.find((b) => b.id === branchId)?.slug;
      const propertyId = slug ? propertyBySlug.get(slug) : undefined;
      if (propertyId) coberturas.set(propertyId, [...(coberturas.get(propertyId) ?? []), id]);
    }
  };
  for (const z of plan.zones) cubrir(z.name, [z.branchId], z.lat, z.lng);
  for (const c of plan.colonias) {
    cubrir(c.name, c.branchIds, null, null, { fuente: c.fuente, asignacionFuente: c.asignacionFuente, refSucursalSlug: c.refSlug, refKm: c.refKm, ref2SucursalSlug: c.ref2Slug, ref2Km: c.ref2Km });
  }
  for (const [propertyId, ids] of coberturas) repo.seedBranchDeliveryZones(propertyId, ids);
  for (const promo of plan.promotions) {
    await repo.createPromotion(organizationId, {
      code: promo.code,
      name: promo.name,
      type: promo.type,
      value: 1,
      autoApply: promo.autoApply,
      daysOfWeek: promo.daysOfWeek,
      channels: promo.channels as never,
      productIds: promo.productNames.map((n) => productIds.get(n)!).filter(Boolean),
      // Combo de cortesia (migracion 031): las aguas a elegir y las piezas por unidad disparadora.
      ...(promo.type === "cortesia" ? { courtesyProductIds: (promo.courtesyProductNames ?? []).map((n) => productIds.get(n)!).filter(Boolean), courtesyQuantity: promo.courtesyQuantity } : {}),
      // Mismo alcance por sucursal que el SQL del seed (migracion 038): ids del seed (T2, T3...) -> sucursales de este mundo.
      ...(promo.branchIds
        ? { propertyIds: plan.branches.filter((b) => promo.branchIds!.includes(b.id)).map((b) => propertyBySlug.get(b.slug)!) }
        : {}),
    });
  }
  // Misma configuracion del agente que inserta el SQL del seed (perfil taqueria_pm con los datos del dueño; sin nombre inventado).
  const configOrg = {
    perfil: plan.whatsappAgent.perfil,
    agentName: plan.whatsappAgent.agentName,
    businessName: plan.whatsappAgent.businessName,
    toneStyle: plan.whatsappAgent.toneStyle as never,
    deliveryTimeText: plan.whatsappAgent.deliveryTimeText,
    salsasText: plan.whatsappAgent.salsasText,
    promosText: plan.whatsappAgent.promosText,
    escalationReasonsOff: [],
    ...(plan.whatsappAgent.replyDebounceSeconds !== null ? { replyDebounceSeconds: plan.whatsappAgent.replyDebounceSeconds } : {}),
  };
  await repo.upsertWhatsAppAgentConfig(organizationId, null, configOrg);
  // Filas propias de sucursal (10b del SQL): copian la de la organizacion y solo cambian el tiempo de entrega.
  for (const d of plan.whatsappAgent.deliveryByBranch) {
    const slug = plan.branches.find((b) => b.id === d.branchId)?.slug;
    const propertyId = slug ? propertyBySlug.get(slug) : undefined;
    if (propertyId) await repo.upsertWhatsAppAgentConfig(organizationId, propertyId, { ...configOrg, deliveryTimeText: d.deliveryTimeText });
  }
  return { repo, organizationId, propertyBySlug, productIds };
}
