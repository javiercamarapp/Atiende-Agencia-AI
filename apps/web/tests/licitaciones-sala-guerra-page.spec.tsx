// @vitest-environment jsdom
//
// L-04 -- pantalla de la sala de guerra (tablero + junta de aclaraciones). `fetch` global
// mockeado por ruta real: se verifica lo que se ve (semaforos, honestidad cuando la base esta sin
// migrar), que cada boton dispare el metodo/ruta/cuerpo reales y que el rol del staff oculte lo
// que el servidor rechazaria.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { SalaGuerraPage } from "../src/verticals/licitaciones/pages/SalaGuerra.tsx";
import type { LicitacionesShellContext } from "../src/verticals/licitaciones/LicitacionesShell.tsx";
import { changeValue, click, flushMicrotasks, renderComponent, submitForm, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

const CTX: LicitacionesShellContext = { apiBaseUrl: "https://api.test", token: "tok", propertyId: "prop-1", orgSlug: "demo", role: "owner", staffFullName: "Ana", staffEmail: "ana@example.com" };
const ROLE = (role: string): LicitacionesShellContext => ({ ...CTX, role });

type Handler = (init?: RequestInit) => { ok?: boolean; status?: number; body: unknown };
type Routes_ = Record<string, Handler>;

function stubFetch(routes: Routes_) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const key = `${method} ${url.replace("https://api.test/licitaciones/prop-1/tenders/t1", "")}`;
    const handler = routes[key];
    if (!handler) return { ok: false, status: 500, json: async () => ({ error: { message: `sin ruta ${key}` } }) } as unknown as Response;
    const r = handler(init);
    return { ok: r.ok ?? true, status: r.status ?? (r.ok === false ? 500 : 200), json: async () => r.body } as unknown as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 8; i++) await flushMicrotasks();
  });
}

function mount(ctx: LicitacionesShellContext) {
  rendered = renderComponent(
    <MemoryRouter initialEntries={["/licitaciones/demo/convocatorias/t1/sala-guerra"]}>
      <Routes>
        <Route path="/licitaciones/:orgSlug/convocatorias/:tenderId/sala-guerra" element={<SalaGuerraPage {...ctx} />} />
      </Routes>
    </MemoryRouter>,
  );
}

const buttons = () => [...rendered!.container.querySelectorAll("button")];
const buttonByText = (text: string) => buttons().find((b) => b.textContent?.trim() === text);
const field = (label: string) => rendered!.container.querySelector(`[aria-label="${label}"]`) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
const calls = (method: string, path: string) => fetchMock.mock.calls.filter(([url, init]) => `${(init as RequestInit | undefined)?.method ?? "GET"} ${String(url).replace("https://api.test/licitaciones/prop-1/tenders/t1", "")}` === `${method} ${path}`);
const bodyOf = (call: unknown[]) => JSON.parse(String((call[1] as RequestInit).body));

const sem = (color: string, state: string) => ({ color, state, hoursRemaining: 5 });
const ITEM = (over: Record<string, unknown> = {}) => ({
  id: "i1",
  kind: "tarea",
  title: "Recabar firmas del representante",
  description: null,
  status: "pendiente",
  severity: null,
  responsibleUserId: null,
  dueAt: "2026-10-05T18:00:00.000Z",
  requirementItemId: null,
  completedAt: null,
  semaphore: sem("rojo", "vence_hoy"),
  ...over,
});
const BOARD = (over: Record<string, unknown> = {}) => ({
  available: true,
  now: "2026-10-01T12:00:00.000Z",
  viewerUserId: "me",
  tender: { id: "t1", title: "Adquisicion de equipo", submissionDeadline: "2026-10-20T18:00:00.000Z", status: "go" },
  board: {
    items: [ITEM(), ITEM({ id: "i2", kind: "riesgo", title: "Fianza sin tramitar", severity: "alta", semaphore: sem("gris", "sin_fecha"), dueAt: null })],
    summary: { requisitos: { total: 0, listos: 0, bloqueados: 0 }, tareas: { total: 1, listas: 0 }, riesgosAbiertos: 1, riesgosAltos: 1, sinResponsable: 1, avancePct: 0, semaforoGeneral: "rojo" },
    goNoGo: { id: "g1", decision: "go", reasons: ["Encaja con el giro"], decidedAt: "2026-09-20T10:00:00.000Z" },
    submissionDeadline: { at: "2026-10-20T18:00:00.000Z", semaphore: sem("verde", "en_tiempo") },
  },
  entries: [{ id: "e1", itemId: null, entryKind: "comentario", body: "Falta la carta del fabricante", authorId: "u", createdAt: "2026-10-01T10:00:00.000Z" }],
  goNoGoHistory: [],
  importableRequirements: [{ id: "r1", text: "Acreditar experiencia minima", requirementKind: "tecnico", obligatoriedad: "obligatorio", clause: "6.2" }],
  ...over,
});

describe("SalaGuerraPage -- tablero", () => {
  it("muestra el resumen, los items con su semaforo, la decision go/no-go y la bitacora", async () => {
    stubFetch({ "GET /sala-guerra": () => ({ body: BOARD() }) });
    mount(CTX);
    await settle();
    const text = rendered!.container.textContent!;
    expect(text).toContain("Sala de guerra · Adquisicion de equipo");
    expect(text).toContain("Recabar firmas del representante");
    expect(text).toContain("Vence en menos de 24 h");
    expect(text).toContain("Fianza sin tramitar");
    expect(text).toContain("Severidad alta");
    expect(text).toContain("Encaja con el giro");
    expect(text).toContain("Falta la carta del fabricante");
    expect(text).toContain("Requisitos de las bases sin importar (1)");
    expect(text).toContain("no envía nada a ComprasMX");
  });

  it("L-22: muestra los dias habiles que quedan y avisa si la fecha limite cae en dia inhabil", async () => {
    const plazo = { fechaLimite: "2026-03-16", hoy: "2026-03-10", diasHabilesRestantes: 0, caeEnInhabil: true, motivoInhabil: "Natalicio de Benito Juárez", siguienteDiaHabil: "2026-03-17", avisos: ["La fecha límite cae en un día inhábil (Natalicio de Benito Juárez): confirme con la convocante si el plazo se recorre."], nota: "n" };
    stubFetch({ "GET /sala-guerra": () => ({ body: BOARD({ plazoPresentacion: plazo }) }) });
    mount(CTX);
    await settle();
    const text = rendered!.container.textContent!;
    expect(text).toContain("sin días hábiles restantes (cae en día inhábil)");
    expect(text).toContain("confirme con la convocante si el plazo se recorre");
  });

  it("L-22: un servidor sin plazoPresentacion sigue mostrando el tablero", async () => {
    stubFetch({ "GET /sala-guerra": () => ({ body: BOARD() }) });
    mount(CTX);
    await settle();
    expect(rendered!.container.textContent!).not.toContain("días hábiles");
  });

  it("cambiar el estado de un item hace PATCH real con el nuevo estado", async () => {
    stubFetch({ "GET /sala-guerra": () => ({ body: BOARD() }), "PATCH /sala-guerra/items/i1": () => ({ body: ITEM({ status: "listo" }) }) });
    mount(CTX);
    await settle();
    await act(async () => {
      changeValue(field("Estado de Recabar firmas del representante") as HTMLSelectElement, "listo");
      await flushMicrotasks();
    });
    await settle();
    const patch = calls("PATCH", "/sala-guerra/items/i1");
    expect(patch).toHaveLength(1);
    expect(bodyOf(patch[0]!)).toEqual({ status: "listo" });
    expect(calls("GET", "/sala-guerra").length).toBeGreaterThanOrEqual(2); // recarga el tablero despues de escribir
  });

  it("'Asignarme' manda el id del usuario actual", async () => {
    stubFetch({ "GET /sala-guerra": () => ({ body: BOARD() }), "PATCH /sala-guerra/items/i1": () => ({ body: ITEM({ responsibleUserId: "me" }) }) });
    mount(CTX);
    await settle();
    await act(async () => {
      click(buttons().find((b) => b.textContent === "Asignarme")!);
      await flushMicrotasks();
    });
    await settle();
    expect(bodyOf(calls("PATCH", "/sala-guerra/items/i1")[0]!)).toEqual({ responsibleUserId: "me" });
  });

  it("agregar un riesgo manda tipo, severidad, fecha ISO y asignacion; los botones dependen de un titulo valido", async () => {
    stubFetch({ "GET /sala-guerra": () => ({ body: BOARD() }), "POST /sala-guerra/items": () => ({ status: 201, body: ITEM() }) });
    mount(CTX);
    await settle();
    expect(buttonByText("Agregar al tablero")!.hasAttribute("disabled")).toBe(true);
    changeValue(field("Tipo de item") as HTMLSelectElement, "riesgo");
    changeValue(field("Título del item") as HTMLInputElement, "Proveedor unico sin respaldo");
    changeValue(field("Severidad del riesgo") as HTMLSelectElement, "critica");
    changeValue(field("Fecha límite del item") as HTMLInputElement, "2026-10-08T10:00");
    expect(buttonByText("Agregar al tablero")!.hasAttribute("disabled")).toBe(false);
    const form = field("Título del item").closest("form")!;
    await submitForm(form);
    await settle();
    const post = calls("POST", "/sala-guerra/items");
    expect(post).toHaveLength(1);
    expect(bodyOf(post[0]!)).toMatchObject({ kind: "riesgo", title: "Proveedor unico sin respaldo", severity: "critica", responsibleUserId: null });
    expect(bodyOf(post[0]!).dueAt).toBe(new Date("2026-10-08T10:00").toISOString()); // la hora local del navegador, convertida a UTC
  });

  it("importar requisitos hace POST real", async () => {
    stubFetch({ "GET /sala-guerra": () => ({ body: BOARD() }), "POST /sala-guerra/items/import-requirements": () => ({ status: 201, body: { created: 1 } }) });
    mount(CTX);
    await settle();
    await act(async () => {
      click(buttonByText("Importar requisitos al tablero")!);
      await flushMicrotasks();
    });
    await settle();
    expect(calls("POST", "/sala-guerra/items/import-requirements")).toHaveLength(1);
  });

  it("la bitacora manda comentario o decision; un writer no ve la opcion 'Decisión'", async () => {
    stubFetch({ "GET /sala-guerra": () => ({ body: BOARD() }), "POST /sala-guerra/entries": () => ({ status: 201, body: {} }) });
    mount(CTX);
    await settle();
    changeValue(field("Tipo de anotación") as HTMLSelectElement, "decision");
    changeValue(field("Texto de la anotación") as HTMLTextAreaElement, "Se decide participar con socio local");
    await submitForm(field("Texto de la anotación").closest("form")!);
    await settle();
    expect(bodyOf(calls("POST", "/sala-guerra/entries")[0]!)).toEqual({ entryKind: "decision", body: "Se decide participar con socio local" });
    rendered!.unmount();
    mount(ROLE("writer"));
    await settle();
    expect([...(field("Tipo de anotación") as HTMLSelectElement).options].map((o) => o.value)).toEqual(["comentario"]);
  });

  it("un viewer solo consulta: sin formularios ni botones de escritura", async () => {
    stubFetch({ "GET /sala-guerra": () => ({ body: BOARD() }) });
    mount(ROLE("viewer"));
    await settle();
    expect(rendered!.container.querySelector("form")).toBeNull();
    expect(rendered!.container.querySelectorAll("select").length).toBe(0);
    expect(buttonByText("Asignarme")).toBeUndefined();
    expect(buttonByText("Importar requisitos al tablero")).toBeUndefined();
    expect(rendered!.container.textContent).toContain("Recabar firmas del representante");
  });

  it("base sin migrar: lo dice, conserva requisitos y go/no-go y no ofrece guardar", async () => {
    stubFetch({
      "GET /sala-guerra": () => ({
        body: BOARD({ available: false, entries: [], board: { ...BOARD().board, items: [], summary: { requisitos: { total: 0, listos: 0, bloqueados: 0 }, tareas: { total: 0, listas: 0 }, riesgosAbiertos: 0, riesgosAltos: 0, sinResponsable: 0, avancePct: null, semaforoGeneral: "verde" } } }),
      }),
    });
    mount(CTX);
    await settle();
    const text = rendered!.container.textContent!;
    expect(text).toContain("falta aplicar la migración 029");
    expect(text).toContain("Encaja con el giro");
    expect(text).toContain("Acreditar experiencia minima");
    expect(text).toContain("Sin items"); // nunca un 0% o 100% inventado
    expect(rendered!.container.querySelector("form")).toBeNull();
    expect(buttonByText("Importar requisitos al tablero")).toBeUndefined();
  });

  it("si la lectura falla, muestra el error con reintento", async () => {
    stubFetch({ "GET /sala-guerra": () => ({ ok: false, status: 500, body: { message: "boom" } }) });
    mount(CTX);
    await settle();
    expect(rendered!.container.textContent).toContain("No se pudo cargar");
    expect(buttons().some((b) => /reintentar/i.test(b.textContent ?? ""))).toBe(true);
  });
});

const Q = (over: Record<string, unknown> = {}) => ({
  id: "q1",
  questionText: "Se aceptan contratos estatales como experiencia comprobable?",
  baseReference: "6.2",
  topic: "tecnico",
  priority: "alta",
  origin: "manual",
  draftMissingData: [],
  status: "borrador",
  createdAt: "2026-10-01T10:00:00.000Z",
  approvedAt: null,
  sentAt: null,
  sentReference: null,
  answerText: null,
  answerActaReference: null,
  answeredAt: null,
  discardReason: null,
  ...over,
});
const JUNTA = (over: Record<string, unknown> = {}) => ({
  available: true,
  now: "2026-10-01T12:00:00.000Z",
  config: { questionsDeadlineAt: "2026-10-02T12:00:00.000Z", meetingAt: "2026-10-03T12:00:00.000Z", actaReference: null },
  questions: [Q()],
  summary: { counts: { borrador: 1, aprobada: 0, enviada: 0, respondida: 0, descartada: 0 }, pendingToSend: 1, questionsDeadline: { at: "2026-10-02T12:00:00.000Z", semaphore: sem("rojo", "vence_hoy") }, meetingAt: "2026-10-03T12:00:00.000Z" },
  reminders: [{ id: "rem1", questionsDeadlineAt: "2026-10-02T12:00:00.000Z", daysRemaining: 1, pendingCount: 1, message: "El plazo para enviar preguntas vence pronto", createdAt: "2026-10-01T06:00:00.000Z", acknowledgedAt: null }],
  portalSubmission: false,
  ...over,
});

async function openJunta(ctx: LicitacionesShellContext, junta: unknown, extra: Routes_ = {}) {
  stubFetch({ "GET /sala-guerra": () => ({ body: BOARD() }), "GET /junta": () => ({ body: junta }), ...extra });
  mount(ctx);
  await settle();
  await act(async () => {
    click(buttonByText("Junta de aclaraciones")!);
    await flushMicrotasks();
  });
  await settle();
}

describe("SalaGuerraPage -- junta de aclaraciones", () => {
  it("muestra preguntas, semaforo de la fecha limite y el recordatorio; reconocer el recordatorio hace POST", async () => {
    await openJunta(CTX, JUNTA(), { "POST /junta/reminders/rem1/acknowledge": () => ({ body: {} }) });
    const text = rendered!.container.textContent!;
    expect(text).toContain("Se aceptan contratos estatales");
    expect(text).toContain("Vence en menos de 24 h");
    expect(text).toContain("El plazo para enviar preguntas vence pronto");
    await act(async () => {
      click(buttonByText("Reconocer recordatorio")!);
      await flushMicrotasks();
    });
    await settle();
    expect(calls("POST", "/junta/reminders/rem1/acknowledge")).toHaveLength(1);
  });

  it("guardar fechas hace PUT con ISO", async () => {
    await openJunta(CTX, JUNTA(), { "PUT /junta/config": () => ({ body: {} }) });
    changeValue(field("Límite para enviar preguntas") as HTMLInputElement, "2026-10-02T09:00");
    changeValue(field("Referencia del acta") as HTMLInputElement, "Acta 1");
    await submitForm(field("Referencia del acta").closest("form")!);
    await settle();
    const put = calls("PUT", "/junta/config");
    expect(put).toHaveLength(1);
    expect(bodyOf(put[0]!)).toMatchObject({ actaReference: "Acta 1" });
    expect(bodyOf(put[0]!).questionsDeadlineAt).toMatch(/^2026-10-02T\d\d:00:00\.000Z$/);
  });

  it("capturar una pregunta hace POST y muestra prioridad y preguntas parecidas", async () => {
    await openJunta(CTX, JUNTA(), {
      "POST /junta/questions": () => ({
        status: 201,
        body: { question: Q({ id: "q2", priority: "media" }), similar: [{ id: "q1", questionText: "Se aceptan contratos estatales", status: "borrador", similarity: 0.7 }], suggestion: { priority: "media", score: 2, reasons: ["afecta plazos de entrega o ejecucion"] } },
      }),
    });
    expect(buttonByText("Capturar pregunta")!.hasAttribute("disabled")).toBe(true);
    changeValue(field("Texto de la pregunta nueva") as HTMLTextAreaElement, "Cual es el plazo de entrega de los bienes licitados?");
    changeValue(field("Referencia a las bases") as HTMLInputElement, "7.1");
    await submitForm(field("Texto de la pregunta nueva").closest("form")!);
    await settle();
    expect(bodyOf(calls("POST", "/junta/questions")[0]!)).toEqual({ questionText: "Cual es el plazo de entrega de los bienes licitados?", baseReference: "7.1", topic: "otro" });
    const result = rendered!.container.querySelector('[data-testid="capture-result"]')!.textContent!;
    expect(result).toContain("70%");
    expect(result).toContain("afecta plazos");
  });

  it("un duplicado exacto (409) muestra el mensaje del servidor", async () => {
    await openJunta(CTX, JUNTA(), { "POST /junta/questions": () => ({ ok: false, status: 409, body: { code: "duplicate_question", message: "Ya existe una pregunta equivalente para esta convocatoria.", existing: { id: "q1" } } }) });
    changeValue(field("Texto de la pregunta nueva") as HTMLTextAreaElement, "Se aceptan contratos estatales como experiencia comprobable?");
    await submitForm(field("Texto de la pregunta nueva").closest("form")!);
    await settle();
    expect(rendered!.container.querySelector('[role="alert"]')!.textContent).toContain("Ya existe una pregunta equivalente");
  });

  it("borrador asistido: POST con la instruccion y resumen de lo creado/descartado", async () => {
    await openJunta(CTX, JUNTA(), {
      "POST /junta/questions/draft": () => ({ status: 201, body: { created: [Q({ id: "q9", origin: "agente" })], skippedDuplicates: [], rejected: [{ questionText: "La fianza del 25%?", reason: "cifra_no_presente_en_el_contexto", detail: "Cifras ajenas al contexto: 25." }], missingData: ["Plazo de la fianza"] } }),
    });
    changeValue(field("Qué aclarar") as HTMLInputElement, "Aclarar garantias");
    await submitForm(field("Qué aclarar").closest("form")!);
    await settle();
    expect(bodyOf(calls("POST", "/junta/questions/draft")[0]!)).toEqual({ instruction: "Aclarar garantias" });
    const result = rendered!.container.querySelector('[data-testid="draft-result"]')!.textContent!;
    expect(result).toContain("1 borrador(es) creado(s)");
    expect(result).toContain("Cifras ajenas al contexto: 25.");
  });

  it("aprobar: solo con rol de decision; el writer no ve el boton", async () => {
    await openJunta(ROLE("writer"), JUNTA());
    expect(buttonByText("Aprobar")).toBeUndefined();
    expect(buttonByText("Editar texto")).toBeDefined();
    rendered!.unmount();
    await openJunta(ROLE("analyst"), JUNTA(), { "POST /junta/questions/q1/transition": () => ({ body: Q({ status: "aprobada" }) }) });
    await act(async () => {
      click(buttonByText("Aprobar")!);
      await flushMicrotasks();
    });
    await settle();
    expect(bodyOf(calls("POST", "/junta/questions/q1/transition")[0]!)).toEqual({ to: "aprobada" });
  });

  it("marcar como enviada pide confirmar (dice que el sistema no envia nada) y manda el folio", async () => {
    await openJunta(CTX, JUNTA({ questions: [Q({ status: "aprobada", approvedAt: "2026-10-01T11:00:00.000Z" })] }), { "POST /junta/questions/q1/transition": () => ({ body: Q({ status: "enviada" }) }) });
    await act(async () => {
      click(buttonByText("Marcar como enviada")!);
      await flushMicrotasks();
    });
    expect(rendered!.container.textContent).toContain("Este sistema no la envía");
    changeValue(field("Folio o acuse del envío") as HTMLInputElement, "Acuse 123");
    await act(async () => {
      click(buttonByText("Confirmar")!);
      await flushMicrotasks();
    });
    await settle();
    expect(bodyOf(calls("POST", "/junta/questions/q1/transition")[0]!)).toEqual({ to: "enviada", sentReference: "Acuse 123" });
  });

  it("registrar la respuesta del acta exige texto y la liga a la pregunta", async () => {
    await openJunta(CTX, JUNTA({ questions: [Q({ status: "enviada", approvedAt: "x", sentAt: "2026-10-01T11:00:00.000Z" })] }), { "POST /junta/questions/q1/transition": () => ({ body: Q({ status: "respondida" }) }) });
    await act(async () => {
      click(buttonByText("Registrar respuesta del acta")!);
      await flushMicrotasks();
    });
    expect(buttonByText("Confirmar")!.hasAttribute("disabled")).toBe(true);
    changeValue(field("Respuesta del acta") as HTMLTextAreaElement, "Si se aceptan.");
    changeValue(field("Referencia en el acta") as HTMLInputElement, "Acta, pregunta 4");
    await act(async () => {
      click(buttonByText("Confirmar")!);
      await flushMicrotasks();
    });
    await settle();
    expect(bodyOf(calls("POST", "/junta/questions/q1/transition")[0]!)).toEqual({ to: "respondida", answerText: "Si se aceptan.", answerActaReference: "Acta, pregunta 4" });
  });

  it("una pregunta respondida muestra la respuesta del acta y no ofrece mas acciones", async () => {
    await openJunta(CTX, JUNTA({ questions: [Q({ status: "respondida", answerText: "Si se aceptan.", answerActaReference: "Acta, pregunta 4" })] }));
    const text = rendered!.container.textContent!;
    expect(text).toContain("Respuesta del acta (Acta, pregunta 4)");
    expect(text).toContain("Si se aceptan.");
    expect(buttonByText("Marcar como enviada")).toBeUndefined();
    expect(buttonByText("Descartar")).toBeUndefined();
  });

  it("descartar exige motivo", async () => {
    await openJunta(CTX, JUNTA(), { "POST /junta/questions/q1/transition": () => ({ body: Q({ status: "descartada" }) }) });
    await act(async () => {
      click(buttonByText("Descartar")!);
      await flushMicrotasks();
    });
    expect(buttonByText("Confirmar")!.hasAttribute("disabled")).toBe(true);
    changeValue(field("Motivo del descarte") as HTMLInputElement, "Duplicada");
    await act(async () => {
      click(buttonByText("Confirmar")!);
      await flushMicrotasks();
    });
    await settle();
    expect(bodyOf(calls("POST", "/junta/questions/q1/transition")[0]!)).toEqual({ to: "descartada", discardReason: "Duplicada" });
  });

  it("editar el texto de un borrador hace PATCH", async () => {
    await openJunta(CTX, JUNTA(), { "PATCH /junta/questions/q1": () => ({ body: Q() }) });
    await act(async () => {
      click(buttonByText("Editar texto")!);
      await flushMicrotasks();
    });
    changeValue(field("Texto de la pregunta") as HTMLTextAreaElement, "Texto corregido de la pregunta para la junta");
    await act(async () => {
      click(buttonByText("Guardar texto")!);
      await flushMicrotasks();
    });
    await settle();
    expect(bodyOf(calls("PATCH", "/junta/questions/q1")[0]!)).toEqual({ questionText: "Texto corregido de la pregunta para la junta" });
  });

  it("base sin migrar: aviso honesto y sin formularios de captura", async () => {
    await openJunta(CTX, JUNTA({ available: false, config: null, questions: [], reminders: [], summary: { counts: { borrador: 0, aprobada: 0, enviada: 0, respondida: 0, descartada: 0 }, pendingToSend: 0, questionsDeadline: { at: null, semaphore: sem("gris", "cerrado") }, meetingAt: null } }));
    expect(rendered!.container.textContent).toContain("falta aplicar la migración 029");
    expect(rendered!.container.querySelector('[aria-label="Texto de la pregunta nueva"]')).toBeNull();
    expect(rendered!.container.textContent).toContain("Aún no hay preguntas para esta junta.");
  });
});
