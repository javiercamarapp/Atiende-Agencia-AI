// @vitest-environment jsdom
//
// i18n ES/EN — superadmin, grupo «base» (Resumen diario, consola, Organizaciones, Gestion, Ficha 360 y Equipo). Con la consola en
// espanol el DOM es identico al de sin proveedor (nadie que no elija EN ve un byte distinto); con EN (diseno ds3) la interfaz sale en
// ingles, sin claves crudas, y los datos (narrativa del LLM, nombres de organizaciones, razones del servidor, correos) quedan tal cual.
import { act } from "react";
import type { ReactElement } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { IdiomaProvider, cargarIdioma } from "@atiende/ui";
import { fijarIdiomaActivo } from "../../../packages/ui/src/i18n/activo.ts";
import { SuperAdminResumenPage } from "../src/superadmin/pages/Resumen.tsx";
import { SuperAdminConsolaResumenPage } from "../src/superadmin/pages/ConsolaResumen.tsx";
import { SuperAdminOrganizacionesPage } from "../src/superadmin/pages/Organizaciones.tsx";
import { SuperAdminGestionOrganizacionesPage } from "../src/superadmin/pages/GestionOrganizaciones.tsx";
import { SuperAdminOrganizacionFichaPage } from "../src/superadmin/pages/OrganizacionFicha.tsx";
import { GRUPOS_AGENTE, NOMBRE_VERTICAL, costoPorAgente, saludoMexico } from "../src/superadmin/lib/consola-client.ts";
import { NOMBRE_ESTADO_ORG, NOMBRE_ESTADO_PASO } from "../src/superadmin/lib/organizaciones.ts";
import { NOMBRE_ROL_EQUIPO, nombreRolEquipo, rolesEquipoDe } from "../src/superadmin/lib/equipo.ts";
import { flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;

const campo = <T,>(valor: T) => ({ valor, razon: null });
const sinDato = (razon: string) => ({ valor: null, razon });
const DIAS = Array.from({ length: 14 }, (_, i) => new Date(Date.UTC(2026, 8, 19 + i)).toISOString().slice(0, 10));

const RESUMEN_DIARIO = {
  fecha: "2026-06-15",
  agregados: {
    fecha: "2026-06-15",
    zonaHoraria: "America/Mexico_City",
    salud: { alertas: [{ severidad: "alta", titulo: "Cola de hoteles atorada", detalle: "3 mensajes muertos", href: "/superadmin/salud" }], crons: { total: 18, ok: 17 }, colas: { muertos: 3, pendientes: 0 } },
    gastoLlm: { costoHoyMicroUsd: 1_500_000, pctTopePlataforma: 0.15 },
    facturacion: { altas: 1, bajas: 0, morososNuevos: 2, activasTotal: 12 },
    prospectos: { altas: 2, cambiosEstado: 1, sinMovimiento: 4, umbralSinMovimientoDias: 14 },
    organizacionesStaff: { organizacionesNuevas: 1, nombresOrganizacionesNuevas: ["Los Taquitos de PM"], staffNuevos: 2 },
    mensajeria: [],
    breakGlassAbiertos: 0,
    deltas: { alertasSalud: 1, facturacionAltas: 0 },
  },
  narrativa: "Todo tranquilo hoy en la plataforma.",
  generadoPor: "llm",
  costoLlmMicroUsd: null,
  modeloLlm: null,
  proveedorLlm: null,
  creadoEn: "2026-06-15T15:00:00.000Z",
  actualizadoEn: "2026-06-15T15:00:00.000Z",
  correoEnviadoEn: null,
};

const CONSOLA = {
  disponible: true,
  generadoEn: "2026-10-02T15:00:00.000Z",
  hoy: "2026-10-02",
  organizaciones: campo({ total: 6, demo: 1, porVertical: [{ vertical: "restaurantes", total: 3, demo: 1 }, { vertical: "hoteles", total: 3, demo: 0 }] }),
  gastoIa: campo({ totalUsd: 41.82, llmUsd: 36.1, otrosUsd: 5.72, porCategoria: [], serie14d: campo(DIAS.map((dia, i) => ({ dia, usd: 1 + i }))), delta7d: { valor: null } }),
  tokens: campo({ total: 5_400_000, entrada: 4_100_000, salida: 1_300_000 }),
  operaciones: campo({ total: 140, porVertical: [], serie14d: DIAS.map((dia, i) => ({ dia, cantidad: 5 + i })), verticalesSinFuente: ["despachos"] }),
  vozMinutos: campo(318.5),
  sucursales: campo(11),
  usuarios: campo({ total: 27, staff: 26, superadmins: 1 }),
  conversacionesWa: campo({ total: 214, porVertical: [{ vertical: "restaurantes", total: 120 }, { vertical: "rentas", total: null, razon: "Sin fuente: esta vertical no guarda conversaciones de WhatsApp." }] }),
  resueltasSinHumano: campo({ dia: "2026-10-02", resueltas: 18, total: 24, porcentaje: 75, nota: "medido solo en restaurantes" }),
  mrr: campo({ totalMxn: 48_900, organizacionesConPrecio: 4, organizacionesSinPrecio: 2 }),
};

const AGENTES = {
  disponible: true,
  hoy: "2026-10-02",
  agentes: campo([{ vertical: "restaurantes", role: "restaurantes:whatsapp_agent", historico: { llamadas: 1840, costoUsd: 21.4, fallbacks: 12 }, ultimos30Dias: { llamadas: 610, costoUsd: 7.2, fallbacks: 3 } }]),
  ultimaCorrida: campo([{ cron: "/internal/rentas/ical-sync", vertical: "rentas", nombre: "Sincronización iCal de rentas", estado: "error", terminoEn: "2026-10-02T14:45:01.000Z", duracionMs: 900, fallosConsecutivos: 2, tareas: "no medido" }]),
};

const ORGS = [{ id: "o1", vertical: "restaurantes", name: "Los Taquitos de PM", slug: "taquitos", status: "active", staffCount: 5 }];

const FILAS = [
  {
    id: "o1", nombre: "Los Taquitos de PM", slug: "taquitos", vertical: "restaurantes", estado: "active", creadaEn: "2026-09-01T00:00:00.000Z", staff: 3,
    plan: campo({ id: "p1", nombre: "Restaurantes" }), operaciones30d: campo(120), costoIa30dUsd: campo(41.5), onboarding: campo({ hechos: 5, total: 6, noMedibles: 1 }),
  },
];

const ACCIONES = [
  { id: "a1", tipo: "suspender", organizationId: "o1", payload: {}, motivo: "Impago de tres meses consecutivos del cliente", estado: "pending", venceEnMs: Date.now() + 600_000, resultado: null, requiereDobleControl: true, contratoVersion: 2, aprobadoPor: null, esSolicitante: true },
  { id: "a2", tipo: "alta", organizationId: null, payload: { name: "Hotel Mar" }, motivo: "Alta del hotel piloto en Mérida", estado: "executed", venceEnMs: 0, resultado: { organization_id: "o1" } },
];

const FICHA = {
  disponible: true, mensaje: null, mes: "2026-09", ventanaDias: 30,
  organizacion: { id: "o1", nombre: "Los Taquitos de PM", slug: "taquitos", vertical: "restaurantes", estado: "active", creadaEn: "2026-09-01T00:00:00.000Z" },
  uso: { operaciones30d: campo(120), conversaciones30d: campo(340), minutosVoz30d: sinDato("No disponible aún: la migración de esta vertical no está aplicada.") },
  costo: { llm30dUsd: campo(41.5), eventos30dUsd: campo(3.9), costoPorEventoUsd: campo(0.13) },
  membresias: { porRol: [{ rol: "owner / staff", cantidad: 1 }], ultimosAccesos: campo([{ rol: "owner", ultimoAcceso: null }]) },
  errores: { outboxMuerto: campo(2), denegaciones30d: { valor: 0, razon: null, ultimas: [] }, crons: sinDato("Sin fuente por organización.") },
  facturacion: { plan: null, cobro: { estado: "pago_pendiente", periodoHasta: null, asientos: 3 }, contrato: { contractId: "c1", version: 2 } },
  onboarding: [
    { paso: "whatsapp", titulo: "WhatsApp configurado", estado: "hecho", razon: null, razonTexto: null },
    { paso: "plan_asignado", titulo: "Plan asignado", estado: "pendiente", razon: null, razonTexto: null },
  ],
};
const MARGEN = { disponible: true, mes: "2026-09", mensaje: null, margenes: { o1: campo({ mxn: 1498, pct: 93.7, ingresoMxn: 1598 }) } };
const EQUIPO = {
  disponible: true,
  vertical: "restaurantes",
  mensaje: null,
  miembros: [{ userId: "u1", correo: "a***@taquitos.mx", rol: "owner", platformRole: "owner", propertyIds: null, altaEn: "2026-09-01T00:00:00.000Z" }],
  invitaciones: [{ id: "i1", correo: "b***@taquitos.mx", rol: "staff", platformRole: "member", propertyIds: ["s1"], creadaEn: "2026-09-02T00:00:00.000Z", venceEn: "2026-09-09T00:00:00.000Z", vencida: true }],
  sucursales: [{ id: "s1", nombre: "Centro", estado: "active" }],
};

const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as unknown as Response;

beforeAll(() => cargarIdioma("en"));

beforeEach(() => {
  document.documentElement.dataset.diseno = "ds3";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const ruta = new URL(url).pathname;
      if (ruta === "/superadmin/resumen") return json({ disponible: true, resumenes: [RESUMEN_DIARIO] });
      if (ruta === "/superadmin/copiloto/pins") return json({ disponible: true, pins: [] });
      if (ruta === "/superadmin/consola/resumen") return json(CONSOLA);
      if (ruta === "/superadmin/consola/agentes-actividad") return json(AGENTES);
      if (ruta === "/superadmin/organizations") return json({ organizations: ORGS });
      if (ruta === "/superadmin/organizaciones/acciones") return json({ disponible: true, acciones: ACCIONES });
      if (ruta === "/superadmin/organizaciones/resumen") return json({ disponible: true, mensaje: null, ventanaDias: 30, organizaciones: FILAS });
      if (ruta === "/superadmin/organizaciones/margen") return json(MARGEN);
      if (ruta.endsWith("/ficha")) return json(FICHA);
      if (ruta.endsWith("/invitaciones")) return json(EQUIPO);
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
    for (let i = 0; i < 8; i++) await flushMicrotasks();
  });
  return rendered.container;
}

async function htmlDe(el: ReactElement): Promise<string> {
  const c = await montar(el);
  // `useId` (React, sin hidratacion) numera con un contador global: dos montajes seguidos dan `:r0:` y `:r6:`. Se normaliza.
  const html = c.innerHTML.replace(/:r[0-9a-z]+:/g, ":r:");
  rendered?.unmount();
  rendered = undefined;
  return html;
}

const CLAVE_CRUDA = /\b(superadmin|comun)\.[a-z]+\.[A-Za-z0-9.]+/;
const API = { apiBaseUrl: "https://api.test", token: "tok" } as const;

const PANTALLAS: ReadonlyArray<{
  nombre: string;
  el: () => ReactElement;
  es: readonly string[];
  en: readonly string[];
  /** Textos en espanol que con EN ya no deben aparecer. */
  fuera: readonly string[];
  /** Datos que quedan tal cual en los dos idiomas. */
  datos: readonly string[];
}> = [
  {
    nombre: "Resumen diario",
    el: () => <SuperAdminResumenPage {...API} />,
    es: ["Resumen diario", "Alertas de salud operativa", "generado por LLM", "(+1 vs. ayer)", "2 moroso(s) nuevo(s)", "alta"],
    en: ["Daily summary", "Operational health alerts", "generated by LLM", "(+1 vs. yesterday)", "2 new overdue account(s)", "high", "History (1)", "June 15, 2026"],
    fuera: ["Resumen diario", "Generar ahora", "Historial", "sin correo", "15 de junio de 2026"],
    datos: ["Todo tranquilo hoy en la plataforma.", "Cola de hoteles atorada", "Los Taquitos de PM"],
  },
  {
    nombre: "Consola",
    el: () => (
      <MemoryRouter initialEntries={["/superadmin"]}>
        <SuperAdminConsolaResumenPage {...API} staffFullName="Ana María Torres" />
      </MemoryRouter>
    ),
    es: ["Orquestación de agentes", "2 organizaciones sin precio", "Resueltas sin humano — hoy", "18 de 24", "Fallo"],
    en: ["Agent orchestration", "2 organizations without a price", "Resolved without a human — today", "18 of 24", "Failed", "Restaurants", "Active", "Enter"],
    fuera: ["Orquestación de agentes", "organizaciones sin precio", "Operaciones atendidas", "Ver parte diario", "Restaurantes"],
    datos: ["Los Taquitos de PM", "Sincronización iCal de rentas", "medido solo en restaurantes", "Sin fuente: esta vertical no guarda conversaciones de WhatsApp."],
  },
  {
    nombre: "Organizaciones",
    el: () => (
      <MemoryRouter initialEntries={["/superadmin/organizaciones"]}>
        <Routes>
          <Route path="/superadmin/organizaciones" element={<SuperAdminOrganizacionesPage {...API} />} />
        </Routes>
      </MemoryRouter>
    ),
    es: ["Todas las organizaciones", "Top por costo de IA", "5/6 (1 sin medir)", "Gestión"],
    en: ["All organizations", "Top by AI cost", "5/6 (1 not measured)", "Management", "Customers", "Profile"],
    fuera: ["Todas las organizaciones", "sin medir", "Gestión"],
    datos: ["Los Taquitos de PM", "taquitos"],
  },
  {
    nombre: "Gestion",
    el: () => <SuperAdminGestionOrganizacionesPage {...API} />,
    es: ["Gestión de organizaciones", "Pendientes de confirmar", "Doble control: la organización tiene contrato vigente (versión 2). Falta la aprobación de un segundo superadmin.", "Ejecutada"],
    en: ["Organization management", "Awaiting confirmation", "Dual control: the organization has an active contract (version 2). Needs approval from a second superadmin.", "Executed", "Suspend", "Create"],
    fuera: ["Gestión de organizaciones", "Doble control", "Ejecutada", "Alta de organización"],
    datos: ["Los Taquitos de PM", "Impago de tres meses consecutivos del cliente", "Alta del hotel piloto en Mérida"],
  },
  {
    nombre: "Ficha y equipo",
    el: () => (
      <MemoryRouter initialEntries={["/superadmin/organizaciones/o1"]}>
        <Routes>
          <Route path="/superadmin/organizaciones/:id" element={<SuperAdminOrganizacionFichaPage {...API} />} />
        </Routes>
      </MemoryRouter>
    ),
    es: ["Uso · últimos 30 días", "Pago pendiente", "Versión 2", "Miembros · 1", "Todas las sucursales", "Vencida"],
    en: ["Usage · last 30 days", "Payment pending", "Version 2", "Members · 1", "All branches", "Expired", "Owner", "Done", "Pending", "No plan assigned"],
    fuera: ["Uso · últimos 30 días", "Membresías", "Invitaciones pendientes", "Sin plan asignado", "Dueño"],
    datos: ["Los Taquitos de PM", "WhatsApp configurado", "a***@taquitos.mx", "Centro", "No disponible aún: la migración de esta vertical no está aplicada."],
  },
];

describe.each(PANTALLAS)("$nombre ES/EN", ({ el, es, en, fuera, datos }) => {
  it("en espanol el DOM es identico con y sin IdiomaProvider", async () => {
    const sin = await htmlDe(el());
    const con = await htmlDe(<IdiomaProvider idiomaInicial="es">{el()}</IdiomaProvider>);
    expect(con).toBe(sin);
    const texto = new DOMParser().parseFromString(sin, "text/html").body.textContent ?? "";
    for (const t of [...es, ...datos]) expect(texto, t).toContain(t);
  });

  it("en ingles la interfaz sale en ingles y los datos quedan tal cual", async () => {
    const c = await montar(<IdiomaProvider idiomaInicial="en">{el()}</IdiomaProvider>);
    const texto = c.textContent ?? "";
    for (const t of en) expect(texto, t).toContain(t);
    for (const t of fuera) expect(texto, t).not.toContain(t);
    for (const t of datos) expect(texto, t).toContain(t);
    expect(c.innerHTML).not.toMatch(CLAVE_CRUDA);
  });
});

describe("etiquetas de lib/ (traducen al idioma activo)", () => {
  it("en espanol son los textos de siempre", () => {
    expect(saludoMexico(new Date("2026-10-02T15:00:00.000Z"))).toBe("Buenos días");
    expect(NOMBRE_VERTICAL.rentas).toBe("Rentas vacacionales");
    expect(Object.keys(NOMBRE_VERTICAL)).toHaveLength(7);
    expect(NOMBRE_ESTADO_ORG.trial).toBe("Prueba");
    expect(NOMBRE_ESTADO_PASO.no_se_pudo_medir).toBe("No se pudo medir");
    expect(GRUPOS_AGENTE.map((g) => g.nombre)).toEqual(["Agente extractor", "Agente de conciliación", "Agente de WhatsApp y voz", "Copiloto"]);
    expect(costoPorAgente([{ vertical: "x", role: "x:data_chat", historico: { llamadas: 1, costoUsd: 1, fallbacks: 0 }, ultimos30Dias: { llamadas: 1, costoUsd: 1, fallbacks: 0 } }])).toEqual([{ etiqueta: "Otros roles", valor: 1 }]);
    expect(rolesEquipoDe("rentas").map((r) => r.nombre)).toContain("Operador (solo calendario)");
    expect(NOMBRE_ROL_EQUIPO.owner).toBe("Dueño");
    expect(nombreRolEquipo("despachos", "admin")).toBe("Dueño del despacho (admin)");
  });

  it("en ingles siguen al idioma activo", () => {
    fijarIdiomaActivo("en");
    expect(saludoMexico(new Date("2026-10-02T15:00:00.000Z"))).toBe("Good morning");
    expect(NOMBRE_VERTICAL.rentas).toBe("Vacation rentals");
    expect(NOMBRE_ESTADO_ORG.trial).toBe("Trial");
    expect(NOMBRE_ESTADO_PASO.no_se_pudo_medir).toBe("Couldn't measure");
    expect(GRUPOS_AGENTE[1]?.nombre).toBe("Reconciliation agent");
    expect(rolesEquipoDe("rentas").map((r) => r.nombre)).toContain("Operator (calendar only)");
    expect(NOMBRE_ROL_EQUIPO.owner).toBe("Owner");
    expect(nombreRolEquipo("despachos", "admin")).toBe("Firm owner (admin)");
  });
});
