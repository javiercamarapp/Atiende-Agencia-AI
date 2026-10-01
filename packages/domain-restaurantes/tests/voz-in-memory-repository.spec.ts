import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryVozRepository, VozNoDisponibleError, VozRechazadaError } from "../src/index.ts";

const ORG_A = "org-a";
const ORG_B = "org-b";
const P_A = "prop-a";
const P_B = "prop-b";

function nuevo(): InMemoryVozRepository {
  const r = new InMemoryVozRepository();
  r.seedProperty(P_A, ORG_A);
  r.seedProperty(P_B, ORG_B);
  r.seedOrder("ped-a", ORG_A);
  r.seedOrder("ped-b", ORG_B);
  return r;
}
const inicio = (organizationId = ORG_A, propertyId = P_A, externalId = "sala-1") => ({ organizationId, propertyId, externalId, canal: "llamada" as const, proveedor: "gemini-3.8-live" as const, voiceId: "Kore", callerHash: null, startedAt: null });
const turno = (conversationId: string, seq: number, latenciaMs: number | null, costoMicroUsd: number, organizationId = ORG_A) => ({ organizationId, conversationId, seq, rol: "cliente" as const, texto: "hola", duracionMs: 100, latenciaMs, costoMicroUsd });

describe("InMemoryVozRepository (reglas que la base real impone)", () => {
  let repo: InMemoryVozRepository;
  beforeEach(() => {
    repo = nuevo();
  });

  it("iniciar es idempotente por external_id y rechaza sucursal ajena o external_id de otra sucursal", async () => {
    const id = await repo.iniciarConversacion(inicio());
    expect(await repo.iniciarConversacion(inicio())).toBe(id);
    await expect(repo.iniciarConversacion(inicio(ORG_A, P_B))).rejects.toBeInstanceOf(VozRechazadaError);
    repo.seedProperty("prop-a2", ORG_A);
    await expect(repo.iniciarConversacion(inicio(ORG_A, "prop-a2", "sala-1"))).rejects.toBeInstanceOf(VozRechazadaError);
  });

  it("registrar turno: idempotente por seq, ajeno rechazado, cerrada rechazada", async () => {
    const id = await repo.iniciarConversacion(inicio());
    expect(await repo.registrarTurno(turno(id, 0, 400, 100))).toBe(true);
    expect(await repo.registrarTurno(turno(id, 0, 400, 100))).toBe(false);
    await expect(repo.registrarTurno(turno(id, 1, 1, 1, ORG_B))).rejects.toBeInstanceOf(VozRechazadaError);
    await repo.cerrarConversacion({ organizationId: ORG_A, conversationId: id, resultado: "abandonado", endedAt: null, orderId: null });
    await expect(repo.registrarTurno(turno(id, 2, 1, 1))).rejects.toBeInstanceOf(VozRechazadaError);
  });

  it("cerrar calcula costo (suma) y p95 de latencia desde los turnos, no desde el llamador", async () => {
    const id = await repo.iniciarConversacion(inicio());
    await repo.registrarTurno(turno(id, 0, 400, 100));
    await repo.registrarTurno(turno(id, 1, 900, 200));
    await repo.registrarTurno(turno(id, 2, null, 0));
    expect(await repo.cerrarConversacion({ organizationId: ORG_A, conversationId: id, resultado: "pedido_creado", endedAt: null, orderId: "ped-a" })).toBe(true);
    const { valor } = await repo.getConversacion(ORG_A, P_A, id);
    expect(valor?.conversacion).toMatchObject({ costoEstimadoMicroUsd: 300, latenciaP95Ms: 900, resultado: "pedido_creado", orderId: "ped-a" });
    expect(valor?.turnos.map((t) => t.seq)).toEqual([0, 1, 2]);
    expect(await repo.cerrarConversacion({ organizationId: ORG_A, conversationId: id, resultado: "escalado", endedAt: null, orderId: null })).toBe(false);
  });

  it("cerrar rechaza un pedido de otra organizacion y no toca conversaciones ajenas", async () => {
    const id = await repo.iniciarConversacion(inicio());
    await expect(repo.cerrarConversacion({ organizationId: ORG_A, conversationId: id, resultado: "pedido_creado", endedAt: null, orderId: "ped-b" })).rejects.toBeInstanceOf(VozRechazadaError);
    expect(await repo.cerrarConversacion({ organizationId: ORG_B, conversationId: id, resultado: "abandonado", endedAt: null, orderId: null })).toBe(false);
  });

  it("lectura: aislada por organizacion y sucursal, filtra por resultado, pagina", async () => {
    const a1 = await repo.iniciarConversacion(inicio(ORG_A, P_A, "s1"));
    repo.reloj = () => Date.now() + 1000;
    const a2 = await repo.iniciarConversacion(inicio(ORG_A, P_A, "s2"));
    await repo.iniciarConversacion(inicio(ORG_B, P_B, "s3"));
    await repo.cerrarConversacion({ organizationId: ORG_A, conversationId: a1, resultado: "escalado", endedAt: null, orderId: null });
    const todas = await repo.listConversaciones(ORG_A, P_A, {});
    expect(todas.valor.total).toBe(2);
    expect(todas.valor.items.map((c) => c.id)).toEqual([a2, a1]);
    expect((await repo.listConversaciones(ORG_A, P_A, { resultado: "escalado" })).valor.items.map((c) => c.id)).toEqual([a1]);
    expect((await repo.listConversaciones(ORG_A, P_A, { limit: 1, offset: 1 })).valor.items.map((c) => c.id)).toEqual([a1]);
    expect((await repo.listConversaciones(ORG_B, P_A, {})).valor.total).toBe(0);
    expect((await repo.getConversacion(ORG_B, P_B, a1)).valor).toBeNull();
    expect((await repo.getConversacion(ORG_A, P_B, a1)).valor).toBeNull();
  });

  it("preview: se consume UNA sola vez, no expirada, solo con la organizacion/sucursal correctas", async () => {
    const s = await repo.crearPreviewSession({ organizationId: ORG_A, propertyId: P_A, createdBy: "u1", proveedor: "gemini-3.8-live", voiceId: "Kore", ttlSegundos: 300 });
    expect(await repo.consumirPreview({ sessionId: s.id, organizationId: ORG_B, propertyId: P_A })).toBe(false);
    expect(await repo.consumirPreview({ sessionId: s.id, organizationId: ORG_A, propertyId: P_B })).toBe(false);
    expect(await repo.consumirPreview({ sessionId: s.id, organizationId: ORG_A, propertyId: P_A })).toBe(true);
    expect(await repo.consumirPreview({ sessionId: s.id, organizationId: ORG_A, propertyId: P_A })).toBe(false);

    const e = await repo.crearPreviewSession({ organizationId: ORG_A, propertyId: P_A, createdBy: "u1", proveedor: "gemini-3.8-live", voiceId: "Kore", ttlSegundos: 60 });
    repo.reloj = () => Date.now() + 61_000;
    expect(await repo.consumirPreview({ sessionId: e.id, organizationId: ORG_A, propertyId: P_A })).toBe(false);
    await expect(repo.crearPreviewSession({ organizationId: ORG_A, propertyId: P_A, createdBy: "u1", proveedor: "gemini-3.8-live", voiceId: "Kore", ttlSegundos: 901 })).rejects.toBeInstanceOf(VozRechazadaError);
  });

  it("config: upsert por sucursal, ajena rechazada, y sin migrar lee vacio / escribe VozNoDisponibleError", async () => {
    const guardada = await repo.upsertConfig(ORG_A, P_A, { habilitado: true, proveedor: "gemini-3.8-live", voiceId: "Puck", comportamiento: "x", mensajeInicial: "y" });
    expect(guardada.configurada).toBe(true);
    expect((await repo.getConfig(P_A)).valor).toEqual(guardada);
    expect((await repo.getConfig(P_B)).valor.configurada).toBe(false);
    await expect(repo.upsertConfig(ORG_A, P_B, { habilitado: true, proveedor: "gemini-3.8-live", voiceId: "Puck", comportamiento: "", mensajeInicial: "" })).rejects.toBeInstanceOf(VozRechazadaError);

    repo.migrada = false;
    expect(await repo.getConfig(P_A)).toMatchObject({ disponible: false });
    expect(await repo.listConversaciones(ORG_A, P_A, {})).toEqual({ disponible: false, valor: { items: [], total: 0 } });
    await expect(repo.iniciarConversacion(inicio())).rejects.toBeInstanceOf(VozNoDisponibleError);
  });
});
