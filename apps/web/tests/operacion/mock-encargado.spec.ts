// El mock del encargado cumple el contrato y se comporta como el servidor: las respuestas pasan por `conContrato` (lanza si se desvian).
import { describe, expect, it } from "vitest";
import { rutasOperacionEncargado } from "../../e2e/mock-api/fixtures/operacion-encargado.ts";
import type { Peticion } from "../../e2e/mock-api/tipos.ts";

function estadoFalso() {
  const m = new Map<string, unknown>();
  return { obtener: <T,>(k: string, s: () => T): T => (m.has(k) ? (m.get(k) as T) : (m.set(k, s()), m.get(k) as T)), guardar: (k: string, v: unknown) => void m.set(k, v) };
}
function peticion(estado: ReturnType<typeof estadoFalso>, metodo: string, params: Record<string, string> = {}, cuerpo: unknown = null): Peticion {
  return { metodo, ruta: "", query: new URLSearchParams(), cuerpo, params, persona: null, cabeceras: {}, estado } as unknown as Peticion;
}
const ruta = (metodo: string, fragmento: string) => rutasOperacionEncargado.find((r) => r.metodo === metodo && r.patron.endsWith(fragmento))!;
const cuerpoDe = (r: unknown) => (r as { cuerpo?: unknown; status?: number }).cuerpo ?? r;
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("mock del encargado", () => {
  it("la cola cumple el contrato y trae acciones del servidor por estado", async () => {
    const e = estadoFalso();
    const r = (await ruta("GET", "/operacion/cola").manejador(peticion(e, "GET"))) as { cuerpo: { pedidos: Array<{ numero: number; accionesDisponibles: string[] }> } };
    const por = new Map(r.cuerpo.pedidos.map((p) => [p.numero, p.accionesDisponibles]));
    expect(por.get(150)).toContain("aceptar");
    expect(por.get(149)).toContain("listo");
    expect(por.get(146)).toContain("salio");
  });

  it("aceptar es idempotente y se refleja en la cola; listo de recoger pasa a listo_para_recoger", async () => {
    const e = estadoFalso();
    const status = ruta("PATCH", "/status");
    const a1 = await status.manejador(peticion(e, "PATCH", { orderId: uuid(150) }, { status: "preparando" }));
    expect(cuerpoDe(a1)).toEqual({ yaAplicado: false });
    const a2 = await status.manejador(peticion(e, "PATCH", { orderId: uuid(150) }, { status: "preparando" }));
    expect(cuerpoDe(a2)).toEqual({ yaAplicado: true });
    const listo = await ruta("POST", "/listo").manejador(peticion(e, "POST", { orderId: uuid(149) }));
    expect((listo as { status: number }).status).toBe(200);
    const cola = (await ruta("GET", "/operacion/cola").manejador(peticion(e, "GET"))) as { cuerpo: { pedidos: Array<{ numero: number; estado: string }> } };
    expect(cola.cuerpo.pedidos.find((p) => p.numero === 150)?.estado).toBe("preparando");
    expect(cola.cuerpo.pedidos.find((p) => p.numero === 149)?.estado).toBe("listo_para_recoger");
  });

  it("en_camino por la ruta de estado se rechaza con usar_despacho y un estado ajeno da 409", async () => {
    const e = estadoFalso();
    const status = ruta("PATCH", "/status");
    const r1 = (await status.manejador(peticion(e, "PATCH", { orderId: uuid(149) }, { status: "en_camino" }))) as { status: number; cuerpo: { code: string } };
    expect([r1.status, r1.cuerpo.code]).toEqual([422, "usar_despacho"]);
    const r2 = (await status.manejador(peticion(e, "PATCH", { orderId: uuid(150) }, { status: "entregado" }))) as { status: number; cuerpo: { code: string } };
    expect([r2.status, r2.cuerpo.code]).toEqual([409, "estado_cambio"]);
  });
});
