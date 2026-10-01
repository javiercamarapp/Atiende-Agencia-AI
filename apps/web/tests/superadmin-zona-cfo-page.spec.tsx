// @vitest-environment jsdom
//
// Smoke tests reales de <SuperAdminZonaCfoPage />: estado por rol, bitacora, asignacion del rol finanzas y
// base sin migrar. Mismo patron que superadmin-planes-page.spec.tsx.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SuperAdminZonaCfoPage } from "../src/superadmin/pages/ZonaCfo.tsx";
import type { EntradaBitacora, EstadoZona } from "../src/superadmin/pages/ZonaCfo.tsx";
import { changeValue, flushMicrotasks, renderComponent, submitForm, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

async function esperar(): Promise<void> {
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();
  });
}

const json = (body: unknown, ok = true): Response => ({ ok, status: ok ? 200 : 400, json: async () => body }) as unknown as Response;

const entrada = (parche: Partial<EntradaBitacora> = {}): EntradaBitacora => ({
  seq: 7, actorUserId: "abcdef12-0000-4000-8000-000000000001", actorRol: "finanzas", accion: "exportacion", recurso: "pyl/export.csv",
  filtros: { mes: "2026-09", nivel: "cliente", _ruta: "/superadmin/pyl/export.csv" }, ocurrioEnMs: Date.now(), ...parche,
});

function api(estado: EstadoZona, extra: Record<string, unknown> = {}) {
  const llamadas: Array<{ url: string; init?: RequestInit }> = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    llamadas.push({ url, init });
    if (url.endsWith("/superadmin/zona-cfo/estado")) return json(estado);
    if (url.includes("/superadmin/zona-cfo/bitacora")) return json({ disponible: true, entradas: [entrada()], siguienteAntesDeSeq: null, ...extra });
    if (url.endsWith("/superadmin/zona-cfo/roles")) return json({ disponible: true, roles: [] });
    if (url.includes("/superadmin/zona-cfo/roles/")) return json({ ok: true });
    throw new Error(`ruta inesperada ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return llamadas;
}

const pagina = () => renderComponent(<SuperAdminZonaCfoPage apiBaseUrl="https://api.test" token="tok" />);

describe("SuperAdminZonaCfoPage", () => {
  it("superadmin completo: muestra su acceso, la bitacora (quien, accion, recurso, filtros sin la ruta) y el formulario del rol", async () => {
    api({ disponible: true, rol: "superadmin", soloLectura: false, mfaObligatoria: false });
    rendered = pagina();
    expect(rendered.container.textContent).toContain("Cargando zona CFO");
    await esperar();
    const t = rendered.container.textContent ?? "";
    expect(t).toContain("Zona CFO segura");
    expect(t).toContain("Superadmin");
    expect(t).toContain("Bitácora de consultas financieras");
    expect(t).toContain("pyl/export.csv");
    expect(t).toContain("Exportación");
    expect(t).toContain("mes=2026-09 · nivel=cliente");
    expect(t).not.toContain("_ruta");
    expect(rendered.container.querySelector('form[aria-label="Asignar rol finanzas"]')).not.toBeNull();
  });

  it("rol finanzas: solo lectura, MFA obligatoria y NO pide ni muestra bitacora ni gestion de roles", async () => {
    const llamadas = api({ disponible: true, rol: "finanzas", soloLectura: true, mfaObligatoria: true });
    rendered = pagina();
    await esperar();
    const t = rendered.container.textContent ?? "";
    expect(t).toContain("Finanzas (solo lectura)");
    expect(t).toContain("MFA obligatoria");
    expect(t).not.toContain("Bitácora de consultas financieras");
    expect(rendered.container.querySelector("form")).toBeNull();
    expect(llamadas.map((l) => l.url).filter((u) => u.includes("bitacora") || u.includes("/roles"))).toEqual([]);
  });

  it("base sin migrar: lo dice y no inventa roles ni bitacora", async () => {
    api({ disponible: false, rol: null, soloLectura: false, mfaObligatoria: false, mensaje: "falta aplicar la migración 0034_superadmin_zona_cfo" });
    rendered = pagina();
    await esperar();
    const t = rendered.container.textContent ?? "";
    expect(t).toContain("0034_superadmin_zona_cfo");
    expect(t).not.toContain("Bitácora de consultas financieras");
  });

  it("asignar: valida el motivo en el cliente y luego manda PUT con rol y motivo", async () => {
    const llamadas = api({ disponible: true, rol: "superadmin", soloLectura: false, mfaObligatoria: false });
    rendered = pagina();
    await esperar();
    const form = rendered.container.querySelector('form[aria-label="Asignar rol finanzas"]') as HTMLFormElement;
    changeValue(form.querySelector("#zona-usuario") as HTMLInputElement, "00000000-0000-4000-8000-0000000000aa");
    changeValue(form.querySelector("#zona-motivo") as HTMLTextAreaElement, "corto");
    await submitForm(form);
    await esperar();
    expect(rendered.container.textContent).toContain("al menos 20 caracteres");
    expect(llamadas.some((l) => l.init?.method === "PUT")).toBe(false);

    changeValue(form.querySelector("#zona-motivo") as HTMLTextAreaElement, "Rol de solo lectura para la contadora externa del trimestre.");
    await submitForm(form);
    await esperar();
    const put = llamadas.find((l) => l.init?.method === "PUT");
    expect(put?.url).toBe("https://api.test/superadmin/zona-cfo/roles/00000000-0000-4000-8000-0000000000aa");
    expect(JSON.parse(String(put?.init?.body))).toEqual({ rol: "finanzas", motivo: "Rol de solo lectura para la contadora externa del trimestre." });
  });

  it("error de carga: estado de error con reintento, nunca se queda en 'Cargando'", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("red"); }));
    rendered = pagina();
    await esperar();
    expect(rendered.container.textContent).toContain("No se pudo cargar el estado de la zona CFO");
  });
});
