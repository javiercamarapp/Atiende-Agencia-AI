// @vitest-environment jsdom
//
// PM PR-3 (e): puentes (horario por fechas) dentro de las reglas de pedido de una sucursal.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { SucursalesPage } from "../src/verticals/restaurantes/pages/Sucursales.tsx";
import type { RestaurantesShellContext } from "../src/verticals/restaurantes/RestaurantesShell.tsx";
import { changeValue, click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

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

function stub(calls: Array<{ method: string; url: string; body?: unknown }>, puentes: unknown[] = []) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ method, url, body: init?.body ? JSON.parse(init.body as string) : undefined });
      if (url === `${BASE}/sucursales`) return json({ branches: [BRANCH] });
      if (url === `${BASE}/config/sucursales/prop-1/politica`) return json({ horario: null, pedidoMinimoDomicilio: null, pedidoMinimoRecoger: null, propinaPolitica: null });
      if (url === `${BASE}/config/sucursales/prop-1/zonas-reparto`) return json({ zoneIds: [] });
      if (url === `${BASE}/config/sucursales/prop-1/whatsapp`) return json({ phoneNumberId: null });
      if (url === `${BASE}/config/zonas`) return json({ zonas: [] });
      if (url === `${BASE}/config/puentes` && method === "GET") return json({ puentes });
      if (url === `${BASE}/config/puentes` && method === "POST") {
        const b = JSON.parse(init!.body as string);
        puentes.push({ id: "pu-1", branchId: "prop-1", fechaDesde: b.fechaDesde, fechaHasta: b.fechaHasta, horario: b.turnos.map((t: object) => ({ dias: [0, 1, 2, 3, 4, 5, 6], ...t })), motivo: b.motivo ?? null });
        return json({ puentes }, 201);
      }
      if (url === `${BASE}/config/puentes/pu-1` && method === "DELETE") {
        puentes.length = 0;
        return json({ ok: true });
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
const boton = (t: string) => [...rendered!.container.querySelectorAll("button")].find((b) => b.textContent === t)!;

describe("puentes en las reglas de una sucursal (UI)", () => {
  it("crea un puente con los dos turnos parametrizados, lo lista y lo quita", async () => {
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    stub(calls);
    render();
    await settle();
    click(botonReglas()!);
    await settle();
    changeValue(rendered!.container.querySelector("#puente-desde-prop-1") as HTMLInputElement, "2026-12-24");
    changeValue(rendered!.container.querySelector("#puente-hasta-prop-1") as HTMLInputElement, "2026-12-26");
    changeValue(rendered!.container.querySelector("#puente-turno-0-prop-1") as HTMLInputElement, "12:00");
    changeValue(rendered!.container.querySelector('[aria-label="Cierre del turno 1"]') as HTMLInputElement, "16:00");
    changeValue(rendered!.container.querySelector("#puente-turno-1-prop-1") as HTMLInputElement, "18:00");
    changeValue(rendered!.container.querySelector('[aria-label="Cierre del turno 2"]') as HTMLInputElement, "01:00");
    changeValue(rendered!.container.querySelector("#puente-motivo-prop-1") as HTMLInputElement, "Navidad");
    await act(async () => {
      click(boton("Guardar puente"));
      await flushMicrotasks();
      await flushMicrotasks();
    });
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({
      branchIds: ["prop-1"],
      fechaDesde: "2026-12-24",
      fechaHasta: "2026-12-26",
      turnos: [
        { abre: "12:00", cierra: "16:00" },
        { abre: "18:00", cierra: "01:00" },
      ],
      motivo: "Navidad",
    });
    expect(rendered!.container.querySelector('[data-testid="puentes-prop-1"]')!.textContent).toContain("2026-12-24 → 2026-12-26: 12:00–16:00 y 18:00–01:00 (Navidad)");
    await act(async () => {
      click(boton("Quitar"));
      await flushMicrotasks();
      await flushMicrotasks();
    });
    expect(calls.some((c) => c.method === "DELETE" && c.url.endsWith("/puentes/pu-1"))).toBe(true);
    expect(rendered!.container.querySelector('[data-testid="puentes-prop-1"]')!.textContent).not.toContain("2026-12-24");
  });

  it("sin turnos o con fechas vacias no envia nada y avisa", async () => {
    const calls: Array<{ method: string; url: string }> = [];
    stub(calls);
    render();
    await settle();
    click(botonReglas()!);
    await settle();
    await act(async () => {
      click(boton("Guardar puente"));
      await flushMicrotasks();
    });
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    expect(rendered!.container.textContent).toContain("Un puente necesita");
  });

  it("si el API no expone puentes, el resto de las reglas sigue cargando", async () => {
    const calls: Array<{ method: string; url: string }> = [];
    stub(calls);
    const original = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => (url.endsWith("/config/puentes") ? json({}, 404) : original(url, init))));
    render();
    await settle();
    click(botonReglas()!);
    await settle();
    expect(rendered!.container.querySelector("#min-dom-prop-1")).not.toBeNull();
  });
});
