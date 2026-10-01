// @vitest-environment jsdom
//
// H-06 -- <GruposPage />: `fetch` global mockeado por ruta real contra apps/api/src/routes/verticals/hoteles/grupos.ts. Cubre carga,
// base sin migrar, roles, aceptar = bloquear (con confirmacion y 409 sin cupo), anticipo SOLO registrado (centavos enteros),
// y la creacion de la cotizacion con importes en centavos (DS v2: DataTable + useConfirm, nunca window.prompt).
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GruposPage } from "../src/verticals/hoteles/pages/Grupos.tsx";
import type { HotelesShellContext } from "../src/verticals/hoteles/HotelesShell.tsx";
import type { Bloqueo, BloqueoDetalle, Cotizacion } from "../src/verticals/hoteles/lib/grupos-client.ts";
import { changeValue, click, flushMicrotasks, renderComponent, submitForm, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const jsonResponse = (body: unknown, ok = true, status = ok ? 200 : 500): Response => ({ ok, status, json: async () => body }) as unknown as Response;
const ctx = (role: string): HotelesShellContext => ({ apiBaseUrl: "https://api.test", token: "tok", propertyId: "prop-1", orgSlug: "demo", role, staffFullName: "Demo", staffEmail: "d@example.com" });
async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}
const text = () => rendered!.container.textContent ?? "";
const buttons = (label: string) => Array.from(rendered!.container.querySelectorAll("button")).filter((b) => b.textContent?.trim() === label) as HTMLButtonElement[];
const tab = (label: string) => Array.from(rendered!.container.querySelectorAll('[role="tab"]')).find((b) => b.textContent?.trim() === label) as HTMLElement | undefined;
const dialogo = () => document.body.querySelector('[role="alertdialog"], [role="dialog"]') as HTMLElement | null;
async function pulsarEnDialogo(label: string) {
  const b = [...dialogo()!.querySelectorAll("button")].find((x) => x.textContent?.trim() === label)!;
  await act(async () => {
    b.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();
  });
}
async function abrirTab(label: string) {
  await act(async () => {
    const t = tab(label)!;
    t.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    t.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    t.focus();
    await flushMicrotasks();
  });
  await settle();
}

function cotizacion(over: Partial<Cotizacion> = {}): Cotizacion {
  return {
    id: "q1", nombreGrupo: "Boda Garcia", contacto: null, correoContacto: null, llegada: "2031-06-12", salida: "2031-06-15", noches: 3, fechaLiberacion: "2031-06-05",
    vigenteHasta: "2031-05-08T18:00:00.000Z", descuentoBps: 1000, brutoCentavos: 2_250_000, totalCentavos: 2_025_000, anticipoRequeridoCentavos: 500_000,
    anticipoRegistradoCentavos: 0, estado: "enviada", motivoCierre: null, ...over,
  };
}
function bloqueo(over: Partial<Bloqueo> = {}): Bloqueo {
  return {
    id: "b1", cotizacionId: "q1", nombreGrupo: "Boda Garcia", estado: "activo", llegada: "2031-06-12", salida: "2031-06-15", fechaLiberacion: "2031-06-05", liberadoEn: null, tipoLiberacion: null,
    pickup: { cuartosNocheBloqueados: 15, cuartosNocheConfirmados: 3, cuartosNocheLiberados: 0, cuartosNochePendientes: 12, cuartosNocheRetenidos: 15, porcentaje: 20 }, ...over,
  };
}
const detalleBloqueo = (over: Partial<BloqueoDetalle> = {}): BloqueoDetalle => ({
  ...bloqueo(),
  noches: [{ tipoHabitacionId: "rt1", fecha: "2031-06-12", bloqueados: 5, confirmados: 1, liberados: 0 }],
  rooming: [{ id: "h1", tipoHabitacionId: "rt1", huesped: "Luis Perez", llegada: "2031-06-12", salida: "2031-06-15", estado: "pendiente", reservaId: null }],
  ...over,
});

interface Mock { disponible?: boolean; cotizaciones?: Cotizacion[]; bloqueos?: Bloqueo[]; acceptStatus?: number }
function stub(m: Mock = {}) {
  const writes: { method: string; url: string; body: unknown }[] = [];
  const disponible = m.disponible ?? true;
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method !== "GET") {
      writes.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (url.endsWith("/aceptar")) return m.acceptStatus && m.acceptStatus !== 201 ? jsonResponse({ message: "Sin disponibilidad: no hay cuartos libres suficientes en alguna noche (no se bloqueo nada)." }, false, m.acceptStatus) : jsonResponse(detalleBloqueo(), true, 201);
      if (url.endsWith("/liberar")) return jsonResponse({ cuartosNocheLiberados: 12 });
      return jsonResponse(cotizacion());
    }
    if (url.endsWith("/grupos/cotizaciones")) return jsonResponse({ disponible, cotizaciones: m.cotizaciones ?? [cotizacion()] });
    if (url.endsWith("/grupos/bloqueos")) return jsonResponse({ disponible, bloqueos: m.bloqueos ?? [bloqueo()] });
    if (url.includes("/grupos/bloqueos/b1")) return jsonResponse(detalleBloqueo());
    if (url.endsWith("/tipos-habitacion")) return jsonResponse([{ id: "rt1", nombre: "Doble", capacidadMaxima: 2 }]);
    throw new Error(`fetch inesperado en el test: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { writes };
}

describe("GruposPage", () => {
  it("lista cotizaciones con total en pesos, anticipo registrado, vigencia y fecha de liberacion", async () => {
    stub();
    rendered = renderComponent(<GruposPage {...ctx("reservations")} />);
    await settle();
    expect(text()).toContain("Boda Garcia");
    expect(text()).toMatch(/20,250\.00/);
    expect(text()).toContain("Incluye 10 % de descuento");
    expect(text()).toContain("Libera el 2031-06-05");
    expect(text()).toContain("Enviada");
    expect(buttons("Aceptar y bloquear")).toHaveLength(1);
  });

  it("frontdesk y accountant ven pero no gestionan: sin Aceptar ni Nueva cotizacion", async () => {
    stub();
    rendered = renderComponent(<GruposPage {...ctx("frontdesk")} />);
    await settle();
    expect(buttons("Aceptar y bloquear")).toHaveLength(0);
    expect(tab("Nueva cotización")).toBeUndefined();
  });

  it("aceptar pide confirmacion (explica cutoff y no sobreventa) y manda POST .../aceptar; luego muestra el pickup", async () => {
    const { writes } = stub();
    rendered = renderComponent(<GruposPage {...ctx("owner")} />);
    await settle();
    click(buttons("Aceptar y bloquear")[0]!);
    await settle();
    expect(dialogo()!.textContent).toContain("No hay sobreventa");
    expect(dialogo()!.textContent).toContain("2031-06-05");
    await pulsarEnDialogo("Bloquear cuartos");
    await settle();
    expect(writes).toEqual([{ method: "POST", url: "https://api.test/hoteles/prop-1/grupos/cotizaciones/q1/aceptar", body: {} }]);
    expect(text()).toContain("Cuartos bloqueados.");
    expect(text()).toContain("Rooming list — Boda Garcia");
    expect(text()).toContain("3 de 15 cuartos-noche confirmados (20 %)");
  });

  it("sin cupo (409): muestra el motivo del servidor y no cambia nada", async () => {
    stub({ acceptStatus: 409 });
    rendered = renderComponent(<GruposPage {...ctx("owner")} />);
    await settle();
    click(buttons("Aceptar y bloquear")[0]!);
    await settle();
    await pulsarEnDialogo("Bloquear cuartos");
    await settle();
    expect(text()).toContain("Sin disponibilidad");
    expect(text()).not.toContain("Cuartos bloqueados.");
  });

  it("anticipo: pide importe en pesos y referencia, y manda centavos ENTEROS (solo registro, no cobra)", async () => {
    const { writes } = stub({ cotizaciones: [cotizacion({ estado: "aceptada" })] });
    rendered = renderComponent(<GruposPage {...ctx("accountant")} />);
    await settle();
    expect(buttons("Aceptar y bloquear")).toHaveLength(0);
    click(buttons("Registrar anticipo")[0]!);
    await settle();
    expect(dialogo()!.textContent).toContain("no se cobra nada");
    changeValue(dialogo()!.querySelector("input")!, "1.234");
    await pulsarEnDialogo("Continuar");
    expect(writes).toHaveLength(0); // mas de 2 decimales: el dialogo no deja continuar
    changeValue(dialogo()!.querySelector("input")!, "5,000.50");
    await pulsarEnDialogo("Continuar");
    await settle();
    changeValue(dialogo()!.querySelector("input")!, "SPEI-0001");
    await pulsarEnDialogo("Registrar");
    await settle();
    expect(writes).toEqual([{ method: "POST", url: "https://api.test/hoteles/prop-1/grupos/cotizaciones/q1/anticipos", body: { montoCentavos: 500_050, referencia: "SPEI-0001" } }]);
  });

  it("rechazar exige motivo de al menos 5 caracteres", async () => {
    const { writes } = stub();
    rendered = renderComponent(<GruposPage {...ctx("reservations")} />);
    await settle();
    click(buttons("Rechazar")[0]!);
    await settle();
    changeValue(dialogo()!.querySelector("textarea")!, "abc");
    await pulsarEnDialogo("Rechazar");
    expect(writes).toHaveLength(0);
    changeValue(dialogo()!.querySelector("textarea")!, "Muy caro para el cliente");
    await pulsarEnDialogo("Rechazar");
    await settle();
    expect(writes).toEqual([{ method: "POST", url: "https://api.test/hoteles/prop-1/grupos/cotizaciones/q1/cerrar", body: { resultado: "rechazada", motivo: "Muy caro para el cliente" } }]);
  });

  it("bloqueos: muestra pickup confirmados/bloqueados y cuenta regresiva; ver rooming list y liberar no confirmados", async () => {
    const { writes } = stub();
    rendered = renderComponent(<GruposPage {...ctx("reservations")} />);
    await settle();
    await abrirTab("Bloqueos y pickup");
    expect(text()).toContain("3 de 15 cuartos-noche (20 %)");
    expect(text()).toContain("12 sin confirmar");
    click(buttons("Ver rooming list")[0]!);
    await settle();
    expect(text()).toContain("Luis Perez");
    expect(buttons("Confirmar pickup")).toHaveLength(1);
    click(buttons("Liberar no confirmados")[0]!);
    await settle();
    expect(dialogo()!.textContent).toContain("12 cuartos-noche sin confirmar");
    await pulsarEnDialogo("Liberar");
    await settle();
    expect(writes[0]).toEqual({ method: "POST", url: "https://api.test/hoteles/prop-1/grupos/bloqueos/b1/liberar", body: {} });
  });

  it("crear cotizacion: importes en pesos se envian como centavos enteros y la vigencia como ISO; total estimado visible", async () => {
    const { writes } = stub();
    rendered = renderComponent(<GruposPage {...ctx("owner")} />);
    await settle();
    await abrirTab("Nueva cotización");
    const form = rendered.container.querySelector("form")!;
    const inputs = Array.from(form.querySelectorAll("input")) as HTMLInputElement[];
    const byLabel = (label: string) => inputs.find((i) => i.closest("label")?.textContent?.includes(label))!;
    changeValue(byLabel("Nombre del grupo"), "Boda Garcia");
    changeValue(byLabel("Llegada"), "2031-06-12");
    changeValue(byLabel("Salida"), "2031-06-15");
    changeValue(byLabel("Fecha de liberación"), "2031-06-05");
    changeValue(byLabel("vigente hasta"), "2031-05-08");
    changeValue(byLabel("Descuento"), "10");
    changeValue(byLabel("Anticipo requerido"), "5000");
    changeValue(form.querySelector('select[aria-label="Tipo de habitación 1"]') as HTMLSelectElement, "rt1");
    changeValue(form.querySelector('input[aria-label="Cuartos 1"]') as HTMLInputElement, "5");
    changeValue(form.querySelector('input[aria-label="Tarifa por noche 1"]') as HTMLInputElement, "1500");
    await settle();
    expect(text()).toMatch(/Total estimado: .*20,250\.00/);
    await submitForm(form);
    await settle();
    expect(writes).toHaveLength(1);
    const body = writes[0]!.body as Record<string, unknown>;
    expect(writes[0]!.url).toBe("https://api.test/hoteles/prop-1/grupos/cotizaciones");
    expect(body).toMatchObject({
      nombreGrupo: "Boda Garcia", llegada: "2031-06-12", salida: "2031-06-15", fechaLiberacion: "2031-06-05", descuentoBps: 1000, anticipoRequeridoCentavos: 500_000,
      renglones: [{ tipoHabitacionId: "rt1", cuartos: 5, tarifaCentavos: 150_000 }],
    });
    expect(String(body.vigenteHasta)).toMatch(/^2031-05-0[89]T.*Z$/);
  });

  it("una tarifa con 3 decimales no se envia: avisa y no crea nada", async () => {
    const { writes } = stub();
    rendered = renderComponent(<GruposPage {...ctx("owner")} />);
    await settle();
    await abrirTab("Nueva cotización");
    const form = rendered.container.querySelector("form")!;
    const inputs = Array.from(form.querySelectorAll("input")) as HTMLInputElement[];
    const byLabel = (label: string) => inputs.find((i) => i.closest("label")?.textContent?.includes(label))!;
    changeValue(byLabel("Nombre del grupo"), "Boda Garcia");
    changeValue(byLabel("Llegada"), "2031-06-12");
    changeValue(byLabel("Salida"), "2031-06-15");
    changeValue(byLabel("Fecha de liberación"), "2031-06-05");
    changeValue(byLabel("vigente hasta"), "2031-05-08");
    changeValue(form.querySelector('select[aria-label="Tipo de habitación 1"]') as HTMLSelectElement, "rt1");
    changeValue(form.querySelector('input[aria-label="Cuartos 1"]') as HTMLInputElement, "5");
    changeValue(form.querySelector('input[aria-label="Tarifa por noche 1"]') as HTMLInputElement, "1500.123");
    await submitForm(form);
    await settle();
    expect(writes).toHaveLength(0);
    expect(text()).toContain("tarifa en pesos");
  });

  it("base sin la migracion 036: avisa y no muestra pestanas", async () => {
    stub({ disponible: false, cotizaciones: [], bloqueos: [] });
    rendered = renderComponent(<GruposPage {...ctx("owner")} />);
    await settle();
    expect(text()).toContain("aún no están activos en esta base de datos");
    expect(tab("Cotizaciones")).toBeUndefined();
  });
});
