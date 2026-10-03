// Humo de paginas publicas (sin sesion): selector de vertical, login de las 6 verticales, legales y 404.
import { ClienteMock } from "../mock-api/cliente.ts";
import { orgDe, VERTICALES } from "../mock-api/personas.ts";
import { CONTRASENA_ACTUAL, TOKEN_RESTABLECER, TOKEN_VERIFICAR } from "../mock-api/fixtures/cuenta.ts";
import { afirmarSinScrollHorizontal, afirmarUnSoloMain } from "../helpers/ds.ts";
import { abrirDialogo, cerrarConCancelar, cerrarConEscape } from "../helpers/dialogos.ts";
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

  // --- PL-21: cuenta de staff en las 6 verticales (API simulada de e2e/mock-api/fixtures/cuenta.ts) ----------------

  for (const v of VERTICALES) {
    test(`login de ${v}: olvide mi contrasena -> aviso uniforme (no confirma la cuenta) y manda la vertical`, async ({ page, vigilante }) => {
      const correo = `olvido.${v}.${Date.now().toString(36)}@example.test`;
      await page.goto(`/${v}/login`);
      await page.getByRole("button", { name: "¿Olvidaste tu contraseña?" }).click();
      await expect(page.getByText("Restablece tu contraseña")).toBeVisible();
      await page.getByRole("textbox", { name: /correo/i }).fill(correo);
      await page.getByRole("button", { name: "Enviarme el enlace" }).click();
      const aviso = page.getByRole("status");
      await expect(aviso).toContainText(`Si ${correo} tiene una cuenta`);
      await expect(aviso).not.toContainText(/no existe|no encontr/i);
      const anon = new ClienteMock(URL_API, "anon");
      const enviados = (await anon.buscar({ metodo: "POST", ruta: "/auth/password-reset/solicitar" })).filter((p) => JSON.stringify(p.cuerpo).includes(correo));
      expect(enviados).toHaveLength(1);
      expect(enviados[0]!.cuerpo).toEqual({ email: correo, vertical: v });
      await page.getByRole("button", { name: "Volver a iniciar sesión" }).click();
      await expect(page.getByRole("button", { name: "Continuar con correo" })).toBeVisible();
      vigilante.verificar();
    });
  }

  for (const v of VERTICALES) {
    test(`restablecer contrasena en ${v}: con token valido guarda; el token sale de la URL`, async ({ page, vigilante }) => {
      await page.goto(`/${v}/restablecer-contrasena?token=${TOKEN_RESTABLECER}`);
      await expect(page.getByRole("heading", { level: 1, name: "Elige una contraseña nueva" })).toBeVisible();
      await expect(page).toHaveURL(new RegExp(`/${v}/restablecer-contrasena$`));
      await afirmarUnSoloMain(page);
      await page.getByLabel(/Contraseña nueva/).fill("nueva-clave-e2e-456");
      await page.getByLabel(/Repite la contraseña nueva/).fill("nueva-clave-e2e-456");
      await page.getByRole("button", { name: "Guardar contraseña" }).click();
      await expect(page.getByRole("heading", { level: 1, name: "Contraseña actualizada" })).toBeVisible();
      await expect(page.getByRole("link", { name: "Ir a iniciar sesión" })).toHaveAttribute("href", `/${v}/login`);
      vigilante.verificar();
    });
  }

  test("restablecer contrasena: contrasenas distintas no llegan al servidor; un enlace vencido muestra el error del servidor", async ({ page, vigilante }) => {
    await page.goto("/citas/restablecer-contrasena?token=token-vencido");
    await page.getByLabel(/Contraseña nueva/).fill("nueva-clave-e2e-456");
    await page.getByLabel(/Repite la contraseña nueva/).fill("otra-cosa-e2e-789");
    await page.getByRole("button", { name: "Guardar contraseña" }).click();
    await expect(page.getByText("Las contraseñas no coinciden.")).toBeVisible();
    await page.getByLabel(/Repite la contraseña nueva/).fill("nueva-clave-e2e-456");
    await page.getByRole("button", { name: "Guardar contraseña" }).click();
    await expect(page.getByText("ya se usó o expiró")).toBeVisible();
    await page.goto("/citas/restablecer-contrasena");
    await expect(page.getByRole("heading", { level: 1, name: "Enlace incompleto" })).toBeVisible();
    await expect(page.getByLabel(/Contraseña nueva/)).toHaveCount(0);
    vigilante.verificar();
  });

  for (const v of VERTICALES) {
    test(`verificar correo en ${v}: el enlace valido confirma y vuelve al login de la vertical`, async ({ page, vigilante }) => {
      await page.goto(`/${v}/verificar-correo?token=${TOKEN_VERIFICAR}`);
      await expect(page.getByRole("status")).toContainText("Tu correo quedó verificado.");
      await expect(page.getByRole("link", { name: "Ir a iniciar sesión" })).toHaveAttribute("href", `/${v}/login`);
      vigilante.verificar();
    });
  }

  test("verificar correo: un enlace invalido muestra el error del servidor", async ({ page, vigilante }) => {
    await page.goto("/hoteles/verificar-correo?token=token-invalido");
    await expect(page.getByText("ya se usó o expiró")).toBeVisible();
    await expect(page.getByText("Tu correo quedó verificado.")).toHaveCount(0);
    vigilante.verificar();
  });

  test("seguridad de la cuenta (citas): sesiones activas, cerrar una pide confirmacion y Cancelar no escribe", async ({ page, mock, iniciarSesion, vigilante }) => {
    await iniciarSesion("citas");
    await page.goto(`/citas/${orgDe("citas").slug}/seguridad`);
    await expect(page.getByRole("heading", { level: 1, name: "Seguridad de la cuenta" })).toBeVisible();
    await expect(page.getByText("Chrome en macOS")).toBeVisible();
    await expect(page.getByText("Este dispositivo")).toBeVisible();
    await expect(page.getByText("Safari en iOS")).toBeVisible();
    // Verificacion en dos pasos solo existe en licitaciones: aqui no se finge.
    await expect(page.getByText("Verificación en dos pasos")).toHaveCount(0);
    await afirmarSinScrollHorizontal(page);

    // Cancelar y Escape cierran el dialogo SIN llamar al servidor (el helper de escrituras ignora /auth/*: se mira directo).
    const cerrar = page.getByRole("button", { name: "Cerrar sesión", exact: true });
    await mock.limpiarRegistro();
    await cerrarConCancelar(await abrirDialogo(page, cerrar, /Cerrar la sesión de/));
    await cerrarConEscape(page, await abrirDialogo(page, cerrar, /Cerrar la sesión de/));
    expect(await mock.buscar({ metodo: "POST", ruta: "/auth/sessions/cerrar" })).toHaveLength(0);
    await page.getByRole("button", { name: "Cerrar sesión", exact: true }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Cerrar sesión" }).click();
    await expect(page.getByText("Sesión cerrada.")).toBeVisible();
    await expect(page.getByText("Safari en iOS")).toHaveCount(0);
    vigilante.verificar();
  });

  test("seguridad de la cuenta (citas): cambiar la contrasena con la actual incorrecta muestra el error real; con la correcta confirma", async ({ page, iniciarSesion, vigilante }) => {
    await iniciarSesion("citas");
    await page.goto(`/citas/${orgDe("citas").slug}/seguridad`);
    await page.getByLabel("Contraseña actual").fill("equivocada-e2e");
    await page.getByLabel(/Contraseña nueva \(mínimo/).fill("nueva-clave-e2e-456");
    await page.getByLabel("Repite la contraseña nueva").fill("nueva-clave-e2e-456");
    await page.getByRole("button", { name: "Cambiar contraseña" }).click();
    await expect(page.getByText("La contraseña actual no es correcta.")).toBeVisible();
    await page.getByLabel("Contraseña actual").fill(CONTRASENA_ACTUAL);
    await page.getByRole("button", { name: "Cambiar contraseña" }).click();
    await expect(page.getByText("Contraseña actualizada. Se cerraron tus otras sesiones")).toBeVisible();
    vigilante.verificar();
  });

  for (const v of ["restaurantes", "hoteles", "rentas", "despachos", "citas"] as const) {
    test(`el menu del shell de ${v} lleva a Seguridad de la cuenta`, async ({ page, iniciarSesion, vigilante }, info) => {
      test.skip(info.project.name.startsWith("movil"), "En movil el destino vive en la hoja Más (lo cubre shells-categorias); este recorrido usa el pie del Sidebar de escritorio");
      await iniciarSesion(v, v === "rentas" ? "admin" : "owner");
      await page.getByRole("complementary").getByRole("link", { name: "Seguridad de la cuenta" }).click();
      await expect(page).toHaveURL(new RegExp(`/${v}/${orgDe(v).slug}/seguridad$`));
      await expect(page.getByRole("heading", { level: 1, name: "Seguridad de la cuenta" })).toBeVisible();
      vigilante.verificar();
    });
  }

  test("capturas: login, olvide mi contrasena y 404 en claro, oscuro y movil (adjuntas) @oscuro", async ({ page, vigilante }, info) => {
    await page.goto("/citas/login");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("atiende citas");
    await afirmarSinScrollHorizontal(page);
    await page.waitForTimeout(1300); // la entrada escalonada termina (login-entra)
    await info.attach(`login-${info.project.name}.png`, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
    await page.getByRole("button", { name: "¿Olvidaste tu contraseña?" }).click();
    await page.waitForTimeout(900);
    await info.attach(`olvido-${info.project.name}.png`, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
    await page.goto("/restablecer-no-existe");
    await afirmarSinScrollHorizontal(page);
    await info.attach(`404-${info.project.name}.png`, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
    vigilante.verificar();
  });
});
