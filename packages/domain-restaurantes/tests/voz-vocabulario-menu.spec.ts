// Keyterms del STT de la llamada: nombres y apodos del menu de la sucursal marcada, tope 50, sin datos personales.
import { describe, expect, it } from "vitest";
import { InMemoryRestaurantesRepository, armarInstruccionLlamada, vocabularioMenuVoz } from "../src/index.ts";
import type { VozConfig } from "../src/index.ts";

const ORG = "00000000-0000-4000-8000-000000000001";
const PROP = "00000000-0000-4000-8000-0000000000a1";
const CONFIG: VozConfig = { habilitado: true, proveedor: "gemini-3.8-live", voiceId: "Kore", comportamiento: "", mensajeInicial: "", configurada: true };

describe("vocabularioMenuVoz", () => {
  it("nombres sin parentesis de presentacion, unicos, y luego apodos; tope 50", () => {
    expect(vocabularioMenuVoz([{ name: "Gringas (orden de 3)", searchKeywords: ["mestizas"] }, { name: "Gringas (individual)", searchKeywords: ["alambre", "ab"] }])).toEqual(["Gringas", "alambre", "mestizas"]);
    const muchos = Array.from({ length: 80 }, (_, i) => ({ name: `Platillo ${i}`, searchKeywords: [] as string[] }));
    expect(vocabularioMenuVoz(muchos)).toHaveLength(50);
  });
});

describe("vocabularioMenuVoz: orden y mezcla con 80 productos", () => {
  const productos = Array.from({ length: 80 }, (_, i) => ({ name: `Platillo ${String(i).padStart(2, "0")}`, searchKeywords: [`apodo${String(i).padStart(2, "0")}`] }));
  it("tope 50, deterministico (mismo resultado barajando la entrada) y los apodos entran aunque haya mas de 50 productos", () => {
    const v = vocabularioMenuVoz(productos);
    expect(v).toHaveLength(50);
    expect(v.filter((t) => t.startsWith("apodo")).length).toBeGreaterThanOrEqual(20);
    expect(vocabularioMenuVoz([...productos].reverse())).toEqual(v);
  });
  it("los populares y el displayOrder van primero", () => {
    const v = vocabularioMenuVoz([{ name: "Zeta", searchKeywords: [] }, { name: "Alfa", searchKeywords: [] }, { name: "Gringas", searchKeywords: ["mestizas"], isPopular: true }], 2);
    expect(v).toEqual(["Gringas", "mestizas"]);
    expect(vocabularioMenuVoz([{ name: "Beta", searchKeywords: [], displayOrder: 2 }, { name: "Alfa", searchKeywords: [], displayOrder: 5 }, { name: "Cero", searchKeywords: [], displayOrder: 1 }], 2)).toEqual(["Cero", "Beta"]);
  });
});

describe("vocabularioMenuVoz: entrada hostil", () => {
  it("miles de '(' no se cuelgan (tiempo lineal) y siguen quitando los parentesis normales", () => {
    const t0 = Date.now();
    expect(vocabularioMenuVoz([{ name: "(".repeat(50_000), searchKeywords: [] }, { name: "Gringas (orden de 3)", searchKeywords: [] }])).toEqual(["Gringas"]);
    expect(Date.now() - t0).toBeLessThan(500);
  });
});

describe("armarInstruccionLlamada: vocabulario", () => {
  it("trae los productos disponibles de la sucursal y no los de otra ni los agotados", async () => {
    const repo = new InMemoryRestaurantesRepository();
    repo.seedOrganization({ id: ORG, slug: "pm", name: "PM" });
    repo.seedBranch({ propertyId: PROP, organizationId: ORG, name: "Montejo", slug: "montejo", status: "active", phone: null, address: null, lat: null, lng: null });
    repo.seedProduct({ id: "p1", organizationId: ORG, categoryId: null, name: "Gringas", description: null, searchKeywords: ["mestizas"] });
    repo.seedProduct({ id: "p2", organizationId: ORG, categoryId: null, name: "Suizo", description: null, searchKeywords: [] });
    repo.seedBranchProduct({ propertyId: PROP, productId: "p1", price: 10, isAvailable: true });
    repo.seedBranchProduct({ propertyId: PROP, productId: "p2", price: 10, isAvailable: false });
    const r = await armarInstruccionLlamada(repo, { organizationId: ORG, propertyId: PROP, telefono: "9991234567", config: CONFIG, ahora: new Date("2026-03-10T18:00:00Z") });
    expect(r.vocabulario).toEqual(["Gringas", "mestizas"]);
    expect(JSON.stringify(r.vocabulario)).not.toContain("9991234567");
  });
});
