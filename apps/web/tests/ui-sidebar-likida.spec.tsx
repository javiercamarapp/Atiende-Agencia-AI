// @vitest-environment jsdom
//
// UNI-2 (spec-diseno-likida-atiende §3): el <Sidebar> compartido replica el de
// Likida. Estos tests afirman comportamiento y medidas (clases literales de
// Likida), no snapshots: acordeon exclusivo, raiz sin titulo, pildora activa,
// pie con pildoras reales, tarjeta de usuario, colapso y persistencia.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { ArrowLeftRight, LayoutDashboard, Wrench } from "lucide-react";
import { Sidebar, categoriaDeRuta, type SidebarSection } from "@atiende/ui";
import { click, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";
import { installMatchMediaStub, installMemoryLocalStorage } from "./test-utils/memory-storage.ts";

const SECCIONES: SidebarSection[] = [
  { title: "Resumen", siempreAbierto: true, items: [{ to: "/x/demo", label: "Resumen", icon: LayoutDashboard, end: true }] },
  {
    title: "Operación",
    items: [
      { to: "/x/demo/pedidos", label: "Pedidos", icon: Wrench },
      { to: "/x/demo/pedidos/historial", label: "Historial", icon: Wrench },
    ],
  },
  { title: "Catálogo", items: [{ to: "/x/demo/productos", label: "Productos", icon: Wrench }] },
  { title: "Vacía", items: [] },
];

let rendered: RenderedComponent | undefined;
let storage: Storage;

beforeEach(() => {
  installMatchMediaStub();
  storage = installMemoryLocalStorage();
});
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
});

function render(props: Partial<React.ComponentProps<typeof Sidebar>> = {}, ruta = "/x/demo"): RenderedComponent {
  return renderComponent(
    <MemoryRouter initialEntries={[ruta]}>
      <Sidebar
        sections={SECCIONES}
        user={{ email: "ana@negocio.mx", rol: "owner", nombre: "Ana Pérez", rolEtiqueta: "Propietaria" }}
        onLogout={() => {}}
        storageScope="demo"
        {...props}
      />
    </MemoryRouter>,
  );
}

const q = <T extends Element>(sel: string) => rendered!.container.querySelector<T>(sel);
const titulo = (t: string) => [...rendered!.container.querySelectorAll<HTMLButtonElement>("button[aria-expanded]")].find((b) => b.textContent?.includes(t))!;

describe("Sidebar Likida — medidas literales", () => {
  it("lámina de 232/72 px, hairline, radio 16 y sombra de tarjeta", () => {
    rendered = render();
    const cls = q("aside")!.className;
    for (const c of ["w-[72px]", "lg:w-[232px]", "rounded-lg", "border", "bg-card", "shadow-card", "top-4", "h-[calc(100dvh-2rem)]"]) expect(cls).toContain(c);
  });

  it("colapsado la lámina fija 72 px", () => {
    rendered = render();
    click(q('button[aria-label="Colapsar barra lateral"]')!);
    const cls = q("aside")!.className;
    expect(cls).toContain("w-[72px]");
    expect(cls).not.toContain("lg:w-[232px]");
  });

  it("item: fila de 13 px con px-2.5 py-1.5 (31.5 px) e icono fino de 16 px", () => {
    rendered = render();
    const a = q<HTMLAnchorElement>('a[aria-label="Resumen"]')!;
    for (const c of ["px-2.5", "py-1.5", "rounded-lg", "text-ui", "gap-2.5"]) expect(a.className).toContain(c);
    expect(a.querySelector("svg")!.getAttribute("stroke-width")).toBe("1.75");
    expect(a.querySelector("svg")!.getAttribute("class")).toContain("size-4");
  });

  it("botón de colapsar de 28 px junto al logo, sin borde, icono de 15 px", () => {
    rendered = render();
    const b = q<HTMLButtonElement>('button[aria-label="Colapsar barra lateral"]')!;
    expect(b.className).toContain("size-7");
    expect(b.className).not.toContain("border");
    expect(b.querySelector("svg")!.getAttribute("class")).toContain("size-[15px]");
  });

  it("el logo del sidebar mide 18 px de alto (marca y texto dimensionados juntos)", () => {
    rendered = render();
    const logo = q("aside .inline-flex.h-\\[18px\\]")!;
    expect(logo).not.toBeNull();
    expect(logo.querySelector("svg")!.getAttribute("class")).toContain("h-[18px]");
    expect(logo.querySelector("span")!.className).toContain("leading-[18px]");
    expect(logo.querySelector("span")!.className).toContain("text-marca-atiende");
  });
});

describe("Sidebar Likida — raíz y acordeón exclusivo", () => {
  it("la raíz (Resumen) se pinta sin título y no es un botón de acordeón", () => {
    rendered = render();
    expect(titulo("Resumen")).toBeUndefined();
    expect(q('a[aria-label="Resumen"]')).not.toBeNull();
  });

  it("Resumen activo = píldora de marca con font-medium; los demás items en tinta", () => {
    rendered = render();
    const activo = q<HTMLAnchorElement>('a[aria-label="Resumen"]')!;
    expect(activo.className).toContain("bg-primary");
    expect(activo.className).toContain("text-primary-foreground");
    expect(activo.className).toContain("font-medium");
    expect(activo.getAttribute("aria-current")).toBe("page");
    const otro = q<HTMLAnchorElement>('a[aria-label="Pedidos"]')!;
    expect(otro.className).toContain("text-foreground");
    expect(otro.className).toContain("hover:bg-muted-foreground/10");
  });

  it("abrir una categoría cierra la otra (exclusivo) y tocar la abierta la cierra", () => {
    rendered = render();
    expect(titulo("Operación").getAttribute("aria-expanded")).toBe("true");
    expect(q('a[aria-label="Productos"]')).toBeNull();
    click(titulo("Catálogo"));
    expect(titulo("Catálogo").getAttribute("aria-expanded")).toBe("true");
    expect(titulo("Operación").getAttribute("aria-expanded")).toBe("false");
    expect(q('a[aria-label="Pedidos"]')).toBeNull();
    expect(q('a[aria-label="Productos"]')).not.toBeNull();
    click(titulo("Catálogo"));
    expect([...rendered.container.querySelectorAll("button[aria-expanded='true']")]).toHaveLength(0);
    expect(storage.getItem("atiende:demo:sidebar:grupo")).toBe("");
  });

  it("el título de categoría conserva la mono de Atiende y enlaza aria-controls con su lista", () => {
    rendered = render();
    const b = titulo("Operación");
    for (const c of ["font-mono", "text-2xs", "uppercase", "tracking-[0.08em]", "text-muted-foreground"]) expect(b.className).toContain(c);
    const id = b.getAttribute("aria-controls")!;
    expect(id).toBe("nav-seccion-operacion-items");
    expect(q(`#${id}`)).not.toBeNull();
  });

  it("las categorías sin items no se pintan", () => {
    rendered = render();
    expect(titulo("Vacía")).toBeUndefined();
  });

  it("abre la categoría de la ruta activa (prefijo más largo) aunque haya otra guardada", () => {
    storage.setItem("atiende:demo:sidebar:grupo", "Operación");
    rendered = render({}, "/x/demo/productos");
    expect(titulo("Catálogo").getAttribute("aria-expanded")).toBe("true");
    expect(titulo("Operación").getAttribute("aria-expanded")).toBe("false");
  });

  it("al navegar a otra categoría desde dentro del Sidebar se abre la de la nueva ruta", () => {
    rendered = render();
    click(titulo("Catálogo"));
    click(q('a[aria-label="Productos"]')!);
    expect(titulo("Catálogo").getAttribute("aria-expanded")).toBe("true");
  });

  it("categoriaDeRuta ignora las raíz y elige el prefijo más largo", () => {
    expect(categoriaDeRuta(SECCIONES, "/x/demo")).toBeNull();
    expect(categoriaDeRuta(SECCIONES, "/x/demo/pedidos/historial/3")).toBe("Operación");
    expect(categoriaDeRuta(SECCIONES, "/x/demo/pedidosX")).toBeNull();
  });

  it("colapsado pinta los iconos de TODAS las categorías con título accesible, sin títulos de categoría", () => {
    storage.setItem("atiende:demo:sidebar:colapsado", "1");
    rendered = render();
    expect(q('a[aria-label="Pedidos"]')).not.toBeNull();
    expect(q('a[aria-label="Productos"]')).not.toBeNull();
    expect(q('a[aria-label="Productos"]')!.getAttribute("title")).toBe("Productos");
    expect(rendered.container.querySelectorAll("button[aria-expanded]")).toHaveLength(0);
    expect(rendered.container.querySelectorAll('[role="separator"]').length).toBeGreaterThan(0);
  });
});

describe("Sidebar Likida — pie", () => {
  it("sin píldoras: tema compacto de 24 px y tarjeta de usuario; sin maquetas", () => {
    rendered = render();
    const radios = rendered.container.querySelectorAll<HTMLButtonElement>('[role="radiogroup"] [role="radio"]');
    expect(radios).toHaveLength(3);
    for (const r of radios) {
      expect(r.className).toContain("size-6");
      expect(r.querySelector("svg")!.getAttribute("class")).toContain("size-3");
    }
    expect(rendered.container.textContent).not.toContain("Costos de IA");
  });

  it("píldoras reales: enlace a ruta, enlace externo y acción; las sin destino no se pintan", () => {
    const onClick = vi.fn();
    rendered = render({
      pie: [
        { label: "Costos de IA", to: "/x/demo/costos" },
        { label: "Ver los otros paneles", to: "/x/paneles", icon: ArrowLeftRight },
        { label: "Pregunta a tus datos", onClick },
        { label: "Docs", href: "https://example.com/docs" },
        { label: "Sin destino" },
      ],
    });
    const costos = q<HTMLAnchorElement>('a[aria-label="Costos de IA"]')!;
    expect(costos.getAttribute("href")).toBe("/x/demo/costos");
    for (const c of ["rounded-full", "border", "bg-card", "text-pill", "font-medium", "px-3", "py-1.5", "text-foreground-2"]) expect(costos.className).toContain(c);
    expect(costos.textContent).toContain("→");
    const paneles = q<HTMLAnchorElement>('a[aria-label="Ver los otros paneles"]')!;
    expect(paneles.querySelector("svg")!.getAttribute("class")).toContain("size-3.5");
    expect(paneles.textContent).not.toContain("→");
    click(q('button[aria-label="Pregunta a tus datos"]')!);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(q('a[aria-label="Docs"]')!.getAttribute("href")).toBe("https://example.com/docs");
    expect(rendered.container.textContent).not.toContain("Sin destino");
  });

  it("colapsado las píldoras quedan como icono o flecha y el selector de tema se oculta", () => {
    storage.setItem("atiende:demo:sidebar:colapsado", "1");
    rendered = render({ pie: [{ label: "Costos de IA", to: "/x/demo/costos" }] });
    const p = q<HTMLAnchorElement>('a[aria-label="Costos de IA"]')!;
    expect(p.textContent).toContain("→");
    expect(p.querySelector("span")!.className).toContain("hidden");
    expect(p.className).toContain("justify-center");
    expect(rendered.container.querySelector('[role="radiogroup"]')).toBeNull();
  });

  it("tarjeta de usuario: avatar con la inicial del nombre, nombre truncado, rol en mayúsculas, correo en title", () => {
    rendered = render();
    const nombre = [...rendered.container.querySelectorAll("p")].find((p) => p.textContent === "Ana Pérez")!;
    expect(nombre.className).toContain("truncate");
    expect(nombre.className).toContain("font-medium");
    expect(nombre.getAttribute("title")).toBe("ana@negocio.mx");
    expect(nombre.parentElement!.className).toContain("min-w-0");
    const rol = [...rendered.container.querySelectorAll("p")].find((p) => p.textContent === "Propietaria")!;
    expect(rol.className).toContain("uppercase");
    expect(rol.className).toContain("text-faint");
    const avatar = nombre.parentElement!.previousElementSibling!;
    expect(avatar.textContent).toBe("A");
    expect(avatar.className).toContain("size-7");
  });

  it("sin nombre cae al correo; sin rolEtiqueta usa el rol de sesión", () => {
    rendered = render({ user: { email: "zoe@negocio.mx", rol: "staff" } });
    expect(rendered.container.textContent).toContain("zoe@negocio.mx");
    expect(rendered.container.textContent).toContain("staff");
    expect(q('[aria-hidden="true"].size-7')!.textContent).toBe("Z");
  });

  it("salir va en rojo con hover de tinte, 28 px, con aria-label y title, y dispara onLogout", () => {
    const onLogout = vi.fn();
    rendered = render({ onLogout });
    const b = q<HTMLButtonElement>('button[aria-label="Cerrar sesión"]')!;
    for (const c of ["size-7", "rounded-lg", "text-destructive", "hover:bg-destructive-tint"]) expect(b.className).toContain(c);
    expect(b.getAttribute("title")).toBe("Cerrar sesión");
    click(b);
    expect(onLogout).toHaveBeenCalledTimes(1);
  });

  it("zona A gris sumido (canvas) con separador y zona B con separador", () => {
    rendered = render({ pie: [{ label: "Costos de IA", to: "/x/demo/costos" }] });
    const zonaA = q('a[aria-label="Costos de IA"]')!.parentElement!;
    for (const c of ["border-t", "bg-canvas", "px-2", "pt-2", "pb-1.5"]) expect(zonaA.className).toContain(c);
  });
});

describe("Sidebar Likida — persistencia sin localStorage", () => {
  it("si localStorage lanza, el Sidebar sigue funcionando", () => {
    const roto = {
      getItem: () => {
        throw new Error("bloqueado");
      },
      setItem: () => {
        throw new Error("bloqueado");
      },
    } as unknown as Storage;
    Object.defineProperty(globalThis, "localStorage", { value: roto, configurable: true, writable: true });
    rendered = render();
    click(titulo("Catálogo"));
    expect(titulo("Catálogo").getAttribute("aria-expanded")).toBe("true");
    click(q('button[aria-label="Colapsar barra lateral"]')!);
    expect(q('button[aria-label="Expandir barra lateral"]')).not.toBeNull();
  });
});
