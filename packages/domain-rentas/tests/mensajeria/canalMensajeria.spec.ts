import { describe, expect, it } from "vitest";
import { SimuladorCanalMensajeria } from "../../src/mensajeria/canalMensajeria.ts";

describe("SimuladorCanalMensajeria", () => {
  it("nunca reporta produccion — siempre 'simulador' (D-019: un simulador nunca se disfraza de canal real)", async () => {
    const canal = new SimuladorCanalMensajeria("airbnb");
    expect(await canal.obtenerEstadoConexion()).toBe("simulador");
  });

  it("enviarMensajeAprobado exige aprobadoPor y devuelve un resultado con enviadoEn", async () => {
    const canal = new SimuladorCanalMensajeria("booking");
    const resultado = await canal.enviarMensajeAprobado({ borradorId: "b-1", texto: "Hola", aprobadoPor: "usuario-1" });
    expect(resultado.enviadoEn).toEqual(expect.any(String));
  });

  it("enviarMensajeAprobado rechaza en runtime si aprobadoPor viene vacío (defensa adicional al tipo)", async () => {
    const canal = new SimuladorCanalMensajeria("vrbo");
    await expect(canal.enviarMensajeAprobado({ borradorId: "b-1", texto: "Hola", aprobadoPor: "" })).rejects.toThrow();
  });
});
