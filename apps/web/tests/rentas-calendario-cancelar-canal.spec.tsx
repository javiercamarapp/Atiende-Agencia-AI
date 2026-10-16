// @vitest-environment jsdom
//
// Rn-P3-29 (adversarial) -- el calendario NUNCA ofrece "Cancelar reserva" para una reserva importada de un canal externo
// (Airbnb/Booking/Vrbo): cancelarla aqui liberaria las noches mientras el canal sigue con la reserva viva. Muestra el aviso de
// "cancelala alla" y la reserva directa ('manual' o sin canal) conserva su boton.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CalendarioPage } from "../src/verticals/rentas/pages/Calendario.tsx";
import type { RentasShellContext } from "../src/verticals/rentas/RentasShell.tsx";
import { click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

const CTX: RentasShellContext = {
  apiBaseUrl: "https://api.test",
  token: "tok-123",
  propertyId: "prop-1",
  setPropertyId: () => {},
  properties: [{ propertyId: "prop-1", nombre: "Depa Marina" }],
  orgSlug: "demo",
  session: { token: "tok-123", refreshToken: "ref", email: "g@example.com", organizations: [{ id: "org-1", slug: "demo", nombre: "Demo", vertical: "rentas", rol: "admin_gestora" }] },
};

const res = (body: unknown): Response => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
const ocu = (id: string, extra: Record<string, unknown>) => ({
  id, unidadId: "u1", capa: "reserva", rango: { inicio: "2026-11-01", fin: "2026-11-05" }, razon: "RESERVA_CANAL", estado: "confirmado", canalCodigo: null, huespedNombre: null, huespedContacto: null, createdAt: "2026-10-01T10:00:00Z", ...extra,
});

async function esperar(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i++) await flushMicrotasks();
  });
}

async function abrir(ocupaciones: unknown[]): Promise<RenderedComponent> {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.endsWith("/unidades")) return res({ unidades: [{ id: "u1", name: "Depa 101", nombre: "Depa 101" }] });
      if (url.includes("/calendario?")) return res({ zona_horaria: "America/Cancun", hoy: "2026-11-01", total: 0, truncado: false, ocupaciones: [] });
      if (url.includes("/tareas?")) return res({ tareas: [] });
      if (url.includes("/conflictos?")) return res({ zona_horaria: "America/Cancun", conflictos: [], total_abiertos: 0 });
      if (url.endsWith("/unidades/u1/ocupaciones")) return res({ ocupaciones });
      throw new Error(`fetch inesperado: ${url}`);
    }),
  );
  const r = renderComponent(<CalendarioPage {...CTX} />);
  await esperar();
  click([...r.container.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Lista")!);
  await esperar();
  return r;
}

const textosBoton = (r: RenderedComponent) => [...r.container.querySelectorAll("button")].map((b) => b.textContent?.trim());

describe("Calendario (lista) -- cancelar una reserva de canal (Rn-P3-29)", () => {
  it("una reserva de Airbnb NO muestra 'Cancelar reserva' y explica que se cancela en el canal", async () => {
    rendered = await abrir([ocu("o1", { canalCodigo: "airbnb" })]);
    expect(textosBoton(rendered)).not.toContain("Cancelar reserva");
    expect(rendered.container.textContent).toContain("Esta reserva viene de airbnb: cancélala allá; Atiende la liberará en el siguiente sync.");
  });

  it("una reserva directa ('manual') conserva su boton y no muestra el aviso", async () => {
    rendered = await abrir([ocu("o2", { canalCodigo: "manual" })]);
    expect(textosBoton(rendered)).toContain("Cancelar reserva");
    expect(rendered.container.textContent).not.toContain("cancélala allá");
  });

  it("un bloqueo manual conserva 'Liberar bloqueo'", async () => {
    rendered = await abrir([ocu("o3", { capa: "bloqueo", razon: "MANTENIMIENTO", canalCodigo: null })]);
    expect(textosBoton(rendered)).toContain("Liberar bloqueo");
  });
});
