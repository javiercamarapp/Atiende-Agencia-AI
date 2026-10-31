// Envio fuera de la ventana de 24 h (PM PR-7): solo con plantilla aprobada; sin ella no se envia y se avisa en el panel. Adaptadores falsos.
import { describe, expect, it } from "vitest";
import { InMemoryAlertasOutbox, InMemoryAvisoEnvioBloqueado, InMemoryPlantillasFueraVentana, decidirEnvioAlCliente, enviarAlClienteRespetandoVentana } from "../src/index.ts";

const AHORA = new Date("2026-10-27T18:00:00Z");
const horas = (h: number) => new Date(AHORA.getTime() - h * 3_600_000);
const PLANTILLA = { nombre: "respuesta_sucursal", idioma: "es_MX", aprobada: true };

function setup() {
  const outbox = new InMemoryAlertasOutbox();
  const plantillas = new InMemoryPlantillasFueraVentana();
  const panel = new InMemoryAvisoEnvioBloqueado();
  const enviar = (ultimo: Date | null, texto = "Su pedido sale en 10 minutos", key = "k1") =>
    enviarAlClienteRespetandoVentana({ outbox, plantillas, panel }, { organizationId: "o1", propertyId: "p1", sucursalNombre: "Tizon", conversationId: "c1", phone: "9991234567", phoneNumberId: "1002", texto, ultimoMensajeClienteAt: ultimo, ahora: AHORA, dedupeKey: key });
  return { outbox, plantillas, panel, enviar };
}

describe("decidirEnvioAlCliente", () => {
  it("dentro de la ventana: texto libre, sin plantilla", () => {
    expect(decidirEnvioAlCliente({ ultimoMensajeClienteAt: horas(2), ahora: AHORA, plantilla: null })).toEqual({ modo: "texto" });
  });
  it("a las 23h56 ya cuenta como fuera (margen de 5 min)", () => {
    expect(decidirEnvioAlCliente({ ultimoMensajeClienteAt: horas(23.93), ahora: AHORA, plantilla: null })).toEqual({ modo: "bloqueado", motivo: "sin_plantilla" });
  });
  it("fuera de ventana: plantilla aprobada, no aprobada o ausente", () => {
    expect(decidirEnvioAlCliente({ ultimoMensajeClienteAt: horas(30), ahora: AHORA, plantilla: PLANTILLA }).modo).toBe("plantilla");
    expect(decidirEnvioAlCliente({ ultimoMensajeClienteAt: horas(30), ahora: AHORA, plantilla: { ...PLANTILLA, aprobada: false } })).toEqual({ modo: "bloqueado", motivo: "plantilla_no_aprobada" });
    expect(decidirEnvioAlCliente({ ultimoMensajeClienteAt: horas(30), ahora: AHORA, plantilla: null })).toEqual({ modo: "bloqueado", motivo: "sin_plantilla" });
  });
  it("ultimo mensaje desconocido cuenta como fuera de ventana", () => {
    expect(decidirEnvioAlCliente({ ultimoMensajeClienteAt: null, ahora: AHORA, plantilla: null }).modo).toBe("bloqueado");
  });
});

describe("enviarAlClienteRespetandoVentana", () => {
  it("dentro de ventana encola texto libre", async () => {
    const t = setup();
    expect(await t.enviar(horas(1))).toEqual({ enviado: true, modo: "texto" });
    const [e] = [...t.outbox.enviados.values()];
    expect(e?.payload).toMatchObject({ body: "Su pedido sale en 10 minutos", transaccional: true });
    expect(e?.payload.template).toBeUndefined();
  });
  it("fuera de ventana con plantilla aprobada encola SOLO plantilla (nunca texto libre)", async () => {
    const t = setup();
    t.plantillas.plantilla = PLANTILLA;
    expect(await t.enviar(horas(30), "Hola\nsegunda linea")).toEqual({ enviado: true, modo: "plantilla" });
    const [e] = [...t.outbox.enviados.values()];
    expect(e?.payload).toMatchObject({ solo_plantilla: true, template: { name: "respuesta_sucursal", language: "es_MX" } });
    expect((e?.payload.template as { params: string[] }).params).toEqual(["Tizon", "Hola segunda linea"]);
  });
  it("fuera de ventana SIN plantilla: no envia nada y avisa en el panel con el motivo", async () => {
    const t = setup();
    expect(await t.enviar(horas(30))).toEqual({ enviado: false, motivo: "sin_plantilla" });
    expect(t.outbox.enviados.size).toBe(0);
    expect(t.panel.avisos).toEqual([{ organizationId: "o1", propertyId: "p1", conversationId: "c1", motivo: "sin_plantilla" }]);
  });
  it("plantilla no aprobada tambien bloquea", async () => {
    const t = setup();
    t.plantillas.plantilla = { ...PLANTILLA, aprobada: false };
    expect((await t.enviar(horas(40))).enviado).toBe(false);
    expect(t.outbox.enviados.size).toBe(0);
  });
  it("es idempotente por dedupeKey", async () => {
    const t = setup();
    await t.enviar(horas(1));
    await t.enviar(horas(1));
    expect(t.outbox.enviados.size).toBe(1);
  });
});
