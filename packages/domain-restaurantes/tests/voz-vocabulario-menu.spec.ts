// Keyterms del STT de la llamada: nombres y apodos del menu de la sucursal marcada, tope 50, sin datos personales.
import { describe, expect, it } from "vitest";
import { InMemoryRestaurantesRepository, armarInstruccionLlamada, vocabularioMenuVoz } from "../src/index.ts";
import type { VozConfig } from "../src/index.ts";

const ORG = "00000000-0000-4000-8000-000000000001";
const PROP = "00000000-0000-4000-8000-0000000000a1";
const CONFIG: VozConfig = { habilitado: true, proveedor: "gemini-3.8-live", voiceId: "Kore", comportamiento: "", mensajeInicial: "", configurada: true };

describe("vocabularioMenuVoz", () => {
  it("nombres sin parentesis de presentacion, unicos, y luego apodos; tope 50", () => {
    expect(vocabularioMenuVoz([{ name: "Gringas (orden de 3)", searchKeywords: ["mestizas"] }, { name: "Gringas (individual)", searchKeywords: ["alambre", "ab"] }])).toEqual(["Gringas", "mestizas", "alambre"]);
    const muchos = Array.from({ length: 80 }, (_, i) => ({ name: `Platillo ${i}`, searchKeywords: [] as string[] }));
    expect(vocabularioMenuVoz(muchos)).toHaveLength(50);
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
