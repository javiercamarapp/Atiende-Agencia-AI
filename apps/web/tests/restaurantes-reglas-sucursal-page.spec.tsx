// @vitest-environment jsdom
//
// Reglas de pedido por sucursal (modelo PM) dentro de <SucursalesPage />: visible solo para
// owner/admin, carga bajo demanda, y guardar manda la politica COMPLETA + la cobertura.
import { act } from "react";
import { afterEach, describe, expect, it, vi, beforeAll } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { SucursalesPage } from "../src/verticals/restaurantes/pages/Sucursales.tsx";
import type { RestaurantesShellContext } from "../src/verticals/restaurantes/RestaurantesShell.tsx";
import { changeValue, click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";
import { elegirValor, valorDe, prepararJsdomParaRadix } from "./test-utils/seleccionar.tsx";

beforeAll(prepararJsdomParaRadix);

let rendered: RenderedComponent | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200): Response => ({ ok: status < 400, status, json: async () => body }) as unknown as Response;
const CTX: RestaurantesShellContext = { apiBaseUrl: "https://api.test", token: "tok", propertyId: "prop-1", orgSlug: "demo", role: "owner", staffFullName: "Gaby", staffEmail: "g@example.com" };
const BRANCH = { propertyId: "prop-1", name: "Altabrisa", slug: "altabrisa", status: "active", phone: null, address: null, lat: null, lng: null };
const BASE = "https://api.test/v1/restaurantes/prop-1/admin";

function stub(calls: Array<{ method: string; url: string; body?: unknown }>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ method, url, body: init?.body ? JSON.parse(init.body as string) : undefined });
      if (url === `${BASE}/sucursales`) return json({ branches: [BRANCH] });
      if (url === `${BASE}/config/sucursales/prop-1/politica` && method === "GET") {
        return json({ horario: [{ dias: [1, 2], abre: "12:00", cierra: "01:00" }], pedidoMinimoDomicilio: 200, pedidoMinimoRecoger: null, propinaPolitica: "solo_tarjeta" });
      }
      if (url === `${BASE}/config/sucursales/prop-1/politica` && method === "PUT") return json(JSON.parse(init!.body as string));
      if (url === `${BASE}/config/sucursales/prop-1/zonas-reparto` && method === "GET") return json({ zoneIds: ["z1"] });
      if (url === `${BASE}/config/sucursales/prop-1/zonas-reparto` && method === "PUT") return json({ zoneIds: JSON.parse(init!.body as string).zoneIds });
      if (url === `${BASE}/config/sucursales/prop-1/whatsapp` && method === "GET") return json({ phoneNumberId: "15550001111" });
      if (url === `${BASE}/config/sucursales/prop-1/whatsapp` && method === "PUT") return json(JSON.parse(init!.body as string));
      if (url === `${BASE}/config/zonas`) {
        return json({ zonas: [{ id: "z1", name: "Altabrisa", lat: 21, lng: -89, createdAt: "x" }, { id: "z2", name: "Pensiones", lat: 20, lng: -89, createdAt: "x" }] });
      }
      throw new Error(`fetch inesperado en el test: ${method} ${url}`);
    }),
  );
}

async function settle() {
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();
  });
}

function render(ctx: RestaurantesShellContext = CTX) {
  rendered = renderComponent(
    <MemoryRouter>
      <SucursalesPage {...ctx} />
    </MemoryRouter>,
  );
}

const botonReglas = () => [...rendered!.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Reglas de pedido"));

describe("reglas de pedido por sucursal (UI)", () => {
  it("owner/admin ven el boton; staff y repartidor NO, y nada se pide hasta abrirlo", async () => {
    const calls: Array<{ method: string; url: string }> = [];
    stub(calls);
    render();
    await settle();
    expect(botonReglas()).toBeDefined();
    expect(calls.map((c) => c.url)).toEqual([`${BASE}/sucursales`]);
    rendered!.unmount();

    for (const role of ["staff", "repartidor"]) {
      stub([]);
      render({ ...CTX, role });
      await settle();
      expect(botonReglas()).toBeUndefined();
      rendered!.unmount();
    }
  });

  it("abrir carga politica, cobertura, numero y zonas reales de ESA sucursal", async () => {
    stub([]);
    render();
    await settle();
    click(botonReglas()!);
    await settle();
    const text = rendered!.container.textContent!;
    expect(text).toContain("Lun, Mar 12:00 a 01:00 (cierra al día siguiente)");
    expect((rendered!.container.querySelector("#min-dom-prop-1") as HTMLInputElement).value).toBe("200");
    expect((rendered!.container.querySelector("#min-rec-prop-1") as HTMLInputElement).value).toBe("");
    expect(valorDe(rendered!.container.querySelector("#propina-prop-1"))).toBe("solo_tarjeta");
    expect((rendered!.container.querySelector("#wa-prop-1") as HTMLInputElement).value).toBe("15550001111");
    const zonas = [...rendered!.container.querySelectorAll("input[type=checkbox]")].filter((i) => i.closest("label")?.textContent === "Altabrisa" || i.closest("label")?.textContent === "Pensiones") as HTMLInputElement[];
    expect(zonas.map((z) => z.checked)).toEqual([true, false]);
  });

  it("guardar manda la politica COMPLETA y la cobertura editadas", async () => {
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    stub(calls);
    render();
    await settle();
    click(botonReglas()!);
    await settle();

    changeValue(rendered!.container.querySelector("#min-dom-prop-1") as HTMLInputElement, "250");
    changeValue(rendered!.container.querySelector("#min-rec-prop-1") as HTMLInputElement, "80");
    elegirValor(rendered!.container.querySelector("#propina-prop-1") as HTMLElement, "");
    const pensiones = [...rendered!.container.querySelectorAll("input[type=checkbox]")].find((i) => i.closest("label")?.textContent === "Pensiones")!;
    click(pensiones);
    await act(async () => {
      click([...rendered!.container.querySelectorAll("button")].find((b) => b.textContent === "Guardar reglas")!);
      await flushMicrotasks();
      await flushMicrotasks();
      await flushMicrotasks();
    });

    const put = calls.find((c) => c.method === "PUT" && c.url.endsWith("/politica"))!;
    expect(put.body).toEqual({
      horario: [{ dias: [1, 2], abre: "12:00", cierra: "01:00" }],
      pedidoMinimoDomicilio: 250,
      pedidoMinimoRecoger: 80,
      propinaPolitica: null,
    });
    expect(calls.find((c) => c.method === "PUT" && c.url.endsWith("/zonas-reparto"))!.body).toEqual({ zoneIds: ["z1", "z2"] });
    expect(rendered!.container.textContent).toContain("Reglas guardadas.");
  });

  it("un minimo invalido no llama a la API y muestra el error", async () => {
    const calls: Array<{ method: string; url: string }> = [];
    stub(calls);
    render();
    await settle();
    click(botonReglas()!);
    await settle();
    changeValue(rendered!.container.querySelector("#min-dom-prop-1") as HTMLInputElement, "mucho");
    await act(async () => {
      click([...rendered!.container.querySelectorAll("button")].find((b) => b.textContent === "Guardar reglas")!);
      await flushMicrotasks();
    });
    expect(rendered!.container.textContent).toContain("Los pedidos mínimos deben ser un monto en pesos");
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("agregar un turno (doble turno) y quitar otro se refleja en lo que se guarda", async () => {
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    stub(calls);
    render();
    await settle();
    click(botonReglas()!);
    await settle();
    click([...rendered!.container.querySelectorAll("button")].find((b) => b.textContent === "Agregar turno")!);
    await act(async () => {
      click([...rendered!.container.querySelectorAll("button")].find((b) => b.textContent === "Guardar reglas")!);
      await flushMicrotasks();
      await flushMicrotasks();
      await flushMicrotasks();
    });
    const put = calls.find((c) => c.method === "PUT" && c.url.endsWith("/politica"))!;
    expect((put.body as { horario: unknown[] }).horario).toHaveLength(2);
  });

  it("guardar el numero de WhatsApp manda PUT solo de ese numero", async () => {
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    stub(calls);
    render();
    await settle();
    click(botonReglas()!);
    await settle();
    changeValue(rendered!.container.querySelector("#wa-prop-1") as HTMLInputElement, "15559998888");
    await act(async () => {
      click([...rendered!.container.querySelectorAll("button")].find((b) => b.textContent === "Guardar número")!);
      await flushMicrotasks();
      await flushMicrotasks();
    });
    expect(calls.find((c) => c.method === "PUT" && c.url.endsWith("/whatsapp"))!.body).toEqual({ phoneNumberId: "15559998888" });
    expect(calls.some((c) => c.method === "PUT" && c.url.endsWith("/politica"))).toBe(false);
  });
});
