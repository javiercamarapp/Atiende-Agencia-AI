// Viaje completo ENCADENADO de un dia de restaurante, con DOS sesiones (owner y repartidor) contra el mismo escenario del mock:
// owner revisa Primeros pasos -> crea un producto -> toma el pedido nuevo (preparando) -> asigna repartidor -> el repartidor (otra
// sesion) lo marca en camino y entregado -> el owner lo ve en Historial -> consulta el Copiloto -> cierra sesion.
import { expect, test } from "../../helpers/fixtures.ts";
import type { Page } from "../../helpers/fixtures.ts";
import { cuerpoDe, esperarEscrituras, ir, BASE } from "../../helpers/recorrido.ts";
import { personaDe } from "../../mock-api/personas.ts";
import { elegirValor, elegirEtiqueta } from "../../helpers/listas.ts";

const main = (page: Page) => page.locator("main#contenido-principal");

test.describe("restaurantes: viaje completo de un pedido @viaje", () => {
  test("owner y repartidor: del producto nuevo a la entrega, el Historial y el Copiloto", async ({ page, browser, iniciarSesion, mock, vigilante }, info) => {
    await iniciarSesion("restaurantes", "owner");

    // 1. Primeros pasos: la lista de arranque dice que falta (checklist real del mock) y enlaza a la pantalla de origen.
    await ir(page, "/primeros-pasos");
    await expect(page.getByText("Faltan puntos obligatorios")).toBeVisible();

    // 2. Crea un producto: POST real y aparece en el catalogo.
    await ir(page, "/productos");
    await main(page).getByRole("button", { name: "Nuevo producto" }).click();
    const form = page.getByRole("dialog", { name: "Nuevo producto" });
    await form.getByLabel("Nombre").fill("Taco de cochinita");
    await form.getByLabel("Precio base").fill("38");
    await form.getByRole("button", { name: "Crear producto" }).click();
    const [creado] = await esperarEscrituras(mock, { metodo: "POST", ruta: "/products" });
    expect(cuerpoDe(creado)).toMatchObject({ name: "Taco de cochinita", price: 38 });
    await expect(main(page).getByText("Taco de cochinita")).toBeVisible();

    // 3. Pedido nuevo (fixture ord-1001, pendiente): lo pasa a preparando y le asigna repartidor.
    await ir(page, "/pedidos");
    const tarjeta = main(page).locator("div.card, [class*=card]").filter({ hasText: "Marisol Pech" }).first();
    await expect(tarjeta).toBeVisible();
    await mock.limpiarRegistro();
    await tarjeta.getByRole("button", { name: "Marcar Preparando" }).click();
    const [estado] = await esperarEscrituras(mock, { metodo: "PATCH", ruta: "/orders/ord-1001/status" });
    expect(cuerpoDe(estado)).toEqual({ status: "preparando" });
    await elegirEtiqueta(page.getByLabel("Repartidor:").first(), "Ramon Uc");
    const [asignado] = await esperarEscrituras(mock, { metodo: "PATCH", ruta: "/orders/ord-1001/assign-repartidor" });
    expect(cuerpoDe(asignado)).toMatchObject({ repartidorId: "usr-2" });

    // 4. Otra sesion: el repartidor ve el pedido en Mis entregas y lo marca en camino y entregado.
    const contexto = await browser.newContext({ baseURL: info.project.use.baseURL ?? "", locale: "es-MX", timezoneId: "America/Merida", viewport: info.project.use.viewport ?? null, colorScheme: info.project.use.colorScheme ?? "light" });
    try {
      const otra = await contexto.newPage();
      const persona = personaDe("restaurantes", "repartidor");
      await otra.goto(`/restaurantes/auth/google/callback?code=${encodeURIComponent(mock.codigoLogin(persona.id))}`);
      await expect(otra.getByRole("heading", { name: "Mis entregas" })).toBeVisible();
      await expect(otra).toHaveURL(new RegExp(`${BASE}/repartidor$`));
      // Mis entregas lista primero lo activo en el orden del servidor: el pedido recien asignado (ord-1001) queda ULTIMO entre los
      // activos, asi que su boton es el ultimo de cada tipo (las entregas sembradas de Marisol y Jorge van antes).
      await otra.getByRole("button", { name: "Marcar en camino" }).last().click();
      const enCamino = await esperarEscrituras(mock, { metodo: "PATCH", ruta: "/repartidor/orders/ord-1001/status" });
      expect(cuerpoDe(enCamino[0])).toMatchObject({ status: "en_camino" });
      // La lista se recarga tras el PATCH: se espera a que el pedido aparezca "En camino" (2 botones: Jorge y el nuestro) antes de elegir.
      await expect(otra.getByRole("button", { name: "Marcar entregado" })).toHaveCount(2);
      await otra.getByRole("button", { name: "Marcar entregado" }).last().click();
      await expect.poll(async () => (await mock.buscar({ metodo: "PATCH", ruta: "/repartidor/orders/ord-1001/status" })).length).toBe(2);
      const todas = await mock.buscar({ metodo: "PATCH", ruta: "/repartidor/orders/ord-1001/status" });
      expect(cuerpoDe(todas[1])).toMatchObject({ status: "entregado" });
    } finally {
      await contexto.close();
    }

    // 5. El owner lo ve entregado en el Historial (el mismo pedido, visto desde el panel).
    await ir(page, "/historial");
    await elegirValor(page.getByLabel("Estado"), "entregado");
    await expect(main(page).getByText("Marisol Pech").first()).toBeVisible();
    await expect(main(page).getByText("Jorge Canul")).toHaveCount(0);

    // 6. Consulta el Copiloto.
    await ir(page, "/copiloto");
    await page.getByRole("button", { name: "¿Cuánto vendí esta semana?" }).click();
    await expect(page.getByText("En los últimos 7 días vendiste")).toBeVisible();

    // 7. Cierra sesion y vuelve al login de restaurantes.
    // En movil el menu de cuenta es una hoja que se abre con el boton de usuario.
    const cuenta = page.getByRole("button", { name: "Abrir menú de cuenta" });
    if (await cuenta.isVisible()) await cuenta.click();
    await page.getByRole("button", { name: "Cerrar sesión" }).click();
    await expect(page).toHaveURL(/\/restaurantes\/login/);
    vigilante.verificar();
  });
});
