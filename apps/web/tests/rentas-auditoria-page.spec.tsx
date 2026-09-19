// @vitest-environment jsdom
//
// Smoke tests reales de <AuditoriaPage /> -- mismo patrón que
// rentas-owner-portal-dashboard-page.spec.tsx: `fetch` global mockeado contra
// auditoria-client.ts, `RentasShellContext` construido a mano.
//
// Cubre específicamente dos hallazgos de revisión r5 (Auditoria.tsx):
//  - no bloqueante #3: el botón "Reintentar" del estado de error debía volver a
//    disparar el fetch (antes solo limpiaba `error`, dejando el skeleton de carga
//    para siempre porque las deps del efecto no cambiaban).
//  - no bloqueante #2: la tabla no mostraba QUIÉN hizo cada acción, pese a que la
//    ruta ya devuelve `actorUserId` y el subtítulo promete "qué hizo cada miembro
//    del staff".
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuditoriaPage } from "../src/verticals/rentas/pages/Auditoria.tsx";
import type { AuditLogEntry } from "../src/verticals/rentas/lib/auditoria-client.ts";
import type { LoginSession } from "../src/lib/auth-client.ts";
import { changeValue, flushMicrotasks, renderComponent, click, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

async function esperarCarga(): Promise<void> {
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
  });
}

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, json: async () => body } as unknown as Response;
}

const SESSION: LoginSession = {
  token: "tok-123",
  refreshToken: "reftok",
  email: "staff@example.com",
  organizations: [{ id: "org-1", slug: "gestora-demo", nombre: "Gestora Demo", vertical: "rentas", rol: "admin_gestora" }],
};

const ENTRY: AuditLogEntry = {
  id: "audit-1",
  actorUserId: "00000000-0000-0000-0000-000000000011",
  action: "pricing.tarifa_base.actualizada",
  entityType: "pricing",
  entityId: "prop-1",
  campo: "precio_noche_centavos",
  antes: "150000",
  despues: "180000",
  creadoEn: "2026-09-01T12:00:00.000Z",
};

function renderPage(): RenderedComponent {
  return renderComponent(
    <AuditoriaPage
      apiBaseUrl="http://api.local"
      token="tok-123"
      propertyId="prop-1"
      setPropertyId={() => {}}
      properties={[]}
      orgSlug="gestora-demo"
      session={SESSION}
    />,
  );
}

describe("AuditoriaPage", () => {
  it("muestra el uuid del actor en su propia columna (la ruta ya lo trae, ver actorUserId)", async () => {
    fetchMock = vi.fn(async () => jsonResponse({ disponible: true, total: 1, nextOffset: null, items: [ENTRY] }));
    vi.stubGlobal("fetch", fetchMock);
    rendered = renderPage();
    await esperarCarga();

    expect(rendered.container.textContent).toContain("Quién");
    expect(rendered.container.textContent).toContain(ENTRY.actorUserId);
  });

  it("Reintentar tras un error vuelve a pedir los mismos filtros y sale del estado de error (antes se quedaba en carga infinita)", async () => {
    let llamadas = 0;
    fetchMock = vi.fn(async () => {
      llamadas += 1;
      if (llamadas === 1) throw new Error("network down");
      return jsonResponse({ disponible: true, total: 1, nextOffset: null, items: [ENTRY] });
    });
    vi.stubGlobal("fetch", fetchMock);
    rendered = renderPage();
    await esperarCarga();

    expect(rendered.container.textContent).toContain("network down");
    const boton = Array.from(rendered.container.querySelectorAll("button")).find((b) => b.textContent?.includes("Reintentar"));
    expect(boton).toBeDefined();

    click(boton!);
    await esperarCarga();

    expect(llamadas).toBe(2);
    expect(rendered.container.textContent).not.toContain("network down");
    expect(rendered.container.textContent).toContain(ENTRY.actorUserId);
  });

  it("cargar más descarta la página si los filtros cambiaron mientras estaba en vuelo (no anexa datos de un filtro viejo)", async () => {
    const ENTRY_PAGINA_2_VIEJA: AuditLogEntry = { ...ENTRY, id: "audit-vieja", despues: "DESPUES_VIEJO_NO_DEBE_APARECER" };
    const ENTRY_FILTRO_NUEVO: AuditLogEntry = { ...ENTRY, id: "audit-nuevo", despues: "DESPUES_FILTRO_NUEVO" };
    let resolverSegundaPagina: ((r: Response) => void) | undefined;
    fetchMock = vi.fn(async (url: string) => {
      const parsed = new URL(url);
      const offset = parsed.searchParams.get("offset");
      const tipo = parsed.searchParams.get("tipo");
      if (offset === "0" && !tipo) {
        return jsonResponse({ disponible: true, total: 2, nextOffset: 1, items: [ENTRY] });
      }
      if (offset === "1" && !tipo) {
        // Página 2 del filtro ORIGINAL (sin tipo) -- se resuelve DESPUÉS de que el
        // usuario ya cambió el filtro a "pricing".
        return new Promise<Response>((resolve) => {
          resolverSegundaPagina = resolve;
        });
      }
      if (offset === "0" && tipo === "pricing") {
        return jsonResponse({ disponible: true, total: 1, nextOffset: null, items: [ENTRY_FILTRO_NUEVO] });
      }
      throw new Error(`fetch inesperado en el test: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    rendered = renderPage();
    await esperarCarga();

    const cargarMasBtn = Array.from(rendered.container.querySelectorAll("button")).find((b) => b.textContent?.includes("Cargar más"));
    expect(cargarMasBtn).toBeDefined();
    click(cargarMasBtn!);
    await act(async () => {
      await flushMicrotasks();
    });

    // Cambia el filtro mientras la página 2 del filtro anterior sigue en vuelo.
    const select = rendered.container.querySelector("select") as HTMLSelectElement;
    changeValue(select, "pricing");
    await esperarCarga();

    expect(rendered.container.textContent).toContain("DESPUES_FILTRO_NUEVO");

    // Ahora resuelve la página vieja que seguía pendiente: NO debe anexarse a la
    // lista del filtro nuevo, aunque llegue después.
    await act(async () => {
      resolverSegundaPagina?.(jsonResponse({ disponible: true, total: 2, nextOffset: null, items: [ENTRY_PAGINA_2_VIEJA] }));
      await flushMicrotasks();
      await flushMicrotasks();
    });

    expect(rendered.container.textContent).not.toContain("DESPUES_VIEJO_NO_DEBE_APARECER");
    expect(rendered.container.textContent).toContain("DESPUES_FILTRO_NUEVO");
  });
});
