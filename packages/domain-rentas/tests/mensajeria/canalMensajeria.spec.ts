import { afterEach, describe, expect, it } from "vitest";
import { CanalMensajeriaNoConfiguradoError, CanalMensajeriaPartnerPendiente, SimuladorCanalMensajeria } from "../../src/mensajeria/canalMensajeria.ts";

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

// Hallazgo de auditoría (severidad CRÍTICA, "la mensajería de rentas es un simulador
// que nunca toca un canal real") -- este adaptador reemplaza al simulador en la ruta
// real de producción (ver apps/api/src/production/deps.ts::rentasCanalMensajeria).
describe("CanalMensajeriaPartnerPendiente", () => {
  const VARIABLES = { airbnb: "AIRBNB_MESSAGING_API_TOKEN", vrbo: "VRBO_MESSAGING_API_TOKEN", booking: "BOOKING_MESSAGING_API_TOKEN" } as const;

  afterEach(() => {
    for (const variable of Object.values(VARIABLES)) delete process.env[variable];
  });

  it("sin credencial: obtenerEstadoConexion reporta 'partner_pendiente', nunca 'produccion'", async () => {
    const canal = new CanalMensajeriaPartnerPendiente("airbnb");
    expect(await canal.obtenerEstadoConexion()).toBe("partner_pendiente");
  });

  it("sin credencial: enviarMensajeAprobado SIEMPRE lanza CanalMensajeriaNoConfiguradoError -- nunca finge un envío", async () => {
    const canal = new CanalMensajeriaPartnerPendiente("vrbo");
    await expect(canal.enviarMensajeAprobado({ borradorId: "b-1", texto: "Hola", aprobadoPor: "usuario-1" })).rejects.toThrow(CanalMensajeriaNoConfiguradoError);
  });

  it("el mensaje de error nombra el canal y la variable de entorno que falta -- accionable, no genérico", async () => {
    const canal = new CanalMensajeriaPartnerPendiente("booking");
    await expect(canal.enviarMensajeAprobado({ borradorId: "b-1", texto: "Hola", aprobadoPor: "usuario-1" })).rejects.toThrow(/BOOKING_MESSAGING_API_TOKEN/);
  });

  it("incluso CON la credencial presente, sigue lanzando (nunca fabrica un cliente HTTP no verificado) -- pero cambia de estado a 'sandbox'", async () => {
    process.env[VARIABLES.airbnb] = "token-de-prueba";
    const canal = new CanalMensajeriaPartnerPendiente("airbnb");
    expect(await canal.obtenerEstadoConexion()).toBe("sandbox");
    await expect(canal.enviarMensajeAprobado({ borradorId: "b-1", texto: "Hola", aprobadoPor: "usuario-1" })).rejects.toThrow(CanalMensajeriaNoConfiguradoError);
  });

  it("cada canal usa su propia variable de entorno -- configurar uno no habilita los otros", async () => {
    process.env[VARIABLES.airbnb] = "token-de-prueba";
    const vrbo = new CanalMensajeriaPartnerPendiente("vrbo");
    expect(await vrbo.obtenerEstadoConexion()).toBe("partner_pendiente");
  });
});
