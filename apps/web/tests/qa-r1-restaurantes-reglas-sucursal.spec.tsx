// @vitest-environment jsdom
//
// QA R1 (restaurantes) en Sucursales > Reglas de pedido: botones-12 (Reintentar), botones-13 / caos-19 (guardado a medias),
// botones-14 (rango de fechas), botones-15 (quitar puente), botones-16 (desconectar WhatsApp) y caos-16 (cerrar una fecha).
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
type Call = { method: string; url: string; body?: any };

interface Opciones {
  readonly fallas?: Record<string, number[]>; // "PUT /zonas-reparto" -> statuses por intento
  readonly whatsapp?: string | null;
  readonly puentes?: unknown[];
}

function stub(calls: Call[], opts: Opciones = {}) {
  const intentos = new Map<string, number>();
  const puentes = opts.puentes ?? [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      calls.push({ method, url, body });
      const clave = `${method} ${url.replace(`${BASE}/config/sucursales/prop-1`, "")}`;
      const n = intentos.get(clave) ?? 0;
      intentos.set(clave, n + 1);
      const status = opts.fallas?.[clave]?.[n];
      if (status && status >= 400) return json({ message: "Servicio no disponible" }, status);
      if (url === `${BASE}/sucursales`) return json({ branches: [BRANCH] });
      if (url === `${BASE}/config/sucursales/prop-1/politica` && method === "GET") return json({ horario: null, pedidoMinimoDomicilio: 100, pedidoMinimoRecoger: null, propinaPolitica: null });
      if (url === `${BASE}/config/sucursales/prop-1/politica` && method === "PUT") return json(body);
      if (url === `${BASE}/config/sucursales/prop-1/zonas-reparto` && method === "GET") return json({ zoneIds: [] });
      if (url === `${BASE}/config/sucursales/prop-1/zonas-reparto` && method === "PUT") return json({ zoneIds: body.zoneIds });
      if (url === `${BASE}/config/sucursales/prop-1/whatsapp` && method === "GET") return json({ phoneNumberId: opts.whatsapp ?? null });
      if (url === `${BASE}/config/sucursales/prop-1/whatsapp` && method === "PUT") return json(body);
      if (url === `${BASE}/config/sucursales/prop-1/whatsapp` && method === "DELETE") return json({ ok: true });
      if (url === `${BASE}/config/zonas`) return json({ zonas: [] });
      if (url === `${BASE}/config/puentes` && method === "GET") return json({ puentes });
      if (url === `${BASE}/config/puentes` && method === "POST") {
        puentes.push({ id: "pu-1", branchId: "prop-1", fechaDesde: body.fechaDesde, fechaHasta: body.fechaHasta, horario: body.cerrado ? [] : body.turnos.map((t: object) => ({ dias: [0, 1, 2, 3, 4, 5, 6], ...t })), motivo: body.motivo ?? null });
        return json({ puentes }, 201);
      }
      throw new Error(`fetch inesperado en el test: ${method} ${url}`);
    }),
  );
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 6; i++) await flushMicrotasks();
  });
}
async function abrirReglas() {
  rendered = renderComponent(
    <MemoryRouter>
      <SucursalesPage {...CTX} />
    </MemoryRouter>,
  );
  await settle();
  click([...rendered.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Reglas de pedido"))!);
  await settle();
}
const q = (sel: string) => rendered!.container.querySelector(sel) as HTMLInputElement;
const boton = (t: string) => [...rendered!.container.querySelectorAll("button")].find((b) => b.textContent === t)!;
async function pulsar(t: string) {
  await act(async () => {
    click(boton(t));
    for (let i = 0; i < 6; i++) await flushMicrotasks();
  });
}
async function pulsarEnDialogo(texto: string) {
  const dialogo = document.body.querySelector('[role="alertdialog"]')!;
  const b = [...dialogo.querySelectorAll("button")].find((x) => x.textContent?.trim() === texto)!;
  await act(async () => {
    b.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    for (let i = 0; i < 6; i++) await flushMicrotasks();
  });
}
const escrituras = (calls: Call[], metodo: string, fin: string) => calls.filter((c) => c.method === metodo && c.url.endsWith(fin));
const texto = () => rendered!.container.textContent ?? "";

describe("Reglas de pedido: errores y reintentos", () => {
  it("botones-12: 'Reintentar' vuelve a mandar el PUT de la politica (no solo oculta el mensaje) y el error sale junto a Guardar reglas", async () => {
    const calls: Call[] = [];
    stub(calls, { fallas: { "PUT /politica": [503] } });
    await abrirReglas();
    await pulsar("Guardar reglas");
    expect(escrituras(calls, "PUT", "/politica")).toHaveLength(1);
    const seccion = boton("Guardar reglas").closest("div")!.parentElement!;
    expect(seccion.textContent).toContain("Servicio no disponible");
    await pulsar("Reintentar");
    expect(escrituras(calls, "PUT", "/politica")).toHaveLength(2);
    expect(escrituras(calls, "PUT", "/zonas-reparto")).toHaveLength(1);
    expect(texto()).toContain("Reglas guardadas.");
    expect(texto()).not.toContain("Servicio no disponible");
  });

  it("botones-13 / caos-19: si fallan las zonas, el aviso dice que horario y minimos SI se guardaron y 'Reintentar' repite SOLO las zonas", async () => {
    const calls: Call[] = [];
    stub(calls, { fallas: { "PUT /zonas-reparto": [503] } });
    await abrirReglas();
    changeValue(q("#min-dom-prop-1"), "300");
    await pulsar("Guardar reglas");
    expect(escrituras(calls, "PUT", "/politica")).toHaveLength(1);
    expect(texto()).toContain("sí se guardaron");
    expect(texto()).toContain("NO se pudieron guardar las zonas de reparto");
    expect(texto()).not.toContain("Reglas guardadas.");
    await pulsar("Reintentar");
    expect(escrituras(calls, "PUT", "/politica")).toHaveLength(1);
    expect(escrituras(calls, "PUT", "/zonas-reparto")).toHaveLength(2);
    expect(texto()).toContain("Reglas guardadas.");
  });
});

describe("Reglas de pedido: puentes", () => {
  it("botones-14: Hasta anterior a Desde no se manda y avisa", async () => {
    const calls: Call[] = [];
    stub(calls);
    await abrirReglas();
    changeValue(q("#puente-desde-prop-1"), "2026-11-16");
    changeValue(q("#puente-hasta-prop-1"), "2026-11-14");
    changeValue(q("#puente-turno-0-prop-1"), "12:00");
    changeValue(q('[aria-label="Cierre del turno 1"]'), "17:00");
    await pulsar("Guardar puente");
    expect(escrituras(calls, "POST", "/config/puentes")).toHaveLength(0);
    expect(texto()).toContain("la fecha final no sea anterior a la inicial");
  });

  it("botones-15: Quitar puente pide confirmacion; Volver no borra", async () => {
    const calls: Call[] = [];
    stub(calls, { puentes: [{ id: "pu-1", branchId: "prop-1", fechaDesde: "2026-12-24", fechaHasta: "2026-12-25", horario: [{ dias: [1], abre: "12:00", cierra: "16:00" }], motivo: null }] });
    await abrirReglas();
    await pulsar("Quitar");
    expect(document.body.querySelector('[role="alertdialog"]')).not.toBeNull();
    await pulsarEnDialogo("Volver");
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(0);
  });

  it("caos-16: 'Cerrado todo el dia' manda cerrado:true sin turnos y se lista como cerrado", async () => {
    const calls: Call[] = [];
    stub(calls);
    await abrirReglas();
    changeValue(q("#puente-desde-prop-1"), "2026-09-16");
    changeValue(q("#puente-hasta-prop-1"), "2026-09-16");
    changeValue(q("#puente-motivo-prop-1"), "Feriado");
    const cerrado = [...rendered!.container.querySelectorAll('input[type="checkbox"]')].find((c) => c.closest("label")?.textContent?.includes("Cerrado todo el día")) as HTMLInputElement;
    click(cerrado);
    expect(q("#puente-turno-0-prop-1")).toBeNull();
    await pulsar("Guardar puente");
    const [post] = escrituras(calls, "POST", "/config/puentes");
    expect(post!.body).toEqual({ branchIds: ["prop-1"], fechaDesde: "2026-09-16", fechaHasta: "2026-09-16", cerrado: true, motivo: "Feriado" });
    expect(rendered!.container.querySelector('[data-testid="puentes-prop-1"]')!.textContent).toContain("Cerrado todo el día");
  });
});

describe("Reglas de pedido: WhatsApp de la sucursal", () => {
  it("botones-16: vaciar el numero pide confirmacion; Volver no desconecta y Desconectar si", async () => {
    const calls: Call[] = [];
    stub(calls, { whatsapp: "109876543210" });
    await abrirReglas();
    changeValue(q("#wa-prop-1"), "");
    await pulsar("Guardar número");
    expect(document.body.querySelector('[role="alertdialog"]')).not.toBeNull();
    await pulsarEnDialogo("Volver");
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(0);
    await pulsar("Guardar número");
    await pulsarEnDialogo("Desconectar número");
    expect(escrituras(calls, "DELETE", "/whatsapp")).toHaveLength(1);
    expect(texto()).toContain("desconectado");
  });

  it("guardar un numero nuevo no pide confirmacion", async () => {
    const calls: Call[] = [];
    stub(calls, { whatsapp: null });
    await abrirReglas();
    changeValue(q("#wa-prop-1"), " 109876543210 ");
    await pulsar("Guardar número");
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull();
    expect(escrituras(calls, "PUT", "/whatsapp")[0]!.body).toEqual({ phoneNumberId: "109876543210" });
  });
});
