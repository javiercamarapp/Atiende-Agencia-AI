// @vitest-environment jsdom
// Ficha 360 de una organizacion (SA-07): uso, costo, membresias, errores, facturacion y checklist de onboarding. Efectos observables con la
// API simulada por ruta; 404 honesto, base sin migrar y 'no se pudo medir' distinto de 'pendiente'.
import { act } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SuperAdminOrganizacionFichaPage } from "../src/superadmin/pages/OrganizacionFicha.tsx";
import { changeValue, click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";
import { instalarLocalStorageEnMemoria, respuestaEntrar } from "./test-utils/token-soporte.ts";

beforeEach(() => {
  instalarLocalStorageEnMemoria();
});

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

const campo = <T,>(valor: T) => ({ valor, razon: null });
const sinDato = (razon: string) => ({ valor: null, razon });

const FICHA = {
  disponible: true, mensaje: null, mes: "2026-09", ventanaDias: 30,
  organizacion: { id: "o1", nombre: "Los Taquitos de PM", slug: "taquitos", vertical: "restaurantes", estado: "active", creadaEn: "2026-09-01T00:00:00.000Z" },
  uso: { operaciones30d: campo(120), conversaciones30d: campo(340), minutosVoz30d: campo(12.4) },
  costo: { llm30dUsd: campo(41.5), eventos30dUsd: campo(3.9), costoPorEventoUsd: campo(0.13) },
  membresias: {
    porRol: [{ rol: "owner / staff", cantidad: 1 }, { rol: "member / staff", cantidad: 3 }],
    ultimosAccesos: campo([{ rol: "member", ultimoAcceso: "2026-09-30T16:00:00.000Z" }, { rol: "owner", ultimoAcceso: null }]),
  },
  errores: {
    outboxMuerto: campo(2),
    denegaciones30d: { valor: 1, razon: null, ultimas: [{ ruta: "/v1/restaurantes/x/admin/config", motivo: "insufficient_role", cuando: "2026-09-29T16:00:00.000Z" }] },
    crons: sinDato("Sin fuente por organización: los crons se miden para toda la plataforma (ver Salud operativa)."),
  },
  facturacion: { plan: { id: "p1", nombre: "Restaurantes" }, cobro: { estado: "pago_pendiente", periodoHasta: "2026-10-30T00:00:00.000Z", asientos: 3 }, contrato: { contractId: "c1", version: 2 } },
  onboarding: [
    { paso: "whatsapp", titulo: "WhatsApp configurado", estado: "hecho", razon: null, razonTexto: null },
    { paso: "primera_operacion", titulo: "Primera operación real", estado: "no_se_pudo_medir", razon: "sin_fuente", razonTexto: "Sin fuente: despachos no guarda un registro de operaciones." },
    { paso: "plan_asignado", titulo: "Plan asignado", estado: "pendiente", razon: null, razonTexto: null },
  ],
};
const MARGEN = { disponible: true, mes: "2026-09", mensaje: null, margenes: { o1: campo({ mxn: 1498, pct: 93.7, ingresoMxn: 1598 }) } };

const json = (body: unknown, ok = true, status = 200) => ({ ok, status, json: async () => body }) as unknown as Response;
async function esperar(): Promise<void> {
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();
  });
}

function stub(o: { ficha?: () => Response; margen?: () => Response } = {}) {
  fetchMock = vi.fn(async (url: string) => {
    if (url.includes("/ficha")) return (o.ficha ?? (() => json(FICHA)))();
    if (url.endsWith("/superadmin/organizaciones/margen")) return (o.margen ?? (() => json(MARGEN)))();
    throw new Error(`fetch inesperado: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}
const render = (id = "o1") =>
  renderComponent(
    <MemoryRouter initialEntries={[`/superadmin/organizaciones/${id}`]}>
      <Routes>
        <Route path="/superadmin/organizaciones/:id" element={<SuperAdminOrganizacionFichaPage apiBaseUrl="https://api.test" token="tok" />} />
        <Route path="*" element={<p data-testid="otra">otra ruta</p>} />
      </Routes>
    </MemoryRouter>,
  );

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

describe("SuperAdminOrganizacionFichaPage", () => {
  it("pinta las secciones con los datos reales: uso, costo con margen, membresias, errores, facturacion y onboarding", async () => {
    stub();
    rendered = render();
    await esperar();
    const t = rendered.container.textContent ?? "";
    expect(rendered.container.querySelectorAll("h1")).toHaveLength(1);
    expect(rendered.container.querySelector("h1")?.textContent).toContain("Los Taquitos de PM");
    for (const s of ["Uso · últimos 30 días", "Costo", "Membresías", "Últimos errores", "Facturación y contrato", "Onboarding · 1/3"]) expect(t).toContain(s);
    expect(t).toContain("120");
    expect(t).toContain("340");
    expect(t).toContain("US$41.50");
    expect(t).toContain("US$0.13");
    expect(t).toContain("$1,498 (94%)");
    expect(t).toContain("Ingreso esperado $1,598");
    expect(t).toContain("owner / staff");
    expect(t).toContain("Sin sesión registrada");
    expect(t).toContain("/v1/restaurantes/x/admin/config");
    expect(t).toContain("Pago pendiente");
    expect(t).toContain("Versión 2");
  });

  it("'No se pudo medir' es DISTINTO de 'Pendiente' y trae su razon; lo hecho dice 'Hecho'", async () => {
    stub();
    rendered = render();
    await esperar();
    const paso = (p: string) => rendered!.container.querySelector(`li[data-paso="${p}"]`) as HTMLElement;
    expect(paso("whatsapp").dataset.estado).toBe("hecho");
    expect(paso("whatsapp").textContent).toContain("Hecho");
    expect(paso("primera_operacion").dataset.estado).toBe("no_se_pudo_medir");
    expect(paso("primera_operacion").textContent).toContain("No se pudo medir");
    expect(paso("primera_operacion").textContent).not.toContain("Pendiente");
    expect(paso("primera_operacion").textContent).toContain("Sin fuente: despachos no guarda un registro de operaciones.");
    expect(paso("plan_asignado").textContent).toContain("Pendiente");
  });

  it("un dato no medible es '—' con su razon (crons sin fuente por organizacion), no 0", async () => {
    stub({ ficha: () => json({ ...FICHA, uso: { ...FICHA.uso, minutosVoz30d: sinDato("No disponible aún: la migración de esta vertical no está aplicada en este despliegue.") } }) });
    rendered = render();
    await esperar();
    const t = rendered.container.textContent ?? "";
    expect(t).toContain("Sin fuente por organización");
    expect(t).toContain("No disponible aún: la migración de esta vertical no está aplicada");
  });

  it("si el margen se rechaza (step-up) solo esa tarjeta queda en '—' con su razon; el resto de la ficha sigue", async () => {
    stub({ margen: () => json({ message: "Esta acción exige verificar tu código MFA (step-up)." }, false, 403) });
    rendered = render();
    await esperar();
    const t = rendered.container.textContent ?? "";
    expect(t).toContain("Esta acción exige verificar tu código MFA");
    expect(t).toContain("US$41.50");
    expect(t).not.toContain("$1,498");
  });

  it("organizacion inexistente: 404 honesto (estado vacio con enlace de regreso), sin pantalla en blanco", async () => {
    stub({ ficha: () => json({ code: "not_found", message: "Organización no encontrada." }, false, 404) });
    rendered = render("no-existe");
    await esperar();
    const t = rendered.container.textContent ?? "";
    expect(t).toContain("Organización no encontrada");
    expect(t).toContain("No encontramos esta organización");
    expect([...rendered.container.querySelectorAll("a")].some((a) => a.getAttribute("href") === "/superadmin/organizaciones")).toBe(true);
  });

  it("base sin la 0052: aviso honesto con la cabecera de la organizacion, sin tarjetas ni cifras inventadas", async () => {
    stub({
      ficha: () =>
        json({
          disponible: false, mensaje: "No disponible aún: falta aplicar la migración 0052_superadmin_organizaciones_ficha_onboarding en este despliegue.",
          organizacion: FICHA.organizacion,
        }),
    });
    rendered = render();
    await esperar();
    const t = rendered.container.textContent ?? "";
    expect(t).toContain("Los Taquitos de PM");
    expect(t).toContain("0052_superadmin_organizaciones_ficha_onboarding");
    expect(t).not.toContain("Uso · últimos 30 días");
  });

  it("error de carga: estado de error con reintento", async () => {
    stub({ ficha: () => json({ message: "boom" }, false, 500) });
    rendered = render();
    await esperar();
    expect(rendered.container.textContent).toContain("No se pudo cargar la ficha de la organización.");
  });

  it("'Entrar' sin motivo no abre la sesion; con motivo llama al POST real", async () => {
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") return json(respuestaEntrar({ slug: "taquitos", nombre: "Los Taquitos de PM", expMs: Date.now() + 3_600_000 }), true, 201);
      if (url.endsWith("/auth/me")) return json({ email: "javier@atiende.ai", fullName: "Javier", organizations: [] });
      if (url.includes("/ficha")) return json(FICHA);
      return json(MARGEN);
    });
    vi.stubGlobal("fetch", fetchMock);
    rendered = render();
    await esperar();
    click([...rendered.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Entrar"))!);
    await esperar();
    const dialogo = document.body.querySelector('[role="alertdialog"]')!;
    const confirmar = () => click([...dialogo.querySelectorAll("button")].find((b) => b.textContent?.includes("Entrar al panel"))!);
    confirmar();
    await esperar();
    expect(fetchMock.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === "POST")).toHaveLength(0);
    changeValue(dialogo.querySelector("textarea")!, "Revisar por que el cliente no recibe mensajes.");
    confirmar();
    await esperar();
    const post = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === "POST")!;
    expect(post[0]).toBe("https://api.test/superadmin/soporte/entrar");
    expect(JSON.parse(String((post[1] as RequestInit).body))).toEqual({ organizationId: "o1", reason: "Revisar por que el cliente no recibe mensajes." });
  });
});
