// @vitest-environment jsdom
//
// <EncuestasPage />: satisfaccion de clientes, configuracion y envio de pendientes (R-41). `fetch` inyectado por ruta real
// (lib/encuesta-client.ts). Cubre: cifras exactas, "—" con razon (nunca 0 inventado), por sucursal y repartidor, comentarios sin PII,
// base sin migrar, error con reintento, cambio de periodo y alcance, guardar la configuracion (validacion local y del servidor),
// envio de pendientes (resultado real, error) y rol sin acceso.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EncuestasPage } from "../src/verticals/restaurantes/pages/Encuestas.tsx";
import { changeValue, click, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
});

const BASE = "https://api.test/v1/restaurantes/prop-1/admin/encuestas";
const URL_RESUMEN = (dias: number, alcance = "organizacion") => `${BASE}/resumen?dias=${dias}&alcance=${alcance}`;
const CONFIG = { activa: true, esperaMin: 30, resenasUrl: "https://g.page/r/ejemplo/review", umbralResena: 4 };

function resumen(parcial: Record<string, unknown> = {}) {
  return {
    disponible: true, zonaHoraria: "America/Mexico_City", hoy: "2026-03-10", desde: "2026-02-09", hasta: "2026-03-10", alcance: "organizacion",
    resumen: { enviadas: 4, respondidas: 3, promedio: 3.67, tasaRespuestaPct: 75, distribucion: [0, 1, 0, 1, 1] },
    porSucursal: [
      { propertyId: "p1", nombre: "Centro", enviadas: 3, respondidas: 2, promedio: 3.5, tasaRespuestaPct: 66.7 },
      { propertyId: "p2", nombre: "Norte", enviadas: 1, respondidas: 1, promedio: 4, tasaRespuestaPct: 100 },
    ],
    porRepartidor: [{ repartidorId: "r1", nombre: "Repartidor Uno", enviadas: 3, respondidas: 2, promedio: 3.5, tasaRespuestaPct: 66.7 }],
    recientes: [
      { id: "e1", pedido: 1042, propertyId: "p1", sucursal: "Centro", calificacion: 2, comentario: "Llego frio", respondidaAt: "2026-03-09T19:30:00.000Z", repartidor: "Repartidor Uno" },
      { id: "e2", pedido: null, propertyId: "p2", sucursal: "Norte", calificacion: 5, comentario: null, respondidaAt: "2026-03-09T19:00:00.000Z", repartidor: null },
    ],
    ...parcial,
  };
}

type Respuesta = { status: number; body?: unknown };
const res = (r: Respuesta) => ({ ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body ?? {} }) as unknown as Response;

type Rutas = Record<string, Respuesta | Respuesta[]>;
function stub(rutas: Rutas) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const clave = `${init?.method ?? "GET"} ${url}`;
    const r = rutas[clave];
    if (!r) throw new Error(`fetch inesperado: ${clave}`);
    return res(Array.isArray(r) ? (r.length > 1 ? (r.shift() as Respuesta) : (r[0] as Respuesta)) : r);
  });
}
const BASE_RUTAS = (): Rutas => ({
  [`GET ${URL_RESUMEN(30)}`]: { status: 200, body: resumen() },
  [`GET ${BASE}/config`]: { status: 200, body: { disponible: true, config: CONFIG } },
});

async function settle() {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}
async function pintar(fetchMock: ReturnType<typeof stub>, role = "owner") {
  rendered = renderComponent(<EncuestasPage apiBaseUrl="https://api.test" token="tok" propertyId="prop-1" orgSlug="demo" role={role} staffFullName={undefined} staffEmail="a@b.c" fetchImpl={fetchMock as unknown as typeof fetch} />);
  await settle();
}
const texto = () => rendered!.container.textContent ?? "";
const boton = (t: RegExp) => Array.from(rendered!.container.querySelectorAll("button")).find((b) => t.test(b.textContent ?? "")) as HTMLButtonElement | undefined;
const input = (etiqueta: RegExp) => {
  const label = Array.from(rendered!.container.querySelectorAll("label")).find((l) => etiqueta.test(l.textContent ?? ""));
  return rendered!.container.querySelector<HTMLInputElement>(`#${label!.getAttribute("for")}`)!;
};

describe("<EncuestasPage />", () => {
  it("muestra las cifras reales: promedio, tasa de respuesta, distribucion, por sucursal, por repartidor y comentarios", async () => {
    await pintar(stub(BASE_RUTAS()));
    const t = texto();
    expect(t).toContain("Calificación promedio");
    expect(t).toContain("3.67");
    expect(t).toContain("3 respuestas de 1 a 5");
    expect(t).toContain("75%");
    expect(t).toContain("3 de 4 encuestas enviadas");
    expect(t).toContain("Encuestas enviadas");
    expect(t).toContain("Calificaciones bajas");
    expect(t).toContain("Centro");
    expect(t).toContain("Norte");
    expect(t).toContain("Repartidor Uno");
    expect(t).toContain("Llego frio");
    expect(t).toContain("#1042");
    expect(t).toContain("Sin comentario");
    expect(t).toContain("Los pedidos para recoger no cuentan aquí");
    expect(t).not.toMatch(/\+52|tel[eé]fono:/i);
  });

  it("sin respuestas ni envios: guiones con razon, nunca 0 ni 0%", async () => {
    const vacio = resumen({ resumen: { enviadas: 0, respondidas: 0, promedio: null, tasaRespuestaPct: null, distribucion: [0, 0, 0, 0, 0] }, porSucursal: [], porRepartidor: [], recientes: [] });
    await pintar(stub({ ...BASE_RUTAS(), [`GET ${URL_RESUMEN(30)}`]: { status: 200, body: vacio } }));
    const t = texto();
    expect(t).toContain("Sin respuestas en el periodo.");
    expect(t).toContain("Sin encuestas enviadas en el periodo.");
    expect(t).not.toContain("0%");
    expect(t).toContain("Sin entregas encuestadas");
  });

  it("base sin migrar (disponible=false o 503): estado honesto en la lectura y en la configuracion", async () => {
    await pintar(stub({ [`GET ${URL_RESUMEN(30)}`]: { status: 200, body: { disponible: false } }, [`GET ${BASE}/config`]: { status: 503 } }));
    expect(texto()).toContain("Encuestas no disponibles todavía");
    expect(texto()).toContain("aún no está activa");
    expect(rendered!.container.querySelector("[data-testid=encuestas-resumen]")).toBeNull();
    expect(boton(/guardar configuración/i)).toBeUndefined();
  });

  it("error del servidor: mensaje y reintento que vuelve a pedir", async () => {
    const f = stub({ ...BASE_RUTAS(), [`GET ${URL_RESUMEN(30)}`]: [{ status: 500 }, { status: 200, body: resumen() }] });
    await pintar(f);
    expect(boton(/reintentar/i)).toBeDefined();
    click(boton(/reintentar/i)!);
    await settle();
    expect(texto()).toContain("Calificación promedio");
  });

  it("cambiar el periodo o el alcance vuelve a pedir con esos parametros", async () => {
    const f = stub({
      ...BASE_RUTAS(),
      [`GET ${URL_RESUMEN(60)}`]: { status: 200, body: resumen() },
      [`GET ${URL_RESUMEN(60, "sucursal")}`]: { status: 200, body: resumen({ alcance: "sucursal" }) },
    });
    await pintar(f);
    changeValue(rendered!.container.querySelector("select#periodo-encuestas") as HTMLSelectElement, "60");
    await settle();
    changeValue(rendered!.container.querySelector("select#alcance-encuestas") as HTMLSelectElement, "sucursal");
    await settle();
    expect(f).toHaveBeenCalledWith(URL_RESUMEN(60), expect.anything());
    expect(f).toHaveBeenLastCalledWith(URL_RESUMEN(60, "sucursal"), expect.anything());
  });

  it("rol sin acceso (staff): aviso y NO se llama a la API", async () => {
    const f = stub({});
    await pintar(f, "staff");
    expect(texto()).toContain("Solo los roles");
    expect(f).not.toHaveBeenCalled();
  });

  it("guardar la configuracion manda el PUT con los valores editados y confirma", async () => {
    const f = stub({ ...BASE_RUTAS(), [`PUT ${BASE}/config`]: { status: 200, body: { disponible: true, config: { ...CONFIG, esperaMin: 45, umbralResena: 5 } } } });
    await pintar(f);
    changeValue(input(/minutos de espera/i), "45");
    changeValue(input(/invitar a reseñar/i), "5");
    click(boton(/guardar configuración/i)!);
    await settle();
    const llamada = f.mock.calls.find(([, init]) => init?.method === "PUT")!;
    expect(llamada[0]).toBe(`${BASE}/config`);
    expect(JSON.parse(String(llamada[1]!.body))).toEqual({ activa: true, esperaMin: 45, resenasUrl: "https://g.page/r/ejemplo/review", umbralResena: 5 });
    expect(texto()).toContain("Configuración guardada.");
  });

  it("validacion local: espera fuera de rango no llama a la API", async () => {
    const f = stub(BASE_RUTAS());
    await pintar(f);
    changeValue(input(/minutos de espera/i), "2");
    click(boton(/guardar configuración/i)!);
    await settle();
    expect(texto()).toContain("La espera debe ser un entero de 5 a 1440 minutos.");
    expect(f.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(false);
  });

  it("el servidor rechaza la liga: se muestra su mensaje y no se confirma", async () => {
    const f = stub({ ...BASE_RUTAS(), [`PUT ${BASE}/config`]: { status: 400, body: { message: "La liga de reseñas debe ser una URL https válida." } } });
    await pintar(f);
    changeValue(input(/liga de reseñas/i), "http://x.test");
    click(boton(/guardar configuración/i)!);
    await settle();
    expect(texto()).toContain("La liga de reseñas debe ser una URL https válida.");
    expect(texto()).not.toContain("Configuración guardada.");
  });

  it("enviar pendientes ahora: POST real y resultado con encoladas, omitidas y errores", async () => {
    const f = stub({ ...BASE_RUTAS(), [`POST ${BASE}/enviar-pendientes`]: { status: 200, body: { disponible: true, candidatas: 3, encoladas: 1, yaRegistradas: 0, omitidas: { telefono_invalido: 1, sin_canal_whatsapp: 0 }, errores: 1 } } });
    await pintar(f);
    click(boton(/enviar pendientes ahora/i)!);
    await settle();
    const t = rendered!.container.querySelector("[data-testid=resultado-envio]")?.textContent ?? "";
    expect(t).toContain("1 encuesta encolada de 3 pendientes");
    expect(t).toContain("1 omitidas");
    expect(t).toContain("1 con error");
    expect(f.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("con la encuesta apagada NO se ofrece enviar pendientes", async () => {
    await pintar(stub({ ...BASE_RUTAS(), [`GET ${BASE}/config`]: { status: 200, body: { disponible: true, config: { ...CONFIG, activa: false } } } }));
    expect(boton(/enviar pendientes ahora/i)).toBeUndefined();
    expect(boton(/guardar configuración/i)).toBeDefined();
  });

  it("enviar pendientes: un 429 muestra el mensaje y no un resultado", async () => {
    const f = stub({ ...BASE_RUTAS(), [`POST ${BASE}/enviar-pendientes`]: { status: 429, body: { message: "Demasiadas solicitudes." } } });
    await pintar(f);
    click(boton(/enviar pendientes ahora/i)!);
    await settle();
    expect(texto()).toContain("Demasiadas solicitudes.");
    expect(rendered!.container.querySelector("[data-testid=resultado-envio]")).toBeNull();
  });
});
