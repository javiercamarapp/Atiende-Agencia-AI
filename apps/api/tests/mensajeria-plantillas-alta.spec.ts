// PL-31 / PL-32 -- catalogo de plantillas por organizacion y ALTA de la lista de supresion en el API. El estado de transaccion
// abortada de Postgres se reproduce con AbortAwareFakeSession (una sesion falsa plana no sirve).
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeWhatsAppGraphClient, WhatsAppOutboundDispatcher } from "@atiende/whatsapp-gateway";
import type { MessagingOutboxItem, MessagingOutboxPort } from "@atiende/whatsapp-gateway";
import { InMemoryTenancyEngine } from "@atiende/db";
import { AbortAwareFakeSession } from "../../../packages/db/tests/support/aborting-fake-session.ts";
import { crearCatalogoPlantillas } from "../src/mensajeria/catalogo-plantillas.ts";
import { ALTA_CONFIRMADA_TEXTO, esPalabraAlta, esPalabraBaja, hashearContacto, procesarBajaOAlta, procesarMensajeAlta, reactivarSupresionBaja } from "../src/supresion/index.ts";

function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

const ORG_A = "00000000-0000-0000-0000-00000000000a";
const ORG_B = "00000000-0000-0000-0000-00000000000b";
const TELEFONO = "+525512345678";
const HASH = hashearContacto("telefono", TELEFONO)!;

afterEach(() => vi.restoreAllMocks());

describe("PL-31: catalogo de plantillas por organizacion", () => {
  it("consulta la funcion de sistema con (organizacion, nombre) y devuelve su booleano", async () => {
    const session = new AbortAwareFakeSession([{ match: /core\.whatsapp_plantilla_aprobada/, respond: () => [{ aprobada: true }] }]);
    const spy = vi.spyOn(session, "query");
    await expect(crearCatalogoPlantillas(session).estaAprobada(ORG_A, "recordatorio_cita")).resolves.toBe(true);
    expect(spy.mock.calls[0]![1]).toEqual([ORG_A, "recordatorio_cita"]);
  });

  it("base SIN la migracion 0049: false (decide la lista global) con la sesion UTILIZABLE despues (SAVEPOINT)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const session = new AbortAwareFakeSession([
      { match: /core\.whatsapp_plantilla_aprobada/, respond: () => pgError("42883", "function core.whatsapp_plantilla_aprobada(uuid, text) does not exist") },
      { match: /select 1/, respond: () => [{ ok: 1 }] },
    ]);
    await expect(crearCatalogoPlantillas(session).estaAprobada(ORG_A, "x")).resolves.toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    await expect(session.query("select 1;")).resolves.toEqual({ rows: [{ ok: 1 }] });
  });

  it("un error de Postgres que NO es migracion pendiente se propaga (no se enmascara)", async () => {
    const session = new AbortAwareFakeSession([{ match: /core\.whatsapp_plantilla_aprobada/, respond: () => pgError("40001", "serialization failure") }]);
    await expect(crearCatalogoPlantillas(session).estaAprobada(ORG_A, "x")).rejects.toMatchObject({ code: "40001" });
  });

  it("de punta a punta con el motor en memoria: la plantilla aprobada de A se usa y la de B no", async () => {
    const engine = new InMemoryTenancyEngine();
    engine.seedPlantillaAprobada(ORG_A, "recordatorio_cita");
    const item = (organizationId: string): MessagingOutboxPort => {
      let enviado = false;
      return {
        label: "citas",
        claimBatch: async (): Promise<readonly MessagingOutboxItem[]> =>
          enviado ? [] : [{ id: "m1", attempts: 0, organizationId, payload: { to: TELEFONO, phone_number_id: "p1", body: "texto", template: { name: "recordatorio_cita", language: "es_MX", params: ["Ana"] } } }],
        markSent: async () => {
          enviado = true;
        },
        markRetry: async () => undefined,
        markDead: async () => undefined,
      };
    };
    const graph = new FakeWhatsAppGraphClient();
    const dispatcher = new WhatsAppOutboundDispatcher({ graphClient: graph });
    await engine.withAppSession({ userId: null }, async (db) => {
      await dispatcher.dispatchPending(item(ORG_A), { plantillas: crearCatalogoPlantillas(db) });
      await dispatcher.dispatchPending(item(ORG_B), { plantillas: crearCatalogoPlantillas(db) });
    });
    expect(graph.sent[0]?.templateApproved).toBe(true);
    expect("templateApproved" in (graph.sent[1] ?? {})).toBe(false);
  });
});

describe("PL-32: ALTA de la lista de supresion", () => {
  it("deteccion: ALTA/START cuentan, una frase real no; y las frases nuevas de baja se reconocen", () => {
    for (const t of ["ALTA", "alta", "Start", "quiero recibir mensajes"]) expect(esPalabraAlta(t), t).toBe(true);
    for (const t of ["alta de mi expediente", "dar de alta a mi esposa", "hola", ""]) expect(esPalabraAlta(t), t).toBe(false);
    for (const t of ["no mas mensajes", "No quiero más mensajes", "darme de baja", "BAJA", "stop"]) expect(esPalabraBaja(t), t).toBe(true);
    for (const t of ["no puedo ir, baja la cita", "stop por favor", "quiero una baja de mi cita"]) expect(esPalabraBaja(t), t).toBe(false);
  });

  it("ALTA tras una baja: la quita, confirma UNA vez y solo viaja el hash", async () => {
    let suprimido = true;
    const session = new AbortAwareFakeSession([
      { match: /core\.reactivar_supresion_baja/, respond: () => { const quitada = suprimido; suprimido = false; return [{ quitada }]; } },
      { match: /core\.esta_suprimido/, respond: () => [{ suprimido }] },
    ]);
    const spy = vi.spyOn(session, "query");
    const confirmar = vi.fn(async () => undefined);
    const r = await procesarMensajeAlta(session, { telefono: "5512345678", texto: "ALTA", confirmar });
    expect(r).toEqual({ manejada: true, resultado: "reactivada" });
    expect(confirmar).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![1]).toEqual(["telefono", HASH]);
    expect(JSON.stringify(spy.mock.calls)).not.toContain("5512345678");
    expect(ALTA_CONFIRMADA_TEXTO).not.toMatch(/\d{10}/);
  });

  it("ALTA sin baja previa: no se maneja (el texto sigue al agente) y no confirma", async () => {
    const session = new AbortAwareFakeSession([{ match: /core\.reactivar_supresion_baja/, respond: () => [{ quitada: false }] }]);
    const confirmar = vi.fn(async () => undefined);
    const r = await procesarMensajeAlta(session, { telefono: TELEFONO, texto: "alta", confirmar });
    expect(r).toEqual({ manejada: false, resultado: "sin_baja" });
    expect(confirmar).not.toHaveBeenCalled();
  });

  it("ALTA con otro motivo de supresion vigente (queja/ARCO): NO confirma, seria mentir", async () => {
    const session = new AbortAwareFakeSession([
      { match: /core\.reactivar_supresion_baja/, respond: () => [{ quitada: true }] },
      { match: /core\.esta_suprimido/, respond: () => [{ suprimido: true }] },
    ]);
    const confirmar = vi.fn(async () => undefined);
    const r = await procesarMensajeAlta(session, { telefono: TELEFONO, texto: "ALTA", confirmar });
    expect(r).toEqual({ manejada: false, resultado: "sigue_suprimido" });
    expect(confirmar).not.toHaveBeenCalled();
  });

  it("base sin la migracion 0049: no se maneja, log sin PII y sesion sana", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const session = new AbortAwareFakeSession([
      { match: /core\.reactivar_supresion_baja/, respond: () => pgError("42883", "function core.reactivar_supresion_baja(text, text) does not exist") },
      { match: /select 1/, respond: () => [] },
    ]);
    const r = await procesarMensajeAlta(session, { telefono: TELEFONO, texto: "ALTA", confirmar: async () => undefined });
    expect(r).toEqual({ manejada: false, resultado: "no_migrada" });
    expect(warn).toHaveBeenCalledTimes(1);
    await expect(session.query("select 1;")).resolves.toEqual({ rows: [] });
  });

  it("un mensaje que no es ALTA no toca la base", async () => {
    const session = new AbortAwareFakeSession([]);
    expect(await procesarMensajeAlta(session, { telefono: TELEFONO, texto: "hola", confirmar: async () => undefined })).toEqual({ manejada: false, resultado: null });
    expect(session.calls).toEqual([]);
  });

  it("reactivarSupresionBaja rechaza un valor no interpretable y propaga errores que no son migracion pendiente", async () => {
    const vacia = new AbortAwareFakeSession([]);
    await expect(reactivarSupresionBaja(vacia, { tipo: "telefono", valor: "xx" })).resolves.toBe("valor_invalido");
    const rota = new AbortAwareFakeSession([{ match: /core\.reactivar_supresion_baja/, respond: () => pgError("40001", "serialization failure") }]);
    await expect(reactivarSupresionBaja(rota, { tipo: "telefono", valor: TELEFONO })).rejects.toMatchObject({ code: "40001" });
  });

  it("procesarBajaOAlta: BAJA primero, ALTA despues, texto normal ni una ni otra", async () => {
    const session = new AbortAwareFakeSession([
      { match: /core\.registrar_supresion/, respond: () => [{ nueva: true }] },
      { match: /core\.reactivar_supresion_baja/, respond: () => [{ quitada: true }] },
      { match: /core\.esta_suprimido/, respond: () => [{ suprimido: false }] },
    ]);
    const confirmarBaja = vi.fn(async () => undefined);
    const confirmarAlta = vi.fn(async () => undefined);
    const base = { telefono: TELEFONO, origen: "whatsapp.citas", organizationId: ORG_A, confirmarBaja, confirmarAlta };
    expect(await procesarBajaOAlta(session, { ...base, texto: "BAJA" })).toBe(true);
    expect(await procesarBajaOAlta(session, { ...base, texto: "ALTA" })).toBe(true);
    expect(await procesarBajaOAlta(session, { ...base, texto: "no puedo ir, baja la cita" })).toBe(false);
    expect(confirmarBaja).toHaveBeenCalledTimes(1);
    expect(confirmarAlta).toHaveBeenCalledTimes(1);
  });
});
