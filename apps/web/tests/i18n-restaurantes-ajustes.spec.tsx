// @vitest-environment jsdom
//
// i18n ES/EN — restaurantes: configuracion, primeros pasos, puerta de onboarding y probador de WhatsApp. En espanol el DOM es identico
// con y sin IdiomaProvider; en ingles sale en ingles natural, sin claves crudas.
import type { ReactElement } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { IdiomaProvider, cargarIdioma } from "@atiende/ui";
import { fijarIdiomaActivo } from "../../../packages/ui/src/i18n/activo.ts";
import { ConfiguracionPage } from "../src/verticals/restaurantes/pages/Configuracion.tsx";
import type { RestaurantesShellContext } from "../src/verticals/restaurantes/RestaurantesShell.tsx";
import { TarjetaPedidoSimulado } from "../src/verticals/restaurantes/preview/TarjetaPedidoSimulado.tsx";
import { WidgetWhatsApp } from "../src/verticals/restaurantes/preview/WidgetWhatsApp.tsx";
import { agruparMensajes } from "../src/verticals/restaurantes/preview/agrupar-mensajes.ts";
import { ESTADO_LABEL, RESPONSABLE_LABEL } from "../src/verticals/restaurantes/lib/onboarding-client.ts";
import type { PedidoSimulado } from "../src/verticals/restaurantes/lib/voz-client.ts";
import { renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;

const CTX: RestaurantesShellContext = {
  apiBaseUrl: "https://api.test",
  token: "tok",
  propertyId: "prop-1",
  orgSlug: "demo",
  role: "staff",
  staffFullName: "Sam",
  staffEmail: "sam@example.com",
};

const PEDIDO = { folio: "PRUEBA-0007", sucursal: "Centro", total: 180, renglones: [{ nombre: "Tacos al pastor", cantidad: 2, precio: 90 }] } as unknown as PedidoSimulado;

beforeAll(() => cargarIdioma("en"));
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }) as unknown as Response));
});
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
  fijarIdiomaActivo("es");
  delete document.documentElement.dataset.diseno;
  document.body.innerHTML = "";
});

function html(el: ReactElement): string {
  rendered = renderComponent(el);
  const h = document.body.innerHTML;
  rendered.unmount();
  rendered = undefined;
  document.body.innerHTML = "";
  return h;
}

const pantallas = (): ReadonlyArray<readonly [string, ReactElement]> => [
  ["configuracion (sin permiso)", <ConfiguracionPage key="c" {...CTX} />],
  ["tarjeta del pedido simulado", <TarjetaPedidoSimulado key="t" pedido={PEDIDO} />],
  ["globo del probador", <WidgetWhatsApp key="w" apiBaseUrl="https://api.test" token="tok" propertyId="prop-1" />],
];

describe("ajustes ES/EN", () => {
  for (const [nombre, el] of pantallas()) {
    it(`${nombre}: en espanol el DOM es identico con y sin IdiomaProvider`, () => {
      expect(html(<IdiomaProvider idiomaInicial="es">{el}</IdiomaProvider>)).toBe(html(el));
    });
  }

  it("en ingles", () => {
    document.documentElement.dataset.diseno = "ds3";
    const textos = pantallas().map(([, el]) => {
      rendered = renderComponent(<IdiomaProvider idiomaInicial="en">{el}</IdiomaProvider>);
      const t = document.body.textContent ?? "";
      expect(document.body.innerHTML).not.toMatch(/\brestaurantes\.[a-z]+\.[A-Za-z0-9.]+/);
      rendered.unmount();
      rendered = undefined;
      document.body.innerHTML = "";
      return t;
    });
    expect(textos[0]).toContain("Editing WhatsApp settings and known areas is limited to owners and admins. Your current role is “staff”.");
    expect(textos[1]).toContain("Simulated order PRUEBA-0007");
    expect(textos[1]).toContain("Server total");
    expect(textos[1]).toContain("Tacos al pastor");
    expect(textos[2]).toContain("Try a conversation");
  });
});

describe("etiquetas de lib/", () => {
  it("espanol de siempre e ingles con el idioma activo", () => {
    expect(ESTADO_LABEL.externo).toBe("Depende de un tercero");
    expect(RESPONSABLE_LABEL.dueno).toBe("Dueño");
    const ahora = new Date("2026-10-02T18:00:00Z");
    expect(agruparMensajes([{ rol: "cliente", hora: ahora }], "America/Mexico_City", ahora)[0]?.separador).toBe("Hoy");
    fijarIdiomaActivo("en");
    expect(ESTADO_LABEL.hecho).toBe("Done");
    expect(RESPONSABLE_LABEL.distribuidor_pos).toBe("POS distributor");
    expect(agruparMensajes([{ rol: "cliente", hora: ahora }], "America/Mexico_City", ahora)[0]?.separador).toBe("Today");
  });
});
