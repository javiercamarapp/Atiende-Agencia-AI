// @vitest-environment jsdom
//
// D-P3-13/22 (jsdom): tarjeta de clasificacion contable en el detalle del CFDI (ver, corregir, historial, sin migrar, rol), ajustes por cliente en Configuracion
// (umbral >= piso, autoaceptado), correcciones por RFC (alta, validacion, baja, sin migrar) y la lista de CFDI (categoria, duplicado, filtro de la campana).
import { act } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CfdiDetallePage } from "../src/verticals/despachos/pages/CfdiDetalle.tsx";
import { CfdiPage } from "../src/verticals/despachos/pages/Cfdi.tsx";
import { ConfiguracionPage } from "../src/verticals/despachos/pages/Configuracion.tsx";
import { CorreccionesRfcCard } from "../src/verticals/despachos/components/CorreccionesRfcCard.tsx";
import type { DespachosShellContext } from "../src/verticals/despachos/DespachosShell.tsx";
import { changeValue, click, flushMicrotasks, renderComponent, submitForm, type RenderedComponent } from "./test-utils/render.tsx";
import { installMatchMediaStub, installMemoryLocalStorage } from "./test-utils/memory-storage.ts";

const notifyMock = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock("@atiende/ui", async (importOriginal) => ({ ...(await importOriginal<typeof import("@atiende/ui")>()), notify: notifyMock }));

const CTX = (role: string): DespachosShellContext => ({ apiBaseUrl: "https://api.test", token: "tok", propertyId: "p1", orgSlug: "demo", role, staffFullName: "Staff", staffEmail: "s@example.com" });
const CATALOGO = { categorias: [{ id: "equipo_computo", nombre: "Equipo de cómputo" }, { id: "seguros", nombre: "Seguros" }], pisoConfianza: 0.5, umbralPorOmision: 0.7 };
const CLASIF_SISTEMA = { categoria: "otros", nombre: "Otros gastos", confianza: 0.3, metodo: "reglas", razon: "Sin coincidencias en la descripción ni ClaveProdServ conocida", cuenta: null, empate: false, porPersona: false, creadaEn: "2026-07-02T10:00:00Z" };
const CLASIF_EMPATE = { ...CLASIF_SISTEMA, categoria: "renta_oficina", nombre: "Renta de oficina o local", confianza: 0.45, empate: true, razon: "Empate entre 2 categorías: renta, laptop" };
const INVOICE = {
  id: "inv1", folioFiscal: "AAAA1111-BBBB-2222-CCCC-DDDDEEEEFFFF", tipo: "I", rfcEmisor: "AAA010101AAA", rfcReceptor: "BBB020202BBB", emisorNombre: "Proveedor SA", subtotal: 1000, total: 1160, iva: 160, descuento: 0,
  categoria: "sin_clasificar", valido: true, issues: [], warnings: [], requiereRevisionHumana: false, diot: { proveedoresReportables: [], reportable: false }, creadoEn: "2026-03-01T00:00:00Z", estadoSat: "pendiente", estadoSatVerificadoEn: null,
  clasificacionEstado: "ok", clasificacion: CLASIF_EMPATE, clasificacionHistorial: [CLASIF_EMPATE],
};

let llamadas: { url: string; method: string; body: unknown }[];
let rendered: RenderedComponent | undefined;
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });
const esperar = async () => {
  for (let i = 0; i < 6; i++) await act(async () => flushMicrotasks());
};
const boton = (texto: string, raiz: ParentNode = document.body) => [...raiz.querySelectorAll("button")].find((b) => b.textContent?.includes(texto)) as HTMLButtonElement | undefined;
const porId = (id: string) => document.getElementById(id) as HTMLInputElement & HTMLSelectElement;

beforeEach(() => {
  installMatchMediaStub();
  installMemoryLocalStorage();
  llamadas = [];
});
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

function stub(rutas: (url: string, method: string, body: unknown) => Response | undefined) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const crudo = init?.body ? String(init.body) : undefined;
      const body = crudo === undefined ? undefined : crudo.startsWith("<") ? crudo : JSON.parse(crudo);
      llamadas.push({ url, method, body });
      return rutas(url, method, body) ?? json({}, 404);
    }),
  );
}

async function montarDetalle(role: string) {
  rendered = renderComponent(
    <MemoryRouter initialEntries={["/cfdi/inv1"]}>
      <Routes>
        <Route path="/cfdi/:invoiceId" element={<CfdiDetallePage {...CTX(role)} />} />
      </Routes>
    </MemoryRouter>,
  );
  await esperar();
}

describe("CfdiDetalle -- clasificacion contable", () => {
  it("muestra la categoria, de donde salio, la confianza y el empate; un empate dice que el sistema nunca elige solo", async () => {
    stub((url, m) => (m === "GET" && url.endsWith("/cfdi/inv1") ? json(INVOICE) : url.endsWith("/revisiones") ? json([]) : url.endsWith("/clasificacion/catalogo") ? json(CATALOGO) : undefined));
    await montarDetalle("contador");
    const texto = document.body.textContent ?? "";
    expect(texto).toContain("Clasificación contable");
    expect(texto).toContain("Renta de oficina o local");
    expect(texto).toContain("Decidida por el sistema");
    expect(texto).toContain("Empate: revisar");
    expect(texto).toContain("nunca elige una por su cuenta");
  });

  it("el contador corrige: elige categoria, cuenta y 'recordar'; manda PUT .../categoria, avisa, y vuelve a pedir el CFDI", async () => {
    let corregido = false;
    stub((url, m, body) => {
      if (m === "GET" && url.endsWith("/cfdi/inv1")) return json(corregido ? { ...INVOICE, clasificacion: { ...CLASIF_SISTEMA, categoria: "equipo_computo", nombre: "Equipo de cómputo", confianza: 1, metodo: "manual", porPersona: true, razon: "Corrección humana" }, clasificacionHistorial: [CLASIF_SISTEMA, CLASIF_EMPATE] } : INVOICE);
      if (url.endsWith("/revisiones")) return json([]);
      if (url.endsWith("/clasificacion/catalogo")) return json(CATALOGO);
      if (m === "PUT" && url.endsWith("/cfdi/inv1/categoria")) {
        corregido = true;
        return json({ clasificacionId: "c9", clasificacion: null });
      }
      void body;
      return undefined;
    });
    await montarDetalle("contador");
    expect(boton("Guardar categoría")!.disabled).toBe(true);
    changeValue(porId("clasif-categoria"), "equipo_computo");
    changeValue(porId("clasif-cuenta"), "1600000");
    click(document.body.querySelector('input[type="checkbox"]')!);
    click(boton("Guardar categoría")!);
    await esperar();
    const put = llamadas.find((l) => l.method === "PUT")!;
    expect(put.url).toBe("https://api.test/despachos/p1/cfdi/inv1/categoria");
    expect(put.body).toEqual({ categoria: "equipo_computo", cuenta: "1600000", guardarRegla: true });
    expect(notifyMock.success).toHaveBeenCalledWith("Categoría guardada. Los siguientes CFDI de este emisor la usarán.");
    expect(document.body.textContent).toContain("Indicada por una persona");
    expect(document.body.textContent).toContain("Historial");
  });

  it("un error del servidor al guardar se ve en pantalla y no cambia lo mostrado", async () => {
    stub((url, m) => {
      if (m === "GET" && url.endsWith("/cfdi/inv1")) return json(INVOICE);
      if (url.endsWith("/revisiones")) return json([]);
      if (url.endsWith("/clasificacion/catalogo")) return json(CATALOGO);
      if (m === "PUT") return json({ code: "service_unavailable", message: "La clasificación contable aún no está disponible en esta base de datos (falta aplicar la migración 026)." }, 503);
      return undefined;
    });
    await montarDetalle("contador");
    changeValue(porId("clasif-categoria"), "seguros");
    click(boton("Guardar categoría")!);
    await esperar();
    expect(document.body.querySelector('[role="alert"]')?.textContent ?? "").toContain("migración 026");
    expect(document.body.textContent).toContain("Renta de oficina o local");
  });

  it("base sin migrar: lo dice en vez de inventar una categoria, y no ofrece corregir; el auditor ve pero no corrige", async () => {
    stub((url, m) => (m === "GET" && url.endsWith("/cfdi/inv1") ? json({ ...INVOICE, clasificacionEstado: "no_disponible", clasificacion: null, clasificacionHistorial: [] }) : url.endsWith("/revisiones") ? json([]) : undefined));
    await montarDetalle("contador");
    expect(document.body.textContent).toContain("falta aplicar la migración 026");
    expect(boton("Guardar categoría")).toBeUndefined();
    rendered?.unmount();
    stub((url, m) => (m === "GET" && url.endsWith("/cfdi/inv1") ? json(INVOICE) : url.endsWith("/revisiones") ? json([]) : undefined));
    await montarDetalle("auditor");
    expect(document.body.textContent).toContain("Renta de oficina o local");
    expect(document.body.textContent).toContain("Tu rol no puede corregir la categoría");
    expect(boton("Guardar categoría")).toBeUndefined();
    expect(llamadas.some((l) => l.url.endsWith("/clasificacion/catalogo"))).toBe(false);
  });

  it("un CFDI excluido por una revision rechazada lo dice (no cuenta en reportes ni polizas)", async () => {
    stub((url, m) => (m === "GET" && url.endsWith("/cfdi/inv1") ? json({ ...INVOICE, excluidoPorRevision: true }) : url.endsWith("/revisiones") ? json([]) : url.endsWith("/clasificacion/catalogo") ? json(CATALOGO) : undefined));
    await montarDetalle("contador");
    const t = document.body.textContent ?? "";
    expect(t).toContain("Excluido de los reportes");
    expect(t).toContain("ya no cuenta en la DIOT");
  });
});

describe("Configuracion -- ajustes de clasificacion y portal", () => {
  const rutas = (ajustes: unknown = { estado: "disponible", umbralConfianza: 0.7, portalAutoaceptarValidos: true, pisoConfianza: 0.5 }, put?: () => Response) => (url: string, m: string): Response | undefined => {
    if (m === "GET" && url.endsWith("/configuracion")) return json({ configuracion: { propertyId: "p1", organizationId: "o1", zonaHoraria: null } });
    if (m === "GET" && url.endsWith("/clasificacion/ajustes")) return json(ajustes);
    if (m === "PUT" && url.endsWith("/clasificacion/ajustes")) return (put ?? (() => json({ estado: "disponible", umbralConfianza: 0.8, portalAutoaceptarValidos: false, pisoConfianza: 0.5 })))();
    return undefined;
  };
  const montar = async (role = "admin") => {
    rendered = renderComponent(
      <MemoryRouter>
        <ConfiguracionPage {...CTX(role)} />
      </MemoryRouter>,
    );
    await esperar();
  };

  it("carga los valores del cliente, valida el umbral contra el piso ANTES de enviar y guarda umbral + autoaceptado", async () => {
    stub(rutas());
    await montar();
    expect(porId("clasif-umbral").value).toBe("0.7");
    changeValue(porId("clasif-umbral"), "0.4");
    expect(document.body.textContent).toContain("No puede ser menor que el piso de confianza (0.5)");
    expect(boton("Guardar", document.getElementById("clasif-umbral")!.closest("form")!)!.disabled).toBe(true);
    changeValue(porId("clasif-umbral"), "0,8");
    click(document.body.querySelector('form input[type="checkbox"]')!);
    await submitForm(document.getElementById("clasif-umbral")!.closest("form") as HTMLFormElement);
    await esperar();
    const put = llamadas.find((l) => l.method === "PUT")!;
    expect(put.body).toEqual({ umbralConfianza: 0.8, portalAutoaceptarValidos: false });
    expect(document.body.textContent).toContain("Guardado");
  });

  it("un rechazo del servidor se muestra; sin migrar dice que no esta disponible; un contador ni la ve (la pagina es del admin)", async () => {
    stub(rutas(undefined, () => json({ code: "validation", message: "umbralConfianza: no puede ser mayor que 1." }, 400)));
    await montar();
    changeValue(porId("clasif-umbral"), "0.9");
    await submitForm(document.getElementById("clasif-umbral")!.closest("form") as HTMLFormElement);
    await esperar();
    expect(document.body.querySelector('form [role="alert"]')?.textContent ?? "").toContain("mayor que 1");
    rendered?.unmount();
    stub(rutas({ estado: "no_disponible", umbralConfianza: 0.7, portalAutoaceptarValidos: true, pisoConfianza: 0.5 }));
    await montar();
    expect(document.body.textContent).toContain("falta aplicar la migración 026");
    expect(document.getElementById("clasif-umbral")).toBeNull();
    rendered?.unmount();
    stub(rutas());
    await montar("contador");
    expect(document.body.textContent).toContain("reservado al administrador");
    expect(document.getElementById("clasif-umbral")).toBeNull();
  });
});

describe("Correcciones por RFC emisor", () => {
  const CORR = { id: "k1", rfcEmisor: "AAA010101AAA", claveProdServ: null, categoria: "seguros", nombre: "Seguros", cuenta: null, creadaEn: "2026-07-01T00:00:00Z", actualizadaEn: "2026-07-02T00:00:00Z" };
  const montar = async (estado: "ok" | "no_disponible" = "ok", correcciones: unknown[] = [CORR]) => {
    stub((url, m) => {
      if (m === "GET" && url.endsWith("/clasificacion/correcciones")) return json({ estado, correcciones: estado === "ok" ? correcciones : [] });
      if (m === "GET" && url.endsWith("/clasificacion/catalogo")) return json(CATALOGO);
      if (m === "PUT" && url.endsWith("/clasificacion/correcciones")) return json({ id: "k2" });
      if (m === "DELETE" && url.endsWith("/clasificacion/correcciones/k1")) return json({ eliminada: true });
      return undefined;
    });
    rendered = renderComponent(<CorreccionesRfcCard apiBaseUrl="https://api.test" token="tok" propertyId="p1" />);
    await esperar();
  };

  it("lista las reglas guardadas en el servidor y permite quitar una (DELETE real)", async () => {
    await montar();
    expect(document.body.textContent).toContain("AAA010101AAA");
    expect(document.body.textContent).toContain("Seguros");
    click(boton("Quitar")!);
    await esperar();
    expect(llamadas.some((l) => l.method === "DELETE" && l.url.endsWith("/clasificacion/correcciones/k1"))).toBe(true);
  });

  it("alta: el boton solo se habilita con RFC valido, categoria y datos opcionales bien formados; manda PUT con lo capturado", async () => {
    await montar("ok", []);
    expect(document.body.textContent).toContain("Todavía no hay reglas");
    expect(boton("Guardar regla")!.disabled).toBe(true);
    changeValue(porId("corr-rfc"), "malo");
    changeValue(porId("corr-categoria"), "seguros");
    expect(boton("Guardar regla")!.disabled).toBe(true);
    changeValue(porId("corr-rfc"), "bbb020202bb2");
    changeValue(porId("corr-cp"), "12");
    expect(boton("Guardar regla")!.disabled).toBe(true);
    changeValue(porId("corr-cp"), "43211503");
    changeValue(porId("corr-cuenta"), "6080100");
    expect(boton("Guardar regla")!.disabled).toBe(false);
    await submitForm(document.getElementById("corr-rfc")!.closest("form") as HTMLFormElement);
    await esperar();
    expect(llamadas.find((l) => l.method === "PUT")!.body).toEqual({ rfcEmisor: "BBB020202BB2", claveProdServ: "43211503", categoria: "seguros", cuenta: "6080100" });
  });

  it("sin migrar: lo dice y no ofrece el formulario", async () => {
    await montar("no_disponible");
    expect(document.body.textContent).toContain("falta aplicar la migración 026");
    expect(document.getElementById("corr-rfc")).toBeNull();
  });
});

describe("Lista de CFDI", () => {
  const FILA = { ...INVOICE, id: "inv1", clasificacion: { ...CLASIF_SISTEMA, categoria: "equipo_computo", nombre: "Equipo de cómputo", confianza: 0.9 } };
  const montar = async (url = "/cfdi", rutas?: (u: string, m: string, b: unknown) => Response | undefined) => {
    stub((u, m, b) => rutas?.(u, m, b) ?? (m === "GET" && u.includes("/despachos/p1/cfdi?") || (m === "GET" && u.endsWith("/despachos/p1/cfdi")) ? json([FILA, { ...FILA, id: "inv2", excluidoPorRevision: true, clasificacion: null }]) : u.endsWith("/revisiones") ? json([]) : u.includes("/efos") ? json({ lista: { periodo: null, disponible: false }, alertas: [] }) : undefined));
    rendered = renderComponent(
      <MemoryRouter initialEntries={[url]}>
        <CfdiPage {...CTX("contador")} />
      </MemoryRouter>,
    );
    await esperar();
  };

  it("muestra la categoria con su confianza y marca el CFDI excluido por una revision rechazada", async () => {
    await montar();
    const t = document.body.textContent ?? "";
    expect(t).toContain("Equipo de cómputo");
    expect(t).toContain("90 %");
    expect(t).toContain("Rechazada (excluido)");
  });

  it("el enlace de la campana (?revision=1) abre la lista ya filtrada a revision humana pendiente", async () => {
    await montar("/cfdi?revision=1");
    expect(llamadas.some((l) => l.url.includes("/despachos/p1/cfdi?") && l.url.includes("requiereRevisionHumana=true"))).toBe(true);
  });

  it("importar un XML cuyo UUID ya existe en el cliente dice 'ya existía' (no se duplicó), no 'importado correctamente'", async () => {
    await montar("/cfdi", (u, m) => (m === "POST" && u.endsWith("/cfdi/importar-xml") ? json({ ...FILA, duplicado: true }, 200) : undefined));
    const input = document.body.querySelector('input[type="file"]') as HTMLInputElement;
    const archivo = new File(["<x/>"], "a.xml", { type: "application/xml" });
    Object.defineProperty(input, "files", { value: [archivo], configurable: true });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await flushMicrotasks();
    });
    await esperar();
    expect(document.body.textContent).toContain("ya existía en este cliente: no se duplicó");
    expect(document.body.textContent).not.toContain("importado correctamente");
  });
});
