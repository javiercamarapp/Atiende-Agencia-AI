// Mundo en memoria de "Los Taquitos de PM" construido a partir del plan del seed (R-01): organizacion, sucursales con su
// menu y precios, politica (horario 12:00-01:00, minimo $200, propina solo con tarjeta), alcohol `no_domicilio` y la
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
    repo.seedProduct({ id, organizationId, categoryId: categoryIds.get(p.categorySlug)!, name: p.name, description: p.description, searchKeywords: [], price: p.price, isPopular: p.isPopular, displayOrder: p.displayOrder });
    if (p.noDomicilio) repo.seedNoDomicilio({ productIds: [id] });
  }
  const propertyBySlug = new Map<string, string>();
  for (const b of plan.branches) {
    const propertyId = newId("sucursal", b.slug);
    propertyBySlug.set(b.slug, propertyId);
    repo.seedBranch({ propertyId, organizationId, name: b.name, slug: b.slug, status: b.status, phone: b.phone, address: b.address, lat: b.lat, lng: b.lng });
    if (!b.menu) continue;
    for (const p of plan.products) {
      if (b.menu === "grande" || p.scope === "todas") repo.seedBranchProduct({ propertyId, productId: productIds.get(p.name)!, price: p.price, isAvailable: true });
    }
    repo.seedBranchPolicy(propertyId, {
      horario: plan.policy.horario as never,
      pedidoMinimoDomicilio: plan.policy.pedidoMinimoDomicilio,
      pedidoMinimoRecoger: plan.policy.pedidoMinimoRecoger,
      propinaPolitica: plan.policy.propinaPolitica as never,
    });
  }
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
    });
  }
  return { repo, organizationId, propertyBySlug, productIds };
}
