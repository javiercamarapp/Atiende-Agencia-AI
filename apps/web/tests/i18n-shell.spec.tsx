// @vitest-environment jsdom
//
// i18n ES/EN — shell y navegacion. Con el proveedor en ingles, el marco compartido (Sidebar, barra movil, menu de cuenta, tema)
// habla ingles y el cambio ES -> EN se ve en caliente sin recargar; en espanol queda IDENTICO a antes (ningun spec existente cambia).
// Ademas: las etiquetas canonicas de superadmin (rutas.ts) coinciden con su clave en espanol, y los roles salen en el idioma activo.
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import { LayoutDashboard, Wrench } from "lucide-react";
import { BottomNav, IdiomaProvider, Sidebar, cargarIdioma, crearTraductor, traducir, type SidebarSection } from "@atiende/ui";
import { guardarIdioma } from "../../../packages/ui/src/lib/idioma.ts";
import { CLAVES_ROL, etiquetaRol } from "../src/lib/roles.ts";
import { COPILOTO, MOVIL_SUPERADMIN, PIE_SUPERADMIN, RESUMEN, SECCIONES } from "../src/superadmin/rutas.ts";
import { CLAVE_SECCION_SUPERADMIN, claveRutaSuperadmin } from "../src/superadmin/rutas-i18n.ts";
import "@atiende/ui/i18n/nav";
import "@atiende/ui/i18n/rol";
import { renderComponent, type RenderedComponent } from "./test-utils/render.tsx";
import { installMatchMediaStub, installMemoryLocalStorage } from "./test-utils/memory-storage.ts";

const SECCIONES_DEMO: SidebarSection[] = [
  { title: "Resumen", siempreAbierto: true, items: [{ to: "/x/demo", label: "Resumen", icon: LayoutDashboard }] },
  { title: "Operación", items: [{ to: "/x/demo/mant", label: "Mantenimiento", icon: Wrench }] },
];

let rendered: RenderedComponent | undefined;

// El ingles es un chunk perezoso: se precarga para que el cambio sea sincrono en la prueba.
beforeAll(() => cargarIdioma("en"));

beforeEach(() => {
  installMatchMediaStub();
  installMemoryLocalStorage();
  document.documentElement.lang = "es";
});
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
});

function marco(idioma?: "es" | "en"): RenderedComponent {
  return renderComponent(
    <IdiomaProvider idiomaInicial={idioma}>
      <MemoryRouter initialEntries={["/x/demo"]}>
        <Sidebar sections={SECCIONES_DEMO} user={{ email: "a@b.com", rol: "owner", nombre: "Ana" }} onLogout={() => {}} storageScope="citas" />
        <BottomNav items={[{ to: "/x/demo", label: "Resumen", icon: LayoutDashboard }]} moreSections={SECCIONES_DEMO} />
      </MemoryRouter>
    </IdiomaProvider>,
  );
}

const etiquetas = (c: HTMLElement) => [...c.querySelectorAll("[aria-label]")].map((e) => e.getAttribute("aria-label"));

describe("shell en espanol (sin cambios)", () => {
  it("las etiquetas del marco son las de siempre", () => {
    rendered = marco("es");
    const l = etiquetas(rendered.container);
    expect(l).toEqual(expect.arrayContaining(["Navegación principal", "Navegación móvil", "Cerrar sesión", "Tema de la interfaz", "Tema claro"]));
    expect(rendered.container.textContent).toContain("Más");
  });
});

describe("shell en ingles", () => {
  it("el marco compartido habla ingles natural", () => {
    rendered = marco("en");
    const l = etiquetas(rendered.container);
    expect(l).toEqual(expect.arrayContaining(["Main navigation", "Mobile navigation", "Sign out", "Interface theme", "Light theme", "Match system", "Dark theme"]));
    expect(l.join(" ")).not.toMatch(/Navegación|Cerrar sesión|Tema /);
    expect(rendered.container.textContent).toContain("More");
  });

  it("cambia en caliente cuando el selector guarda EN", () => {
    rendered = marco();
    expect(etiquetas(rendered.container)).toContain("Navegación principal");
    act(() => guardarIdioma("en"));
    expect(etiquetas(rendered.container)).toContain("Main navigation");
    expect(document.documentElement.lang).toBe("en");
  });
});

describe("superadmin: etiqueta canonica y clave", () => {
  it("cada ruta del menu, del pie y de la barra movil tiene clave y su texto en espanol es la etiqueta de siempre", () => {
    const rutas = [RESUMEN, COPILOTO, ...SECCIONES.flatMap((s) => s.items), ...MOVIL_SUPERADMIN, ...PIE_SUPERADMIN];
    for (const r of rutas) {
      const clave = claveRutaSuperadmin(r.to, r.label);
      expect(clave, `${r.to} ${r.label}`).toBeDefined();
      if (clave) expect(traducir("es", clave), r.label).toBe(r.label);
    }
    for (const s of SECCIONES) {
      const clave = CLAVE_SECCION_SUPERADMIN[s.title];
      expect(clave, s.title).toBeDefined();
      if (clave) expect(traducir("es", clave)).toBe(s.title);
    }
  });

  it("en ingles ninguna etiqueta del menu queda igual que en espanol salvo nombres propios", () => {
    const iguales = [RESUMEN, COPILOTO, ...SECCIONES.flatMap((s) => s.items)].filter((r) => traducir("en", claveRutaSuperadmin(r.to, r.label)!) === r.label).map((r) => r.label);
    expect(iguales).toEqual(["Model Ops"]);
  });
});

describe("roles", () => {
  it("sin traductor, espanol (compatibilidad); con traductor, el idioma activo; un rol desconocido pasa tal cual", () => {
    expect(etiquetaRol("owner")).toBe("Propietario");
    expect(etiquetaRol("owner", crearTraductor("en"))).toBe("Owner");
    expect(etiquetaRol("operador:solo_calendario", crearTraductor("en"))).toBe("Operator (calendar only)");
    expect(etiquetaRol("rol-nuevo", crearTraductor("en"))).toBe("rol-nuevo");
    expect(etiquetaRol("constructor")).toBe("constructor");
    expect(etiquetaRol(undefined)).toBeUndefined();
  });

  it("todo rol con clave tiene texto en los dos idiomas", () => {
    for (const clave of Object.values(CLAVES_ROL)) {
      expect(traducir("es", clave)).not.toBe(clave);
      expect(traducir("en", clave)).not.toBe(clave);
    }
  });
});
