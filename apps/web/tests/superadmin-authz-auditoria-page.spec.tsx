// @vitest-environment jsdom
//
// Smoke tests reales de <SuperAdminAuthzAuditoriaPage /> -- mismo patrón que
// superadmin-impersonacion-page.spec.tsx.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SuperAdminAuthzAuditoriaPage } from "../src/superadmin/pages/AuthzAuditoria.tsx";
import type { AuthzAuditLogEntry } from "../src/superadmin/pages/AuthzAuditoria.tsx";
import { click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

async function esperarCarga(): Promise<void> {
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
  });
}

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as unknown as Response;
}

function entry(overrides: Partial<AuthzAuditLogEntry> = {}): AuthzAuditLogEntry {
  return {
    id: "row-1",
    actorUserId: "staff-1",
    actorIp: "150.172.238.178",
    organizationId: null,
    action: "admin:access",
    route: "/superadmin/impersonacion/sesiones",
    method: "POST",
    decision: "denied",
    reason: "no_membership",
    metadata: {},
    occurredAtMs: Date.now(),
    ...overrides,
  };
}

function renderPage(): RenderedComponent {
  return renderComponent(<SuperAdminAuthzAuditoriaPage apiBaseUrl="https://api.test" token="tok-123" />);
}

describe("SuperAdminAuthzAuditoriaPage", () => {
  it("muestra el estado de carga primero, y después el estado vacío real sin denegaciones", async () => {
    fetchMock = vi.fn(async () => jsonResponse({ available: true, entries: [], hasMore: false }));
    vi.stubGlobal("fetch", fetchMock);
    rendered = renderPage();
    expect(rendered.container.textContent).toContain("Cargando bitácora de denegaciones");

    await esperarCarga();
    expect(rendered.container.textContent).toContain("Auditoría de denegaciones");
    expect(rendered.container.textContent).toContain("Sin denegaciones registradas");
  });

  it("estado de error cuando el fetch falla -- nunca se queda atorado en 'Cargando'", async () => {
    fetchMock = vi.fn(async () => {
      throw new Error("network down");
    });
    vi.stubGlobal("fetch", fetchMock);
    rendered = renderPage();
    await esperarCarga();
    expect(rendered.container.textContent).toContain("No se pudo cargar la bitácora de denegaciones");
  });

  it("available:false -- muestra el aviso de 'migración pendiente', nunca oculta las filas ya devueltas", async () => {
    fetchMock = vi.fn(async () => jsonResponse({ available: false, entries: [entry()], hasMore: false }));
    vi.stubGlobal("fetch", fetchMock);
    rendered = renderPage();
    await esperarCarga();
    expect(rendered.container.textContent).toContain("migración pendiente de aplicar");
    expect(rendered.container.textContent).toContain("/superadmin/impersonacion/sesiones");
  });

  it("renderiza una fila con actor/ip/ruta/motivo, y 'Cargar más' dispara la siguiente página con offset real", async () => {
    fetchMock = vi.fn(async (url: string) => {
      if (url.includes("offset=0")) return jsonResponse({ available: true, entries: [entry({ id: "a", route: "/superadmin/a" })], hasMore: true });
      if (url.includes("offset=1")) return jsonResponse({ available: true, entries: [entry({ id: "b", route: "/superadmin/b" })], hasMore: false });
      throw new Error(`fetch inesperado: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    rendered = renderPage();
    await esperarCarga();

    expect(rendered.container.textContent).toContain("/superadmin/a");
    expect(rendered.container.textContent).toContain("Cargar más");

    const boton = Array.from(rendered.container.querySelectorAll("button")).find((b) => b.textContent?.includes("Cargar más"));
    expect(boton).toBeTruthy();
    click(boton!);
    await esperarCarga();

    // Acumula (nunca reemplaza) -- la primera fila sigue visible junto a la nueva.
    expect(rendered.container.textContent).toContain("/superadmin/a");
    expect(rendered.container.textContent).toContain("/superadmin/b");
    // Ya no hay más -- el botón desaparece.
    expect(Array.from(rendered.container.querySelectorAll("button")).some((b) => b.textContent?.includes("Cargar más"))).toBe(false);
  });

  it("motivo sin traducción conocida se muestra tal cual (nunca 'undefined')", async () => {
    fetchMock = vi.fn(async () => jsonResponse({ available: true, entries: [entry({ reason: "rate_limited" })], hasMore: false }));
    vi.stubGlobal("fetch", fetchMock);
    rendered = renderPage();
    await esperarCarga();
    expect(rendered.container.textContent).toContain("Límite de intentos");
  });
});
