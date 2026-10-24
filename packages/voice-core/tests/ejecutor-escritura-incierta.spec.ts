// Una escritura (crear_pedido) cuya respuesta no llega por una falla de RED o un 5xx de pasarela (no solo por el timeout propio) tambien queda INCIERTA: el servidor pudo
// registrarla antes de que la conexion se cortara. Antes se devolvia "Error interno" sin marca: el modelo reintentaba a ciegas o le decia al cliente que no quedo.
import { describe, expect, it } from "vitest";
import { crearEjecutorTools, transporteHttp } from "../src/llamada/ejecutor-tools.ts";
import type { RegistroToolsVoz, TransporteTools } from "../src/llamada/ejecutor-tools.ts";

const registro: RegistroToolsVoz = {
  definiciones: () => ["crear_pedido", "cotizar_pedido"].map((name) => ({ name, description: name, parameters: { type: "object" as const, properties: {} } })),
  herramientasInciertas: ["crear_pedido"],
  mensajeIncierto: "INCIERTO: no asegure el pedido.",
};
const ejecutor = (transporte: TransporteTools) => crearEjecutorTools({ registro, transporte, timeoutMs: 1_000 });

describe("escritura incierta por falla de red o 5xx", () => {
  it("crear_pedido: una conexion cortada (excepcion no abortada) devuelve el aviso de INCIERTO y marca timeout+incierto para la maquina", async () => {
    const r = await ejecutor(async () => { throw new Error("ECONNRESET"); }).ejecutar("crear_pedido", {});
    expect(r.resultado).toMatchObject({ error: "INCIERTO: no asegure el pedido.", incierto: true });
    expect(r.ok).toBe(false);
    expect(r.timeout).toBe(true);
    expect(r.entidadId).toBeNull();
  });
  it("una herramienta de solo lectura con la misma falla sigue siendo un error interno comun, sin marca de incierto", async () => {
    const r = await ejecutor(async () => { throw new Error("ECONNRESET"); }).ejecutar("cotizar_pedido", {});
    expect(r.resultado).toEqual({ error: "Error interno al ejecutar la herramienta" });
    expect(r.timeout).toBe(false);
  });
  it("transporte HTTP: un 502/504 sin cuerpo JSON de la API (pasarela) en crear_pedido llega como INCIERTO", async () => {
    for (const status of [502, 503, 504]) {
      const t = transporteHttp({ raiz: "https://api.invalid/v1", ruta: () => "/x", cabeceras: {}, fetchFn: (async () => new Response("<html>gateway</html>", { status })) as typeof fetch });
      const r = await ejecutor(t).ejecutar("crear_pedido", {});
      expect(r.resultado, `status ${status}`).toMatchObject({ incierto: true });
    }
  });
  it("transporte HTTP: un 4xx/5xx CON mensaje de la API (regla de negocio) sigue llegando tal cual al modelo", async () => {
    const t = transporteHttp({ raiz: "https://api.invalid/v1", ruta: () => "/x", cabeceras: {}, fetchFn: (async () => new Response(JSON.stringify({ message: "La sucursal esta cerrada" }), { status: 422 })) as typeof fetch });
    const r = await ejecutor(t).ejecutar("crear_pedido", {});
    expect(r.resultado).toEqual({ error: "La sucursal esta cerrada" });
    expect(r.timeout).toBe(false);
  });
});
