// @vitest-environment jsdom
//
// QA-citas-R1-botones-07 / 07b / features-10: la Agenda usa la zona del NEGOCIO (la que informa `GET .../resumen`), no la del navegador.
// Navegador del test: Tijuana (UTC-7 en octubre); negocio en Merida (UTC-6): una cita a las 10:00 locales del negocio es 16:00Z.
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgendaPage } from "../src/verticals/citas/pages/Agenda.tsx";
import type { CitasShellContext } from "../src/verticals/citas/CitasShell.tsx";
import { changeValue, flushMicrotasks, renderComponent, submitForm, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
const CTX: CitasShellContext = { apiBaseUrl: "https://api.test", token: "tok", propertyId: "prop-1", orgSlug: "demo", orgId: "org-1", role: "owner", staffFullName: "Staff", staffEmail: "s@example.com" };
const json = (body: unknown): Response => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
const RESUMEN = {
  timezone: "America/Merida",
  generated_at: "2026-10-21T14:00:00.000Z",
  today: { date: "2026-10-21", total: 0, by_status: {} },
  week: { from_date: "2026-10-19", to_date: "2026-10-25", total: 0, by_status: {} },
  pending_to_confirm: 0,
  no_shows_last_30_days: 0,
  new_customers_last_30_days: 0,
};
const cita = (id: string, startsAt: string, nombre: string) => ({
  id, property_id: "prop-1", provider_id: "prov-1", service_id: "svc-1", customer_id: "c1", starts_at: startsAt,
  ends_at: new Date(Date.parse(startsAt) + 30 * 60_000).toISOString(), status: "confirmed", source: "web", notes: null,
  provider_name: "Dra. Lopez", service_name: "Consulta general", customer_name: nombre, customer_phone: "5522223333",
});

function stub(citas: unknown[], resumenOk = true) {
  const fm = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (url.includes("/resumen")) {
      if (!resumenOk) throw new Error("sin resumen");
      return json(RESUMEN);
    }
    if (url.includes("/providers")) return json({ providers: [{ id: "prov-1", propertyId: "prop-1", displayName: "Dra. Lopez", roleLabel: "x", isActive: true }] });
    if (url.includes("/services") && !url.includes("appointments")) return json({ services: [{ id: "svc-1", name: "Consulta general", durationMinutes: 30, bufferMinutesBefore: 0, bufferMinutesAfter: 0, priceCents: 1, isActive: true }] });
    if (url.includes("/waitlist")) return json({ waitlist: [] });
    if (method === "GET" && url.includes("/appointments")) return json({ appointments: citas });
    if (method === "POST" && /\/appointments$/.test(url)) return json({ appointment: cita("nueva", "2026-10-21T16:00:00.000Z", "Nueva") });
    throw new Error(`fetch inesperado: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fm);
  return fm;
}
async function esperar() {
  await act(async () => {
    for (let i = 0; i < 6; i += 1) await flushMicrotasks();
  });
}
let tzPrevia: string | undefined;
beforeEach(() => {
  tzPrevia = process.env.TZ;
  process.env.TZ = "America/Tijuana";
});
afterEach(() => {
  if (tzPrevia === undefined) delete process.env.TZ;
  else process.env.TZ = tzPrevia;
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Agenda en la zona del negocio", () => {
  it("la cita de las 19:30 de Merida y la de las 09:00 del dia siguiente van en secciones de dias distintos, con su hora local", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-21T14:00:00.000Z"));
    stub([cita("a", "2026-10-21T01:30:00.000Z", "Cita Nocturna"), cita("b", "2026-10-21T15:00:00.000Z", "Cita Matutina")]);
    rendered = renderComponent(<AgendaPage {...CTX} />);
    await esperar();
    const secciones = [...rendered.container.querySelectorAll("section")].filter((s) => s.querySelector("h2"));
    const texto = secciones.map((s) => s.textContent ?? "");
    const noche = texto.find((t) => t.includes("Cita Nocturna"))!;
    const manana = texto.find((t) => t.includes("Cita Matutina"))!;
    expect(noche).toContain("martes"); // 20-oct-2026 es martes
    expect(manana).toContain("miércoles"); // 21-oct-2026
    expect(noche).not.toContain("Cita Matutina");
    expect(noche).toContain("07:30 p.m.");
    expect(manana).toContain("09:00 a.m.");
  });

  it("Nueva cita: la hora capturada se interpreta en la zona del negocio (10:00 Merida = 16:00Z)", async () => {
    const fm = stub([]);
    rendered = renderComponent(<AgendaPage {...CTX} />);
    await esperar();
    const nuevaBtn = [...rendered.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Nueva cita"))!;
    await act(async () => {
      nuevaBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    const root = document.body;
    changeValue(root.querySelector("#citas-nueva-proveedor") as HTMLSelectElement, "prov-1");
    changeValue(root.querySelector("#citas-nueva-servicio") as HTMLSelectElement, "svc-1");
    changeValue(root.querySelector("#citas-nueva-inicio") as HTMLInputElement, "2026-10-21T10:00");
    changeValue(root.querySelector("#citas-nueva-cliente") as HTMLInputElement, "Hora Del Negocio");
    changeValue(root.querySelector("#citas-nueva-telefono") as HTMLInputElement, "5533334444");
    await submitForm(root.querySelector("#citas-nueva-cita") as HTMLFormElement);
    await esperar();
    const call = fm.mock.calls.find(([url, init]) => /\/appointments$/.test(url) && init?.method === "POST");
    expect(JSON.parse(call![1]!.body as string).starts_at).toBe("2026-10-21T16:00:00.000Z");
  });

  it("el rango del mes se pide de medianoche a medianoche del negocio (06:00Z), no de 00:00Z", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-21T14:00:00.000Z"));
    const fm = stub([]);
    rendered = renderComponent(<AgendaPage {...CTX} />);
    await esperar();
    const url = new URL(fm.mock.calls.map(([u]) => u as string).find((u) => u.includes("/appointments"))!);
    expect(url.searchParams.get("from")).toBe("2026-10-01T06:00:00.000Z");
    expect(url.searchParams.get("to")).toBe("2026-11-01T06:00:00.000Z");
  });

  it("si el resumen no responde, la agenda igual carga (zona por omision de la plataforma) y no se queda colgada", async () => {
    stub([cita("a", "2026-10-21T15:00:00.000Z", "Cita X")], false);
    rendered = renderComponent(<AgendaPage {...CTX} />);
    await esperar();
    expect(rendered.container.textContent).toContain("Cita X");
  });
});
