// Humo de paginas publicas (sin sesion): selector de vertical, login de las 6 verticales, legales y 404.
import { ClienteMock } from "../mock-api/cliente.ts";
import { VERTICALES } from "../mock-api/personas.ts";
import { afirmarUnSoloMain } from "../helpers/ds.ts";
import { expect, test, URL_API } from "../helpers/fixtures.ts";

test.describe("publicas @humo", () => {
  test("selector de vertical: ofrece las 6 verticales y enlaza a su login", async ({ page, vigilante }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "¿A qué negocio quieres entrar?" })).toBeVisible();
    for (const v of VERTICALES) {
      await expect(page.locator(`a[href="/${v}/login"]`)).toBeVisible();
    }
    await afirmarUnSoloMain(page);
    vigilante.verificar();
  });

  for (const v of VERTICALES) {
    test(`login de ${v}: carga, Google honesto (pendiente) y ruta protegida redirige`, async ({ page, vigilante }) => {
      await page.goto(`/${v}/login`);
      await expect(page.getByRole("heading", { level: 1 })).toContainText(`atiende ${v}`);
      // El mock reporta Google sin configurar: el boton debe estar deshabilitado con explicacion, no fingir que funciona.
      await expect(page.getByRole("button", { name: "Continuar con Google" })).toBeDisabled();
      await expect(page.getByText("Google: pendiente de configurar en este entorno.")).toBeVisible();
      await expect(page.getByRole("button", { name: "Continuar con correo" })).toBeEnabled();
      await afirmarUnSoloMain(page);

      // Sin sesion, una ruta del panel vuelve al login de su vertical (nunca renderiza el shell sin sesion).
      await page.goto(`/${v}/algun-negocio-que-no-existe`);
      await expect(page).toHaveURL(new RegExp(`/${v}/login$`));
      vigilante.verificar();
    });
  }

  test("magic link: correo invalido se rechaza en el cliente; uno valido muestra el aviso y hace un POST", async ({ page, vigilante }) => {
    const correo = `prueba.${Date.now().toString(36)}@example.test`;
    await page.goto("/citas/login");
    const campo = page.getByRole("textbox", { name: /correo/i });
    await campo.fill("no-es-un-correo");
    await page.getByRole("button", { name: "Continuar con correo" }).click();
    await expect(page.getByText("Escribe un correo válido")).toBeVisible();

    await campo.fill(correo);
    await page.getByRole("button", { name: "Continuar con correo" }).click();
    await expect(page.getByRole("status")).toContainText(correo);
    // Las peticiones sin sesion se registran en el escenario "anon": se filtra por el correo unico de esta prueba.
    const anon = new ClienteMock(URL_API, "anon");
    const enviados = (await anon.buscar({ metodo: "POST", ruta: "/auth/magic-link/iniciar" })).filter((p) => JSON.stringify(p.cuerpo).includes(correo));
    expect(enviados).toHaveLength(1);
    vigilante.verificar();
  });

  test("terminos, privacidad y 404 cargan con un solo <main>", async ({ page, vigilante }) => {
    await page.goto("/terminos");
    await expect(page.getByRole("heading", { name: "Términos de Servicio" })).toBeVisible();
    await afirmarUnSoloMain(page);
    await page.goto("/privacidad");
    await expect(page.getByRole("heading", { name: "Aviso de Privacidad" })).toBeVisible();
    await afirmarUnSoloMain(page);
    await page.goto("/esta-ruta-no-existe");
    await expect(page.getByRole("heading", { name: "No encontramos esta página" })).toBeVisible();
    vigilante.verificar();
  });
});
