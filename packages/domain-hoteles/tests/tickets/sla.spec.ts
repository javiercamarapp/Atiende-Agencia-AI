// H-05 -- reglas puras de SLA, transiciones, clasificacion y ticket desde resena.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SLA_MINUTES_BY_PRIORITY,
  actorMayOperateTicket,
  canTransitionTicket,
  classifyGuestMessage,
  computeSlaDueAt,
  computeSlaWarningAt,
  draftTicketFromReview,
  isReviewTicketable,
  isSlaOverdue,
  minutesToSlaDue,
  resolveSlaMinutes,
  slaState,
} from "../../src/index.ts";

const T0 = new Date("2026-03-10T10:00:00.000Z");

describe("SLA", () => {
  it("resolveSlaMinutes: la politica configurada manda; sin ella, el default por prioridad", () => {
    expect(resolveSlaMinutes(45, "alta")).toBe(45);
    expect(resolveSlaMinutes(null, "alta")).toBe(30);
    expect(resolveSlaMinutes(undefined, "media")).toBe(120);
    expect(resolveSlaMinutes(0, "baja")).toBe(DEFAULT_SLA_MINUTES_BY_PRIORITY.baja);
    expect(resolveSlaMinutes(Number.NaN, "baja")).toBe(480);
    expect(resolveSlaMinutes(999999, "baja")).toBe(43200);
  });

  it("computeSlaDueAt / computeSlaWarningAt (75%)", () => {
    expect(computeSlaDueAt(T0, 120).toISOString()).toBe("2026-03-10T12:00:00.000Z");
    expect(computeSlaWarningAt(T0, 120).toISOString()).toBe("2026-03-10T11:30:00.000Z");
  });

  it("isSlaOverdue: el instante exacto del limite todavia es dentro del SLA", () => {
    const due = computeSlaDueAt(T0, 60);
    expect(isSlaOverdue(due, due)).toBe(false);
    expect(isSlaOverdue(new Date(due.getTime() + 1), due)).toBe(true);
  });

  it("slaState: en_tiempo / por_vencer / vencido / cerrado con reloj inyectado", () => {
    const base = { createdAt: T0.toISOString(), slaMinutes: 120, slaDueAt: computeSlaDueAt(T0, 120).toISOString() };
    const at = (min: number) => new Date(T0.getTime() + min * 60_000);
    expect(slaState({ ...base, status: "abierto" }, at(10))).toBe("en_tiempo");
    expect(slaState({ ...base, status: "abierto" }, at(90))).toBe("por_vencer");
    expect(slaState({ ...base, status: "en_progreso" }, at(120))).toBe("por_vencer");
    expect(slaState({ ...base, status: "escalado" }, at(121))).toBe("vencido");
    expect(slaState({ ...base, status: "cerrado" }, at(500))).toBe("cerrado");
    expect(slaState({ ...base, status: "cancelado" }, at(500))).toBe("cerrado");
  });

  it("minutesToSlaDue: positivo antes, negativo despues", () => {
    const due = computeSlaDueAt(T0, 60).toISOString();
    expect(minutesToSlaDue(due, new Date(T0.getTime() + 15 * 60_000))).toBe(45);
    expect(minutesToSlaDue(due, new Date(T0.getTime() + 75 * 60_000))).toBe(-15);
  });
});

describe("transiciones y permisos", () => {
  it("espejo del trigger: terminales sin salida, escalado puede volver a en_progreso", () => {
    expect(canTransitionTicket("abierto", "en_progreso")).toBe(true);
    expect(canTransitionTicket("en_progreso", "abierto")).toBe(false);
    expect(canTransitionTicket("escalado", "en_progreso")).toBe(true);
    expect(canTransitionTicket("abierto", "abierto")).toBe(false);
    expect(canTransitionTicket("cerrado", "en_progreso")).toBe(false);
    expect(canTransitionTicket("cancelado", "escalado")).toBe(false);
  });

  it("actorMayOperateTicket: manager, departamento o responsable", () => {
    const manage = ["owner", "gm", "frontdesk"] as const;
    const ticket = { department: "housekeeping", assignedTo: "u-asignado" };
    expect(actorMayOperateTicket({ role: "gm", userId: "x" }, ticket, manage)).toBe(true);
    expect(actorMayOperateTicket({ role: "housekeeping", userId: "x" }, ticket, manage)).toBe(true);
    expect(actorMayOperateTicket({ role: "fnb", userId: "u-asignado" }, ticket, manage)).toBe(true);
    expect(actorMayOperateTicket({ role: "fnb", userId: "otro" }, ticket, manage)).toBe(false);
  });
});

describe("classifyGuestMessage", () => {
  it("enruta por palabras clave sin acentos y detecta prioridad", () => {
    expect(classifyGuestMessage("El aire acondicionado no enfría")).toEqual({ department: "maintenance", priority: "media" });
    expect(classifyGuestMessage("Necesito toallas")).toEqual({ department: "housekeeping", priority: "media" });
    expect(classifyGuestMessage("Quiero un desayuno a la habitación")).toEqual({ department: "fnb", priority: "media" });
    expect(classifyGuestMessage("Hay una fuga de agua, es urgente")).toEqual({ department: "maintenance", priority: "alta" });
    expect(classifyGuestMessage("Cuando puedan, cambiar mi fecha de salida")).toEqual({ department: "reservations", priority: "baja" });
  });
  it("un mensaje ambiguo cae en frontdesk/media (nunca bloquea la creacion)", () => {
    expect(classifyGuestMessage("Hola, buenas tardes")).toEqual({ department: "frontdesk", priority: "media" });
  });
});

describe("ticket desde resena", () => {
  const review = (over: Partial<Parameters<typeof draftTicketFromReview>[0]> = {}) => ({
    id: "r1", source: "google", texto: "El aire no sirve y el cuarto estaba sucio", calificacion: 2, sentiment: "negativo",
    topics: [{ topic: "limpieza", menciones: 1 }, { topic: "aire_acondicionado", menciones: 2 }], ...over,
  });

  it("solo las resenas con queja son ticketables", () => {
    expect(isReviewTicketable({ sentiment: "negativo" })).toBe(true);
    expect(isReviewTicketable({ sentiment: "muy_negativo" })).toBe(true);
    expect(isReviewTicketable({ sentiment: "neutral" })).toBe(false);
    expect(isReviewTicketable({ sentiment: "positivo" })).toBe(false);
  });

  it("el departamento sale del tema mas mencionado con area clara; prioridad media por negativo", () => {
    const d = draftTicketFromReview(review());
    expect(d.department).toBe("maintenance");
    expect(d.priority).toBe("media");
    expect(d.guestMessage.startsWith("Resena (google 2/5): ")).toBe(true);
  });

  it("muy_negativo o tema de seguridad -> prioridad alta; sin tema mapeable -> frontdesk", () => {
    expect(draftTicketFromReview(review({ sentiment: "muy_negativo" })).priority).toBe("alta");
    expect(draftTicketFromReview(review({ topics: [{ topic: "seguridad", menciones: 1 }] }))).toMatchObject({ department: "gm", priority: "alta" });
    expect(draftTicketFromReview(review({ topics: [{ topic: "local:vista", menciones: 3 }] })).department).toBe("frontdesk");
  });

  it("el mensaje se recorta a 1000 caracteres (limite del CHECK)", () => {
    expect(draftTicketFromReview(review({ texto: "x".repeat(5000) })).guestMessage).toHaveLength(1000);
  });
});
