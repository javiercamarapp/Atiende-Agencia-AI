// Domicilio por sucursal (migracion 057): helpers puros + regla aplicada al cotizar y al crear pedidos
// (el agente de WhatsApp y de voz pasan por el mismo dominio) + directorio publico.
import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createOrder, quoteOrder } from "../src/orders.ts";
import { OrderValidationError } from "../src/errors.ts";
import { aplicarReglasDeSucursal } from "../src/reglas-pedido.ts";
import { describirDiasDomicilio, evaluarDomicilioSucursal, insigniaDomicilio, mensajeDomicilioNoDisponible } from "../src/domicilio-sucursal.ts";
import { buildStorefrontBranches, buildStorefrontDirectorio, enlaceComoLlegar } from "../src/storefront.ts";
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

describe("directorio publico de sucursales", () => {
  function conSucursales() {
    const f = buildRestaurantFixture();
    const base = { organizationId: f.organizationId, phone: "+529990000000", lat: null, lng: null } as const;
    const inactiva = randomUUID();
    const oculta = randomUUID();
    const temporada = randomUUID();
    f.repo.seedBranch({ ...base, propertyId: inactiva, name: "Galerías", slug: "galerias", status: "inactive", address: "Plaza Galerías, Mérida" });
    f.repo.seedBranch({ ...base, propertyId: oculta, name: "Bodega", slug: "bodega", status: "active", address: "Calle 9" });
    f.repo.seedBranch({ ...base, propertyId: temporada, name: "Chicxulub", slug: "chicxulub", status: "active", address: "Chicxulub Puerto" });
    f.repo.seedBranchPolicy(inactiva, { visibleEnDirectorio: true });
    f.repo.seedBranchPolicy(oculta, { visibleEnDirectorio: false });
    f.repo.seedBranchPolicy(temporada, { aceptaDomicilio: false, deTemporada: true });
    f.repo.seedBranchPolicy(f.propertyId, { diasDomicilio: VIE_A_DOM, horario: [{ dias: [1, 2, 3, 4, 5], abre: "12:00", cierra: "22:00" }] });
    return f;
  }

  it("lista las visibles (activas por omision + inactivas marcadas visibles), con insignias; oculta las que no", async () => {
    const f = conSucursales();
    const dir = await buildStorefrontDirectorio(f.repo, f.organizationId, VIERNES_MEDIODIA);
    expect(dir.map((d) => d.slug).sort()).toEqual(["chicxulub", "fco-montejo", "galerias"]);
    const montejo = dir.find((d) => d.slug === "fco-montejo")!;
    expect(montejo).toMatchObject({ pideEnLinea: true, soloRecoger: false, insigniaDomicilio: "Domicilio vie-dom", soloInformativa: false, abiertoAhora: true });
    expect(montejo.horario).toEqual([{ dias: [1, 2, 3, 4, 5], abre: "12:00", cierra: "22:00" }]);
    expect(dir.find((d) => d.slug === "galerias")).toMatchObject({ pideEnLinea: false, soloInformativa: true, abiertoAhora: null });
    expect(dir.find((d) => d.slug === "chicxulub")).toMatchObject({ pideEnLinea: true, soloRecoger: true, deTemporada: true, insigniaDomicilio: null });
  });

  it("solo expone campos publicos: ningun id, coordenada ni minimo", async () => {
    const f = conSucursales();
    const dir = await buildStorefrontDirectorio(f.repo, f.organizationId);
    for (const item of dir) {
      expect(Object.keys(item).sort()).toEqual(
        ["abiertoAhora", "address", "comoLlegarUrl", "deTemporada", "horario", "insigniaDomicilio", "name", "phone", "pideEnLinea", "slug", "soloInformativa", "soloRecoger"],
      );
    }
  });

  it("'Cómo llegar' usa solo nombre y direccion del negocio, escapados", () => {
    expect(enlaceComoLlegar("Galerías", "Calle 7 #1 & 2")).toBe("https://www.google.com/maps/search/?api=1&query=Galer%C3%ADas%20Calle%207%20%231%20%26%202");
    expect(enlaceComoLlegar("X", null)).toBeNull();
    expect(enlaceComoLlegar("X", "   ")).toBeNull();
  });

  it("la lista de pedir sigue mostrando solo activas, ahora con banderas de domicilio", async () => {
    const f = conSucursales();
    const vistas = await buildStorefrontBranches(f.repo, f.organizationId);
    expect(vistas.map((v) => v.slug).sort()).toEqual(["bodega", "chicxulub", "fco-montejo"]);
    expect(vistas.find((v) => v.slug === "chicxulub")).toMatchObject({ aceptaDomicilio: false });
    expect(vistas.find((v) => v.slug === "fco-montejo")).toMatchObject({ aceptaDomicilio: true, diasDomicilio: [5, 6, 0] });
  });
});
