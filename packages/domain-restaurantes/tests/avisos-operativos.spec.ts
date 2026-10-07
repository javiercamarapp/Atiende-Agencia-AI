// R-16 -- barrido de alertas operativas (entrega tardia / programado por vencer). El candidato lo decide la base
// (verify-restaurantes-avisos-staff); aqui: la emision por el productor compartido, la idempotencia (dos ticks =
// una alerta por pedido) y el comportamiento contra la base sin migrar, con AbortAwareFakeSession.
import { describe, expect, it } from "vitest";
import { barrerAvisosOperativos, listarCandidatosAvisos } from "../src/avisos-operativos.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

const ORG = "00000000-0000-0000-0000-00000000a001";
const PROP = "00000000-0000-0000-0000-00000000c001";
const O1 = "6129984c-4f5e-4a0f-9b7e-0d4d8a1b2c01";
const O2 = "6129984c-4f5e-4a0f-9b7e-0d4d8a1b2c02";

function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

const CANDIDATOS = [
  { tipo: "restaurantes.pedido.entrega_tardia", order_id: O1, organization_id: ORG, property_id: PROP, order_number: "101" },
  { tipo: "restaurantes.pedido.programado_por_vencer", order_id: O2, organization_id: ORG, property_id: PROP, order_number: 102 },
];

/** Sesion falsa con la misma semantica de dedupe de core.emit_notification: la segunda emision de la misma clave inserta 0. */
function sesionConDedupe(candidatos: unknown[]) {
  const vistas = new Set<string>();
  const emisiones: unknown[][] = [];
  const session = new AbortAwareFakeSession([
    { match: /avisos_operativos_candidatos/, respond: () => candidatos },
    { match: /select core\.emit_notification/, respond: () => [{ emit_notification: 1 }] },
  ]);
  const original = session.query.bind(session);
  session.query = (async (sql: string, p?: unknown[]) => {
    if (/select core\.emit_notification/.test(sql)) {
      const clave = String((p ?? [])[10]);
      emisiones.push(p ?? []);
      if (vistas.has(clave)) return { rows: [{ emit_notification: 0 }] };
      vistas.add(clave);
    }
    return original(sql, p);
  }) as typeof session.query;
  return { session, emisiones };
}

describe("barrerAvisosOperativos", () => {
  it("emite una notificacion por candidato con datos del catalogo, enlace relativo y solo el numero de pedido (sin PII)", async () => {
    const { session, emisiones } = sesionConDedupe(CANDIDATOS);
    const r = await barrerAvisosOperativos(session);
    expect(r).toEqual({ disponible: true, candidatos: 2, emitidas: 2, sinNuevas: 0, errores: 0 });

    const [tardia, programado] = emisiones;
    expect(tardia![2]).toBe("restaurantes.pedido.entrega_tardia");
    expect(tardia![4]).toBe("atencion");
    expect(tardia![5]).toBe("Un pedido va con retraso");
    expect(tardia![6]).toBe("El pedido #101 pasó de su hora prometida y sigue sin entregarse.");
    expect(tardia![7]).toBe("/restaurantes/{orgSlug}/pedidos");
    expect(tardia![10]).toBe(`restaurantes.pedido.entrega_tardia:${O1}`);
    expect(tardia![11]).toEqual(["staff"]);
    expect(programado![2]).toBe("restaurantes.pedido.programado_por_vencer");
    expect(programado![6]).toContain("#102");
    expect(programado![10]).toBe(`restaurantes.pedido.programado_por_vencer:${O2}`);
  });

  it("idempotente: dos ticks dejan UNA alerta por pedido (el segundo cuenta sinNuevas)", async () => {
    const { session } = sesionConDedupe(CANDIDATOS);
    const primero = await barrerAvisosOperativos(session);
    const segundo = await barrerAvisosOperativos(session);
    expect(primero.emitidas).toBe(2);
    expect(segundo).toEqual({ disponible: true, candidatos: 2, emitidas: 0, sinNuevas: 2, errores: 0 });
  });

  it("sin candidatos no emite nada", async () => {
    const { session, emisiones } = sesionConDedupe([]);
    expect(await barrerAvisosOperativos(session)).toEqual({ disponible: true, candidatos: 0, emitidas: 0, sinNuevas: 0, errores: 0 });
    expect(emisiones).toHaveLength(0);
  });

  it("pasa el reloj fijo a la base (p_now) para pruebas deterministas", async () => {
    let params: unknown[] = [];
    const session = new AbortAwareFakeSession([{ match: /avisos_operativos_candidatos/, respond: () => [] }]);
    const original = session.query.bind(session);
    session.query = (async (sql: string, p?: unknown[]) => {
      params = p ?? [];
      return original(sql, p);
    }) as typeof session.query;
    await listarCandidatosAvisos(session, new Date("2026-10-03T18:00:00Z"));
    expect(params).toEqual(["2026-10-03T18:00:00.000Z"]);
    await listarCandidatosAvisos(session);
    expect(params).toEqual([null]);
  });

  it("base sin migrar (42883): no barre, devuelve disponible=false y la transaccion sigue utilizable (SAVEPOINT)", async () => {
    const session = new AbortAwareFakeSession([
      { match: /avisos_operativos_candidatos/, respond: () => pgError("42883", "function restaurantes.avisos_operativos_candidatos(timestamp with time zone) does not exist") },
      { match: /select 1 as despues/, respond: () => [{ despues: 1 }] },
    ]);
    expect(await barrerAvisosOperativos(session)).toEqual({ disponible: false, candidatos: 0, emitidas: 0, sinNuevas: 0, errores: 0 });
    await expect(session.query("select 1 as despues")).resolves.toEqual({ rows: [{ despues: 1 }] });
  });

  it("una emision que falla (error de Postgres) no aborta el barrido: las demas se emiten y se cuenta el error", async () => {
    let n = 0;
    const session = new AbortAwareFakeSession([
      { match: /avisos_operativos_candidatos/, respond: () => CANDIDATOS },
      { match: /select core\.emit_notification/, respond: () => (++n === 1 ? pgError("XX000", "falla interna") : [{ emit_notification: 1 }]) },
    ]);
    const r = await barrerAvisosOperativos(session);
    expect(r).toEqual({ disponible: true, candidatos: 2, emitidas: 1, sinNuevas: 0, errores: 1 });
  });
});

describe("QA R2 automatizacion-04/-05: pedido sin aceptar y pedido estancado", () => {
  const O3 = "6129984c-4f5e-4a0f-9b7e-0d4d8a1b2c03";
  const O4 = "6129984c-4f5e-4a0f-9b7e-0d4d8a1b2c04";
  const NUEVOS = [
    { tipo: "restaurantes.pedido.sin_aceptar", order_id: O3, organization_id: ORG, property_id: PROP, order_number: 103 },
    { tipo: "restaurantes.pedido.estancado", order_id: O4, organization_id: ORG, property_id: PROP, order_number: 104 },
  ];

  it("emite cada tipo nuevo con su propio texto (solo el numero de pedido), clave de dedupe por pedido y enlace a Pedidos", async () => {
    const { session, emisiones } = sesionConDedupe(NUEVOS);
    expect(await barrerAvisosOperativos(session)).toEqual({ disponible: true, candidatos: 2, emitidas: 2, sinNuevas: 0, errores: 0 });
    const [sinAceptar, estancado] = emisiones;
    expect(sinAceptar![2]).toBe("restaurantes.pedido.sin_aceptar");
    expect(sinAceptar![5]).toBe("Un pedido lleva tiempo sin aceptarse");
    expect(sinAceptar![6]).toContain("#103");
    expect(sinAceptar![7]).toBe("/restaurantes/{orgSlug}/pedidos");
    expect(sinAceptar![10]).toBe(`restaurantes.pedido.sin_aceptar:${O3}`);
    expect(estancado![2]).toBe("restaurantes.pedido.estancado");
    expect(estancado![6]).toContain("#104");
    expect(estancado![10]).toBe(`restaurantes.pedido.estancado:${O4}`);
  });

  it("dos ticks dejan UNA alerta por pedido y tipo (segundo tick: sin nuevas)", async () => {
    const { session } = sesionConDedupe(NUEVOS);
    await barrerAvisosOperativos(session);
    expect(await barrerAvisosOperativos(session)).toMatchObject({ emitidas: 0, sinNuevas: 2, errores: 0 });
  });

  it("un tipo que este codigo no conoce se salta (nunca se emite con el texto de otro tipo)", async () => {
    const { session, emisiones } = sesionConDedupe([{ tipo: "restaurantes.pedido.futuro", order_id: O3, organization_id: ORG, property_id: PROP, order_number: 103 }]);
    expect(await barrerAvisosOperativos(session)).toMatchObject({ candidatos: 1, emitidas: 0, errores: 0 });
    expect(emisiones).toHaveLength(0);
  });
});
