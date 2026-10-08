// QA-PM-R3-whatsapp-05 (P1): con un pin compartido y una calle sin nombre de colonia ("calle 34 #300 x 35, casa blanca"), cotizar rechazaba "No reconozco esa colonia"
// aunque el pin cae en la sucursal asignada; el agente entraba en bucle y escalaba zona_no_reconocida sin crear el pedido.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { OrderValidationError } from "../src/errors.ts";
import { COLONIA_FUERA_DE_VERIFICACION_MENSAJE } from "../src/reglas-pedido.ts";
import { createOrder, quoteOrder } from "../src/orders.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

const CERCA_DE_FCO = { lat: 21.0187, lng: -89.6709 };
const CERCA_DE_ALTABRISA = { lat: 21.0156, lng: -89.5982 };

function mundo() {
  const f = buildRestaurantFixture();
  const altabrisaId = randomUUID();
  f.repo.seedBranch({ propertyId: altabrisaId, organizationId: f.organizationId, name: "Victory Altabrisa", slug: "altabrisa", status: "active", phone: null, address: null, lat: 21.0156, lng: -89.5982 });
  const zonaMontejo = randomUUID();
  const zonaAltabrisa = randomUUID();
  f.repo.seedKnownZone({ id: zonaMontejo, organizationId: f.organizationId, name: "Montejo Centro", lat: 21.0186, lng: -89.6708 } as never);
  f.repo.seedKnownZone({ id: zonaAltabrisa, organizationId: f.organizationId, name: "Altabrisa Norte", lat: 21.0156, lng: -89.5982 } as never);
  f.repo.seedBranchDeliveryZones(f.propertyId, [zonaMontejo]);
  f.repo.seedBranchDeliveryZones(altabrisaId, [zonaAltabrisa]);
  return f;
}

const quote = (f: ReturnType<typeof mundo>, extra: Record<string, unknown> = {}) =>
  quoteOrder(f.repo, { organizationId: f.organizationId, branchSlug: "fco-montejo", items: [{ productId: f.products.cocaCola, requestedQuantity: 2 }], canal: "domicilio", colonia: "casa blanca", source: "whatsapp", ...extra } as never);

describe("pin + colonia que no se reconoce", () => {
  it("SIN pin la colonia desconocida sigue rechazada", async () => {
    const f = mundo();
    await expect(quote(f)).rejects.toThrow(COLONIA_FUERA_DE_VERIFICACION_MENSAJE);
  });

  it("CON pin dentro de la sucursal asignada: cotiza y crea sin exigir una colonia reconocida", async () => {
    const f = mundo();
    const q = await quote(f, { ubicacion: CERCA_DE_FCO });
    expect(q.total).toBe(90);
    const c = await createOrder(f.repo, {
      organizationId: f.organizationId, branchSlug: "fco-montejo", customerName: "Elena Prueba", customerPhone: "9991234567", customerAddress: "Calle 34 #300 x 35, casa blanca",
      items: [{ productId: f.products.cocaCola, requestedQuantity: 2 }], source: "whatsapp", canal: "domicilio", colonia: "casa blanca", paymentMethod: "efectivo", ubicacion: CERCA_DE_FCO,
    } as never);
    expect(c.total).toBe(90);
  });

  it("colonia vacia con pin valido tampoco bloquea (el pin ya dice donde es)", async () => {
    const f = mundo();
    expect((await quote(f, { colonia: undefined, ubicacion: CERCA_DE_FCO })).total).toBe(90);
  });

  it("el pin mas cerca de OTRA sucursal sigue rechazado (no se salta la cobertura)", async () => {
    const f = mundo();
    const q = await quote(f, { ubicacion: CERCA_DE_ALTABRISA }).catch((e: unknown) => e);
    expect(q).toBeInstanceOf(OrderValidationError);
  });

  it("una colonia que SI se reconoce y ninguna cobertura de esta sucursal incluye sigue rechazada aunque haya pin", async () => {
    const f = mundo();
    const q = await quote(f, { colonia: "Altabrisa Norte", ubicacion: CERCA_DE_FCO }).catch((e: unknown) => e);
    expect(q).toBeInstanceOf(OrderValidationError);
    expect((q as Error).message).toMatch(/fuera de la zona de reparto/);
  });
});
