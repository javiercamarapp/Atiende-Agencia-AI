// @vitest-environment jsdom
//
// i18n ES/EN — citas (Resumen, Agenda y Clientes). Con la consola en espanol el DOM es identico al de sin proveedor (nadie que no
// elija EN ve un byte distinto); con EN (diseno ds3) las pantallas salen en ingles natural, sin claves crudas, y los datos del
// negocio (cliente, proveedor, servicio) quedan tal cual.
import { act } from "react";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { IdiomaProvider, cargarIdioma } from "@atiende/ui";
import { fijarIdiomaActivo } from "../../../packages/ui/src/i18n/activo.ts";
import { ResumenPage } from "../src/verticals/citas/pages/Resumen.tsx";
import { AgendaPage } from "../src/verticals/citas/pages/Agenda.tsx";
import { ClienteFichaPage, ClientesListPage } from "../src/verticals/citas/pages/Clientes.tsx";
import type { CitasShellContext } from "../src/verticals/citas/CitasShell.tsx";
import {
  STATUS_LABELS,
  formatAppointmentSource,
  formatAppointmentStatus,
  formatDayOfWeek,
  formatGoogleSyncStatus,
  formatMoneyFromCents,
  saludoTraducido,
} from "../src/verticals/citas/lib/format.ts";
import { formatDiaNegocio } from "../src/verticals/citas/lib/resumen-client.ts";
import { flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;

const CTX: CitasShellContext = {
  apiBaseUrl: "https://api.test",
  token: "tok-123",
  propertyId: "prop-1",
  orgSlug: "demo",
  orgId: "org-1",
  role: "owner",
  staffFullName: "Sam Torres",
  staffEmail: "sam@example.com",
};

const RESUMEN = {
  timezone: "America/Merida",
  generated_at: "2026-09-30T05:00:00.000Z",
  today: { date: "2026-09-29", total: 3, by_status: { pending: 1, confirmed: 2, completed: 0, cancelled: 1, no_show: 0 } },
  week: { from_date: "2026-09-28", to_date: "2026-10-04", total: 19, by_status: { pending: 2, confirmed: 5, completed: 2, cancelled: 1, no_show: 0 } },
  pending_to_confirm: 4,
  no_shows_last_30_days: 2,
  new_customers_last_30_days: 7,
  created_by_source_last_30_days: { voice: 1, whatsapp: 23, web: 4, manual: 1 },
};

const AVISOS = {
  generadoEn: "2026-09-30T05:00:00.000Z",
  porConfirmar: { horas: 72, total: 0, items: [] },
  recordatorios: { visible: true, disponible: true, ventanaDias: 7, filas: [{ canal: "whatsapp", estado: "sent", total: 11 }, { canal: "whatsapp", estado: "failed", total: 1 }] },
  escalaciones: { visible: true, disponible: true, seguimientoDisponible: true, items: [] },
};

const AGENTE = { disponible: true, agente: { version: 1, config: {}, actualizadoEn: null, promptDeMuestra: "" }, conexion: { numero: { phoneNumberId: "123", activo: true }, estado: "registrado", credencialDeEnvioDisponible: true, nota: "" }, opciones: {} };

const CITA = {
  id: "apt-1",
  property_id: "prop-1",
  provider_id: "prov-1",
  service_id: "svc-1",
  customer_id: "cust-1",
  starts_at: "2026-09-19T15:00:00.000Z",
  ends_at: "2026-09-19T15:30:00.000Z",
  status: "pending",
  source: "whatsapp",
  notes: null,
  provider_name: "Dra. López",
  service_name: "Consulta general",
  customer_name: "María Ruiz",
  customer_phone: "5522223333",
};

const ESPERA = {
  id: "wl-1",
  position: 1,
  customer_name: "Cliente en espera",
  customer_phone: "5511112222",
  provider_id: null,
  service_id: null,
  preferred_date_from: "2026-10-01",
  preferred_date_to: null,
  preferred_time_window: null,
  notified_count: 2,
  created_at: "2026-09-01T10:00:00.000Z",
};

const CLIENTE = { id: "cust-1", full_name: "María Ruiz", phone: "5522223333", email: null };

function json(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

beforeAll(() => cargarIdioma("en"));

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.dataset.diseno = "ds3";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.endsWith("/resumen")) return json(RESUMEN);
      if (u.endsWith("/admin/avisos")) return json(AVISOS);
      if (u.endsWith("/admin/whatsapp-agente")) return json(AGENTE);
      if (u.includes("/providers")) return json({ providers: [{ id: "prov-1", propertyId: "prop-1", displayName: "Dra. López", roleLabel: "Doctora", isActive: true }] });
      if (u.includes("/services")) return json({ services: [{ id: "svc-1", name: "Consulta general", durationMinutes: 30, bufferMinutesBefore: 0, bufferMinutesAfter: 0, priceCents: 50000, isActive: true }] });
      if (u.includes("/waitlist")) return json({ waitlist: [ESPERA] });
      if (u.includes("/appointments")) return json({ appointments: [CITA] });
      if (u.includes("/customers/cust-1")) return json({ customer: CLIENTE, upcoming_appointments: [CITA] });
      if (u.includes("/customers")) return json({ customers: [{ ...CLIENTE, email: "maria@example.com" }], total: 1, next_offset: null });
      return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
    }),
  );
});

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
  fijarIdiomaActivo("es");
  delete document.documentElement.dataset.diseno;
});

async function montar(el: ReactElement): Promise<HTMLElement> {
  rendered = renderComponent(<MemoryRouter>{el}</MemoryRouter>);
  await act(async () => {
    for (let i = 0; i < 6; i++) await flushMicrotasks();
  });
  return rendered.container;
}

async function htmlDe(el: ReactElement): Promise<string> {
  const c = await montar(el);
  // Los ids de `useId` (`:r3:`) dependen de cuantos componentes se montaron antes en el archivo: se normalizan.
  const html = c.innerHTML.replace(/:r[0-9a-z]+:/g, ":r:");
  rendered?.unmount();
  rendered = undefined;
  return html;
}

async function esIgualConProveedor(el: ReactElement): Promise<string> {
  const sin = await htmlDe(el);
  const con = await htmlDe(<IdiomaProvider idiomaInicial="es">{el}</IdiomaProvider>);
  expect(con).toBe(sin);
  return sin;
}

async function enIngles(el: ReactElement): Promise<HTMLElement> {
  return montar(<IdiomaProvider idiomaInicial="en">{el}</IdiomaProvider>);
}

const CLAVE_CRUDA = /\bcitas\.[a-z]+[.A-Za-z0-9_]*/;

function revisar(c: HTMLElement, en: readonly string[], es: readonly string[], datos: readonly string[]): void {
  const texto = c.textContent ?? "";
  for (const t of en) expect(texto, t).toContain(t);
  for (const t of es) expect(texto, t).not.toContain(t);
  for (const t of datos) expect(texto, t).toContain(t);
  expect(c.innerHTML).not.toMatch(CLAVE_CRUDA);
}

describe("Resumen de citas ES/EN", () => {
  it("en espanol el DOM es identico con y sin IdiomaProvider", async () => {
    const html = await esIgualConProveedor(<ResumenPage {...CTX} />);
    expect(html).toContain("3 citas hoy");
    expect(html).toContain("Orquestación de agentes");
    expect(html).toContain("23 citas creadas por WhatsApp (30 días)");
    expect(html).toContain("1 cita creada por voz (30 días)");
    expect(html).toContain("11 enviados · 1 fallido (7 días)");
  });

  it("en ingles sale en ingles, sin claves crudas", async () => {
    const c = await enIngles(<ResumenPage {...CTX} />);
    revisar(
      c,
      ["3 appointments today", "Appointments this week", "To confirm", "No-shows", "New customers", "View schedule", "Agent orchestration", "Connected", "23 appointments booked via WhatsApp (30 days)", "1 appointment booked by voice (30 days)", "11 sent · 1 failed (7 days)", "September 29"],
      ["citas hoy", "Clientes nuevos", "Ver agenda", "Orquestación", "septiembre"],
      ["Sam"],
    );
  });
});

describe("Agenda de citas ES/EN", () => {
  it("en espanol el DOM es identico con y sin IdiomaProvider", async () => {
    const html = await esIgualConProveedor(<AgendaPage {...CTX} />);
    expect(html).toContain("Lista de espera");
    expect(html).toContain("Todos los proveedores");
    expect(html).toContain("ya avisado 2x");
  });

  it("en ingles sale en ingles y los datos del negocio quedan tal cual", async () => {
    const c = await enIngles(<AgendaPage {...CTX} />);
    revisar(
      c,
      ["Schedule", "All providers", "Month", "Week", "Today", "New appointment", "Confirm", "Complete", "Mark no-show", "Cancel", "Pending", "WhatsApp (agent)", "Waitlist", "Notify the waitlist", "Provider filter: the same selector above (all providers).", "from 2026-10-01", "notified 2x"],
      ["Todos los proveedores", "Nueva cita", "Lista de espera", "Pendiente", "ya avisado"],
      ["Consulta general", "María Ruiz", "Dra. López", "Cliente en espera"],
    );
  });
});

describe("Clientes de citas ES/EN", () => {
  it("en espanol el DOM es identico con y sin IdiomaProvider (lista y ficha)", async () => {
    const lista = await esIgualConProveedor(<ClientesListPage {...CTX} />);
    expect(lista).toContain("1–1 de 1");
    const ficha = await esIgualConProveedor(<ClienteFichaPage {...CTX} customerId="cust-1" />);
    expect(ficha).toContain("Próximas citas");
  });

  it("en ingles sale en ingles", async () => {
    const c = await enIngles(<ClientesListPage {...CTX} />);
    revisar(c, ["Customers", "Contact", "1–1 of 1", "Previous", "Next"], ["Contacto", "Anterior", "Siguiente"], ["María Ruiz", "maria@example.com"]);
    rendered?.unmount();
    const f = await enIngles(<ClienteFichaPage {...CTX} customerId="cust-1" />);
    revisar(f, ["Back to customers", "Add email (to sync with Cal.com)", "Upcoming appointments"], ["Volver a clientes", "Próximas citas"], ["María Ruiz", "Consulta general", "Dra. López"]);
  });
});

describe("etiquetas de lib/ (traducen al idioma activo)", () => {
  it("en espanol son los textos de siempre", () => {
    expect(formatAppointmentStatus("no_show")).toBe("No se presentó");
    expect(formatAppointmentStatus("algo_nuevo")).toBe("algo_nuevo");
    expect(Object.keys(STATUS_LABELS)).toEqual(["pending", "confirmed", "completed", "cancelled", "no_show"]);
    expect(formatAppointmentSource("manual")).toBe("Manual");
    expect(formatGoogleSyncStatus("error")).toBe("Con problema de sincronización");
    expect(formatDayOfWeek(3)).toBe("Miércoles");
    expect(formatDayOfWeek(9)).toBe("Día 9");
    expect(formatMoneyFromCents(null)).toBe("Sin precio");
    expect(["Buenos días", "Buenas tardes", "Buenas noches"]).toContain(saludoTraducido());
    expect(formatDiaNegocio("2026-09-29")).toBe("martes, 29 de septiembre");
  });

  it("en ingles siguen al idioma activo", () => {
    fijarIdiomaActivo("en");
    expect(formatAppointmentStatus("no_show")).toBe("No-show");
    expect(formatAppointmentSource("voice")).toBe("Voice (agent)");
    expect(formatGoogleSyncStatus("invalid")).toBe("Not synced");
    expect(formatDayOfWeek(6)).toBe("Saturday");
    expect(formatMoneyFromCents(null)).toBe("No price");
    expect(saludoTraducido(new Date(2026, 9, 2, 9, 0))).toBe("Good morning");
    expect(formatDiaNegocio("2026-09-29")).toBe("Tuesday, September 29");
  });
});
