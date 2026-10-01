// @vitest-environment jsdom
//
// R-21: pantalla de Turnos. Todo el personal ve quien esta de guardia; solo owner/admin edita (el servidor re-valida).
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TurnosPage } from "../src/verticals/restaurantes/pages/Turnos.tsx";
import type { RestaurantesShellContext } from "../src/verticals/restaurantes/RestaurantesShell.tsx";
import { click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;
const CTX: RestaurantesShellContext = { apiBaseUrl: "https://api.test", token: "tok", propertyId: "prop-1", orgSlug: "demo", role: "owner", staffFullName: "Ana", staffEmail: "ana@example.com" };

function json(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
}
const TURNOS = {
  disponible: true,
  turnos: [{ id: "t1", nombre: "Turno 1", dias: [0, 1, 2, 3, 4, 5, 6], inicia: "12:00", termina: "18:00", miembros: [{ userId: "u1", nombre: "Ana", orden: 1 }] }],
  cobertura: { sinCobertura: false, turnosVigentes: [], guardia: [{ userId: "u1", nombre: "Ana", turno: "Turno 1", orden: 1 }] },
};
async function esperar(): Promise<void> {
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
  });
}
const botones = () => Array.from(rendered!.container.querySelectorAll("button")).map((b) => b.textContent);

beforeEach(() => {
  fetchMock = vi.fn(async (url: string) => (String(url).endsWith("/staff/miembros") ? json({ miembros: [{ id: "u1", email: "ana@example.com", fullName: "Ana", verticalRole: "staff", propertyIds: null }] }) : json(TURNOS)));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

describe("TurnosPage (restaurantes)", () => {
  it("el staff de piso ve quien esta de guardia pero NO tiene botones de edicion", async () => {
    rendered = renderComponent(<TurnosPage {...CTX} role="staff" />);
    await esperar();
    expect(rendered.container.textContent).toContain("Ana — Turno 1 (principal)");
    expect(botones()).not.toContain("Guardar turnos");
    expect(rendered.container.querySelector("input[aria-label='Nombre del turno 1']")?.hasAttribute("disabled")).toBe(true);
    expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith("/staff/miembros"))).toBe(false);
  });

  it("owner guarda: PUT con los turnos y los miembros por userId/orden", async () => {
    rendered = renderComponent(<TurnosPage {...CTX} />);
    await esperar();
    click(Array.from(rendered.container.querySelectorAll("button")).find((b) => b.textContent === "Guardar turnos")!);
    await esperar();
    const put = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === "PUT");
    expect(String(put?.[0])).toBe("https://api.test/v1/restaurantes/prop-1/admin/turnos");
    expect(JSON.parse(String((put?.[1] as RequestInit).body))).toEqual({ turnos: [{ nombre: "Turno 1", dias: [0, 1, 2, 3, 4, 5, 6], inicia: "12:00", termina: "18:00", miembros: [{ userId: "u1", orden: 1 }] }] });
    expect(rendered.container.textContent).toContain("Turnos guardados.");
  });

  it("base sin migrar muestra el estado honesto", async () => {
    fetchMock.mockImplementation(async () => json({ ...TURNOS, disponible: false, turnos: [] }));
    rendered = renderComponent(<TurnosPage {...CTX} />);
    await esperar();
    expect(rendered.container.textContent).toContain("Turnos no disponibles aún");
  });
});
