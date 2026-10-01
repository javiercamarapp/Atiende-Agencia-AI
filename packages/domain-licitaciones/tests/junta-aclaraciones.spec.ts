// L-04 -- dominio puro de la junta de aclaraciones: huella, similitud, prioridad,
// maquina de estados con roles y resumen/semaforo.
import { describe, expect, it } from "vitest";
import {
  JUNTA_QUESTION_TRANSITIONS,
  JuntaQuestionRejectedError,
  assertQuestionEditable,
  assertQuestionTransition,
  buildJuntaSummary,
  canTransitionQuestion,
  findSimilarQuestions,
  parseJuntaConfig,
  parseQuestionCapture,
  parseQuestionPatch,
  parseTransitionRequest,
  questionDedupeKey,
  questionSimilarity,
  sortJuntaQuestions,
  suggestQuestionPriority,
} from "../src/junta-aclaraciones.ts";
import type { JuntaQuestionRecord, JuntaQuestionStatus } from "../src/junta-aclaraciones.ts";
import { SalaGuerraValidationError } from "../src/sala-guerra.ts";

const NOW = "2026-10-01T12:00:00.000Z";

function question(partial: Partial<JuntaQuestionRecord>): JuntaQuestionRecord {
  return {
    id: partial.id ?? "q1",
    organizationId: "org",
    tenderId: "t1",
    questionText: "Se aceptan contratos de dependencias estatales como experiencia?",
    baseReference: null,
    topic: "tecnico",
    priority: "media",
    dedupeKey: "k",
    origin: "manual",
    draftMissingData: [],
    status: "borrador",
    createdBy: "u",
    createdAt: NOW,
    updatedAt: NOW,
    approvedBy: null,
    approvedAt: null,
    sentAt: null,
    sentBy: null,
    sentReference: null,
    answerText: null,
    answerActaReference: null,
    answeredAt: null,
    answeredBy: null,
    discardReason: null,
    ...partial,
  };
}

describe("huella y similitud", () => {
  it("ignora acentos, mayusculas, puntuacion y palabras vacias", () => {
    const a = questionDedupeKey("¿Cuál es el plazo de ENTREGA de los bienes?");
    const b = questionDedupeKey("cual es el plazo de entrega de los bienes");
    expect(a).toBe(b);
  });
  it("el orden de las palabras no cambia la huella", () => {
    expect(questionDedupeKey("plazo de entrega de bienes")).toBe(questionDedupeKey("bienes entrega plazo"));
  });
  it("preguntas distintas dan huellas distintas", () => {
    expect(questionDedupeKey("Cual es el plazo de entrega?")).not.toBe(questionDedupeKey("Cual es la forma de pago?"));
  });
  it("la huella nunca pasa de 200 caracteres", () => {
    const largo = Array.from({ length: 80 }, (_, i) => `palabra${i}largaunica`).join(" ");
    expect(questionDedupeKey(largo).length).toBeLessThanOrEqual(200);
  });
  it("texto sin palabras clave igual produce una huella (no vacia)", () => {
    expect(questionDedupeKey("a de la").length).toBeGreaterThan(0);
  });
  it("similitud: casi iguales > umbral, distintas < umbral", () => {
    expect(questionSimilarity("Cual es el plazo de entrega de los bienes licitados?", "Cual es el plazo maximo de entrega de los bienes?")).toBeGreaterThanOrEqual(0.6);
    expect(questionSimilarity("Cual es el plazo de entrega?", "Se requiere fianza de cumplimiento?")).toBeLessThan(0.3);
  });
  it("findSimilarQuestions ignora las descartadas y ordena por similitud", () => {
    const vivas = [
      question({ id: "a", questionText: "Cual es el plazo de entrega de los bienes?", status: "borrador" }),
      question({ id: "b", questionText: "Cual es el plazo de entrega de los bienes?", status: "descartada" }),
      question({ id: "c", questionText: "Se requiere fianza de cumplimiento?" }),
    ];
    const similares = findSimilarQuestions("Cual es el plazo de entrega de los bienes licitados?", vivas);
    expect(similares.map((s) => s.question.id)).toEqual(["a"]);
  });
});

describe("suggestQuestionPriority", () => {
  it("contradiccion + puntaje -> alta, con razones legibles", () => {
    const s = suggestQuestionPriority("El numeral 4.2 contradice el anexo sobre los puntos del criterio de evaluacion; favor de aclarar.");
    expect(s.priority).toBe("alta");
    expect(s.reasons.length).toBeGreaterThanOrEqual(2);
  });
  it("un tema de forma de pago -> media", () => {
    expect(suggestQuestionPriority("Cual es la forma de pago?").priority).toBe("media");
  });
  it("una duda sin impacto -> baja", () => {
    expect(suggestQuestionPriority("Cual es el nombre del contacto?").priority).toBe("baja");
  });
});

describe("sortJuntaQuestions", () => {
  it("por trabajar primero, por prioridad, y las cerradas al final", () => {
    const sorted = sortJuntaQuestions([
      question({ id: "resp", status: "respondida", priority: "alta" }),
      question({ id: "baja", status: "borrador", priority: "baja" }),
      question({ id: "alta", status: "borrador", priority: "alta" }),
      question({ id: "apr", status: "aprobada", priority: "alta" }),
    ]);
    expect(sorted.map((q) => q.id)).toEqual(["alta", "baja", "apr", "resp"]);
  });
});

describe("validacion de entradas", () => {
  it("captura: texto corto o largo, tema y prioridad invalidos", () => {
    expect(() => parseQuestionCapture({ questionText: "corta" })).toThrow(SalaGuerraValidationError);
    expect(() => parseQuestionCapture({ questionText: "x".repeat(2001) })).toThrow(/2000/);
    expect(() => parseQuestionCapture({ questionText: "Pregunta suficientemente larga", topic: "magia" })).toThrow(/topic/);
    expect(() => parseQuestionCapture({ questionText: "Pregunta suficientemente larga", priority: "urgente" })).toThrow(/priority/);
    expect(parseQuestionCapture({ questionText: "  Pregunta suficientemente larga  " })).toMatchObject({ questionText: "Pregunta suficientemente larga", topic: "otro", priority: null, baseReference: null });
  });
  it("patch vacio se rechaza", () => {
    expect(() => parseQuestionPatch({})).toThrow(/ningun campo/);
  });
  it("config: el limite de preguntas no puede ser posterior a la junta", () => {
    expect(() => parseJuntaConfig({ questionsDeadlineAt: "2026-10-10T10:00:00Z", meetingAt: "2026-10-09T10:00:00Z" })).toThrow(/posterior/);
    expect(parseJuntaConfig({ questionsDeadlineAt: "2026-10-08T10:00:00Z", meetingAt: "2026-10-09T10:00:00Z", actaReference: " Acta 1 " }).actaReference).toBe("Acta 1");
  });
  it("transicion: estado desconocido se rechaza", () => {
    expect(() => parseTransitionRequest({ to: "volando" })).toThrow(/to:/);
  });
});

describe("maquina de estados", () => {
  const ALL: JuntaQuestionStatus[] = ["borrador", "aprobada", "enviada", "respondida", "descartada"];
  it("el grafo permitido es exactamente el documentado", () => {
    const permitidas = ALL.flatMap((from) => ALL.filter((to) => canTransitionQuestion(from, to)).map((to) => `${from}>${to}`)).sort();
    expect(permitidas).toEqual(["aprobada>borrador", "aprobada>descartada", "aprobada>enviada", "borrador>aprobada", "borrador>descartada", "descartada>borrador", "enviada>descartada", "enviada>respondida"].sort());
    expect(JUNTA_QUESTION_TRANSITIONS.respondida).toEqual([]);
  });
  it("borrador -> enviada se salta la aprobacion: rechazado", () => {
    expect(() => assertQuestionTransition({ status: "borrador" }, { to: "enviada" }, "owner")).toThrow(JuntaQuestionRejectedError);
  });
  it("aprobar exige rol de decision: writer/reviewer/viewer no; owner/admin/analyst si", () => {
    for (const rol of ["writer", "reviewer", "viewer"] as const) expect(() => assertQuestionTransition({ status: "borrador" }, { to: "aprobada" }, rol)).toThrow(JuntaQuestionRejectedError);
    for (const rol of ["owner", "admin", "analyst"] as const) expect(() => assertQuestionTransition({ status: "borrador" }, { to: "aprobada" }, rol)).not.toThrow();
  });
  it("viewer no modifica nada; writer si marca enviada", () => {
    expect(() => assertQuestionTransition({ status: "aprobada" }, { to: "enviada" }, "viewer")).toThrow(/no puede modificar/);
    expect(() => assertQuestionTransition({ status: "aprobada" }, { to: "enviada" }, "writer")).not.toThrow();
  });
  it("respondida exige texto de respuesta; descartar exige motivo", () => {
    expect(() => assertQuestionTransition({ status: "enviada" }, { to: "respondida" }, "writer")).toThrow(/answerText/);
    expect(() => assertQuestionTransition({ status: "enviada" }, { to: "respondida", answerText: "Si." }, "writer")).not.toThrow();
    expect(() => assertQuestionTransition({ status: "borrador" }, { to: "descartada" }, "writer")).toThrow(/discardReason/);
  });
  it("el texto solo se edita en borrador", () => {
    expect(() => assertQuestionEditable({ status: "borrador" })).not.toThrow();
    for (const s of ["aprobada", "enviada", "respondida", "descartada"] as const) expect(() => assertQuestionEditable({ status: s })).toThrow(JuntaQuestionRejectedError);
  });
});

describe("buildJuntaSummary", () => {
  const cfg = { tenderId: "t1", organizationId: "org", questionsDeadlineAt: "2026-10-01T20:00:00.000Z", meetingAt: null, actaReference: null, updatedBy: null, updatedAt: NOW };
  it("cuenta por estado, calcula pendientes y semaforo rojo a menos de 24 h", () => {
    const s = buildJuntaSummary([question({ id: "1", status: "borrador" }), question({ id: "2", status: "aprobada" }), question({ id: "3", status: "enviada" })], cfg, NOW);
    expect(s.counts).toMatchObject({ borrador: 1, aprobada: 1, enviada: 1 });
    expect(s.pendingToSend).toBe(2);
    expect(s.questionsDeadline.semaphore.color).toBe("rojo");
  });
  it("sin nada por enviar la fecha limite deja de alarmar (gris)", () => {
    const s = buildJuntaSummary([question({ status: "enviada" })], cfg, NOW);
    expect(s.pendingToSend).toBe(0);
    expect(s.questionsDeadline.semaphore.color).toBe("gris");
  });
  it("sin configuracion no inventa fechas", () => {
    const s = buildJuntaSummary([], null, NOW);
    expect(s.questionsDeadline).toMatchObject({ at: null, semaphore: { state: "cerrado" } });
  });
});
