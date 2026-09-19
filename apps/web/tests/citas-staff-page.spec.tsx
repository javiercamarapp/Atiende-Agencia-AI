// @vitest-environment jsdom
//
// Smoke tests reales de <StaffPage /> (citas) — invitar/revocar staff y
// cambiar el rol de staff ya aceptado. `fetch` global mockeado por ruta real
// contra apps/api/src/routes/verticals/citas/admin-staff.ts, gate real por rol
// del lado del cliente (STAFF_INVITE_ROLES, cosmético — el servidor sigue
// siendo el enforcement), estados de carga/vacío/error, y las acciones
// principales: invitar, revocar y cambiar rol de un miembro activo.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { StaffPage } from "../src/verticals/citas/pages/Staff.tsx";
import type { CitasShellContext } from "../src/verticals/citas/CitasShell.tsx";
import type { CreatedStaffInvite, OrgMember, StaffInvite } from "../src/verticals/citas/lib/staff-client.ts";
import { changeValue, click, flushMicrotasks, renderComponent, submitForm, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, json: async () => body } as unknown as Response;
}

function ctx(role: string): CitasShellContext {
  return { apiBaseUrl: "https://api.test", token: "tok-123", propertyId: "prop-1", orgSlug: "demo", role, staffFullName: "Sam Demo", staffEmail: "sam@example.com" } as CitasShellContext;
}

const INVITE_PENDIENTE: StaffInvite = { id: "inv-1", email: "nuevo@example.com", verticalRole: "staff", propertyIds: null, status: "pending", expiresAt: "2026-09-25T00:00:00.000Z", createdAt: "2026-09-18T00:00:00.000Z" };
const MIEMBRO_1: OrgMember = { id: "user-1", email: "ana@example.com", fullName: "Ana Pérez", verticalRole: "staff", propertyIds: null };

interface Handlers {
  invites?: readonly StaffInvite[] | (() => readonly StaffInvite[]);
  members?: readonly OrgMember[] | (() => readonly OrgMember[]);
  invitesOk?: boolean;
}

function stubFetch(handlers: Handlers) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "GET" && url === "https://api.test/v1/citas/properties/prop-1/admin/staff/invitaciones") {
      const invites = typeof handlers.invites === "function" ? handlers.invites() : (handlers.invites ?? [INVITE_PENDIENTE]);
      return jsonResponse({ invitations: invites }, handlers.invitesOk ?? true);
    }
    if (method === "GET" && url === "https://api.test/v1/citas/properties/prop-1/admin/staff/miembros") {
      const members = typeof handlers.members === "function" ? handlers.members() : (handlers.members ?? [MIEMBRO_1]);
      return jsonResponse({ miembros: members }, handlers.invitesOk ?? true);
    }
    if (method === "POST" && url === "https://api.test/v1/citas/properties/prop-1/admin/staff/invitaciones") {
      const input = JSON.parse(init!.body as string) as { email: string; verticalRole: string };
      const created: CreatedStaffInvite = { id: "inv-nuevo", email: input.email, verticalRole: input.verticalRole as StaffInvite["verticalRole"], propertyIds: null, status: "pending", expiresAt: "2026-09-26T00:00:00.000Z", createdAt: "2026-09-19T00:00:00.000Z", inviteToken: "TOKEN-SECRETO-123" };
      return jsonResponse(created);
    }
    if (method === "DELETE" && url === "https://api.test/v1/citas/properties/prop-1/admin/staff/invitaciones/inv-1") {
      return jsonResponse({ ok: true });
    }
    if (method === "PATCH" && url === "https://api.test/v1/citas/properties/prop-1/admin/staff/miembros/user-1") {
      const patch = JSON.parse(init!.body as string) as { verticalRole: string };
      return jsonResponse({ ...MIEMBRO_1, verticalRole: patch.verticalRole });
    }
    throw new Error(`fetch inesperado en el test: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}

function renderPage(role = "owner"): RenderedComponent {
  return renderComponent(
    <MemoryRouter>
      <StaffPage {...ctx(role)} />
    </MemoryRouter>,
  );
}

async function esperarCarga(): Promise<void> {
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
  });
}

describe("StaffPage (citas)", () => {
  it("rol 'staff' (sin permiso): NUNCA llama a la API y muestra el aviso de acceso reservado con el rol real", async () => {
    stubFetch({});
    rendered = renderPage("staff");
    await esperarCarga();
    expect(fetchMock.mock.calls.length).toBe(0);
    expect(rendered.container.textContent).toContain("Invitar o revocar staff está reservado a dueños y administradores.");
    expect(rendered.container.textContent).toContain("(staff)");
    expect(rendered.container.querySelector("#citas-staff-email")).toBeNull();
  });

  it("rol 'owner': muestra el estado de carga y luego pide invitaciones y miembros", async () => {
    stubFetch({});
    rendered = renderPage("owner");
    expect(rendered.container.textContent).toContain("Cargando invitaciones");
    await esperarCarga();
    expect(fetchMock.mock.calls.some(([url]) => url.endsWith("/invitaciones"))).toBe(true);
    expect(fetchMock.mock.calls.some(([url]) => url.endsWith("/miembros"))).toBe(true);
  });

  it("estado de error real — nunca se queda atorado en 'Cargando'", async () => {
    stubFetch({ invitesOk: false });
    rendered = renderPage("owner");
    await esperarCarga();
    expect(rendered.container.textContent).not.toContain("Cargando invitaciones");
    expect(rendered.container.textContent).toContain("No se pudo cargar https://api.test/v1/citas/properties/prop-1/admin/staff/invitaciones (500).");
  });

  it("estado vacío honesto: sin invitaciones pendientes y sin staff activo", async () => {
    stubFetch({ invites: [], members: [] });
    rendered = renderPage("owner");
    await esperarCarga();
    expect(rendered.container.textContent).toContain("No hay ninguna invitación pendiente.");
    expect(rendered.container.textContent).toContain("Todavía no hay ningún staff aceptado en este negocio.");
  });

  it("renderiza invitaciones y staff activo reales", async () => {
    stubFetch({});
    rendered = renderPage("owner");
    await esperarCarga();
    const text = rendered.container.textContent!;
    expect(text).toContain("nuevo@example.com");
    expect(text).toContain("Pendiente");
    expect(text).toContain("Ana Pérez");
    expect(text).toContain("ana@example.com");
  });

  it("invitar staff nuevo: POST .../invitaciones con email en minúsculas y rol real, muestra el token una sola vez y recarga", async () => {
    let invitesActuales = [INVITE_PENDIENTE];
    stubFetch({ invites: () => invitesActuales });
    rendered = renderPage("owner");
    await esperarCarga();

    changeValue(rendered.container.querySelector("#citas-staff-email") as HTMLInputElement, "NuevoStaff@Example.com");
    changeValue(rendered.container.querySelector("#citas-staff-rol") as HTMLSelectElement, "admin");
    invitesActuales = [INVITE_PENDIENTE, { id: "inv-nuevo", email: "nuevostaff@example.com", verticalRole: "admin", propertyIds: null, status: "pending", expiresAt: "2026-09-26T00:00:00.000Z", createdAt: "2026-09-19T00:00:00.000Z" }];

    const form = [...rendered.container.querySelectorAll("form")].find((f) => f.textContent?.includes("Invitar"))!;
    await submitForm(form);
    await esperarCarga();

    const call = fetchMock.mock.calls.find(([url, init]) => url === "https://api.test/v1/citas/properties/prop-1/admin/staff/invitaciones" && init?.method === "POST");
    expect(call).toBeDefined();
    expect(JSON.parse(call![1].body as string)).toEqual({ email: "nuevostaff@example.com", verticalRole: "admin" });
    expect(rendered.container.textContent).toContain("TOKEN-SECRETO-123");
    expect(rendered.container.textContent).toContain("nuevostaff@example.com");
  });

  it("revocar invitación: DELETE .../invitaciones/inv-1 y recarga la lista", async () => {
    let invitesActuales: readonly StaffInvite[] = [INVITE_PENDIENTE];
    stubFetch({ invites: () => invitesActuales });
    rendered = renderPage("owner");
    await esperarCarga();

    const revokeBtn = [...rendered.container.querySelectorAll("button")].find((b) => b.textContent === "Revocar")!;
    invitesActuales = [];
    await act(async () => {
      click(revokeBtn);
      await flushMicrotasks();
      await flushMicrotasks();
    });

    const call = fetchMock.mock.calls.find(([url, init]) => url === "https://api.test/v1/citas/properties/prop-1/admin/staff/invitaciones/inv-1" && init?.method === "DELETE");
    expect(call).toBeDefined();
    expect(rendered.container.textContent).toContain("No hay ninguna invitación pendiente.");
  });

  it("cambiar rol de un miembro activo real: PATCH .../miembros/user-1 con el rol nuevo exacto", async () => {
    stubFetch({});
    rendered = renderPage("owner");
    await esperarCarga();

    const select = rendered.container.querySelector("#citas-staff-rol-user-1") as HTMLSelectElement;
    changeValue(select, "admin");
    await act(async () => {
      await flushMicrotasks();
      await flushMicrotasks();
    });

    const call = fetchMock.mock.calls.find(([url, init]) => url === "https://api.test/v1/citas/properties/prop-1/admin/staff/miembros/user-1" && init?.method === "PATCH");
    expect(call).toBeDefined();
    expect(JSON.parse(call![1].body as string)).toEqual({ verticalRole: "admin" });
  });

  it("cambio de rol rechazado por el servidor (403, jerarquía real): muestra el error real, nunca un éxito fingido", async () => {
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET" && url.endsWith("/invitaciones")) return jsonResponse({ invitations: [] });
      if (method === "GET" && url.endsWith("/miembros")) return jsonResponse({ miembros: [MIEMBRO_1] });
      if (method === "PATCH") return jsonResponse({ message: "No puedes asignar un rol por encima del tuyo." }, false);
      throw new Error(`fetch inesperado: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    rendered = renderPage("owner");
    await esperarCarga();

    const select = rendered.container.querySelector("#citas-staff-rol-user-1") as HTMLSelectElement;
    changeValue(select, "owner");
    await act(async () => {
      await flushMicrotasks();
      await flushMicrotasks();
    });

    expect(rendered.container.textContent).toContain("No puedes asignar un rol por encima del tuyo.");
    // El select real sigue mostrando el rol actual (staff), nunca el rechazado.
    expect((rendered.container.querySelector("#citas-staff-rol-user-1") as HTMLSelectElement).value).toBe("staff");
  });
});
