// @vitest-environment jsdom
//
// L-27 -- pestana "Garantias y hitos" de la post-adjudicacion. `fetch` global mockeado por ruta real: se verifica lo que se
// ve (vigencia, estados efectivos, plazos con la nota de "validar con abogado", honestidad con la base sin migrar), que cada
// accion dispare metodo/ruta/cuerpo reales (montos como cadena, Idempotency-Key en las altas), que descartar un dialogo NO
// escriba y que el rol oculte lo que el servidor rechazaria.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GarantiasHitosPanel } from "../src/verticals/licitaciones/components/GarantiasHitosPanel.tsx";
import { changeValue, click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

const BASE = "https://api.test/licitaciones/prop-1/tenders/t-1/contract/post-award";

type Handler = (init?: RequestInit) => { ok?: boolean; status?: number; body: unknown };

function stubFetch(routes: Record<string, Handler>) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${url.replace(BASE, "")}`;
    const handler = routes[key];
    if (!handler) return { ok: false, status: 500, json: async () => ({ message: `sin ruta ${key}` }) } as unknown as Response;
    const r = handler(init);
    return { ok: r.ok ?? true, status: r.status ?? (r.ok === false ? 409 : 200), json: async () => r.body } as unknown as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 10; i++) await flushMicrotasks();
  });
}

const text = () => document.body.textContent ?? "";
const boton = (t: string) => [...document.body.querySelectorAll("button")].find((b) => b.textContent?.trim() === t);
const dialogo = () => document.body.querySelector("[role='dialog']") as HTMLElement | null;
const llamadas = (method: string, path: string) => fetchMock.mock.calls.filter(([url, init]) => `${(init as RequestInit | undefined)?.method ?? "GET"} ${String(url).replace(BASE, "")}` === `${method} ${path}`);
const cuerpo = (call: unknown[]) => JSON.parse(String((call[1] as RequestInit).body));
const cabeceras = (call: unknown[]) => (call[1] as RequestInit).headers as Record<string, string>;

/** Control del dialogo por el texto de su etiqueta. */
function campo(etiqueta: string): HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement {
  const label = [...dialogo()!.querySelectorAll("label")].find((l) => l.textContent?.trim().startsWith(etiqueta));
  if (!label) throw new Error(`sin campo "${etiqueta}"`);
  return document.getElementById(label.getAttribute("for")!) as HTMLInputElement;
}

async function enviar(textoBoton: string) {
  const b = [...dialogo()!.querySelectorAll("button")].find((x) => x.textContent?.trim() === textoBoton)!;
  await act(async () => {
    b.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    for (let i = 0; i < 10; i++) await flushMicrotasks();
  });
}

const GARANTIA_ENTREGADA = {
  id: "g-1",
  contractId: "c-1",
  tipo: "cumplimiento",
  monto: "125000.50",
  porcentaje: 10,
  afianzadora: "Afianzadora Demo",
  numeroPoliza: "POL-1",
  vigenciaDesde: "2026-01-01",
  vigenciaHasta: "2026-10-20",
  fechaLimiteEntrega: null,
  entregadaEn: "2026-01-05",
  estado: "entregada",
  notas: null,
  vigencia: { estadoEfectivo: "entregada", vencidaPorFecha: false, porVencer: true, diasParaVencer: 15, entregaVencida: false },
};
const GARANTIA_PENDIENTE = { ...GARANTIA_ENTREGADA, id: "g-2", tipo: "anticipo", monto: "2500000.00", porcentaje: null, afianzadora: null, numeroPoliza: null, vigenciaHasta: "2027-01-01", fechaLimiteEntrega: "2026-09-30", entregadaEn: null, estado: "pendiente_entrega", vigencia: { estadoEfectivo: "pendiente_entrega", vencidaPorFecha: false, porVencer: false, diasParaVencer: 88, entregaVencida: true } };
const HITO = { id: "h-1", contractId: "c-1", titulo: "Entrega de la etapa 1", descripcion: null, responsableId: "u-1", fechaCompromiso: "2026-10-01", estado: "pendiente", cumplidoEn: null, vigencia: { estadoEfectivo: "vencido", vencido: true, diasDeRetraso: 4 } };
const CONVENIO = { id: "v-1", numero: 1, tipo: "monto_plazo", montoDelta: "-5000.00", nuevaFechaFin: "2027-03-31", fechaFinAnterior: "2026-12-31", fechaFirma: "2026-10-01", motivo: "Ajuste acordado", createdAt: "2026-10-01T12:00:00.000Z" };

const OVERVIEW = (over: Record<string, unknown> = {}) => ({
  available: true,
  hoy: "2026-10-05",
  puedeEscribir: true,
  puedeDecidir: true,
  contract: { id: "c-1", status: "en_ejecucion", endDate: "2027-03-31" },
  plazos: { falloNotificadoEn: "2026-11-12", plazoFirmaDias: 3, firmadoEn: null, plazoGarantiaDias: 2 },
  plazosCalculados: { fechaLimiteFirma: "2026-11-18", fechaLimiteEntregaGarantia: null, firmaVencida: false, nota: "Plazo legal no verificado contra la fuente primaria: validar con abogado.", calendarioNota: "Se excluyen sábados, domingos y 20 días inhábiles oficiales." },
  garantias: [GARANTIA_ENTREGADA, GARANTIA_PENDIENTE],
  hitos: [HITO],
  convenios: [CONVENIO],
  resumen: { garantiasEntregadas: 1, garantiasPendientes: 1, garantiasPorVencer: 1, garantiasVencidas: 0, garantiasEntregaVencida: 1, hitosPendientes: 1, hitosVencidos: 1, ajusteDeMontoAcumulado: "-5000.00" },
  ...over,
});
const BITACORA = { bitacora: [{ id: "b-1", entidad: "garantia", entidadId: "g-1", accion: "cambio_estado", detalle: { estado: "entregada", estado_anterior: "pendiente_entrega" }, actorId: "u-1", createdAt: "2026-10-01T12:00:00.000Z" }] };
const RESPONSABLES = { responsables: [{ userId: "u-1", nombre: "Ana Analista", rol: "analyst" }, { userId: "u-2", nombre: "Walter Writer", rol: "writer" }] };

function montar() {
  rendered = renderComponent(<GarantiasHitosPanel apiBaseUrl="https://api.test" token="tok" propertyId="prop-1" tenderId="t-1" />);
}

function rutasBase(overview: () => unknown = () => OVERVIEW()): Record<string, Handler> {
  return { "GET ": () => ({ body: overview() }), "GET /bitacora": () => ({ body: BITACORA }), "GET /responsables": () => ({ body: RESPONSABLES }) };
}

describe("pestana de garantias y hitos", () => {
  it("muestra garantias con su vigencia y estado efectivo, hitos con retraso, plazos con la nota legal, convenios y bitacora", async () => {
    stubFetch(rutasBase());
    montar();
    await settle();
    const t = text();
    expect(t).toContain("Garantías del contrato");
    expect(t).toContain("Cumplimiento");
    expect(t).toContain("$125,000.50 · 10%");
    expect(t).toContain("Afianzadora Demo · Póliza POL-1");
    expect(t).toContain("vence en 15 días");
    expect(t).toContain("Entrega vencida");
    expect(t).toContain("$2,500,000.00");
    expect(t).toContain("Pendiente de entrega");
    expect(t).toContain("Ana Analista"); // el responsable sale del equipo, no del id
    expect(t).toContain("4 días de retraso");
    expect(t).toContain("Convenio 1");
    expect(t).toContain("-$5,000.00");
    expect(t).toContain("Ajuste de monto acumulado");
    expect(t).toContain("Cambio de estado");
    expect(t).toContain("Validar con abogado");
    expect(t).toContain("no verificado contra la fuente primaria");
    expect(t).toContain("Límite para firmar el contrato");
    expect(boton("Nueva garantía")).toBeDefined();
    expect(boton("Registrar convenio")).toBeDefined();
  });

  it("base sin la migracion 035: lo dice y no ofrece ningun control que no pueda funcionar", async () => {
    stubFetch({ "GET ": () => ({ body: { available: false, hoy: "2026-10-05", puedeEscribir: true, puedeDecidir: true } }) });
    montar();
    await settle();
    expect(text()).toContain("aún no disponibles");
    expect(text()).toContain("migración 035");
    expect(boton("Nueva garantía")).toBeUndefined();
    expect(boton("Nuevo hito")).toBeUndefined();
    expect(llamadas("GET", "/bitacora")).toHaveLength(0);
  });

  it("un error del servidor al cargar se muestra con reintento (404 sin contrato incluido)", async () => {
    stubFetch({ "GET ": () => ({ ok: false, status: 404, body: { message: "No existe contrato registrado para esta convocatoria todavía; regístrelo primero con POST .../contract." } }) });
    montar();
    await settle();
    expect(text()).toContain("No existe contrato registrado");
  });

  it("el rol limita lo visible: un lector no ve altas ni acciones; un writer no ve liberar ni convenios", async () => {
    stubFetch(rutasBase(() => OVERVIEW({ puedeEscribir: false, puedeDecidir: false })));
    montar();
    await settle();
    expect(boton("Nueva garantía")).toBeUndefined();
    expect(boton("Nuevo hito")).toBeUndefined();
    expect(boton("Editar plazos")).toBeUndefined();
    expect(boton("Registrar convenio")).toBeUndefined();
    expect(boton("Editar")).toBeUndefined();
    rendered!.unmount();

    stubFetch(rutasBase(() => OVERVIEW({ puedeEscribir: true, puedeDecidir: false })));
    montar();
    await settle();
    expect(boton("Nueva garantía")).toBeDefined();
    expect(boton("Liberar")).toBeUndefined();
    expect(boton("Registrar convenio")).toBeUndefined();
  });

  it("nueva garantia: POST real con el monto como cadena, Idempotency-Key y recarga; el dialogo se cierra y avisa", async () => {
    let garantias: unknown[] = [];
    stubFetch({
      ...rutasBase(() => OVERVIEW({ garantias })),
      "POST /garantias": () => {
        garantias = [GARANTIA_ENTREGADA];
        return { status: 201, body: GARANTIA_ENTREGADA };
      },
    });
    montar();
    await settle();
    click(boton("Nueva garantía")!);
    await settle();
    expect(dialogo()!.textContent).toContain("Nueva garantía");
    await act(async () => {
      changeValue(campo("Monto") as HTMLInputElement, " 125000.50 ");
      changeValue(campo("Porcentaje") as HTMLInputElement, "10");
      changeValue(campo("Afianzadora") as HTMLInputElement, "Afianzadora Demo");
      changeValue(campo("Número de póliza") as HTMLInputElement, "POL-1");
      changeValue(campo("Vigencia desde") as HTMLInputElement, "2026-01-01");
      changeValue(campo("Vigencia hasta") as HTMLInputElement, "2026-10-20");
    });
    await enviar("Registrar garantía");
    const [post] = llamadas("POST", "/garantias");
    expect(cuerpo(post!)).toMatchObject({ tipo: "cumplimiento", monto: "125000.50", porcentaje: 10, afianzadora: "Afianzadora Demo", numeroPoliza: "POL-1", vigenciaDesde: "2026-01-01", vigenciaHasta: "2026-10-20" });
    expect(typeof cuerpo(post!).monto).toBe("string");
    expect(cabeceras(post!)["idempotency-key"]).toMatch(/.{8,}/);
    expect(dialogo()).toBeNull();
    expect(text()).toContain("Garantía registrada");
  });

  it("validacion local sin red: monto invalido o vigencia invertida muestran el error y NO escriben", async () => {
    stubFetch(rutasBase());
    montar();
    await settle();
    click(boton("Nueva garantía")!);
    await settle();
    await act(async () => {
      changeValue(campo("Monto") as HTMLInputElement, "12.345");
      changeValue(campo("Vigencia desde") as HTMLInputElement, "2026-10-01");
      changeValue(campo("Vigencia hasta") as HTMLInputElement, "2026-09-01");
    });
    await enviar("Registrar garantía");
    expect(dialogo()!.textContent).toContain("cantidad válida");
    await act(async () => {
      changeValue(campo("Monto") as HTMLInputElement, "12.34");
    });
    await enviar("Registrar garantía");
    expect(dialogo()!.textContent).toContain("no puede ser anterior");
    expect(llamadas("POST", "/garantias")).toHaveLength(0);
  });

  it("cerrar el dialogo SIN guardar nunca escribe", async () => {
    stubFetch(rutasBase());
    montar();
    await settle();
    click(boton("Nueva garantía")!);
    await settle();
    await act(async () => {
      changeValue(campo("Monto") as HTMLInputElement, "500.00");
    });
    click(document.body.querySelector("[aria-label='Cerrar']")!);
    await settle();
    expect(dialogo()).toBeNull();
    expect(fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method && (init as RequestInit).method !== "GET")).toHaveLength(0);
  });

  it("un error del servidor al guardar se muestra y el dialogo conserva lo escrito", async () => {
    stubFetch({ ...rutasBase(), "POST /garantias": () => ({ ok: false, status: 409, body: { message: "Máximo 30 garantías por contrato." } }) });
    montar();
    await settle();
    click(boton("Nueva garantía")!);
    await settle();
    await act(async () => {
      changeValue(campo("Monto") as HTMLInputElement, "500.00");
      changeValue(campo("Vigencia desde") as HTMLInputElement, "2026-01-01");
      changeValue(campo("Vigencia hasta") as HTMLInputElement, "2026-12-31");
    });
    await enviar("Registrar garantía");
    expect(dialogo()!.textContent).toContain("Máximo 30 garantías");
    expect((campo("Monto") as HTMLInputElement).value).toBe("500.00");
  });

  it("liberar: pide confirmacion; 'Cancelar' no escribe y confirmar manda PATCH {estado: liberada}", async () => {
    stubFetch({ ...rutasBase(), "PATCH /garantias/g-1": () => ({ body: { ...GARANTIA_ENTREGADA, estado: "liberada" } }) });
    montar();
    await settle();
    click(boton("Liberar")!);
    await settle();
    expect(text()).toContain("Liberar la garantía");
    click(boton("Cancelar")!);
    await settle();
    expect(llamadas("PATCH", "/garantias/g-1")).toHaveLength(0);
    click(boton("Liberar")!);
    await settle();
    await act(async () => {
      click([...document.body.querySelectorAll("[role='alertdialog'] button, [role='dialog'] button")].find((b) => b.textContent?.trim() === "Liberar")!);
      for (let i = 0; i < 10; i++) await flushMicrotasks();
    });
    const [patch] = llamadas("PATCH", "/garantias/g-1");
    expect(cuerpo(patch!)).toEqual({ estado: "liberada" });
    expect(text()).toContain("Garantía liberada");
  });

  it("marcar entregada pide la fecha real y manda PATCH {estado, entregadaEn}", async () => {
    stubFetch({ ...rutasBase(), "PATCH /garantias/g-2": () => ({ body: { ...GARANTIA_PENDIENTE, estado: "entregada" } }) });
    montar();
    await settle();
    click(boton("Marcar entregada")!);
    await settle();
    expect((campo("Fecha de entrega") as HTMLInputElement).value).toBe("2026-10-05"); // sugiere hoy, editable
    await act(async () => {
      changeValue(campo("Fecha de entrega") as HTMLInputElement, "2026-10-03");
    });
    await enviar("Marcar entregada");
    expect(cuerpo(llamadas("PATCH", "/garantias/g-2")[0]!)).toEqual({ estado: "entregada", entregadaEn: "2026-10-03" });
  });

  it("nuevo hito: el responsable sale del equipo; POST real con Idempotency-Key", async () => {
    stubFetch({ ...rutasBase(), "POST /hitos": () => ({ status: 201, body: HITO }) });
    montar();
    await settle();
    click(boton("Nuevo hito")!);
    await settle();
    const opciones = [...(campo("Responsable") as HTMLSelectElement).options].map((o) => o.textContent);
    expect(opciones).toEqual(["Elige a una persona", "Ana Analista", "Walter Writer"]);
    await act(async () => {
      changeValue(campo("Título") as HTMLInputElement, "Capacitación al personal");
      changeValue(campo("Responsable") as HTMLSelectElement, "u-2");
      changeValue(campo("Fecha comprometida") as HTMLInputElement, "2026-12-01");
    });
    await enviar("Registrar hito");
    const [post] = llamadas("POST", "/hitos");
    expect(cuerpo(post!)).toMatchObject({ titulo: "Capacitación al personal", responsableId: "u-2", fechaCompromiso: "2026-12-01" });
    expect(cabeceras(post!)["idempotency-key"]).toBeTruthy();
    expect(text()).toContain("Hito registrado");
  });

  it("hito cumplido: confirma y manda PATCH {estado: cumplido}", async () => {
    stubFetch({ ...rutasBase(), "PATCH /hitos/h-1": () => ({ body: { ...HITO, estado: "cumplido" } }) });
    montar();
    await settle();
    click(boton("Cumplido")!);
    await settle();
    await act(async () => {
      click([...document.body.querySelectorAll("[role='alertdialog'] button, [role='dialog'] button")].find((b) => b.textContent?.trim() === "Marcar cumplido")!);
      for (let i = 0; i < 10; i++) await flushMicrotasks();
    });
    expect(cuerpo(llamadas("PATCH", "/hitos/h-1")[0]!)).toEqual({ estado: "cumplido" });
  });

  it("plazos: guarda dias y fechas reales por PUT (vacio = null) y avisa cuantas garantias se recalcularon", async () => {
    stubFetch({ ...rutasBase(), "PUT /plazos": () => ({ body: { plazos: {}, plazosCalculados: {}, garantiasActualizadas: 1 } }) });
    montar();
    await settle();
    click(boton("Editar plazos")!);
    await settle();
    await act(async () => {
      changeValue(campo("Días hábiles para firmar") as HTMLInputElement, "0");
    });
    await enviar("Guardar plazos");
    expect(dialogo()!.textContent).toContain("entre 1 y 90");
    expect(llamadas("PUT", "/plazos")).toHaveLength(0);
    await act(async () => {
      changeValue(campo("Días hábiles para firmar") as HTMLInputElement, "15");
      changeValue(campo("Contrato firmado el") as HTMLInputElement, "");
    });
    await enviar("Guardar plazos");
    expect(cuerpo(llamadas("PUT", "/plazos")[0]!)).toEqual({ falloNotificadoEn: "2026-11-12", plazoFirmaDias: 15, firmadoEn: null, plazoGarantiaDias: 2 });
    expect(text()).toContain("recalculó");
  });

  it("convenio: el ajuste viaja como cadena con signo, con la nueva fecha de fin, y deja avisar el historial", async () => {
    stubFetch({ ...rutasBase(), "POST /convenios": () => ({ status: 201, body: { convenio: CONVENIO, contratoFechaFin: "2027-03-31" } }) });
    montar();
    await settle();
    click(boton("Registrar convenio")!);
    await settle();
    await act(async () => {
      changeValue(campo("Tipo") as HTMLSelectElement, "monto_plazo");
    });
    await act(async () => {
      changeValue(campo("Ajuste de monto") as HTMLInputElement, "-5000.00");
      changeValue(campo("Nueva fecha de fin") as HTMLInputElement, "2027-03-31");
      changeValue(campo("Fecha de firma") as HTMLInputElement, "2026-10-01");
      changeValue(campo("Motivo") as HTMLTextAreaElement, "Ajuste acordado");
    });
    await enviar("Registrar convenio");
    const [post] = llamadas("POST", "/convenios");
    expect(cuerpo(post!)).toEqual({ tipo: "monto_plazo", montoDelta: "-5000.00", nuevaFechaFin: "2027-03-31", fechaFirma: "2026-10-01", motivo: "Ajuste acordado" });
    expect(cabeceras(post!)["idempotency-key"]).toBeTruthy();
    expect(text()).toContain("Convenio modificatorio registrado");
  });
});
