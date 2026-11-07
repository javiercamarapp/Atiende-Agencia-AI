// ds3 / «Pregúntale a tus datos» en TODOS los ámbitos que montan el chat compartido, con la bandera encendida y contra la API
// simulada: citas, hoteles, despachos, licitaciones, rentas y el Copiloto de plataforma del superadmin (restaurantes vive en
// copiloto-ds3.spec.ts). En cada uno: los temas salen de las categorías de ESA vertical, una pregunta del primer tema llega al
// endpoint de su vertical, la respuesta trae «Cómo se calculó» con la fuente que mandó el servidor y el historial abre como Drawer.
// Por rol: el staff de restaurantes no ve el tema «CFO» (la misma regla `cfo.ver` del diseño actual) y un rol sin Copiloto ve el
// estado honesto «Sin acceso» también con la bandera.
// Capturas opcionales: COPILOTO_CAPTURAS=<carpeta>.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "../helpers/fixtures.ts";
import type { ObjetivoLogin } from "../helpers/fixtures.ts";
import { afirmarPantallaSana } from "../helpers/humo.ts";
import { citas } from "../mock-api/fixtures/citas.ts";
import { despachos } from "../mock-api/fixtures/despachos.ts";
import { hoteles } from "../mock-api/fixtures/hoteles.ts";
import { licitaciones } from "../mock-api/fixtures/licitaciones.ts";
import { rentas } from "../mock-api/fixtures/rentas.ts";
import { restaurantes } from "../mock-api/fixtures/restaurantes.ts";
import type { Rol } from "../mock-api/tipos.ts";

const CAPTURAS = process.env["COPILOTO_CAPTURAS"];

interface Ambito {
  readonly nombre: string;
  readonly objetivo: ObjetivoLogin;
  readonly rol?: Rol;
  readonly ruta: string;
  /** Primer tema (primera categoría de la vertical) y su primera pregunta. */
  readonly tema: string;
  readonly pregunta: string;
  /** POST que debe recibir la pregunta (endpoint de chat de ESA vertical). */
  readonly post: string | RegExp;
  readonly respuesta: string;
  readonly fuente: string;
}

const AMBITOS: readonly Ambito[] = [
  { nombre: "citas", objetivo: "citas", rol: "owner", ruta: `/citas/${citas.orgSlug}/copiloto`, tema: "Agenda y ocupación", pregunta: "¿Cuántas citas tengo esta semana?", post: "/chat-datos", respuesta: "Esta semana tienes 24 citas", fuente: "Citas de la agenda" },
  { nombre: "hoteles", objetivo: "hoteles", rol: "owner", ruta: `/hoteles/${hoteles.orgSlug}/copiloto`, tema: "Ocupación e ingresos", pregunta: "¿Cómo va la ocupación esta semana?", post: "/chat-datos", respuesta: "Esta semana tu ocupación fue 73%", fuente: "Cargos de hospedaje del folio e inventario por día" },
  { nombre: "despachos", objetivo: "despachos", rol: "admin", ruta: `/despachos/${despachos.orgSlug}/copiloto`, tema: "Cobranza", pregunta: "¿Cuánto me deben mis clientes hoy?", post: "/chat-datos", respuesta: "Tus clientes te deben $120,000 MXN", fuente: "Cuentas por cobrar de CFDI en seguimiento de cobranza, sin pagar" },
  { nombre: "licitaciones", objetivo: "licitaciones", rol: "owner", ruta: `/licitaciones/${licitaciones.orgSlug}/copiloto`, tema: "Oportunidades", pregunta: "¿Qué convocatorias vencen en los próximos 7 días?", post: "/chat-datos", respuesta: "Tienes 7 convocatorias abiertas", fuente: "Convocatorias de la organización con fecha límite vigente" },
  { nombre: "rentas", objetivo: "rentas", rol: "admin", ruta: `/rentas/${rentas.orgSlug}/copiloto`, tema: "Ocupación", pregunta: "¿Cuál fue la ocupación por unidad el mes pasado?", post: "/chat-datos", respuesta: "Este mes ingresaste $53,400 MXN", fuente: "Reservas con llegada en el periodo" },
  { nombre: "superadmin", objetivo: "superadmin", ruta: "/superadmin/copiloto", tema: "", pregunta: "", post: /\/superadmin\/copiloto$/, respuesta: "Hay 6 organizaciones, 5 activas.", fuente: "Organizaciones de la plataforma" },
];

async function capturar(page: Page, nombre: string, proyecto: string): Promise<void> {
  if (!CAPTURAS) return;
  mkdirSync(CAPTURAS, { recursive: true });
  await page.screenshot({ path: join(CAPTURAS, `${proyecto}-despues-${nombre}.png`) });
}

test.describe("copiloto ds3 en todos los ámbitos @copiloto @ds3", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      try {
        window.localStorage.setItem("atiende-diseno", "ds3");
      } catch {
        // sin almacenamiento: falla la afirmacion de la bandera
      }
    });
  });

  for (const a of AMBITOS) {
    test(`${a.nombre}: temas de su vertical, respuesta con «Cómo se calculó» y historial en Drawer`, async ({ page, iniciarSesion, mock, vigilante }, info) => {
      await iniciarSesion(a.objetivo, a.rol);
      await page.goto(a.ruta);
      await afirmarPantallaSana(page, "copiloto");
      await expect(page.locator("html")).toHaveAttribute("data-diseno", "ds3");
      await expect(page.getByRole("heading", { level: 1, name: "Pregúntale a tus datos" })).toBeVisible();

      const temas = page.getByTestId("copiloto-temas");
      await expect(temas).toBeVisible();
      const primerTema = temas.locator("button[aria-pressed]").first();
      await expect(primerTema).toHaveAttribute("aria-pressed", "true");
      if (a.tema) await expect(primerTema).toHaveText(a.tema);
      const pregunta = a.pregunta ? temas.getByRole("button", { name: a.pregunta, exact: true }) : temas.locator("[data-pregunta]").first();
      await expect(pregunta).toBeVisible();
      await capturar(page, `${a.nombre}-portada`, info.project.name);
      await pregunta.click();

      const hilo = page.getByRole("log", { name: "Conversación con el Copiloto" });
      await expect(hilo.getByText(a.respuesta)).toBeVisible();
      await expect.poll(async () => (await mock.buscar({ metodo: "POST", ruta: a.post })).length).toBe(1);

      await hilo.getByRole("button", { name: "Ver cómo lo calculé" }).first().click();
      const calculo = page.getByRole("dialog", { name: /Cómo se calculó/ });
      await expect(calculo).toBeVisible();
      await expect(calculo.getByText(a.fuente)).toBeVisible();
      await capturar(page, `${a.nombre}-como-se-calculo`, info.project.name);
      await page.keyboard.press("Escape");
      await expect(calculo).toBeHidden();

      await page.getByRole("button", { name: "Historial de chats" }).click();
      const panel = page.getByRole("dialog", { name: "Historial de chats" });
      await expect(panel).toBeVisible();
      await expect(panel.getByText("1 chat guardado en tu cuenta")).toBeVisible();
      await expect(panel.getByRole("heading", { name: "Hoy" })).toBeVisible();
      await capturar(page, `${a.nombre}-historial`, info.project.name);
      await page.keyboard.press("Escape");
      await expect(panel).toHaveCount(0);
      vigilante.verificar();
    });
  }

  test("restaurantes por rol: el staff no ve el tema «CFO»; el dueño sí", async ({ page, iniciarSesion }) => {
    const ruta = `/restaurantes/${restaurantes.orgSlug}/copiloto`;
    await iniciarSesion("restaurantes", "staff");
    await page.goto(ruta);
    await afirmarPantallaSana(page, "copiloto");
    const temas = page.getByTestId("copiloto-temas");
    await expect(temas.getByRole("button", { name: "Ventas", exact: true })).toBeVisible();
    await expect(temas.getByRole("button", { name: "CFO", exact: true })).toHaveCount(0);

    await iniciarSesion("restaurantes", "owner");
    await page.goto(ruta);
    await afirmarPantallaSana(page, "copiloto");
    await expect(page.getByTestId("copiloto-temas").getByRole("button", { name: "CFO", exact: true })).toBeVisible();
  });

  test("un rol sin Copiloto ve el estado honesto «Sin acceso» también con la bandera (sin temas ni compositor)", async ({ page, iniciarSesion }) => {
    await iniciarSesion("hoteles", "staff");
    await page.goto(`/hoteles/${hoteles.orgSlug}/copiloto`);
    await expect(page.getByText("Sin acceso")).toBeVisible();
    await expect(page.getByTestId("copiloto-temas")).toHaveCount(0);
    await expect(page.getByRole("form", { name: "Preguntar al Copiloto" })).toHaveCount(0);
  });
});
