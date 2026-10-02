// L-29 -- mezcla pura de la bitacora por convocatoria: orden temporal total, filtros, paginacion y privacidad.
import { describe, expect, it } from "vitest";
import { BITACORA_MAX_LIMIT, buildBitacoraEventos, isBitacoraFuente, paginarBitacora } from "../src/index.ts";
import type { Approval, BitacoraFuentes } from "../src/index.ts";

const YO = "11111111-1111-4111-8111-111111111111";
const OTRO = "22222222-2222-4222-8222-222222222222";

const aprobacion = (over: Partial<Approval>): Approval => ({
  id: "ap1",
  scope: "expediente",
  scopeRef: "expediente",
  approvedBy: OTRO,
  approvedByRole: "analyst",
  approvedAt: "2026-10-03T10:00:00.000Z",
  inputsHash: "h" as never,
  status: "vigente",
  stage: "tecnica_legal",
  ...over,
});

const FUENTES: BitacoraFuentes = {
  auditoria: [{ id: "a1", action: "tender.manual_upsert.created", actorId: YO, createdAt: "2026-10-01T09:00:00.000Z" }],
  salaGuerra: [
    { id: "s1", organizationId: "o", tenderId: "t", itemId: null, entryKind: "comentario", body: "Pedir carta al fabricante", authorId: OTRO, createdAt: "2026-10-02T09:00:00.000Z" },
    { id: "s2", organizationId: "o", tenderId: "t", itemId: null, entryKind: "evento", body: "Se importaron 3 requisitos.", authorId: OTRO, createdAt: "2026-10-02T09:00:00.000Z" },
  ],
  goNoGo: [{ id: "g1", organizationId: "o", tenderId: "t", decision: "go", reasons: ["a", "b"], matchScore: 80, matchEligibilityStatus: "cumple", matchInputsHash: "x", decidedBy: YO, decidedAt: "2026-10-01T12:00:00.000Z" }],
  aprobaciones: [aprobacion({}), aprobacion({ id: "ap2", stage: "economica", approvedBy: YO, approvedByRole: "owner", approvedAt: "2026-10-03T11:00:00.000Z" }), aprobacion({ id: "ap3", scope: "seccion", scopeRef: "seccion:x" })],
  presentacion: { id: "p1", status: "submitted", submittedAt: "2026-10-05T00:00:00.000Z", acknowledgementStorageRef: null, acknowledgementFileHash: null, notes: null, createdAt: "2026-10-05T10:00:00.000Z" },
};

describe("buildBitacoraEventos / paginarBitacora", () => {
  const eventos = buildBitacoraEventos(FUENTES, YO);

  it("une todas las fuentes y descarta aprobaciones de seccion", () => {
    expect(eventos.map((e) => e.id).sort()).toEqual(
      ["aprobacion:ap1", "aprobacion:ap2", "auditoria:a1", "go_no_go:g1", "presentacion:p1", "sala_guerra:s1", "sala_guerra:s2"].sort(),
    );
  });

  it("orden temporal descendente con desempate total estable (mismo instante -> id desc)", () => {
    const pag = paginarBitacora(eventos, {});
    expect(pag.items[0]!.id).toBe("presentacion:p1");
    const idx = (id: string) => pag.items.findIndex((e) => e.id === id);
    expect(idx("sala_guerra:s2")).toBeLessThan(idx("sala_guerra:s1"));
    expect(paginarBitacora(eventos, {})).toEqual(pag);
  });

  it("no filtra ids ni correos de otras personas: solo esTuyo y rol", () => {
    const crudo = JSON.stringify(eventos);
    expect(crudo).not.toContain(OTRO);
    expect(crudo).not.toContain(YO);
    expect(eventos.find((e) => e.id === "auditoria:a1")!.actor.esTuyo).toBe(true);
    expect(eventos.find((e) => e.id === "aprobacion:ap1")!.actor).toEqual({ esTuyo: false, rol: "analyst" });
    expect(eventos.find((e) => e.id === "sala_guerra:s2")!.actor.esTuyo).toBeNull();
  });

  it("filtra por fuente y por rango (inclusivo)", () => {
    expect(paginarBitacora(eventos, { fuente: "sala_guerra" }).total).toBe(2);
    expect(paginarBitacora(eventos, { fuente: "aprobacion" }).total).toBe(2);
    const rango = paginarBitacora(eventos, { desde: "2026-10-02T00:00:00.000Z", hasta: "2026-10-03T23:59:59.000Z" });
    expect(rango.items.map((e) => e.fuente).sort()).toEqual(["aprobacion", "aprobacion", "sala_guerra", "sala_guerra"]);
  });

  it("pagina sin repetir ni perder filas y reporta nextOffset", () => {
    const vistos: string[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const p: ReturnType<typeof paginarBitacora> = paginarBitacora(eventos, {}, { limit: 3, offset });
      expect(p.total).toBe(eventos.length);
      vistos.push(...p.items.map((e) => e.id));
      offset = p.nextOffset;
    }
    expect(vistos).toHaveLength(eventos.length);
    expect(new Set(vistos).size).toBe(eventos.length);
  });

  it("acota limit/offset absurdos y reconoce las fuentes validas", () => {
    expect(paginarBitacora(eventos, {}, { limit: 99999 }).limit).toBe(BITACORA_MAX_LIMIT);
    expect(paginarBitacora(eventos, {}, { limit: -4, offset: -9 })).toMatchObject({ limit: 1, offset: 0 });
    expect(isBitacoraFuente("go_no_go")).toBe(true);
    expect(isBitacoraFuente("otra")).toBe(false);
  });

  it("organizacion sin nada -> pagina vacia honesta", () => {
    const vacia = buildBitacoraEventos({ auditoria: [], salaGuerra: [], goNoGo: [], aprobaciones: [], presentacion: null }, YO);
    expect(paginarBitacora(vacia, {})).toMatchObject({ items: [], total: 0, nextOffset: null });
  });
});
