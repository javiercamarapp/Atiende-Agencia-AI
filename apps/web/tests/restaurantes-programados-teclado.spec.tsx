// @vitest-environment jsdom
//
// ProgramadosPanel (Órdenes programadas de restaurantes): la fila abria el pedido con un `<div onClick>` que el teclado no alcanzaba
// (WCAG 2.1.1). Ahora la abre un `<button type="button">` real (Tab, Enter y Espacio nativos; foco con el anillo global de @atiende/ui),
// sin controles anidados: «Enviar a cocina ahora» y «Cancelar pedido» quedan fuera del boton y no abren el pedido.
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProgramadosPanel } from "../src/verticals/restaurantes/pages/ProgramadosPanel.tsx";
import type { OrderSummary } from "../src/verticals/restaurantes/lib/orders-client.ts";
import { click, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

const AHORA = Date.parse("2026-10-08T20:00:00.000Z");
const PROGRAMADO: OrderSummary = {
  id: "ord-p1",
  orderNumber: 1001,
  propertyId: "prop-1",
  branch: "Centro",
  customerId: "cust-1",
  customerName: "Pía Programada",
  customerPhone: "+529995550101",
  customerAddress: "Calle 60 por 55, Centro",
  total: 345.5,
  status: "programado",
  items: [{ id: "it-1", name: "Tacos al pastor", price: 115, quantity: 3 }],
  source: "web",
  notes: null,
  paymentMethod: "efectivo",
  createdAt: "2026-10-08T19:30:00.000Z",
  assignedRepartidorId: null,
  estimatedDeliveryAt: null,
  incidentNote: null,
  canal: "domicilio",
  programadoPara: "2026-10-08T23:00:00.000Z",
};

let rendered: RenderedComponent | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
});

function pintar() {
  const onAbrir = vi.fn();
  const onAdelantar = vi.fn();
  const onCancelar = vi.fn();
  rendered = renderComponent(
    <ProgramadosPanel orders={[PROGRAMADO]} disponible ahoraMs={AHORA} changingId={null} onAbrir={onAbrir} onAdelantar={onAdelantar} onCancelar={onCancelar} />,
  );
  const fila = rendered.container.querySelector<HTMLElement>('[data-testid="programado-ord-p1"]')!;
  const abrir = rendered.container.querySelector<HTMLButtonElement>('[data-testid="programado-abrir-ord-p1"]')!;
  const boton = (texto: string) => [...fila.querySelectorAll("button")].find((b) => b.textContent?.trim() === texto)!;
  return { fila, abrir, boton, onAbrir, onAdelantar, onCancelar };
}

describe("ProgramadosPanel: abrir el pedido con teclado", () => {
  it("la fila se abre con un <button type=button> real, con nombre accesible y alcanzable con Tab", () => {
    const { abrir } = pintar();
    expect(abrir.tagName).toBe("BUTTON");
    expect(abrir.type).toBe("button");
    expect(abrir.getAttribute("aria-label")).toBe("Abrir el pedido de Pía Programada");
    expect(abrir.disabled).toBe(false);
    expect(abrir.tabIndex).toBe(0);
    abrir.focus();
    expect(document.activeElement).toBe(abrir);
    // Foco visible: no apaga el anillo global de :focus-visible de @atiende/ui.
    expect(abrir.className).not.toMatch(/\boutline-none\b/);
    // El contenido de la fila (hora, total, insignias) esta dentro del boton: el area de clic es la misma que antes.
    expect(abrir.querySelector('[data-testid="programado-para-ord-p1"]')?.textContent).toBe("8 oct, 17:00");
  });

  it("la fila ya no es un contenedor con clic: ni el <div> ni ningun otro elemento no interactivo abre el pedido", () => {
    const { fila, onAbrir } = pintar();
    click(fila);
    expect(onAbrir).not.toHaveBeenCalled();
  });

  it("activar el boton (lo que Enter y Espacio hacen en un <button> nativo) abre el pedido una sola vez", () => {
    const { abrir, onAbrir } = pintar();
    click(abrir);
    expect(onAbrir).toHaveBeenCalledTimes(1);
    expect(onAbrir).toHaveBeenCalledWith(PROGRAMADO);
  });

  it("sin controles anidados: las acciones viven fuera del boton y no abren el pedido", () => {
    const { fila, abrir, boton, onAbrir, onAdelantar, onCancelar } = pintar();
    expect(abrir.querySelector("button, a, input, select, textarea, [tabindex]")).toBeNull();
    expect(abrir.querySelector("div, p")).toBeNull(); // solo contenido de frase dentro de <button>
    expect(fila.querySelectorAll("button")).toHaveLength(3);
    click(boton("Enviar a cocina ahora"));
    expect(onAdelantar).toHaveBeenCalledWith(PROGRAMADO);
    click(boton("Cancelar pedido"));
    expect(onCancelar).toHaveBeenCalledWith(PROGRAMADO);
    expect(onAbrir).not.toHaveBeenCalled();
  });
});
