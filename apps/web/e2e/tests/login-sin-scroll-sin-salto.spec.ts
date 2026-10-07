// Login sin scroll y sin saltos (orden de Javier, 3-oct): (1) toda pantalla de acceso cabe en la ventana sin scroll
// vertical en 6 tamanos, en claro y oscuro; (2) pasar de reposo -> enviando -> enviado -> error -> reenviar no mueve
// NI UN pixel (tolerancia 1 px) ninguna pieza de la pagina ni agrega scroll, y el CLS medido por el navegador es 0.
// La API es la simulada de e2e/mock-api (NUNCA la real); el POST del magic link se intercepta por prueba para
// controlar la latencia y el resultado.
import type { Page } from "@playwright/test";
import { VERTICALES } from "../mock-api/personas.ts";
import { expect, test } from "../helpers/fixtures.ts";

const VIEWPORTS = [
  { nombre: "1366x768", width: 1366, height: 768 },
  { nombre: "1280x720", width: 1280, height: 720 },
  { nombre: "1440x900", width: 1440, height: 900 },
  { nombre: "iPhone SE 375x667", width: 375, height: 667 },
  { nombre: "iPhone 14 390x844", width: 390, height: 844 },
  { nombre: "Android 360x740", width: 360, height: 740 },
] as const;
const TEMAS = ["light", "dark"] as const;

// Las pruebas fijan su propio viewport y tema: basta un proyecto (los 4 de la matriz solo las repetirian).
// eslint-disable-next-line no-empty-pattern -- Playwright exige la forma desestructurada aunque no se use ninguna fixture
test.beforeEach(({}, info) => {
  test.skip(info.project.name !== "escritorio-claro", "fija viewport y tema por prueba; corre una sola vez");
});

async function abrir(page: Page, ruta: string, tema: (typeof TEMAS)[number], viewport: { width: number; height: number }) {
  await page.setViewportSize(viewport);
  await page.emulateMedia({ colorScheme: tema });
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem("atiende-tema", "sistema");
    } catch {
      // sin localStorage el tema sigue al sistema igual
    }
    const w = window as unknown as { __cls: number };
    w.__cls = 0;
    new PerformanceObserver((lista) => {
      for (const e of lista.getEntries() as unknown as Array<{ value: number; hadRecentInput: boolean }>) if (!e.hadRecentInput) w.__cls += e.value;
    }).observe({ type: "layout-shift", buffered: true });
  });
  await page.goto(ruta);
  await expect(page.locator("main")).toHaveCount(1);
  // R-37: la pantalla es un chunk perezoso; se espera a que no haya cargas en vuelo (chunk, estilos, fuentes) antes de medir.
  // Las tipografias vienen de Google Fonts (login.css las importa): el CSS y luego cada archivo llegan DESPUES de que
  // `document.fonts.ready` ya resolvio (aun no habia caras registradas), y su cambio (swap) mueve el texto ~1 px y suma
  // CLS en mitad de la prueba. Se espera a que la red quede en reposo (sin Google Fonts accesible, las peticiones
  // fallan rapido y el reposo llega igual) y solo entonces a `fonts.ready`.
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => document.fonts.ready);
  // La carga de tipografias puede mover el texto UNA vez al abrir; el CLS que se exige es el de los cambios de estado.
  await page.evaluate(() => ((window as unknown as { __cls: number }).__cls = 0));
}

async function altoPagina(page: Page) {
  return page.evaluate(() => ({ contenido: document.scrollingElement!.scrollHeight, ventana: window.innerHeight, ancho: document.scrollingElement!.scrollWidth, anchoVentana: window.innerWidth }));
}

const PIEZAS = ["h1", "form", "form button[type=submit]", "form input[type=email]", ".login-estado", ".login-legales", ".login-pie"] as const;

async function cajas(page: Page) {
  const out: Record<string, { x: number; y: number; width: number; height: number } | null> = {};
  for (const sel of PIEZAS) out[sel] = await page.locator(sel).first().boundingBox();
  return out;
}

async function afirmarMismoLugar(page: Page, base: Awaited<ReturnType<typeof cajas>>, estado: string) {
  const ahora = await cajas(page);
  for (const sel of PIEZAS) {
    const a = base[sel];
    const b = ahora[sel];
    expect(a, `${sel} no existe en reposo`).not.toBeNull();
    expect(b, `${sel} desaparecio en ${estado}`).not.toBeNull();
    for (const k of ["x", "y", "width", "height"] as const) {
      expect(Math.abs(b![k] - a![k]), `${sel}.${k} se movio en "${estado}" (${a![k]} -> ${b![k]})`).toBeLessThanOrEqual(1);
    }
  }
  const { contenido, ventana } = await altoPagina(page);
  expect(contenido, `scroll vertical en "${estado}"`).toBeLessThanOrEqual(ventana);
  const cls = await page.evaluate(() => (window as unknown as { __cls: number }).__cls);
  expect(cls, `CLS acumulado en "${estado}"`).toBe(0);
}

test.describe("login sin scroll @humo", () => {
  for (const v of VIEWPORTS) {
    for (const tema of TEMAS) {
      test(`login de las 6 verticales, selector y portal de propietario caben sin scroll en ${v.nombre} (${tema})`, async ({ page }) => {
        const rutas = [...VERTICALES.map((x) => `/${x}/login`), "/", "/rentas/portal-propietario/login"];
        for (const ruta of rutas) {
          await abrir(page, ruta, tema, v);
          const { contenido, ventana, ancho, anchoVentana } = await altoPagina(page);
          expect(contenido, `${ruta}: scrollHeight ${contenido} > innerHeight ${ventana} en ${v.nombre}`).toBeLessThanOrEqual(ventana);
          expect(ancho, `${ruta}: scrollWidth ${ancho} > innerWidth ${anchoVentana}`).toBeLessThanOrEqual(anchoVentana);
        }
      });
    }
  }
});

test.describe("login sin saltos @humo", () => {
  for (const v of VIEWPORTS) {
    for (const tema of TEMAS) {
      test(`reposo, enviando, enviado, error y reenviar no mueven la pagina en ${v.nombre} (${tema})`, async ({ page }) => {
        let modo: "ok" | "falla" = "ok";
        await page.route("**/auth/magic-link/iniciar", async (ruta) => {
          if (ruta.request().method() === "OPTIONS") return ruta.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "POST, OPTIONS" } });
          await new Promise((r) => setTimeout(r, 400)); // ventana para medir el estado "enviando"
          return ruta.fulfill({ status: modo === "ok" ? 200 : 429, headers: { "access-control-allow-origin": "*", "content-type": "application/json" }, body: JSON.stringify({ ok: modo === "ok" }) });
        });
        await abrir(page, "/citas/login", tema, v);
        const base = await cajas(page);
        const campo = page.getByRole("textbox", { name: /correo/i });
        // Se envia con Enter en el campo: pasar el mouse sobre el boton despliega el glifo de Likida (gesto de hover,
        // movimiento intencional dentro del boton) y eso no es un salto del layout que se quiere medir.
        const enviar = async () => {
          await campo.focus();
          await page.keyboard.press("Enter");
        };

        // Error de correo (cliente).
        await campo.fill("no-es-un-correo");
        await enviar();
        await expect(page.getByRole("alert")).toContainText("correo válido");
        await afirmarMismoLugar(page, base, "error de correo");

        // Enviando.
        await campo.fill("una.persona.con.un.correo.bastante.largo@un-dominio-muy-largo-de-prueba.example.com");
        await enviar();
        await expect(page.getByRole("button", { name: "Enviando…" })).toBeVisible();
        await afirmarMismoLugar(page, base, "enviando");

        // Enviado.
        await expect(page.getByRole("status")).toContainText("Te mandamos un enlace");
        await afirmarMismoLugar(page, base, "enviado");

        // Correo mal escrito DESPUES de un envio exitoso: el error reemplaza al aviso y es visible (un solo mensaje).
        await campo.fill("me-equivoque");
        await enviar();
        await expect(page.getByRole("alert")).toContainText("correo válido");
        await expect(page.getByRole("status")).toHaveCount(0);
        await afirmarMismoLugar(page, base, "correo invalido tras enviado");

        // Error del servidor.
        modo = "falla";
        await campo.fill("una.persona@un-dominio.example.com");
        await enviar();
        await expect(page.getByRole("alert")).toContainText("429");
        await afirmarMismoLugar(page, base, "error del servidor");

        // Reenviar con exito.
        modo = "ok";
        await enviar();
        await expect(page.getByRole("status")).toContainText("Te mandamos un enlace");
        await afirmarMismoLugar(page, base, "reenviado");
      });
    }
  }

  test("el foco se queda donde estaba: enviar no manda al usuario a otro sitio ni mueve el scroll", async ({ page }) => {
    await page.route("**/auth/magic-link/iniciar", (ruta) =>
      ruta.request().method() === "OPTIONS"
        ? ruta.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*" } })
        : ruta.fulfill({ status: 200, headers: { "access-control-allow-origin": "*", "content-type": "application/json" }, body: "{}" }),
    );
    await abrir(page, "/citas/login", "light", { width: 375, height: 667 });
    await page.getByRole("textbox", { name: /correo/i }).fill("a@b.com");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("status")).toBeVisible();
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    await expect(page.getByRole("textbox", { name: /correo/i })).toBeFocused();
  });

  test("¿Olvidaste tu contraseña?: el aviso de enviado y el error no mueven el formulario", async ({ page }) => {
    await page.route("**/auth/password-reset/solicitar", (ruta) =>
      ruta.request().method() === "OPTIONS"
        ? ruta.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*" } })
        : ruta.fulfill({ status: 200, headers: { "access-control-allow-origin": "*", "content-type": "application/json" }, body: JSON.stringify({ ok: true }) }),
    );
    await abrir(page, "/citas/login", "light", { width: 375, height: 667 });
    await page.getByRole("button", { name: "¿Olvidaste tu contraseña?" }).click();
    const piezas = ["form", "form button[type=submit]", ".login-estado"] as const;
    const antes = await Promise.all(piezas.map((s) => page.locator(s).first().boundingBox()));
    expect((await altoPagina(page)).contenido, "la vista de restablecer contrasena hace scroll").toBeLessThanOrEqual((await altoPagina(page)).ventana);
    await page.getByRole("textbox", { name: /correo/i }).fill("no-es-correo");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("alert")).toContainText("correo válido");
    await page.getByRole("textbox", { name: /correo/i }).fill("dueno@negocio.com");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("status")).toContainText("Revisa tu correo");
    const despues = await Promise.all(piezas.map((s) => page.locator(s).first().boundingBox()));
    piezas.forEach((s, i) => {
      for (const k of ["x", "y", "width", "height"] as const) expect(Math.abs(despues[i]![k] - antes[i]![k]), `${s}.${k}`).toBeLessThanOrEqual(1);
    });
    const { contenido, ventana } = await altoPagina(page);
    expect(contenido).toBeLessThanOrEqual(ventana);
  });
});

// Carga con tipografias LENTAS (1.2 s por archivo de fuente, propias y de Google): el usuario no debe ver ningun salto
// al abrir el login aunque la fuente llegue tarde (fuentes propias precargadas + caras de respaldo con las metricas de
// la fuente real, ver pages/login.css). Medido sin reiniciar el CLS: se mide la CARGA completa.
const MOVILES = VIEWPORTS.filter((v) => v.nombre.startsWith("iPhone SE") || v.nombre.startsWith("Android"));
test.describe("login: carga con fuentes lentas @humo", () => {
  for (const v of MOVILES) {
    test(`ningun desplazamiento visible al cargar el login con las fuentes retrasadas 1.2 s en ${v.nombre}`, async ({ page }) => {
      await page.setViewportSize(v);
      await page.route(/\/fonts\/.*\.woff2|fonts\.(googleapis|gstatic)\.com/, async (ruta) => {
        await new Promise((r) => setTimeout(r, 1200));
        await ruta.continue();
      });
      await page.addInitScript(() => {
        const w = window as unknown as { __cls: number; __pie: number[] };
        w.__cls = 0;
        new PerformanceObserver((lista) => {
          for (const e of lista.getEntries() as unknown as Array<{ value: number; hadRecentInput: boolean }>) if (!e.hadRecentInput) w.__cls += e.value;
        }).observe({ type: "layout-shift", buffered: true });
      });
      await page.goto("/citas/login");
      await expect(page.locator("main")).toHaveCount(1);
      // Ya pinto con la fuente de respaldo: el pie (lo mas bajo de la pagina) no puede moverse cuando llegue la real.
      const pieAntes = await page.locator(".login-pie").first().boundingBox();
      await page.waitForLoadState("networkidle");
      await page.evaluate(() => document.fonts.ready);
      await expect.poll(() => page.evaluate(() => document.fonts.check("400 44px Fraunces")), { timeout: 10_000 }).toBe(true);
      const pieDespues = await page.locator(".login-pie").first().boundingBox();
      expect(Math.abs(pieDespues!.y - pieAntes!.y), "el pie bajo/subio al llegar la fuente real").toBeLessThanOrEqual(1);
      const cls = await page.evaluate(() => (window as unknown as { __cls: number }).__cls);
      expect(cls, "CLS de la carga con fuentes lentas").toBe(0);
    });
  }
});
