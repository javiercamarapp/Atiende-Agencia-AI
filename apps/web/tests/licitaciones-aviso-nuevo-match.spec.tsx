// @vitest-environment jsdom
//
// Umbral del aviso de nuevo match (paridad3 L-P3-09), dentro de Staff: lee tenant-config UNA vez, guarda con PATCH, valida en el
// cliente SIN llamar a la API, muestra el motivo del servidor (403/503) y solo owner/admin ve la tarjeta.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StaffPage } from "../src/verticals/licitaciones/pages/Staff.tsx";
import { parsearUmbral } from "../src/verticals/licitaciones/components/AvisoNuevoMatch.tsx";
import { fetchTenantConfig, updateTenantConfigNewMatchMinScore } from "../src/verticals/licitaciones/lib/admin-client.ts";
import type { LicitacionesShellContext } from "../src/verticals/licitaciones/LicitacionesShell.tsx";
import { flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

const CTX: LicitacionesShellContext = { apiBaseUrl: "https://api.test", token: "tok", propertyId: "prop-1", orgSlug: "demo", role: "owner", staffFullName: "Ana", staffEmail: "ana@example.com" };
const TC = "/v1/licitaciones/demo/admin/tenant-config";

interface Llamada {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

/** API simulada por ruta real: tenant-config con estado (lo que se guarda se lee), el resto de Staff vacio. */
function stubApi(opts: { umbral?: number | null; patch?: (body: Record<string, unknown>) => { status: number; body: unknown }; getFalla?: boolean } = {}) {
  let umbral = opts.umbral ?? null;
  const llamadas: Llamada[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = url.replace("https://api.test", "");
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      llamadas.push({ method, path, body });
      const respuesta = (status: number, data: unknown) => ({ ok: status < 400, status, json: async () => data }) as unknown as Response;
      if (path === TC && method === "GET") return opts.getFalla ? respuesta(500, { message: "caido" }) : respuesta(200, { tenant_config: { organization_id: "org-1", timezone: null, new_match_min_score: umbral } });
      if (path === TC && method === "PATCH") {
        if (opts.patch) {
          const r = opts.patch(body);
          if (r.status < 400 && "new_match_min_score" in body) umbral = body.new_match_min_score as number | null;
          return respuesta(r.status, r.body);
        }
        if ("new_match_min_score" in body) umbral = body.new_match_min_score as number | null;
        return respuesta(200, { tenant_config: { organization_id: "org-1", timezone: null, new_match_min_score: umbral } });
      }
      return respuesta(200, { invites: [], members: [] });
    }),
  );
  return { llamadas };
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 8; i++) await flushMicrotasks();
  });
}
const campo = () => rendered!.container.querySelector<HTMLInputElement>("#tenant-new-match-min-score");
const texto = () => rendered!.container.textContent ?? "";
const botonGuardarUmbral = () => campo()!.closest("form")!.querySelector<HTMLButtonElement>("button[type=submit]")!;

async function escribir(valor: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(campo(), valor);
    campo()!.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function enviar() {
  await act(async () => {
    botonGuardarUmbral().form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await settle();
}

describe("parsearUmbral", () => {
  it("vacio = null (solo elegibles); enteros de 0 a 100; todo lo demas se rechaza con el motivo", () => {
    expect(parsearUmbral("")).toBeNull();
    expect(parsearUmbral("  ")).toBeNull();
    expect(parsearUmbral("0")).toBe(0);
    expect(parsearUmbral(" 70 ")).toBe(70);
    expect(parsearUmbral("100")).toBe(100);
    for (const malo of ["101", "-1", "7.5", "abc", "1e2", "70%", "999"]) expect(() => parsearUmbral(malo), malo).toThrow();
  });
});

describe("cliente admin: umbral en tenant-config", () => {
  it("lee new_match_min_score (y null si una API anterior no lo manda) y lo escribe con PATCH", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => ({ ok: true, status: 200, json: async () => ({ tenant_config: { organization_id: "o", timezone: "America/Tijuana", ...(init?.method === "PATCH" ? { new_match_min_score: 55 } : {}) } }) }) as unknown as Response);
    expect(await fetchTenantConfig(fetchMock as unknown as typeof fetch, "https://api.test", "t", "demo")).toEqual({ organizationId: "o", timezone: "America/Tijuana", newMatchMinScore: null });
    expect((await updateTenantConfigNewMatchMinScore(fetchMock as unknown as typeof fetch, "https://api.test", "t", "demo", 55)).newMatchMinScore).toBe(55);
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1]!.body))).toEqual({ new_match_min_score: 55 });
  });
});

describe("Staff: aviso de convocatorias nuevas con match", () => {
  it("muestra el umbral guardado, lo cambia, y lo que se guarda es lo que se vuelve a mostrar; una sola lectura de tenant-config", async () => {
    const api = stubApi({ umbral: 65 });
    rendered = renderComponent(<StaffPage {...CTX} />);
    await settle();
    expect(campo()!.value).toBe("65");
    expect(texto()).toContain("Umbral guardado: 65.");
    expect(api.llamadas.filter((l) => l.path === TC && l.method === "GET")).toHaveLength(1);

    await escribir("80");
    await enviar();
    expect(api.llamadas.filter((l) => l.method === "PATCH")).toEqual([{ method: "PATCH", path: TC, body: { new_match_min_score: 80 } }]);
    expect(campo()!.value).toBe("80");
    expect(texto()).toContain("Umbral guardado: 80.");
    expect(texto()).toContain("Guardado.");
  });

  it("vacio y guardar manda null (solo elegibles)", async () => {
    const api = stubApi({ umbral: 40 });
    rendered = renderComponent(<StaffPage {...CTX} />);
    await settle();
    await escribir("");
    await enviar();
    expect(api.llamadas.find((l) => l.method === "PATCH")!.body).toEqual({ new_match_min_score: null });
    expect(texto()).toContain("Sin umbral: solo se avisan las convocatorias elegibles.");
  });

  it("un valor invalido NO llama a la API y dice por que", async () => {
    const api = stubApi();
    rendered = renderComponent(<StaffPage {...CTX} />);
    await settle();
    await escribir("150");
    await enviar();
    expect(api.llamadas.some((l) => l.method === "PATCH")).toBe(false);
    expect(rendered.container.querySelector("[role=alert]")!.textContent).toContain("entre 0 y 100");
  });

  it("si el servidor rechaza (403) o la base no esta migrada (503) muestra el motivo y conserva lo guardado", async () => {
    stubApi({ umbral: 30, patch: () => ({ status: 503, body: { message: "El umbral requiere la migracion 039." } }) });
    rendered = renderComponent(<StaffPage {...CTX} />);
    await settle();
    await escribir("90");
    await enviar();
    expect(rendered.container.querySelector("[role=alert]")!.textContent).toContain("migracion 039");
    expect(texto()).toContain("Umbral guardado: 30.");
    expect(texto()).not.toContain("Guardado.");
  });

  it("si la lectura falla no se pinta un formulario con un valor inventado", async () => {
    stubApi({ getFalla: true });
    rendered = renderComponent(<StaffPage {...CTX} />);
    await settle();
    expect(campo()).toBeNull();
    expect(texto()).toContain("No se pudo leer la configuración de la empresa");
  });

  it("solo owner/admin ve la tarjeta: un analista no la ve ni lee tenant-config", async () => {
    const api = stubApi();
    rendered = renderComponent(<StaffPage {...CTX} role="analyst" />);
    await settle();
    expect(campo()).toBeNull();
    expect(texto()).not.toContain("convocatorias nuevas con match");
    expect(api.llamadas.some((l) => l.path === TC)).toBe(false);
  });
});
