// Alertas al dueño por falla del proveedor de WhatsApp: evaluacion pura sobre la corrida del despachador y emision con dedupe
// por (organizacion, dia de Merida), con reloj falso. Base sin migrar probada con AbortAwareFakeSession (estado abortado real).
import { afterEach, describe, expect, it, vi } from "vitest";
import { diaMerida } from "../src/alertas-duenio/dia.ts";
import { emitirAlertasProveedor, evaluarSaludProveedor } from "../src/alertas-duenio/proveedor.ts";
import type { ItemDespachoOrg } from "../src/alertas-duenio/proveedor.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

const A = "00000000-0000-0000-0000-00000000a001";
const B = "00000000-0000-0000-0000-00000000a002";

const falla = (organizationId: string, extra: Partial<ItemDespachoOrg> = {}): ItemDespachoOrg => ({ organizationId, outcome: "retry", proveedor: true, ...extra });

function pgError(code: string): Error & { code: string } {
  const err = new Error("function core.emit_notification(uuid, uuid, text) does not exist") as Error & { code: string };
  err.code = code;
  return err;
}

afterEach(() => vi.useRealTimers());

describe("evaluarSaludProveedor", () => {
  it("3 fallas del proveedor sin ningun envio exitoso de la organizacion = alerta de proveedor", () => {
    expect(evaluarSaludProveedor([falla(A), falla(A, { outcome: "dead" }), falla(A)])).toEqual([{ organizationId: A, tokenInvalido: false, proveedorFalla: true }]);
  });

  it("2 fallas no alcanzan el umbral; 3 fallas con UN envio exitoso tampoco (el proveedor responde)", () => {
    expect(evaluarSaludProveedor([falla(A), falla(A)])).toEqual([]);
    expect(evaluarSaludProveedor([falla(A), falla(A), falla(A), { organizationId: A, outcome: "sent" }])).toEqual([]);
  });

  it("solo cuentan las fallas del proveedor: payload invalido, suprimidos, cuota y circuito abierto no alertan", () => {
    const items: ItemDespachoOrg[] = [
      { organizationId: A, outcome: "dead" },
      { organizationId: A, outcome: "dead" },
      { organizationId: A, outcome: "suppressed" },
      { organizationId: A, outcome: "omitido_cuota" },
      { organizationId: A, outcome: "skipped_circuit_open" },
    ];
    expect(evaluarSaludProveedor(items)).toEqual([]);
  });

  it("el error 190 alerta de inmediato con UN solo mensaje y no cuenta ademas como falla de proveedor", () => {
    expect(evaluarSaludProveedor([falla(A, { outcome: "dead", graphCode: 190 })])).toEqual([{ organizationId: A, tokenInvalido: true, proveedorFalla: false }]);
    expect(evaluarSaludProveedor([falla(A, { outcome: "dead", graphCode: 190 }), falla(A), falla(A)])).toEqual([{ organizationId: A, tokenInvalido: true, proveedorFalla: false }]);
  });

  it("evalua por organizacion, sin mezclar fallas entre organizaciones, en orden estable", () => {
    const r = evaluarSaludProveedor([falla(B), falla(A), falla(B), falla(A), falla(B), { organizationId: A, outcome: "sent" }]);
    expect(r).toEqual([{ organizationId: B, tokenInvalido: false, proveedorFalla: true }]);
  });
});

describe("diaMerida", () => {
  it("usa el dia calendario de Merida (UTC-6), no el UTC: 03:00 UTC del 5 sigue siendo el 4 en Merida", () => {
    expect(diaMerida(new Date("2026-10-05T03:00:00Z"))).toBe("2026-10-04");
    expect(diaMerida(new Date("2026-10-05T06:00:00Z"))).toBe("2026-10-05");
  });
});

/** Sesion falsa con la semantica de dedupe de core.emit_notification (misma clave = 0 filas nuevas). */
function sesionConDedupe() {
  const vistas = new Set<string>();
  const emisiones: unknown[][] = [];
  const session = new AbortAwareFakeSession([{ match: /select core\.emit_notification/, respond: () => [{ emit_notification: 1 }] }]);
  const original = session.query.bind(session);
  session.query = (async (sql: string, p?: unknown[]) => {
    if (/select core\.emit_notification/.test(sql)) {
      const clave = `${String((p ?? [])[0])}|${String((p ?? [])[10])}`;
      emisiones.push(p ?? []);
      if (vistas.has(clave)) return { rows: [{ emit_notification: 0 }] };
      vistas.add(clave);
    }
    return original(sql, p);
  }) as typeof session.query;
  return { session, emisiones };
}

describe("emitirAlertasProveedor", () => {
  const diag = [{ organizationId: A, tokenInvalido: true, proveedorFalla: true }];

  it("emite con datos del catalogo, severidad critica, enlace relativo y solo el codigo de proveedor (sin PII)", async () => {
    const { session, emisiones } = sesionConDedupe();
    const r = await emitirAlertasProveedor(session, diag, new Date("2026-10-04T15:00:00Z"));
    expect(r).toEqual({ evaluadas: 2, emitidas: 2, sinNuevas: 0, errores: 0 });
    const [token, proveedor] = emisiones;
    expect(token![2]).toBe("restaurantes.whatsapp.token_invalido");
    expect(token![4]).toBe("critica");
    expect(token![7]).toBe("/restaurantes/{orgSlug}/configuracion");
    expect(token![10]).toBe("restaurantes.whatsapp.token_invalido:whatsapp:2026-10-04");
    expect(proveedor![2]).toBe("restaurantes.proveedor.falla");
    expect(proveedor![5]).toBe("Falla un proveedor del agente");
    expect(proveedor![6]).toBe("Proveedor: whatsapp.");
    expect(proveedor![10]).toBe("restaurantes.proveedor.falla:whatsapp:2026-10-04");
  });

  it("dedupe: una por proveedor por dia de Merida; al dia siguiente vuelve a avisar", async () => {
    vi.useFakeTimers();
    const { session } = sesionConDedupe();
    const manana = diaMerida(new Date("2026-10-05T07:00:00Z"));
    expect(manana).toBe("2026-10-05");
    const primero = await emitirAlertasProveedor(session, diag, new Date("2026-10-04T15:00:00Z"));
    const mismoDia = await emitirAlertasProveedor(session, diag, new Date("2026-10-05T03:30:00Z")); // 21:30 del 4 en Merida
    const diaSiguiente = await emitirAlertasProveedor(session, diag, new Date("2026-10-05T07:00:00Z"));
    expect(primero.emitidas).toBe(2);
    expect(mismoDia).toEqual({ evaluadas: 2, emitidas: 0, sinNuevas: 2, errores: 0 });
    expect(diaSiguiente.emitidas).toBe(2);
  });

  it("base sin migrar (42883 en core.emit_notification): no_disponible sin abortar la sesion; la consulta siguiente funciona", async () => {
    const session = new AbortAwareFakeSession([
      { match: /select core\.emit_notification/, respond: () => pgError("42883") },
      { match: /select 1 as siguiente/, respond: () => [{ siguiente: 1 }] },
    ]);
    const r = await emitirAlertasProveedor(session, diag, new Date("2026-10-04T15:00:00Z"));
    expect(r).toEqual({ evaluadas: 2, emitidas: 0, sinNuevas: 2, errores: 0 });
    const { rows } = await session.query("select 1 as siguiente");
    expect(rows).toEqual([{ siguiente: 1 }]);
  });
});
