// @vitest-environment jsdom
//
// Importar menu (alta autoservicio): subir CSV -> revision (los sin precio quedan sin marcar) -> corregir un precio -> guardar lo
// marcado. Fetch falso: se verifica el payload que sale y la pantalla de resultado.
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImportarMenuDialog } from "../src/verticals/restaurantes/components/ImportarMenuDialog.tsx";
import { aBase64 } from "../src/verticals/restaurantes/lib/menu-importar-client.ts";
import { changeValue, click, esperarHasta, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
});

function respuesta(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const BORRADOR = {
  categorias: ["Tacos"],
  productos: [
    { nombre: "Taco de pastor", categoria: "Tacos", descripcion: null, precio: 25, esPaquete: false, incluye: [], dudas: [] },
    { nombre: "Gringa", categoria: "Tacos", descripcion: null, precio: null, esPaquete: false, incluye: [], dudas: ["sin_precio"] },
  ],
  ilegibles: 1,
  recortado: false,
};

describe("ImportarMenuDialog", () => {
  it("CSV -> revision -> corregir precio -> guardar solo lo marcado", async () => {
    const llamadas: Array<{ url: string; body: unknown }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      llamadas.push({ url: u, body: JSON.parse(String(init?.body)) });
      if (u.endsWith("/extraer")) return respuesta(200, { fuente: "csv", borrador: BORRADOR });
      return respuesta(201, { creados: 2, omitidos: 0, categoriasCreadas: 1 });
    }) as unknown as typeof fetch;
    const onTerminado = vi.fn();
    rendered = renderComponent(<ImportarMenuDialog open onOpenChange={() => {}} apiBaseUrl="https://api.test" token="t" propertyId="p1" fetchImpl={fetchImpl} onTerminado={onTerminado} />);

    const input = document.querySelector("#menu-import-archivo") as HTMLInputElement;
    const archivo = new File(["nombre,precio\nTaco de pastor,25\nGringa,\n"], "menu.csv", { type: "text/csv" });
    Object.defineProperty(input, "files", { value: [archivo] });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await esperarHasta(() => document.querySelector('[data-testid="menu-revision"]') !== null, "pantalla de revision");
    expect(llamadas[0]!.body).toEqual({ csv: "nombre,precio\nTaco de pastor,25\nGringa,\n" });
    expect(document.body.textContent).toContain("1 renglones no se pudieron leer");

    const boton = () => [...document.querySelectorAll("button")].find((b) => b.textContent?.startsWith("Guardar"))!;
    expect(boton().textContent).toContain("Guardar 1 producto");

    // Corregir el precio de la Gringa y marcarla.
    changeValue(document.querySelector('input[aria-label="Precio de Gringa"]') as HTMLInputElement, "45");
    click(document.querySelector('input[aria-label="Guardar Gringa"]')!);
    await esperarHasta(() => boton().textContent!.includes("Guardar 2 productos"), "dos marcados");
    click(boton());
    await esperarHasta(() => document.querySelector('[data-testid="menu-resultado"]') !== null, "resultado");
    expect(llamadas[1]!.url).toBe("https://api.test/v1/restaurantes/p1/admin/menu/importar/guardar");
    expect(llamadas[1]!.body).toEqual({
      productos: [
        { nombre: "Taco de pastor", categoria: "Tacos", descripcion: null, precio: 25 },
        { nombre: "Gringa", categoria: "Tacos", descripcion: null, precio: 45 },
      ],
    });
    expect(onTerminado).toHaveBeenCalledTimes(1);
  });

  it("archivo de mas de 3 MB: aviso sin llamar al servidor", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    rendered = renderComponent(<ImportarMenuDialog open onOpenChange={() => {}} apiBaseUrl="https://api.test" token="t" propertyId="p1" fetchImpl={fetchImpl} onTerminado={() => {}} />);
    const input = document.querySelector("#menu-import-archivo") as HTMLInputElement;
    const grande = new File([new Uint8Array(3 * 1024 * 1024 + 1)], "menu.pdf", { type: "application/pdf" });
    Object.defineProperty(input, "files", { value: [grande] });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await esperarHasta(() => document.body.textContent!.includes("pesa más de 3 MB"), "aviso de tamaño");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("aBase64 en trozos coincide con Buffer", () => {
    const bytes = new Uint8Array(100_000).map((_, i) => i % 256);
    expect(aBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
  });
});
