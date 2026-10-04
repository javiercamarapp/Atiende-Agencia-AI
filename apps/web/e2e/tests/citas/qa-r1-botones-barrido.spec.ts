// QA R1 (lente botones y paginas) de citas: barrido de TODAS las paginas del panel (y las fichas) en los 4 proyectos (claro/oscuro x
// escritorio/movil). En cada una: shell sano, un solo <h1>, sin desborde horizontal, sin botones sin nombre accesible, sin textos
// cortados en botones, sin rutas sin fixture en la API simulada y sin errores de consola ni 5xx. Mas la bandeja de conversaciones
// (filtro, actualizar, conflicto al tomar) que el humo no cubre.
import { expect, test } from "../../helpers/fixtures.ts";
import { afirmarSinScrollHorizontal } from "../../helpers/ds.ts";
import { afirmarPantallaSana } from "../../helpers/humo.ts";
import { citasQa } from "../../mock-api/fixtures/citas-qa.ts";

const BASE = `/citas/${citasQa.orgSlug}`;
const PAGINAS = [
  "resumen",
  "copiloto",
  "agenda",
  "avisos",
  "primeros-pasos",
  "proveedores",
  "proveedores/prv-1",
  "proveedores/prv-2",
  "servicios",
  "servicios/srv-1",
  "clientes",
  "clientes/cli-1",
  "disponibilidad",
  "conversaciones",
  "agente-whatsapp",
  "mensajes-whatsapp",
  "configuracion",
  "staff",
  "auditoria",
  "privacidad",
  "notificaciones",
  "plan",
  "seguridad",
] as const;

test.describe("citas QA R1 botones: barrido de paginas @oscuro", () => {
  for (const ruta of PAGINAS) {
    test(`${ruta}: shell sano, un h1, sin desborde, sin botones sin nombre ni cortados, sin rutas sin fixture @oscuro`, async ({ page, iniciarSesion, vigilante }) => {
      await iniciarSesion("citas", "owner");
      await page.goto(`${BASE}/${ruta}`);
      await afirmarPantallaSana(page, ruta);
      await page.waitForLoadState("networkidle");
      await expect(page.getByRole("heading", { level: 1 }), `${ruta}: un solo <h1>`).toHaveCount(1);
      await expect(page.locator("main").getByText("No se pudo cargar la información"), `${ruta}: ninguna carga fallo`).toHaveCount(0);
      await afirmarSinScrollHorizontal(page);
      const sinNombre = await page.locator("main button:visible, main [role='button']:visible").evaluateAll((els) =>
        els
          .filter((el) => {
            const nombre = (el.getAttribute("aria-label") ?? "").trim() || (el.getAttribute("title") ?? "").trim() || (el.textContent ?? "").trim();
            const porId = (el.getAttribute("aria-labelledby") ?? "").split(/\s+/).filter(Boolean).map((id) => document.getElementById(id)?.textContent?.trim() ?? "").join("");
            return nombre === "" && porId === "";
          })
          .map((el) => el.outerHTML.slice(0, 160)),
      );
      expect(sinNombre, `${ruta}: botones sin nombre accesible`).toEqual([]);
      const cortados = await page.locator("main button:visible").evaluateAll((els) => els.filter((el) => el.scrollWidth > el.clientWidth + 1 && (el.textContent ?? "").trim() !== "").map((el) => (el.textContent ?? "").trim()));
      expect(cortados, `${ruta}: botones con el texto cortado`).toEqual([]);
      expect([...new Set(vigilante.sinFixture)], `${ruta}: rutas que la API simulada no atiende`).toEqual([]);
      vigilante.verificar();
    });
  }
});

test.describe("citas QA R1 botones: bandeja de conversaciones", () => {
  test("filtro por estado pide al servidor y muestra el vacio honesto; Actualizar vuelve a pedir", async ({ page, iniciarSesion, mock, vigilante }) => {
    await iniciarSesion("citas", "owner");
    await page.goto(`${BASE}/conversaciones`);
    await expect(page.locator("[data-conversation-id='cnv-1']").first()).toBeVisible();
    await page.getByRole("combobox", { name: "Estado" }).selectOption("pendiente");
    await expect(page.locator("[data-conversation-id='cnv-1']")).toHaveCount(0);
    await expect(page.locator("[data-conversation-id='cnv-2']").first()).toBeVisible();
    await page.getByRole("combobox", { name: "Estado" }).selectOption("cerrada");
    await expect(page.getByText("Sin conversaciones")).toBeVisible();
    await mock.limpiarRegistro();
    await page.getByRole("button", { name: "Actualizar" }).click();
    await expect.poll(async () => (await mock.buscar({ metodo: "GET", ruta: "/admin/conversaciones?" })).length).toBeGreaterThan(0);
    vigilante.verificar();
  });

  test("tomar una conversacion que otra persona ya tomo (409) explica el conflicto y no deja la UI rota", async ({ page, iniciarSesion, mock, vigilante }) => {
    await iniciarSesion("citas", "owner");
    await page.goto(`${BASE}/conversaciones`);
    await page.locator("[data-conversation-id='cnv-2']").first().click();
    await mock.inyectarFalla({ metodo: "POST", ruta: "/tomar", status: 409, cuerpo: { message: "Esta conversación ya la tiene otra persona." }, veces: 1 });
    await page.getByRole("button", { name: "Tomar conversación" }).click();
    await expect(page.getByText("Esta conversación ya la tiene otra persona.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Tomar conversación" })).toBeEnabled();
    await afirmarSinScrollHorizontal(page);
    vigilante.verificar();
  });
});
