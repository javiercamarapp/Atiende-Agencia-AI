import { describe, expect, it } from "vitest";
import type { TarjetaPedido } from "@atiende/domain-restaurantes/operacion";
import { accionPrincipal, conteosPorPestana, etiquetaOrigen, minutosVivos, ordenarCola, pestanaDe } from "../../src/verticals/restaurantes/lib/operacion-presentacion.ts";

function tarjeta(extra: Partial<TarjetaPedido> = {}): TarjetaPedido {
  return {
    id: "00000000-0000-4000-8000-000000000001", numero: 1, estado: "pending", canal: "domicilio", origen: "whatsapp", clienteNombre: "Cliente de prueba", resumenItems: "2 pastor", total: 100,
    creadoEn: "2026-10-21T20:00:00.000Z", aceptadoEn: null, listoAt: null, salioAt: null, minutos: 0, semaforo: "verde", repartidorId: null, sinAviso: false, accionesDisponibles: [], ...extra,
  };
}

describe("presentacion de la cola", () => {
  it("clasifica por pestana: domicilio listo = preparando con listoAt", () => {
    expect(pestanaDe(tarjeta({ estado: "pending" }))).toBe("nuevos");
    expect(pestanaDe(tarjeta({ estado: "preparando" }))).toBe("preparacion");
    expect(pestanaDe(tarjeta({ estado: "preparando", listoAt: "2026-10-21T20:10:00.000Z" }))).toBe("listos");
    expect(pestanaDe(tarjeta({ estado: "listo_para_recoger", canal: "recoger" }))).toBe("listos");
    expect(pestanaDe(tarjeta({ estado: "en_camino" }))).toBe("camino");
    expect(pestanaDe(tarjeta({ estado: "entregado" }))).toBeNull();
    expect(pestanaDe(tarjeta({ estado: "problema" }))).toBeNull();
  });

  it("cuenta por pestana e ignora lo que la cola no pinta", () => {
    const c = conteosPorPestana([tarjeta(), tarjeta({ id: "b" }), tarjeta({ estado: "en_camino" }), tarjeta({ estado: "cancelado" })]);
    expect(c).toEqual({ nuevos: 2, preparacion: 0, listos: 0, camino: 1 });
  });

  it("la accion grande la decide el servidor: sin accion declarada no hay boton", () => {
    expect(accionPrincipal(tarjeta({ accionesDisponibles: [] }))).toBeNull();
    expect(accionPrincipal(tarjeta({ accionesDisponibles: ["cancelar", "aceptar"] }))).toBe("aceptar");
    expect(accionPrincipal(tarjeta({ estado: "preparando", accionesDisponibles: ["cancelar", "listo"] }))).toBe("listo");
    expect(accionPrincipal(tarjeta({ estado: "listo_para_recoger", canal: "recoger", accionesDisponibles: ["entregar"] }))).toBe("entregar");
    // «entregar» de un domicilio en camino es del chofer: el encargado no ve boton grande.
    expect(accionPrincipal(tarjeta({ estado: "en_camino", accionesDisponibles: ["entregar"] }))).toBeNull();
  });

  it("minutos vivos suman lo transcurrido desde la consulta", () => {
    const t0 = Date.parse("2026-10-21T20:00:00Z");
    expect(minutosVivos({ minutos: 10 }, t0, t0 + 3 * 60_000 + 5000)).toBe(13);
    expect(minutosVivos({ minutos: 10 }, t0, t0 - 5000)).toBe(10);
  });

  it("ordena rojos primero y luego el mas antiguo", () => {
    const t0 = Date.parse("2026-10-21T20:00:00Z");
    const verdeViejo = tarjeta({ id: "v", numero: 1, estado: "preparando", minutos: 5, creadoEn: "2026-10-21T19:00:00.000Z" });
    const rojo = tarjeta({ id: "r", numero: 2, estado: "pending", minutos: 9, creadoEn: "2026-10-21T19:50:00.000Z" });
    const verdeNuevo = tarjeta({ id: "n", numero: 3, estado: "preparando", minutos: 1, creadoEn: "2026-10-21T19:59:00.000Z" });
    expect(ordenarCola([verdeNuevo, rojo, verdeViejo], t0, t0).map((p) => p.id)).toEqual(["r", "v", "n"]);
  });

  it("etiqueta el origen en español", () => {
    expect(etiquetaOrigen("whatsapp")).toBe("WhatsApp");
    expect(etiquetaOrigen("llamada")).toBe("Llamada");
    expect(etiquetaOrigen("voice")).toBe("Voz");
  });
});
