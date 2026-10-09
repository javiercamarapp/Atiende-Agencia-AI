// Recorrido de CONTROLES del panel de restaurantes (inventario docs/diseno-ux-recorrido-botones-restaurantes.md): cada control
// ejecuta su camino feliz y la prueba afirma la peticion REAL al mock (metodo, ruta y cuerpo) y el estado de exito en pantalla.
// Los estados de error (EstadoError + Reintentar) y los dialogos van en recorrido-restaurantes-errores/dialogos.spec.ts.
import type { Page } from "@playwright/test";
import { dialogo } from "../../helpers/dialogos.ts";
import { expect, test } from "../../helpers/fixtures.ts";
import { cuerpoDe, esperarEscrituras, ir } from "../../helpers/recorrido.ts";
import { elegirEtiqueta } from "../../helpers/listas.ts";

const main = (page: Page) => page.locator("main#contenido-principal");

test.describe("restaurantes: controles, camino feliz @recorrido", () => {
  test.beforeEach(async ({ iniciarSesion }) => {
    await iniciarSesion("restaurantes", "owner");
  });

  test("Resumen: cambia el periodo y Actualizar vuelven a pedir los KPIs", async ({ page, mock, vigilante }) => {
    await ir(page, "");
    await expect(main(page).getByText("Número de órdenes")).toBeVisible();
    await mock.limpiarRegistro();
    await main(page).getByText("7 días", { exact: true }).click();
    await expect.poll(async () => (await mock.buscar({ metodo: "GET", ruta: "/kpis/sales" })).length).toBeGreaterThan(0);
    const antes = (await mock.buscar({ metodo: "GET", ruta: "/kpis/sales" })).length;
    await main(page).getByRole("button", { name: "Actualizar" }).click();
    await expect.poll(async () => (await mock.buscar({ metodo: "GET", ruta: "/kpis/sales" })).length).toBeGreaterThan(antes);
    vigilante.verificar();
  });

  test("Pedidos: Marcar Preparando hace un PATCH de estado y la fila cambia", async ({ page, mock, vigilante }) => {
    await ir(page, "/pedidos");
    const tarjeta = main(page).locator('[data-testid^="pedido-"]').filter({ hasText: "Marisol Pech" }).first();
    await expect(tarjeta).toBeVisible();
    await mock.limpiarRegistro();
    await tarjeta.getByRole("button", { name: "Marcar Preparando" }).click();
    const [patch] = await esperarEscrituras(mock, { metodo: "PATCH", ruta: "/orders/ord-1001/status" });
    expect(cuerpoDe(patch)).toEqual({ status: "preparando" });
    await expect(tarjeta.getByRole("button", { name: "Asignar repartidor" })).toBeVisible();
    await expect(tarjeta.getByTestId("estado-ord-1001")).toHaveText("Preparando");
    vigilante.verificar();
  });

  test("Pedidos: Asignar repartidor + Asignar hace un PATCH assign-repartidor (un pedido recien recibido aun no sale: solo se asigna)", async ({ page, mock, vigilante }) => {
    await ir(page, "/pedidos");
    const fila = main(page).locator('[data-testid^="pedido-"]').filter({ hasText: "Marisol Pech" }).first();
    await mock.limpiarRegistro();
    await fila.getByRole("button", { name: "Asignar repartidor" }).click();
    await elegirEtiqueta(fila.getByLabel("Elegir repartidor"), "Ramon Uc");
    await fila.getByRole("button", { name: "Asignar", exact: true }).click();
    const [patch] = await esperarEscrituras(mock, { metodo: "PATCH", ruta: "/orders/ord-1001/assign-repartidor" });
    expect(cuerpoDe(patch)).toMatchObject({ repartidorId: "usr-2" });
    expect(await mock.buscar({ metodo: "PATCH", ruta: "/orders/ord-1001/status" })).toHaveLength(0);
    vigilante.verificar();
  });

  test("Pedidos: los filtros de estado y Actualizar ahora piden con GET real", async ({ page, mock, vigilante }) => {
    await ir(page, "/pedidos");
    await mock.limpiarRegistro();
    await main(page).getByRole("button", { name: "Preparando", exact: true }).click();
    await expect(main(page).getByText("Jorge Canul").first()).toBeVisible();
    await expect(main(page).getByText("Marisol Pech")).toHaveCount(0);
    await expect.poll(async () => (await mock.buscar({ metodo: "GET", ruta: "/orders?status=preparando" })).length).toBeGreaterThan(0);
    // "Actualizar ahora" fuerza el sondeo liviano de pendientes (la lista completa solo se recarga si cambio el conjunto).
    const previas = (await mock.buscar({ metodo: "GET", ruta: "/orders?status=pending" })).length;
    await main(page).getByRole("button", { name: "Herramientas de pedidos" }).click();
    await page.getByRole("button", { name: "Actualizar ahora" }).click();
    await expect.poll(async () => (await mock.buscar({ metodo: "GET", ruta: "/orders?status=pending" })).length).toBeGreaterThan(previas);
    vigilante.verificar();
  });

  test("Pedidos: Vista previa del ticket de cocina abre un dialogo con el pedido", async ({ page, vigilante }) => {
    await ir(page, "/pedidos");
    await main(page).getByRole("button", { name: "Vista previa" }).first().click();
    await expect(dialogo(page)).toBeVisible();
    await expect(dialogo(page)).toContainText("Marisol Pech");
    await page.keyboard.press("Escape");
    await expect(dialogo(page)).toBeHidden();
    vigilante.verificar();
  });

  test("Historial: el filtro por estado vuelve a pedir las ordenes con ese estado", async ({ page, mock, vigilante }) => {
    await ir(page, "/historial");
    await expect(main(page).getByText("Marisol Pech").first()).toBeVisible();
    await mock.limpiarRegistro();
    await page.getByLabel("Estado").selectOption("completado");
    await expect.poll(async () => (await mock.buscar({ metodo: "GET", ruta: "status=completado" })).length).toBeGreaterThan(0);
    await expect(main(page).getByText("Jorge Canul")).toHaveCount(0);
    vigilante.verificar();
  });

  test("Productos: Nueva categoria y Nuevo producto crean con POST real y aparecen en el catalogo", async ({ page, mock, vigilante }) => {
    await ir(page, "/productos");
    await main(page).getByRole("button", { name: "Nueva categoría" }).click();
    let d = dialogo(page, "Nueva categoría");
    await d.getByLabel("Nombre").fill("Postres");
    await d.getByLabel("Slug").fill("postres");
    await d.getByRole("button", { name: "Crear categoría" }).click();
    const [cat] = await esperarEscrituras(mock, { metodo: "POST", ruta: "/categories" });
    expect(cuerpoDe(cat)).toMatchObject({ name: "Postres", slug: "postres" });
    await expect(d).toBeHidden();

    await main(page).getByRole("button", { name: "Nuevo producto" }).click();
    d = dialogo(page, "Nuevo producto");
    await d.getByLabel("Nombre").fill("Flan napolitano");
    await d.getByLabel("Precio base").fill("55");
    await d.getByRole("button", { name: "Crear producto" }).click();
    const [prod] = await esperarEscrituras(mock, { metodo: "POST", ruta: "/products" });
    expect(cuerpoDe(prod)).toMatchObject({ name: "Flan napolitano", price: 55 });
    await expect(main(page).getByText("Flan napolitano")).toBeVisible();
    vigilante.verificar();
  });

  test("Productos: precio por sucursal, Disponible, Popular y no a domicilio hacen su PATCH/PUT", async ({ page, mock, vigilante }) => {
    await ir(page, "/productos");
    await mock.limpiarRegistro();
    const precio = page.getByLabel("Precio de Horchata en esta sucursal");
    await precio.fill("52");
    await precio.blur();
    const [p1] = await esperarEscrituras(mock, { metodo: "PATCH", ruta: "/products/p-2/branch-availability" });
    expect(cuerpoDe(p1)).toMatchObject({ price: 52 });

    await mock.limpiarRegistro();
    await page.locator("tr, li").filter({ hasText: "Horchata" }).getByRole("button", { name: /^(Disponible|No disponible)$/ }).click();
    const [pd] = await esperarEscrituras(mock, { metodo: "PATCH", ruta: "/products/p-2/branch-availability" });
    expect(cuerpoDe(pd)).toHaveProperty("isAvailable");

    await mock.limpiarRegistro();
    await page.getByLabel("Marcar Horchata como popular").click();
    const [p2] = await esperarEscrituras(mock, { metodo: "PATCH", ruta: "/products/p-2" });
    expect(cuerpoDe(p2)).toMatchObject({ isPopular: true });

    await mock.limpiarRegistro();
    await page.getByLabel("Horchata: no se vende a domicilio").click();
    const [p3] = await esperarEscrituras(mock, { metodo: "PUT", ruta: "/config/no-domicilio/productos/p-2" });
    expect(cuerpoDe(p3)).toEqual({ noDomicilio: true });
    vigilante.verificar();
  });

  test("Promociones: crear un codigo y Desactivar/Activar hacen POST y PATCH", async ({ page, mock, vigilante }) => {
    await ir(page, "/promociones");
    await main(page).getByRole("button", { name: "Crear un código nuevo" }).click();
    const d = dialogo(page, "Crear un código nuevo");
    await d.getByLabel("Código", { exact: true }).fill("TACOS20");
    await d.getByLabel("Nombre para el staff").fill("Martes de tacos");
    await d.getByLabel("Valor", { exact: true }).fill("20");
    await d.getByRole("button", { name: "Crear código" }).click();
    const [crear] = await esperarEscrituras(mock, { metodo: "POST", ruta: "/promotions" });
    expect(cuerpoDe(crear)).toMatchObject({ code: "TACOS20", name: "Martes de tacos", value: 20 });
    await expect(main(page).getByText("TACOS20")).toBeVisible();

    await mock.limpiarRegistro();
    await main(page).getByRole("button", { name: "Desactivar", exact: true }).first().click();
    const [off] = await esperarEscrituras(mock, { metodo: "PATCH", ruta: "/promotions/promo-1" });
    expect(cuerpoDe(off)).toEqual({ isActive: false });
    await expect(main(page).getByRole("button", { name: "Activar", exact: true })).toBeVisible();

    await mock.limpiarRegistro();
    await main(page).getByRole("button", { name: "Activar", exact: true }).click();
    const [on] = await esperarEscrituras(mock, { metodo: "PATCH", ruta: "/promotions/promo-1" });
    expect(cuerpoDe(on)).toEqual({ isActive: true });
    vigilante.verificar();
  });

  test("Clientes: la busqueda pide customers?search= y la fila abre la ficha", async ({ page, mock, vigilante }) => {
    await ir(page, "/clientes");
    await mock.limpiarRegistro();
    await page.getByLabel("Buscar").fill("Marisol");
    await expect.poll(async () => (await mock.buscar({ metodo: "GET", ruta: "search=Marisol" })).length).toBeGreaterThan(0);
    await main(page).getByRole("link", { name: /Marisol Pech/ }).click();
    await expect(page.getByRole("heading", { name: "Marisol Pech" })).toBeVisible();
    await main(page).getByRole("link", { name: "Volver a clientes" }).click();
    await expect(page).toHaveURL(/\/clientes$/);
    vigilante.verificar();
  });

  test("Sucursales: Editar, cambiar el telefono y Guardar hace un PATCH; Cancelar descarta", async ({ page, mock, vigilante }) => {
    await ir(page, "/sucursales");
    await main(page).getByRole("button", { name: "Editar" }).click();
    await page.getByLabel("Teléfono").fill("+529995550111");
    await mock.limpiarRegistro();
    await main(page).getByRole("button", { name: "Guardar" }).click();
    const [patch] = await esperarEscrituras(mock, { metodo: "PATCH", ruta: "/sucursales/" });
    expect(cuerpoDe(patch)).toMatchObject({ phone: "+529995550111" });
    await expect(main(page).getByText("+529995550111")).toBeVisible();
    // Cancelar no escribe.
    await main(page).getByRole("button", { name: "Editar" }).click();
    await mock.limpiarRegistro();
    await main(page).getByRole("button", { name: "Cancelar" }).click();
    expect(await mock.escrituras()).toEqual([]);
    vigilante.verificar();
  });

  test("Staff: Invitar crea la invitacion (POST) y Revocar la quita (DELETE); cambiar rol hace PATCH", async ({ page, mock, vigilante }) => {
    await ir(page, "/staff");
    await main(page).getByRole("button", { name: "Invitar a alguien" }).click();
    const d = dialogo(page, "Invitar a alguien nuevo");
    await d.getByLabel("Correo").fill("nuevo.staff@example.test");
    await d.getByRole("button", { name: "Invitar" }).click();
    const [inv] = await esperarEscrituras(mock, { metodo: "POST", ruta: "/staff/invitaciones" });
    expect(cuerpoDe(inv)).toMatchObject({ email: "nuevo.staff@example.test" });
    await expect(main(page).getByText("nuevo.staff@example.test").first()).toBeVisible();

    await mock.limpiarRegistro();
    await page.getByLabel("Rol de Lucia Xool").selectOption("admin");
    const [rol] = await esperarEscrituras(mock, { metodo: "PATCH", ruta: "/staff/miembros/usr-1" });
    expect(cuerpoDe(rol)).toEqual({ verticalRole: "admin" });

    await mock.limpiarRegistro();
    await main(page).getByRole("button", { name: "Revocar" }).click();
    await dialogo(page).getByRole("button", { name: "Revocar" }).click();
    await esperarEscrituras(mock, { metodo: "DELETE", ruta: "/staff/invitaciones/" });
    vigilante.verificar();
  });

  test("Configuracion: guardar WhatsApp y zona horaria (PUT/PATCH), agregar zona (POST)", async ({ page, mock, vigilante }) => {
    await ir(page, "/configuracion");
    await page.locator("#config-whatsapp-phone-number-id, [name=config-whatsapp-phone-number-id]").first().fill("109876543210");
    await mock.limpiarRegistro();
    await page.getByRole("button", { name: "Guardar" }).first().click();
    const [wa] = await esperarEscrituras(mock, { metodo: "PUT", ruta: "/config/whatsapp" });
    expect(cuerpoDe(wa)).toEqual({ phoneNumberId: "109876543210" });

    await mock.limpiarRegistro();
    await page.getByLabel("Nombre", { exact: true }).fill("Itzimna");
    await page.getByLabel("Latitud").fill("21.0100");
    await page.getByLabel("Longitud").fill("-89.6000");
    await page.getByRole("button", { name: "Agregar zona" }).click();
    const [zona] = await esperarEscrituras(mock, { metodo: "POST", ruta: "/config/zonas" });
    expect(cuerpoDe(zona)).toMatchObject({ name: "Itzimna" });
    await expect(main(page).getByText("Itzimna")).toBeVisible();

    await mock.limpiarRegistro();
    await page.getByLabel("Zona horaria de esta sucursal").selectOption("America/Cancun");
    await page.locator("form").filter({ has: page.locator("#config-zona-horaria") }).getByRole("button", { name: "Guardar" }).click();
    const [tz] = await esperarEscrituras(mock, { metodo: "PATCH", ruta: "/config/zona-horaria" });
    expect(cuerpoDe(tz)).toEqual({ zona_horaria: "America/Cancun" });
    vigilante.verificar();
  });

  test("Conversaciones: Tomar conversacion hace POST /tomar y la nota se agrega", async ({ page, mock, vigilante }) => {
    await ir(page, "/conversaciones");
    await main(page).getByRole("button", { name: /WhatsApp · \+529995550101/ }).click();
    await mock.limpiarRegistro();
    await main(page).getByRole("button", { name: "Tomar conversación" }).click();
    await esperarEscrituras(mock, { metodo: "POST", ruta: "/conversaciones/whatsapp/conv-1/tomar" });
    await expect(main(page).getByRole("button", { name: "Marcar como resuelta" })).toBeVisible();
    vigilante.verificar();
  });

  test("Turnos: Guardar turnos hace un PUT con los turnos", async ({ page, mock, vigilante }) => {
    await ir(page, "/turnos");
    await expect(page.getByLabel("Nombre del turno 1")).toHaveValue("Comida");
    await page.getByLabel("Nombre del turno 1").fill("Comida y cena");
    await mock.limpiarRegistro();
    await main(page).getByRole("button", { name: "Guardar turnos" }).click();
    const [put] = await esperarEscrituras(mock, { metodo: "PUT", ruta: "/turnos" });
    expect(cuerpoDe(put)).toMatchObject({ turnos: [{ nombre: "Comida y cena" }] });
    vigilante.verificar();
  });

  test("Privacidad: Guardar configuracion hace un PUT", async ({ page, mock, vigilante }) => {
    await ir(page, "/privacidad");
    await mock.limpiarRegistro();
    await main(page).getByRole("button", { name: "Guardar configuración" }).click();
    const [put] = await esperarEscrituras(mock, { metodo: "PUT", ruta: "/privacidad/configuracion" });
    expect(cuerpoDe(put)).toMatchObject({ avisoVersion: "2026-09" });
    vigilante.verificar();
  });

  test("Primeros pasos: Actualizar vuelve a pedir el checklist y los enlaces llevan a la pantalla", async ({ page, mock, vigilante }) => {
    await ir(page, "/primeros-pasos");
    await expect(main(page).getByText("Faltan puntos obligatorios")).toBeVisible();
    await mock.limpiarRegistro();
    await main(page).getByRole("button", { name: "Actualizar" }).click();
    await expect.poll(async () => (await mock.buscar({ metodo: "GET", ruta: "/onboarding" })).length).toBe(1);
    await main(page).getByRole("link", { name: "Ir a la pantalla" }).first().click();
    await expect(page).toHaveURL(/\/configuracion$/);
    vigilante.verificar();
  });

  test("Auditoria: el filtro por tipo pide auditoria?tipo= y filtra las filas", async ({ page, mock, vigilante }) => {
    await ir(page, "/auditoria");
    await expect(main(page).getByTitle("producto.precio_actualizado")).toBeVisible();
    await mock.limpiarRegistro();
    await page.getByLabel("Tipo de acción").selectOption("staff");
    await expect.poll(async () => (await mock.buscar({ metodo: "GET", ruta: "tipo=staff" })).length).toBeGreaterThan(0);
    await expect(main(page).getByTitle("producto.precio_actualizado")).toHaveCount(0);
    vigilante.verificar();
  });

  test("Indicadores de WhatsApp: cambiar el periodo pide whatsapp/kpi?dias=", async ({ page, mock, vigilante }) => {
    await ir(page, "/agente-whatsapp");
    await mock.limpiarRegistro();
    await page.getByLabel("Periodo").selectOption({ label: "Últimos 30 días" });
    await expect.poll(async () => (await mock.buscar({ metodo: "GET", ruta: "whatsapp/kpi?dias=30" })).length).toBeGreaterThan(0);
    vigilante.verificar();
  });
});

test.describe("restaurantes: puerta de onboarding R-33 @recorrido", () => {
  test.beforeEach(async ({ iniciarSesion }) => {
    await iniciarSesion("restaurantes", "owner");
  });

  test("Resumen: con obligatorios pendientes pero sin bloqueo muestra el banner y no redirige", async ({ page, mock, vigilante }) => {
    await ir(page, "");
    await expect(main(page).getByText("Faltan puntos obligatorios de configuración")).toBeVisible();
    await expect(main(page).getByRole("link", { name: "Ver primeros pasos" })).toBeVisible();
    expect((await mock.buscar({ metodo: "GET", ruta: "/onboarding/gate" })).length).toBeGreaterThan(0);
    vigilante.verificar();
  });

  test("Resumen: si la puerta bloquea redirige a Primeros pasos y 'Ir al panel de todos modos' la omite en la sesion", async ({ page, mock, vigilante }) => {
    await ir(page, ""); // crea la lista de bloqueo en el escenario (gate sin bloquear)
    await expect(main(page).getByText("Faltan puntos obligatorios de configuración")).toBeVisible();
    await mock.agregarAEstado("rest.gate.bloqueo", true);
    await ir(page, "");
    await expect(page).toHaveURL(/\/primeros-pasos$/);
    await expect(main(page).getByText("Faltan puntos obligatorios", { exact: true })).toBeVisible();
    await main(page).getByRole("button", { name: "Ir al panel de todos modos" }).click();
    await expect(page).toHaveURL(/\/restaurantes\/[^/]+$/);
    await expect(main(page).getByText("Faltan puntos obligatorios de configuración")).toBeVisible();
    vigilante.verificar();
  });
});
