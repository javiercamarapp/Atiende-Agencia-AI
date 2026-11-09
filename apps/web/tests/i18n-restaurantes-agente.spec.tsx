// @vitest-environment jsdom
//
// i18n ES/EN — restaurantes, agente de WhatsApp (indicadores, conocimiento del negocio y etiquetas del editor). Con la consola en
// espanol el DOM es identico con y sin IdiomaProvider; con EN (diseno ds3) las pantallas salen en ingles, sin claves crudas, y los
// datos del negocio (titulos y textos del conocimiento, sucursales) quedan tal cual.
import { act } from "react";
import type { ReactElement } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { IdiomaProvider, cargarIdioma } from "@atiende/ui";
import { fijarIdiomaActivo } from "../../../packages/ui/src/i18n/activo.ts";
import { IndicadoresWhatsappPage } from "../src/verticals/restaurantes/pages/IndicadoresWhatsapp.tsx";
import { ConocimientoNegocio } from "../src/verticals/restaurantes/components/ConocimientoNegocio.tsx";
import { MOTIVO_LABEL, PERFIL_LABEL, TONO_LABEL, camposCambiados } from "../src/verticals/restaurantes/lib/agente-whatsapp-client.ts";
import { TIPO_CONOCIMIENTO_LABEL } from "../src/verticals/restaurantes/lib/conocimiento-client.ts";
import { flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";
import { prepararJsdomParaRadix } from "./test-utils/seleccionar.tsx";

let rendered: RenderedComponent | undefined;

const BASE = "https://api.test/v1/restaurantes/prop-1/admin";
const json = (body: unknown, status = 200): Response => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response;

const KPI = {
  disponible: true,
  zonaHoraria: "America/Mexico_City",
  hoy: "2026-03-10",
  desde: "2026-03-09",
  hasta: "2026-03-10",
  resumen: { dias: 2, conversaciones: 10, conversacionesConPedido: 4, conversacionesConHandoff: 1, conversionPct: 40, handoffPct: 10, pedidos: 5, handoffs: 2, pedidosOrg: 6, orgEsDemo: false, costoLlmOrgCentavosMxn: 1600, costoLlmPorPedidoCentavosMxn: 267 },
  serie: [{ fecha: "2026-03-10", conversaciones: 6, conversacionesConPedido: 3, conversionPct: 50, handoffPct: 0, pedidos: 4, handoffs: 1, pedidosOrg: 4, costoLlmOrgCentavosMxn: 1000, costoLlmPorPedidoCentavosMxn: 250 }],
};
const ENTRADA = { id: "k1", sucursalId: null, reemplazaId: null, titulo: "Estacionamiento", texto: "Hay estacionamiento gratuito para clientes.", tipo: "faq", prioridad: 50, vigenteDesde: null, vigenteHasta: null, activo: true, estado: "publicado", origen: "manual", version: 1, actualizadoEn: "2026-10-04T12:00:00Z" };
const BORRADOR = { ...ENTRADA, id: "k3", titulo: "Reservas", texto: "No tomamos reservaciones.", tipo: "politica", estado: "borrador", origen: "importado", vigenteDesde: "2026-10-06", vigenteHasta: "2026-10-08" };

beforeAll(async () => {
  prepararJsdomParaRadix();
  await cargarIdioma("en");
});

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
  document.documentElement.dataset.diseno = "ds3";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.startsWith(`${BASE}/whatsapp/kpi`)) return json(KPI);
      if (url === `${BASE}/sucursales`) return json({ branches: [{ propertyId: "prop-1", name: "Altabrisa", slug: "altabrisa", status: "active", phone: null, address: null, lat: null, lng: null }] });
      if (url.startsWith(`${BASE}/conocimiento`)) return json({ disponible: true, topeCaracteres: 6000, entradas: [ENTRADA, BORRADOR] });
      throw new Error(`sin respuesta simulada: ${url}`);
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
  rendered = renderComponent(el);
  await act(async () => {
    for (let i = 0; i < 6; i++) await flushMicrotasks();
  });
  return rendered.container;
}

async function htmlDe(el: ReactElement): Promise<string> {
  const c = await montar(el);
  // Los ids de React (useId: «:r3:») cambian entre montajes; el resto debe ser identico.
  const html = c.innerHTML.replace(/:r[0-9a-z]+:/g, ":id:").replace(/«r[0-9a-z]+»/g, "«id»");
  rendered?.unmount();
  rendered = undefined;
  return html;
}

const CLAVE_CRUDA = /\brestaurantes\.[a-zA-Z]+\.[A-Za-z0-9._]+/;
const indicadores = () => <IndicadoresWhatsappPage apiBaseUrl="https://api.test" token="tok" propertyId="prop-1" orgSlug="demo" role="owner" staffFullName={undefined} staffEmail="a@b.c" />;
const conocimiento = () => <ConocimientoNegocio apiBaseUrl="https://api.test" token="tok" propertyId="prop-1" canal="whatsapp" />;

describe("Indicadores del agente de WhatsApp ES/EN", () => {
  it("en espanol el DOM es identico con y sin IdiomaProvider", async () => {
    const sin = await htmlDe(indicadores());
    const con = await htmlDe(<IdiomaProvider idiomaInicial="es">{indicadores()}</IdiomaProvider>);
    expect(con).toBe(sin);
    expect(sin).toContain("4 de 10 conversaciones nuevas terminaron en pedido");
  });

  it("en ingles sale en ingles, sin claves crudas", async () => {
    const c = await montar(<IdiomaProvider idiomaInicial="en">{indicadores()}</IdiomaProvider>);
    const texto = c.textContent ?? "";
    for (const en of ["WhatsApp agent metrics", "New conversations", "Order conversion", "4 of 10 new conversations ended in an order", "By day", "Definitions:"]) expect(texto, en).toContain(en);
    for (const es of ["Indicadores del agente", "Conversaciones nuevas", "Conversión a pedido", "Por día", "Definiciones:"]) expect(texto, es).not.toContain(es);
    expect(c.innerHTML).not.toMatch(CLAVE_CRUDA);
  });
});

describe("Conocimiento del negocio ES/EN", () => {
  it("en espanol el DOM es identico con y sin IdiomaProvider", async () => {
    const sin = await htmlDe(conocimiento());
    const con = await htmlDe(<IdiomaProvider idiomaInicial="es">{conocimiento()}</IdiomaProvider>);
    expect(con).toBe(sin);
    expect(sin).toContain("Del 2026-10-06 al 2026-10-08");
  });

  it("en ingles traduce la interfaz y deja el contenido del negocio tal cual", async () => {
    const c = await montar(<IdiomaProvider idiomaInicial="en">{conocimiento()}</IdiomaProvider>);
    const texto = c.textContent ?? "";
    for (const en of ["Business knowledge", "Drafts pending approval", "From 2026-10-06 to 2026-10-08", "Imported from a document", "Add entry", "FAQ"]) expect(texto, en).toContain(en);
    for (const es of ["Conocimiento del negocio", "Borradores por aprobar", "Agregar entrada", "Pregunta frecuente"]) expect(texto, es).not.toContain(es);
    expect(texto).toContain("Hay estacionamiento gratuito para clientes.");
    expect(c.innerHTML).not.toMatch(CLAVE_CRUDA);
  });
});

describe("etiquetas de lib/ del agente de WhatsApp", () => {
  it("en espanol son los textos de siempre", () => {
    expect(PERFIL_LABEL.taqueria_pm).toBe("Taquería PM (de usted, recoger y domicilio)");
    expect(TONO_LABEL.calido_cercano).toBe("Cálido y cercano");
    expect(MOTIVO_LABEL["no_entiende"]).toBe("No se le entiende al cliente");
    expect(Object.keys(TONO_LABEL)).toEqual(["calido_cercano", "formal_directo", "profesional_neutro", "divertido_desenfadado"]);
    expect(camposCambiados({ agentName: "A" }, { agentName: "B" })).toEqual(["Nombre del agente"]);
    expect(TIPO_CONOCIMIENTO_LABEL.aviso_temporal).toBe("Aviso temporal");
  });

  it("en ingles siguen al idioma activo", () => {
    fijarIdiomaActivo("en");
    expect(PERFIL_LABEL.generico).toBe("Generic (informal, delivery only)");
    expect(TONO_LABEL.formal_directo).toBe("Formal and direct");
    expect(camposCambiados({ toneStyle: "a" }, { toneStyle: "b" })).toEqual(["Tone"]);
    expect(TIPO_CONOCIMIENTO_LABEL.politica).toBe("Policy");
  });
});
