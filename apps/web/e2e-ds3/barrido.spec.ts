// Barrido de rutas con el medidor (protocolo de verificacion ds3, secciones 7.2 y 7.3). Para cada una de las 7 consolas recorre las
// rutas REALES del menu (las mismas que ve una persona: Sidebar en escritorio, hoja «Más» en movil), mas una lista fija EXTRAS de rutas
// fuera del menu, y ejecuta `medidas.js` en cada pantalla. Agrupa TODOS los defectos y falla una sola vez con la lista
// (`ruta [tipo] elemento — mensaje dato`), salvo en modo informativo (DS3_INFORMATIVO=1: solo reporta). Escribe un JSON por pantalla
// y variante en la carpeta de evidencia. Variantes por consola (en su primera ruta): dialogo abierto, hoja «Más» (movil) y foco (Tab x60).
// No usa la API real: corre contra el mock existente. Ver playwright.ds3.config.ts para las variables DS3_*.
import { expect, test } from "../e2e/helpers/fixtures.ts";
import { afirmarModo, afirmarSkipLink } from "../e2e/helpers/ds.ts";
import { abrirMasMovil, esMovil, seccionesDelPanel } from "../e2e/helpers/navegacion.ts";
import { orgDe, VERTICALES } from "../e2e/mock-api/personas.ts";
import { esperarSinCarga, HUMO, INFORMATIVO, leerFoco, medir, prepararBandera } from "./comun.ts";

type Consola = (typeof VERTICALES)[number] | "superadmin";
const CONSOLAS: readonly Consola[] = [...VERTICALES, "superadmin"];
const MAX_HUMO = 6;

/** Rutas fuera del menu que una persona alcanza por enlaces (campana, cuenta, plan). */
function extras(consola: Consola): string[] {
  if (consola === "superadmin") return ["/superadmin/parte-diario", "/superadmin/seguridad", "/superadmin/notificaciones"];
  const base = `/${consola}/${orgDe(consola).slug}`;
  const comunes = [`${base}/notificaciones`, `${base}/seguridad`];
  return consola === "restaurantes" || consola === "hoteles" ? [...comunes, `${base}/plan`] : comunes;
}

function elegirHumo<T>(todas: readonly T[]): T[] {
  if (!HUMO || todas.length <= MAX_HUMO) return [...todas];
  const paso = (todas.length - 1) / (MAX_HUMO - 1);
  return [...new Set(Array.from({ length: MAX_HUMO }, (_, i) => Math.round(i * paso)))].map((i) => todas[i] as T);
}

test.beforeEach(async ({ page }) => {
  await prepararBandera(page);
});

for (const consola of CONSOLAS) {
  test(`barrido ${consola}`, async ({ page, iniciarSesion, vigilante }, info) => {
    const oscuro = info.project.name.endsWith("oscuro");
    await iniciarSesion(consola, "owner");
    const rutas = elegirHumo((await seccionesDelPanel(page)).map((s) => s.href));
    // EXTRAS solo en el barrido completo (en HUMO se mide la primera, para no alargar el PR).
    const todas = HUMO ? [...rutas, ...extras(consola).slice(0, 1)] : [...rutas, ...extras(consola)];
    const defectos: string[] = [];
    const juntar = (l: string[]) => defectos.push(...l);

    for (const [i, href] of todas.entries()) {
      await page.goto(href);
      await expect(page.locator("main#contenido-principal")).toBeVisible();
      await esperarSinCarga(page);
      await afirmarModo(page, oscuro ? "oscuro" : "claro");
      juntar((await medir(page, info, consola, href)).linea);

      if (i !== 0) continue;
      // Variantes de estado, una vez por consola (primera ruta del menu).
      if (esMovil(page)) {
        const hoja = await abrirMasMovil(page);
        juntar((await medir(page, info, consola, href, "mas")).linea);
        await page.keyboard.press("Escape");
        await expect(hoja).toBeHidden();
      }
      const crear = page.locator("main").getByRole("button", { name: /^(Nuevo|Nueva|Agregar|Crear|A[ñn]adir)\b/i }).first();
      if ((await crear.count()) > 0 && (await crear.isVisible())) {
        await crear.click();
        const dialogo = page.getByRole("dialog").first();
        if (await dialogo.isVisible().catch(() => false)) {
          juntar((await medir(page, info, consola, href, "dialogo")).linea);
          await page.keyboard.press("Escape");
          await expect(dialogo).toBeHidden();
        }
      }
      // Foco: Tab x60; cada elemento enfocado debe mostrar anillo, quedar a la vista y no estar tapado; ningun tabindex > 0.
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      for (let n = 0; n < 60; n++) {
        await page.keyboard.press("Tab");
        const f = await leerFoco(page);
        if (!f) continue;
        if (f.sinAnillo) defectos.push(`${href} [foco] ${f.el} — sin anillo de foco (outline y box-shadow ausentes)`);
        if (f.tapadoPor) defectos.push(`${href} [foco] ${f.el} — tapado por ${f.tapadoPor}`);
        if (f.tabindexPositivo) defectos.push(`${href} [foco] ${f.el} — tabindex positivo`);
      }
    }
    try {
      await page.goto(todas[0] as string);
      await expect(page.locator("main#contenido-principal")).toBeVisible();
      await afirmarSkipLink(page);
    } catch (e) {
      defectos.push(`${todas[0]} [skip-link] ${(e as Error).message.split("\n")[0]}`);
    }
    const consolaYRed = vigilante.resumen();
    if (consolaYRed) defectos.push(`[consola/red] ${consolaYRed.replace(/\n/g, " | ")}`);

    const unicos = [...new Set(defectos)];
    await info.attach(`defectos-${consola}.txt`, { body: unicos.join("\n") || "(sin defectos)", contentType: "text/plain" });
    if (INFORMATIVO) {
      console.log(`[ds3] ${consola} (${info.project.name}): ${unicos.length} defecto(s), ${todas.length} ruta(s)`);
      return;
    }
    expect(unicos, `defectos de ${consola} (${info.project.name})`).toEqual([]);
  });
}

// Roles distintos del propietario en restaurantes: el repartidor aterriza fuera del shell (/repartidor) y el staff ve un menu reducido.
for (const rol of ["staff", "repartidor"] as const) {
  test(`barrido restaurantes con rol ${rol}`, async ({ page, iniciarSesion }, info) => {
    const ruta = await iniciarSesion("restaurantes", rol);
    await esperarSinCarga(page);
    const { linea } = await medir(page, info, `restaurantes-${rol}`, ruta);
    const unicos = [...new Set(linea)];
    await info.attach(`defectos-${rol}.txt`, { body: unicos.join("\n") || "(sin defectos)", contentType: "text/plain" });
    if (INFORMATIVO) return;
    expect(unicos, `defectos de restaurantes/${rol} (${info.project.name})`).toEqual([]);
  });
}

// Paginas publicas y login de cada vertical (sin sesion).
test("barrido de paginas publicas", async ({ page }, info) => {
  const publicas = [
    "/",
    ...VERTICALES.map((v) => `/${v}/login`),
    "/terminos",
    "/privacidad",
    `/reservar/${orgDe("citas").slug}`,
    `/demo/${orgDe("restaurantes").slug}`,
    "/ruta-que-no-existe-ds3",
  ];
  const defectos: string[] = [];
  for (const ruta of elegirHumo(publicas)) {
    await page.goto(ruta);
    await page.waitForLoadState("networkidle");
    await esperarSinCarga(page);
    defectos.push(...(await medir(page, info, "publicas", ruta)).linea);
  }
  const unicos = [...new Set(defectos)];
  await info.attach("defectos-publicas.txt", { body: unicos.join("\n") || "(sin defectos)", contentType: "text/plain" });
  if (INFORMATIVO) return;
  expect(unicos, `defectos de las paginas publicas (${info.project.name})`).toEqual([]);
});
