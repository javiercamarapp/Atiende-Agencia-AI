// @vitest-environment jsdom
//
// <StaffPage /> de despachos tras migrar invitaciones pendientes y staff activo a DataTable (UNI-C-despachos.3): los datos reales llegan a las
// tablas (con nombre accesible), los estados vacio y error son honestos, el cambio de rol sigue pegando al PATCH real y un rol sin permiso
// no ve listados ni dispara fetch. `fetch` global mockeado por ruta real de staff-client.ts.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StaffPage } from "../src/verticals/despachos/pages/Staff.tsx";
import type { DespachosShellContext } from "../src/verticals/despachos/DespachosShell.tsx";
import { changeValue, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

const jsonResponse = (body: unknown, ok = true): Response => ({ ok, status: ok ? 200 : 500, json: async () => body }) as unknown as Response;

const CTX: DespachosShellContext = {
  apiBaseUrl: "https://api.test",
  token: "tok-123",
  propertyId: "prop-1",
  orgSlug: "demo",
  role: "admin",
  staffFullName: "Admin Demo",
  staffEmail: "admin@example.com",
};

const INVITACION = { id: "inv-1", email: "nuevo@example.com", verticalRole: "contador", propertyIds: null, status: "pending", expiresAt: "2026-12-01T12:00:00.000Z", createdAt: "2026-11-01T12:00:00.000Z" };
const MIEMBRO = { id: "usr-1", email: "ana@example.com", fullName: "Ana Contadora", verticalRole: "auditor", propertyIds: null };

function stubFetch(opts: { invitaciones?: unknown[]; miembros?: unknown[]; fallaInvitaciones?: boolean } = {}) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "GET" && url.endsWith("/admin/staff/invitaciones")) return jsonResponse({ invitations: opts.invitaciones ?? [] }, !opts.fallaInvitaciones);
    if (method === "GET" && url.endsWith("/admin/staff/miembros")) return jsonResponse({ miembros: opts.miembros ?? [] });
    if (method === "PATCH" && url.includes("/admin/staff/miembros/")) return jsonResponse({ ...MIEMBRO, verticalRole: "readonly" });
    throw new Error(`fetch inesperado en el test: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}

async function esperarCarga(): Promise<void> {
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
  });
}

describe("StaffPage (despachos) con DataTable", () => {
  it("muestra invitaciones pendientes y staff activo como tablas con nombre accesible y datos reales", async () => {
    stubFetch({ invitaciones: [INVITACION], miembros: [MIEMBRO] });
    rendered = renderComponent(<StaffPage {...CTX} />);
    await esperarCarga();
    const tablas = Array.from(rendered.container.querySelectorAll("table"));
    expect(tablas.map((t) => t.getAttribute("aria-label"))).toEqual(["Invitaciones pendientes", "Staff activo"]);
    const texto = rendered.container.textContent!;
    expect(texto).toContain("nuevo@example.com");
    expect(texto).toContain("Pendiente");
    expect(texto).toContain("Ana Contadora");
    expect(texto).toContain("ana@example.com");
    expect(rendered.container.querySelector<HTMLSelectElement>("#staff-rol-usr-1")?.value).toBe("auditor");
    expect(Array.from(rendered.container.querySelectorAll("button")).some((b) => b.textContent?.includes("Revocar"))).toBe(true);
  });

  it("estados vacios honestos, sin tablas", async () => {
    stubFetch();
    rendered = renderComponent(<StaffPage {...CTX} />);
    await esperarCarga();
    expect(rendered.container.querySelector("table")).toBeNull();
    expect(rendered.container.textContent).toContain("No hay ninguna invitación pendiente.");
    expect(rendered.container.textContent).toContain("Todavía no hay ningún staff aceptado en este despacho.");
  });

  it("si la carga falla muestra el error real", async () => {
    stubFetch({ fallaInvitaciones: true });
    rendered = renderComponent(<StaffPage {...CTX} />);
    await esperarCarga();
    expect(rendered.container.querySelector('[role="alert"]')).not.toBeNull();
  });

  it("cambiar el rol de un staff activo hace PATCH real al miembro con el rol elegido", async () => {
    stubFetch({ miembros: [MIEMBRO] });
    rendered = renderComponent(<StaffPage {...CTX} />);
    await esperarCarga();
    const select = rendered.container.querySelector<HTMLSelectElement>("#staff-rol-usr-1")!;
    await act(async () => {
      changeValue(select, "readonly");
      await flushMicrotasks();
    });
    const patch = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "PATCH");
    expect(patch?.[0]).toBe("https://api.test/despachos/prop-1/admin/staff/miembros/usr-1");
    expect(JSON.parse((patch?.[1] as RequestInit).body as string)).toEqual({ verticalRole: "readonly" });
  });

  it("un rol sin permiso de gestion no ve listados ni consulta la API", async () => {
    stubFetch({ invitaciones: [INVITACION], miembros: [MIEMBRO] });
    rendered = renderComponent(<StaffPage {...CTX} role="contador" />);
    await esperarCarga();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(rendered.container.querySelector("table")).toBeNull();
  });
});
