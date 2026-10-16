// @vitest-environment jsdom
//
// L-26/L-28 -- componentes de la pantalla de cierre: AprobacionExpediente (doble aprobacion con step-up) y
// PresentacionPortal (declarar la presentacion). Se afirma el comportamiento real contra un fetch simulado:
// el primer clic solo abre el dialogo, Cancelar/Escape NO escriben, el step-up viaja en la cabecera, un error del
// servidor se ve, y la clave de idempotencia se reutiliza en el reintento del mismo formulario.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { AprobacionExpediente } from "../src/verticals/licitaciones/components/AprobacionExpediente.tsx";
import type { AprobacionExpedienteProps } from "../src/verticals/licitaciones/components/AprobacionExpediente.tsx";
import { PresentacionPortal } from "../src/verticals/licitaciones/components/PresentacionPortal.tsx";
import type { PresentacionPortalProps } from "../src/verticals/licitaciones/components/PresentacionPortal.tsx";
import type { ExpedienteApprovalsState } from "../src/verticals/licitaciones/lib/cierre-client.ts";
import { changeValue, click, flushMicrotasks, keydown, renderComponent, submitForm, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}
async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i++) await flushMicrotasks();
  });
}
const dialogo = () => document.body.querySelector('[role="alertdialog"]');
const botonDialogo = (texto: string) => [...dialogo()!.querySelectorAll("button")].find((b) => b.textContent?.includes(texto)) as HTMLButtonElement;
const boton = (r: RenderedComponent, texto: string) => [...r.container.querySelectorAll("button")].find((b) => b.textContent?.includes(texto)) as HTMLButtonElement | undefined;
const posts = () => fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "POST");
const postsTo = (suffix: string) => posts().filter(([url]) => String(url).endsWith(suffix));

const PENDIENTE: ExpedienteApprovalsState = { mode: "doble", complete: false, missing: ["tecnica_legal", "economica"], stages: [{ stage: "tecnica_legal", approval: null }, { stage: "economica", approval: null }] };
const MEDIA: ExpedienteApprovalsState = {
  mode: "doble",
  complete: false,
  missing: ["economica"],
  stages: [
    { stage: "tecnica_legal", approval: { id: "a1", approvedAt: "2026-10-01T16:00:00.000Z", approvedByRole: "analyst", byYou: false } },
    { stage: "economica", approval: null },
  ],
};

function stubFetch(opts: { twoFactor?: { available: boolean; enabled: boolean }; approve?: () => Response } = {}) {
  const twoFactor = opts.twoFactor ?? { available: true, enabled: true };
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/auth/2fa/status")) return json({ ...twoFactor, pending: false, lockedUntil: null, backupCodesRemaining: 8 });
    if (u.endsWith("/auth/step-up")) return json({ stepUpToken: "su-token" });
    if (u.endsWith("/expediente/approval") && init?.method === "POST") return (opts.approve ?? (() => json({ id: "n1", stage: "tecnica_legal" }, 201)))();
    throw new Error(`fetch inesperado: ${init?.method ?? "GET"} ${u}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}

async function montarAprobacion(over: Partial<AprobacionExpedienteProps> = {}) {
  const onChanged = vi.fn(async () => undefined);
  const props: AprobacionExpedienteProps = { apiBaseUrl: "https://api.test", token: "tok", propertyId: "p1", tenderId: "t1", orgSlug: "demo", role: "analyst", canApprove: true, state: PENDIENTE, stateError: null, onChanged, ...over };
  rendered = renderComponent(
    <MemoryRouter>
      <AprobacionExpediente {...props} />
    </MemoryRouter>,
  );
  await settle();
  return { r: rendered, onChanged };
}

describe("AprobacionExpediente -- doble aprobacion con step-up", () => {
  it("muestra las dos etapas pendientes; la economica queda bloqueada con el motivo hasta que exista la 1/2", async () => {
    stubFetch();
    const { r } = await montarAprobacion();
    expect(r.container.textContent).toContain("Técnico-legal (1/2)");
    expect(r.container.textContent).toContain("Económica (2/2)");
    expect(r.container.textContent).toContain("Faltan: Técnico-legal (1/2) y Económica (2/2)");
    expect(boton(r, "Aprobar técnico-legal (1/2)")!.disabled).toBe(false);
    expect(boton(r, "Aprobar económica (2/2)")!.disabled).toBe(true);
    expect(r.container.textContent).toContain("Falta la aprobación técnico-legal (1/2).");
  });

  it("paridad3 / AE-11: quien edito contenido del expediente no puede aprobarlo y ve el motivo (el servidor decide igual)", async () => {
    stubFetch();
    const { r } = await montarAprobacion({ authoredByViewer: true });
    expect(boton(r, "Aprobar técnico-legal (1/2)")!.disabled).toBe(true);
    expect(r.container.textContent).toContain("Editaste contenido de este expediente: debe aprobarlo otra persona");
  });

  it("el primer clic solo abre el dialogo de identidad; Cancelar no llama a NINGUN endpoint de escritura", async () => {
    stubFetch();
    const { r, onChanged } = await montarAprobacion();
    click(boton(r, "Aprobar técnico-legal (1/2)")!);
    await settle();
    expect(dialogo()).not.toBeNull();
    expect(dialogo()!.textContent).toContain("Confirma tu identidad");
    expect(posts()).toHaveLength(0);
    await act(async () => {
      click(botonDialogo("Cancelar"));
      await flushMicrotasks();
    });
    await settle();
    expect(posts()).toHaveLength(0);
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("Escape tampoco escribe nada", async () => {
    stubFetch();
    const { r } = await montarAprobacion();
    click(boton(r, "Aprobar técnico-legal (1/2)")!);
    await settle();
    keydown(dialogo()!, "Escape");
    await settle();
    expect(posts()).toHaveLength(0);
  });

  it("con el codigo: pide el step-up (alcance expediente_approval) y aprueba con la etapa y la cabecera x-step-up-token", async () => {
    stubFetch();
    const { r, onChanged } = await montarAprobacion();
    click(boton(r, "Aprobar técnico-legal (1/2)")!);
    await settle();
    expect(botonDialogo("Aprobar").disabled).toBe(true); // el codigo es requerido
    changeValue(dialogo()!.querySelector("input")!, "123456");
    await act(async () => {
      click(botonDialogo("Aprobar"));
      for (let i = 0; i < 8; i++) await flushMicrotasks();
    });
    await settle();
    const stepUp = postsTo("/auth/step-up");
    expect(stepUp).toHaveLength(1);
    expect(JSON.parse(String((stepUp[0]![1] as RequestInit).body))).toEqual({ scope: "expediente_approval", code: "123456" });
    const approval = postsTo("/expediente/approval");
    expect(approval).toHaveLength(1);
    expect(JSON.parse(String((approval[0]![1] as RequestInit).body))).toEqual({ stage: "tecnica_legal" });
    expect(((approval[0]![1] as RequestInit).headers as Record<string, string>)["x-step-up-token"]).toBe("su-token");
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(r.container.textContent).toContain("Técnico-legal (1/2): aprobada.");
  });

  it("un error del servidor (403 misma persona) se muestra y refresca el estado", async () => {
    stubFetch({ approve: () => json({ message: "La aprobación técnico-legal y la económica deben darlas dos personas distintas." }, 403) });
    const { r, onChanged } = await montarAprobacion();
    click(boton(r, "Aprobar técnico-legal (1/2)")!);
    await settle();
    changeValue(dialogo()!.querySelector("input")!, "123456");
    await act(async () => {
      click(botonDialogo("Aprobar"));
      for (let i = 0; i < 8; i++) await flushMicrotasks();
    });
    await settle();
    expect(r.container.querySelector('[role="alert"]')!.textContent).toContain("dos personas distintas");
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("quien dio la otra etapa no puede dar esta: boton deshabilitado con el motivo", async () => {
    stubFetch();
    const yoDiLa1: ExpedienteApprovalsState = { ...MEDIA, stages: [{ stage: "tecnica_legal", approval: { id: "a1", approvedAt: "2026-10-01T16:00:00.000Z", approvedByRole: "analyst", byYou: true } }, { stage: "economica", approval: null }] };
    const { r } = await montarAprobacion({ state: yoDiLa1 });
    expect(boton(r, "Aprobar económica (2/2)")!.disabled).toBe(true);
    expect(r.container.textContent).toContain("Ya diste la otra aprobación de este expediente: debe darla otra persona.");
    expect(r.container.textContent).toContain("Aprobó Analista (tú)");
  });

  it("otra persona ve la 1/2 ya dada y puede dar la 2/2", async () => {
    stubFetch();
    const { r } = await montarAprobacion({ state: MEDIA });
    expect(r.container.textContent).toContain("Aprobó Analista ·");
    expect(boton(r, "Aprobar económica (2/2)")!.disabled).toBe(false);
  });

  it("sin 2FA activado: bloquea con el enlace a Seguridad (el servidor tambien lo exigiria)", async () => {
    stubFetch({ twoFactor: { available: true, enabled: false } });
    const { r } = await montarAprobacion();
    expect(boton(r, "Aprobar técnico-legal (1/2)")!.disabled).toBe(true);
    expect(r.container.querySelector('a[href="/licitaciones/demo/seguridad"]')).not.toBeNull();
  });

  it("base sin 2FA (available:false): solo confirma con un dialogo, sin pedir codigo, y no manda cabecera de step-up", async () => {
    stubFetch({ twoFactor: { available: false, enabled: false } });
    const { r } = await montarAprobacion();
    click(boton(r, "Aprobar técnico-legal (1/2)")!);
    await settle();
    expect(dialogo()!.querySelector("input")).toBeNull();
    await act(async () => {
      click(botonDialogo("Aprobar"));
      for (let i = 0; i < 8; i++) await flushMicrotasks();
    });
    await settle();
    expect(postsTo("/auth/step-up")).toHaveLength(0);
    const approval = postsTo("/expediente/approval");
    expect(approval).toHaveLength(1);
    expect(((approval[0]![1] as RequestInit).headers as Record<string, string>)["x-step-up-token"]).toBeUndefined();
  });

  it("un rol sin decision no puede aprobar: boton deshabilitado y motivo", async () => {
    stubFetch();
    const { r } = await montarAprobacion({ canApprove: false, role: "writer" });
    expect(boton(r, "Aprobar técnico-legal (1/2)")!.disabled).toBe(true);
    expect(r.container.textContent).toContain("Tu rol (writer) no puede aprobar");
  });

  it("2/2 completa: lo dice y ya no ofrece aprobar", async () => {
    stubFetch();
    const completa: ExpedienteApprovalsState = {
      mode: "doble",
      complete: true,
      missing: [],
      stages: [
        { stage: "tecnica_legal", approval: { id: "a1", approvedAt: "2026-10-01T16:00:00.000Z", approvedByRole: "analyst", byYou: false } },
        { stage: "economica", approval: { id: "a2", approvedAt: "2026-10-01T17:00:00.000Z", approvedByRole: "owner", byYou: true } },
      ],
    };
    const { r } = await montarAprobacion({ state: completa });
    expect(r.container.textContent).toContain("2/2 completa");
    expect(r.container.textContent).toContain("ya puedes ensamblar el paquete");
    expect(boton(r, "Aprobar técnico-legal")).toBeUndefined();
  });

  it("base sin migrar (legacy): aviso honesto y la aprobacion unica de siempre, con confirmacion", async () => {
    stubFetch();
    const { r, onChanged } = await montarAprobacion({ state: { mode: "legacy", stages: [], complete: false, missing: ["tecnica_legal", "economica"], singleApproval: null } });
    expect(r.container.textContent).toContain("requiere la migración 033");
    click(boton(r, "Aprobar expediente completo")!);
    await settle();
    expect(posts()).toHaveLength(0); // primero el dialogo
    await act(async () => {
      click(botonDialogo("Aprobar expediente"));
      for (let i = 0; i < 8; i++) await flushMicrotasks();
    });
    await settle();
    const approval = postsTo("/expediente/approval");
    expect(approval).toHaveLength(1);
    expect(JSON.parse(String((approval[0]![1] as RequestInit).body))).toEqual({});
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("si no se pudo cargar el estado: error con reintento (llama a onChanged), nunca una pantalla vacia", async () => {
    stubFetch();
    const { r, onChanged } = await montarAprobacion({ state: null, stateError: "No se pudo cargar el estado" });
    expect(r.container.textContent).toContain("No se pudo cargar el estado");
    click(boton(r, "Reintentar")!);
    await settle();
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("sin expediente todavia: estado vacio honesto", async () => {
    stubFetch();
    const { r } = await montarAprobacion({ state: { mode: "sin_propuesta", stages: [], complete: false, missing: ["tecnica_legal", "economica"] } });
    expect(r.container.textContent).toContain("genera primero la propuesta");
  });
});

// ---------------------------------------------------------------------------------------------------------------
const SUBMISSION = { id: "s1", status: "submitted", submittedAt: "2026-10-01T16:00:00.000Z", acknowledgementStorageRef: null, acknowledgementFileHash: "a".repeat(64), notes: "Folio 123", createdAt: "2026-10-01T16:05:00.000Z" };

function stubSubmission(opts: { initial?: unknown; declare?: (n: number) => Response } = {}) {
  let declareCalls = 0;
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/submission") && (init?.method ?? "GET") === "GET") return json(opts.initial ?? null);
    if (u.endsWith("/submission/declare") && init?.method === "POST") {
      declareCalls += 1;
      return (opts.declare ?? (() => json(SUBMISSION, 201)))(declareCalls);
    }
    throw new Error(`fetch inesperado: ${init?.method ?? "GET"} ${u}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}

async function montarPresentacion(over: Partial<PresentacionPortalProps> = {}) {
  const props: PresentacionPortalProps = { apiBaseUrl: "https://api.test", token: "tok", propertyId: "p1", tenderId: "t1", canDeclare: true, role: "analyst", packageStatus: "ready", ...over };
  rendered = renderComponent(<PresentacionPortal {...props} />);
  await settle();
  return rendered;
}

describe("PresentacionPortal -- declarar la presentacion ante el portal", () => {
  it("dice la verdad: Atiende nunca envia la oferta; solo registra la declaracion", async () => {
    stubSubmission();
    const r = await montarPresentacion();
    expect(r.container.textContent).toContain("Atiende nunca envía tu oferta al portal");
    expect(r.container.querySelector("form")).not.toBeNull();
  });

  it("ya declarada: se ve al cargar (recarga), con fecha, notas y huella del acuse, y no ofrece el formulario", async () => {
    stubSubmission({ initial: SUBMISSION });
    const r = await montarPresentacion();
    const card = r.container.querySelector('[data-testid="presentacion-declarada"]')!;
    expect(card.textContent).toContain("Folio 123");
    expect(card.textContent).toContain("huella SHA-256 aaaaaaaaaaaa");
    expect(r.container.querySelector("form")).toBeNull();
    expect(r.container.textContent).toContain("Declarada");
  });

  it("enviar abre el dialogo; Cancelar NO escribe; confirmar manda la declaracion con idempotency-key y la deja visible", async () => {
    stubSubmission();
    const r = await montarPresentacion();
    changeValue(r.container.querySelector("#presentacion-fecha")! as HTMLInputElement, "2026-10-01T10:00");
    changeValue(r.container.querySelector("#presentacion-notas")! as HTMLTextAreaElement, "Folio 123");
    await submitForm(r.container.querySelector("form")!);
    expect(dialogo()).not.toBeNull();
    expect(dialogo()!.textContent).toContain("Atiende no envía nada al portal");
    expect(posts()).toHaveLength(0);
    await act(async () => {
      click(botonDialogo("Cancelar"));
      await flushMicrotasks();
    });
    await settle();
    expect(posts()).toHaveLength(0);

    await submitForm(r.container.querySelector("form")!);
    await act(async () => {
      click(botonDialogo("Declarar presentación"));
      for (let i = 0; i < 10; i++) await flushMicrotasks();
    });
    await settle();
    const declares = postsTo("/submission/declare");
    expect(declares).toHaveLength(1);
    const init = declares[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>)["idempotency-key"]).toBeTruthy();
    const body = JSON.parse(String(init.body)) as { submittedAt: string; notes: string; acknowledgementContentBase64: string | null };
    expect(body.notes).toBe("Folio 123");
    expect(body.acknowledgementContentBase64).toBeNull();
    expect(Number.isNaN(new Date(body.submittedAt).getTime())).toBe(false);
    expect(r.container.querySelector('[data-testid="presentacion-declarada"]')).not.toBeNull();
  });

  it("un reintento del MISMO formulario reutiliza la clave de idempotencia; si el formulario cambia, usa otra", async () => {
    stubSubmission({ declare: (n) => (n === 1 ? json({ message: "falló" }, 500) : json(SUBMISSION, 201)) });
    const r = await montarPresentacion();
    changeValue(r.container.querySelector("#presentacion-fecha")! as HTMLInputElement, "2026-10-01T10:00");
    const enviar = async () => {
      await submitForm(r.container.querySelector("form")!);
      await act(async () => {
        click(botonDialogo("Declarar presentación"));
        for (let i = 0; i < 10; i++) await flushMicrotasks();
      });
      await settle();
    };
    await enviar();
    expect(r.container.querySelector('[role="alert"]')!.textContent).toContain("falló");
    await enviar();
    const keys = postsTo("/submission/declare").map(([, init]) => ((init as RequestInit).headers as Record<string, string>)["idempotency-key"]);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it("cambiar una nota entre intentos rota la clave (misma clave con otro cuerpo seria un 422)", async () => {
    stubSubmission({ declare: (n) => (n === 1 ? json({ message: "falló" }, 500) : json(SUBMISSION, 201)) });
    const r = await montarPresentacion();
    changeValue(r.container.querySelector("#presentacion-fecha")! as HTMLInputElement, "2026-10-01T10:00");
    const enviar = async () => {
      await submitForm(r.container.querySelector("form")!);
      await act(async () => {
        click(botonDialogo("Declarar presentación"));
        for (let i = 0; i < 10; i++) await flushMicrotasks();
      });
      await settle();
    };
    await enviar();
    changeValue(r.container.querySelector("#presentacion-notas")! as HTMLTextAreaElement, "otra nota");
    await enviar();
    const keys = postsTo("/submission/declare").map(([, init]) => ((init as RequestInit).headers as Record<string, string>)["idempotency-key"]);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("un acuse mayor al tope se rechaza en el cliente, sin enviar nada", async () => {
    stubSubmission();
    const r = await montarPresentacion();
    const grande = new File(["x"], "acuse.pdf");
    Object.defineProperty(grande, "size", { value: 25 * 1024 * 1024 });
    const input = r.container.querySelector("#presentacion-acuse")! as HTMLInputElement;
    Object.defineProperty(input, "files", { value: [grande], configurable: true });
    act(() => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await settle();
    expect(r.container.querySelector('[role="alert"]')!.textContent).toContain("el máximo es 20 MB");
    expect(posts()).toHaveLength(0);
  });

  it("falla la carga: error con reintento, no un formulario que parezca vacio", async () => {
    fetchMock = vi.fn(async () => json({ message: "Convocatoria no encontrada." }, 404));
    vi.stubGlobal("fetch", fetchMock);
    const r = await montarPresentacion();
    expect(r.container.textContent).toContain("Convocatoria no encontrada.");
    expect(r.container.querySelector("form")).toBeNull();
    expect(boton(r, "Reintentar")).toBeDefined();
  });

  it("sin paquete listo advierte (sin bloquear); un rol de solo lectura no ve el formulario", async () => {
    stubSubmission();
    const r = await montarPresentacion({ packageStatus: "draft", canDeclare: false, role: "viewer" });
    expect(r.container.textContent).toContain("El último paquete sigue en borrador.");
    expect(r.container.querySelector("form")).toBeNull();
    expect(r.container.textContent).toContain("Tu rol (viewer) no puede declarar");
  });
});
