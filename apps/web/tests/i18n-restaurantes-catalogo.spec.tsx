// @vitest-environment jsdom
//
// i18n ES/EN — restaurantes: catalogo, sucursales y marketing. Con la consola en espanol el DOM es identico con y sin IdiomaProvider
// (nadie que no elija EN ve un byte distinto); con EN (diseno ds3) Productos, Sucursales y Promociones salen en ingles natural, sin
// claves crudas, y los datos del negocio (productos, categorias, sucursales, codigos) quedan tal cual. Las etiquetas de lib/ siguen al
// idioma activo.
import { act } from "react";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { IdiomaProvider, cargarIdioma } from "@atiende/ui";
import { fijarIdiomaActivo } from "../../../packages/ui/src/i18n/activo.ts";
import { ProductosPage } from "../src/verticals/restaurantes/pages/Productos.tsx";
import { SucursalesPage } from "../src/verticals/restaurantes/pages/Sucursales.tsx";
import { PromocionesPage } from "../src/verticals/restaurantes/pages/Promociones.tsx";
import type { RestaurantesShellContext } from "../src/verticals/restaurantes/RestaurantesShell.tsx";
import { ETIQUETA_MOTIVO_COLONIA, NOMBRES_DIAS, describirTurno } from "../src/verticals/restaurantes/lib/modelo-pm-client.ts";
import { ETIQUETA_SEGMENTO } from "../src/verticals/restaurantes/lib/marketing-client.ts";
import { validarPar } from "../src/verticals/restaurantes/lib/coordenadas.ts";
import { flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
const BASE = "https://api.test/v1/restaurantes/prop-1/admin";
const CTX: RestaurantesShellContext = { apiBaseUrl: "https://api.test", token: "tok", propertyId: "prop-1", orgSlug: "demo", role: "owner", staffFullName: "G", staffEmail: "g@example.com" };

const CATEGORIAS = [{ id: "c1", name: "Cervezas", slug: "cervezas", displayOrder: 0 }];
const PRODUCTOS = [
  { id: "p1", categoryId: "c1", categoryName: "Cervezas", name: "Sol", description: null, price: 66, imageUrl: null, isPopular: false, isAvailable: true, displayOrder: 0, searchKeywords: [], branch: { propertyId: "prop-1", productId: "p1", price: 66, isAvailable: true } },
  { id: "p2", categoryId: null, categoryName: null, name: "Taco", description: null, price: 42, imageUrl: null, isPopular: false, isAvailable: true, displayOrder: 1, searchKeywords: [], branch: null },
];
const SUCURSALES = [
  { propertyId: "prop-1", name: "Sucursal Centro", slug: "centro", status: "active", phone: "5511112222", address: "Av. Reforma 123", lat: 19.43, lng: -99.13 },
  { propertyId: "prop-2", name: "Sucursal Norte", slug: "norte", status: "active", phone: null, address: null, lat: null, lng: null },
];
const PROMO = {
  id: "promo-1",
  code: "BIENVENIDA10",
  name: "Bienvenida 10%",
  description: null,
  type: "percentage",
  value: 10,
  minOrderTotal: 200,
  startsAt: null,
  endsAt: null,
  daysOfWeek: [1, 2, 3],
  startTime: null,
  endTime: null,
  maxUses: 100,
  timesUsed: 37,
  isActive: true,
  createdAt: "2026-08-25T10:00:00.000Z",
  updatedAt: "2026-08-25T10:00:00.000Z",
};

const json = (body: unknown, ok = true) => ({ ok, status: ok ? 200 : 503, json: async () => body }) as unknown as Response;

beforeAll(() => cargarIdioma("en"));

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
  document.documentElement.dataset.diseno = "ds3";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === `${BASE}/categories`) return json({ categories: CATEGORIAS });
      if (url === `${BASE}/products`) return json({ products: PRODUCTOS });
      if (url === `${BASE}/config/no-domicilio`) return json({ productIds: [], categoryIds: [] });
      if (url === `${BASE}/sucursales`) return json({ branches: SUCURSALES });
      if (url === `${BASE}/promotions`) return json({ promotions: [PROMO] });
      return json({ message: "sin respuesta simulada" }, false);
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
    for (let i = 0; i < 5; i++) await flushMicrotasks();
  });
  return rendered.container;
}

async function htmlDe(el: ReactElement): Promise<string> {
  const c = await montar(el);
  const html = c.innerHTML;
  rendered?.unmount();
  rendered = undefined;
  return html;
}

const CLAVE_CRUDA = /\brestaurantes\.[a-z]+\.[A-Za-z0-9.]+/;
const PANTALLAS: ReadonlyArray<{ readonly nombre: string; readonly el: () => ReactElement; readonly es: readonly string[]; readonly en: readonly string[]; readonly datos: readonly string[] }> = [
  { nombre: "Productos", el: () => <ProductosPage {...CTX} />, es: ["Nueva categoría", "Catálogo", "Agotado hasta mañana"], en: ["New category", "Catalog", "Sold out until tomorrow", "Price at this branch"], datos: ["Sol", "Taco", "Cervezas"] },
  { nombre: "Sucursales", el: () => <SucursalesPage {...CTX} />, es: ["Plan y uso", "Sin coordenadas", "Reglas de pedido"], en: ["Plan and usage", "No coordinates", "Order rules", "Active"], datos: ["Sucursal Centro", "Av. Reforma 123"] },
  { nombre: "Promociones", el: () => <PromocionesPage {...CTX} />, es: ["Códigos existentes", "Editar vigencia", "Desactivar"], en: ["Existing codes", "Edit validity", "Deactivate", "10% off", "used 37/100"], datos: ["BIENVENIDA10", "Bienvenida 10%"] },
];

describe("catalogo, sucursales y marketing ES/EN", () => {
  for (const p of PANTALLAS) {
    it(`${p.nombre}: en espanol el DOM es identico con y sin IdiomaProvider`, async () => {
      const sin = await htmlDe(p.el());
      const con = await htmlDe(<IdiomaProvider idiomaInicial="es">{p.el()}</IdiomaProvider>);
      expect(con).toBe(sin);
      for (const es of p.es) expect(sin, es).toContain(es);
    });

    it(`${p.nombre}: en ingles sale en ingles y los datos del negocio quedan tal cual`, async () => {
      const c = await montar(<IdiomaProvider idiomaInicial="en">{p.el()}</IdiomaProvider>);
      const texto = c.textContent ?? "";
      for (const en of p.en) expect(texto, en).toContain(en);
      for (const es of p.es) expect(texto, es).not.toContain(es);
      for (const dato of p.datos) expect(texto, dato).toContain(dato);
      expect(c.innerHTML).not.toMatch(CLAVE_CRUDA);
    });
  }
});

describe("etiquetas de lib/ (traducen al idioma activo)", () => {
  it("en espanol son los textos de siempre", () => {
    expect([...NOMBRES_DIAS]).toEqual(["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"]);
    expect(describirTurno({ dias: [1, 5], abre: "12:00", cierra: "01:00", ultimoPedidoDomicilio: "00:30" })).toBe("Lun, Vie 12:00 a 01:00 (cierra al día siguiente); último pedido a domicilio 00:30");
    expect(ETIQUETA_MOTIVO_COLONIA.ambigua).toBe("Las dos sucursales más cercanas quedan a menos de 1 km");
    expect(ETIQUETA_SEGMENTO.inactivo_30).toBe("30 a 59 días sin pedir");
    expect(validarPar("99", "").errorLat).toBe("La latitud debe estar entre 14.5 y 32.8 (México). ¿Invertiste latitud y longitud?");
  });

  it("en ingles siguen al idioma activo", () => {
    fijarIdiomaActivo("en");
    expect(NOMBRES_DIAS[0]).toBe("Sun");
    expect(describirTurno({ dias: [0, 1, 2, 3, 4, 5, 6], abre: "12:00", cierra: "16:00" })).toBe("Every day 12:00 to 16:00");
    expect(ETIQUETA_SEGMENTO.inactivo_90).toBe("90+ days without ordering");
    expect(validarPar("21.0", "").errorLng).toBe("Longitude is missing: the location needs both latitude and longitude.");
  });
});
