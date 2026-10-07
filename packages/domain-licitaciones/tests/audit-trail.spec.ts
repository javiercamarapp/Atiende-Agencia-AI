// L-P3-17 -- piezas puras y SQL de la bitacora de escrituras. El SQL real (append-only, RLS, grants) se prueba en
// scripts/verify-licitaciones-stepup-y-bitacora contra Postgres real; aqui, el saneado, la lista cerrada de campos y la compatibilidad con la base sin
// migrar sobre AbortAwareFakeSession (reproduce el estado abortado 25P02: una sesion falsa plana no serviria).
import { describe, expect, it } from "vitest";
import { appendAuditoria, listAuditoria, newCorrelationId, pickAuditFields, sanitizeCorrelationId, tenderCorrelationId } from "../src/audit-trail.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

const ORG = "00000000-0000-4000-8000-000000000001";
const pendiente = () => Object.assign(new Error("function licitaciones.append_audit(uuid, uuid, text, text, text, jsonb, jsonb, text) does not exist"), { code: "42883" });

describe("sanitizeCorrelationId", () => {
  it("acepta 1..64 caracteres [A-Za-z0-9._:-] y descarta lo demas (nunca recorta ni interpreta)", () => {
    expect(sanitizeCorrelationId("ingesta.2026-10-04:abc_1")).toBe("ingesta.2026-10-04:abc_1");
    expect(sanitizeCorrelationId("  c-1  ")).toBe("c-1");
    for (const bad of ["", "   ", "x".repeat(65), "con espacio", "a;b", "<script>", "a/b", "ñandú", "a\nb", undefined, null]) expect(sanitizeCorrelationId(bad as string | null | undefined), String(bad)).toBeNull();
    expect(sanitizeCorrelationId("x".repeat(64))).toBe("x".repeat(64));
  });
  it("newCorrelationId produce un id valido y unico", () => {
    const a = newCorrelationId();
    expect(sanitizeCorrelationId(a)).toBe(a);
    expect(newCorrelationId()).not.toBe(a);
  });
});

describe("pickAuditFields", () => {
  it("solo toma la lista cerrada, descarta nombres con aspecto de secreto y valores no escalares", () => {
    const entidad = { id: "1", concept: "x", unitPrice: "1.00", token: "no", passwordHash: "no", nested: { a: 1 }, validUntil: null, tags: ["a", "b"], objs: [{ a: 1 }], when: new Date("2026-01-01T00:00:00Z") };
    expect(pickAuditFields(entidad, ["concept", "unitPrice", "token", "passwordHash", "nested", "validUntil", "tags", "objs", "when", "ausente"])).toEqual({
      concept: "x",
      unitPrice: "1.00",
      validUntil: null,
      tags: ["a", "b"],
      when: "2026-01-01T00:00:00.000Z",
    });
    expect(pickAuditFields(null, ["a"])).toBeNull();
  });

  it("recorta las listas de mas de 100 elementos y registra el total real", () => {
    const largo = Array.from({ length: 150 }, (_, i) => `k${i}`);
    const r = pickAuditFields({ keywords: largo }, ["keywords"])!;
    expect((r.keywords as string[]).length).toBe(100);
    expect(r.keywordsTotal).toBe(150);
  });
});

describe("appendAuditoria / listAuditoria / tenderCorrelationId sobre una transaccion compartida", () => {
  const entry = { entity: "tarifa", entityId: "r1", action: "tarifa.editada", before: { a: 1 }, after: { a: 2 }, actorId: "u1", correlationId: "c-1" } as const;

  it("con la 038: anota con los 8 parametros del SQL y devuelve true", async () => {
    const session = new AbortAwareFakeSession([{ match: /licitaciones\.append_audit/, respond: () => [{ append_audit: "id" }] }]);
    expect(await appendAuditoria(session, ORG, entry)).toBe(true);
  });

  it("sin la 038 (42883): devuelve false y la transaccion SIGUE VIVA (ROLLBACK TO SAVEPOINT), no 25P02", async () => {
    const session = new AbortAwareFakeSession([
      { match: /licitaciones\.append_audit/, respond: pendiente },
      { match: /select 1 as vivo/, respond: () => [{ vivo: 1 }] },
    ]);
    expect(await appendAuditoria(session, ORG, entry)).toBe(false);
    await expect(session.query("select 1 as vivo")).resolves.toEqual({ rows: [{ vivo: 1 }] });
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
  });

  it("un error de permisos (42501) NO se traga: se repropaga y la escritura de negocio se revierte", async () => {
    const err = Object.assign(new Error("append_audit: sin rol de escritura en la organizacion"), { code: "42501" });
    const session = new AbortAwareFakeSession([{ match: /licitaciones\.append_audit/, respond: () => err }]);
    await expect(appendAuditoria(session, ORG, entry)).rejects.toBe(err);
  });

  it("lectura sin la 038 (42P01): pagina vacia con available:false y sesion viva", async () => {
    const err = Object.assign(new Error('relation "licitaciones.audit_trail" does not exist'), { code: "42P01" });
    const session = new AbortAwareFakeSession([
      { match: /licitaciones\.audit_trail/, respond: () => err },
      { match: /select 1 as vivo/, respond: () => [{ vivo: 1 }] },
    ]);
    expect(await listAuditoria(session, ORG, {})).toEqual({ items: [], nextCursor: null, available: false });
    await expect(session.query("select 1 as vivo")).resolves.toBeDefined();
  });

  it("lectura: topa el limite, pide uno de mas para saber si hay siguiente y devuelve el cursor por llave", async () => {
    const fila = (n: number) => ({ id: `i${n}`, seq: String(100 - n), entity: "tarifa", entity_id: "r", action: "a", before: null, after: null, actor_id: null, correlation_id: null, created_at: "2026-10-04T10:00:00Z" });
    const session = new AbortAwareFakeSession([{ match: /licitaciones\.audit_trail/, respond: () => [fila(0), fila(1), fila(2)] }]);
    const page = await listAuditoria(session, ORG, { entity: "tarifa" }, { limit: 2 });
    expect(page.items.map((i) => i.seq)).toEqual(["100", "99"]);
    expect(page.nextCursor).toBe("99");
    expect(page.available).toBe(true);
  });

  it("tenderCorrelationId sanea lo que devuelve la base y cae a null sin la 038", async () => {
    const ok = new AbortAwareFakeSession([{ match: /tender_correlation_id/, respond: () => [{ c: "origen-1" }] }]);
    expect(await tenderCorrelationId(ok, ORG, "t1")).toBe("origen-1");
    const raro = new AbortAwareFakeSession([{ match: /tender_correlation_id/, respond: () => [{ c: "con espacio" }] }]);
    expect(await tenderCorrelationId(raro, ORG, "t1")).toBeNull();
    const viejo = new AbortAwareFakeSession([{ match: /tender_correlation_id/, respond: pendiente }]);
    expect(await tenderCorrelationId(viejo, ORG, "t1")).toBeNull();
  });
});
