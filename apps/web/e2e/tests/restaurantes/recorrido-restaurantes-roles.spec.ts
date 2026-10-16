// Recorrido por ROL del panel de restaurantes: cada rol entra, ve exactamente los destinos que le tocan, cada destino pinta sin error
// de render, y un rol sin acceso recibe un 403 MANEJADO (estado de error, sin escrituras ni 5xx) al forzar la URL.
import { expect, test } from "../../helpers/fixtures.ts";
import { afirmarPantallaSana, TEXTO_PANTALLA_ROTA } from "../../helpers/humo.ts";
import { irASeccion, seccionesDelPanel } from "../../helpers/navegacion.ts";
import { BASE, DESTINOS, afirmarSinEscrituras, ir } from "../../helpers/recorrido.ts";

const href = (sub: string): string => `${BASE}${sub}`;

test.describe("restaurantes: recorrido por rol @recorrido", () => {
  for (const rol of ["owner", "admin"] as const) {
    test(`${rol}: el menu lista los 23 destinos y cada uno pinta sano`, async ({ page, iniciarSesion, vigilante }) => {
      await iniciarSesion("restaurantes", rol);
      const secciones = await seccionesDelPanel(page);
      expect(secciones.map((s) => s.href).sort()).toEqual(DESTINOS.map((d) => href(d.sub)).sort());
      for (const seccion of secciones) {
        await irASeccion(page, seccion);
        await afirmarPantallaSana(page, `${rol} ${seccion.href}`);
      }
      vigilante.verificar();
    });
  }

  test("staff: el menu omite los destinos de gestion y los de operacion pintan sanos", async ({ page, iniciarSesion, vigilante }) => {
    await iniciarSesion("restaurantes", "staff");
    const secciones = await seccionesDelPanel(page);
    const esperados = DESTINOS.filter((d) => !d.soloGestion).map((d) => href(d.sub));
    expect(secciones.map((s) => s.href).sort()).toEqual(esperados.sort());
    for (const seccion of secciones) {
      await irASeccion(page, seccion);
      await afirmarPantallaSana(page, `staff ${seccion.href}`);
    }
    vigilante.verificar();
  });

  test("repartidor: aterriza en Mis entregas, sin menu de gestion, y el panel lo redirige", async ({ page, iniciarSesion, vigilante }) => {
    const aterrizaje = await iniciarSesion("restaurantes", "repartidor");
    expect(aterrizaje).toBe(`${BASE}/repartidor`);
    await expect(page.getByRole("heading", { name: "Mis entregas" })).toBeVisible();
    await expect(page.getByRole("complementary", { name: "Navegación principal" })).toHaveCount(0);
    // Forzar el Resumen o el Copiloto por URL lo devuelve a su unico panel (la SPA redirige antes de pintar el menu de gestion).
    for (const sub of ["", "/copiloto", "/staff"]) {
      await page.goto(href(sub));
      await expect(page).toHaveURL(new RegExp(`${BASE}/repartidor$`));
      await expect(page.getByRole("heading", { name: "Mis entregas" })).toBeVisible();
    }
    vigilante.verificar();
  });

  test("staff forzando /staff y /auditoria por URL: la pantalla explica la restriccion y NO pide datos de gestion ni escribe", async ({ page, iniciarSesion, mock, vigilante }) => {
    await iniciarSesion("restaurantes", "staff");
    await mock.limpiarRegistro();
    await ir(page, "/staff");
    await expect(page.getByText(/reservado a dueños y administradores/)).toBeVisible();
    await ir(page, "/auditoria");
    await expect(page.getByText(/Solo los roles/)).toBeVisible();
    await expect(page.getByText(TEXTO_PANTALLA_ROTA)).toHaveCount(0);
    expect(await mock.buscar({ ruta: /\/(staff\/miembros|staff\/invitaciones|auditoria)/ }), "un staff no debe pedir las lecturas de gestion").toEqual([]);
    await afirmarSinEscrituras(mock, "staff sin permiso");
    vigilante.verificar();
  });

  test("owner con 403 del servidor en Staff y Auditoria: EstadoError manejado con Reintentar, sin 5xx", async ({ page, iniciarSesion, mock, vigilante }) => {
    await iniciarSesion("restaurantes", "owner");
    for (const [sub, ruta] of [["/staff", "/staff/miembros"], ["/auditoria", "/auditoria"]] as const) {
      await mock.inyectarFalla({ metodo: "GET", ruta, status: 403, veces: 1 });
      await ir(page, sub);
      await expect(page.getByRole("alert").filter({ has: page.getByRole("button", { name: "Reintentar" }) })).toBeVisible();
      await expect(page.getByText(TEXTO_PANTALLA_ROTA)).toHaveCount(0);
    }
    vigilante.verificar();
  });

  // BUG-E2E-REST-001: /repartidor vive fuera del VerticalShell y no pinta ningun <main> ni "Saltar al contenido": un lector de pantalla
  // no tiene landmark principal. test.fail documenta el defecto y avisa (falla si "pasa") cuando se corrija.
  test("repartidor: Mis entregas tiene un landmark <main> (BUG-E2E-REST-001, defecto conocido)", async ({ page, iniciarSesion }) => {
    test.fail(true, "BUG-E2E-REST-001: /repartidor no tiene <main>; envolver RepartidorPedidosPage en un landmark main con id=contenido-principal");
    await iniciarSesion("restaurantes", "repartidor");
    await expect(page.locator("main")).toHaveCount(1);
  });

  test("sin sesion: una ruta del panel manda al login de restaurantes", async ({ page }) => {
    await page.goto(`${BASE}/pedidos`);
    await expect(page).toHaveURL(/\/restaurantes\/login/);
  });
});
