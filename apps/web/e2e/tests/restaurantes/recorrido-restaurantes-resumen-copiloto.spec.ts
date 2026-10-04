// Resumen (uni-res) y Copiloto (chat-08) del panel de restaurantes: KPIs en su orden, "—" cuando no hay dato, pildoras y tarjetas con su
// destino; en el Copiloto: pregunta libre, abort con "Detener", historial y rol sin acceso.
import { expect, test } from "../../helpers/fixtures.ts";
import { afirmarPantallaSana } from "../../helpers/humo.ts";
import { BASE, ir } from "../../helpers/recorrido.ts";
import type { Page } from "@playwright/test";

const main = (page: Page) => page.locator("main#contenido-principal");

const KPIS_EN_ORDEN = [
  "Número de órdenes",
  "Valor promedio",
  "Pedidos por agentes IA",
  "Ingresos por agentes IA",
  "Pedidos por WhatsApp",
  "Pedidos por voz",
  "Clientes recurrentes",
];

test.describe("restaurantes: Resumen @recorrido", () => {
  test("los 7 KPIs salen en su orden con los datos del servidor y las pildoras apuntan a su pantalla", async ({ page, iniciarSesion, vigilante }) => {
    await iniciarSesion("restaurantes", "owner");
    await ir(page, "");
    for (const kpi of KPIS_EN_ORDEN) await expect(main(page).getByText(kpi, { exact: true })).toBeVisible();
    // Orden de lectura: la posicion vertical/horizontal de cada etiqueta sigue el orden del arreglo (por filas de la rejilla).
    const cajas = await Promise.all(KPIS_EN_ORDEN.map(async (k) => (await main(page).getByText(k, { exact: true }).boundingBox())!));
    for (let i = 1; i < cajas.length; i++) {
      const [a, b] = [cajas[i - 1]!, cajas[i]!];
      expect(b.y > a.y + 4 || (Math.abs(b.y - a.y) <= 4 && b.x > a.x), `"${KPIS_EN_ORDEN[i]}" debe ir despues de "${KPIS_EN_ORDEN[i - 1]}"`).toBe(true);
    }
    // Valores del mock: 96 ordenes, 76% de adopcion de IA (21 voz + 52 WhatsApp = 73 pedidos), 41% recurrentes.
    await expect(main(page).getByText("96", { exact: true }).first()).toBeVisible();
    await expect(main(page).getByText("41%")).toBeVisible();
    await expect(main(page).getByText(/76% de los pedidos/)).toBeVisible();

    const destinos: Array<[string, string]> = [
      ["Ver pedidos", `${BASE}/pedidos`],
      ["Ver historial", `${BASE}/historial`],
      ["Pregunta a tus datos", `${BASE}/copiloto`],
    ];
    for (const [texto, href] of destinos) await expect(main(page).getByRole("link", { name: texto })).toHaveAttribute("href", href);
    await expect(main(page).getByRole("link", { name: /WhatsApp/ }).first()).toHaveAttribute("href", `${BASE}/conversaciones`);
    await afirmarPantallaSana(page, "resumen");
    vigilante.verificar();
  });

  test("sin dato (recurrentes nulo, sin adopcion de IA): muestra — y la explicacion, no un 0 inventado", async ({ page, iniciarSesion, vigilante }) => {
    await iniciarSesion("restaurantes", "owner");
    // Respuestas de borde decididas por la prueba (el mock real siempre trae dato): el navegador recibe nulos del servidor.
    await page.route(/\/kpis\/customers/, async (route) => {
      const res = await route.fetch();
      const json = (await res.json()) as Record<string, unknown>;
      await route.fulfill({ response: res, json: { ...json, recurringCustomerPct: null } });
    });
    await page.route(/\/kpis\/channels/, async (route) => {
      const res = await route.fetch();
      const json = (await res.json()) as Record<string, unknown>;
      await route.fulfill({ response: res, json: { ...json, aiAdoptionPct: null } });
    });
    await ir(page, "");
    // La tarjeta es la mas pequena que contiene la etiqueta y el guion largo (no un 0% inventado).
    const tarjeta = main(page).locator("div").filter({ hasText: "Clientes recurrentes" }).filter({ hasText: "—" }).last();
    await expect(tarjeta).toContainText("—");
    await expect(tarjeta).not.toContainText("0%");
    await expect(main(page).getByText("Aún no hay pedidos vinculados a clientes")).toBeVisible();
    await expect(main(page).getByText(/Voz y WhatsApp · /).first()).toBeVisible();
    vigilante.verificar();
  });

  test("staff ve el Resumen con su pildora del Copiloto", async ({ page, iniciarSesion }) => {
    await iniciarSesion("restaurantes", "staff");
    await ir(page, "");
    await expect(main(page).getByRole("link", { name: "Pregunta a tus datos" })).toBeVisible();
  });
});

test.describe("restaurantes: Copiloto @recorrido", () => {
  test("pregunta libre con Enter: el POST lleva la pregunta y llega la respuesta con su fuente", async ({ page, iniciarSesion, mock, vigilante }) => {
    await iniciarSesion("restaurantes", "owner");
    await ir(page, "/copiloto");
    await page.getByLabel("Tu pregunta").fill("¿Cuánto vendí esta semana en total?");
    await page.getByLabel("Tu pregunta").press("Enter");
    await expect(page.getByText("En los últimos 7 días vendiste")).toBeVisible();
    const posts = await mock.buscar({ metodo: "POST", ruta: "/chat-datos" });
    expect(posts).toHaveLength(1);
    expect(posts[0]?.cuerpo).toMatchObject({ question: "¿Cuánto vendí esta semana en total?", conversationId: "new" });
    vigilante.verificar();
  });

  test("Detener aborta la consulta en curso: no llega respuesta y el compositor vuelve a quedar listo", async ({ page, iniciarSesion, mock, vigilante }) => {
    await iniciarSesion("restaurantes", "owner");
    await ir(page, "/copiloto");
    await mock.configurar({ latenciaMs: 3000 });
    await page.getByLabel("Tu pregunta").fill("¿Cuánto vendí esta semana?");
    await page.getByLabel("Tu pregunta").press("Enter");
    await page.getByRole("button", { name: "Detener" }).click();
    await expect(page.getByRole("button", { name: "Detener" })).toHaveCount(0);
    await expect(page.getByLabel("Tu pregunta")).toBeEnabled();
    await mock.configurar({ latenciaMs: 0 });
    await expect(page.getByText("En los últimos 7 días vendiste")).toHaveCount(0);
    vigilante.verificar();
  });

  test("admin entra al Copiloto (el repartidor es devuelto a Mis entregas: ver recorrido por rol)", async ({ page, iniciarSesion }) => {
    await iniciarSesion("restaurantes", "admin");
    await ir(page, "/copiloto");
    await expect(page.getByRole("heading", { level: 1, name: "Pregunta a tus datos" })).toBeVisible();
  });
});
