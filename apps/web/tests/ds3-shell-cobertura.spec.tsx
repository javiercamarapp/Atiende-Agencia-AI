// @vitest-environment jsdom
//
// ds3 / lote 5 (cobertura del shell): TODA consola con navegacion (las 6 verticales y superadmin, cualquier rol) monta el shell unico
// (`VerticalShell`, directo o via `VerticalShellConectado`), asi que el sidebar, el encabezado, la barra movil y la hoja «Más» ds3 cubren
// todas. Ninguna pantalla arma su propio Sidebar/BottomNav. Unica excepcion documentada: el panel del repartidor (sin nav de gestion por
// seguridad). Ademas: el shell reserva la ranura del historial de «Pregúntale a tus datos». Solo AÑADE.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { CalendarCheck } from "lucide-react";
import { VerticalShell } from "@atiende/ui";
import { renderComponent, type RenderedComponent } from "./test-utils/render.tsx";
import { installMatchMediaStub, installMemoryLocalStorage } from "./test-utils/memory-storage.ts";

const aqui = dirname(fileURLToPath(import.meta.url));
const SRC = join(aqui, "../src");

function archivos(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const r = join(dir, n);
    return statSync(r).isDirectory() ? archivos(r) : /\.tsx?$/.test(n) ? [r] : [];
  });
}
const fuentes = archivos(SRC).map((r) => ({ ruta: relative(SRC, r).split("\\").join("/"), codigo: readFileSync(r, "utf8") }));

const SHELLS = [
  "verticals/restaurantes/RestaurantesShell.tsx",
  "verticals/citas/CitasShell.tsx",
  "verticals/hoteles/HotelesShell.tsx",
  "verticals/despachos/DespachosShell.tsx",
  "verticals/licitaciones/LicitacionesShell.tsx",
  "verticals/rentas/RentasShell.tsx",
  "superadmin/SuperAdminShell.tsx",
];

describe("ds3 — el shell unico cubre todas las consolas", () => {
  it("las 6 verticales y superadmin montan VerticalShell (directo o conectado)", () => {
    for (const ruta of SHELLS) {
      const f = fuentes.find((x) => x.ruta === ruta);
      expect(f, ruta).toBeDefined();
      expect(/<VerticalShell(Conectado)?[\s>]/.test(f!.codigo), ruta).toBe(true);
    }
  });

  it("ningun archivo de apps/web arma su propio Sidebar o BottomNav (solo el shell los usa)", () => {
    const propios = fuentes.filter((f) => /<(Sidebar|BottomNav)[\s>]/.test(f.codigo)).map((f) => f.ruta);
    expect(propios).toEqual([]);
  });

  it("no hay otro *Shell.tsx de consola fuera de la lista (una consola nueva debe entrar aqui)", () => {
    const shells = fuentes.filter((f) => /(^|\/)[A-Z]\w*Shell\.tsx$/.test(f.ruta) && !/VerticalShellConectado/.test(f.ruta)).map((f) => f.ruta).sort();
    expect(shells).toEqual([...SHELLS].sort());
  });

  it("el panel del repartidor es la unica pantalla operativa sin nav, a proposito (no debe ver la gestion)", () => {
    const repartidor = fuentes.find((f) => f.ruta === "verticals/restaurantes/pages/Repartidor.tsx")!;
    expect(repartidor.codigo).not.toMatch(/<VerticalShell/);
    expect(repartidor.codigo).toMatch(/SIN el shell de nav/);
  });
});

describe("ds3 — ranura del historial de «Pregúntale a tus datos»", () => {
  let rendered: RenderedComponent | undefined;
  beforeEach(() => {
    installMatchMediaStub();
    installMemoryLocalStorage();
  });
  afterEach(() => {
    rendered?.unmount();
    rendered = undefined;
  });

  const render = (historialChat?: React.ReactNode) =>
    renderComponent(
      <MemoryRouter initialEntries={["/v/demo"]}>
        <VerticalShell
          vertical="demo"
          sections={[{ title: "Resumen", siempreAbierto: true, items: [{ to: "/v/demo", label: "Resumen", icon: CalendarCheck }] }]}
          mobileItems={[]}
          user={{ email: "a@b.mx" }}
          onLogout={() => {}}
          header={{ icon: <span />, title: "Demo" }}
          historialChat={historialChat}
        >
          <p>contenido</p>
        </VerticalShell>
      </MemoryRouter>,
    );

  it("con historialChat lo monta una vez, fuera del <main>", () => {
    rendered = render(<p data-testid="historial">historial</p>);
    const ranura = rendered.container.querySelector('[data-testid="ranura-historial-chat"]')!;
    expect(ranura.querySelectorAll('[data-testid="historial"]')).toHaveLength(1);
    expect(ranura.closest("main")).toBeNull();
  });

  it("sin historialChat no hay ranura", () => {
    rendered = render();
    expect(rendered.container.querySelector('[data-testid="ranura-historial-chat"]')).toBeNull();
  });
});
