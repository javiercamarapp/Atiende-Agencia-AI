// @vitest-environment jsdom
//
// D-13: dialogo "Importar ZIP o varios XML" -- ZIP descomprimido en el navegador y enviado en tandas de 50, progreso, resumen con la tabla de
// resultados, notify y CANCELAR (detiene las tandas pendientes, no revierte las hechas y lo dice). `fetch` mockeado por la ruta real.
import { act } from "react";
import { strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";

const notifyMock = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock("@atiende/ui", async (importOriginal) => ({ ...(await importOriginal<typeof import("@atiende/ui")>()), notify: notifyMock }));

import { ImportarLoteDialog } from "../src/verticals/despachos/components/ImportarLoteDialog.tsx";
import { CfdiPage } from "../src/verticals/despachos/pages/Cfdi.tsx";
import type { DespachosShellContext } from "../src/verticals/despachos/DespachosShell.tsx";
import { click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

const URL_LOTE = "https://api.test/despachos/prop-1/cfdi/importar-lote";
const xml = (n: number) => strToU8(`<cfdi:Comprobante n="${n}"/>`);

function zipDe(n: number): File {
  const entradas = Object.fromEntries(Array.from({ length: n }, (_, i) => [`f${i}.xml`, xml(i)]));
  const bytes = zipSync(entradas);
  return new File([bytes as BlobPart], "sat.zip", { type: "application/zip" });
}

function respuestaDe(nombres: string[]): Response {
  const resultados = nombres.map((archivo) => ({ archivo, estado: "ingerido", clase: "cfdi", folioFiscal: null, motivo: null }));
  const totales = { recibidos: nombres.length, ingeridos: nombres.length, enRevision: 0, duplicados: 0, rechazados: 0, reps: 0 };
  return { ok: true, status: 200, json: async () => ({ loteId: "l", resultados, totales, ignorados: 0 }) } as unknown as Response;
}
const nombresDe = (init: RequestInit) => (init.body as FormData).getAll("archivos").map((f) => (f as File).name);

async function montar(onTerminado = vi.fn()) {
  rendered = renderComponent(<ImportarLoteDialog open onOpenChange={() => undefined} apiBaseUrl="https://api.test" token="tok" propertyId="prop-1" onTerminado={onTerminado} />);
  await act(async () => {
    await flushMicrotasks();
  });
  return onTerminado;
}
function elegir(archivos: File[]) {
  const input = document.body.querySelector<HTMLInputElement>("#cfdi-lote-archivos")!;
  Object.defineProperty(input, "files", { value: archivos, configurable: true });
  act(() => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
const boton = (re: RegExp) => [...document.body.querySelectorAll("button")].find((b) => re.test(b.textContent ?? ""));
async function esperar(cond: () => boolean) {
  for (let i = 0; i < 80 && !cond(); i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
}

describe("ImportarLoteDialog", () => {
  it("un ZIP de 120 XML se descomprime en el navegador y viaja en 3 tandas (50, 50, 20); muestra progreso final, resumen y tabla; avisa y recarga", async () => {
    const tandas: string[][] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      if (url !== URL_LOTE) throw new Error(`fetch inesperado: ${url}`);
      const n = nombresDe(init);
      tandas.push(n);
      return respuestaDe(n);
    }));
    const onTerminado = await montar();
    elegir([zipDe(120)]);
    click(boton(/^Importar$/)!);
    await esperar(() => document.body.textContent?.includes("120 archivo(s):") ?? false);
    expect(tandas.map((t) => t.length)).toEqual([50, 50, 20]);
    expect(document.body.textContent).toContain("120 ingeridos");
    expect(document.body.querySelectorAll("table tbody tr").length).toBeGreaterThan(0);
    expect(notifyMock.success).toHaveBeenCalledWith(expect.stringContaining("120 CFDI nuevos"));
    expect(onTerminado).toHaveBeenCalledTimes(1);
  });

  it("CANCELAR: la tanda en vuelo termina, las pendientes NO se envian y el resumen dice que lo ya importado no se revierte", async () => {
    let liberar!: () => void;
    const primera = new Promise<void>((r) => (liberar = r));
    const enviadas: string[][] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const n = nombresDe(init);
      enviadas.push(n);
      if (enviadas.length === 1) await primera;
      return respuestaDe(n);
    }));
    const onTerminado = await montar();
    elegir([zipDe(120)]);
    click(boton(/^Importar$/)!);
    await esperar(() => enviadas.length === 1);
    expect(document.body.querySelector('[role="progressbar"]')).not.toBeNull();
    click(boton(/Cancelar importación/)!);
    await act(async () => {
      liberar();
      await flushMicrotasks();
    });
    await esperar(() => document.body.textContent?.includes("Importación cancelada") ?? false);
    expect(enviadas).toHaveLength(1);
    expect(document.body.textContent).toMatch(/quedaron 70 archivo\(s\) sin enviar/);
    expect(document.body.textContent).toMatch(/NO se revierte/);
    expect(notifyMock.warning).toHaveBeenCalledWith(expect.stringContaining("no se revierten"));
    expect(onTerminado).toHaveBeenCalledTimes(1);
  });

  it("varios XML sueltos: un archivo que no es XML se omite y se dice; un ZIP con '..' se rechaza completo sin llamar al servidor", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => respuestaDe(nombresDe(init)));
    vi.stubGlobal("fetch", fetchMock);
    await montar();
    elegir([new File([xml(1) as BlobPart], "a.xml"), new File(["x"], "notas.txt")]);
    click(boton(/^Importar$/)!);
    await esperar(() => document.body.textContent?.includes("1 archivo(s):") ?? false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toMatch(/1 archivo\(s\) que no son XML se omitieron/);

    fetchMock.mockClear();
    click(boton(/Importar otro lote/)!);
    elegir([new File([zipSync({ "../x.xml": xml(1) }) as BlobPart], "malo.zip", { type: "application/zip" })]);
    click(boton(/^Importar$/)!);
    await esperar(() => document.body.querySelector('[role="alert"]') !== null);
    expect(document.body.querySelector('[role="alert"]')!.textContent).toMatch(/ruta no permitida/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("un fallo del servidor en la segunda tanda detiene el resto, lo informa y conserva lo ya importado", async () => {
    let n = 0;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      n += 1;
      if (n === 2) return { ok: false, status: 500, json: async () => ({ message: "Error interno" }), text: async () => "" } as unknown as Response;
      return respuestaDe(nombresDe(init));
    }));
    await montar();
    elegir([zipDe(120)]);
    click(boton(/^Importar$/)!);
    await esperar(() => document.body.querySelector('[role="alert"]') !== null);
    expect(n).toBe(2);
    expect(document.body.textContent).toMatch(/La importación se detuvo/);
    expect(document.body.textContent).toMatch(/Quedaron 70 archivo\(s\) sin enviar/);
    expect(notifyMock.error).toHaveBeenCalled();
  });
});

describe("CfdiPage — acceso a la carga masiva", () => {
  const CTX: DespachosShellContext = { apiBaseUrl: "https://api.test", token: "tok", propertyId: "prop-1", orgSlug: "demo", role: "contador", staffFullName: "C", staffEmail: "c@example.com" };
  async function montarPagina(role: string) {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const body = url.includes("/efos") ? { lista: { periodo: null, disponible: false }, alertas: [] } : [];
      return { ok: true, status: 200, headers: new Headers(), json: async () => body } as unknown as Response;
    }));
    rendered = renderComponent(
      <MemoryRouter>
        <CfdiPage {...CTX} role={role} />
      </MemoryRouter>,
    );
    await act(async () => {
      await flushMicrotasks();
      await flushMicrotasks();
    });
  }
  it("contador ve el boton y abre el dialogo; auditor no lo ve", async () => {
    await montarPagina("contador");
    const b = boton(/Importar ZIP o varios XML/);
    expect(b).toBeDefined();
    click(b!);
    await act(async () => {
      await flushMicrotasks();
    });
    expect(document.body.querySelector("#cfdi-lote-archivos")).not.toBeNull();
    rendered?.unmount();
    document.body.innerHTML = "";
    await montarPagina("auditor");
    expect(boton(/Importar ZIP o varios XML/)).toBeUndefined();
  });
});
