// PM R13 (T7-031: 3 x $283 = $2,399 en 2 de 8 corridas). El menu REAL (volcado del 14-oct) NO trae «Orden de 1 flauta grande», asi que `packSize` de las flautas
// es null y `unidadDeVentaFlautas` (que exigia packSize === 1) nunca actuaba: el modelo no recibia «cada orden es UNA flauta grande» y preguntaba o cotizaba 3.
// La regla aplica tambien con packSize null/undefined; un numero explicito distinto de 1 (PM cambio la presentacion) sigue mandando.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { invokeAgentTool, quoteToWire } from "../src/agent-tools/registry.ts";
import { InMemoryRestaurantesRepository } from "../src/in-memory-repository.ts";
import { buildOrderQuoteFromProducts } from "../src/order-quote.ts";
import { extraerPackSize, unidadDeVenta, unidadDeVentaFlautas } from "../src/product-search.ts";

const AVISO = /Cada ORDEN de flautas es UNA flauta grande/;
type P = Parameters<typeof unidadDeVentaFlautas>[0];
const flauta = (packSize: number | null | undefined, name = "Flauta de Pechuga", categoryName: string | null = "Flautas"): P => ({ name, categoryName, packSize: packSize as number | null });

describe("flautas: la regla de una flauta grande por orden con packSize null/undefined", () => {
  it("packSize null (menu real) -> aviso", () => {
    expect(unidadDeVentaFlautas(flauta(null))).toMatch(AVISO);
    expect(unidadDeVenta(flauta(null))).toMatch(AVISO);
  });
  it("packSize undefined (producto sin el dato) -> aviso", () => {
    expect(unidadDeVentaFlautas(flauta(undefined))).toMatch(AVISO);
  });
  it("packSize 1 (seed) -> aviso, igual que antes", () => {
    expect(unidadDeVentaFlautas(flauta(1))).toMatch(AVISO);
  });
  it.each([2, 3, 4, 6])("packSize explicito %i (PM cambio la presentacion) -> sin aviso: manda el pack_size", (n) => {
    expect(unidadDeVentaFlautas(flauta(n))).toBeNull();
    expect(unidadDeVenta(flauta(n))).toBeNull();
  });
  it("sin categoria, solo por nombre (flauta/flautas, mayusculas) con packSize null", () => {
    for (const name of ["Flauta de Arrachera", "FLAUTAS de Poc-Chuc", "Flauta de Pechuga"]) expect(unidadDeVentaFlautas({ name, packSize: null }), name).toMatch(AVISO);
  });
  it("por categoria «Flautas» aunque el nombre no lo diga (como hoy)", () => {
    expect(unidadDeVentaFlautas({ name: "Poc-Chuc", categoryName: "Flautas", packSize: null })).toMatch(AVISO);
  });
  it("sigue preguntando la contradiccion «4 flautas, una orden»", () => {
    const msg = unidadDeVentaFlautas(flauta(null))!;
    expect(msg).toMatch(/«4 flautas, una orden»/);
    expect(msg).toMatch(/NO adivines/);
  });
  it.each([
    ["Coca-Cola", "Bebidas"],
    ["Tacos de Bistec (orden de 3)", "Tacos"],
    ["Bistec de Res — 1 kg", "Por kilo"],
    ["Frijoles Charros Normal", "Frijoles Charros"],
    ["Nachos de Pastor", "Nachos"],
  ])("producto que no es flauta («%s») con packSize null -> sin aviso de flautas", (name, categoryName) => {
    expect(unidadDeVentaFlautas({ name, categoryName, packSize: null })).toBeNull();
    expect(unidadDeVenta({ name, categoryName, packSize: null })).toBeNull();
  });
  it("alitas y crujientes con packSize null conservan su aviso propio (sin mencionar flautas)", () => {
    for (const name of ["Alitas de Pollo", "Crujientes de Pechuga"]) {
      const msg = unidadDeVenta({ name, categoryName: "Entradas", packSize: null })!;
      expect(msg, name).toMatch(/ORDEN completa/);
      expect(msg, name).not.toMatch(/flauta/i);
    }
  });
  it("la descripcion del menu real no inventa un pack_size", () => {
    expect(extraerPackSize("Flauta de Pechuga", "Tortilla de maíz grande y frita, rellena de pechuga")).toBeNull();
  });
});

describe("flautas con el menu real (descripcion SIN «Orden de 1 flauta grande»): herramienta y cotizacion", () => {
  function mundo() {
    const repo = new InMemoryRestaurantesRepository();
    const organizationId = randomUUID();
    const propertyId = randomUUID();
    repo.seedOrganization({ id: organizationId, slug: "pm-r13", name: "PM R13" });
    repo.seedBranch({ propertyId, organizationId, name: "Sucursal", slug: "t7", status: "active", phone: null, address: "Calle de prueba, Mérida", lat: 21.0186, lng: -89.6708 });
    const categoryId = randomUUID();
    repo.seedCategory({ id: categoryId, organizationId, name: "Flautas" });
    const id = randomUUID();
    repo.seedProduct({ id, organizationId, categoryId, name: "Flauta de Pechuga", description: "Tortilla de maíz grande y frita, rellena de pechuga deshebrada", searchKeywords: [] });
    repo.seedBranchProduct({ propertyId, productId: id, price: 283, isAvailable: true });
    return { repo, organizationId, id };
  }

  it("buscar_producto devuelve pack_size null Y el aviso de unidad", async () => {
    const m = mundo();
    const out = await invokeAgentTool(m.repo, { organizationId: m.organizationId, channel: "whatsapp", phone: "9991234567" }, "buscar_producto", { query: "flauta de pechuga", branch_slug: "t7" });
    const r = (out.result as Array<{ name: string; pack_size: number | null; unidad_de_venta?: string }>).find((p) => p.name === "Flauta de Pechuga")!;
    expect(r.pack_size).toBeNull();
    expect(r.unidad_de_venta).toMatch(AVISO);
  });

  it("la cotizacion lleva la unidad en la linea de flautas aunque packSize sea null", () => {
    const p = { id: randomUUID(), name: "Flauta de Pechuga", price: 283, packSize: null, requiresAdultConfirmation: false };
    const wire = quoteToWire(buildOrderQuoteFromProducts([{ productId: p.id, requestedQuantity: 3 }], [p]));
    expect(wire.lines[0]!.unidad_de_venta).toMatch(AVISO);
  });
});
