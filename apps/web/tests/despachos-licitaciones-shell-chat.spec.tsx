// @vitest-environment jsdom
//
// "Chatea con tus datos" conectado en los shells de DESPACHOS y LICITACIONES: el boton del encabezado deja de
// decir "Pronto" SOLO cuando el servidor confirma available=true en su propia ruta; con el servidor
// diciendo no (o fallando) sigue el aviso honesto. Al abrir, la conversacion es real: la pregunta viaja por
// POST a la ruta de la vertical con el Bearer de la sesion y la respuesta pinta tabla y fuente del servidor.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { DespachosShell } from "../src/verticals/despachos/DespachosShell.tsx";
import { LicitacionesShell } from "../src/verticals/licitaciones/LicitacionesShell.tsx";
import { SUGERENCIAS_DESPACHOS } from "../src/verticals/despachos/lib/chat-datos-client.ts";
import { SUGERENCIAS_LICITACIONES } from "../src/verticals/licitaciones/lib/chat-datos-client.ts";
import { changeValue, click, flushMicrotasks, renderComponent, submitForm, type RenderedComponent } from "./test-utils/render.tsx";
import { installMatchMediaStub, installMemoryLocalStorage } from "./test-utils/memory-storage.ts";

const fetchBranchesDespachos = vi.fn();
const fetchBranchesLicitaciones = vi.fn();

vi.mock("../src/verticals/despachos/lib/admin-client.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/verticals/despachos/lib/admin-client.ts")>();
  return { ...actual, fetchBranches: (...args: unknown[]) => fetchBranchesDespachos(...args) };
});
vi.mock("../src/verticals/licitaciones/lib/admin-client.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/verticals/licitaciones/lib/admin-client.ts")>();
  return { ...actual, fetchBranches: (...args: unknown[]) => fetchBranchesLicitaciones(...args) };
});
vi.mock("../src/lib/useNotifications.ts", () => ({
  useNotifications: () => ({ items: [], unreadCount: 0, loading: false, refetch: () => {}, onMarkRead: () => {}, onMarkAllRead: () => {} }),
}));

const RESPUESTA = {
  status: "ok",
  text: "Resumen del servidor.",
  blocks: [{ tool: "t", title: "Tabla del servidor", columns: [{ key: "n", label: "Nombre", kind: "text" }, { key: "m", label: "Monto", kind: "mxn" }], rows: [{ n: "Abarrotes", m: 1234.5 }], truncated: false }],
  sources: [{ tool: "t", source: "Fuente de prueba", periodLabel: "este mes", scopeLabel: "todos tus clientes" }],
  toolsUsed: ["t"],
};

let rendered: RenderedComponent | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  document.body.innerHTML = "";
  fetchBranchesDespachos.mockReset();
  fetchBranchesLicitaciones.mockReset();
  vi.unstubAllGlobals();
});

type Llamada = { url: string; init: RequestInit | undefined };

function stubFetch(estado: () => Response | Promise<Response>): Llamada[] {
  const calls: Llamada[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith("/chat-datos/estado")) return estado();
      if (String(url).endsWith("/chat-datos")) return new Response(JSON.stringify(RESPUESTA), { status: 200, headers: { "content-type": "application/json" } });
      return new Response("{}", { status: 200 });
    }),
  );
  return calls;
}
const siEsta = () => new Response(JSON.stringify({ available: true }), { status: 200, headers: { "content-type": "application/json" } });

async function renderDespachos(): Promise<RenderedComponent> {
  installMatchMediaStub();
  installMemoryLocalStorage().setItem("atiende.despachos.session", JSON.stringify({ token: "tok-d", refreshToken: "r", email: "c@example.com", fullName: "C", organizations: [{ id: "o", slug: "demo", nombre: "Demo", vertical: "despachos", rol: "admin" }] }));
  fetchBranchesDespachos.mockResolvedValue([{ propertyId: "prop-d1", name: "Contribuyente Uno" }]);
  const r = renderComponent(
    <MemoryRouter>
      <DespachosShell apiBaseUrl="https://api.test" orgSlug="demo" onRequireLogin={() => {}}>
        {() => <div>child</div>}
      </DespachosShell>
    </MemoryRouter>,
  );
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
  });
  return r;
}

async function renderLicitaciones(): Promise<RenderedComponent> {
  installMatchMediaStub();
  installMemoryLocalStorage().setItem("atiende.licitaciones.session", JSON.stringify({ token: "tok-l", refreshToken: "r", email: "o@example.com", fullName: "O", organizations: [{ id: "o", slug: "demo", nombre: "Demo", vertical: "licitaciones", rol: "owner" }] }));
  fetchBranchesLicitaciones.mockResolvedValue([{ propertyId: "prop-l1", name: "Empresa Demo" }]);
  const r = renderComponent(
    <MemoryRouter>
      <LicitacionesShell apiBaseUrl="https://api.test" orgSlug="demo" onRequireLogin={() => {}}>
        {() => <div>child</div>}
      </LicitacionesShell>
    </MemoryRouter>,
  );
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
  });
  return r;
}

const botonesChat = (): HTMLButtonElement[] => [...document.body.querySelectorAll("button")].filter((b) => b.textContent?.includes("Chatea con tus datos")) as HTMLButtonElement[];

describe.each([
  { nombre: "DespachosShell", render: renderDespachos, ruta: "https://api.test/despachos/prop-d1/chat-datos", bearer: "Bearer tok-d", sugerencias: SUGERENCIAS_DESPACHOS },
  { nombre: "LicitacionesShell", render: renderLicitaciones, ruta: "https://api.test/licitaciones/prop-l1/chat-datos", bearer: "Bearer tok-l", sugerencias: SUGERENCIAS_LICITACIONES },
])("$nombre — Chatea con tus datos", ({ render, ruta, bearer, sugerencias }) => {
  it("consulta la disponibilidad en la ruta de SU vertical y, si el servidor la confirma, quita 'Pronto'", async () => {
    const calls = stubFetch(siEsta);
    rendered = await render();
    expect(calls.some((c) => c.url === `${ruta}/estado`)).toBe(true);
    const boton = botonesChat()[0]!;
    expect(boton.textContent).not.toContain("Pronto");
  });

  it("si el servidor dice que no esta activo (o responde 403/500/falla), SIGUE el aviso honesto con 'Pronto'", async () => {
    for (const estado of [
      () => new Response(JSON.stringify({ available: false }), { status: 200 }),
      () => new Response("{}", { status: 403 }),
      () => new Response("{}", { status: 500 }),
      () => Promise.reject(new TypeError("offline")),
    ]) {
      stubFetch(estado);
      rendered = await render();
      expect(botonesChat()[0]!.textContent).toContain("Pronto");
      click(botonesChat()[0]!);
      expect(document.body.querySelector('[role="dialog"]')!.textContent).toContain("todavía no está disponible");
      expect(document.body.querySelector('[role="dialog"] textarea, [role="dialog"] input')).toBeNull();
      rendered.unmount();
      rendered = undefined;
      document.body.innerHTML = "";
      vi.unstubAllGlobals();
    }
  });

  it("con el asistente activo la conversacion es real: sugerencias de la vertical, POST con Bearer y respuesta del servidor (tabla + fuente)", async () => {
    const calls = stubFetch(siEsta);
    rendered = await render();
    click(botonesChat()[0]!);
    const d = document.body.querySelector('[role="dialog"]')!;
    for (const s of sugerencias) expect(d.textContent).toContain(s);
    const campo = d.querySelector("textarea, input") as HTMLInputElement;
    changeValue(campo, "¿Cuánto me deben?");
    await submitForm(d.querySelector("form") as HTMLFormElement);
    const post = calls.find((c) => c.url === ruta && c.init?.method === "POST")!;
    expect(post).toBeDefined();
    expect((post.init!.headers as Record<string, string>).authorization).toBe(bearer);
    const cuerpo = JSON.parse(post.init!.body as string) as Record<string, unknown>;
    expect(Object.keys(cuerpo).sort()).toEqual(["history", "question"]);
    expect(cuerpo["question"]).toBe("¿Cuánto me deben?");
    const dialogo = document.body.querySelector('[role="dialog"]')!;
    expect(dialogo.textContent).toContain("Resumen del servidor.");
    expect(dialogo.textContent).toContain("$1,234.50 MXN");
    expect(dialogo.textContent).toContain("Fuente: Fuente de prueba");
    expect(dialogo.textContent).toContain("Alcance: todos tus clientes");
  });
});
