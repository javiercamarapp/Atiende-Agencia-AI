// ds3 / «Pregúntale a tus datos» en TODOS los ámbitos que montan el chat compartido, con la bandera encendida y contra la API
// simulada: citas, hoteles, despachos, licitaciones, rentas y el Copiloto de plataforma del superadmin (restaurantes vive en
// copiloto-ds3.spec.ts). En cada uno: los temas salen de las categorías de ESA vertical, una pregunta del primer tema llega al
// endpoint de su vertical, la respuesta trae «Cómo se calculó» con la fuente que mandó el servidor y el historial abre como Drawer.
// Por rol: el staff de restaurantes no ve el tema «CFO» (la misma regla `cfo.ver` del diseño actual) y un rol sin Copiloto ve el
// estado honesto «Sin acceso» también con la bandera. Negativos: un no-superadmin en /superadmin/copiloto, otra organizacion por slug
// y el historial de otro usuario (la API simulada guarda las conversaciones por persona, como la RLS de 0041).
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
  /** POST que debe recibir la pregunta: endpoint de chat de ESA vertical y de SU sucursal/propiedad (ruta exacta). */
  readonly post: string;
  /** Persona de la API simulada que hace la peticion (la sesion con la que se entro). */
  readonly persona: string;
  readonly respuesta: string;
  readonly fuente: string;
}

const AMBITOS: readonly Ambito[] = [
  { nombre: "citas", objetivo: "citas", rol: "owner", ruta: `/citas/${citas.orgSlug}/copiloto`, tema: "Agenda y ocupación", pregunta: "¿Cuántas citas tengo esta semana?", post: `/citas/${citas.propertyId}/chat-datos`, persona: "citas-owner", respuesta: "Esta semana tienes 24 citas", fuente: "Citas de la agenda" },
  { nombre: "hoteles", objetivo: "hoteles", rol: "owner", ruta: `/hoteles/${hoteles.orgSlug}/copiloto`, tema: "Ocupación e ingresos", pregunta: "¿Cómo va la ocupación esta semana?", post: `/hoteles/${hoteles.propertyId}/chat-datos`, persona: "hoteles-owner", respuesta: "Esta semana tu ocupación fue 73%", fuente: "Cargos de hospedaje del folio e inventario por día" },
  { nombre: "despachos", objetivo: "despachos", rol: "admin", ruta: `/despachos/${despachos.orgSlug}/copiloto`, tema: "Cobranza", pregunta: "¿Cuánto me deben mis clientes hoy?", post: `/despachos/${despachos.propertyId}/chat-datos`, persona: "despachos-admin", respuesta: "Tus clientes te deben $120,000 MXN", fuente: "Cuentas por cobrar de CFDI en seguimiento de cobranza, sin pagar" },
  { nombre: "licitaciones", objetivo: "licitaciones", rol: "owner", ruta: `/licitaciones/${licitaciones.orgSlug}/copiloto`, tema: "Oportunidades", pregunta: "¿Qué convocatorias vencen en los próximos 7 días?", post: `/licitaciones/${licitaciones.propertyId}/chat-datos`, persona: "licitaciones-owner", respuesta: "Tienes 7 convocatorias abiertas", fuente: "Convocatorias de la organización con fecha límite vigente" },
  { nombre: "rentas", objetivo: "rentas", rol: "admin", ruta: `/rentas/${rentas.orgSlug}/copiloto`, tema: "Ocupación", pregunta: "¿Cuál fue la ocupación por unidad el mes pasado?", post: `/rentas/${rentas.propertyId}/chat-datos`, persona: "rentas-admin", respuesta: "Este mes ingresaste $53,400 MXN", fuente: "Reservas con llegada en el periodo" },
  { nombre: "superadmin", objetivo: "superadmin", ruta: "/superadmin/copiloto", tema: "", pregunta: "", post: "/superadmin/copiloto", persona: "plataforma-superadmin", respuesta: "Hay 6 organizaciones, 5 activas.", fuente: "Organizaciones de la plataforma" },
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
      if (a.tema) await expect(primerTema).toHaveAccessibleName(a.tema);
      const pregunta = a.pregunta ? temas.getByRole("button", { name: a.pregunta, exact: true }) : temas.locator("[data-pregunta]").first();
      await expect(pregunta).toBeVisible();
      await capturar(page, `${a.nombre}-portada`, info.project.name);
      await pregunta.click();

      const hilo = page.getByRole("log", { name: "Conversación con el Copiloto" });
      await expect(hilo.getByText(a.respuesta)).toBeVisible();
      // Una sola pregunta, al endpoint de SU vertical y SU propiedad, con la sesion de quien entro (nada de otra organizacion).
      await expect.poll(async () => (await mock.buscar({ metodo: "POST", ruta: /chat-datos$|\/superadmin\/copiloto$/ })).length).toBe(1);
      const [post] = await mock.buscar({ metodo: "POST", ruta: /chat-datos$|\/superadmin\/copiloto$/ });
      expect(post?.ruta).toBe(a.post);
      expect(post?.persona).toBe(a.persona);
      expect(post?.status).toBe(200);

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

  // ---- Negativos: aislamiento por plataforma, organizacion y usuario ------------------------------------------------------------------
  test("un usuario que NO es superadmin no obtiene el Copiloto de plataforma en /superadmin/copiloto", async ({ page, iniciarSesion, mock }) => {
    await iniciarSesion("restaurantes", "owner");
    await page.goto("/superadmin/copiloto");
    await expect(page).not.toHaveURL(/\/superadmin\/copiloto$/);
    await expect(page.getByRole("form", { name: "Preguntar al Copiloto" })).toHaveCount(0);
    expect(await mock.buscar({ ruta: /^\/superadmin\/copiloto/ })).toHaveLength(0);
  });

  test("abrir OTRA organizacion por su slug no muestra su chat ni consulta datos de nadie", async ({ page, iniciarSesion, mock }) => {
    await iniciarSesion("restaurantes", "owner");
    // El Resumen de la organizacion PROPIA sigue pidiendo sus graficas fijadas (GET .../chat-datos/pins) tras pintar el sidebar;
    // se espera a que termine antes de contar, para que solo cuente lo que dispare la organizacion ajena.
    await page.waitForLoadState("networkidle");
    const antes = (await mock.buscar({ ruta: /chat-datos/ })).length;
    // La API simulada no modela membresias: devuelve sucursales para CUALQUIER slug. La real (admin-kpis.ts) responde 403
    // «No perteneces a esta organización» en GET /v1/restaurantes/:orgSlug/admin/branches; se reproduce aqui esa respuesta.
    await mock.inyectarFalla({ metodo: "GET", ruta: "/v1/restaurantes/otra-organizacion-ajena/admin/branches", status: 403, cuerpo: { message: "No perteneces a esta organización." } });
    await page.goto("/restaurantes/otra-organizacion-ajena/copiloto");
    await expect(page.getByTestId("copiloto-temas")).toHaveCount(0);
    await expect(page.getByRole("form", { name: "Preguntar al Copiloto" })).toHaveCount(0);
    expect((await mock.buscar({ ruta: /chat-datos/ })).length).toBe(antes);
  });

  test("el historial es de cada usuario: el staff no ve los chats del dueño (y el dueño sí)", async ({ page, iniciarSesion, mock }) => {
    const ruta = `/restaurantes/${restaurantes.orgSlug}/copiloto`;
    await iniciarSesion("restaurantes", "owner");
    await page.goto(ruta);
    await afirmarPantallaSana(page, "copiloto");
    const pregunta = "¿Cuál es mi ticket medio este mes?";
    await page.getByTestId("copiloto-temas").getByRole("button", { name: pregunta, exact: true }).click();
    await expect(page.getByRole("log", { name: "Conversación con el Copiloto" }).getByText("vendiste")).toBeVisible();

    await iniciarSesion("restaurantes", "staff");
    await page.goto(ruta);
    await afirmarPantallaSana(page, "copiloto");
    await page.getByRole("button", { name: "Historial de chats" }).click();
    const panel = page.getByRole("dialog", { name: "Historial de chats" });
    await expect(panel.getByText("Aún no tienes chats guardados.")).toBeVisible();
    await expect(panel.getByRole("button", { name: pregunta, exact: true })).toHaveCount(0);
    // El staff pidio SU lista (con su sesion), nunca la del dueño.
    const listas = await mock.buscar({ metodo: "GET", ruta: /chat-datos\/conversaciones$/ });
    expect(listas.at(-1)?.persona).toBe("restaurantes-staff");
    await page.keyboard.press("Escape");

    await iniciarSesion("restaurantes", "owner");
    await page.goto(ruta);
    await afirmarPantallaSana(page, "copiloto");
    await page.getByRole("button", { name: "Historial de chats" }).click();
    await expect(page.getByRole("dialog", { name: "Historial de chats" }).getByRole("button", { name: pregunta, exact: true })).toBeVisible();
  });
});
