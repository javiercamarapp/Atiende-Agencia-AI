// Errores 4xx/5xx inyectados y latencia configurable en la API simulada: la SPA debe degradar con honestidad.
import { expect, test } from "../helpers/fixtures.ts";
import { citas } from "../mock-api/fixtures/citas.ts";

const RESUMEN = `/citas/${citas.orgSlug}/resumen`;

test.describe("errores y latencia @errores", () => {
  test("5xx al cargar sucursales: error visible con Reintentar y reintentar recupera el panel", async ({ page, iniciarSesion, mock, vigilante }) => {
    await iniciarSesion("citas", "owner");
    vigilante.permitirRespuesta5xx(/\/admin\/branches/);
    await mock.inyectarFalla({ metodo: "GET", ruta: "/admin/branches", status: 503, veces: 1 });
    await page.reload();
    const reintentar = page.getByRole("button", { name: "Reintentar" });
    await expect(reintentar).toBeVisible();
    await reintentar.click();
    await expect(page.getByRole("heading", { name: "Resumen" })).toBeVisible();
    await expect(page.getByText("Citas hoy")).toBeVisible();
    // Una falla inyectada deja huella en el registro (para aserciones del tipo "se reintento").
    const registro = await mock.peticiones();
    expect(registro.filter((p) => p.inyectada && p.status === 503)).toHaveLength(1);
    expect(registro.filter((p) => p.ruta.includes("/admin/branches") && p.status === 200).length).toBeGreaterThanOrEqual(1);
  });

  test("401 con sesion vencida: la SPA refresca el token una vez y reintenta sin pedir login", async ({ page, iniciarSesion, mock, vigilante }) => {
    await iniciarSesion("citas", "owner");
    await mock.limpiarRegistro();
    await mock.inyectarFalla({ metodo: "GET", ruta: "/resumen", status: 401, veces: 1 });
    await page.goto(RESUMEN);
    await expect(page.getByText("Citas hoy")).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`${RESUMEN}$`));
    const refrescos = await mock.buscar({ metodo: "POST", ruta: "/auth/refresh" });
    expect(refrescos).toHaveLength(1);
    vigilante.verificar();
  });

  test("refresh rechazado: la sesion se limpia y vuelve al login de la vertical", async ({ page, iniciarSesion, mock }) => {
    await iniciarSesion("citas", "owner");
    await mock.inyectarFalla({ metodo: "GET", ruta: "/resumen", status: 401, veces: 1 });
    await mock.inyectarFalla({ metodo: "POST", ruta: "/auth/refresh", status: 401, veces: 1 });
    await page.goto(RESUMEN);
    await expect(page).toHaveURL(/\/citas\/login$/);
  });

  test("403 por rol: staff abre /staff por URL directa y la SPA ni se rompe ni pide endpoints de gestion", async ({ page, iniciarSesion, mock, vigilante }) => {
    // El mock responde 403 a staff en miembros/invitaciones (solo owner/admin): la SPA ya lo anticipa y no los pide.
    await iniciarSesion("restaurantes", "staff");
    await page.goto("/restaurantes/taqueria-el-faro/staff");
    await expect(page.locator("main#contenido-principal")).toBeVisible();
    await expect(page.getByText("Esta pantalla no pudo mostrarse")).toHaveCount(0);
    const gestion = await mock.buscar({ ruta: /\/staff\/(miembros|invitaciones)/ });
    expect(gestion).toEqual([]);
    vigilante.verificar();
  });

  test("latencia: con 700 ms por peticion se ve el estado de carga antes de los datos", async ({ page, iniciarSesion, mock }) => {
    await iniciarSesion("citas", "owner");
    await mock.configurar({ latenciaMs: 700 });
    await page.goto(RESUMEN);
    await expect(page.getByRole("status", { name: "Cargando resumen…" }).or(page.getByText("Cargando resumen…")).first()).toBeVisible();
    await expect(page.getByText("Citas hoy")).toBeVisible({ timeout: 15_000 });
  });
});
