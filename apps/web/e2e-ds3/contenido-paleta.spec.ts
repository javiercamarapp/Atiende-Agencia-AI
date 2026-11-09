// ds3 «componentes de contenido», parte 2 (PARIDAD-ATIENDE-ROVAQ §R1 #6, #9 y P2 de radios), en el navegador real con la bandera:
// periodo segmentado en azul suave y en UNA linea (tambien a 390), aviso de agregados como callout (nunca sobre el chat), ningun primario
// azul solido suelto, tarjetas de radio 12 y th Hanken 13/600 con la tabla dentro de una tarjeta. Sin la bandera, el diseno actual sigue
// (periodo activo en azul solido). Captura por pantalla y proyecto en `<DS3_SALIDA>/contenido-paleta/<pantalla>/`.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page, TestInfo } from "@playwright/test";
import { expect, test } from "../e2e/helpers/fixtures.ts";
import { orgDe } from "../e2e/mock-api/personas.ts";
import { ETAPA, esperarSinCarga, prepararBandera } from "./comun.ts";

const SALIDA = process.env["DS3_SALIDA"] ?? "test-results-ds3/evidencia";
const DS3 = process.env["E2E_DISENO"] === "ds3";
const SOLIDO = "rgb(29, 79, 215)";
const rest = () => `/restaurantes/${orgDe("restaurantes").slug}`;

async function capturar(page: Page, info: TestInfo, pantalla: string): Promise<void> {
  const carpeta = join(SALIDA, "contenido-paleta", pantalla);
  mkdirSync(carpeta, { recursive: true });
  const png = join(carpeta, `${info.project.name}-${ETAPA}${DS3 ? "-ds3" : ""}.png`);
  await page.screenshot({ path: png, fullPage: false });
  await info.attach(`${pantalla}-${info.project.name}`, { path: png, contentType: "image/png" });
}

async function abrir(page: Page, ruta: string): Promise<void> {
  await page.goto(ruta);
  await expect(page.locator("main#contenido-principal")).toBeVisible();
  await esperarSinCarga(page);
}

test.beforeEach(async ({ page }) => {
  await prepararBandera(page);
});

test("periodo segmentado en azul suave y en una linea; aviso de agregados como callout", async ({ page, iniciarSesion, vigilante }, info) => {
  await iniciarSesion("restaurantes", "owner");
  await abrir(page, rest());
  const grupo = page.getByRole("radiogroup", { name: "Periodo" });
  await expect(grupo).toBeVisible();
  const lectura = await grupo.evaluate((g) => {
    const labels = [...g.querySelectorAll("label")];
    const activa = labels.find((l) => l.querySelector("input")!.checked)!;
    return {
      fondoActiva: getComputedStyle(activa).backgroundColor,
      altos: [...new Set(labels.map((l) => Math.round(l.getBoundingClientRect().height)))],
      renglones: new Set(labels.map((l) => Math.round(l.offsetTop))).size,
      radio: getComputedStyle(activa).borderTopLeftRadius,
      scrollPagina: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  await info.attach("periodo", { body: JSON.stringify(lectura, null, 1), contentType: "application/json" });
  if (DS3) {
    expect(lectura.fondoActiva, "activa en azul suave, no solido").not.toBe(SOLIDO);
    expect(lectura.altos).toEqual([28]);
    expect(lectura.radio).toBe("8px");
    expect(lectura.renglones, "el periodo no se parte en renglones").toBe(1);
  } else {
    expect(lectura.fondoActiva).toBe(SOLIDO);
  }
  expect(lectura.scrollPagina, "sin scroll horizontal de la pagina").toBeLessThanOrEqual(0);

  const aviso = page.getByTestId("banner-agregados-global");
  await expect(aviso).toBeVisible();
  const cta = aviso.getByRole("link", { name: "Validar ahora" });
  const av = await cta.evaluate((a) => ({ fondo: getComputedStyle(a).backgroundColor, alto: Math.round(a.getBoundingClientRect().height), borde: getComputedStyle(a.parentElement!).borderTopWidth }));
  if (DS3) {
    expect(av.fondo).not.toBe(SOLIDO);
    expect(av.alto).toBe(30);
    expect(av.borde).toBe("1px");
  }
  await capturar(page, info, "restaurantes-resumen");

  // Nunca encima del chat (en ningun ancho).
  await abrir(page, `${rest()}/copiloto`);
  if (DS3) await expect(page.getByTestId("banner-agregados-global")).toBeHidden();
  vigilante.verificar();
});

test("ningun primario azul solido suelto y tarjetas de radio 12", async ({ page, iniciarSesion, vigilante }, info) => {
  await iniciarSesion("restaurantes", "owner");
  await abrir(page, `${rest()}/notificaciones`);
  const lectura = await page.evaluate((solido) => {
    const main = document.querySelector("main")!;
    const solidos = [...main.querySelectorAll<HTMLElement>("a, button")]
      .filter((b) => b.getClientRects().length > 0 && getComputedStyle(b).backgroundColor === solido && !/switch|checkbox|radio|tab/.test(b.getAttribute("role") ?? ""))
      .map((b) => (b.textContent ?? "").trim().slice(0, 30));
    const radios = [...main.querySelectorAll<HTMLElement>(".card, .ds3-card")].filter((c) => c.getClientRects().length > 0 && !c.classList.contains("ds3-stat")).map((c) => getComputedStyle(c).borderTopLeftRadius);
    return { solidos, radios: [...new Set(radios)] };
  }, SOLIDO);
  await info.attach("notificaciones", { body: JSON.stringify(lectura, null, 1), contentType: "application/json" });
  if (DS3) {
    expect(lectura.solidos).toEqual([]);
    for (const r of lectura.radios) expect(r).toBe("12px");
  }
  await capturar(page, info, "restaurantes-notificaciones");
  vigilante.verificar();
});

test("tabla: th Hanken 13/600 y la tabla suelta dentro de una tarjeta (Despachos)", async ({ page, iniciarSesion, vigilante }, info) => {
  test.skip(info.project.name.startsWith("m"), "en movil DataTable pinta tarjetas, no <table>");
  await iniciarSesion("despachos", "owner");
  await abrir(page, `/despachos/${orgDe("despachos").slug}/cierre-mensual`);
  const th = page.locator("main th").first();
  await expect(th).toBeVisible();
  const lectura = await th.evaluate((el) => {
    const s = getComputedStyle(el);
    const envoltura = el.closest("table")!.parentElement!;
    return { familia: s.fontFamily.split(",")[0]!.replace(/"/g, "").trim(), tam: s.fontSize, peso: s.fontWeight, tt: s.textTransform, borde: getComputedStyle(envoltura).borderTopWidth, radio: getComputedStyle(envoltura).borderTopLeftRadius };
  });
  await info.attach("tabla", { body: JSON.stringify(lectura, null, 1), contentType: "application/json" });
  if (DS3) {
    expect(lectura).toEqual({ familia: "Hanken Grotesk", tam: "13px", peso: "600", tt: "none", borde: "1px", radio: "12px" });
  } else {
    expect(lectura.tt).toBe("uppercase");
  }
  await capturar(page, info, "despachos-cierre-mensual");
  vigilante.verificar();
});
