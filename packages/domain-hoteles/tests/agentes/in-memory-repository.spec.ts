// H-03 -- ciclo de vida de las aprobaciones, plantillas y configuracion sobre el repositorio en memoria (espejo de
// la migracion 035). RLS/GRANT/triggers/funciones definer reales: scripts/verify-hoteles-agentes-aprobaciones.
import { describe, expect, it } from "vitest";
import {
  AgentesAccessDeniedError,
  AgentesConflictError,
  AgentesInvalidInputError,
  AgentesNotFoundError,
  AgentesUnavailableError,
  InMemoryAgentesRepository,
} from "../../src/index.ts";
import type { Actor, GuardrailsInput, ProposeActionInput } from "../../src/index.ts";

const P = "00000000-0000-0000-0000-0000000000a1";
const OWNER: Actor = { userId: "u-owner", role: "owner" };
const GM: Actor = { userId: "u-gm", role: "gm" };
const GM2: Actor = { userId: "u-gm2", role: "gm" };
const FD: Actor = { userId: "u-fd", role: "frontdesk" };
const HK: Actor = { userId: "u-hk", role: "housekeeping" };
const SYS: Actor = { userId: null, role: null };

const GUARD: GuardrailsInput = {
  maxDiscountPct: 30, maxRefundCents: 500_000, maxFolioChargeCents: 500_000, maxMassRecipients: 200, blockedWords: [], sendWindowStart: "08:00", sendWindowEnd: "21:00",
};

function setup(opts: { start?: string } = {}) {
  let t = new Date(opts.start ?? "2026-06-01T12:00:00Z").getTime();
  const repo = new InMemoryAgentesRepository({ now: () => new Date(t) });
  return { repo, advance: (ms: number) => { t += ms; }, now: () => new Date(t) };
}

let seq = 0;
const proposal = (over: Partial<ProposeActionInput> = {}): ProposeActionInput => ({
  propertyId: P, agentKey: "revenue", actionType: "descuento_tarifa", summary: "Descuento fin de semana", payload: { roomTypeId: "rt-1" },
  amountCents: null, percent: 10, recipients: null, contentText: null, idempotencyKey: `key-${String(++seq).padStart(6, "0")}`, ...over,
});

describe("proponer: el agente propone, nunca ejecuta", () => {
  it("la propuesta del agente queda pendiente, sin autor humano y con la vigencia de 24 h", async () => {
    const { repo, now } = setup();
    const a = await repo.proposeAction(proposal(), SYS);
    expect(a).toMatchObject({ status: "pendiente", proposedBy: null, autoApproved: false, agentKey: "revenue", executedAt: null });
    expect(new Date(a.expiresAt).getTime()).toBe(now().getTime() + 1440 * 60_000);
  });

  it("una persona propone como 'manual' sin importar el agente que declare; roles sin permiso de redactar no", async () => {
    const { repo } = setup();
    expect((await repo.proposeAction(proposal({ agentKey: "revenue" }), FD)).agentKey).toBe("manual");
    await expect(repo.proposeAction(proposal(), HK)).rejects.toBeInstanceOf(AgentesAccessDeniedError);
  });

  it("la misma llave devuelve la existente; con contenido distinto es conflicto", async () => {
    const { repo } = setup();
    const p = proposal();
    const a = await repo.proposeAction(p, SYS);
    expect((await repo.proposeAction(p, SYS)).id).toBe(a.id);
    await expect(repo.proposeAction({ ...p, percent: 11 }, SYS)).rejects.toBeInstanceOf(AgentesConflictError);
    expect((await repo.listApprovals(P, {})).aprobaciones).toHaveLength(1);
  });

  it("valida campos obligatorios por accion y rangos", async () => {
    const { repo } = setup();
    for (const bad of [
      proposal({ percent: null }), proposal({ percent: 0 }), proposal({ percent: 100.5 }),
      proposal({ actionType: "reembolso", percent: null, amountCents: null }), proposal({ actionType: "reembolso", percent: null, amountCents: 0 }),
      proposal({ actionType: "mensaje_masivo", percent: null, recipients: 5, contentText: null }),
      proposal({ actionType: "respuesta_resena", percent: null, contentText: null }),
      proposal({ idempotencyKey: "corta" }),
    ]) {
      await expect(repo.proposeAction(bad, SYS)).rejects.toBeInstanceOf(AgentesInvalidInputError);
    }
  });

  it("topes duros por defecto en el borde exacto: pasan los topes, un paso mas se BLOQUEA", async () => {
    const { repo } = setup();
    const ok = [
      proposal({ percent: 30 }), proposal({ actionType: "reembolso", percent: null, amountCents: 500_000 }),
      proposal({ actionType: "mensaje_masivo", percent: null, recipients: 200, contentText: "Aviso" }),
    ];
    const over = [
      proposal({ percent: 30.01 }), proposal({ actionType: "reembolso", percent: null, amountCents: 500_001 }),
      proposal({ actionType: "mensaje_masivo", percent: null, recipients: 201, contentText: "Aviso" }),
    ];
    for (const p of ok) expect((await repo.proposeAction(p, SYS)).status).toBe("pendiente");
    const reasons: (string | null)[] = [];
    for (const p of over) {
      const r = await repo.proposeAction(p, SYS);
      expect(r.status).toBe("bloqueada");
      reasons.push(r.blockReason);
    }
    expect(reasons).toEqual(["tope_descuento", "tope_reembolso", "tope_destinatarios"]);
  });

  it("palabra bloqueada en el contenido o el resumen bloquea; una subcadena no", async () => {
    const { repo } = setup();
    await repo.upsertGuardrails(P, { ...GUARD, blockedWords: ["Gratis"] });
    expect((await repo.proposeAction(proposal({ actionType: "respuesta_resena", percent: null, contentText: "Noche GRATIS" }), SYS)).blockReason).toBe("palabra_bloqueada");
    expect((await repo.proposeAction(proposal({ actionType: "respuesta_resena", percent: null, contentText: "gratisimo" }), SYS)).status).toBe("pendiente");
    expect((await repo.proposeAction(proposal({ summary: "es gratis" }), SYS)).status).toBe("bloqueada");
  });

  it("agente pausado no encola (bloqueada); las propuestas manuales no se afectan", async () => {
    const { repo } = setup();
    await repo.updateAgentConfig(P, "revenue", { enabled: false, pausedReason: "Pausa por auditoria" });
    expect((await repo.proposeAction(proposal(), SYS)).blockReason).toBe("agente_pausado");
    expect((await repo.proposeAction(proposal(), FD)).status).toBe("pendiente");
  });

  it("cola llena: con 200 pendientes vigentes la siguiente se bloquea", async () => {
    const { repo } = setup();
    for (let i = 0; i < 200; i += 1) await repo.proposeAction(proposal(), SYS);
    expect((await repo.proposeAction(proposal(), SYS)).blockReason).toBe("cola_llena");
  });

  it("ejecucion automatica bajo umbral: solo agente, borde inclusivo, nunca contenido para el huesped", async () => {
    const { repo } = setup();
    await repo.upsertPolicy(P, "descuento_tarifa", { mode: "auto_bajo_umbral", autoMaxPercent: 10, autoMaxAmountCents: null, expiresMinutes: 60, approverRoles: ["owner", "gm"] });
    const at = await repo.proposeAction(proposal({ percent: 10 }), SYS);
    expect(at).toMatchObject({ status: "aprobada", autoApproved: true, decidedBy: null, decisionReason: "politica_auto_bajo_umbral" });
    expect((await repo.proposeAction(proposal({ percent: 10.01 }), SYS)).status).toBe("pendiente");
    expect((await repo.proposeAction(proposal({ percent: 5 }), FD)).status).toBe("pendiente");
    await expect(repo.upsertPolicy(P, "respuesta_resena", { mode: "auto_bajo_umbral", autoMaxPercent: null, autoMaxAmountCents: 1, expiresMinutes: 60, approverRoles: ["owner"] })).rejects.toBeInstanceOf(AgentesInvalidInputError);
  });
});

describe("decidir: motivo, roles, maker-checker, anti-replay, expiracion", () => {
  it("aprobar guarda decisor, momento y motivo; el motivo es obligatorio", async () => {
    const { repo } = setup();
    const a = await repo.proposeAction(proposal(), SYS);
    await expect(repo.decideApproval(P, a.id, "aprobar", "no", OWNER)).rejects.toBeInstanceOf(AgentesInvalidInputError);
    const done = await repo.decideApproval(P, a.id, "aprobar", "Ocupacion baja el fin de semana", OWNER);
    expect(done).toMatchObject({ status: "aprobada", decidedBy: "u-owner", decisionReason: "Ocupacion baja el fin de semana" });
    expect(done.decidedAt).not.toBeNull();
  });

  it("solo los roles de la politica deciden (owner siempre)", async () => {
    const { repo } = setup();
    const a = await repo.proposeAction(proposal(), SYS);
    await expect(repo.decideApproval(P, a.id, "aprobar", "motivo valido", FD)).rejects.toBeInstanceOf(AgentesAccessDeniedError);
    await repo.upsertPolicy(P, "descuento_tarifa", { mode: "siempre_humano", autoMaxPercent: null, autoMaxAmountCents: null, expiresMinutes: 1440, approverRoles: ["frontdesk"] });
    await expect(repo.decideApproval(P, a.id, "aprobar", "motivo valido", GM)).rejects.toBeInstanceOf(AgentesAccessDeniedError);
    expect((await repo.decideApproval(P, a.id, "aprobar", "Revisado por recepcion", FD)).status).toBe("aprobada");
    const b = await repo.proposeAction(proposal(), SYS);
    expect((await repo.decideApproval(P, b.id, "aprobar", "El dueno siempre puede", OWNER)).status).toBe("aprobada");
  });

  it("maker-checker: quien propone no decide lo suyo; otra persona si", async () => {
    const { repo } = setup();
    const a = await repo.proposeAction(proposal(), GM);
    await expect(repo.decideApproval(P, a.id, "aprobar", "me la apruebo yo", GM)).rejects.toBeInstanceOf(AgentesAccessDeniedError);
    await expect(repo.decideApproval(P, a.id, "rechazar", "me la rechazo yo", GM)).rejects.toBeInstanceOf(AgentesAccessDeniedError);
    expect((await repo.decideApproval(P, a.id, "aprobar", "Revisada por el dueno", OWNER)).status).toBe("aprobada");
  });

  it("anti-replay: una solicitud ya decidida no se decide de nuevo, ni en sentido contrario", async () => {
    const { repo } = setup();
    const a = await repo.proposeAction(proposal(), SYS);
    const b = await repo.proposeAction(proposal(), SYS);
    await repo.decideApproval(P, a.id, "aprobar", "Primera decision valida", OWNER);
    await expect(repo.decideApproval(P, a.id, "aprobar", "Repetir la aprobacion", OWNER)).rejects.toBeInstanceOf(AgentesConflictError);
    await expect(repo.decideApproval(P, a.id, "rechazar", "Cambiar de opinion", GM)).rejects.toBeInstanceOf(AgentesConflictError);
    await repo.decideApproval(P, b.id, "rechazar", "Primera decision valida", OWNER);
    await expect(repo.decideApproval(P, b.id, "aprobar", "Reabrir una rechazada", OWNER)).rejects.toBeInstanceOf(AgentesConflictError);
  });

  it("solicitud de otra property o inexistente: NotFound", async () => {
    const { repo } = setup();
    const a = await repo.proposeAction(proposal(), SYS);
    await expect(repo.decideApproval("otra-property", a.id, "aprobar", "motivo valido", OWNER)).rejects.toBeInstanceOf(AgentesNotFoundError);
    await expect(repo.decideApproval(P, "no-existe", "aprobar", "motivo valido", OWNER)).rejects.toBeInstanceOf(AgentesNotFoundError);
  });

  it("vencida: decidir la marca expirada y NO la aprueba", async () => {
    const { repo, advance } = setup();
    const a = await repo.proposeAction(proposal(), SYS);
    advance(1440 * 60_000);
    expect((await repo.decideApproval(P, a.id, "aprobar", "Intento tardio valido", OWNER)).status).toBe("expirada");
    await expect(repo.decideApproval(P, a.id, "aprobar", "Segundo intento tardio", OWNER)).rejects.toBeInstanceOf(AgentesConflictError);
  });

  it("aprobar respeta el guardrail VIGENTE (si el tope se endurecio, no se puede aprobar); rechazar siempre", async () => {
    const { repo } = setup();
    const a = await repo.proposeAction(proposal({ percent: 20 }), SYS);
    const b = await repo.proposeAction(proposal({ percent: 21 }), SYS);
    await repo.upsertGuardrails(P, { ...GUARD, maxDiscountPct: 15 });
    await expect(repo.decideApproval(P, a.id, "aprobar", "Sobre el tope nuevo", OWNER)).rejects.toBeInstanceOf(AgentesInvalidInputError);
    expect((await repo.decideApproval(P, b.id, "rechazar", "Excede el tope vigente", OWNER)).status).toBe("rechazada");
  });

  it("cancelar: quien propuso u owner/gm; con motivo; solo abiertas", async () => {
    const { repo } = setup();
    const a = await repo.proposeAction(proposal(), FD);
    await expect(repo.cancelApproval(P, a.id, "no es mia pero intento", { userId: "u-rs", role: "reservations" })).rejects.toBeInstanceOf(AgentesAccessDeniedError);
    await expect(repo.cancelApproval(P, a.id, "ok", FD)).rejects.toBeInstanceOf(AgentesInvalidInputError);
    expect((await repo.cancelApproval(P, a.id, "Me equivoque de monto", FD)).status).toBe("cancelada");
    await expect(repo.cancelApproval(P, a.id, "Cancelar dos veces", OWNER)).rejects.toBeInstanceOf(AgentesConflictError);
  });
});

describe("consumir: UNA sola ejecucion", () => {
  async function approved(repo: InMemoryAgentesRepository, over: Partial<ProposeActionInput> = {}) {
    const a = await repo.proposeAction(proposal(over), SYS);
    return repo.decideApproval(P, a.id, "aprobar", "Aprobada para ejecutar", OWNER);
  }

  it("ejecuta una vez; el segundo intento (replay) es conflicto", async () => {
    const { repo } = setup();
    const a = await approved(repo);
    const done = await repo.consumeApproval(P, a.id, "tarifa-123", SYS);
    expect(done).toMatchObject({ status: "ejecutada", executionRef: "tarifa-123", executedBy: null });
    await expect(repo.consumeApproval(P, a.id, "tarifa-123", SYS)).rejects.toBeInstanceOf(AgentesConflictError);
  });

  it("solo lo aprobado: pendiente y rechazada no se consumen", async () => {
    const { repo } = setup();
    const pend = await repo.proposeAction(proposal(), SYS);
    const rech = await repo.proposeAction(proposal(), SYS);
    await repo.decideApproval(P, rech.id, "rechazar", "No procede por ahora", OWNER);
    for (const id of [pend.id, rech.id]) await expect(repo.consumeApproval(P, id, "ref", SYS)).rejects.toBeInstanceOf(AgentesConflictError);
  });

  it("un owner/gm ejecuta a mano; frontdesk no", async () => {
    const { repo } = setup();
    const a = await approved(repo);
    await expect(repo.consumeApproval(P, a.id, "manual-1", FD)).rejects.toBeInstanceOf(AgentesNotFoundError);
    expect(await repo.consumeApproval(P, a.id, "manual-1", GM)).toMatchObject({ status: "ejecutada", executedBy: "u-gm" });
  });

  it("vencida: se marca expirada y no ejecuta; el reloj de usuario no se puede rebobinar", async () => {
    const { repo, advance } = setup();
    const a = await approved(repo);
    advance(1440 * 60_000);
    expect((await repo.consumeApproval(P, a.id, "tarde", GM, new Date("2019-01-01T00:00:00Z"))).status).toBe("expirada");
  });

  it("guardrail endurecido despues de aprobar: queda bloqueada con su motivo", async () => {
    const { repo } = setup();
    const a = await approved(repo, { percent: 20 });
    await repo.upsertGuardrails(P, { ...GUARD, maxDiscountPct: 15 });
    expect(await repo.consumeApproval(P, a.id, "ref", SYS)).toMatchObject({ status: "bloqueada", blockReason: "tope_descuento", executedAt: null });
  });

  it("mensaje masivo: fuera del horario se difiere (sigue aprobada), dentro ejecuta (08:00 inclusivo, 21:00 exclusivo)", async () => {
    const { repo } = setup({ start: "2026-03-10T12:00:00Z" });
    const mass = (n: number) => proposal({ actionType: "mensaje_masivo", percent: null, recipients: 10, contentText: `Aviso ${n}` });
    const ids: string[] = [];
    for (let n = 0; n < 4; n += 1) ids.push((await approved(repo, mass(n))).id);
    const at = ["2026-03-10T13:59:00Z", "2026-03-10T14:00:00Z", "2026-03-11T02:59:00Z", "2026-03-11T03:00:00Z"];
    const out: string[] = [];
    for (let n = 0; n < 4; n += 1) out.push((await repo.consumeApproval(P, ids[n]!, "ref", SYS, new Date(at[n]!))).status);
    expect(out).toEqual(["aprobada", "ejecutada", "ejecutada", "aprobada"]);
  });

  it("barrido de expiracion: limite inclusivo, idempotente, alcanza pendientes y aprobadas, no ejecutadas", async () => {
    const { repo, now } = setup();
    const pend = await repo.proposeAction(proposal(), SYS);
    const appr = await approved(repo);
    const exec = await approved(repo);
    await repo.consumeApproval(P, exec.id, "ref", SYS);
    const limit = new Date(now().getTime() + 1440 * 60_000);
    expect(await repo.expireApprovals(P, new Date(limit.getTime() - 1000))).toBe(0);
    expect(await repo.expireApprovals(P, limit)).toBe(2);
    expect(await repo.expireApprovals(P, limit)).toBe(0);
    expect((await repo.findApproval(P, pend.id))?.status).toBe("expirada");
    expect((await repo.findApproval(P, appr.id))?.status).toBe("expirada");
    expect((await repo.findApproval(P, exec.id))?.status).toBe("ejecutada");
  });

  it("la bitacora registra propuesta, aprobada y ejecutada con el actor", async () => {
    const { repo } = setup();
    const a = await approved(repo);
    await repo.consumeApproval(P, a.id, "ref", SYS);
    const events = await repo.listApprovalEvents(P, a.id);
    expect(events.map((e) => [e.eventType, e.actorId])).toEqual([["propuesta", null], ["aprobada", "u-owner"], ["ejecutada", null]]);
  });
});

describe("kill switch, presupuesto y costo", () => {
  it("pausar exige motivo; reanudar limpia; presupuesto > 0", async () => {
    const { repo } = setup();
    await expect(repo.updateAgentConfig(P, "revenue", { enabled: false })).rejects.toBeInstanceOf(AgentesInvalidInputError);
    await expect(repo.updateAgentConfig(P, "revenue", { enabled: false, pausedReason: "abc" })).rejects.toBeInstanceOf(AgentesInvalidInputError);
    await expect(repo.updateAgentConfig(P, "revenue", { budgetMicroUsd: 0 })).rejects.toBeInstanceOf(AgentesInvalidInputError);
    const paused = await repo.updateAgentConfig(P, "revenue", { enabled: false, pausedReason: "Revision de costos" });
    expect(paused).toMatchObject({ enabled: false, pausedReason: "Revision de costos" });
    expect(paused.pausedAt).not.toBeNull();
    const resumed = await repo.updateAgentConfig(P, "revenue", { enabled: true });
    expect(resumed).toMatchObject({ enabled: true, pausedReason: null, pausedAt: null });
  });

  it("el costo es aditivo por mes y no acepta negativos", async () => {
    const { repo } = setup();
    await repo.recordUsage(P, "recepcion_whatsapp", "2026-10", { tokensIn: 100, tokensOut: 50, costMicroUsd: 1200, calls: 1 });
    await repo.recordUsage(P, "recepcion_whatsapp", "2026-10", { tokensIn: 10, tokensOut: 5, costMicroUsd: 1800, calls: 2 });
    expect((await repo.gate(P, "recepcion_whatsapp", "2026-10"))?.spentMicroUsd).toBe(3000);
    expect((await repo.gate(P, "recepcion_whatsapp", "2026-11"))?.spentMicroUsd).toBe(0);
    await expect(repo.recordUsage(P, "recepcion_whatsapp", "2026-10", { tokensIn: 0, tokensOut: 0, costMicroUsd: -1, calls: 1 })).rejects.toBeInstanceOf(AgentesInvalidInputError);
  });
});

describe("plantillas de WhatsApp versionadas", () => {
  const draft = (name = "bienvenida_huesped", body = "Hola, bienvenido") => ({ propertyId: P, agentKey: "recepcion_whatsapp" as const, name, language: "es_MX" as const, category: "utility" as const, body });

  it("versiona por (nombre, idioma) y valida el nombre y el cuerpo", async () => {
    const { repo } = setup();
    expect((await repo.createTemplate(draft(), FD)).version).toBe(1);
    expect((await repo.createTemplate(draft(), FD)).version).toBe(2);
    expect((await repo.createTemplate({ ...draft(), language: "en_US" }, FD)).version).toBe(1);
    await expect(repo.createTemplate(draft("Bienvenida"), FD)).rejects.toBeInstanceOf(AgentesInvalidInputError);
    await expect(repo.createTemplate(draft("valida", ""), FD)).rejects.toBeInstanceOf(AgentesInvalidInputError);
    await expect(repo.createTemplate(draft("valida", "x".repeat(1025)), FD)).rejects.toBeInstanceOf(AgentesInvalidInputError);
    await expect(repo.createTemplate(draft(), HK)).rejects.toBeInstanceOf(AgentesAccessDeniedError);
  });

  it("separacion de funciones: frontdesk no aprueba, gm si, el gm no la suya, el dueno si la suya", async () => {
    const { repo } = setup();
    const t = await repo.createTemplate(draft(), FD);
    await repo.submitTemplate(P, t.id, FD);
    await expect(repo.reviewTemplate(P, t.id, "aprobar", "Texto correcto", FD)).rejects.toBeInstanceOf(AgentesAccessDeniedError);
    expect(await repo.reviewTemplate(P, t.id, "aprobar", "Texto correcto y claro", GM)).toMatchObject({ status: "aprobada", reviewedBy: "u-gm" });

    const g = await repo.createTemplate(draft("plantilla_gm"), GM);
    await repo.submitTemplate(P, g.id, GM);
    await expect(repo.reviewTemplate(P, g.id, "aprobar", "Me la apruebo yo", GM)).rejects.toBeInstanceOf(AgentesAccessDeniedError);
    expect((await repo.reviewTemplate(P, g.id, "aprobar", "Revisada por el segundo gm", GM2)).status).toBe("aprobada");

    const o = await repo.createTemplate(draft("plantilla_dueno"), OWNER);
    await repo.submitTemplate(P, o.id, OWNER);
    expect((await repo.reviewTemplate(P, o.id, "aprobar", "El dueno aprueba la suya", OWNER)).status).toBe("aprobada");
  });

  it("ciclo estricto: no se aprueba un borrador ni se decide dos veces; rechazar exige motivo", async () => {
    const { repo } = setup();
    const t = await repo.createTemplate(draft(), FD);
    await expect(repo.reviewTemplate(P, t.id, "aprobar", "Todavia es borrador", GM)).rejects.toBeInstanceOf(AgentesConflictError);
    await repo.submitTemplate(P, t.id, FD);
    await expect(repo.submitTemplate(P, t.id, FD)).rejects.toBeInstanceOf(AgentesConflictError);
    await expect(repo.reviewTemplate(P, t.id, "rechazar", "no", GM)).rejects.toBeInstanceOf(AgentesInvalidInputError);
    await repo.reviewTemplate(P, t.id, "rechazar", "Falta el nombre del hotel", GM);
    await expect(repo.reviewTemplate(P, t.id, "aprobar", "Reabrir la rechazada", GM)).rejects.toBeInstanceOf(AgentesConflictError);
  });

  it("una sola version aprobada vigente: aprobar la 2 archiva la 1", async () => {
    const { repo } = setup();
    const v1 = await repo.createTemplate(draft("una_vigente", "Version uno"), FD);
    const v2 = await repo.createTemplate(draft("una_vigente", "Version dos"), FD);
    await repo.submitTemplate(P, v1.id, FD);
    await repo.submitTemplate(P, v2.id, FD);
    await repo.reviewTemplate(P, v1.id, "aprobar", "Primera version vigente", GM);
    await repo.reviewTemplate(P, v2.id, "aprobar", "Segunda version vigente", GM);
    const list = (await repo.listTemplates(P)).plantillas;
    expect(list.find((t) => t.id === v1.id)?.status).toBe("archivada");
    expect(list.find((t) => t.id === v2.id)?.status).toBe("aprobada");
  });

  it("una palabra bloqueada por los guardrails impide crear la plantilla", async () => {
    const { repo } = setup();
    await repo.upsertGuardrails(P, { ...GUARD, blockedWords: ["gratis"] });
    await expect(repo.createTemplate(draft("con_palabra", "Noche GRATIS"), FD)).rejects.toBeInstanceOf(AgentesInvalidInputError);
    expect((await repo.createTemplate(draft("sin_palabra", "Gratisimo no cuenta"), FD)).status).toBe("borrador");
  });
});

describe("guardrails y base sin migrar", () => {
  it("valida rangos al guardar guardrails y normaliza las palabras", async () => {
    const { repo } = setup();
    await expect(repo.upsertGuardrails(P, { ...GUARD, maxDiscountPct: 0 })).rejects.toBeInstanceOf(AgentesInvalidInputError);
    await expect(repo.upsertGuardrails(P, { ...GUARD, maxDiscountPct: 100.01 })).rejects.toBeInstanceOf(AgentesInvalidInputError);
    await expect(repo.upsertGuardrails(P, { ...GUARD, sendWindowStart: "10:00", sendWindowEnd: "10:00" })).rejects.toBeInstanceOf(AgentesInvalidInputError);
    await expect(repo.upsertGuardrails(P, { ...GUARD, blockedWords: ["x".repeat(61)] })).rejects.toBeInstanceOf(AgentesInvalidInputError);
    expect((await repo.upsertGuardrails(P, { ...GUARD, blockedWords: [" Gratis ", "CORTESÍA", "gratis"] })).blockedWords).toEqual(["cortesia", "gratis"]);
  });

  it("sin la migracion 035: lecturas vacias honestas y escrituras 503", async () => {
    const repo = new InMemoryAgentesRepository({ migrated: false });
    expect(await repo.listAgentConfig(P, "2026-10")).toEqual({ disponible: false, configs: [], usage: [] });
    expect((await repo.listApprovals(P, {})).disponible).toBe(false);
    expect(await repo.gate(P, "revenue", "2026-10")).toBeNull();
    await expect(repo.proposeAction(proposal(), SYS)).rejects.toBeInstanceOf(AgentesUnavailableError);
    await expect(repo.updateAgentConfig(P, "revenue", { enabled: true })).rejects.toBeInstanceOf(AgentesUnavailableError);
  });
});
