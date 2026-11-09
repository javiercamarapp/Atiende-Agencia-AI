// @vitest-environment jsdom
//
// i18n ES/EN — restaurantes: turnos, cierres, auditoria y privacidad. Con la consola en espanol el DOM es identico al de sin
// proveedor; con EN (diseno ds3) las cuatro pantallas salen en ingles, sin claves crudas, y los datos del negocio (nombres del
// personal, nombres de turno, responsable del aviso) quedan tal cual. Las etiquetas y validaciones que arman lib/ y las funciones
// de la pagina (tipos de la bitacora, validarTurnosLocal, formatoDia) siguen al idioma activo.
import { act } from "react";
import type { ReactElement } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { IdiomaProvider, cargarIdioma } from "@atiende/ui";
import { fijarIdiomaActivo } from "../../../packages/ui/src/i18n/activo.ts";
import { TurnosPage, validarTurnosLocal } from "../src/verticals/restaurantes/pages/Turnos.tsx";
import { CierresPage } from "../src/verticals/restaurantes/pages/Cierres.tsx";
import { AuditoriaPage } from "../src/verticals/restaurantes/pages/Auditoria.tsx";
import { PrivacidadPage } from "../src/verticals/restaurantes/pages/Privacidad.tsx";
import { AUDIT_LOG_ENTITY_TYPE_LABELS } from "../src/verticals/restaurantes/lib/auditoria-client.ts";
import { formatoDia } from "../src/verticals/restaurantes/voz/formato-kpi.ts";
import type { RestaurantesShellContext } from "../src/verticals/restaurantes/RestaurantesShell.tsx";
import { flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";
import { prepararJsdomParaRadix } from "./test-utils/seleccionar.tsx";

let rendered: RenderedComponent | undefined;
const CTX: RestaurantesShellContext = { apiBaseUrl: "https://api.test", token: "tok", propertyId: "prop-1", orgSlug: "demo", role: "owner", staffFullName: "Ana", staffEmail: "ana@example.com" };

const TURNOS = {
  disponible: true,
  turnos: [{ id: "t1", nombre: "Turno 1", dias: [1, 2, 3, 4, 5], inicia: "12:00", termina: "18:00", miembros: [{ userId: "u1", nombre: "Ana Pech", orden: 1 }] }],
  cobertura: { sinCobertura: false, turnosVigentes: [], guardia: [{ userId: "u1", nombre: "Ana Pech", turno: "Turno 1", orden: 1 }, { userId: "u2", nombre: "Beto Ruiz", turno: "Turno 1", orden: 2 }] },
};
const MIEMBROS = { miembros: [{ id: "u1", email: "ana@example.com", fullName: "Ana Pech", verticalRole: "staff", propertyIds: null }] };
const CIERRE = {
  id: "c1", tipo: "dia", fechaInicio: "2026-03-09", fechaFin: "2026-03-09", zonaHoraria: "America/Merida", generadoPor: "sistema", generadoAt: "2026-03-10T12:00:00.000Z",
  pedidos: 5, ventasCentavos: 38575, ticketPromedioCentavos: 7715, conProblema: 1, cancelados: 1, canceladosCentavos: 8000, noRecogidos: 1, cancelacionPct: 16.7,
  porCanal: [
    { canal: "web", pedidos: 1, ventasCentavos: 1000, cancelados: 1 },
    { canal: "whatsapp", pedidos: 2, ventasCentavos: 30050, cancelados: 0 },
    { canal: "voice", pedidos: 1, ventasCentavos: 5000, cancelados: 0 },
    { canal: "admin", pedidos: 1, ventasCentavos: 2525, cancelados: 0 },
  ],
  tiempos: { entregados: 2, promedioMin: 45, medianaMin: 45, p90Min: 57 },
  comparativo: { fechaInicio: "2026-03-02", fechaFin: "2026-03-02", pedidos: 2, ventasCentavos: 20000, variacionPedidosPct: 150, variacionVentasPct: 92.9 },
  porDia: null,
};
const CIERRES = { disponible: true, tipo: "dia", zonaHoraria: "America/Merida", hoy: "2026-03-11", cierres: [CIERRE], pendientes: ["2026-03-10"] };
const AUDITORIA = {
  disponible: true,
  total: 30,
  nextOffset: 25,
  items: [{ id: "a1", actorUserId: "usr-owner", action: "producto.precio_actualizado", entityType: "producto", entityId: "p1", campo: "precio", antes: "90", despues: "95", creadoEn: "2026-09-30T17:00:00.000Z" }],
};
const CONFIG = { responsable: "Taqueria El Faro SA de CV", avisoUrl: null, avisoVersion: "v1", retencionConversacionesDias: 180, retencionVozDias: 30, exigirConsentimientoGrabacion: true, configurada: false };
const ARCO = {
  disponible: true,
  total: 1,
  nextOffset: null,
  plazos: { respuestaDias: 20, ejecucionDias: 15 },
  items: [{ id: "11111111-1111-1111-1111-111111111111", folio: "11111111", telefono: "+5219981234567", derecho: "acceso", canal: "whatsapp", identidadVerificadaPor: "whatsapp_numero", estado: "recibida", solicitadaEn: "2026-09-30T15:00:00.000Z", respuestaVenceEn: "2026-10-20T15:05:00.000Z", ejecucionVenceEn: null, notaResolucion: null, plazo: "en_plazo" }],
};

function json(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
}

beforeAll(async () => {
  prepararJsdomParaRadix();
  await cargarIdioma("en");
});

beforeEach(() => {
  document.documentElement.dataset.diseno = "ds3";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.endsWith("/staff/miembros")) return json(MIEMBROS);
      if (url.endsWith("/admin/turnos")) return json(TURNOS);
      if (url.includes("/admin/cierres")) return json(CIERRES);
      if (url.includes("/admin/auditoria")) return json(AUDITORIA);
      if (url.endsWith("/privacidad/configuracion")) return json({ configuracion: CONFIG, porDefecto: CONFIG });
      if (url.includes("/privacidad/solicitudes")) return json(ARCO);
      return json({ error: "sin respuesta simulada" }, 404);
    }),
  );
});

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
  fijarIdiomaActivo("es");
  delete document.documentElement.dataset.diseno;
  document.body.innerHTML = "";
});

async function montar(el: ReactElement): Promise<HTMLElement> {
  rendered = renderComponent(el);
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

async function textoEn(el: ReactElement): Promise<{ readonly texto: string; readonly html: string }> {
  const c = await montar(<IdiomaProvider idiomaInicial="en">{el}</IdiomaProvider>);
  return { texto: c.textContent ?? "", html: c.innerHTML };
}

const CLAVE_CRUDA = /\brestaurantes\.[a-z]+\.[A-Za-z0-9.]+/;

describe("Turnos, Cierres, Auditoria y Privacidad ES/EN", () => {
  for (const [nombre, pagina] of [
    ["Turnos", () => <TurnosPage {...CTX} />],
    ["Cierres", () => <CierresPage {...CTX} />],
    ["Auditoria", () => <AuditoriaPage {...CTX} />],
    ["Privacidad", () => <PrivacidadPage {...CTX} />],
    ["Cierres (rol sin acceso)", () => <CierresPage {...CTX} role="staff" />],
  ] as const) {
    it(`${nombre}: en espanol el DOM es identico con y sin IdiomaProvider`, async () => {
      const sin = await htmlDe(pagina());
      const con = await htmlDe(<IdiomaProvider idiomaInicial="es">{pagina()}</IdiomaProvider>);
      expect(con).toBe(sin);
    });
  }

  it("Turnos en ingles: guardia, campos y botones en ingles; nombres del personal y del turno tal cual", async () => {
    const { texto, html } = await textoEn(<TurnosPage {...CTX} />);
    for (const en of ["On call now", "lead", "backup 1", "Starts", "Ends (if earlier, it runs past midnight)", "Remove shift", "Mon", "Fri", "Add shift", "Save shifts", "Staff (in order: lead, then backups)"]) expect(texto, en).toContain(en);
    for (const es of ["De guardia ahora", "principal", "respaldo", "Inicia", "Quitar turno", "Lun", "Agregar turno", "Guardar turnos"]) expect(texto, es).not.toContain(es);
    expect(texto).toContain("Ana Pech — Turno 1");
    expect(html).toContain('aria-label="Shift 1 days"');
    expect(html).not.toMatch(CLAVE_CRUDA);
  });

  it("Cierres en ingles: KPIs, canales, pendientes y definiciones en ingles; cifras con formatMoney", async () => {
    const { texto, html } = await textoEn(<CierresPage {...CTX} />);
    for (const en of ["Daily closeout", "Generate Mar 10", "Closeout for Mar 9 · generated automatically", "Average ticket", "1 not picked up", "Median 45 min · 9 out of 10 in 57 min or less (2 delivered)", "By channel", "Online order (legacy)", "Phone call", "Entered by the team", "Definitions:", "Comparison: Mar 2 (2 orders, $200.00 MXN).", "$385.75 MXN"]) expect(texto, en).toContain(en);
    for (const es of ["Cierre del día", "Generar", "Ticket promedio", "Por canal", "Llamada", "Capturado por el equipo", "Definiciones", "Comparativo", "pedidos"]) expect(texto, es).not.toContain(es);
    expect(texto).toContain("WhatsApp");
    expect(html).not.toMatch(CLAVE_CRUDA);
  });

  it("Cierres en ingles con un rol sin acceso: aviso de roles en ingles", async () => {
    const { texto } = await textoEn(<CierresPage {...CTX} role="staff" />);
    expect(texto).toContain("Only the owner/admin roles can see closeouts — your current role is staff.");
  });

  it("Auditoria en ingles: filtros, tabla y conteo en ingles; lo que manda el servidor tal cual", async () => {
    const { texto, html } = await textoEn(<AuditoriaPage {...CTX} />);
    for (const en of ["Audit log", "Filters", "Action type", "From", "To", "Team actions", "When", "Who", "Action", "Field", "Before", "After", "Products", "1 of 30", "Load more"]) expect(texto, en).toContain(en);
    for (const es of ["Filtros", "Tipo de acción", "Desde", "Acciones del staff", "Cuándo", "Productos", "Cargar más", " de 30"]) expect(texto, es).not.toContain(es);
    expect(texto).toContain("precio actualizado");
    expect(html).not.toMatch(CLAVE_CRUDA);
  });

  it("Privacidad en ingles: configuracion y filtros en ingles; el responsable del aviso tal cual", async () => {
    const { texto, html } = await textoEn(<PrivacidadPage {...CTX} />);
    for (const en of ["Privacy", "ARCO data rights requests", "not legal advice", "Privacy notice, retention and recording", "You haven't saved these settings yet", "Data controller (name on the notice)", "Keep WhatsApp conversations", "Require consent to record the call", "Save settings", "Filters", "Status", "Right", "1 of 1"]) expect(texto, en).toContain(en);
    // El panel ARCO compartido de @atiende/ui (tabla y semaforo) sigue en espanol: hueco conocido, fuera de este PR.
    for (const es of ["Solicitudes de derechos ARCO", "Todavía no guardas", "Responsable del tratamiento", "Guardar configuración", "Filtros", "Esperando confirmación del titular", "1 de 1"]) expect(texto, es).not.toContain(es);
    for (const en of ["Waiting for the data owner to confirm", "Objection"]) expect(texto, en).toContain(en);
    expect(html).toContain('placeholder="Legal name or trade name"');
    expect(html).toContain('aria-label="ARCO requests"');
    expect(html).toContain("Taqueria El Faro SA de CV");
    expect(html).not.toMatch(CLAVE_CRUDA);
  });
});

describe("etiquetas de lib/ y de la pagina (idioma activo)", () => {
  const SIN_DIAS = [{ nombre: "Comida", dias: [], inicia: "12:00", termina: "18:00", miembros: [] }];

  it("en espanol son las de siempre", () => {
    expect(AUDIT_LOG_ENTITY_TYPE_LABELS.configuracion).toBe("Configuración");
    expect(AUDIT_LOG_ENTITY_TYPE_LABELS.acceso).toBe("Accesos a datos personales");
    expect(Object.keys(AUDIT_LOG_ENTITY_TYPE_LABELS)).toEqual(["producto", "promocion", "pedido", "repartidor", "staff", "configuracion", "exportacion", "acceso"]);
    expect(validarTurnosLocal(SIN_DIAS)).toBe('El turno "Comida" necesita al menos un día.');
    expect(formatoDia("2026-03-10")).toBe("10 mar");
  });

  it("en ingles siguen al idioma activo", () => {
    fijarIdiomaActivo("en");
    expect(AUDIT_LOG_ENTITY_TYPE_LABELS.configuracion).toBe("Settings");
    expect(AUDIT_LOG_ENTITY_TYPE_LABELS.staff).toBe("Team");
    expect(validarTurnosLocal(SIN_DIAS)).toBe('Shift "Comida" needs at least one day.');
    expect(formatoDia("2026-03-10")).toBe("Mar 10");
  });
});
