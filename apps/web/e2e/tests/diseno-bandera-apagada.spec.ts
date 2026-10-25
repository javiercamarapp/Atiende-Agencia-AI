// ds3 / 0.2: con la bandera de diseno APAGADA la app se ve exactamente igual. En 3 pantallas (login, Resumen de restaurantes y
// Resumen de superadmin) se toma la huella de estilos computados de todos los elementos y se compara entre la carga normal y la
// carga con `?diseno=off` (la bandera fuerza apagada, aunque otra prueba la hubiera guardado). Ademas, si `DS3_ESTILOS_REF`
// apunta a un JSON de huellas (generado con `DS3_ESTILOS_SALIDA` sobre `origin/main`), cada huella se compara contra esa
// referencia: asi un PR que cambie estilos con la bandera apagada se detecta contra main y no solo contra si mismo.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "../helpers/fixtures.ts";

const PROPIEDADES = [
  "display", "position", "color", "background-color", "font-family", "font-size", "font-weight", "line-height", "letter-spacing",
  "padding-top", "padding-right", "padding-bottom", "padding-left", "margin-top", "margin-right", "margin-bottom", "margin-left",
  "border-top-width", "border-top-color", "border-top-left-radius", "border-top-right-radius", "row-gap", "column-gap",
  "box-shadow", "opacity", "text-transform",
] as const;

type Huella = Record<string, string>;

async function huella(page: Page): Promise<Huella> {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.waitForLoadState("networkidle");
  await expect(page.locator('[role="status"][aria-busy="true"]')).toHaveCount(0, { timeout: 20_000 });
  return page.evaluate((props) => {
    const salida: Record<string, string> = {};
    const vistos = new Map<string, number>();
    document.querySelectorAll("body, body *").forEach((el) => {
      if (el.closest("script,style,noscript,svg")) return;
      const ruta: string[] = [];
      for (let n: Element | null = el; n && n !== document.documentElement; n = n.parentElement) {
        const idx = n.parentElement ? [...n.parentElement.children].indexOf(n) : 0;
        ruta.unshift(`${n.tagName.toLowerCase()}:${idx}`);
      }
      const clave = ruta.join(">");
      const veces = (vistos.get(clave) ?? 0) + 1;
      vistos.set(clave, veces);
      const s = getComputedStyle(el);
      salida[veces > 1 ? `${clave}#${veces}` : clave] = props.map((p) => s.getPropertyValue(p)).join("|");
    });
    return salida;
  }, [...PROPIEDADES]);
}

function diferencias(a: Huella, b: Huella): string[] {
  const claves = new Set([...Object.keys(a), ...Object.keys(b)]);
  const dif: string[] = [];
  for (const k of claves) if (a[k] !== b[k]) dif.push(`${k}\n   antes: ${a[k] ?? "(no existe)"}\n   ahora: ${b[k] ?? "(no existe)"}`);
  return dif;
}

const PANTALLAS = [
  { id: "login-restaurantes", entrar: null },
  { id: "resumen-restaurantes", entrar: "restaurantes" },
  { id: "resumen-superadmin", entrar: "superadmin" },
] as const;

for (const pantalla of PANTALLAS) {
  test(`bandera apagada: ${pantalla.id} no cambia ningun estilo computado`, async ({ page, iniciarSesion }, info) => {
    let ruta = "/restaurantes/login";
    if (pantalla.entrar) ruta = await iniciarSesion(pantalla.entrar);
    else await page.goto(ruta);
    await expect(page.locator("html")).not.toHaveAttribute("data-diseno", /.*/);
    const normal = await huella(page);
    expect(Object.keys(normal).length, "la huella no esta vacia").toBeGreaterThan(20);

    await page.goto(`${ruta}?diseno=off`);
    await expect(page.locator("html")).not.toHaveAttribute("data-diseno", /.*/);
    const apagada = await huella(page);
    const dif = diferencias(normal, apagada);
    expect(dif, `estilos que cambian con ?diseno=off:\n${dif.slice(0, 10).join("\n")}`).toEqual([]);

    const clave = `${pantalla.id}/${info.project.name}`;
    const salida = process.env["DS3_ESTILOS_SALIDA"];
    if (salida) {
      mkdirSync(dirname(salida), { recursive: true });
      const previo = existsSync(salida) ? (JSON.parse(readFileSync(salida, "utf8")) as Record<string, Huella>) : {};
      writeFileSync(salida, JSON.stringify({ ...previo, [clave]: normal }));
    }
    const ref = process.env["DS3_ESTILOS_REF"];
    if (ref && existsSync(ref)) {
      const referencia = (JSON.parse(readFileSync(ref, "utf8")) as Record<string, Huella>)[clave];
      if (referencia) {
        const contraMain = diferencias(referencia, normal);
        expect(contraMain, `estilos distintos de la referencia (origin/main) con la bandera apagada:\n${contraMain.slice(0, 10).join("\n")}`).toEqual([]);
      }
    }
  });
}
