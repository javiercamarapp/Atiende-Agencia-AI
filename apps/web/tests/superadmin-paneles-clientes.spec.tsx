// @vitest-environment jsdom
// «Organizaciones de clientes» dentro de «Ver los otros paneles»: lista las NO demo y «Entrar» abre una sesión de soporte con motivo.
import { act } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SuperAdminPanelesPage } from "../src/superadmin/pages/Paneles.tsx";
import { changeValue, click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";
import { instalarLocalStorageEnMemoria, respuestaEntrar } from "./test-utils/token-soporte.ts";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;
const json = (body: unknown, ok = true, status = 200) => ({ ok, status, json: async () => body }) as unknown as Response;
const campo = <T,>(valor: T) => ({ valor, razon: null });
const fila = (id: string, nombre: string, slug: string, vertical: string, estado: "trial" | "active" | "suspended") => ({
  id, nombre, slug, vertical, estado, creadaEn: "2030-01-01T00:00:00.000Z", staff: 1,
  plan: campo({ id: "p", nombre: "Restaurantes" }), operaciones30d: campo(1), costoIa30dUsd: campo(1), onboarding: campo({ hechos: 1, total: 1, noMedibles: 0 }),
});
const RESUMEN = {
  disponible: true, mensaje: null, ventanaDias: 30,
  organizaciones: [fila("o1", "Los Taquitos de PM", "los-taquitos-de-pm", "restaurantes", "trial"), fila("d1", "Demo — Vista previa (restaurantes)", "demo-restaurantes", "restaurantes", "active")],
};

async function esperar() {
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();
  });
}
function Ubicacion() {
  return <p data-testid="ubicacion">{useLocation().pathname}</p>;
}
const dialogo = () => document.body.querySelector('[role="alertdialog"]');
const botonDialogo = (t: string) => [...dialogo()!.querySelectorAll("button")].find((b) => b.textContent?.includes(t)) as HTMLButtonElement;
const posts = () => fetchMock.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === "POST");

function stub(over: { resumen?: () => Response; entrar?: () => Response } = {}) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST" && url.endsWith("/superadmin/soporte/entrar")) return (over.entrar ?? (() => json(respuestaEntrar({ slug: "los-taquitos-de-pm", nombre: "Los Taquitos de PM", expMs: Date.parse("2030-03-04T11:00:00Z") }), true, 201)))();
    if (url.endsWith("/superadmin/organizaciones/resumen")) return (over.resumen ?? (() => json(RESUMEN)))();
    if (url.endsWith("/auth/me")) return json({ email: "javier@atiende.ai", fullName: "Javier", organizations: [{ id: "o1", slug: "los-taquitos-de-pm", nombre: "Los Taquitos de PM", vertical: "restaurantes", rol: "owner" }] });
    throw new Error(`fetch inesperado: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}
function render() {
  rendered = renderComponent(
    <MemoryRouter initialEntries={["/superadmin/paneles"]}>
      <Routes>
        <Route path="/superadmin/paneles" element={<SuperAdminPanelesPage apiBaseUrl="https://api.test" token="tok" />} />
        <Route path="*" element={<Ubicacion />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  instalarLocalStorageEnMemoria();
});
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

describe("Organizaciones de clientes (Ver los otros paneles)", () => {
  it("lista solo organizaciones reales (las demo no), con vertical, estado, plan y «Entrar»", async () => {
    stub();
    render();
    await esperar();
    const c = rendered!.container;
    expect(c.textContent).toContain("Organizaciones de clientes");
    expect(c.querySelector('tr[data-org-id="o1"]')?.textContent).toMatch(/Los Taquitos de PM.*Restaurantes.*Prueba.*Restaurantes/s);
    expect(c.querySelector('tr[data-org-id="d1"]')).toBeNull();
    expect([...c.querySelectorAll('tr[data-org-id="o1"] button')].some((b) => b.textContent?.includes("Entrar"))).toBe(true);
  });

  it("el diálogo exige motivo de 10+ caracteres: vacío, solo espacios y corto no envían nada", async () => {
    stub();
    render();
    await esperar();
    click([...rendered!.container.querySelectorAll('tr[data-org-id="o1"] button')].find((b) => b.textContent?.includes("Entrar"))!);
    await esperar();
    expect(dialogo()?.textContent).toContain("Entrar a Los Taquitos de PM");
    expect(botonDialogo("Entrar al panel").disabled).toBe(true);
    for (const v of ["", "   \n ", "muy corto"]) {
      changeValue(dialogo()!.querySelector("textarea")!, v);
      expect(botonDialogo("Entrar al panel").disabled, JSON.stringify(v)).toBe(true);
      click(botonDialogo("Entrar al panel"));
      await esperar();
    }
    expect(posts()).toHaveLength(0);
  });

  it("con motivo válido abre la sesión de soporte y navega al panel del cliente con su sesión persistida", async () => {
    stub();
    render();
    await esperar();
    click([...rendered!.container.querySelectorAll('tr[data-org-id="o1"] button')].find((b) => b.textContent?.includes("Entrar"))!);
    await esperar();
    changeValue(dialogo()!.querySelector("textarea")!, "  Revisar cómo quedó su panel  ");
    click(botonDialogo("Entrar al panel"));
    await esperar();
    expect(posts()).toHaveLength(1);
    expect(JSON.parse(String((posts()[0]![1] as RequestInit).body))).toEqual({ organizationId: "o1", reason: "Revisar cómo quedó su panel" });
    expect(rendered!.container.querySelector('[data-testid="ubicacion"]')?.textContent).toBe("/restaurantes/los-taquitos-de-pm");
    expect(JSON.parse(window.localStorage.getItem("atiende.restaurantes.session")!).refreshToken).toBe("");
  });

  it("si la bitácora/API rechaza la entrada no se navega ni se persiste nada (falla cerrado)", async () => {
    stub({ entrar: () => json({ message: "La sesión de soporte todavía no está disponible en esta base." }, false, 503) });
    render();
    await esperar();
    click([...rendered!.container.querySelectorAll('tr[data-org-id="o1"] button')].find((b) => b.textContent?.includes("Entrar"))!);
    await esperar();
    changeValue(dialogo()!.querySelector("textarea")!, "Revisar cómo quedó su panel");
    click(botonDialogo("Entrar al panel"));
    await esperar();
    expect(posts()).toHaveLength(1);
    expect(dialogo()).not.toBeNull();
    expect(window.localStorage.getItem("atiende.restaurantes.session")).toBeNull();
    expect(rendered!.container.querySelector('[data-testid="ubicacion"]')).toBeNull();
  });

  it("sin métricas (resumen no disponible) cae a la lista simple y sigue sin mostrar demos", async () => {
    stub({ resumen: () => json({ disponible: false, mensaje: "x", ventanaDias: 30, organizaciones: [] }) });
    const base = fetchMock;
    fetchMock = vi.fn(async (url: string, init?: RequestInit) =>
      url.endsWith("/superadmin/organizations")
        ? json({ organizations: [{ id: "o1", name: "Los Taquitos de PM", slug: "los-taquitos-de-pm", vertical: "restaurantes", status: "trial", createdAt: "2030-01-01T00:00:00Z", staffCount: 2 }, { id: "d1", name: "Demo", slug: "demo-hoteles", vertical: "hoteles", status: "active", createdAt: "2030-01-01T00:00:00Z", staffCount: 1 }] })
        : base(url, init),
    );
    vi.stubGlobal("fetch", fetchMock);
    render();
    await esperar();
    expect(rendered!.container.querySelector('tr[data-org-id="o1"]')).not.toBeNull();
    expect(rendered!.container.querySelector('tr[data-org-id="d1"]')).toBeNull();
  });
});
