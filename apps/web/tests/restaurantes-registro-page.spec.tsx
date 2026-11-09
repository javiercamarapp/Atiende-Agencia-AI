// @vitest-environment jsdom
//
// Registro autoservicio de restaurantes (pantallas /restaurantes/registro y /restaurantes/registro/confirmar) con un fetch falso:
// payload armado desde lo tecleado (trampa vacia + tiempo de llenado), estado «revisa tu correo», Google navega a la URL del
// servidor, «no disponible aún» honesto y el canje del token del fragmento que pasa al puente de sesion.
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { RestaurantesRegistroPage } from "../src/verticals/restaurantes/pages/Registro.tsx";
import { RestaurantesRegistroConfirmarPage } from "../src/verticals/restaurantes/pages/RegistroConfirmar.tsx";
import { tokenDelFragmento } from "../src/verticals/restaurantes/lib/registro-client.ts";
import { changeValue, click, esperarHasta, flushMicrotasks, renderComponent, submitForm, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
});

function respuesta(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function fetchFalso(opciones: { disponible?: boolean; google?: boolean; iniciar?: () => Response } = {}) {
  const llamadas: Array<{ url: string; body: unknown }> = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    llamadas.push({ url: u, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (u.endsWith("/estado")) return respuesta(200, { disponible: opciones.disponible ?? true, google: opciones.google ?? true, correo: true });
    if (u.endsWith("/iniciar")) return opciones.iniciar ? opciones.iniciar() : respuesta(202, { ok: true, metodo: "correo" });
    return respuesta(404, {});
  }) as unknown as typeof fetch;
  return { impl, llamadas };
}

function byId<T extends HTMLElement>(root: HTMLElement, id: string): T {
  const el = root.querySelector(`#${id}`);
  if (!el) throw new Error(`No se encontró #${id}`);
  return el as T;
}

function llenar(root: HTMLElement) {
  changeValue(byId(root, "registro-negocio"), "Taquería Lupita");
  changeValue(byId(root, "registro-sucursal"), "Centro");
  changeValue(byId(root, "registro-nombre"), "Lupita Pérez");
  changeValue(byId(root, "registro-correo"), "lupita@example.com");
}

describe("RestaurantesRegistroPage", () => {
  it("con correo: manda el payload con la trampa vacia y el tiempo de llenado, y muestra «Revisa tu correo»", async () => {
    const f = fetchFalso();
    rendered = renderComponent(
      <MemoryRouter initialEntries={["/restaurantes/registro"]}>
        <RestaurantesRegistroPage apiBaseUrl="https://api.test" fetchImpl={f.impl} />
      </MemoryRouter>,
    );
    await flushMicrotasks();
    llenar(rendered.container);
    await submitForm(rendered.container.querySelector("form")!);
    await esperarHasta(() => rendered!.container.textContent!.includes("Revisa tu correo"), "pantalla de revisa tu correo");
    const iniciar = f.llamadas.find((l) => l.url === "https://api.test/auth/registro/restaurantes/iniciar")!;
    expect(iniciar.body).toMatchObject({ metodo: "correo", correo: "lupita@example.com", nombreNegocio: "Taquería Lupita", nombreSucursal: "Centro", nombreCompleto: "Lupita Pérez", sitioWeb: "" });
    expect(typeof (iniciar.body as { msLlenado: number }).msLlenado).toBe("number");
  });

  it("con Google: navega a la URL que devuelve el servidor", async () => {
    const f = fetchFalso({ iniciar: () => respuesta(200, { ok: true, metodo: "google", url: "https://accounts.google.com/o/oauth2?x=1" }) });
    const irA = vi.fn();
    rendered = renderComponent(
      <MemoryRouter initialEntries={["/restaurantes/registro"]}>
        <RestaurantesRegistroPage apiBaseUrl="https://api.test" fetchImpl={f.impl} irA={irA} />
      </MemoryRouter>,
    );
    await esperarHasta(() => rendered!.container.textContent!.includes("Continuar con Google"), "boton de Google");
    llenar(rendered.container);
    click([...rendered.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Continuar con Google"))!);
    await esperarHasta(() => irA.mock.calls.length > 0, "navegacion a Google");
    expect(irA).toHaveBeenCalledWith("https://accounts.google.com/o/oauth2?x=1");
    expect((f.llamadas.find((l) => l.url.endsWith("/iniciar"))!.body as { correo?: string }).correo).toBeUndefined();
  });

  it("sin la migracion: «No disponible aún» y el formulario deshabilitado; el error del servidor se muestra tal cual", async () => {
    const f = fetchFalso({ disponible: false, google: false });
    rendered = renderComponent(
      <MemoryRouter initialEntries={["/restaurantes/registro"]}>
        <RestaurantesRegistroPage apiBaseUrl="https://api.test" fetchImpl={f.impl} />
      </MemoryRouter>,
    );
    await esperarHasta(() => rendered!.container.textContent!.includes("No disponible aún"), "aviso no disponible");
    expect(rendered.container.textContent).not.toContain("Continuar con Google");
    expect((rendered.container.querySelector("fieldset") as HTMLFieldSetElement).disabled).toBe(true);
  });

  it("el error que deja el callback de Google (?registro_error=cuenta_existente) se explica", async () => {
    const f = fetchFalso();
    rendered = renderComponent(
      <MemoryRouter initialEntries={["/restaurantes/registro?registro_error=cuenta_existente"]}>
        <RestaurantesRegistroPage apiBaseUrl="https://api.test" fetchImpl={f.impl} />
      </MemoryRouter>,
    );
    await flushMicrotasks();
    expect(rendered.container.textContent).toContain("Ya tienes una cuenta con ese correo");
  });
});

describe("RestaurantesRegistroConfirmarPage", () => {
  it("canjea el token del fragmento SOLO al tocar el boton y pasa el codigo al puente de sesion", async () => {
    const token = "t".repeat(43);
    const llamadas: unknown[] = [];
    const impl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      llamadas.push(JSON.parse(String(init?.body)));
      return respuesta(201, { code: "codigo-de-intercambio-123456", orgSlug: "taqueria-lupita", trialEndsAt: "2026-11-21T00:00:00Z" });
    }) as unknown as typeof fetch;
    rendered = renderComponent(
      <MemoryRouter initialEntries={["/restaurantes/registro/confirmar"]}>
        <Routes>
          <Route path="/restaurantes/registro/confirmar" element={<RestaurantesRegistroConfirmarPage apiBaseUrl="https://api.test" fetchImpl={impl} hash={`#token=${token}`} />} />
          <Route path="/restaurantes/auth/google/callback" element={<p>puente de sesion</p>} />
        </Routes>
      </MemoryRouter>,
    );
    expect(llamadas).toHaveLength(0);
    click([...rendered.container.querySelectorAll("button")].find((b) => b.textContent === "Crear mi restaurante")!);
    await esperarHasta(() => rendered!.container.textContent!.includes("puente de sesion"), "navegacion al puente");
    expect(llamadas).toEqual([{ token }]);
  });

  it("sin token en el fragmento: aviso y boton deshabilitado", () => {
    rendered = renderComponent(
      <MemoryRouter>
        <RestaurantesRegistroConfirmarPage apiBaseUrl="https://api.test" hash="" />
      </MemoryRouter>,
    );
    expect(rendered.container.textContent).toContain("El enlace está incompleto");
    expect(([...rendered.container.querySelectorAll("button")].find((b) => b.textContent === "Crear mi restaurante") as HTMLButtonElement).disabled).toBe(true);
  });

  it("tokenDelFragmento solo acepta tokens base64url de 20 a 128", () => {
    expect(tokenDelFragmento("#token=" + "a".repeat(43))).toBe("a".repeat(43));
    expect(tokenDelFragmento("#token=<script>")).toBeNull();
    expect(tokenDelFragmento("")).toBeNull();
  });
});
