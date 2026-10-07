// @vitest-environment jsdom
//
// SA-L-01: el menu del superadmin sale de UN mapa de rutas plano (`superadmin/rutas.ts`) con el orden
// de Likida (Resumen arriba + Agentes, Negocio, Plataforma, Control, Sistema en acordeon). Estas pruebas
// fijan las reglas que el diff promete: orden de secciones, unicidad, solo paginas reales (ninguna ruta
// pendiente se pinta), redirecciones y que el sidebar renderizado ES el mapa (no una lista paralela).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { SuperAdminShell } from "../src/superadmin/SuperAdminShell.tsx";
import { COPILOTO, MOVIL_SUPERADMIN, PARTE_DIARIO, PENDIENTES, PIE_SUPERADMIN, REDIRECCIONES_SUPERADMIN, RESUMEN, RUTAS_SIN_MENU, SECCIONES, TODAS_LAS_RUTAS } from "../src/superadmin/rutas.ts";
import { click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";
import { installMatchMediaStub, installMemoryLocalStorage } from "./test-utils/memory-storage.ts";

vi.mock("../src/lib/useNotifications.ts", () => ({
  useNotifications: () => ({ items: [], unreadCount: 0, loading: false, refetch: () => {}, onMarkRead: () => {}, onMarkAllRead: () => {} }),
}));
vi.mock("../src/superadmin/components/ImpersonacionBanner.tsx", () => ({ ImpersonacionBanner: () => null }));

const aqui = dirname(fileURLToPath(import.meta.url));
const appSrc = readFileSync(join(aqui, "../src/App.tsx"), "utf8");
const SESSION = { token: "tok", refreshToken: "reftok", email: "root@example.com", fullName: "Ana Root" };

let rendered: RenderedComponent | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
});

async function renderShell(ruta: string, sesion: object = SESSION): Promise<RenderedComponent> {
  installMatchMediaStub();
  installMemoryLocalStorage().setItem("atiende.superadmin.session", JSON.stringify(sesion));
  const result = renderComponent(
    <MemoryRouter initialEntries={[ruta]}>
      <SuperAdminShell apiBaseUrl="https://api.test" onRequireLogin={() => {}}>
        {() => <div>child</div>}
      </SuperAdminShell>
    </MemoryRouter>,
  );
  await act(async () => {
    await flushMicrotasks();
  });
  return result;
}

describe("mapa de rutas del superadmin (rutas.ts)", () => {
  it("las secciones salen en el orden de Likida y no hay rotulos duplicados", () => {
    const orden = ["Agentes", "Negocio", "Plataforma", "Control", "Sistema"];
    const titulos = SECCIONES.map((s) => s.title);
    expect(titulos).toEqual(orden.filter((t) => titulos.includes(t)));
    expect(new Set(titulos).size).toBe(titulos.length);
  });

  it("una seccion sin paginas reales no se pinta; Agentes ya no tiene el Copiloto (CHAT-17 lo pone bajo Resumen): el Panel (SA-L-08), las tres fichas (SA-L-09) y Model Ops (SA-L-10)", () => {
    expect(SECCIONES.every((s) => s.items.length > 0)).toBe(true);
    const agentes = SECCIONES.find((s) => s.title === "Agentes");
    expect(agentes?.items.map((i) => i.to)).toEqual([
      "/superadmin/agentes",
      "/superadmin/agente-extractor",
      "/superadmin/agente-conciliacion",
      "/superadmin/agente-whatsapp",
      "/superadmin/model-ops",
    ]);
  });

  it("cada ruta es unica, cuelga de /superadmin y Resumen va primero con el Copiloto justo debajo", () => {
    const rutas = TODAS_LAS_RUTAS.map((r) => r.to);
    expect(rutas[0]).toBe(RESUMEN.to);
    expect(rutas[1]).toBe("/superadmin/copiloto");
    expect(COPILOTO.label).toBe("Copiloto");
    expect(new Set(rutas).size).toBe(rutas.length);
    expect(rutas.every((r) => r === "/superadmin" || r.startsWith("/superadmin/"))).toBe(true);
  });

  it("toda ruta del menu, del pie y de la barra movil tiene una <Route> real en App.tsx", () => {
    const todas = [...TODAS_LAS_RUTAS, ...MOVIL_SUPERADMIN, ...PIE_SUPERADMIN].map((r) => r.to);
    for (const ruta of new Set(todas)) expect(appSrc, ruta).toContain(`path="${ruta}"`);
  });

  it("ninguna ruta pendiente aparece en el menu, el pie ni la barra movil (sin entradas fantasma)", () => {
    const pintadas = new Set([...TODAS_LAS_RUTAS, ...MOVIL_SUPERADMIN, ...PIE_SUPERADMIN].map((r) => r.to));
    expect(PENDIENTES.length).toBeGreaterThan(0);
    for (const p of PENDIENTES) {
      expect(pintadas.has(p.ruta), p.ruta).toBe(false);
      expect(appSrc, p.ruta).not.toContain(`path="${p.ruta}"`);
      expect(p.ticket.length).toBeGreaterThan(0);
    }
    const rutasPendientes = PENDIENTES.map((p) => p.ruta);
    expect(new Set(rutasPendientes).size).toBe(rutasPendientes.length);
  });

  it("las rutas viejas que cambian de lugar redirigen a una ruta que existe", () => {
    for (const [desde, hacia] of Object.entries(REDIRECCIONES_SUPERADMIN)) {
      expect(desde).not.toBe(hacia);
      // La consulta (`?tab=gestion`) solo elige una pestana: la ruta destino es la de antes del `?`.
      expect(TODAS_LAS_RUTAS.map((r) => r.to)).toContain(hacia.split("?")[0]);
    }
    expect(REDIRECCIONES_SUPERADMIN["/superadmin/gestion-organizaciones"]).toBe("/superadmin/organizaciones?tab=gestion");
    // El listado de organizaciones ya no es la raiz: el Resumen lo es.
    expect(TODAS_LAS_RUTAS.map((r) => r.to)).toContain("/superadmin/organizaciones");
    expect(REDIRECCIONES_SUPERADMIN["/superadmin/resumen"]).toBe("/superadmin");
  });

  it("el parte diario vive en /superadmin/parte-diario con Route real y SIN item de menu, pie ni barra movil (UNI-RES-superadmin)", () => {
    expect(PARTE_DIARIO).toBe("/superadmin/parte-diario");
    expect(RUTAS_SIN_MENU).toContain(PARTE_DIARIO);
    for (const ruta of RUTAS_SIN_MENU) expect(appSrc, ruta).toContain(`path="${ruta}"`);
    const pintadas = new Set([...TODAS_LAS_RUTAS, ...MOVIL_SUPERADMIN, ...PIE_SUPERADMIN].map((r) => r.to));
    expect(pintadas.has(PARTE_DIARIO)).toBe(false);
    // La raiz es el Resumen de la consola; el parte diario ya no la ocupa.
    expect(appSrc).toContain("<SuperAdminConsolaResumenPage {...ctx} />");
  });

  it("nada de las 22 entradas del menu anterior se pierde: cada ruta vieja sigue en el mapa, en el pie o redirige", () => {
    const viejas = [
      "/superadmin/gestion-organizaciones", "/superadmin/interruptores", "/superadmin/seguridad", "/superadmin/salud", "/superadmin/acciones",
      "/superadmin/prospectos", "/superadmin/gasto-api", "/superadmin/zona-cfo", "/superadmin/privacidad", "/superadmin/cfo", "/superadmin/pyl",
      "/superadmin/costos-margen", "/superadmin/planes", "/superadmin/contratos", "/superadmin/facturacion", "/superadmin/break-glass",
      "/superadmin/impersonacion", "/superadmin/auditoria-denegaciones", "/superadmin/integraciones", "/superadmin/paneles", "/superadmin/resumen",
    ];
    const vivas = new Set([...TODAS_LAS_RUTAS.map((r) => r.to), ...PIE_SUPERADMIN.map((p) => p.to), ...Object.keys(REDIRECCIONES_SUPERADMIN)]);
    for (const v of viejas) expect(vivas.has(v), v).toBe(true);
  });
});

describe("sidebar del superadmin (SuperAdminShell)", () => {
  it("pinta Resumen arriba y SOLO las secciones del mapa, en orden, con una sola abierta (la de la ruta activa)", async () => {
    rendered = await renderShell("/superadmin/planes");
    const aside = rendered.container.querySelector('aside[aria-label="Navegación principal"]')!;
    const cabeceras = [...aside.querySelectorAll("button[aria-expanded]")].map((b) => b.textContent?.trim());
    expect(cabeceras).toEqual(SECCIONES.map((s) => s.title));
    const abiertas = [...aside.querySelectorAll('button[aria-expanded="true"]')].map((b) => b.textContent?.trim());
    expect(abiertas).toEqual(["Control"]);
    const enlaces = [...aside.querySelectorAll("nav a")].map((a) => a.getAttribute("href"));
    // Resumen y, justo debajo, el Copiloto (CHAT-17): primera seccion, siempre visibles.
    expect(enlaces.slice(0, 2)).toEqual(["/superadmin", "/superadmin/copiloto"]);
    const control = SECCIONES.find((s) => s.title === "Control")!;
    expect(enlaces.slice(2)).toEqual(control.items.map((i) => i.to));
  });

  it("el acordeon es exclusivo: abrir Sistema cierra Control", async () => {
    rendered = await renderShell("/superadmin/planes");
    const aside = rendered.container.querySelector('aside[aria-label="Navegación principal"]')!;
    const sistema = [...aside.querySelectorAll("button[aria-expanded]")].find((b) => b.textContent?.trim() === "Sistema")!;
    click(sistema);
    const abiertas = [...aside.querySelectorAll('button[aria-expanded="true"]')].map((b) => b.textContent?.trim());
    expect(abiertas).toEqual(["Sistema"]);
  });

  it("el pie lleva 'Costos de IA' y 'Ver los otros paneles' a paginas reales; el selector de paneles ya no es un item del menu", async () => {
    rendered = await renderShell("/superadmin");
    const aside = rendered.container.querySelector('aside[aria-label="Navegación principal"]')!;
    const pie = [...aside.querySelectorAll("a")].filter((a) => ["Costos de IA", "Ver los otros paneles"].includes(a.getAttribute("aria-label") ?? ""));
    expect(pie.map((a) => a.getAttribute("href"))).toEqual(["/superadmin/costos-facturacion", "/superadmin/paneles"]);
    const navHrefs = [...aside.querySelectorAll("nav a")].map((a) => a.getAttribute("href"));
    expect(navHrefs).not.toContain("/superadmin/paneles");
  });

  it("la tarjeta de usuario muestra el nombre (no el correo) y SUPERADMIN; sin nombre cae al correo", async () => {
    rendered = await renderShell("/superadmin");
    let aside = rendered.container.querySelector('aside[aria-label="Navegación principal"]')!;
    expect(aside.textContent).toContain("Ana Root");
    expect(aside.textContent).not.toContain("root@example.com");
    expect(aside.textContent?.toLowerCase()).toContain("superadmin");
    rendered.unmount();
    rendered = await renderShell("/superadmin", { token: "tok", refreshToken: "reftok", email: "root@example.com" });
    aside = rendered.container.querySelector('aside[aria-label="Navegación principal"]')!;
    expect(aside.textContent).toContain("root@example.com");
  });
});
