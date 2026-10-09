// UNI-R0b -- capturas ANTES/DESPUES de las paginas reales de restaurantes con la API simulada: el MISMO estado de la MISMA pagina se fotografia
// primero con el ambito (despues) y luego con `data-ambito="ninguno"` (antes = aspecto de Likida de main), asi no hay diferencias de datos ni de
// momento. Los PNG solo se escriben si CAPTURAS_R0B_DIR apunta a una carpeta (CI no genera nada). Claro/oscuro/375 px segun el proyecto.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { dialogo } from "../../helpers/dialogos.ts";
import { expect, test } from "../../helpers/fixtures.ts";
import { ir } from "../../helpers/recorrido.ts";

const PAGINAS: ReadonlyArray<{ sub: string; nombre: string }> = [
  { sub: "", nombre: "resumen" },
  { sub: "/pedidos", nombre: "pedidos" },
  { sub: "/clientes", nombre: "clientes" },
  { sub: "/productos", nombre: "productos" },
  { sub: "/agente-voz", nombre: "agente-voz" },
  { sub: "/agente-whatsapp", nombre: "whatsapp" },
  { sub: "/configuracion", nombre: "configuracion" },
  { sub: "/staff", nombre: "staff" },
];

async function foto(page: Page, nombre: string, vista: string): Promise<void> {
  const destino = process.env["CAPTURAS_R0B_DIR"];
  if (!destino) return;
  mkdirSync(destino, { recursive: true });
  await page.waitForTimeout(700);
  await page.screenshot({ path: join(destino, `${nombre}-${vista}-despues.png`) });
  await page.evaluate(() => document.documentElement.setAttribute("data-ambito", "ninguno"));
  await page.waitForTimeout(350);
  await page.screenshot({ path: join(destino, `${nombre}-${vista}-antes.png`) });
  await page.evaluate(() => document.documentElement.setAttribute("data-ambito", "restaurantes"));
  await page.waitForTimeout(150);
}

test.describe("UNI-R0b capturas antes/despues @recorrido @oscuro", () => {
  test("paginas y overlays reales", async ({ page, iniciarSesion }, info) => {
    test.skip(!process.env["CAPTURAS_R0B_DIR"], "solo con CAPTURAS_R0B_DIR");
    test.setTimeout(240_000);
    const movil = info.project.name.startsWith("movil");
    const vista = { "escritorio-claro": "claro", "escritorio-oscuro": "oscuro", "movil-claro": "movil", "movil-oscuro": "movil-oscuro" }[info.project.name]!;
    if (!movil) await page.setViewportSize({ width: 1440, height: 900 });
    await iniciarSesion("restaurantes", "owner");
    for (const p of PAGINAS) {
      await ir(page, p.sub);
      await expect(page.getByText(/^Cargando/)).toHaveCount(0, { timeout: 15_000 });
      await foto(page, p.nombre, vista);
    }
    // Overlays reales: FormDialog (cancelar pedido) y ConfirmDialog destructivo (dar de baja).
    await ir(page, "/pedidos");
    await page.locator("main#contenido-principal").getByRole("button", { name: "Marcar Cancelado" }).first().click();
    await expect(dialogo(page, "Cancelar pedido")).toBeVisible();
    await foto(page, "overlay-formdialog", vista);
    await page.keyboard.press("Escape");
    await ir(page, "/staff");
    await page.locator("xpath=//p[normalize-space()='Ramon Uc']/../..").getByRole("button", { name: "Dar de baja" }).click();
    await expect(dialogo(page, /Dar de baja a/)).toBeVisible();
    await foto(page, "overlay-confirmar", vista);
    await page.keyboard.press("Escape");
  });
});
