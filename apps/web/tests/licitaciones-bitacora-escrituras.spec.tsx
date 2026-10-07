// @vitest-environment jsdom
//
// L-P3-17 -- bitacora de ESCRITURAS de la organizacion (pagina de owner/admin): cliente (filtros -> query, antes/despues legibles) y pagina con
// carga, vacio, error con reintento, "no disponible aun" (038 pendiente), paginacion por llave, filtro por correlacion, traza de una
// convocatoria y el aviso para quien no es owner/admin (sin pedir nada al servidor). Solo lectura: ninguna llamada escribe.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { BitacoraPage } from "../src/verticals/licitaciones/pages/Bitacora.tsx";
import { accionLegible, cambiosDe } from "../src/verticals/licitaciones/lib/audit-trail-client.ts";
import type { AuditTrailEntry, AuditTrailPage } from "../src/verticals/licitaciones/lib/audit-trail-client.ts";
import type { LicitacionesShellContext } from "../src/verticals/licitaciones/LicitacionesShell.tsx";
import { changeValue, click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

const ctx = (role: string): LicitacionesShellContext => ({ apiBaseUrl: "https://api.test", token: "tok", propertyId: "prop-1", orgSlug: "demo", role, staffFullName: "Sam", staffEmail: "sam@example.com" }) as LicitacionesShellContext;
const FILA = (n: number, over: Partial<AuditTrailEntry> = {}): AuditTrailEntry => ({
  id: `a${n}`, seq: String(100 - n), entity: "tarifa", entityId: "r1", action: "tarifa.editado", before: { unitPrice: "10.00" }, after: { unitPrice: "12.00" }, actorId: "u1", correlationId: `c-${n}`, createdAt: "2026-10-03T16:00:00.000Z", ...over,
});
const PAGINA = (items: AuditTrailEntry[], over: Partial<AuditTrailPage> = {}): AuditTrailPage => ({ items, nextCursor: null, available: true, entities: ["tarifa", "convocatoria"], people: { u1: "Ana Pérez" }, ...over });

function stub(responder: (url: URL) => { ok?: boolean; status?: number; body: unknown }) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    expect(init?.method ?? "GET").toBe("GET"); // solo lectura
    const u = new URL(url);
    if (u.pathname.endsWith("/admin/staff/miembros")) return { ok: true, status: 200, json: async () => ({ miembros: [{ id: "u1", email: "ana@example.com", fullName: "Ana Pérez", verticalRole: "admin", propertyIds: null }] }) } as unknown as Response;
    const r = responder(u);
    return { ok: r.ok ?? true, status: r.status ?? (r.ok === false ? 503 : 200), json: async () => r.body } as unknown as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
}
async function settle() {
  await act(async () => {
    for (let i = 0; i < 8; i++) await flushMicrotasks();
  });
}
function mount(role = "owner", entry = "/licitaciones/demo/bitacora") {
  rendered = renderComponent(
    <MemoryRouter initialEntries={[entry]}>
      <BitacoraPage {...ctx(role)} />
    </MemoryRouter>,
  );
}
const text = () => rendered!.container.textContent ?? "";
const btn = (label: string) => [...rendered!.container.querySelectorAll("button")].find((b) => b.textContent?.trim() === label) as HTMLButtonElement | undefined;
const llamadasAuditoria = () => fetchMock.mock.calls.map((c) => new URL(String(c[0]))).filter((u) => u.pathname.includes("/audit-trail"));

describe("cliente de la bitacora", () => {
  it("cambiosDe muestra solo los campos que cambiaron (un alta trae antes '—') y accionLegible no inventa nada", () => {
    expect(cambiosDe({ a: "1", b: "x" }, { a: "2", b: "x", c: ["p", "q"] })).toEqual([
      { campo: "a", antes: "1", despues: "2" },
      { campo: "c", antes: "—", despues: "p, q" },
    ]);
    expect(cambiosDe(null, { concept: "x" })).toEqual([{ campo: "concept", antes: "—", despues: "x" }]);
    expect(cambiosDe({ a: 1 }, { a: 1 })).toEqual([]);
    expect(accionLegible("tarifa", "tarifa.editado")).toBe("Tarifa · editado");
    expect(accionLegible("rara", "rara.accion_nueva")).toBe("rara · accion_nueva");
  });
});

describe("BitacoraPage", () => {
  it("lista renglones con antes → después, quién (nombre real, o 'Sistema' sin actor) y la correlación", async () => {
    stub(() => ({ body: PAGINA([FILA(1), FILA(2, { actorId: null, action: "convocatoria.ingerida", entity: "convocatoria", before: null, after: { source: "compranet" } })]) }));
    mount();
    await settle();
    expect(text()).toContain("Tarifa · editado");
    expect(text()).toContain("unitPrice");
    expect(text()).toContain("10.00");
    expect(text()).toContain("12.00");
    expect(text()).toContain("Ana Pérez");
    expect(text()).toContain("Sistema (ingesta automática)");
    expect(text()).toContain("Convocatoria · ingerida por la ingesta automática");
    expect(text()).toContain("c-1");
    expect(text()).toContain("3 oct 2026");
  });

  it("vacío honesto y 'no disponible aún' cuando falta la migración 038 (nunca finge 'sin cambios')", async () => {
    stub(() => ({ body: PAGINA([]) }));
    mount();
    await settle();
    expect(text()).toContain("Todavía no hay cambios registrados.");
    rendered!.unmount();
    stub(() => ({ body: PAGINA([], { available: false }) }));
    mount();
    await settle();
    expect(text()).toContain("No disponible aún");
    expect(text()).toContain("migración 038");
    expect(text()).not.toContain("Todavía no hay cambios registrados.");
  });

  it("error del servidor: aviso con reintento que vuelve a pedir y se recupera", async () => {
    let n = 0;
    stub(() => (++n === 1 ? { ok: false, body: { message: "boom" } } : { body: PAGINA([FILA(1)]) }));
    mount();
    await settle();
    expect(text()).toContain("Reintentar");
    click(btn("Reintentar")!);
    await settle();
    expect(text()).toContain("Tarifa · editado");
  });

  it("paginación por llave: 'Cargar más' pide con el cursor y agrega sin repetir", async () => {
    stub((u) => (u.searchParams.get("cursor") ? { body: PAGINA([FILA(3)]) } : { body: PAGINA([FILA(1), FILA(2)], { nextCursor: "98" }) }));
    mount();
    await settle();
    expect(text()).toContain("c-1");
    expect(text()).not.toContain("c-3");
    click(btn("Cargar más")!);
    await settle();
    expect(llamadasAuditoria().at(-1)!.searchParams.get("cursor")).toBe("98");
    expect(text()).toContain("c-1");
    expect(text()).toContain("c-3");
    expect(btn("Cargar más")).toBeUndefined();
  });

  it("filtro por entidad y por correlación viajan al servidor; una correlación en la tabla filtra al hacer clic", async () => {
    stub(() => ({ body: PAGINA([FILA(1)]) }));
    mount();
    await settle();
    changeValue(rendered!.container.querySelector("#bit-entidad") as HTMLSelectElement, "tarifa");
    await settle();
    expect(llamadasAuditoria().at(-1)!.searchParams.get("entity")).toBe("tarifa");
    click(rendered!.container.querySelector('button[title^="Ver toda la traza"]') as HTMLButtonElement);
    await settle();
    expect(llamadasAuditoria().at(-1)!.searchParams.get("correlationId")).toBe("c-1");
    expect((rendered!.container.querySelector("#bit-correlacion") as HTMLInputElement).value).toBe("c-1");
  });

  it("traza de una convocatoria (?convocatoria=): pide /trace y no ofrece filtros ni 'Cargar más'", async () => {
    stub(() => ({ body: { items: [FILA(1, { entity: "convocatoria", action: "convocatoria.ingerida", actorId: null })], nextCursor: null, available: true, people: {} } }));
    mount("admin", "/licitaciones/demo/bitacora?convocatoria=tnd-1");
    await settle();
    expect(llamadasAuditoria().at(-1)!.pathname).toBe("/licitaciones/prop-1/audit-trail/tenders/tnd-1/trace");
    expect(text()).toContain("Traza de la convocatoria");
    expect(text()).toContain("Volver a la convocatoria");
    expect(rendered!.container.querySelector("#bit-entidad")).toBeNull();
  });

  it("quien no es owner/admin ve el aviso y la pantalla NO pide la bitácora", async () => {
    stub(() => ({ body: PAGINA([]) }));
    for (const role of ["analyst", "writer", "viewer"]) {
      mount(role);
      await settle();
      expect(text()).toContain("Solo el owner o un admin de la organización puede ver la bitácora de cambios.");
      rendered!.unmount();
    }
    expect(fetchMock.mock.calls).toHaveLength(0);
  });
});
