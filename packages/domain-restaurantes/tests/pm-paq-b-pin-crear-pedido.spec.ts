// Paquete B (B1/B2) por el camino REAL: crear_pedido de PM con el pin compartido no vuelve a pedir calle y numero; pide solo la referencia, una vez. Tablaje o referencia bastan.
// Con la bandera apagada el camino es el de siempre. Datos inventados. Sin LLM.
import { afterEach, describe, expect, it, vi } from "vitest";
import { invokeAgentTool } from "../src/agent-tools/registry.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

const PM = { perfil: "taqueria_pm", agentName: "Lupe", businessName: null, toneStyle: null, deliveryTimeText: null } as never;
const PHONE = "+5219991234567";
const PIN = { lat: 21.0186, lng: -89.6708 };

async function intentar(direccion: string, extra: Record<string, unknown>): Promise<string> {
  const f = buildRestaurantFixture();
  await f.repo.upsertWhatsAppAgentConfig(f.organizationId, null, PM);
  const input = { branch_slug: "fco-montejo", customer_name: "Carlos Prueba", customer_address: direccion, canal: "domicilio", payment_method: "tarjeta", items: [{ product_id: f.products.cocaCola, requested_quantity: 1 }] };
  return invokeAgentTool(f.repo, { organizationId: f.organizationId, channel: "whatsapp" as const, phone: PHONE, ...extra }, "crear_pedido", input).then(
    () => "",
    (e: Error) => e.message,
  );
}

describe("crear_pedido con pin (paquete B)", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("encendida + pin + direccion de relleno: pide SOLO la referencia y NO calle y numero", async () => {
    vi.stubEnv("RESTAURANTES_GEOCERCAS", "1");
    const m = await intentar("la que te mandé", { sharedLocation: PIN });
    expect(m).toMatch(/Ya tengo su ubicación/);
    expect(m).toMatch(/referencia/i);
    expect(m).toMatch(/NO pida calle ni número/);
  });
  it("encendida + pin + tablaje: no se rechaza por falta de direccion", async () => {
    vi.stubEnv("RESTAURANTES_GEOCERCAS", "1");
    const m = await intentar("Residencial Ficticia, tablaje 12345, privada con portón negro", { sharedLocation: PIN });
    expect(m).not.toMatch(/Ya tengo su ubicación/);
    expect(m).not.toMatch(/dirección de entrega no es utilizable/);
  });
  it("encendida + pin + direccion normal: pasa", async () => {
    vi.stubEnv("RESTAURANTES_GEOCERCAS", "1");
    expect(await intentar("Calle 5 #100, Real Montejo", { sharedLocation: PIN })).not.toMatch(/Ya tengo su ubicación/);
  });
  it("encendida pero SIN pin: rige lo de siempre (no usa el mensaje del paquete B)", async () => {
    vi.stubEnv("RESTAURANTES_GEOCERCAS", "1");
    expect(await intentar("la que te mandé", {})).not.toMatch(/Ya tengo su ubicación/);
  });
  it("apagada (por omision): el mismo caso no usa el mensaje del paquete B", async () => {
    expect(await intentar("la que te mandé", { sharedLocation: PIN })).not.toMatch(/Ya tengo su ubicación/);
  });
});
