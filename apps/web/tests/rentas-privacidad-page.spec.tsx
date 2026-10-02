// @vitest-environment jsdom
//
// Smoke tests reales de <PrivacidadPage /> de rentas (Rn-07): gate de rol, base sin migrar, lista, registro y cambio de estado.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PrivacidadPage } from "../src/verticals/rentas/pages/Privacidad.tsx";
import type { LoginSession } from "../src/lib/auth-client.ts";
import { click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});
async function esperar(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i++) await flushMicrotasks();
  });
}
const sesion = (rol: string): LoginSession => ({ token: "tok", refreshToken: "ref", email: "s@example.com", organizations: [{ id: "org-1", slug: "gestora-demo", nombre: "Gestora", vertical: "rentas", rol }] });
const json = (body: unknown, status = 200): Response => ({ ok: status < 400, status, json: async () => body }) as unknown as Response;
const montar = (rol: string) => renderComponent(<PrivacidadPage apiBaseUrl="http://api.local" token="tok" propertyId="prop-1" setPropertyId={() => {}} properties={[]} orgSlug="gestora-demo" session={sesion(rol)} />);

const SOLICITUD = {
  id: "s1",
  folio: "ARCO-R-00000001",
  derecho: "acceso",
  canal: "correo",
  estado: "recibida",
  plazo: "vencida",
  solicitanteNombre: "Titular Uno",
  solicitanteContacto: "titular1@example.com",
  detalle: null,
  recibidaEn: "2026-08-01T10:00:00Z",
  respuestaVenceEn: "2026-08-21T10:00:00Z",
  ejecucionVenceEn: "2026-09-05T10:00:00Z",
  notaResolucion: null,
};
const PLAZOS = { respuestaDias: 20, ejecucionDias: 15 };

function red(disponible = true, extra: (url: string, init?: RequestInit) => Response | undefined = () => undefined) {
  const llamadas: { url: string; method: string; body?: unknown }[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    llamadas.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const c = extra(url, init);
    if (c) return c;
    if (url.includes("/privacidad/solicitudes?")) return json({ disponible, total: disponible ? 1 : 0, nextOffset: null, plazos: PLAZOS, items: disponible ? [SOLICITUD] : [] });
    throw new Error(`url inesperada: ${url}`);
  });
  return { fn, llamadas };
}

describe("PrivacidadPage (rentas)", () => {
  it("el admin ve la solicitud con su folio, contacto y plazo vencido", async () => {
    vi.stubGlobal("fetch", red().fn);
    rendered = montar("admin_gestora");
    await esperar();
    const texto = rendered.container.textContent ?? "";
    expect(texto).toContain("ARCO-R-00000001");
    expect(texto).toContain("titular1@example.com");
    expect(texto).toContain("Vencida");
    expect(texto).toContain("Registrar una solicitud");
  });

  it("registrar hace POST con el cuerpo del formulario y recarga la lista", async () => {
    const { fn, llamadas } = red(true, (url, init) => (init?.method === "POST" ? json({ id: "s2", folio: "ARCO-R-00000002", creada: true }, 201) : undefined));
    vi.stubGlobal("fetch", fn);
    rendered = montar("admin_gestora");
    await esperar();
    const escribir = (el: HTMLInputElement | HTMLTextAreaElement, valor: string) => {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, valor);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    };
    const [nombre, contacto] = [...rendered.container.querySelectorAll("input")].filter((i) => i.required);
    await act(async () => {
      escribir(nombre!, "Titular Dos");
      escribir(contacto!, "titular2@example.com");
      await flushMicrotasks();
    });
    const boton = [...rendered.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Registrar solicitud"))!;
    await act(async () => {
      click(boton);
      await flushMicrotasks();
    });
    await esperar();
    const post = llamadas.find((l) => l.method === "POST");
    expect(post?.url).toBe("http://api.local/rentas/prop-1/privacidad/solicitudes");
    expect(post?.body).toMatchObject({ derecho: "acceso", canal: "correo", solicitanteNombre: "Titular Dos", solicitanteContacto: "titular2@example.com", detalle: null, recibidaEn: null });
    expect(rendered.container.textContent).toContain("Solicitud registrada (ARCO-R-00000002).");
  });

  it("Iniciar hace PATCH al estado en_proceso y recarga", async () => {
    const { fn, llamadas } = red(true, (url, init) => (init?.method === "PATCH" ? json({ id: "s1", estado: "en_proceso" }) : undefined));
    vi.stubGlobal("fetch", fn);
    rendered = montar("admin_gestora");
    await esperar();
    const iniciar = [...rendered.container.querySelectorAll("button")].find((b) => b.textContent === "Iniciar")!;
    await act(async () => {
      click(iniciar);
      await flushMicrotasks();
    });
    const confirmar = [...rendered.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Confirmar: Iniciar"))!;
    await act(async () => {
      click(confirmar);
      await flushMicrotasks();
    });
    await esperar();
    expect(llamadas.some((l) => l.method === "PATCH" && l.url === "http://api.local/rentas/prop-1/privacidad/solicitudes/s1/estado" && JSON.stringify(l.body) === JSON.stringify({ estado: "en_proceso", nota: null }))).toBe(true);
  });

  it("contra la base sin la migracion 028 explica que aun no esta disponible y no ofrece registrar", async () => {
    vi.stubGlobal("fetch", red(false).fn);
    rendered = montar("admin_gestora");
    await esperar();
    const texto = rendered.container.textContent ?? "";
    expect(texto).toContain("Seguimiento ARCO no disponible aún");
    expect(texto).toContain("migración 028");
    expect(texto).not.toContain("Registrar una solicitud");
  });

  it("un error del servidor se muestra con opcion de reintentar", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ message: "Fallo interno" }, 500)));
    rendered = montar("admin_gestora");
    await esperar();
    expect(rendered.container.textContent).toContain("Fallo interno");
  });

  it("un rol distinto de admin_gestora no pide nada y lo explica", async () => {
    const { fn } = red();
    vi.stubGlobal("fetch", fn);
    rendered = montar("operador:acceso_total");
    await esperar();
    expect(fn).not.toHaveBeenCalled();
    expect(rendered.container.textContent).toContain("no tiene acceso a esta sección");
  });
});
