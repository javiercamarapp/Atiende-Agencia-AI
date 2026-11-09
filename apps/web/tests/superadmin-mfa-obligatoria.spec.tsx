// @vitest-environment jsdom
//
// MFA obligatoria del superadmin: mientras el API diga que la MFA es obligatoria y este superadmin no
// la ha activado, el shell manda a /superadmin/seguridad en vez de mostrar paginas que solo darian 403.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { SuperAdminShell } from "../src/superadmin/SuperAdminShell.tsx";
import { debeEnrolarMfa } from "../src/superadmin/lib/mfa-obligatoria.ts";
import { flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";
import { installMatchMediaStub, installMemoryLocalStorage } from "./test-utils/memory-storage.ts";

vi.mock("../src/lib/useNotifications.ts", () => ({
  useNotifications: () => ({ items: [], unreadCount: 0, loading: false, refetch: () => {}, onMarkRead: () => {}, onMarkAllRead: () => {} }),
}));
vi.mock("../src/superadmin/components/ImpersonacionBanner.tsx", () => ({ ImpersonacionBanner: () => null }));

const SESSION = { token: "tok", refreshToken: "reftok", email: "root@example.com", fullName: "Root" };
let rendered: RenderedComponent | undefined;

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

function stubEstado(estado: unknown, ok = true) {
  const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(estado), { status: ok ? 200 : 500, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function renderEn(ruta: string): Promise<RenderedComponent> {
  installMatchMediaStub();
  installMemoryLocalStorage().setItem("atiende.superadmin.session", JSON.stringify(SESSION));
  const pagina = (nombre: string) => () => <div data-testid="pagina">{nombre}</div>;
  const result = renderComponent(
    <MemoryRouter initialEntries={[ruta]}>
      <Routes>
        {["/superadmin", "/superadmin/organizaciones", "/superadmin/seguridad"].map((p) => (
          <Route key={p} path={p} element={<SuperAdminShell apiBaseUrl="https://api.test" onRequireLogin={() => {}}>{pagina(p)}</SuperAdminShell>} />
        ))}
      </Routes>
    </MemoryRouter>,
  );
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
  });
  return result;
}

const pagina = (r: RenderedComponent) => r.container.querySelector('[data-testid="pagina"]')?.textContent;

describe("debeEnrolarMfa", () => {
  it("solo con disponible + obligatoria + no inscrito", () => {
    expect(debeEnrolarMfa({ disponible: true, obligatoria: true, inscrito: false })).toBe(true);
    expect(debeEnrolarMfa({ disponible: true, obligatoria: true, inscrito: true })).toBe(false);
    expect(debeEnrolarMfa({ disponible: true, obligatoria: false, inscrito: false })).toBe(false);
    expect(debeEnrolarMfa({ disponible: false, obligatoria: true, inscrito: false })).toBe(false);
    expect(debeEnrolarMfa(null)).toBe(false);
  });
});

describe("SuperAdminShell con MFA obligatoria", () => {
  it("sin factor activo redirige a Seguridad desde cualquier pagina", async () => {
    const fetchMock = stubEstado({ disponible: true, obligatoria: true, inscrito: false, pendiente: false, bloqueadoHastaMs: null });
    rendered = await renderEn("/superadmin/organizaciones");
    expect(fetchMock).toHaveBeenCalled();
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://api.test/superadmin/mfa/estado");
    expect(pagina(rendered)).toBe("/superadmin/seguridad");
  });

  it("con factor activo muestra la pagina pedida", async () => {
    stubEstado({ disponible: true, obligatoria: true, inscrito: true, pendiente: false, bloqueadoHastaMs: null });
    rendered = await renderEn("/superadmin/organizaciones");
    expect(pagina(rendered)).toBe("/superadmin/organizaciones");
  });

  it("si la consulta de estado falla no bloquea (el API sigue cortando)", async () => {
    stubEstado({ message: "x" }, false);
    rendered = await renderEn("/superadmin/organizaciones");
    expect(pagina(rendered)).toBe("/superadmin/organizaciones");
  });
});
