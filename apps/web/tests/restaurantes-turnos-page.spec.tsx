// @vitest-environment jsdom
//
// R-21: pantalla de Turnos. Todo el personal ve quien esta de guardia; solo owner/admin edita (el servidor re-valida).
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TurnosPage } from "../src/verticals/restaurantes/pages/Turnos.tsx";
import type { RestaurantesShellContext } from "../src/verticals/restaurantes/RestaurantesShell.tsx";
import { changeValue, click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

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

  // QA-restaurantes-R1-botones-05: validacion local antes del PUT.
  it("turno invalido (sin nombre, sin dias, inicio = fin) avisa localmente y NO manda el PUT", async () => {
    rendered = renderComponent(<TurnosPage {...CTX} />);
    await esperar();
    const input = (label: string) => rendered!.container.querySelector(`input[aria-label='${label}']`) as HTMLInputElement;
    changeValue(input("Nombre del turno 1"), "   ");
    await esperar();
    const guardar = () => Array.from(rendered!.container.querySelectorAll("button")).find((b) => b.textContent === "Guardar turnos")!;
    click(guardar());
    await esperar();
    expect(rendered.container.querySelector('[role="alert"]')?.textContent).toContain("necesita un nombre");
    changeValue(input("Nombre del turno 1"), "Comida");
    changeValue(input("Fin del turno 1"), "12:00");
    click(guardar());
    await esperar();
    expect(rendered.container.querySelector('[role="alert"]')?.textContent).toContain("no pueden ser iguales");
    changeValue(input("Fin del turno 1"), "18:00");
    for (const dia of Array.from(rendered.container.querySelectorAll("[role='group'] input[type='checkbox']"))) if ((dia as HTMLInputElement).checked) click(dia);
    click(guardar());
    await esperar();
    expect(rendered.container.querySelector('[role="alert"]')?.textContent).toContain("al menos un día");
    expect(fetchMock.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === "PUT")).toBe(false);
  });

  // QA-restaurantes-R1-botones-08: el nombre por defecto no se repite tras "Quitar turno".
  it("Agregar, quitar y volver a agregar turnos nunca repite el nombre por defecto", async () => {
    rendered = renderComponent(<TurnosPage {...CTX} />);
    await esperar();
    const agregar = () => click(Array.from(rendered!.container.querySelectorAll("button")).find((b) => b.textContent === "Agregar turno")!);
    const nombres = () => Array.from(rendered!.container.querySelectorAll("input[aria-label^='Nombre del turno']")).map((i) => (i as HTMLInputElement).value);
    agregar();
    agregar();
    expect(nombres()).toEqual(["Turno 1", "Turno 2", "Turno 3"]);
    click(Array.from(rendered.container.querySelectorAll("button")).filter((b) => b.textContent === "Quitar turno")[1]!);
    agregar();
    const final = nombres();
    expect(final).toHaveLength(3);
    expect(new Set(final.map((n) => n.toLowerCase())).size).toBe(3);
  });

  it("un fallo del servidor al guardar se anuncia como alerta y el exito como estado", async () => {
    rendered = renderComponent(<TurnosPage {...CTX} />);
    await esperar();
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      init?.method === "PUT" ? ({ ok: false, status: 503, json: async () => ({ message: "Servicio no disponible" }) } as unknown as Response) : String(url).endsWith("/staff/miembros") ? json({ miembros: [] }) : json(TURNOS),
    );
    click(Array.from(rendered.container.querySelectorAll("button")).find((b) => b.textContent === "Guardar turnos")!);
    await esperar();
    expect(rendered.container.querySelector('[role="alert"]')?.textContent).toContain("Servicio no disponible");
    expect(rendered.container.querySelector('[role="status"]')).toBeNull();
  });
});
