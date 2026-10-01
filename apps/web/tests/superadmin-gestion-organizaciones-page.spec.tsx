// @vitest-environment jsdom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SuperAdminGestionOrganizacionesPage } from "../src/superadmin/pages/GestionOrganizaciones.tsx";
import { changeValue, click, flushMicrotasks, renderComponent, submitForm, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

const ORGS = [
  { id: "o1", vertical: "restaurantes", name: "Los Taquitos de PM", slug: "taquitos", status: "active" },
  { id: "o2", vertical: "citas", name: "Clinica Sur", slug: "clinica-sur", status: "suspended" },
];

async function esperar(): Promise<void> {
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
  });
}
const json = (body: unknown, ok = true) => ({ ok, json: async () => body }) as unknown as Response;

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

function stub(opts: { acciones?: unknown[]; disponible?: boolean; post?: (url: string, body: unknown) => void }) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      opts.post?.(url, init.body ? JSON.parse(String(init.body)) : null);
      return json({ accion: {} });
    }
    if (url.endsWith("/superadmin/organizations")) return json({ organizations: ORGS });
    if (url.endsWith("/superadmin/organizaciones/acciones")) return json({ disponible: opts.disponible ?? true, acciones: opts.acciones ?? [] });
    throw new Error(`fetch inesperado: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}

const render = () => renderComponent(<SuperAdminGestionOrganizacionesPage apiBaseUrl="https://api.test" token="tok" />);

describe("SuperAdminGestionOrganizacionesPage", () => {
  it("lista organizaciones con la accion que corresponde a su estado", async () => {
    stub({});
    rendered = render();
    await esperar();
    const t = rendered.container.textContent ?? "";
    expect(t).toContain("Los Taquitos de PM");
    expect(t).toContain("Pasar a prueba");
    expect(t).toContain("Suspender");
    expect(t).toContain("Reactivar"); // la suspendida
    expect(t).toContain("Alta de organización");
  });

  it("base sin migrar: aviso honesto y SIN botones de accion", async () => {
    stub({ disponible: false });
    rendered = render();
    await esperar();
    const t = rendered.container.textContent ?? "";
    expect(t).toContain("todavía no está disponible en esta base");
    const botones = [...rendered.container.querySelectorAll("button")].map((b) => b.textContent?.trim());
    expect(botones).not.toContain("Suspender");
    expect(botones).not.toContain("Reactivar");
    expect(botones.some((b) => b?.includes("Alta de organización"))).toBe(false);
  });

  it("suspender: motivo corto no llama al backend; valido arma el POST de SOLICITUD (no ejecuta)", async () => {
    let post: { url: string; body: unknown } | null = null;
    stub({ post: (url, body) => { post = { url, body }; } });
    rendered = render();
    await esperar();
    click([...rendered.container.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Suspender")!);
    const motivo = document.body.querySelector("#org-motivo") as HTMLTextAreaElement;
    const form = document.body.querySelector("#form-solicitud-org") as HTMLFormElement;
    changeValue(motivo, "corto");
    await submitForm(form);
    expect(document.body.textContent).toContain("al menos 20 caracteres");
    expect(post).toBeNull();

    changeValue(motivo, "Cliente en mora de 90 dias, se suspende previa confirmacion.");
    await submitForm(form);
    await esperar();
    expect(post).toMatchObject({ url: "https://api.test/superadmin/organizaciones/acciones", body: { tipo: "suspender", organizationId: "o1", motivo: "Cliente en mora de 90 dias, se suspende previa confirmacion." } });
  });

  it("alta valida nombre y slug antes de enviar", async () => {
    stub({});
    rendered = render();
    await esperar();
    click([...rendered.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Alta de organización"))!);
    changeValue(document.body.querySelector("#org-nombre") as HTMLInputElement, "Clinica Nueva");
    changeValue(document.body.querySelector("#org-slug") as HTMLInputElement, "Slug Malo!");
    changeValue(document.body.querySelector("#org-motivo") as HTMLTextAreaElement, "Cliente nuevo cerrado por ventas, se da de alta su organizacion.");
    await submitForm(document.body.querySelector("#form-solicitud-org") as HTMLFormElement);
    expect(document.body.textContent).toContain("slug en minúsculas");
    expect(fetchMock.mock.calls.every((c: unknown[]) => (c[1] as RequestInit | undefined)?.method !== "POST")).toBe(true);
  });

  it("muestra las pendientes y confirmar / cancelar llaman a sus rutas", async () => {
    const posts: string[] = [];
    stub({
      acciones: [{ id: "a1", tipo: "suspender", organizationId: "o1", payload: {}, motivo: "Cliente en mora de 90 dias, se suspende previa confirmacion.", estado: "pending", venceEnMs: Date.now() + 5 * 60_000, resultado: null }],
      post: (url) => posts.push(url),
    });
    rendered = render();
    await esperar();
    expect(rendered.container.textContent).toContain("Pendientes de confirmar");
    click([...rendered.container.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Confirmar")!);
    await esperar();
    expect(posts).toContain("https://api.test/superadmin/organizaciones/acciones/a1/confirmar");
    click([...rendered.container.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Cancelar")!);
    await esperar();
    expect(posts).toContain("https://api.test/superadmin/organizaciones/acciones/a1/cancelar");
  });
});
