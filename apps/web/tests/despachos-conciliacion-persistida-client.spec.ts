// D-35 + D-02 -- cliente de la conciliacion persistida: URLs, cuerpos (solo ids al confirmar; el servidor decide nivel/confianza/origen) y errores del servidor.
import { describe, expect, it, vi } from "vitest";
import {
  cerrarSesionConciliacion,
  confirmarParesConciliacion,
  crearSesionConciliacion,
  deshacerMatchConciliacion,
  listarSesionesConciliacion,
  obtenerSesionConciliacion,
  resolverSugerenciaConciliacion,
  sugerirConIaConciliacion,
} from "../src/verticals/despachos/lib/conciliacion-client.ts";

function fetchQue(respuesta: unknown, status = 200) {
  const llamadas: { url: string; init?: RequestInit }[] = [];
  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    llamadas.push({ url, init });
    return new Response(JSON.stringify(respuesta), { status });
  });
  return { impl: impl as unknown as typeof fetch, llamadas };
}
const B = "http://api.local/despachos/p1/conciliacion";

describe("cliente de conciliacion persistida", () => {
  it("lista y detalle son GET con el token", async () => {
    const { impl, llamadas } = fetchQue({ disponible: true, sesiones: [] });
    await listarSesionesConciliacion(impl, "http://api.local", "tok", "p1");
    await obtenerSesionConciliacion(impl, "http://api.local", "tok", "p1", "s1");
    expect(llamadas.map((l) => l.url)).toEqual([`${B}/sesiones`, `${B}/sesiones/s1`]);
    expect((llamadas[0]!.init?.headers as Record<string, string>).authorization).toBe("Bearer tok");
  });

  it("crear manda periodo (y cuenta solo si existe)", async () => {
    const { impl, llamadas } = fetchQue({ sesion: { id: "s1" }, movimientos: 2 });
    await crearSesionConciliacion(impl, "http://api.local", "tok", "p1", "2026-01");
    await crearSesionConciliacion(impl, "http://api.local", "tok", "p1", "2026-01", "012180001234567897");
    expect(JSON.parse(String(llamadas[0]!.init?.body))).toEqual({ periodo: "2026-01" });
    expect(JSON.parse(String(llamadas[1]!.init?.body))).toEqual({ periodo: "2026-01", cuenta: "012180001234567897" });
  });

  it("confirmar manda SOLO movimientoId e invoiceId (nada de nivel, confianza ni origen)", async () => {
    const { impl, llamadas } = fetchQue({ matches: [] }, 201);
    await confirmarParesConciliacion(impl, "http://api.local", "tok", "p1", "s1", [{ movimientoId: "m1", invoiceId: "i1" }]);
    expect(llamadas[0]!.url).toBe(`${B}/sesiones/s1/confirmar`);
    expect(JSON.parse(String(llamadas[0]!.init?.body))).toEqual({ pares: [{ movimientoId: "m1", invoiceId: "i1" }] });
  });

  it("deshacer, cerrar, sugerir con IA y aprobar/rechazar pegan a su ruta", async () => {
    const { impl, llamadas } = fetchQue({});
    await deshacerMatchConciliacion(impl, "http://api.local", "tok", "p1", "mt1", "motivo valido");
    await cerrarSesionConciliacion(impl, "http://api.local", "tok", "p1", "s1");
    await sugerirConIaConciliacion(impl, "http://api.local", "tok", "p1", "s1");
    await resolverSugerenciaConciliacion(impl, "http://api.local", "tok", "p1", "sg1", true);
    await resolverSugerenciaConciliacion(impl, "http://api.local", "tok", "p1", "sg1", false);
    expect(llamadas.map((l) => l.url)).toEqual([`${B}/matches/mt1/deshacer`, `${B}/sesiones/s1/cerrar`, `${B}/sesiones/s1/sugerencias-llm`, `${B}/sugerencias/sg1/aprobar`, `${B}/sugerencias/sg1/rechazar`]);
    expect(JSON.parse(String(llamadas[0]!.init?.body))).toEqual({ motivo: "motivo valido" });
  });

  it("un error del servidor (503 sin IA) llega con su mensaje real", async () => {
    const { impl } = fetchQue({ error: "service_unavailable", message: "IA no configurada: sin proveedor." }, 503);
    await expect(sugerirConIaConciliacion(impl, "http://api.local", "tok", "p1", "s1")).rejects.toThrow("IA no configurada");
  });
});
