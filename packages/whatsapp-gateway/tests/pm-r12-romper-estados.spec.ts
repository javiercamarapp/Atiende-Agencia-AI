// R12 romper (ronda 2) -- proveedor de WhatsApp: estados de entrega (`statuses`) que llegan en desorden, repetidos, mal formados o enormes. Puro (sin red, sin base).
// La regla: un estado nunca retrocede (`read` antes que `delivered`), `failed` gana y es terminal, repetir no cambia nada y un payload hostil nunca lanza ni tarda.
import { describe, expect, it } from "vitest";
import { ESTADOS_ENTREGA, avanzarEstadoEntrega, extractMetaStatuses, motivoFalloEntrega } from "../src/statuses.ts";
import type { EstadoEntrega } from "../src/statuses.ts";

const payload = (statuses: unknown) => ({ entry: [{ changes: [{ value: { metadata: { phone_number_id: "pn-1" }, statuses } }] }] });

describe("R12-E5 orden de los estados de entrega", () => {
  const rango: Record<EstadoEntrega, number> = { sent: 1, delivered: 2, read: 3, failed: 4 };

  it("tabla completa: ninguna combinacion retrocede; `failed` es terminal; el mismo estado repetido no cambia nada", () => {
    for (const actual of [null, ...ESTADOS_ENTREGA] as const) {
      for (const nuevo of ESTADOS_ENTREGA) {
        const r = avanzarEstadoEntrega(actual, nuevo);
        if (actual === null) expect(r).toBe(nuevo);
        else if (actual === "failed") expect(r).toBe("failed");
        else expect(rango[r]).toBe(Math.max(rango[actual], rango[nuevo]));
        if (actual === nuevo) expect(r).toBe(actual);
      }
    }
  });

  it("llegada en desorden de una secuencia real (read, sent, delivered, sent): termina en `read`", () => {
    const orden: EstadoEntrega[] = ["read", "sent", "delivered", "sent"];
    expect(orden.reduce<EstadoEntrega | null>((acc, e) => avanzarEstadoEntrega(acc, e), null)).toBe("read");
  });

  it("un `failed` tardio gana sobre `read` (Meta reporta el fallo despues) y ningun estado posterior lo levanta", () => {
    const secuencia: EstadoEntrega[] = ["sent", "delivered", "read", "failed", "read", "delivered"];
    expect(secuencia.reduce<EstadoEntrega | null>((acc, e) => avanzarEstadoEntrega(acc, e), null)).toBe("failed");
  });

  it("clasifica los codigos de error de Meta sin lanzar con valores raros", () => {
    expect(motivoFalloEntrega(131047)).toBe("fuera_de_ventana");
    expect(motivoFalloEntrega(131026)).toBe("numero_no_entregable");
    expect(motivoFalloEntrega(132015)).toBe("plantilla");
    for (const raro of [null, -1, 0, Number.NaN, 2 ** 40]) expect(() => motivoFalloEntrega(raro as number)).not.toThrow();
  });
});

describe("R12-E6 payloads de `statuses` hostiles o rotos", () => {
  it.each([[null], [undefined], [42], ["x"], [[]], [{}], [{ entry: "x" }], [{ entry: [null, 3, "x"] }], [{ entry: [{ changes: [null, 1, { value: null }] }] }]])("payload raro %j: devuelve [] sin lanzar", (raro) => {
    expect(() => extractMetaStatuses(raro)).not.toThrow();
    expect(extractMetaStatuses(raro)).toEqual([]);
  });

  it("estados desconocidos (`deleted`, `warning`), wamid vacio o de 300 caracteres y elementos que no son objeto se ignoran; los validos se conservan en orden", () => {
    const r = extractMetaStatuses(payload([
      null, 3, "x", { id: "", status: "sent" }, { id: "x".repeat(300), status: "sent" }, { id: "w1", status: "deleted" }, { id: "w2", status: "warning" },
      { id: "w3", status: "delivered", timestamp: "1790000000" }, { id: "w4", status: "failed", errors: [{ code: 131047, title: "Re-engagement message" }] },
    ]));
    expect(r.map((s) => [s.wamid, s.status])).toEqual([["w3", "delivered"], ["w4", "failed"]]);
    expect(r[1]!.errorCode).toBe(131047);
  });

  it("marcas de tiempo absurdas (negativa, 0, texto, futuro lejano, NaN) no lanzan: occurredAt es una fecha valida o null", () => {
    for (const timestamp of [-5, 0, "abc", "99999999999999", Number.NaN, 1e20, {}, [], null]) {
      const [s] = extractMetaStatuses(payload([{ id: "w1", status: "sent", timestamp }]));
      expect(s).toBeDefined();
      expect(s!.occurredAt === null || !Number.isNaN(new Date(s!.occurredAt).getTime())).toBe(true);
    }
  });

  it("errores raros (codigo negativo, decimal, enorme, titulo de 10 000 caracteres, errors que no es lista) se acotan; el titulo se recorta a 120", () => {
    const [a] = extractMetaStatuses(payload([{ id: "w1", status: "failed", errors: [{ code: -1, title: "x".repeat(10_000) }] }]));
    expect(a!.errorCode).toBeNull();
    expect(a!.errorTitle!.length).toBeLessThanOrEqual(120);
    for (const errors of ["x", 7, {}, [null], [7], [[]]]) expect(() => extractMetaStatuses(payload([{ id: "w2", status: "failed", errors }]))).not.toThrow();
    const [b] = extractMetaStatuses(payload([{ id: "w3", status: "failed", errors: [{ code: 2 ** 40 }] }]));
    expect(b!.errorCode).toBeNull();
  });

  it("20 000 estados en un payload se procesan rapido (sin trabajo cuadratico) y el telefono del destinatario solo se entrega, nunca se mezcla con otro campo", () => {
    const t0 = Date.now();
    const muchos = Array.from({ length: 20_000 }, (_v, i) => ({ id: `w${i}`, status: i % 2 ? "read" : "delivered", recipient_id: "5219991234567" }));
    const r = extractMetaStatuses(payload(muchos));
    expect(r).toHaveLength(20_000);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(JSON.stringify(r[0])).not.toMatch(/conversation|pricing|body|text/i);
  });
});
