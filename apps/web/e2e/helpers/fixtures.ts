// Fixtures de Playwright compartidas: API simulada aislada por prueba, vigilante de consola/red, tema y login.
import { expect, test as base } from "@playwright/test";
import type { Page, TestInfo } from "@playwright/test";
import { ClienteMock } from "../mock-api/cliente.ts";
import { personaDe, SUPERADMIN } from "../mock-api/personas.ts";
import type { Rol, Vertical } from "../mock-api/tipos.ts";
import { barraMovil, sidebar } from "./navegacion.ts";
import { VigilanteConsola } from "./vigilante.ts";

export const URL_API = `http://127.0.0.1:${process.env.E2E_API_PORT ?? "8788"}`;

export type ObjetivoLogin = Vertical | "superadmin";

interface Fixtures {
  /** Cliente de control del mock con un escenario propio (estado, fallas y registro aislados de otras pruebas). */
  mock: ClienteMock;
  /** Consola y red vigiladas; la prueba llama `await vigilante.verificar()` al final de los recorridos. */
  vigilante: VigilanteConsola & { verificar(): void };
  /** Inicia sesion como `rol` en `vertical` por el mismo camino que la SPA (retorno de Google/magic link). */
  iniciarSesion: (objetivo: ObjetivoLogin, rol?: Rol) => Promise<string>;
}

function escenarioUnico(info: TestInfo): string {
  // Solo [a-z0-9]: el escenario viaja dentro de tokens separados por puntos y de codigos separados por "~".
  const azar = Math.random().toString(36).slice(2, 8);
  return `w${info.workerIndex}${info.testId.replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 12)}${azar}`;
}

export const test = base.extend<Fixtures>({
  // eslint-disable-next-line no-empty-pattern -- Playwright exige la forma desestructurada aunque no se use ninguna fixture
  mock: async ({}, use, info) => {
    const cliente = new ClienteMock(URL_API, escenarioUnico(info));
    await use(cliente);
    await cliente.reiniciar().catch(() => undefined);
  },

  // Tema: los proyectos "-oscuro" siguen al sistema (colorScheme dark); los claros usan el valor por defecto.
  page: async ({ page }, use, info) => {
    if (info.project.name.endsWith("oscuro")) {
      await page.addInitScript(() => {
        try {
          window.localStorage.setItem("atiende-tema", "sistema");
        } catch {
          // localStorage bloqueado: la prueba de tema lo reportara.
        }
      });
    }
    await use(page);
  },

  vigilante: async ({ page }, use, info) => {
    const v = new VigilanteConsola(page, URL_API) as VigilanteConsola & { verificar(): void };
    v.verificar = () => expect(v.resumen(), "consola/red con errores").toBe("");
    await use(v);
    // Cobertura pendiente de la API simulada: rutas que la pagina pidio y ninguna fixture atendio (informativo).
    const pendientes = [...new Set(v.sinFixture)].sort();
    if (pendientes.length > 0) await info.attach("sin-fixture", { body: pendientes.join("\n"), contentType: "text/plain" });
    // E2E_LISTAR_SIN_FIXTURE=1 los imprime en la consola (backlog de cobertura de la API simulada).
    if (process.env.E2E_LISTAR_SIN_FIXTURE === "1" && pendientes.length > 0) console.log(`[sin-fixture] ${info.title}\n  ${pendientes.join("\n  ")}`);
  },

  iniciarSesion: async ({ page, mock }, use) => {
    await use(async (objetivo, rol = "owner") => {
      const persona = objetivo === "superadmin" ? SUPERADMIN : personaDe(objetivo, rol);
      // Cualquier vertical valida sirve de puente para el superadmin: la SPA lo manda a /superadmin.
      const puente = objetivo === "superadmin" ? "restaurantes" : objetivo;
      await page.goto(`/${puente}/auth/google/callback?code=${encodeURIComponent(mock.codigoLogin(persona.id))}`);
      await page.waitForURL((url) => !url.pathname.includes("/auth/google/callback"), { timeout: 15_000 });
      // Hasta que el shell REAL pinto (menu lateral en escritorio, barra inferior en movil; sesion y sucursales ya cargadas): si no, una falla
      // inyectada justo despues del login podria consumirla la carga inicial en vez de la accion que la prueba quiere ejercitar (flake visto en CI)
      // y `seccionesDelPanel` leeria 0 enlaces. QA-restaurantes-R2-botones-09: antes bastaba con el primer <main> visible, que tambien es el de las
      // pantallas de paso (carga de sesion) anteriores al shell. El repartidor aterriza en /repartidor, que no es parte del shell y no tiene <main>
      // (BUG-E2E-REST-001): espera su encabezado.
      await sidebar(page).or(barraMovil(page)).or(page.getByRole("heading", { name: "Mis entregas" })).first().waitFor({ state: "visible", timeout: 15_000 });
      return new URL(page.url()).pathname;
    });
  },
});

export { expect };
export type { Page };
