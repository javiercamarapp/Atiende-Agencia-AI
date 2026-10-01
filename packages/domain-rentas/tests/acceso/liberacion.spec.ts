import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryRentasAccesoRepository, correoAccesoHuesped, ejecutarLiberacionAcceso, type LiberacionPendiente, type WithLiberacionTx } from "../../src/index.ts";

const SECRETO = "CODIGO-9137";
const DIRECCION = "Calle 60 #123 Centro";
const CORREO = "huesped.privado@example.com";

function pendiente(id: string, extra: Partial<LiberacionPendiente> = {}): LiberacionPendiente {
  return {
    ocupacionId: id,
    organizationId: "org-1",
    propertyId: "prop-1",
    checkIn: "2027-03-10",
    checkOut: "2027-03-12",
    unidadNombre: "Casa Mar",
    tenantNombre: "Gestora Demo",
    huespedNombre: "Ana",
    huespedContacto: CORREO,
    tieneInstrucciones: true,
    direccionExacta: DIRECCION,
    codigoAcceso: SECRETO,
    instrucciones: "Caja junto a la puerta",
    ...extra,
  };
}

interface Encolado {
  propertyId: string;
  organizationId: string;
  channel: string;
  eventType: string;
  dedupeKey: string;
  payload: { to: string; subject: string; html: string; text: string };
}

function montar(opts: { falla?: (dedupeKey: string) => boolean } = {}) {
  const acceso = new InMemoryRentasAccesoRepository();
  const encolados: Encolado[] = [];
  let transacciones = 0;
  const rentas = {
    async enqueueMessagingOutbox(propertyId: string, organizationId: string, channel: "whatsapp" | "email", eventType: string, dedupeKey: string, payload: unknown): Promise<void> {
      if (opts.falla?.(dedupeKey)) throw Object.assign(new Error(`insert falló para ${CORREO} ${SECRETO}`), { code: "40P01" });
      encolados.push({ propertyId, organizationId, channel, eventType, dedupeKey, payload: payload as Encolado["payload"] });
    },
  };
  const withTx: WithLiberacionTx = async (fn) => {
    transacciones += 1;
    return fn({ acceso, rentas });
  };
  return { acceso, encolados, withTx, transacciones: () => transacciones };
}

afterEach(() => vi.restoreAllMocks());

describe("ejecutarLiberacionAcceso", () => {
  it("libera cada reserva pendiente: encola el correo con dedupe por reserva y marca la liberación, una transacción por reserva", async () => {
    const m = montar();
    m.acceso.pendientes.push(pendiente("o1"), pendiente("o2"));
    const r = await ejecutarLiberacionAcceso(m.withTx);
    expect(r).toMatchObject({ disponible: true, liberadas: 2, errores: 0, truncada: false });
    expect(m.encolados.map((e) => e.dedupeKey)).toEqual(["acceso:o1", "acceso:o2"]);
    expect(m.encolados[0]).toMatchObject({ channel: "email", eventType: "reserva.acceso_huesped", propertyId: "prop-1", organizationId: "org-1" });
    expect(m.encolados[0]!.payload.to).toBe(CORREO);
    expect(m.encolados[0]!.payload.html).toContain(SECRETO);
    expect(m.encolados[0]!.payload.text).toContain(DIRECCION);
    expect([...m.acceso.liberadas]).toEqual(["o1", "o2"]);
    expect(m.acceso.bitacora.filter((b) => b.evento === "liberada")).toHaveLength(2);
    // 2 reservas + 1 consulta final que no encuentra más = 3 transacciones
    expect(m.transacciones()).toBe(3);
  });

  it("es idempotente: una segunda corrida no vuelve a encolar ni a marcar", async () => {
    const m = montar();
    m.acceso.pendientes.push(pendiente("o1"));
    await ejecutarLiberacionAcceso(m.withTx);
    const r2 = await ejecutarLiberacionAcceso(m.withTx);
    expect(r2.liberadas).toBe(0);
    expect(m.encolados).toHaveLength(1);
    expect(m.acceso.bitacora.filter((b) => b.evento === "liberada")).toHaveLength(1);
  });

  it("sin correo válido del huésped: no encola, no marca como liberada y deja la omisión en la bitácora (una vez)", async () => {
    const m = montar();
    m.acceso.pendientes.push(pendiente("o1", { huespedContacto: "+52 999 123 4567" }), pendiente("o2", { huespedContacto: null }));
    const r = await ejecutarLiberacionAcceso(m.withTx);
    expect(r).toMatchObject({ liberadas: 0, omitidasSinContacto: 2 });
    expect(m.encolados).toHaveLength(0);
    expect(m.acceso.liberadas.size).toBe(0);
    expect(m.acceso.bitacora.map((b) => b.evento)).toEqual(["omitida_sin_contacto", "omitida_sin_contacto"]);
    // la siguiente corrida no repite el renglón de bitácora (el dedupe de 24 h es de la base; aquí el doble lo modela)
    await ejecutarLiberacionAcceso(m.withTx);
    expect(m.acceso.bitacora).toHaveLength(2);
  });

  it("sin instrucciones configuradas para la unidad: omite y registra, sin tocar el outbox", async () => {
    const m = montar();
    m.acceso.pendientes.push(pendiente("o1", { tieneInstrucciones: false, direccionExacta: null, codigoAcceso: null, instrucciones: null }));
    const r = await ejecutarLiberacionAcceso(m.withTx);
    expect(r).toMatchObject({ liberadas: 0, omitidasSinInstrucciones: 1 });
    expect(m.encolados).toHaveLength(0);
    expect(m.acceso.bitacora[0]).toMatchObject({ evento: "omitida_sin_instrucciones", ocupacionId: "o1" });
  });

  it("un fallo al encolar una reserva no frena las demás ni la marca como liberada, deja error_envio y no filtra PII al log", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const m = montar({ falla: (k) => k === "acceso:o1" });
    m.acceso.pendientes.push(pendiente("o1"), pendiente("o2"));
    const r = await ejecutarLiberacionAcceso(m.withTx);
    expect(r).toMatchObject({ liberadas: 1, errores: 1 });
    expect([...m.acceso.liberadas]).toEqual(["o2"]);
    expect(m.acceso.bitacora.map((b) => `${b.ocupacionId}:${b.evento}`)).toEqual(["o1:error_envio", "o2:liberada"]);
    const logs = JSON.stringify(spy.mock.calls);
    expect(logs).toContain("o1");
    expect(logs).toContain("40P01");
    for (const secreto of [CORREO, SECRETO, DIRECCION, "Ana"]) expect(logs).not.toContain(secreto);
  });

  it("contra una base sin la migración 025 responde disponible:false sin lanzar ni loguear errores", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const m = montar();
    m.acceso.migracion025Disponible = false;
    const r = await ejecutarLiberacionAcceso(m.withTx);
    expect(r).toMatchObject({ disponible: false, liberadas: 0, errores: 0 });
    expect(spy).not.toHaveBeenCalled();
  });

  it("respeta el tope por corrida y avisa que quedó trabajo", async () => {
    const m = montar();
    for (let i = 0; i < 5; i++) m.acceso.pendientes.push(pendiente(`o${i}`));
    const r = await ejecutarLiberacionAcceso(m.withTx, { maxPorCorrida: 3 });
    expect(r).toMatchObject({ liberadas: 3, truncada: true });
    const r2 = await ejecutarLiberacionAcceso(m.withTx, { maxPorCorrida: 3 });
    expect(r2).toMatchObject({ liberadas: 2, truncada: false });
  });

  it("si falla pedir la siguiente (sin candidata) corta la corrida en vez de ciclar", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const m = montar();
    m.acceso.siguienteLiberacion = async () => {
      throw Object.assign(new Error("boom"), { code: "57014" });
    };
    const r = await ejecutarLiberacionAcceso(m.withTx);
    expect(r).toMatchObject({ errores: 1, truncada: false });
  });
});

describe("correoAccesoHuesped", () => {
  it("escapa HTML en todos los campos dinámicos y omite el código si no hay", () => {
    const c = correoAccesoHuesped({ huespedNombre: "<b>Ana</b>", tenantNombre: "A&B", unidadNombre: "Casa <i>Mar</i>", checkInTexto: "x", checkOutTexto: "y", direccionExacta: "<script>alert(1)</script>", codigoAcceso: null, instrucciones: "a<b" });
    expect(c.html).not.toContain("<script>");
    expect(c.html).not.toContain("<b>Ana</b>");
    expect(c.html).toContain("&lt;script&gt;");
    expect(c.texto).not.toContain("Codigo de acceso");
  });
});
