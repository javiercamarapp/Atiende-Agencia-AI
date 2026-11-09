// @vitest-environment jsdom
//
// i18n ES/EN — citas, segundo grupo (Servicios, Staff, Disponibilidad y Avisos). Con la consola en espanol el DOM es identico al de
// sin proveedor; con EN (diseno ds3) cada pantalla sale en ingles natural, sin claves crudas, y los datos del negocio (servicio,
// proveedor, correos, palabra clave de la escalacion) quedan tal cual.
import { act } from "react";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { IdiomaProvider, cargarIdioma } from "@atiende/ui";
import { fijarIdiomaActivo } from "../../../packages/ui/src/i18n/activo.ts";
import { ServicioFichaPage, ServiciosListPage } from "../src/verticals/citas/pages/Servicios.tsx";
import { StaffPage } from "../src/verticals/citas/pages/Staff.tsx";
import { DisponibilidadPage } from "../src/verticals/citas/pages/Disponibilidad.tsx";
import { AvisosPage } from "../src/verticals/citas/pages/Avisos.tsx";
import type { CitasShellContext } from "../src/verticals/citas/CitasShell.tsx";
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

const SERVICIO = { id: "svc-1", name: "Consulta general", duration_minutes: 30, buffer_minutes_before: 5, buffer_minutes_after: 10, price_cents: 50000, is_active: true };
const PROVEEDOR = { id: "prov-1", property_id: "prop-1", display_name: "Dra. López", role_label: "Doctora", is_active: true };
const SIN_CAL = { connected: false, sync_status: "disconnected", sync_error: null };
const DETALLE = {
  provider: PROVEEDOR,
  availability_rules: [
    { id: "r-1", day_of_week: 1, start_time: "09:00:00", end_time: "14:00:00", is_active: true },
    { id: "r-2", day_of_week: 2, start_time: "16:00:00", end_time: "19:00:00", is_active: false },
  ],
  google_calendar: SIN_CAL,
  calcom: { ...SIN_CAL, calcom_event_type_id: null, calcom_base_url: null },
  caldav: { ...SIN_CAL, calendar_collection_url: null, username: null },
  offered_service_ids: [],
};
const EXCEPCION = { override_date: "2026-12-24", is_closed: true, start_time: null, end_time: null, reason: "Nochebuena" };
const INVITACION = { id: "inv-1", email: "nuevo@example.com", verticalRole: "admin", propertyIds: null, status: "pending", expiresAt: "2026-09-25T00:00:00.000Z", createdAt: "2026-09-18T00:00:00.000Z" };
const MIEMBRO = { id: "user-1", email: "ana@example.com", fullName: "Ana Pérez", verticalRole: "staff", propertyIds: null };
const AVISOS = {
  generadoEn: "2026-10-01T12:00:00.000Z",
  porConfirmar: { horas: 72, total: 3, items: [{ id: "c-1", iniciaEn: "2026-10-02T15:00:00.000Z", proveedor: "Dra. Lupita", servicio: "Consulta general", origen: "whatsapp" }] },
  recordatorios: { visible: true, disponible: true, ventanaDias: 7, filas: [{ canal: "whatsapp", estado: "dead", total: 2 }, { canal: "email", estado: "sent", total: 9 }] },
  escalaciones: { visible: true, disponible: true, seguimientoDisponible: true, items: [{ id: "e-1", canal: "voice", palabraClave: "crisis", telefono: "***4567", creadaEn: "2026-10-01T10:00:00.000Z", seguimiento: "pending", seguimientoEn: null, nota: "Llamar mañana" }] },
};

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
      if (u.endsWith("/admin/avisos")) return json(AVISOS);
      if (u.endsWith("/admin/staff/invitaciones")) return json({ invitations: [INVITACION] });
      if (u.endsWith("/admin/staff/miembros")) return json({ miembros: [MIEMBRO] });
      if (u.endsWith("/services/svc-1")) return json({ service: SERVICIO });
      if (u.endsWith("/services")) return json({ services: [SERVICIO] });
      if (u.endsWith("/providers/prov-1/availability-overrides") || u.includes("/availability-overrides?")) return json({ availability_overrides: [EXCEPCION] });
      if (u.endsWith("/providers/prov-1")) return json(DETALLE);
      if (u.endsWith("/providers")) return json({ providers: [PROVEEDOR] });
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

const CLAVE_CRUDA = /\bcitas\.[a-z]+[.A-Za-z0-9_]*/;

async function enIngles(el: ReactElement, en: readonly string[], es: readonly string[], datos: readonly string[]): Promise<void> {
  const c = await montar(<IdiomaProvider idiomaInicial="en">{el}</IdiomaProvider>);
  const texto = c.textContent ?? "";
  for (const t of en) expect(texto, t).toContain(t);
  for (const t of es) expect(texto, t).not.toContain(t);
  for (const t of datos) expect(texto, t).toContain(t);
  expect(c.innerHTML).not.toMatch(CLAVE_CRUDA);
  rendered?.unmount();
  rendered = undefined;
}

describe("Servicios de citas ES/EN", () => {
  it("en espanol el DOM es identico con y sin IdiomaProvider (lista y ficha)", async () => {
    expect(await esIgualConProveedor(<ServiciosListPage {...CTX} />)).toContain("30 min · $500.00");
    expect(await esIgualConProveedor(<ServicioFichaPage {...CTX} serviceId="svc-1" />)).toContain("Colchón después");
  });

  it("en ingles sale en ingles", async () => {
    await enIngles(<ServiciosListPage {...CTX} />, ["Services", "New service", "Create service", "Duration (min)", "30 min"], ["Nuevo servicio", "Crear servicio"], ["Consulta general"]);
    await enIngles(<ServicioFichaPage {...CTX} serviceId="svc-1" />, ["Back to services", "Edit service", "Buffer before", "Buffer after", "Price", "Active", "10 min"], ["Colchón", "Precio", "Activo"], ["Consulta general"]);
  });
});

describe("Staff de citas ES/EN", () => {
  it("en espanol el DOM es identico con y sin IdiomaProvider", async () => {
    const html = await esIgualConProveedor(<StaffPage {...CTX} />);
    expect(html).toContain("Invitaciones pendientes");
    expect(html).toContain("Administrador/a");
  });

  it("en ingles sale en ingles (y el aviso sin permiso tambien)", async () => {
    await enIngles(<StaffPage {...CTX} />, ["Invite someone new", "Pending invitations", "Administrator", "Pending", "Revoke", "Active staff", "expires "], ["Invitaciones", "Administrador/a", "Revocar", "expira "], ["nuevo@example.com", "Ana Pérez"]);
    await enIngles(<StaffPage {...CTX} role="staff" />, ["With your current role (staff) you can't manage"], ["Con tu rol actual"], []);
  });
});

describe("Disponibilidad de citas ES/EN", () => {
  it("en espanol el DOM es identico con y sin IdiomaProvider", async () => {
    const html = await esIgualConProveedor(<DisponibilidadPage {...CTX} />);
    expect(html).toContain("Horario semanal");
    expect(html).toContain("Miércoles");
  });

  it("en ingles sale en ingles y los dias tambien", async () => {
    await enIngles(<DisponibilidadPage {...CTX} />, ["Availability", "Weekly hours", "Monday", "Wednesday", "Closed", "inactive", "Add hours", "Exceptions (specific days)", "Closed all day", "Save exception"], ["Horario semanal", "Lunes", "Cerrado", "Agregar horario"], ["Dra. López", "Nochebuena", "09:00 – 14:00"]);
  });
});

describe("Avisos de citas ES/EN", () => {
  it("en espanol el DOM es identico con y sin IdiomaProvider", async () => {
    const html = await esIgualConProveedor(<AvisosPage {...CTX} />);
    expect(html).toContain("Próximas 72 h · 3");
    expect(html).toContain("Y 2 más en la agenda.");
    expect(html).toContain("1 registradas · 1 sin seguimiento");
  });

  it("en ingles sale en ingles", async () => {
    await enIngles(
      <AvisosPage {...CTX} />,
      ["Appointments to confirm", "Next 72 h · 3", "And 2 more in the schedule.", "24-hour reminders", "Out of retries", "Sent", "Email", "Crisis escalations", "1 logged · 1 without follow-up", "No follow-up", "Voice", "Take follow-up", "Mark resolved", "Note: Llamar mañana"],
      ["Citas por confirmar", "Recordatorios", "Escalaciones", "Tomar seguimiento"],
      ["Consulta general", "Dra. Lupita", "crisis", "***4567"],
    );
  });
});
