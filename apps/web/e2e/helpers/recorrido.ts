// Piezas comunes de los recorridos completos de restaurantes (qa-e2e-restaurantes): rutas del panel, escrituras al mock con
// una sola peticion exacta, y el patron "falla inyectada -> EstadoError con Reintentar -> recupera".
import { expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import type { ClienteMock } from "../mock-api/cliente.ts";
import { restaurantes } from "../mock-api/fixtures/restaurantes.ts";
import type { RegistroPeticion } from "../mock-api/tipos.ts";
import { afirmarPantallaSana } from "./humo.ts";

export const BASE = `/restaurantes/${restaurantes.orgSlug}`;

/** Destinos del Sidebar de restaurantes (ver RestaurantesShell.buildSections) con el rol minimo que los ve. */
export interface Destino {
  readonly sub: string;
  readonly nombre: string;
  readonly soloGestion: boolean;
}

export const DESTINOS: readonly Destino[] = [
  { sub: "", nombre: "Resumen", soloGestion: false },
  { sub: "/copiloto", nombre: "Copiloto", soloGestion: false },
  { sub: "/cfo", nombre: "CFO", soloGestion: true },
  { sub: "/pedidos", nombre: "Pedidos", soloGestion: false },
  { sub: "/comandas-pos", nombre: "Comandas al POS", soloGestion: false },
  { sub: "/conversaciones", nombre: "Conversaciones", soloGestion: false },
  { sub: "/turnos", nombre: "Turnos", soloGestion: false },
  { sub: "/historial", nombre: "Historial", soloGestion: false },
  { sub: "/avisos", nombre: "Avisos", soloGestion: false },
  { sub: "/cierres", nombre: "Cierre del día", soloGestion: true },
  { sub: "/productos", nombre: "Productos", soloGestion: false },
  { sub: "/promociones", nombre: "Promociones", soloGestion: true },
  { sub: "/clientes", nombre: "Clientes", soloGestion: false },
  { sub: "/campanas", nombre: "Campañas", soloGestion: true },
  { sub: "/sucursales", nombre: "Sucursales", soloGestion: false },
  { sub: "/agente-voz", nombre: "Agente de voz", soloGestion: true },
  { sub: "/agente-whatsapp", nombre: "Agente de WhatsApp", soloGestion: true },
  { sub: "/agente-ajustes", nombre: "Ajustes del agente", soloGestion: true },
  { sub: "/primeros-pasos", nombre: "Primeros pasos", soloGestion: true },
  { sub: "/configuracion", nombre: "Configuración", soloGestion: true },
  { sub: "/staff", nombre: "Staff", soloGestion: true },
  { sub: "/auditoria", nombre: "Auditoría", soloGestion: true },
  { sub: "/privacidad", nombre: "Privacidad", soloGestion: true },
  { sub: "/privacidad-organizacion", nombre: "Privacidad de la organización", soloGestion: true },
  { sub: "/seguridad", nombre: "Seguridad de la cuenta", soloGestion: false },
];

/** Va a una pagina del panel por URL y espera a que el shell pinte (el <main> con foco programatico). */
export async function ir(page: Page, sub = ""): Promise<void> {
  await page.goto(`${BASE}${sub}`);
  await expect(page.locator("main#contenido-principal")).toBeVisible();
  // R-37: la pantalla es un chunk perezoso; no seguir mientras se pinta el estado de carga de la ruta.
  await expect(page.locator("[data-atiende-carga-ruta]")).toHaveCount(0);
}

/** Espera a que el mock reciba EXACTAMENTE `n` peticiones que coinciden y las devuelve (para afirmar metodo, ruta y cuerpo). */
export async function esperarEscrituras(mock: ClienteMock, filtro: { metodo: string; ruta: string | RegExp }, n = 1): Promise<RegistroPeticion[]> {
  await expect.poll(async () => (await mock.buscar(filtro)).length, { message: `peticiones ${filtro.metodo} ${String(filtro.ruta)}` }).toBe(n);
  return mock.buscar(filtro);
}

/** Ninguna escritura (POST/PUT/PATCH/DELETE) desde el ultimo `limpiarRegistro`. */
export async function afirmarSinEscrituras(mock: ClienteMock, contexto: string): Promise<void> {
  expect(await mock.escrituras(), `${contexto}: no debe haber escrituras`).toEqual([]);
}

/** El cuerpo de la peticion como objeto (el mock lo guarda tal cual lo envio la SPA). */
export function cuerpoDe(p: RegistroPeticion | undefined): Record<string, unknown> {
  expect(p, "falta la peticion").toBeDefined();
  return (p!.cuerpo ?? {}) as Record<string, unknown>;
}

/**
 * Falla inyectada -> EstadoError con "Reintentar" -> al reintentar la pagina se recupera. `ruta` es la GET que carga la
 * pantalla; `listo` es algo visible solo cuando cargo bien. La falla es PERSISTENTE hasta que aparece el error y entonces se
 * retira: con `veces: 1` una pantalla que pide dos veces (el efecto se repite al llegar sucursal/token, o hay una peticion
 * hermana con la misma subcadena, p. ej. /kpis/sales y /kpis/sales/trend) gastaba la falla en una peticion descartada y el
 * error nunca se pintaba (flake del CI en /kpis/sales y /conversaciones). `ruta` debe ser lo bastante especifica (regex
 * anclada) para no tumbar peticiones hermanas que pintarian un segundo EstadoError.
 */
export async function afirmarErrorYReintento(page: Page, mock: ClienteMock, opciones: { sub: string; ruta: string | RegExp; listo: (page: Page) => Locator; status?: number; sinShell?: boolean }): Promise<void> {
  await mock.inyectarFalla({ metodo: "GET", ruta: typeof opciones.ruta === "string" ? opciones.ruta : `/${opciones.ruta.source}/`, status: opciones.status ?? 503 });
  await page.goto(`${BASE}${opciones.sub}`);
  const alerta = page.getByRole("alert").filter({ has: page.getByRole("button", { name: "Reintentar" }) });
  await expect(alerta, `${opciones.sub || "/"}: la falla debe verse como EstadoError con Reintentar`).toBeVisible();
  await mock.limpiarFallas();
  await alerta.getByRole("button", { name: "Reintentar" }).click();
  await expect(opciones.listo(page)).toBeVisible();
  await expect(alerta).toHaveCount(0);
  // /repartidor vive fuera del shell (sin <main>, BUG-E2E-REST-001): no se le exige el landmark.
  if (!opciones.sinShell) await afirmarPantallaSana(page, opciones.sub || "/");
}
