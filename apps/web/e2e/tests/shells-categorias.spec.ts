// UNI-6 (shells): las 7 consolas (6 verticales + superadmin) pintan el marco de Likida con sus destinos agrupados.
//  - Escritorio: categorias del Sidebar en el orden de Likida, acordeon EXCLUSIVO (abrir una cierra la otra), la raiz
//    "Resumen" sin boton de grupo y la tarjeta de usuario con nombre y rol.
//  - Movil: barra inferior de 4 destinos con etiquetas completas (sin recortar) + "Más", y la hoja "Más" con los mismos
//    titulos de categoria, la raiz sin titulo y TODOS los destinos alcanzables (superadmin: tambien "Cuenta" con el pie).
// Mismos destinos y roles que antes: solo cambia como se agrupan.
import { expect, test } from "../helpers/fixtures.ts";
import type { ObjetivoLogin } from "../helpers/fixtures.ts";
import { afirmarPantallaSana } from "../helpers/humo.ts";
import { abrirMasMovil, barraMovil, esMovil, sidebar } from "../helpers/navegacion.ts";

interface Esperado {
  readonly categorias: readonly string[];
  readonly barra: readonly string[];
  /** Etiquetas del pie del Sidebar que son enlaces reales (solo superadmin las trae siempre; las verticales dependen del asistente). */
  readonly pie: readonly string[];
}

const CONSOLAS: Readonly<Record<ObjetivoLogin, Esperado>> = {
  superadmin: { categorias: ["Agentes", "Negocio", "Plataforma", "Control", "Sistema"], barra: ["Resumen", "Salud", "Acciones", "Prospectos"], pie: ["Costos de IA", "Ver los otros paneles"] },
  restaurantes: { categorias: ["Operación", "Catálogo", "Clientes", "Agente", "Configuración"], barra: ["Resumen", "Pedidos", "Historial", "Productos"], pie: [] },
  hoteles: { categorias: ["Operación", "Huéspedes", "Finanzas", "Agentes", "Configuración"], barra: ["Resumen", "Reservas", "Tickets", "Asistencia"], pie: [] },
  rentas: { categorias: ["Operación", "Canales", "Finanzas", "Configuración", "Control"], barra: ["Resumen", "Calendario", "Aprobaciones", "Mis tareas"], pie: [] },
  despachos: { categorias: ["Facturación", "Fiscal", "Contabilidad", "Clientes y equipo"], barra: ["Resumen", "Cierre", "CFDI", "Cobranza"], pie: [] },
  licitaciones: { categorias: ["Oportunidades", "Inteligencia", "Organización"], barra: ["Resumen", "Convocatorias", "Seguimiento", "Empresa"], pie: [] },
  citas: { categorias: ["Negocio", "Comunicación", "Administrar"], barra: ["Resumen", "Agenda", "Proveedores", "Clientes"], pie: [] },
};

for (const [objetivo, esperado] of Object.entries(CONSOLAS) as [ObjetivoLogin, Esperado][]) {
  test.describe(`shell de ${objetivo} @shell`, () => {
    test("escritorio: categorias en el orden de Likida, acordeon exclusivo y tarjeta de usuario", async ({ page, iniciarSesion, vigilante }) => {
      test.skip(esMovil(page), "el Sidebar es solo de escritorio");
      await iniciarSesion(objetivo, objetivo === "superadmin" ? undefined : "owner");
      await afirmarPantallaSana(page, `${objetivo}: aterrizaje`);
      const lateral = sidebar(page);
      const grupos = lateral.locator("button[aria-expanded]");
      await expect(grupos).toHaveText([...esperado.categorias]);
      // Una sola categoria abierta; al abrir otra se cierra la anterior (acordeon exclusivo, como Likida).
      await expect(lateral.locator("button[aria-expanded='true']")).toHaveCount(1);
      const ultimo = grupos.nth(esperado.categorias.length - 1);
      await ultimo.click();
      await expect(ultimo).toHaveAttribute("aria-expanded", "true");
      await expect(lateral.locator("button[aria-expanded='true']")).toHaveCount(1);
      // La raiz "Resumen" no es un grupo: es un enlace siempre visible, el primero del <nav>.
      await expect(lateral.locator("nav a").first()).toContainText("Resumen");
      // Pie: tarjeta de usuario con nombre y rol (no un correo cortado) y cerrar sesion.
      await expect(lateral.getByRole("button", { name: "Cerrar sesión" })).toBeVisible();
      const nombre = lateral.locator("p[title]").first();
      expect(((await nombre.textContent()) ?? "").trim().length).toBeGreaterThan(0);
      expect(((await nombre.locator("xpath=following-sibling::p[1]").textContent()) ?? "").trim().length).toBeGreaterThan(0);
      for (const etiqueta of esperado.pie) await expect(lateral.getByRole("link", { name: etiqueta })).toBeVisible();
      vigilante.verificar();
    });

    test("movil: barra de 4 destinos con etiquetas completas, y la hoja Más con las mismas categorias y todos los destinos", async ({ page, iniciarSesion, vigilante }) => {
      test.skip(!esMovil(page), "la barra inferior es solo de movil");
      await iniciarSesion(objetivo, objetivo === "superadmin" ? undefined : "owner");
      await afirmarPantallaSana(page, `${objetivo}: aterrizaje`);
      const barra = barraMovil(page);
      await expect(barra.locator("a span")).toHaveText([...esperado.barra]);
      // Ninguna etiqueta de la barra queda recortada con puntos suspensivos a 375 px.
      const recortadas = await barra.locator("a span").evaluateAll((spans) => spans.filter((s) => s.scrollWidth > s.clientWidth + 1).map((s) => s.textContent));
      expect(recortadas, `${objetivo}: etiquetas recortadas en la barra`).toEqual([]);
      await expect(barra.getByRole("button", { name: "Más" })).toBeVisible();

      const hoja = await abrirMasMovil(page);
      const titulos = [...esperado.categorias, ...(esperado.pie.length > 0 ? ["Cuenta"] : [])];
      await expect(hoja.locator("p.font-mono")).toHaveText(titulos);
      // La raiz "Resumen" va sin titulo y es el primer enlace de la hoja.
      await expect(hoja.getByRole("link").first()).toContainText("Resumen");
      // Cada destino de la barra tambien esta en la hoja.
      const hrefsHoja = await hoja.getByRole("link").evaluateAll((as) => as.map((a) => a.getAttribute("href") ?? ""));
      for (const href of await barra.locator("a").evaluateAll((as) => as.map((a) => a.getAttribute("href") ?? ""))) expect(hrefsHoja).toContain(href);
      // Solo "Costos de IA" (pie de superadmin) repite el destino de "Costos y margen"; en las verticales no se repite nada.
      const duplicados = hrefsHoja.filter((h, i) => hrefsHoja.indexOf(h) !== i);
      expect(duplicados, `${objetivo}: destinos repetidos en la hoja`).toEqual(objetivo === "superadmin" ? ["/superadmin/costos-margen"] : []);
      if (objetivo === "superadmin") expect(hrefsHoja).toContain("/superadmin/paneles");
      vigilante.verificar();
    });
  });
}
