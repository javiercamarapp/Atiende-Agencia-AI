// @vitest-environment jsdom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SuperAdminPlanesPage } from "../src/superadmin/pages/Planes.tsx";
import { changeValue, click, flushMicrotasks, renderComponent, submitForm, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

async function esperar(): Promise<void> {
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
  });
}
const json = (body: unknown, ok = true) => ({ ok, json: async () => body, clone() { return this; }, status: ok ? 200 : 400 }) as unknown as Response;

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

const CATALOGO = { verticales: ["hoteles", "restaurantes", "rentas", "licitaciones", "citas", "despachos"], metricas: ["llm_costo_micro_usd_mes", "minutos_voz_mes", "mensajes_mes", "sucursales", "asientos"], acciones: ["avisar", "cobrar", "pausar"] };
const PLANES = [
  { id: "restaurantes-estandar", nombre: "Restaurantes - por agente de voz", vertical: "restaurantes", precioBaseMxn: 0, precioAsientoMxn: 799, asientosIncluidos: 1, activo: true, limites: [{ metrica: "llm_costo_micro_usd_mes", limite: 25_000_000, accion: "pausar" }], organizaciones: 0 },
  { id: "rentas-estandar", nombre: "Rentas vacacionales - por configurar", vertical: "rentas", precioBaseMxn: null, precioAsientoMxn: null, asientosIncluidos: 0, activo: true, limites: [], organizaciones: 0 },
];
const ORGS = [
  { id: "o1", vertical: "restaurantes", name: "Los Taquitos de PM", slug: "taquitos", status: "active" },
  { id: "o2", vertical: "citas", name: "Clinica Suspendida", slug: "clinica", status: "suspended" },
];

function stub(opts: { disponible?: boolean; asignaciones?: unknown[]; onWrite?: (method: string, url: string, body: unknown) => void } = {}) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method && init.method !== "GET") {
      opts.onWrite?.(init.method, url, init.body ? JSON.parse(String(init.body)) : null);
      return json({ ok: true });
    }
    if (url.endsWith("/superadmin/planes")) return json({ disponible: opts.disponible ?? true, catalogo: CATALOGO, planes: opts.disponible === false ? [] : PLANES });
    if (url.endsWith("/superadmin/planes/asignaciones")) return json({ asignaciones: opts.asignaciones ?? [] });
    if (url.endsWith("/superadmin/organizations")) return json({ organizations: ORGS });
    if (url.includes("/superadmin/costos/resumen")) return json({ disponible: true, organizaciones: [{ organizationId: "o1", planId: null }] });
    throw new Error(`fetch inesperado: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}

const render = () => renderComponent(<SuperAdminPlanesPage apiBaseUrl="https://api.test" token="tok" />);
const boton = (texto: string) => [...document.body.querySelectorAll("button")].find((b) => b.textContent?.trim() === texto)!;

describe("SuperAdminPlanesPage", () => {
  it("lista el catalogo con precios y limites; un precio sin definir es «por configurar», no 0", async () => {
    stub();
    rendered = render();
    await esperar();
    const t = rendered.container.textContent ?? "";
    expect(t).toContain("Restaurantes - por agente de voz");
    expect(t).toContain("$799.00");
    expect(t).toContain("— por configurar");
    expect(t).toContain("Costo de LLM al mes (USD): US$25.00 (pausar)");
    expect(t).toContain("sin plan asignado");
  });

  it("base sin migrar: aviso honesto y SIN botones de edicion ni de asignacion", async () => {
    stub({ disponible: false });
    rendered = render();
    await esperar();
    expect(rendered.container.textContent).toContain("migración 0028 pendiente");
    const botones = [...rendered.container.querySelectorAll("button")].map((b) => b.textContent?.trim());
    expect(botones).not.toContain("Nuevo plan");
    expect(botones).not.toContain("Asignar plan");
    expect(botones).not.toContain("Editar");
  });

  it("no ofrece asignar plan a una organizacion suspendida", async () => {
    stub();
    rendered = render();
    await esperar();
    expect([...rendered.container.querySelectorAll("button")].filter((b) => b.textContent?.trim() === "Asignar plan")).toHaveLength(1);
  });

  it("nuevo plan: valida id y precios; vacio = null (por configurar) en el PUT", async () => {
    const writes: Array<{ method: string; url: string; body: unknown }> = [];
    stub({ onWrite: (method, url, body) => writes.push({ method, url, body }) });
    rendered = render();
    await esperar();
    click(boton("Nuevo plan"));
    const form = document.body.querySelector("#form-plan") as HTMLFormElement;
    changeValue(document.body.querySelector("#plan-id") as HTMLInputElement, "X");
    await submitForm(form);
    expect(document.body.textContent).toContain("El id usa minúsculas");
    expect(writes).toHaveLength(0);

    changeValue(document.body.querySelector("#plan-id") as HTMLInputElement, "restaurantes-pro");
    changeValue(document.body.querySelector("#plan-nombre") as HTMLInputElement, "Restaurantes Pro");
    changeValue(document.body.querySelector("#plan-base") as HTMLInputElement, "-4");
    await submitForm(form);
    expect(document.body.textContent).toContain("mayores o iguales a 0");

    changeValue(document.body.querySelector("#plan-base") as HTMLInputElement, "5900");
    changeValue(document.body.querySelector("#plan-asiento") as HTMLInputElement, "");
    await submitForm(form);
    await esperar();
    expect(writes[0]).toMatchObject({ method: "PUT", url: "https://api.test/superadmin/planes/restaurantes-pro", body: { nombre: "Restaurantes Pro", vertical: "restaurantes", precioBaseMxn: 5900, precioAsientoMxn: null, asientosIncluidos: 0, activo: true } });
  });

  it("limite LLM se captura en USD y se envia en micro-USD", async () => {
    const writes: Array<{ method: string; url: string; body: unknown }> = [];
    stub({ onWrite: (method, url, body) => writes.push({ method, url, body }) });
    rendered = render();
    await esperar();
    click([...rendered.container.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Límites")!);
    changeValue(document.body.querySelector("#lim-metrica") as HTMLSelectElement, "llm_costo_micro_usd_mes");
    changeValue(document.body.querySelector("#lim-valor") as HTMLInputElement, "30.5");
    changeValue(document.body.querySelector("#lim-accion") as HTMLSelectElement, "pausar");
    await submitForm(document.body.querySelector("#form-limite") as HTMLFormElement);
    await esperar();
    expect(writes[0]).toMatchObject({ method: "PUT", url: "https://api.test/superadmin/planes/restaurantes-estandar/limites/llm_costo_micro_usd_mes", body: { limite: 30_500_000, accion: "pausar" } });
  });

  it("asignar plan: solo planes de la vertical, motivo corto no llama al backend, valido manda la SOLICITUD (no ejecuta)", async () => {
    const writes: Array<{ method: string; url: string; body: unknown }> = [];
    stub({ onWrite: (method, url, body) => writes.push({ method, url, body }) });
    rendered = render();
    await esperar();
    click([...rendered.container.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Asignar plan")!);
    const opciones = [...document.body.querySelectorAll("#asig-plan option")].map((o) => o.textContent);
    expect(opciones).toContain("Restaurantes - por agente de voz");
    expect(opciones).not.toContain("Rentas vacacionales - por configurar");
    const form = document.body.querySelector("#form-asignar") as HTMLFormElement;
    changeValue(document.body.querySelector("#asig-plan") as HTMLSelectElement, "restaurantes-estandar");
    changeValue(document.body.querySelector("#asig-motivo") as HTMLTextAreaElement, "corto");
    await submitForm(form);
    expect(document.body.textContent).toContain("al menos 20 caracteres");
    expect(writes).toHaveLength(0);
    changeValue(document.body.querySelector("#asig-motivo") as HTMLTextAreaElement, "Cliente firmo contrato anual del plan estandar.");
    await submitForm(form);
    await esperar();
    expect(writes[0]).toMatchObject({ method: "POST", url: "https://api.test/superadmin/planes/asignaciones", body: { organizationId: "o1", planId: "restaurantes-estandar" } });
    expect(writes.some((w) => w.url.endsWith("/confirmar"))).toBe(false);
  });

  it("muestra las pendientes y confirmar / cancelar llaman a sus rutas", async () => {
    const writes: Array<{ method: string; url: string }> = [];
    stub({
      asignaciones: [{ id: "a1", organizationId: "o1", organizacion: "Los Taquitos de PM", planId: "restaurantes-estandar", motivo: "Cliente firmo contrato anual del plan estandar.", estado: "pending", venceEnMs: Date.now() + 5 * 60_000 }],
      onWrite: (method, url) => writes.push({ method, url }),
    });
    rendered = render();
    await esperar();
    expect(rendered.container.textContent).toContain("Pendientes de confirmar");
    click([...rendered.container.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Confirmar")!);
    await esperar();
    expect(writes.map((w) => w.url)).toContain("https://api.test/superadmin/planes/asignaciones/a1/confirmar");
    click([...rendered.container.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Cancelar")!);
    await esperar();
    expect(writes.map((w) => w.url)).toContain("https://api.test/superadmin/planes/asignaciones/a1/cancelar");
  });
});
