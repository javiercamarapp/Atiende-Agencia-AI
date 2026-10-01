// @vitest-environment jsdom
//
// "Chatea con tus datos" conectado en CitasShell: el boton del encabezado deja de decir "Pronto" SOLO cuando el servidor
// confirma available=true en SU ruta; con el servidor diciendo no (o fallando, por ejemplo 403 para el rol staff) sigue el
// aviso honesto. Al abrir, la conversacion es real: la pregunta viaja por POST a la ruta de citas con el Bearer de la sesion
// y la respuesta pinta tabla y fuente del servidor.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { CitasShell } from "../src/verticals/citas/CitasShell.tsx";
import { SUGERENCIAS_CITAS } from "../src/verticals/citas/lib/chat-datos-client.ts";
import type { BranchOption } from "../src/verticals/citas/lib/admin-client.ts";
import { changeValue, click, flushMicrotasks, renderComponent, submitForm, type RenderedComponent } from "./test-utils/render.tsx";
import { installMatchMediaStub, installMemoryLocalStorage } from "./test-utils/memory-storage.ts";

const fetchBranchesMock = vi.fn<(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, orgSlug: string) => Promise<readonly BranchOption[]>>();

vi.mock("../src/verticals/citas/lib/admin-client.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/verticals/citas/lib/admin-client.ts")>();
  return { ...actual, fetchBranches: (...args: Parameters<typeof fetchBranchesMock>) => fetchBranchesMock(...args) };
});
vi.mock("../src/lib/useNotifications.ts", () => ({
  useNotifications: () => ({ items: [], unreadCount: 0, loading: false, refetch: () => {}, onMarkRead: () => {}, onMarkAllRead: () => {} }),
}));

const RUTA = "https://api.test/citas/prop-1/chat-datos";
const RESPUESTA = {
  status: "ok",
  text: "Resumen del servidor.",
  blocks: [{ tool: "t", title: "Tabla del servidor", columns: [{ key: "n", label: "Servicio", kind: "text" }, { key: "m", label: "Ingresos", kind: "mxn" }], rows: [{ n: "Consulta", m: 1234.5 }], truncated: false }],
  sources: [{ tool: "t", source: "Fuente de prueba", periodLabel: "este mes", scopeLabel: "todas tus sucursales" }],
  toolsUsed: ["t"],
};

let rendered: RenderedComponent | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  document.body.innerHTML = "";
  fetchBranchesMock.mockReset();
  vi.unstubAllGlobals();
});

type Llamada = { url: string; init: RequestInit | undefined };

function stubFetch(estado: () => Response | Promise<Response>): Llamada[] {
  const calls: Llamada[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url) === `${RUTA}/estado`) return estado();
      if (String(url) === RUTA) return new Response(JSON.stringify(RESPUESTA), { status: 200, headers: { "content-type": "application/json" } });
      return new Response("{}", { status: 200 });
    }),
  );
  return calls;
}
const siEsta = () => new Response(JSON.stringify({ available: true }), { status: 200, headers: { "content-type": "application/json" } });

async function renderCitas(rol = "owner"): Promise<RenderedComponent> {
  installMatchMediaStub();
  installMemoryLocalStorage().setItem("atiende.citas.session", JSON.stringify({ token: "tok-c", refreshToken: "r", email: "o@example.com", fullName: "O", organizations: [{ id: "o", slug: "demo", nombre: "Demo", vertical: "citas", rol }] }));
  fetchBranchesMock.mockResolvedValue([{ propertyId: "prop-1", name: "Sucursal Centro" }]);
  const r = renderComponent(
    <MemoryRouter>
      <CitasShell apiBaseUrl="https://api.test" orgSlug="demo" onRequireLogin={() => {}}>
        {() => <div>child</div>}
      </CitasShell>
    </MemoryRouter>,
  );
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
  });
  return r;
}

const botonesChat = (): HTMLButtonElement[] => [...document.body.querySelectorAll("button")].filter((b) => b.textContent?.includes("Chatea con tus datos")) as HTMLButtonElement[];

describe("CitasShell — Chatea con tus datos", () => {
  it("consulta la disponibilidad en la ruta de CITAS con el Bearer de la sesion y, si el servidor la confirma, quita 'Pronto'", async () => {
    const calls = stubFetch(siEsta);
    rendered = await renderCitas();
    const estado = calls.find((c) => c.url === `${RUTA}/estado`);
    expect(estado).toBeDefined();
    expect((estado!.init!.headers as Record<string, string>).authorization).toBe("Bearer tok-c");
    expect(botonesChat()[0]!.textContent).not.toContain("Pronto");
  });

  it("si el servidor dice que no esta activo (o responde 403 por rol/500/falla), SIGUE el aviso honesto con 'Pronto'", async () => {
    for (const estado of [
      () => new Response(JSON.stringify({ available: false }), { status: 200 }),
      () => new Response("{}", { status: 403 }),
      () => new Response("{}", { status: 500 }),
      () => Promise.reject(new TypeError("offline")),
    ]) {
      stubFetch(estado);
      rendered = await renderCitas("staff");
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

  it("con el asistente activo la conversacion es real: sugerencias de citas, POST con Bearer y respuesta del servidor (tabla + fuente)", async () => {
    const calls = stubFetch(siEsta);
    rendered = await renderCitas();
    click(botonesChat()[0]!);
    const d = document.body.querySelector('[role="dialog"]')!;
    for (const s of SUGERENCIAS_CITAS) expect(d.textContent).toContain(s);
    const campo = d.querySelector("textarea, input") as HTMLInputElement;
    changeValue(campo, "¿Cuánto facturé este mes?");
    await submitForm(d.querySelector("form") as HTMLFormElement);
    const post = calls.find((c) => c.url === RUTA && c.init?.method === "POST")!;
    expect(post).toBeDefined();
    expect((post.init!.headers as Record<string, string>).authorization).toBe("Bearer tok-c");
    const cuerpo = JSON.parse(post.init!.body as string) as Record<string, unknown>;
    expect(Object.keys(cuerpo).sort()).toEqual(["history", "question"]);
    expect(cuerpo["question"]).toBe("¿Cuánto facturé este mes?");
    const dialogo = document.body.querySelector('[role="dialog"]')!;
    expect(dialogo.textContent).toContain("Resumen del servidor.");
    expect(dialogo.textContent).toContain("$1,234.50 MXN");
    expect(dialogo.textContent).toContain("Fuente: Fuente de prueba");
    expect(dialogo.textContent).toContain("Alcance: todas tus sucursales");
  });
});
