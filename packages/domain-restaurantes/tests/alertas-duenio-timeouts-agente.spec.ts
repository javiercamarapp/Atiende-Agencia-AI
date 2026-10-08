// Timeouts y fallas seguidas del agente de WhatsApp: evaluacion pura con reloj fijo (miercoles 7-oct-2026 12:00 America/Merida = 18:00 UTC),
// casos limite (justo en el umbral, ventana vacia, un solo fallo), emision idempotente y adaptador Postgres (base sin migrar incluida).
import { describe, expect, it } from "vitest";
import {
  claseErrorTurno,
  crearLectorTurnosAgentePostgres,
  esClaseTimeout,
  evaluarTimeoutsAgente,
  vigilarAgenteWhatsapp,
} from "../src/alertas-duenio/timeouts-agente.ts";
import type { LectorTurnosAgente, ResultadoTurnoAgente, TurnoAgente } from "../src/alertas-duenio/timeouts-agente.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";
import { sesionConDedupe } from "./support/sesion-con-dedupe.ts";

const AHORA = new Date("2026-10-07T18:00:00Z");
const MIN = 60_000;
const A = "00000000-0000-0000-0000-00000000a001";
const B = "00000000-0000-0000-0000-00000000a002";
const turno = (minutosAtras: number, resultado: ResultadoTurnoAgente, organizationId = A): TurnoAgente => ({ organizationId, at: new Date(AHORA.getTime() - minutosAtras * MIN), resultado });
/** n turnos repartidos en la ventana, de los cuales `t` son timeout. */
function lote(n: number, t: number, organizationId = A): TurnoAgente[] {
  return Array.from({ length: n }, (_, i) => turno((i % 9) + 0.5, i < t ? "timeout" : "ok", organizationId));
}
const lector = (turnos: readonly TurnoAgente[] | null | Error): LectorTurnosAgente => ({
  leer: async () => {
    if (turnos instanceof Error) throw turnos;
    return turnos;
  },
});

describe("evaluarTimeoutsAgente: tasa en 10 minutos", () => {
  it("justo en el umbral: 1 timeout en 100 turnos = 1 % exacto NO alerta; 2 en 100 si", () => {
    expect(evaluarTimeoutsAgente(lote(100, 1), AHORA)).toMatchObject({ turnosVentana: 100, timeoutsVentana: 1, tasaPct: 1, alertaTasa: false });
    expect(evaluarTimeoutsAgente(lote(100, 2), AHORA)).toMatchObject({ turnosVentana: 100, timeoutsVentana: 2, alertaTasa: true });
  });

  it("101 turnos con 1 timeout (0,99 %) no alerta; 99 con 1 (1,01 %) si", () => {
    expect(evaluarTimeoutsAgente(lote(101, 1), AHORA).alertaTasa).toBe(false);
    expect(evaluarTimeoutsAgente(lote(99, 1), AHORA).alertaTasa).toBe(true);
  });

  it("ventana vacia: sin turnos no hay tasa ni alerta ni division entre cero", () => {
    expect(evaluarTimeoutsAgente([], AHORA)).toEqual({ turnosVentana: 0, timeoutsVentana: 0, tasaPct: 0, alertaTasa: false, rachas: [] });
  });

  it("un solo fallo: 1 turno con timeout (100 %) es muestra insuficiente y no es racha: no alerta", () => {
    const d = evaluarTimeoutsAgente([turno(1, "timeout")], AHORA);
    expect(d).toMatchObject({ turnosVentana: 1, timeoutsVentana: 1, tasaPct: 100, alertaTasa: false, rachas: [] });
  });

  it("muestra minima: con 19 turnos no evalua aunque haya timeouts; con 20 si", () => {
    expect(evaluarTimeoutsAgente(lote(19, 5), AHORA).alertaTasa).toBe(false);
    expect(evaluarTimeoutsAgente(lote(20, 5), AHORA).alertaTasa).toBe(true);
    expect(evaluarTimeoutsAgente(lote(5, 5), AHORA, { minTurnos: 1 }).alertaTasa).toBe(true);
  });

  it("limites de la ventana: el turno de hace exactamente 10 min cuenta; el de 10 min y 1 ms no; uno en el futuro no", () => {
    const dentro = [...lote(20, 0), turno(10, "timeout")];
    expect(evaluarTimeoutsAgente(dentro, AHORA)).toMatchObject({ turnosVentana: 21, timeoutsVentana: 1 });
    const fuera: TurnoAgente = { organizationId: A, at: new Date(AHORA.getTime() - 10 * MIN - 1), resultado: "timeout" };
    expect(evaluarTimeoutsAgente([...lote(20, 0), fuera], AHORA)).toMatchObject({ turnosVentana: 20, timeoutsVentana: 0 });
    const futuro: TurnoAgente = { organizationId: A, at: new Date(AHORA.getTime() + 1), resultado: "timeout" };
    expect(evaluarTimeoutsAgente([...lote(20, 0), futuro], AHORA).timeoutsVentana).toBe(0);
  });

  it("solo los timeouts cuentan para la tasa: los fallos de otra clase no", () => {
    expect(evaluarTimeoutsAgente([...lote(30, 0), turno(1, "fallo"), turno(2, "fallo")], AHORA)).toMatchObject({ timeoutsVentana: 0, alertaTasa: false });
  });
});

describe("evaluarTimeoutsAgente: fallos seguidos por organizacion", () => {
  it("5 fallos seguidos (timeout o fallo) alertan; 4 no", () => {
    expect(evaluarTimeoutsAgente([1, 2, 3, 4, 5].map((m) => turno(m, m % 2 ? "fallo" : "timeout")), AHORA).rachas).toEqual([{ organizationId: A, fallos: 5 }]);
    expect(evaluarTimeoutsAgente([1, 2, 3, 4].map((m) => turno(m, "fallo")), AHORA).rachas).toEqual([]);
  });

  it("un turno bien terminado rompe la racha: ok, fallo x4 mas reciente-primero", () => {
    // mas reciente primero: fallo, fallo, fallo, fallo, ok, fallo, fallo -> racha 4
    const t = [turno(1, "fallo"), turno(2, "fallo"), turno(3, "fallo"), turno(4, "fallo"), turno(5, "ok"), turno(6, "fallo"), turno(7, "fallo")];
    expect(evaluarTimeoutsAgente(t, AHORA).rachas).toEqual([]);
    // un ok MAS RECIENTE tambien la rompe aunque haya 5 fallos antes
    expect(evaluarTimeoutsAgente([turno(0.5, "ok"), ...[1, 2, 3, 4, 5].map((m) => turno(m, "fallo"))], AHORA).rachas).toEqual([]);
  });

  it("por organizacion: los fallos de B no suman a los de A, y salen ordenados por id", () => {
    const t = [...[1, 2, 3].map((m) => turno(m, "fallo", A)), ...[1, 2, 3].map((m) => turno(m, "fallo", B))];
    expect(evaluarTimeoutsAgente(t, AHORA).rachas).toEqual([]);
    const t2 = [...[1, 2, 3, 4, 5, 6].map((m) => turno(m, "fallo", B)), ...[1, 2, 3, 4, 5].map((m) => turno(m, "timeout", A))];
    expect(evaluarTimeoutsAgente(t2, AHORA).rachas).toEqual([{ organizationId: A, fallos: 5 }, { organizationId: B, fallos: 6 }]);
  });

  it("la racha mira hasta 60 min atras: exactamente 60 cuenta, 60 min y 1 ms no", () => {
    const en60 = [60, 59, 58, 57, 56].map((m) => turno(m, "fallo"));
    expect(evaluarTimeoutsAgente(en60, AHORA).rachas).toEqual([{ organizationId: A, fallos: 5 }]);
    const viejo: TurnoAgente = { organizationId: A, at: new Date(AHORA.getTime() - 60 * MIN - 1), resultado: "fallo" };
    expect(evaluarTimeoutsAgente([viejo, ...[59, 58, 57, 56].map((m) => turno(m, "fallo"))], AHORA).rachas).toEqual([]);
  });

  it("las rachas no dependen del orden de entrada", () => {
    const t = [1, 2, 3, 4, 5].map((m) => turno(m, "fallo"));
    expect(evaluarTimeoutsAgente([...t].reverse(), AHORA).rachas).toEqual(evaluarTimeoutsAgente(t, AHORA).rachas);
  });
});

describe("ConversationBusy (contrapresion) es neutral", () => {
  it("5 o mas ConversationBusy seguidos NO alertan: ni racha, ni cuentan como turnos de la ventana", () => {
    const busy = Array.from({ length: 8 }, (_, i) => turno(i + 0.5, "neutral"));
    expect(evaluarTimeoutsAgente(busy, AHORA)).toEqual({ turnosVentana: 0, timeoutsVentana: 0, tasaPct: 0, alertaTasa: false, rachas: [] });
  });

  it("intercalados entre fallos reales no reinician ni suman: 4 fallos + busy = sin racha; 5 fallos con busy en medio = racha de 5", () => {
    const cuatro = [turno(1, "fallo"), turno(1.5, "neutral"), turno(2, "fallo"), turno(2.5, "neutral"), turno(3, "fallo"), turno(4, "fallo"), turno(4.5, "neutral")];
    expect(evaluarTimeoutsAgente(cuatro, AHORA).rachas).toEqual([]);
    const cinco = [turno(1, "fallo"), turno(1.5, "neutral"), turno(2, "timeout"), turno(2.5, "neutral"), turno(3, "fallo"), turno(3.5, "neutral"), turno(4, "fallo"), turno(5, "fallo")];
    expect(evaluarTimeoutsAgente(cinco, AHORA).rachas).toEqual([{ organizationId: A, fallos: 5 }]);
  });

  it("un ConversationBusy mas reciente que los fallos tampoco rompe la racha, y un ok sigue rompiendola", () => {
    const f5 = [1, 2, 3, 4, 5].map((m) => turno(m, "fallo"));
    expect(evaluarTimeoutsAgente([turno(0.2, "neutral"), ...f5], AHORA).rachas).toHaveLength(1);
    expect(evaluarTimeoutsAgente([turno(0.2, "ok"), ...f5], AHORA).rachas).toHaveLength(0);
  });

  it("el adaptador Postgres traduce failed/ConversationBusy a neutral; y 8 de ellos no emiten ninguna alerta", async () => {
    const filas = Array.from({ length: 8 }, (_, i) => ({ organization_id: A, claimed_at: new Date(AHORA.getTime() - (i + 1) * MIN), status: "failed", last_error_class: "ConversationBusy" }));
    const session = new AbortAwareFakeSession([{ match: /restaurantes\.agente_turnos_recientes/, respond: () => filas }, { match: /select core\.emit_notification/, respond: () => [{ emit_notification: 1 }] }]);
    const turnos = await crearLectorTurnosAgentePostgres(session).leer(new Date(AHORA.getTime() - 60 * MIN), AHORA);
    expect(turnos!.every((t) => t.resultado === "neutral")).toBe(true);
    const r = await vigilarAgenteWhatsapp(session, crearLectorTurnosAgentePostgres(session), AHORA);
    expect(r).toMatchObject({ disponible: true, emitidas: 0, errores: 0 });
    expect(session.calls.filter((c) => /emit_notification/.test(String(c))).length).toBe(0);
  });
});

describe("clasificacion de errores de turno", () => {
  it("esClaseTimeout reconoce TimeoutError/AbortError/variantes y rechaza lo demas", () => {
    for (const c of ["TimeoutError", "AbortError", "GatewayTimeoutError", "RequestTimedOut"]) expect(esClaseTimeout(c), c).toBe(true);
    for (const c of ["Error", "TypeError", "UnknownError", "", null, undefined]) expect(esClaseTimeout(c), String(c)).toBe(false);
  });

  it("claseErrorTurno: un DOMException TimeoutError o un Error 'timed out' se guardan como TimeoutError; el resto conserva su clase", () => {
    expect(claseErrorTurno(new DOMException("The operation timed out", "TimeoutError"))).toBe("TimeoutError");
    expect(claseErrorTurno(new DOMException("aborted", "AbortError"))).toBe("TimeoutError");
    expect(claseErrorTurno(new Error("request timed out after 45000ms"))).toBe("TimeoutError");
    expect(claseErrorTurno(new TypeError("x is undefined"))).toBe("TypeError");
    expect(claseErrorTurno(new Error("current transaction is aborted"))).toBe("Error");
    expect(claseErrorTurno("texto")).toBe("UnknownError");
  });
});

describe("vigilarAgenteWhatsapp", () => {
  it("tasa alta: UN aviso de plataforma con porcentaje y turnos, severidad critica, clave por cubeta de 30 min", async () => {
    const { session, emisiones } = sesionConDedupe();
    const r = await vigilarAgenteWhatsapp(session, lector(lote(100, 2)), AHORA);
    expect(r).toMatchObject({ disponible: true, emitidas: 1, errores: 0 });
    expect(emisiones).toHaveLength(1);
    const e = emisiones[0]!;
    expect(e[0]).toBeNull();
    expect(e[2]).toBe("superadmin.agente.timeouts_altos");
    expect(e[4]).toBe("critica");
    expect(e[5]).toBe("El agente de WhatsApp tiene 2 por ciento de turnos con timeout");
    expect(e[6]).toContain("100 turnos");
    expect(String(e[10])).toMatch(/^superadmin\.agente\.timeouts_altos:c\d+$/);
  });

  it("redondeo del porcentaje a un decimal: 3 timeouts en 140 turnos (2,142857 %) se avisan como 2.1, y la alerta es una sola", async () => {
    const { session, emisiones } = sesionConDedupe();
    await vigilarAgenteWhatsapp(session, lector(lote(140, 3)), AHORA);
    expect(emisiones[0]![5]).toBe("El agente de WhatsApp tiene 2.1 por ciento de turnos con timeout");
  });

  it("dedupe: dos ticks de 5 min en la misma cubeta emiten una; en la cubeta siguiente, otra", async () => {
    const { session } = sesionConDedupe();
    const turnos = lote(100, 5);
    const a = await vigilarAgenteWhatsapp(session, lector(turnos), AHORA);
    const b = await vigilarAgenteWhatsapp(session, lector(turnos), new Date(AHORA.getTime() + 5 * MIN));
    expect(a.emitidas).toBe(1);
    expect(b.emitidas).toBe(0);
    const c = await vigilarAgenteWhatsapp(session, lector(lote(100, 5).map((t) => ({ ...t, at: new Date(t.at.getTime() + 35 * MIN) }))), new Date(AHORA.getTime() + 35 * MIN));
    expect(c.emitidas).toBe(1);
  });

  it("racha: avisa al duenio de ESA organizacion (restaurantes.proveedor.falla, proveedor agente) y al operador, una vez por dia de Merida", async () => {
    const { session, emisiones } = sesionConDedupe();
    const turnos = [1, 2, 3, 4, 5].map((m) => turno(m, "fallo"));
    const r = await vigilarAgenteWhatsapp(session, lector(turnos), AHORA);
    expect(r.emitidas).toBe(2);
    const dueno = emisiones.find((e) => e[2] === "restaurantes.proveedor.falla")!;
    expect(dueno[0]).toBe(A);
    expect(dueno[6]).toBe("Proveedor: agente.");
    expect(dueno[10]).toBe("restaurantes.proveedor.falla:agente:2026-10-07");
    const op = emisiones.find((e) => e[2] === "superadmin.agente.fallos_seguidos")!;
    expect(op[0]).toBeNull();
    expect(op[5]).toBe("Una organización acumula 5 fallos seguidos del agente de WhatsApp");
    expect(op[6]).toBe("Organización: 00000000. Revisa el proveedor del modelo y la conexión de WhatsApp de esa organización.");
    const otra = await vigilarAgenteWhatsapp(session, lector(turnos), new Date(AHORA.getTime() + 5 * MIN));
    expect(otra.emitidas).toBe(0);
  });

  it("sin problema (ventana vacia, un solo fallo): no emite nada", async () => {
    const { session, emisiones } = sesionConDedupe();
    expect(await vigilarAgenteWhatsapp(session, lector([]), AHORA)).toMatchObject({ disponible: true, emitidas: 0 });
    expect(await vigilarAgenteWhatsapp(session, lector([turno(1, "fallo")]), AHORA)).toMatchObject({ disponible: true, emitidas: 0 });
    expect(emisiones).toHaveLength(0);
  });

  it("fuente no disponible (null) o lector que falla: no alerta ni lanza", async () => {
    const { session, emisiones } = sesionConDedupe();
    expect(await vigilarAgenteWhatsapp(session, lector(null), AHORA)).toMatchObject({ disponible: false, emitidas: 0 });
    expect(await vigilarAgenteWhatsapp(session, lector(new Error("boom")), AHORA)).toMatchObject({ disponible: false, emitidas: 0 });
    expect(emisiones).toHaveLength(0);
  });

  it("pide al lector la ventana mas larga entre la de tasa y la de racha (60 min) terminando ahora", async () => {
    const { session } = sesionConDedupe();
    const visto: Date[] = [];
    await vigilarAgenteWhatsapp(session, { leer: async (d, h) => { visto.push(d, h); return []; } }, AHORA);
    expect(visto[0]!.toISOString()).toBe("2026-10-07T17:00:00.000Z");
    expect(visto[1]!.toISOString()).toBe(AHORA.toISOString());
  });
});

describe("crearLectorTurnosAgentePostgres", () => {
  const desde = new Date(AHORA.getTime() - 60 * MIN);

  it("traduce las filas: processed = ok; failed con clase de timeout = timeout; otro failed = fallo", async () => {
    const session = new AbortAwareFakeSession([
      {
        match: /restaurantes\.agente_turnos_recientes/,
        respond: () => [
          { organization_id: A, claimed_at: "2026-10-07T17:59:00Z", status: "processed", last_error_class: null },
          { organization_id: A, claimed_at: new Date("2026-10-07T17:58:00Z"), status: "failed", last_error_class: "TimeoutError" },
          { organization_id: B, claimed_at: "2026-10-07T17:57:00Z", status: "failed", last_error_class: "TypeError" },
        ],
      },
    ]);
    const turnos = await crearLectorTurnosAgentePostgres(session).leer(desde, AHORA);
    expect(turnos!.map((t) => t.resultado)).toEqual(["ok", "timeout", "fallo"]);
    expect(turnos![1]!.at.toISOString()).toBe("2026-10-07T17:58:00.000Z");
  });

  it("base sin la migracion 085 (42883): devuelve null sin abortar la sesion; la consulta siguiente funciona", async () => {
    const err = Object.assign(new Error("function restaurantes.agente_turnos_recientes(timestamp with time zone, timestamp with time zone) does not exist"), { code: "42883" });
    const session = new AbortAwareFakeSession([
      { match: /restaurantes\.agente_turnos_recientes/, respond: () => err },
      { match: /select 1 as siguiente/, respond: () => [{ siguiente: 1 }] },
    ]);
    expect(await crearLectorTurnosAgentePostgres(session).leer(desde, AHORA)).toBeNull();
    expect((await session.query("select 1 as siguiente")).rows).toEqual([{ siguiente: 1 }]);
  });

  it("un error que no es de migracion pendiente se propaga (no se enmascara)", async () => {
    const session = new AbortAwareFakeSession([{ match: /restaurantes\.agente_turnos_recientes/, respond: () => Object.assign(new Error("permission denied"), { code: "42501" }) }]);
    await expect(crearLectorTurnosAgentePostgres(session).leer(desde, AHORA)).rejects.toThrow("permission denied");
  });
});
