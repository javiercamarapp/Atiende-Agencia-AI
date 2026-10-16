// Domicilio por sucursal (migracion 057): helpers puros + regla aplicada al cotizar y al crear pedidos
// (el agente de WhatsApp y de voz pasan por el mismo dominio)
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOrder, quoteOrder } from "../src/orders.ts";
import { OrderValidationError } from "../src/errors.ts";
import { aplicarReglasDeSucursal } from "../src/reglas-pedido.ts";
import { describirDiasDomicilio, evaluarDomicilioSucursal, insigniaDomicilio, mensajeDomicilioNoDisponible } from "../src/domicilio-sucursal.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

afterEach(() => {
  vi.useRealTimers();
});

// Merida es UTC-6 todo el año. 2026-10-09 es viernes.
const VIERNES_MEDIODIA = new Date("2026-10-09T18:00:00Z");
const MARTES_MEDIODIA = new Date("2026-10-06T18:00:00Z");
const SABADO_0030_MERIDA = new Date("2026-10-10T06:30:00Z");
const VIE_A_DOM = [5, 6, 0] as const;

describe("helpers de domicilio", () => {
  it("evalua solo recoger, dias permitidos y todos los dias", () => {
    expect(evaluarDomicilioSucursal({ aceptaDomicilio: false, diasDomicilio: null }, 3)).toEqual({ acepta: false, motivo: "solo_recoger" });
    expect(evaluarDomicilioSucursal({ aceptaDomicilio: true, diasDomicilio: VIE_A_DOM }, 5)).toEqual({ acepta: true });
    expect(evaluarDomicilioSucursal({ aceptaDomicilio: true, diasDomicilio: VIE_A_DOM }, 0)).toEqual({ acepta: true });
    expect(evaluarDomicilioSucursal({ aceptaDomicilio: true, diasDomicilio: VIE_A_DOM }, 2)).toEqual({ acepta: false, motivo: "dia_no_disponible" });
    expect(evaluarDomicilioSucursal({ aceptaDomicilio: true, diasDomicilio: null }, 2)).toEqual({ acepta: true });
    expect(evaluarDomicilioSucursal({}, 2)).toEqual({ acepta: true });
  });

  it("describe los dias en español de lectura (lunes primero) y la insignia corta", () => {
    expect(describirDiasDomicilio([5, 6, 0])).toBe("viernes a domingo");
    expect(describirDiasDomicilio([1, 3, 5])).toBe("lunes, miércoles y viernes");
    expect(describirDiasDomicilio([1, 2])).toBe("lunes y martes");
    expect(describirDiasDomicilio(null)).toBe("todos los días");
    expect(describirDiasDomicilio([0, 1, 2, 3, 4, 5, 6])).toBe("todos los días");
    expect(insigniaDomicilio({ aceptaDomicilio: true, diasDomicilio: [5, 6, 0] })).toBe("Domicilio vie-dom");
    expect(insigniaDomicilio({ aceptaDomicilio: false, diasDomicilio: null })).toBe("Solo recoger");
    expect(insigniaDomicilio({ aceptaDomicilio: true, diasDomicilio: null })).toBeNull();
  });

  it("el mensaje es honesto y ofrece recoger u otra sucursal", () => {
    expect(mensajeDomicilioNoDisponible("Pensiones", { diasDomicilio: VIE_A_DOM }, { acepta: false, motivo: "dia_no_disponible" })).toBe(
      "Pensiones solo entrega a domicilio de viernes a domingo; ¿la recoge o elige otra sucursal?",
    );
    expect(mensajeDomicilioNoDisponible("Chicxulub", { diasDomicilio: null }, { acepta: false, motivo: "solo_recoger" })).toContain("solo atiende pedidos para recoger");
  });
});

describe("la regla corre en cotizar y crear pedido (mismo dominio para WhatsApp, voz y web)", () => {
  const items = (f: ReturnType<typeof buildRestaurantFixture>) => [{ productId: f.products.cocaCola, requestedQuantity: 2 }];

  it("sucursal que solo reparte vie-dom: un martes la cotizacion a domicilio se rechaza y recoger sigue funcionando", async () => {
    const f = buildRestaurantFixture();
    f.repo.seedBranchPolicy(f.propertyId, { diasDomicilio: VIE_A_DOM });
    vi.useFakeTimers();
    vi.setSystemTime(MARTES_MEDIODIA);
    const error = await quoteOrder(f.repo, { organizationId: f.organizationId, branchSlug: "fco-montejo", items: items(f) }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OrderValidationError);
    expect((error as Error).message).toBe("Francisco de Montejo solo entrega a domicilio de viernes a domingo; ¿la recoge o elige otra sucursal?");
    const recoger = await quoteOrder(f.repo, { organizationId: f.organizationId, branchSlug: "fco-montejo", canal: "recoger", items: items(f) });
    expect(recoger.canal).toBe("recoger");
  });

  it("el viernes si reparte, y createOrder rechaza el martes sin crear pedido", async () => {
    const f = buildRestaurantFixture();
    f.repo.seedBranchPolicy(f.propertyId, { diasDomicilio: VIE_A_DOM });
    vi.useFakeTimers();
    vi.setSystemTime(VIERNES_MEDIODIA);
    await expect(quoteOrder(f.repo, { organizationId: f.organizationId, branchSlug: "fco-montejo", items: items(f) })).resolves.toMatchObject({ canal: "domicilio" });

    vi.setSystemTime(MARTES_MEDIODIA);
    await expect(
      createOrder(f.repo, {
        organizationId: f.organizationId,
        branchSlug: "fco-montejo",
        customerName: "Marcela Pech",
        customerPhone: "9991234567",
        customerAddress: "Calle 7 #210, Vista Alegre",
        items: items(f),
        source: "whatsapp",
        paymentMethod: "efectivo",
      }),
    ).rejects.toThrow(/solo entrega a domicilio de viernes a domingo/);
  });

  it("solo recoger: rechaza el domicilio cualquier dia pero acepta recoger", async () => {
    const f = buildRestaurantFixture();
    f.repo.seedBranchPolicy(f.propertyId, { aceptaDomicilio: false });
    await expect(aplicarReglasDeSucursal(f.repo, { branch: (await f.repo.findBranch(f.organizationId, { slug: "fco-montejo" }))!, canal: "domicilio", subtotal: 100, now: VIERNES_MEDIODIA })).rejects.toThrow(/solo atiende pedidos para recoger/);
    await expect(aplicarReglasDeSucursal(f.repo, { branch: (await f.repo.findBranch(f.organizationId, { slug: "fco-montejo" }))!, canal: "recoger", subtotal: 100, now: VIERNES_MEDIODIA })).resolves.toBeTruthy();
  });

  it("usa el dia de NEGOCIO: a la 00:30 del sabado, la cola del turno del viernes todavia cuenta como viernes", async () => {
    const f = buildRestaurantFixture();
    f.repo.seedBranchPolicy(f.propertyId, { diasDomicilio: [5], horario: [{ dias: [5], abre: "12:00", cierra: "01:00" }] });
    const branch = (await f.repo.findBranch(f.organizationId, { slug: "fco-montejo" }))!;
    await expect(aplicarReglasDeSucursal(f.repo, { branch, canal: "domicilio", subtotal: 100, now: SABADO_0030_MERIDA })).resolves.toMatchObject({ diaNegocio: 5 });
  });

  it("sin configurar nada (politica vacia) el domicilio funciona como siempre", async () => {
    const f = buildRestaurantFixture();
    const branch = (await f.repo.findBranch(f.organizationId, { slug: "fco-montejo" }))!;
    await expect(aplicarReglasDeSucursal(f.repo, { branch, canal: "domicilio", subtotal: 100, now: MARTES_MEDIODIA })).resolves.toBeTruthy();
  });
});
