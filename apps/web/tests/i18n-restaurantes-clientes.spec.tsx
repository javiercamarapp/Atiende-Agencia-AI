// @vitest-environment jsdom
//
// i18n ES/EN — restaurantes: clientes y equipo. Con la consola en espanol el DOM es identico al de sin proveedor; con EN (diseno ds3)
// Clientes y Staff salen en ingles, sin claves crudas, y los datos del cliente (nombres, telefonos) quedan tal cual. Las etiquetas que
// arman los lib/ (tipo de gusto, campos de importacion, vehiculo, disponibilidad, validaciones) siguen al idioma activo.
import { act } from "react";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { IdiomaProvider, cargarIdioma } from "@atiende/ui";
import { fijarIdiomaActivo } from "../../../packages/ui/src/i18n/activo.ts";
import { ClientesListPage } from "../src/verticals/restaurantes/pages/Clientes.tsx";
import { StaffPage } from "../src/verticals/restaurantes/pages/Staff.tsx";
import type { RestaurantesShellContext } from "../src/verticals/restaurantes/RestaurantesShell.tsx";
import { ETIQUETA_TIPO_GUSTO } from "../src/verticals/restaurantes/lib/customers-client.ts";
import { ETIQUETA_CAMPO } from "../src/verticals/restaurantes/lib/clientes-importacion.ts";
import { DISPONIBILIDAD_ETIQUETAS, PERFIL_FORM_VACIO, VEHICULO_ETIQUETAS, validarPerfilForm } from "../src/verticals/restaurantes/lib/repartidor-perfil-client.ts";
import { flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
const CTX: RestaurantesShellContext = { apiBaseUrl: "https://api.test", token: "tok", propertyId: "prop-1", orgSlug: "demo", role: "owner", staffFullName: "Ana", staffEmail: "ana@example.com" };
const CLIENTES = [
  { id: "c1", name: "Ana Torres", phone: "9991230001", orderCount: 5, tier: "BLACK", lastOrderAt: "2026-01-01T00:00:00.000Z" },
  { id: "c2", name: null, phone: "9991230002", orderCount: 1, tier: null, lastOrderAt: null },
];
const KPIS = { disponible: true, total: 11, recurrentes: 4, ticketPromedio: 250.5, masFrecuente: { nombre: "Ana Torres", telefonoEnmascarado: "******0001", pedidos: 5, diasDesdeUltimoPedido: 2 } };
const TIERS = { metric: "gasto", BLACK: 1, PLATINUM: 2, GOLD: 3, BLUE: 4, withoutTier: 1 };

function json(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
}

beforeAll(() => cargarIdioma("en"));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-01-03T12:00:00Z") });
  document.documentElement.dataset.diseno = "ds3";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.endsWith("/admin/customers/kpis")) return json(KPIS);
      if (url.endsWith("/admin/kpis/customers")) return json({ tierDistribution: TIERS });
      if (url.endsWith("/admin/branches")) return json({ branches: [] });
      if (url.includes("/admin/customers")) return json({ customers: CLIENTES, nextCursor: null, filtrosDisponibles: true });
      if (url.includes("/staff/repartidores")) return json({ repartidores: [{ id: "r1", fullName: "Beto Ruiz", email: "beto@example.com" }] });
      if (url.includes("/staff/invitaciones")) return json({ invitations: [] });
      if (url.includes("/staff/miembros")) return json({ miembros: [{ id: "m1", fullName: "Carla Paz", email: "carla@example.com", verticalRole: "staff" }] });
      return json({ error: "sin respuesta simulada" }, 404);
    }),
  );
});

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
  vi.useRealTimers();
  fijarIdiomaActivo("es");
  delete document.documentElement.dataset.diseno;
  document.body.innerHTML = "";
});

async function montar(el: ReactElement): Promise<HTMLElement> {
  rendered = renderComponent(<MemoryRouter>{el}</MemoryRouter>);
  await act(async () => {
    for (let i = 0; i < 10; i++) await flushMicrotasks();
  });
  return rendered.container;
}

async function htmlDe(el: ReactElement): Promise<string> {
  // Los ids de React/Radix (useId: «:r6:») dependen del orden de montaje, no del idioma.
  const html = (await montar(el)).innerHTML.replace(/:r[0-9a-z]+:/g, ":id:");
  rendered?.unmount();
  rendered = undefined;
  return html;
}

const CLAVE_CRUDA = /\brestaurantes\.[a-z]+\.[A-Za-z0-9.]+/;

describe("Clientes y Staff ES/EN", () => {
  for (const [nombre, pagina] of [
    ["Clientes", () => <ClientesListPage {...CTX} />],
    ["Staff", () => <StaffPage {...CTX} />],
  ] as const) {
    it(`${nombre}: en espanol el DOM es identico con y sin IdiomaProvider`, async () => {
      const sin = await htmlDe(pagina());
      const con = await htmlDe(<IdiomaProvider idiomaInicial="es">{pagina()}</IdiomaProvider>);
      expect(con).toBe(sin);
    });
  }

  it("Clientes en ingles: textos de la pagina en ingles, datos del cliente tal cual", async () => {
    const c = await montar(
      <IdiomaProvider idiomaInicial="en">
        <ClientesListPage {...CTX} />
      </IdiomaProvider>,
    );
    const texto = c.textContent ?? "";
    for (const en of ["Most frequent customer", "Entire customer base", "Import customers", "2 customers in total", "5 orders", "hasn't ordered yet"]) expect(texto, en).toContain(en);
    for (const es of ["Cliente más frecuente", "Importar clientes", "en total", "aún no ha pedido", "Cualquier momento"]) expect(texto, es).not.toContain(es);
    expect(texto).toContain("Ana Torres");
    expect(c.innerHTML).not.toMatch(CLAVE_CRUDA);
  });

  it("Staff en ingles: roles, secciones y botones en ingles", async () => {
    const c = await montar(
      <IdiomaProvider idiomaInicial="en">
        <StaffPage {...CTX} />
      </IdiomaProvider>,
    );
    const texto = c.textContent ?? "";
    for (const en of ["Invite someone", "Active team", "Active drivers", "Remove", "Staff (management)"]) expect(texto, en).toContain(en);
    for (const es of ["Invitar a alguien", "Staff activo", "Repartidores activos", "Dar de baja"]) expect(texto, es).not.toContain(es);
    expect(texto).toContain("Beto Ruiz");
    expect(c.innerHTML).not.toMatch(CLAVE_CRUDA);
  });
});

describe("etiquetas de lib/ (idioma activo)", () => {
  it("en espanol son las de siempre", () => {
    expect(ETIQUETA_TIPO_GUSTO.omision).toBe("Sin (omite)");
    expect(Object.keys(ETIQUETA_TIPO_GUSTO)).toEqual(["tortilla", "salsa", "omision", "nota", "pago", "propina", "canal", "sucursal"]);
    expect(ETIQUETA_CAMPO.telefono).toBe("Teléfono");
    expect(VEHICULO_ETIQUETAS.a_pie).toBe("A pie");
    expect(DISPONIBILIDAD_ETIQUETAS.en_descanso).toBe("En descanso");
    expect(validarPerfilForm({ ...PERFIL_FORM_VACIO, licenciaNumero: "X1" }).licenciaVigencia).toBe("Indica hasta cuándo es válida la licencia.");
  });

  it("en ingles siguen al idioma activo", () => {
    fijarIdiomaActivo("en");
    expect(ETIQUETA_TIPO_GUSTO.omision).toBe("Without (leave out)");
    expect(ETIQUETA_CAMPO.direccion).toBe("Address");
    expect(VEHICULO_ETIQUETAS.moto).toBe("Motorcycle");
    expect(DISPONIBILIDAD_ETIQUETAS.fuera_de_turno).toBe("Off shift");
    expect(validarPerfilForm({ ...PERFIL_FORM_VACIO, licenciaNumero: "X1" }).licenciaVigencia).toBe("Enter the license expiration date.");
  });
});
