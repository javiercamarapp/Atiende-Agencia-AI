// Carga, rendimiento y animacion del diseno ds3 (protocolo de verificacion, seccion 7.4): CLS y estabilidad del logo de carga,
// estabilidad del shell entre rutas, tiempo hasta contenido, fotogramas (rAF), propiedades de layout animadas, reduced-motion y
// destello de tema (FOUC). Mide siempre y adjunta el resultado; FALLA solo en modo estricto (E2E_DISENO=ds3 y sin DS3_INFORMATIVO),
// porque varias metricas (logo unico, shell estable, solo opacity/transform) son objetivos del diseno nuevo y hoy no se cumplen.
// Umbrales: E18-E24 (ver REDISENO, seccion 1). Corre contra el mock existente, nunca contra la API real.
import type { Page } from "@playwright/test";
import { expect, test, URL_API } from "../e2e/helpers/fixtures.ts";
import { esMovil, irASeccion, seccionesDelPanel, sidebar } from "../e2e/helpers/navegacion.ts";
import { esperarSinCarga, INFORMATIVO, prepararBandera } from "./comun.ts";

const ESTRICTO = process.env["E2E_DISENO"] === "ds3" && !INFORMATIVO;
const CARGANDO = '[role="status"][aria-busy="true"]';
const PROPIEDADES_DE_LAYOUT = /\b(width|height|margin|padding|top|left|right|bottom|flex|grid-template|inset|all)\b/;

interface Metricas {
  cls: number;
  lcp: number;
  largas: number;
  /** Instantes (ms desde el inicio) en que aparecio un estado de carga visible. */
  cargas: number[];
}

/** Observadores instalados ANTES de que cargue la app. */
async function instrumentar(page: Page): Promise<void> {
  await page.addInitScript((sel) => {
    const m = { cls: 0, lcp: 0, largas: 0, cargas: [] as number[], fondoDcl: "" };
    (window as unknown as { __ds3m: typeof m }).__ds3m = m;
    new PerformanceObserver((l) => {
      for (const e of l.getEntries() as unknown as Array<{ hadRecentInput: boolean; value: number }>) if (!e.hadRecentInput) m.cls += e.value;
    }).observe({ type: "layout-shift", buffered: true });
    new PerformanceObserver((l) => {
      const u = l.getEntries().at(-1);
      if (u) m.lcp = u.startTime;
    }).observe({ type: "largest-contentful-paint", buffered: true });
    new PerformanceObserver((l) => {
      m.largas += l.getEntries().filter((e) => e.duration > 200).length;
    }).observe({ type: "longtask", buffered: true });
    document.addEventListener("DOMContentLoaded", () => {
      m.fondoDcl = getComputedStyle(document.documentElement).backgroundColor + "|" + getComputedStyle(document.body).backgroundColor;
      new MutationObserver(() => {
        if (document.querySelector(sel)) m.cargas.push(Math.round(performance.now()));
      }).observe(document.documentElement, { childList: true, subtree: true });
    });
  }, CARGANDO);
}

const leer = (page: Page) => page.evaluate(() => (window as unknown as { __ds3m: Metricas & { fondoDcl: string } }).__ds3m);

/** Muestrea fotogramas con rAF durante `ms` mientras `accion` corre. */
async function fotogramas(page: Page, ms: number, accion: () => Promise<void>): Promise<{ p50: number; p95: number; max: number; n: number }> {
  const muestreo = page.evaluate(
    (dur) =>
      new Promise<number[]>((resolver) => {
        const dts: number[] = [];
        let previo = performance.now();
        const fin = previo + dur;
        const paso = (t: number) => {
          dts.push(t - previo);
          previo = t;
          if (t < fin) requestAnimationFrame(paso);
          else resolver(dts);
        };
        requestAnimationFrame(paso);
      }),
    ms,
  );
  await accion();
  const dts = (await muestreo).slice(1).sort((a, b) => a - b);
  const q = (p: number) => dts[Math.min(dts.length - 1, Math.floor(dts.length * p))] ?? 0;
  return { p50: +q(0.5).toFixed(1), p95: +q(0.95).toFixed(1), max: +(dts.at(-1) ?? 0).toFixed(1), n: dts.length };
}

test.beforeEach(async ({ page }) => {
  await prepararBandera(page);
  await instrumentar(page);
});

/** Registra hallazgos; en modo estricto falla al final con la lista, si no, solo la adjunta. */
async function cerrar(info: import("@playwright/test").TestInfo, nombre: string, datos: unknown, hallazgos: string[]): Promise<void> {
  await info.attach(`${nombre}.json`, { body: JSON.stringify({ proyecto: info.project.name, estricto: ESTRICTO, hallazgos, datos }, null, 1), contentType: "application/json" });
  if (ESTRICTO) expect(hallazgos, `${nombre} (${info.project.name})`).toEqual([]);
  else if (hallazgos.length > 0) console.log(`[ds3] ${nombre} (${info.project.name}): ${hallazgos.length} hallazgo(s) informativo(s)`);
}

test("logo de carga sin salto de layout, y sin logo cuando la carga es instantanea", async ({ page, iniciarSesion }, info) => {
  const hallazgos: string[] = [];
  await iniciarSesion("restaurantes", "owner");
  await esperarSinCarga(page);
  const rutas = await seccionesDelPanel(page);
  const destino = rutas[1]?.href ?? rutas[0]?.href ?? "/";

  // 1) Latencia 0: ningun estado de carga debe llegar a verse (retardo de entrada de 120 ms).
  await page.goto(destino);
  await esperarSinCarga(page);
  const sinLatencia = await leer(page);
  if (sinLatencia.cargas.length > 0) hallazgos.push(`con latencia 0 aparecio un estado de carga (${sinLatencia.cargas.length} mutaciones)`);

  // 2) Latencia 1500 ms: posicion del logo estable a 150 y 1300 ms, solo opacity/transform, CLS anadido <= 0.02.
  await page.route(`${URL_API}/**`, async (ruta) => {
    await new Promise((r) => setTimeout(r, 1500));
    await ruta.continue();
  });
  await page.goto(destino);
  const logo = page.locator(CARGANDO).first();
  await page.waitForTimeout(150);
  const cajaA = await logo.boundingBox().catch(() => null);
  await page.waitForTimeout(1150);
  const cajaB = await logo.boundingBox().catch(() => null);
  if (!cajaA || !cajaB) hallazgos.push("no hubo un logo de carga visible con latencia de 1500 ms");
  else if (Math.abs(cajaA.x - cajaB.x) > 0.5 || Math.abs(cajaA.y - cajaB.y) > 0.5) hallazgos.push(`el logo se movio: ${JSON.stringify(cajaA)} -> ${JSON.stringify(cajaB)}`);
  const props = await page.evaluate(() => {
    const out = new Set<string>();
    document.getAnimations().forEach((a) => ((a.effect as KeyframeEffect | null)?.getKeyframes() ?? []).forEach((k) => Object.keys(k).forEach((p) => out.add(p))));
    return [...out].filter((p) => !["offset", "easing", "composite", "computedOffset"].includes(p));
  });
  const nolayout = props.filter((p) => !/^(opacity|transform|scale|translate|rotate)$/.test(p));
  if (nolayout.length > 0) hallazgos.push(`animaciones con propiedades distintas de opacity/transform: ${nolayout.join(", ")}`);
  const antes = (await leer(page)).cls;
  await esperarSinCarga(page);
  await page.waitForTimeout(300);
  const despues = (await leer(page)).cls;
  if (despues - antes > 0.02) hallazgos.push(`CLS anadido al llegar los datos: ${(despues - antes).toFixed(3)} (> 0.02)`);
  if (despues >= 0.05) hallazgos.push(`CLS de la ruta: ${despues.toFixed(3)} (objetivo <= 0.05)`);
  await cerrar(info, "logo-y-cls", { cajaA, cajaB, props, cls: despues }, hallazgos);
});

test("el shell no se remonta al cambiar de ruta (sidebar y barra inferior)", async ({ page, iniciarSesion }, info) => {
  const hallazgos: string[] = [];
  await iniciarSesion("restaurantes", "owner");
  await esperarSinCarga(page);
  const movil = esMovil(page);
  const nav = movil ? page.getByRole("navigation", { name: "Navegación móvil" }) : sidebar(page);
  await nav.first().evaluate((el) => ((el as unknown as { __ds3id: string }).__ds3id = "montado"));
  const enlaces = await nav.first().getByRole("link").evaluateAll((as) => as.map((a) => a.getAttribute("href")).filter(Boolean) as string[]);
  const otro = enlaces.find((h) => !new URL(h, "http://x").pathname.endsWith(new URL(page.url()).pathname));
  if (!otro) hallazgos.push("el menu no ofrece otra ruta a la que navegar");
  else {
    await nav.first().locator(`a[href="${otro}"]`).first().click();
    await expect(page).toHaveURL(new RegExp(otro.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    await esperarSinCarga(page);
    const sigue = await nav.first().evaluate((el) => (el as unknown as { __ds3id?: string }).__ds3id === "montado").catch(() => false);
    if (!sigue) hallazgos.push(`${movil ? "la barra inferior" : "el sidebar"} se remonto al navegar`);
  }
  await cerrar(info, "shell-estable", { movil }, hallazgos);
});

test("tiempo hasta contenido y fotogramas (cambio de ruta, dialogo, sidebar)", async ({ page, iniciarSesion, context }, info) => {
  const hallazgos: string[] = [];
  const movil = esMovil(page);
  const cdp = await context.newCDPSession(page);
  if (movil) await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await iniciarSesion("restaurantes", "owner");
  await esperarSinCarga(page);

  // Tiempo hasta contenido (TTC), aparte del LCP: el candidato a LCP puede ser el logo.
  const t0 = Date.now();
  await page.goto(page.url());
  await expect(page.locator("main#contenido-principal h1, main#contenido-principal [role=heading][aria-level='1']").first()).toBeVisible();
  await esperarSinCarga(page);
  const ttc = Date.now() - t0;
  const limiteTtc = movil ? 2000 : 1200;
  if (ttc > limiteTtc) hallazgos.push(`tiempo hasta contenido ${ttc} ms (> ${limiteTtc} ms)`);
  const lcp = (await leer(page)).lcp;

  const p95Max = movil ? 25 : 18;
  const resultados: Record<string, { p50: number; p95: number; max: number; n: number }> = {};
  const medir = async (nombre: string, accion: () => Promise<void>) => {
    const r = await fotogramas(page, 1500, accion);
    resultados[nombre] = r;
    if (r.p95 > p95Max) hallazgos.push(`${nombre}: p95 de fotograma ${r.p95} ms (> ${p95Max} ms)`);
    if (movil && r.max > 100) hallazgos.push(`${nombre}: fotograma de ${r.max} ms (> 100 ms)`);
  };

  const rutas = await seccionesDelPanel(page);
  const destino = rutas.find((r) => !page.url().endsWith(r.href));
  if (destino) {
    // Navegacion de SPA con clic real (si fuera `goto` se destruiria el contexto donde corre el muestreo).
    await medir("cambio-de-ruta", async () => {
      await irASeccion(page, destino);
      await esperarSinCarga(page);
    });
  }
  const crear = page.locator("main").getByRole("button", { name: /^(Nuevo|Nueva|Agregar|Crear|A[ñn]adir)\b/i }).first();
  if ((await crear.count()) > 0 && (await crear.isVisible())) {
    await medir("dialogo", async () => {
      await crear.click();
      await page.getByRole("dialog").first().waitFor({ state: "visible" }).catch(() => undefined);
      await page.waitForTimeout(400);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
    });
  }
  const colapsar = page.getByRole("button", { name: /Colapsar barra lateral|Expandir barra lateral/ }).first();
  if (!movil && (await colapsar.count()) > 0) {
    await medir("sidebar", async () => {
      await colapsar.click();
      await page.waitForTimeout(500);
      await colapsar.click();
    });
  }
  await medir("scroll-del-contenido", async () => {
    await page.mouse.move(400, 400);
    for (let i = 0; i < 6; i++) {
      await page.mouse.wheel(0, 400);
      await page.waitForTimeout(100);
    }
  });
  if (movil) await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  await cerrar(info, "ttc-y-fps", { ttc, lcp, resultados }, hallazgos);
});

test("animaciones: solo opacity/transform, duraciones <= 400 ms y reduced-motion sin movimiento", async ({ page, iniciarSesion }, info) => {
  const hallazgos: string[] = [];
  await iniciarSesion("restaurantes", "owner");
  await esperarSinCarga(page);

  const transiciones = await page.evaluate((patron) => {
    const re = new RegExp(patron);
    const vistas = new Map<string, number>();
    document.querySelectorAll("body *").forEach((el) => {
      const s = getComputedStyle(el);
      const dur = s.transitionDuration.split(",").map((d) => parseFloat(d) * (d.includes("ms") ? 1 : 1000));
      const props = s.transitionProperty.split(",").map((p) => p.trim());
      props.forEach((p, i) => {
        const d = dur[i % dur.length] ?? 0;
        if (d > 0 && re.test(p)) vistas.set(`${p} (${d} ms)`, (vistas.get(`${p} (${d} ms)`) ?? 0) + 1);
        if (d > 400) vistas.set(`duracion > 400 ms: ${p} (${d} ms)`, (vistas.get(`duracion > 400 ms: ${p} (${d} ms)`) ?? 0) + 1);
      });
    });
    return [...vistas.entries()].map(([k, n]) => `${k} x${n}`);
  }, PROPIEDADES_DE_LAYOUT.source);
  transiciones.slice(0, 12).forEach((t) => hallazgos.push(`transicion de layout o demasiado larga: ${t}`));

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.waitForTimeout(300);
  const infinitas = await page.evaluate(() =>
    document.getAnimations().filter((a) => (a.effect?.getTiming().iterations ?? 0) === Infinity && a.playState === "running").length,
  );
  if (infinitas > 0) hallazgos.push(`con prefers-reduced-motion hay ${infinitas} animacion(es) infinita(s) corriendo`);
  const conTransicion = await page.evaluate(() => {
    let n = 0;
    document.querySelectorAll("button, [role=dialog], a").forEach((el) => {
      if (getComputedStyle(el).transitionDuration.split(",").some((d) => parseFloat(d) > 0.001)) n++;
    });
    return n;
  });
  if (conTransicion > 0) hallazgos.push(`con prefers-reduced-motion ${conTransicion} control(es) conservan transicion`);
  await cerrar(info, "animaciones", { transiciones, infinitas, conTransicion }, hallazgos);
});

test("tema sin destello: el fondo en DOMContentLoaded es el definitivo (login y repartidor)", async ({ page }, info) => {
  const hallazgos: string[] = [];
  const datos: Record<string, { alInicio: string; alFinal: string }> = {};
  for (const ruta of ["/restaurantes/login", "/repartidor"]) {
    await page.goto(ruta);
    await page.waitForLoadState("networkidle");
    const alInicio = (await leer(page)).fondoDcl;
    const alFinal = await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor + "|" + getComputedStyle(document.body).backgroundColor);
    datos[ruta] = { alInicio, alFinal };
    if (alInicio !== alFinal) hallazgos.push(`${ruta}: fondo ${alInicio} en DOMContentLoaded y ${alFinal} al final`);
  }
  await cerrar(info, "fouc", datos, hallazgos);
});
