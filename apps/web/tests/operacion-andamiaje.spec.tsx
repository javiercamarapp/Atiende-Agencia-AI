// @vitest-environment jsdom
//
// Andamiaje del panel del operador (PLAN-PANEL-OPERADOR §6, commit 0): las cuatro pantallas existen, son honestas («No disponible aun»,
// sin controles ni datos de ejemplo) y el interruptor del panel esta apagado, de modo que el menu del shell no las anuncia todavia.
import { afterEach, describe, expect, it } from "vitest";
import { OperacionColaPage } from "../src/verticals/restaurantes/pages/OperacionCola.tsx";
import { OperacionNuevoPedidoPage } from "../src/verticals/restaurantes/pages/OperacionNuevoPedido.tsx";
import { OperacionViajesPage } from "../src/verticals/restaurantes/pages/OperacionViajes.tsx";
import { OperacionTurnoPage } from "../src/verticals/restaurantes/pages/OperacionTurno.tsx";
import { OPERACION_PANEL_ACTIVO } from "../src/verticals/restaurantes/lib/operacion-flag.ts";
import type { RestaurantesShellContext } from "../src/verticals/restaurantes/RestaurantesShell.tsx";
import { renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  document.body.innerHTML = "";
});

const CTX: RestaurantesShellContext = { apiBaseUrl: "https://api.test", token: "t", propertyId: "prop-1", orgSlug: "demo", role: "staff", staffFullName: "Persona de prueba", staffEmail: "persona@example.test", nombreSucursal: "Sucursal de prueba" };

describe("pantallas stub del panel del operador", () => {
  const PANTALLAS = [
    ["Cola", OperacionColaPage],
    ["Nuevo pedido", OperacionNuevoPedidoPage],
    ["Viajes", OperacionViajesPage],
    ["Turno", OperacionTurnoPage],
  ] as const;

  for (const [nombre, Pagina] of PANTALLAS) {
    it(`${nombre}: dice que aun no esta disponible y no ofrece ningun control`, () => {
      rendered = renderComponent(<Pagina {...CTX} />);
      expect(document.body.textContent).toContain("No disponible aún");
      expect(document.querySelectorAll("button, input, select, textarea, a")).toHaveLength(0);
    });
  }

  it("el interruptor del panel esta apagado hasta que el paquete B lo encienda", () => {
    expect(OPERACION_PANEL_ACTIVO).toBe(false);
  });
});
