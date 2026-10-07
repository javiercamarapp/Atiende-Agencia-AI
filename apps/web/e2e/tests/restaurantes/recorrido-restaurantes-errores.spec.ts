// Estados de ERROR del panel de restaurantes: cada pantalla cuyo dato principal falla (503 inyectado una vez) muestra un
// EstadoError con "Reintentar", y al reintentar se recupera sin recargar la pagina. Tambien cubre la sesion vencida y la latencia.
import { expect, test } from "../../helpers/fixtures.ts";
import { afirmarErrorYReintento, BASE, ir } from "../../helpers/recorrido.ts";
import type { Locator, Page } from "@playwright/test";

interface Caso {
  readonly sub: string;
  readonly ruta: string | RegExp;
  readonly listo: (page: Page) => Locator;
  /** 503 en las rutas de voz/WhatsApp significa "servicio no disponible aun" (estado honesto por diseno): ahi la falla es un 500. */
  readonly status?: number;
  readonly sinShell?: boolean;
  /** Defecto conocido: la pantalla muestra el error SIN boton Reintentar (test.fail con su id). */
  readonly bug?: string;
}

const CASOS: readonly Caso[] = [
  { sub: "", ruta: /\/kpis\/sales(\?|$)/, listo: (p) => p.getByText("Número de órdenes") },
  { sub: "/pedidos", ruta: "/orders?status=pending", listo: (p) => p.getByText("Marisol Pech").first() },
  { sub: "/historial", ruta: "/orders", listo: (p) => p.getByText("Marisol Pech").first() },
  { sub: "/productos", ruta: "/products", listo: (p) => p.getByText("Tacos al pastor (orden)").first() },
  { sub: "/promociones", ruta: "/promotions", listo: (p) => p.getByText("BIENVENIDA10") },
  { sub: "/clientes", ruta: "/customers", listo: (p) => p.getByRole("link", { name: /Marisol Pech/ }), bug: "BUG-E2E-REST-002: Clientes pinta EstadoError sin onReintentar (pages/Clientes.tsx:68 y :121); el usuario debe recargar la pagina" },
  { sub: "/avisos", ruta: "/admin/avisos", listo: (p) => p.getByRole("switch", { name: "Avisarme: Pedido nuevo" }) },
  { sub: "/cierres", ruta: "/admin/cierres", listo: (p) => p.getByTestId("cierre-detalle"), status: 500 },
  { sub: "/sucursales", ruta: "/sucursales", listo: (p) => p.getByText("Calle 60 #400") },
  { sub: "/staff", ruta: "/staff/miembros", listo: (p) => p.getByText("Lucia Xool").first() },
  { sub: "/auditoria", ruta: "/auditoria", listo: (p) => p.getByTitle("producto.precio_actualizado") },
  // Ancla al final: "/onboarding/gate" (la puerta del shell) tambien contiene "/onboarding" y, al cargar el shell antes que la pagina
  // (pantallas perezosas), consumia la unica falla inyectada dejando la pagina sana.
  { sub: "/primeros-pasos", ruta: "/\\/onboarding$/", listo: (p) => p.getByText("Faltan puntos obligatorios") },
  { sub: "/turnos", ruta: "/turnos", listo: (p) => p.getByRole("button", { name: "Guardar turnos" }) },
  { sub: "/conversaciones", ruta: "/conversaciones?", listo: (p) => p.getByRole("button", { name: /WhatsApp · \+529995550101/ }) },
  { sub: "/privacidad", ruta: "/privacidad/configuracion", listo: (p) => p.getByRole("button", { name: "Guardar configuración" }), bug: "BUG-E2E-REST-003: Privacidad muestra la falla de carga de la configuracion como texto suelto, sin EstadoError ni Reintentar (pages/Privacidad.tsx:119)" },
  { sub: "/agente-whatsapp", ruta: "/whatsapp/kpi", listo: (p) => p.getByLabel("Periodo"), status: 500 },
  { sub: "/configuracion", ruta: "/config/zonas", listo: (p) => p.getByRole("button", { name: "Quitar zona Centro" }) },
  { sub: "/repartidor", ruta: "/repartidor/orders", listo: (p) => p.getByText("Marisol Pech").first(), sinShell: true },
];

test.describe("restaurantes: errores y reintento @recorrido", () => {
  for (const caso of CASOS) {
    test(`${caso.sub || "/"}: 503 en ${caso.ruta} -> EstadoError con Reintentar y recupera`, async ({ page, iniciarSesion, mock, vigilante }) => {
      if (caso.bug) test.fail(true, caso.bug);
      await iniciarSesion("restaurantes", "owner");
      vigilante.permitirRespuesta5xx(/\/v1\/restaurantes\//);
      await afirmarErrorYReintento(page, mock, { sub: caso.sub, ruta: caso.ruta, listo: caso.listo, ...(caso.status ? { status: caso.status } : {}), ...(caso.sinShell ? { sinShell: true } : {}) });
    });
  }

  test("sesion vencida (401 en una lectura y en el refresh): la SPA manda al login en vez de quedarse rota", async ({ page, iniciarSesion, mock }) => {
    await iniciarSesion("restaurantes", "owner");
    await mock.inyectarFalla({ metodo: "GET", ruta: "/products", status: 401 });
    await mock.inyectarFalla({ metodo: "POST", ruta: "/auth/refresh", status: 401 });
    await page.goto(`${BASE}/productos`);
    await expect(page).toHaveURL(/\/restaurantes\/login/);
  });

  test("latencia alta: la pantalla muestra su estado de carga y termina sin errores", async ({ page, iniciarSesion, mock, vigilante }) => {
    await iniciarSesion("restaurantes", "owner");
    await mock.configurar({ latenciaMs: 900 });
    await page.goto(`${BASE}/productos`);
    await expect(page.getByText(/Cargando/).first()).toBeVisible();
    await expect(page.getByText("Tacos al pastor (orden)").first()).toBeVisible();
    await ir(page, "/promociones");
    await expect(page.getByText("BIENVENIDA10")).toBeVisible();
    vigilante.verificar();
  });
});
