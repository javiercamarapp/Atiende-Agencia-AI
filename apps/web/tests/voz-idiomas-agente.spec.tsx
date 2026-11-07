// @vitest-environment jsdom
// Idiomas del agente de voz (cliente + seccion de la pestana Voz): catalogo del servidor (#712), estado honesto sin backend o sin la
// migracion 181, reglas locales (principal fuera de adicionales, tope, deteccion solo con adicionales) y PUT con el cuerpo exacto.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { conAdicional, conPrincipal, fetchIdiomasVoz, guardarIdiomasVoz, mismosIdiomas, sinAdicional } from "../src/verticals/restaurantes/lib/voz-idiomas-client.ts";
import { VozNoDisponibleError } from "../src/verticals/restaurantes/lib/voz-client.ts";
import { IdiomasAgenteVoz } from "../src/verticals/restaurantes/voz/IdiomasAgenteVoz.tsx";
import { click, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

const URL_IDIOMAS = "https://api.test/v1/restaurantes/prop-1/admin/agente/voz-idiomas";
const CATALOGO = [
  { codigo: "es-MX", nombre: "Español (México)" },
  { codigo: "en-US", nombre: "Inglés (Estados Unidos)" },
  { codigo: "fr-FR", nombre: "Francés" },
  { codigo: "ja-JP", nombre: "Japonés" },
];
const WIRE = { disponible: true, configurado: true, actualizadoEn: null, idiomas: { principal: "es-MX", adicionales: ["en-US"], deteccionAutomatica: true }, catalogo: CATALOGO, adicionalesMax: 2, nota: "x" };
const resp = (status: number, body?: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body ?? {} }) as unknown as Response;

describe("voz-idiomas-client", () => {
  it("GET: mapea el contrato de #712 y descarta codigos fuera del catalogo o iguales al principal", async () => {
    const f = vi.fn(async (url: string) => {
      expect(url).toBe(URL_IDIOMAS);
      return resp(200, { ...WIRE, idiomas: { principal: "es-MX", adicionales: ["en-US", "xx-XX", "es-MX"], deteccionAutomatica: true } });
    }) as unknown as typeof fetch;
    await expect(fetchIdiomasVoz(f, "https://api.test", "tok", "prop-1")).resolves.toEqual({
      configurado: true,
      idiomas: { principal: "es-MX", adicionales: ["en-US"], deteccionAutomatica: true },
      catalogo: CATALOGO,
      adicionalesMax: 2,
    });
  });

  it("404, 503 y base sin la 181 (disponible: false) -> VozNoDisponibleError", async () => {
    for (const r of [resp(404), resp(503), resp(200, { ...WIRE, disponible: false })]) {
      await expect(fetchIdiomasVoz(vi.fn(async () => r) as unknown as typeof fetch, "https://api.test", "tok", "prop-1")).rejects.toBeInstanceOf(VozNoDisponibleError);
    }
  });

  it("PUT: manda el cuerpo exacto y nunca deteccion sin adicionales", async () => {
    const cuerpos: unknown[] = [];
    const f = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.method).toBe("PUT");
      cuerpos.push(JSON.parse(init!.body as string));
      return resp(200, WIRE);
    }) as unknown as typeof fetch;
    await guardarIdiomasVoz(f, "https://api.test", "tok", "prop-1", { principal: "es-MX", adicionales: [], deteccionAutomatica: true });
    expect(cuerpos).toEqual([{ principal: "es-MX", adicionales: [], deteccionAutomatica: false }]);
  });

  it("reglas locales: principal sale de adicionales, tope, sin repetidos y deteccion se apaga al quedar sin adicionales", () => {
    const base = { principal: "es-MX", adicionales: ["en-US"], deteccionAutomatica: true } as const;
    expect(conPrincipal(base, "en-US")).toEqual({ principal: "en-US", adicionales: [], deteccionAutomatica: false });
    expect(conAdicional(base, "fr-FR", 2).adicionales).toEqual(["en-US", "fr-FR"]);
    expect(conAdicional(base, "en-US", 2)).toBe(base);
    expect(conAdicional(base, "es-MX", 2)).toBe(base);
    expect(conAdicional(base, "fr-FR", 1)).toBe(base);
    expect(sinAdicional(base, "en-US")).toEqual({ principal: "es-MX", adicionales: [], deteccionAutomatica: false });
    expect(mismosIdiomas(base, { ...base, adicionales: ["en-US"] })).toBe(true);
    expect(mismosIdiomas(base, { ...base, deteccionAutomatica: false })).toBe(false);
  });
});

let rendered: RenderedComponent | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
});

async function settle() {
  for (let i = 0; i < 10; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function pintar(fetchImpl: typeof fetch) {
  rendered = renderComponent(<IdiomasAgenteVoz apiBaseUrl="https://api.test" token="tok" propertyId="prop-1" fetchImpl={fetchImpl} />);
  await settle();
}
const texto = () => rendered!.container.textContent ?? "";
const boton = (t: string) => Array.from(rendered!.container.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent === t || b.getAttribute("aria-label") === t)!;

describe("<IdiomasAgenteVoz />", () => {
  it("sin el backend de #712: aviso honesto y ningun control editable", async () => {
    await pintar(vi.fn(async () => resp(404)) as unknown as typeof fetch);
    expect(rendered!.container.querySelector('[data-testid="idiomas-voz-no-disponible"]')!.textContent).toMatch(/No disponible aún: requiere el PR #712 y la migración 181/);
    expect(rendered!.container.querySelector('[role="switch"]')).toBeNull();
  });

  it("pinta lo guardado con nombres del catalogo del servidor; quitar el adicional apaga la deteccion y guarda con PUT", async () => {
    const puts: unknown[] = [];
    const f = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        const body = JSON.parse(init.body as string) as Record<string, unknown>;
        puts.push(body);
        return resp(200, { ...WIRE, idiomas: body });
      }
      return resp(200, WIRE);
    }) as unknown as typeof fetch;
    await pintar(f);
    expect(texto()).toContain("Inglés (Estados Unidos)");
    const sw = rendered!.container.querySelector<HTMLButtonElement>('[role="switch"]')!;
    expect(sw.getAttribute("aria-checked")).toBe("true");
    expect(boton("Guardar idiomas").disabled).toBe(true);

    click(boton("Quitar Inglés (Estados Unidos)"));
    await settle();
    expect(texto()).toContain("Sin idiomas adicionales");
    expect(sw.getAttribute("aria-checked")).toBe("false");
    expect(sw.disabled).toBe(true);
    expect(boton("Guardar idiomas").disabled).toBe(false);

    click(boton("Guardar idiomas"));
    await settle();
    expect(puts).toEqual([{ principal: "es-MX", adicionales: [], deteccionAutomatica: false }]);
    expect(texto()).toContain("Idiomas guardados.");
    expect(boton("Guardar idiomas").disabled).toBe(true);
  });

  it("error real al cargar: mensaje con Reintentar", async () => {
    let n = 0;
    const f = vi.fn(async () => (n++ === 0 ? resp(500, { error: { message: "boom" } }) : resp(200, WIRE))) as unknown as typeof fetch;
    await pintar(f);
    expect(texto()).toContain("No se pudieron cargar los idiomas del agente.");
    click(boton("Reintentar"));
    await settle();
    expect(texto()).toContain("Inglés (Estados Unidos)");
  });
});
