// @vitest-environment jsdom
//
// paridad3 L-P3-16 -- Staff: quitar a un miembro ya aceptado. Pide confirmacion (Cancelar NO escribe), manda DELETE al id real, no ofrece
// quitarse a uno mismo y muestra el error real del servidor (409 ultimo owner) en vez de fingir exito.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StaffPage } from "../src/verticals/licitaciones/pages/Staff.tsx";
import type { LicitacionesShellContext } from "../src/verticals/licitaciones/LicitacionesShell.tsx";
import { click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

const CTX: LicitacionesShellContext = { apiBaseUrl: "https://api.test", token: "tok", propertyId: "prop-1", orgSlug: "demo", role: "owner", staffFullName: "Yo", staffEmail: "yo@example.com" };
const MIEMBROS = [
  { id: "u-yo", email: "yo@example.com", fullName: "Yo Mismo", verticalRole: "owner", propertyIds: null },
  { id: "u-2", email: "ana@example.com", fullName: "Ana Analista", verticalRole: "analyst", propertyIds: null },
];

function stub(deleteResponse: { ok: boolean; status: number; body: unknown } = { ok: true, status: 200, body: { ok: true } }) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    let r: { ok: boolean; status: number; body: unknown } = { ok: true, status: 200, body: {} };
    if (method === "DELETE" && u.endsWith("/admin/staff/miembros/u-2")) r = deleteResponse;
    else if (u.endsWith("/admin/staff/miembros")) r = { ok: true, status: 200, body: { miembros: MIEMBROS } };
    else if (u.endsWith("/admin/staff/invitaciones")) r = { ok: true, status: 200, body: { invitations: [] } };
    else if (u.includes("/admin/tenant-config")) r = { ok: true, status: 200, body: { tenant_config: { organization_id: "o", timezone: null } } };
    return { ok: r.ok, status: r.status, headers: new Headers(), json: async () => r.body } as unknown as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
}
async function settle() {
  await act(async () => {
    for (let i = 0; i < 8; i++) await flushMicrotasks();
  });
}
const buttons = (t: string) => [...document.body.querySelectorAll("button")].filter((b) => b.textContent?.trim() === t);
const deletes = () => fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "DELETE");

describe("Staff: quitar miembro (L-P3-16)", () => {
  it("Cancelar no escribe; confirmar manda DELETE al id real y el miembro desaparece", async () => {
    stub();
    rendered = renderComponent(<StaffPage {...CTX} />);
    await settle();
    await act(async () => click(buttons("Quitar")[1]!));
    await settle();
    expect(document.body.textContent).toContain("Quitar a Ana Analista");
    await act(async () => click(buttons("Cancelar")[0]!));
    await settle();
    expect(deletes()).toHaveLength(0);

    await act(async () => click(buttons("Quitar")[1]!));
    await settle();
    await act(async () => click(buttons("Quitar del staff")[0]!));
    await settle();
    expect(deletes()).toHaveLength(1);
    expect(String(deletes()[0]![0])).toBe("https://api.test/v1/licitaciones/prop-1/admin/staff/miembros/u-2");
    expect(rendered!.container.textContent).not.toContain("Ana Analista");
  });

  it("no se ofrece quitarse a uno mismo (boton deshabilitado)", async () => {
    stub();
    rendered = renderComponent(<StaffPage {...CTX} />);
    await settle();
    expect(buttons("Quitar")[0]!.disabled).toBe(true);
    expect(buttons("Quitar")[1]!.disabled).toBe(false);
  });

  it("el error real del servidor (409 ultimo owner) se muestra y el miembro se queda", async () => {
    stub({ ok: false, status: 409, body: { error: { message: "No puedes quitar al último owner de la organización." }, message: "No puedes quitar al último owner de la organización." } });
    rendered = renderComponent(<StaffPage {...CTX} />);
    await settle();
    await act(async () => click(buttons("Quitar")[1]!));
    await settle();
    await act(async () => click(buttons("Quitar del staff")[0]!));
    await settle();
    expect(rendered!.container.textContent).toContain("Ana Analista");
    expect(rendered!.container.querySelector('[role="alert"]')).not.toBeNull();
  });
});
