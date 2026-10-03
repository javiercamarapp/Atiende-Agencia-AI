// UNI-RES-citas: Resumen de citas de punta a punta contra la API simulada (e2e/mock-api/fixtures/citas.ts): saludo, destacado
// "Citas hoy", KPIs, tiles de agentes con cifras sembradas, rol staff sin tiles de agentes, un solo h1, sin desborde horizontal,
// barra inferior en movil. Las pruebas @oscuro corren tambien en los proyectos oscuros. Con CAPTURAS_RESUMEN=1 guarda capturas en
// docs/diseno-ux-capturas-uni-res-citas/ (nunca en CI).
import { expect, test } from "../helpers/fixtures.ts";
import { afirmarSinScrollHorizontal } from "../helpers/ds.ts";
import { afirmarPantallaSana } from "../helpers/humo.ts";
import { barraMovil, esMovil } from "../helpers/navegacion.ts";
import { citas } from "../mock-api/fixtures/citas.ts";

const RUTA = `/citas/${citas.orgSlug}/resumen`;

test.describe("resumen de citas @resumen", () => {
  test("owner: saludo, destacado, KPIs y tiles de agentes con las cifras del API @oscuro", async ({ page, iniciarSesion, mock, vigilante }, info) => {
    await iniciarSesion("citas", "owner");
    await page.goto(RUTA);
    await afirmarPantallaSana(page, "resumen citas");

    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(/^(Buenos días|Buenas tardes|Buenas noches), /);
    await expect(page.getByTestId("odometro")).toContainText("Citas hoy");
    const kpi = (nombre: string) => page.getByRole("link", { name: new RegExp(nombre) }).first();
    await expect(kpi("Citas esta semana")).toContainText("9");
    await expect(kpi("Por confirmar")).toContainText("3");
    await expect(kpi("No asistieron")).toContainText("1");
    await expect(kpi("Clientes nuevos")).toContainText("12");
    await expect(page.getByRole("region", { name: "Orquestación de agentes" })).toBeVisible();
    await expect(page.getByRole("link", { name: /Agente de WhatsApp/ })).toContainText("23 citas creadas por WhatsApp (30 días)");
    await expect(page.getByRole("link", { name: /Agente de WhatsApp/ })).toContainText("Conectado");
    await expect(page.getByRole("link", { name: /Recordatorios 24 h/ })).toContainText("13 enviados · 3 fallidos (7 días)");
    await expect(page.getByRole("link", { name: /^Voz/ })).toContainText("6 citas creadas por voz (30 días)");
    await expect(page.getByTestId("sin-datos-corrida")).toContainText("registro de corridas");
    await expect(page.getByRole("link", { name: /Ver agenda/ })).toHaveAttribute("href", `/citas/${citas.orgSlug}/agenda`);
    await afirmarSinScrollHorizontal(page);

    if (process.env.CAPTURAS_RESUMEN === "1") {
      await page.screenshot({ path: `../../docs/diseno-ux-capturas-uni-res-citas/${info.project.name}-resumen.png`, fullPage: true });
    }
    expect((await mock.buscar({ metodo: "GET", ruta: /\/resumen$/ })).length).toBeGreaterThan(0);
    vigilante.verificar();
  });

  test("movil: la barra inferior sigue visible y el contenido no queda tapado", async ({ page, iniciarSesion, vigilante }) => {
    test.skip(!esMovil(page), "la barra inferior es solo de movil");
    await iniciarSesion("citas", "owner");
    await page.goto(RUTA);
    await afirmarPantallaSana(page, "resumen citas movil");
    await expect(barraMovil(page)).toBeVisible();
    await afirmarSinScrollHorizontal(page);
    vigilante.verificar();
  });

  test("staff: ve los conteos de citas pero no los tiles de agentes ni dispara sus lecturas", async ({ page, iniciarSesion, mock, vigilante }) => {
    await iniciarSesion("citas", "staff");
    await page.goto(RUTA);
    await afirmarPantallaSana(page, "resumen citas staff");
    await expect(page.getByRole("link", { name: /Citas esta semana/ }).first()).toBeVisible();
    await expect(page.getByText("Orquestación de agentes")).toHaveCount(0);
    expect(await mock.buscar({ metodo: "GET", ruta: /\/admin\/(avisos|whatsapp-agente)$/ })).toHaveLength(0);
    vigilante.verificar();
  });
});
