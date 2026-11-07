// @vitest-environment jsdom
//
// «Útil / No fue útil»: (1) el transporte del Copiloto (el mismo de las 6 verticales) hace PUT a la ruta real con solo {util, motivo} y
// los errores HTTP (503 base sin migrar, 404 mensaje ajeno) llegan como error; (2) la tarjeta del back office pinta conteos por
// organizacion, el % util sin inventar un 0 % y el aviso honesto sin la migracion 0076. `fetch` inyectado/simulado: sin red.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { crearTransporteCopiloto } from "../src/lib/copiloto/transporte.ts";
import { ValoracionesCopiloto, pctUtil, textoMotivos, type RespuestaValoraciones } from "../src/superadmin/components/ValoracionesCopiloto.tsx";
import { renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

const BASE = "https://api.example.test/hoteles/p1/chat-datos";
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("transporte: valorar", () => {
  it("PUT a .../conversaciones/:id/mensajes/:seq/valoracion con solo util y motivo", async () => {
    const llamadas: { url: string; init: RequestInit }[] = [];
    const t = crearTransporteCopiloto({
      baseUrl: BASE,
      token: "tok",
      fetchImpl: (async (url: string, init: RequestInit) => {
        llamadas.push({ url, init });
        return json(200, {});
      }) as unknown as typeof fetch,
    });
    await t.valorar!("c-1", 2, { util: true });
    await t.valorar!("c-1", 4, { util: false, motivo: "dato_incorrecto" });
    expect(llamadas.map((l) => [l.url, l.init.method, l.init.body])).toEqual([
      [`${BASE}/conversaciones/c-1/mensajes/2/valoracion`, "PUT", JSON.stringify({ util: true })],
      [`${BASE}/conversaciones/c-1/mensajes/4/valoracion`, "PUT", JSON.stringify({ util: false, motivo: "dato_incorrecto" })],
    ]);
    expect((llamadas[0]!.init.headers as Record<string, string>)["authorization"]).toBe("Bearer tok");
  });

  it("503 (sin la 0076) y 404 (mensaje ajeno) rechazan para que el boton lo diga", async () => {
    for (const status of [503, 404]) {
      const t = crearTransporteCopiloto({ baseUrl: BASE, token: "tok", fetchImpl: (async () => json(status, { message: "x" })) as unknown as typeof fetch });
      await expect(t.valorar!("c-1", 2, { util: true })).rejects.toBeInstanceOf(Error);
    }
  });
});

describe("back office: tarjeta de valoraciones", () => {
  let r: RenderedComponent | null = null;
  afterEach(() => {
    r?.unmount();
    r = null;
    vi.unstubAllGlobals();
  });

  it("textoMotivos y pctUtil: solo motivos con conteo; sin valoraciones no hay porcentaje", () => {
    expect(textoMotivos({ dato_incorrecto: 3, incompleta: 0, no_entendio: 1, otro: 0, sin_motivo: 0 })).toBe("3 dato mal · 1 no entendió");
    expect(textoMotivos({ dato_incorrecto: 0, incompleta: 0, no_entendio: 0, otro: 0, sin_motivo: 0 })).toBe("—");
    expect(pctUtil(3, 1)).toBe(75);
    expect(pctUtil(0, 0)).toBeNull();
  });

  async function montar(respuesta: Response) {
    vi.stubGlobal("fetch", vi.fn(async () => respuesta));
    r = renderComponent(<ValoracionesCopiloto apiBaseUrl="https://api.test" token="tok" />);
    await act(async () => {
      for (let i = 0; i < 6; i++) await Promise.resolve();
    });
    return r.container;
  }

  it("pinta una fila por organizacion con sus conteos", async () => {
    const datos: RespuestaValoraciones = {
      disponible: true,
      dias: 30,
      total: { utiles: 4, noUtiles: 2, motivos: { dato_incorrecto: 2, incompleta: 0, no_entendio: 0, otro: 0, sin_motivo: 0 } },
      filas: [{ vertical: "restaurantes", organizacionId: "o1", organizacion: "Los Taquitos de PM", utiles: 4, noUtiles: 2, motivos: { dato_incorrecto: 2, incompleta: 0, no_entendio: 0, otro: 0, sin_motivo: 0 } }],
    };
    const c = await montar(json(200, datos));
    const tarjeta = c.querySelector('[data-testid="valoraciones-copiloto"]')!;
    expect(tarjeta.textContent).toContain("Los Taquitos de PM");
    expect(tarjeta.textContent).toContain("2 dato mal");
    expect(c.textContent).toContain("6 valoraciones");
  });

  it("sin la migracion 0076: aviso honesto, sin tabla de ceros", async () => {
    const c = await montar(json(200, { disponible: false, mensaje: "Las valoraciones todavía no están disponibles: falta aplicar la actualización de base de datos (0076).", dias: 30, total: { utiles: 0, noUtiles: 0, motivos: {} }, filas: [] }));
    expect(c.textContent).toContain("No disponible aún");
    expect(c.querySelector("table")).toBeNull();
  });
});
