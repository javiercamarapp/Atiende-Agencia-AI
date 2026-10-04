// Fixture compartido de las regresiones del original (atiende-restaurantes): restaurante PM de tres sucursales
// con un catalogo parecido al real, sobre el repositorio en memoria (mismos cerrojos por clave que el SQL).
import { randomUUID } from "node:crypto";
import { InMemoryRestaurantesRepository } from "../../src/in-memory-repository.ts";
import type { CreateOrderInput, RequestedOrderItemInput } from "../../src/types.ts";

export const DIAS_TODOS = [0, 1, 2, 3, 4, 5, 6];

export function pmFixture() {
  const repo = new InMemoryRestaurantesRepository();
  const organizationId = randomUUID();
  repo.seedOrganization({ id: organizationId, slug: "los-taquitos-de-pm", name: "Los Taquitos de PM" });
  const t1 = randomUUID();
  const t3 = randomUUID();
  const t8 = randomUUID();
  const sucursal = (propertyId: string, name: string, slug: string, lat: number, lng: number) =>
    repo.seedBranch({ propertyId, organizationId, name, slug, status: "active", phone: null, address: `${name}, Merida`, lat, lng });
  sucursal(t1, "Francisco de Montejo", "t1-montejo", 21.0186, -89.6708);
  sucursal(t3, "Pensiones", "t3-pensiones", 20.9751, -89.5923);
  sucursal(t8, "Altabrisa", "t8-altabrisa", 21.0213, -89.5578);

  const cat = (name: string) => {
    const id = randomUUID();
    repo.seedCategory({ id, organizationId, name });
    return id;
  };
  const catTacos = cat("Tacos");
  const catBebidas = cat("Bebidas");
  const catCervezas = cat("Cervezas");
  const catCocteles = cat("Cocteles");
  const catAntojitos = cat("Antojitos");
  const catCarnes = cat("Carnes");

  const producto = (categoryId: string, name: string, price: number, opts: { description?: string | null; keywords?: string[]; sucursales?: string[] } = {}) => {
    const id = randomUUID();
    repo.seedProduct({ id, organizationId, categoryId, name, description: opts.description ?? null, searchKeywords: opts.keywords ?? [] });
    for (const propertyId of opts.sucursales ?? [t1, t3, t8]) repo.seedBranchProduct({ propertyId, productId: id, price, isAvailable: true });
    return id;
  };

  const p = {
    pastor: producto(catTacos, "Taco al Pastor (individual)", 42, { description: "Individual", keywords: ["trompo"] }),
    bistec: producto(catTacos, "Tacos de Bistec de Res (orden de 3)", 164, { description: "Orden de 3 tacos de bistec" }),
    guacamole: producto(catAntojitos, "Guacamole", 30),
    extraGuacamole: producto(catAntojitos, "Extra Guacamole", 25),
    frijolesMedia: producto(catAntojitos, "Frijoles Charros (1/2 orden)", 35),
    frijolesOrden: producto(catAntojitos, "Frijoles Charros", 60),
    cocaCola: producto(catBebidas, "Coca-Cola", 45),
    sol: producto(catCervezas, "Sol", 66, { keywords: ["chela"] }),
    heineken0: producto(catCervezas, "Heineken 0.0", 55),
    margarita: producto(catCocteles, "Margarita", 90, { description: "Coctel Margarita" }),
    arrachera500: producto(catCarnes, "Arrachera 500 g", 180),
    arrachera750: producto(catCarnes, "Arrachera 750 g", 260),
    arrachera1kg: producto(catCarnes, "Arrachera 1 kg", 340),
    arrachera1500: producto(catCarnes, "Arrachera 1.5 kg", 500),
    pizza: producto(randomUUID(), "Quesobich de Queso", 120, { description: "Pizza estilo Quesobich", keywords: ["pizza"] }),
  };
  return { repo, organizationId, t1, t3, t8, p, categorias: { cervezas: catCervezas } };
}
export type F = ReturnType<typeof pmFixture>;

export const item = (productId: string, requestedQuantity: number, tortilla?: "maiz" | "harina"): RequestedOrderItemInput => ({ productId, requestedQuantity, ...(tortilla ? { tortilla } : {}) });

export function pedido(f: F, items: NonNullable<CreateOrderInput["items"]>, extra: Partial<CreateOrderInput> = {}): CreateOrderInput {
  return {
    organizationId: f.organizationId,
    branchSlug: "t1-montejo",
    customerName: "Marcela Pech",
    customerPhone: "9991234567",
    customerAddress: "Calle 7 #210 x 20 y 22, Vista Alegre",
    items,
    source: "whatsapp",
    paymentMethod: "efectivo",
    ...extra,
  };
}

export const mensajeDe = async (promesa: Promise<unknown>) => ((await promesa.catch((e: unknown) => e)) as Error).message;
