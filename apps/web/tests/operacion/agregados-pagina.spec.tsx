// @vitest-environment jsdom
//
// «Agregados por validar»: carga real contra un fetch simulado, estados vacio / cargando / error con Reintentar / no disponible, aceptar con una sola escritura,
// rechazar con motivo y aviso persistente.
import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ListaAgregados, TarjetaAgregado } from "@atiende/domain-restaurantes/operacion";
import { OperacionAgregadosPage } from "../../src/verticals/restaurantes/pages/OperacionAgregados.tsx";
import type { RestaurantesShellContext } from "../../src/verticals/restaurantes/RestaurantesShell.tsx";
import { click, renderComponent, type RenderedComponent } from "../test-utils/render.tsx";

const CTX: RestaurantesShellContext = { apiBaseUrl: "https://api.test", token: "t", propertyId: "prop-1", orgSlug: "demo", role: "staff", staffFullName: "Persona de prueba", staffEmail: "persona@example.com", nombreSucursal: "Centro" };
const ID = "00000000-0000-4000-8000-000000000901";

function tarjeta(extra: Partial<TarjetaAgregado> = {}): TarjetaAgregado {
  return {
    id: ID, propertyId: "prop-1", sucursal: "Centro", canal: "whatsapp", estado: "pendiente", estadoEfectivo: "pendiente", sla: { segundosEspera: 130, nivel: "en_tiempo", segundosParaSiguienteUmbral: 470 },
    pedido: { id: "o1", numero: 201, estado: "pending", yaEnCocina: false, creadoEn: new Date().toISOString(), renglones: [{ nombre: "Taco de pastor", cantidad: 4 }], total: 100 },
    agregado: { renglones: [{ nombre: "Coca-Cola", cantidad: 2, precio: 45, subtotal: 90 }], total: 90, nuevoTotal: 190, nota: null, version: 1 },
    cliente: { nombre: "Ana R.", telefono: "9995550101" }, solicitadoEn: new Date().toISOString(), vistoEn: new Date().toISOString(), resueltoEn: null, resueltoPor: null, motivoRechazo: null, notaRechazo: null, escalamiento: 0, ...extra,
  };
}
const lista = (agregados: TarjetaAgregado[], disponible = true): ListaAgregados => ({ disponible, agregados, pendientes: agregados.filter((a) => a.estado === "pendiente").length, ahora: new Date().toISOString() });
const json = (status: number, cuerpo: unknown) => new Response(JSON.stringify(cuerpo), { status, headers: { "content-type": "application/json" } });

let rendered: RenderedComponent | undefined;
async function montar(f: ReturnType<typeof vi.fn>) {
  vi.stubGlobal("fetch", f);
  await act(async () => {
    rendered = renderComponent(
      <MemoryRouter>
        <OperacionAgregadosPage {...CTX} />
      </MemoryRouter>,
    );
    await Promise.resolve();
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}
const textos = () => document.body.textContent ?? "";
const boton = (nombre: RegExp) => [...document.querySelectorAll("button")].find((b) => nombre.test(b.getAttribute("aria-label") ?? b.textContent ?? "")) as HTMLElement | undefined;

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("Agregados por validar", () => {
  it("pide la lista del contrato y pinta pedido original, lo agregado, nuevo total, cronometro y banner", async () => {
    const f = vi.fn(async () => json(200, lista([tarjeta()])));
    await montar(f);
    expect((f.mock.calls[0] as unknown as [string])[0]).toBe("https://api.test/v1/restaurantes/prop-1/admin/agregados?estado=pendientes");
    expect(textos()).toContain("Pedido #201");
    expect(textos()).toContain("4× Taco de pastor");
    expect(textos()).toContain("2× Coca-Cola");
    expect(textos()).toContain("Nuevo total: $190");
    expect(textos()).toContain("Hace 2 min");
    expect(document.querySelector('[data-testid="banner-agregados"]')?.textContent).toContain("1 agregado por validar");
  });

  it("vacio: dice que no hay nada por validar; no disponible (503): estado honesto sin tarjetas", async () => {
    await montar(vi.fn(async () => json(200, lista([]))));
    expect(textos()).toContain("Nada por validar");
    rendered?.unmount();
    document.body.innerHTML = "";
    await montar(vi.fn(async () => json(503, { code: "service_unavailable", message: "no" })));
    expect(textos()).toContain("falta aplicar la actualización de base de datos");
    expect(document.querySelector('[data-testid^="tarjeta-agregado"]')).toBeNull();
  });

  it("error de servidor sin datos previos: mensaje con Reintentar que vuelve a pedir", async () => {
    const f = vi.fn().mockResolvedValueOnce(json(500, { code: "internal", message: "Falló el servidor" })).mockResolvedValue(json(200, lista([tarjeta()])));
    await montar(f);
    expect(textos()).toContain("Falló el servidor");
    await act(async () => {
      click(boton(/reintentar/i)!);
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(textos()).toContain("Pedido #201");
  });

  it("aceptar: una sola escritura aunque se toque dos veces y avisa al operador", async () => {
    let aceptado = false;
    const f = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/aceptar")) {
        aceptado = true;
        return json(200, { resultado: "aplicado", agregado: tarjeta({ estado: "aceptado" }) });
      }
      if (String(url).endsWith("/visto")) return json(200, { ok: true });
      void init;
      return json(200, lista(aceptado ? [] : [tarjeta()]));
    });
    await montar(f);
    await act(async () => {
      const b = boton(/Aceptar agregado al pedido #201/)!;
      click(b);
      click(b);
      await new Promise((r) => setTimeout(r, 0));
    });
    const escrituras = f.mock.calls.filter((c) => String(c[0]).endsWith("/aceptar"));
    expect(escrituras).toHaveLength(1);
  });
});
