// Fixture compartido de tests — seed real (no mockeado) de un restaurante con una
// sucursal, categorías y productos, sobre InMemoryRestaurantesRepository. Los datos
// son deliberadamente parecidos a los del restaurante piloto real del origen ("Los
// Taquitos de PM") para que los tests lean como escenarios reales.
import { randomUUID } from "node:crypto";
import { InMemoryRestaurantesRepository } from "../src/in-memory-repository.ts";

export function buildRestaurantFixture() {
  const repo = new InMemoryRestaurantesRepository();

  const organizationId = randomUUID();
  const propertyId = randomUUID();
  repo.seedOrganization({ id: organizationId, slug: "los-taquitos-de-pm", name: "Los Taquitos de PM" });
  repo.seedBranch({
    propertyId,
    organizationId,
    name: "Francisco de Montejo",
    slug: "fco-montejo",
    status: "active",
    phone: "+529991234567",
    address: "Calle 1 #100, Mérida",
  });

  const catTacos = randomUUID();
  const catBebidas = randomUUID();
  const catCervezas = randomUUID();
  repo.seedCategory({ id: catTacos, organizationId, name: "Tacos" });
  repo.seedCategory({ id: catBebidas, organizationId, name: "Bebidas" });
  repo.seedCategory({ id: catCervezas, organizationId, name: "Cervezas" });

  const tacosPastor = randomUUID();
  repo.seedProduct({
    id: tacosPastor,
    organizationId,
    categoryId: catTacos,
    name: "Tacos de Bistec de Res (orden de 3)",
    description: "Orden de 3 tacos de bistec",
    searchKeywords: [],
  });
  repo.seedBranchProduct({ propertyId, productId: tacosPastor, price: 164, isAvailable: true });

  const cocaCola = randomUUID();
  repo.seedProduct({ id: cocaCola, organizationId, categoryId: catBebidas, name: "Coca-Cola", description: null, searchKeywords: [] });
  repo.seedBranchProduct({ propertyId, productId: cocaCola, price: 45, isAvailable: true });

  const quesobich = randomUUID();
  repo.seedProduct({
    id: quesobich,
    organizationId,
    categoryId: randomUUID(),
    name: "Quesobich de Queso",
    description: "Pizza estilo Quesobich",
    searchKeywords: ["pizza"],
  });
  repo.seedBranchProduct({ propertyId, productId: quesobich, price: 120, isAvailable: true });

  const cervezaSol = randomUUID();
  repo.seedProduct({ id: cervezaSol, organizationId, categoryId: catCervezas, name: "Sol", description: null, searchKeywords: [] });
  repo.seedBranchProduct({ propertyId, productId: cervezaSol, price: 66, isAvailable: true });

  return {
    repo,
    organizationId,
    propertyId,
    products: { tacosPastor, cocaCola, quesobich, cervezaSol },
  };
}
