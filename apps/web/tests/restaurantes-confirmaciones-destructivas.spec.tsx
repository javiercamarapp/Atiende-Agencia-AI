// @vitest-environment jsdom
//
// PR-5 de diseno-ux (restaurantes): las dos confirmaciones destructivas que seguian en
// `window.confirm` (baja de staff en Staff.tsx, quitar zona en Configuracion.tsx) pasan al
// <ConfirmDialog> de @atiende/ui via `useConfirm`. Se afirma que:
//   - `window.confirm` NUNCA se llama;
//   - Cancelar/cerrar NO ejecuta el DELETE;
//   - Confirmar si lo ejecuta, con el nombre del objeto en el titulo del dialogo.
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { StaffPage } from "../src/verticals/restaurantes/pages/Staff.tsx";
import { ConfiguracionPage } from "../src/verticals/restaurantes/pages/Configuracion.tsx";
import type { RestaurantesShellContext } from "../src/verticals/restaurantes/RestaurantesShell.tsx";
import { click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;
let confirmMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  confirmMock = vi.fn(() => true);
  vi.stubGlobal("confirm", confirmMock);
});

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, json: async () => body } as unknown as Response;
}

function ctx(role = "owner"): RestaurantesShellContext {
  return { apiBaseUrl: "https://api.test", token: "tok-123", propertyId: "prop-1", orgSlug: "demo", role, staffFullName: "Sam Demo", staffEmail: "sam@example.com" };
}

const BASE = "https://api.test/v1/restaurantes/prop-1/admin";

function stubFetch(extra: (method: string, url: string) => Response | null) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const propia = extra(method, url);
    if (propia) return propia;
    throw new Error(`fetch inesperado en el test: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}

async function esperar(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 6; i++) await flushMicrotasks();
  });
}

function dialogo(): HTMLElement | null {
  return document.body.querySelector('[role="alertdialog"]');
}

async function pulsarEnDialogo(texto: string): Promise<void> {
  const boton = [...dialogo()!.querySelectorAll("button")].find((b) => b.textContent?.trim() === texto)!;
  await act(async () => {
    boton.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    for (let i = 0; i < 6; i++) await flushMicrotasks();
  });
}

const deletes = () => fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "DELETE");

describe("Staff (restaurantes) — baja con ConfirmDialog", () => {
  const MIEMBRO = { id: "user-1", email: "ana@example.com", fullName: "Ana Pérez", verticalRole: "staff", propertyIds: null };

  function stubStaff() {
    stubFetch((method, url) => {
      if (method === "GET" && url === `${BASE}/staff/repartidores`) return jsonResponse({ repartidores: [] });
      if (method === "GET" && url === `${BASE}/staff/invitaciones`) return jsonResponse({ invitations: [] });
      if (method === "GET" && url === `${BASE}/staff/miembros`) return jsonResponse({ miembros: [MIEMBRO] });
      if (method === "DELETE" && url === `${BASE}/staff/miembros/user-1`) return jsonResponse({ ok: true });
      return null;
    });
  }

  async function abrirBaja(): Promise<void> {
    stubStaff();
    rendered = renderComponent(
      <MemoryRouter>
        <StaffPage {...ctx()} />
      </MemoryRouter>,
    );
    await esperar();
    const boton = [...rendered.container.querySelectorAll("button")].find((b) => b.textContent === "Dar de baja")!;
    click(boton);
    await esperar();
  }

  it("abre un alertdialog con el nombre del miembro y nunca usa window.confirm", async () => {
    await abrirBaja();
    expect(dialogo()).not.toBeNull();
    expect(dialogo()!.textContent).toContain("Dar de baja a Ana Pérez");
    expect(dialogo()!.textContent).toContain("Pierde acceso a esta organización de inmediato.");
    expect(confirmMock).not.toHaveBeenCalled();
    expect(deletes()).toHaveLength(0);
  });

  it("Cancelar no ejecuta el DELETE", async () => {
    await abrirBaja();
    await pulsarEnDialogo("Cancelar");
    expect(deletes()).toHaveLength(0);
    expect(rendered!.container.textContent).toContain("Ana Pérez");
  });

  it("Confirmar ejecuta DELETE .../staff/miembros/:id y quita al miembro de la lista", async () => {
    await abrirBaja();
    await pulsarEnDialogo("Dar de baja");
    expect(deletes()).toHaveLength(1);
    expect(deletes()[0]![0]).toBe(`${BASE}/staff/miembros/user-1`);
    expect(rendered!.container.textContent).not.toContain("ana@example.com");
    expect(confirmMock).not.toHaveBeenCalled();
  });
});

describe("Configuracion (restaurantes) — quitar zona con ConfirmDialog", () => {
  const ZONA = { id: "zona-1", name: "Altabrisa", lat: 21.0619, lng: -89.6216 };

  function stubConfig() {
    stubFetch((method, url) => {
      if (method === "GET" && url === `${BASE}/config/whatsapp`) return jsonResponse({ phoneNumberId: "123" });
      if (method === "GET" && url === `${BASE}/config/zonas`) return jsonResponse({ zonas: [ZONA] });
      if (method === "GET" && url === `${BASE}/config/zona-horaria`) return jsonResponse({ zonaHoraria: null });
      if (method === "DELETE" && url === `${BASE}/config/zonas/zona-1`) return jsonResponse({ ok: true });
      // AgenteWhatsappSeccion (hija de esta pagina) hace sus propias lecturas: no son parte de este test.
      if (method === "GET") return jsonResponse({}, false);
      return null;
    });
  }

  async function abrirQuitar(): Promise<void> {
    stubConfig();
    rendered = renderComponent(
      <MemoryRouter>
        <ConfiguracionPage {...ctx()} />
      </MemoryRouter>,
    );
    await esperar();
    click(rendered.container.querySelector('button[aria-label="Quitar zona Altabrisa"]')!);
    await esperar();
  }

  it("el boton de solo icono tiene nombre accesible y abre el dialogo con el nombre de la zona", async () => {
    await abrirQuitar();
    expect(dialogo()!.textContent).toContain('Quitar "Altabrisa" de las zonas conocidas');
    expect(confirmMock).not.toHaveBeenCalled();
    expect(deletes()).toHaveLength(0);
  });

  it("Cancelar no ejecuta el DELETE", async () => {
    await abrirQuitar();
    await pulsarEnDialogo("Cancelar");
    expect(deletes()).toHaveLength(0);
    expect(rendered!.container.textContent).toContain("Altabrisa");
  });

  it("Confirmar ejecuta DELETE .../config/zonas/:id y la zona desaparece", async () => {
    await abrirQuitar();
    await pulsarEnDialogo("Quitar zona");
    expect(deletes()).toHaveLength(1);
    expect(deletes()[0]![0]).toBe(`${BASE}/config/zonas/zona-1`);
    expect(rendered!.container.querySelector('button[aria-label="Quitar zona Altabrisa"]')).toBeNull();
  });
});
