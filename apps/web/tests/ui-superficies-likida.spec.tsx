// @vitest-environment jsdom
//
// UNI-3b: superficies identicas a Likida -- Card, Table, DataTable y StatCard.
// Se fijan las clases que materializan la receta (spec-diseno-likida-atiende §6.2-6.4);
// la medicion en pixeles contra Likida va en las capturas del PR (e2e).
import { Activity, Users } from "lucide-react";
import { afterEach, describe, expect, it } from "vitest";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  DataTable,
  StatCard,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TrendStatCard,
} from "@atiende/ui";
import { renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
});
const montar = (el: React.ReactElement) => (rendered = renderComponent(el)).container;

describe("Card", () => {
  it("es la tarjeta de Likida: clase card, radio 16, hairline y sombra fina, sin relleno propio", () => {
    const c = montar(<Card data-testid="x" className="p-4" />);
    const el = c.firstElementChild as HTMLElement;
    for (const clase of ["card", "min-w-0", "rounded-lg", "border", "border-border", "bg-card", "shadow-sm", "p-4"]) expect(el.className).toContain(clase);
  });

  it("CardTitle es un h2 limpio de 14 px (sin 24 px ni tracking) y CardHeader/Content/Footer usan p-4", () => {
    const c = montar(
      <Card>
        <CardHeader>
          <CardTitle>Pedidos</CardTitle>
          <CardDescription>Ultimos 7 dias</CardDescription>
        </CardHeader>
        <CardContent>cuerpo</CardContent>
        <CardFooter>pie</CardFooter>
      </Card>,
    );
    const titulo = c.querySelector("h2")!;
    expect(titulo.textContent).toBe("Pedidos");
    expect(c.querySelector("h3")).toBeNull();
    expect(titulo.className).toContain("text-sm");
    expect(titulo.className).toContain("font-medium");
    expect(titulo.className).not.toMatch(/text-2xl|tracking-tight/);
    expect(c.querySelector("p")!.className).toContain("text-ui");
    expect(c.firstElementChild!.children[0]!.className).toContain("p-4");
    expect(c.firstElementChild!.children[1]!.className).toContain("p-4 pt-0");
    expect(c.firstElementChild!.children[2]!.className).toContain("p-4 pt-0");
  });

  it("un className del consumidor gana sobre el relleno por defecto", () => {
    const c = montar(<CardContent className="p-0">x</CardContent>);
    expect(c.firstElementChild!.className).toContain("p-0");
    expect(c.firstElementChild!.className).not.toContain("p-4");
  });
});

describe("Table", () => {
  const tabla = () =>
    montar(
      <Card>
        <Table aria-label="Demo">
          <TableHeader>
            <TableRow>
              <TableHead>Nombre</TableHead>
              <TableHead>Total</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell>Ana</TableCell>
              <TableCell>10</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </Card>,
    );

  it("cabecera mono de 10 px sobre canvas, celdas px-3 py-2 (fila de ~37 px) y filas con linea line2", () => {
    const c = tabla();
    const th = c.querySelector("th")!;
    for (const clase of ["px-3", "py-1.5", "etiqueta-mono", "text-2xs", "uppercase", "text-muted-foreground"]) expect(th.className).toContain(clase);
    expect(th.className).not.toContain("h-12");
    expect(c.querySelector("thead")!.className).toContain("[&_th]:bg-canvas");
    const td = c.querySelector("td")!;
    expect(td.className).toContain("px-3");
    expect(td.className).toContain("py-2");
    expect(td.className).not.toContain("p-4");
    const fila = c.querySelector("tbody tr")!;
    expect(fila.className).toContain("border-line2");
    expect(fila.className).toContain("hover:bg-canvas");
  });

  it("el contenedor hace scroll horizontal interno y no ensancha a su padre (min-w-0)", () => {
    const envoltorio = tabla().querySelector("table")!.parentElement!;
    expect(envoltorio.className).toContain("overflow-x-auto");
    expect(envoltorio.className).toContain("min-w-0");
    expect(envoltorio.className).toContain("max-w-full");
  });
});

describe("DataTable (receta de Likida)", () => {
  interface Fila {
    id: string;
    n: string;
  }
  it("filas punteadas, encabezado sin alto fijo, contenedor con scroll interno y paginacion compacta", () => {
    const filas: Fila[] = Array.from({ length: 12 }, (_, i) => ({ id: `f${i}`, n: `Fila ${i}` }));
    const c = montar(
      <DataTable<Fila>
        etiqueta="Filas"
        filas={filas}
        obtenerId={(f) => f.id}
        columnas={[{ id: "n", encabezado: "Nombre", celda: (f) => f.n, valorOrden: (f) => f.n }]}
      />,
    );
    expect(c.querySelector("table")!.className).toContain("[&_tbody_tr]:border-dashed");
    expect(c.querySelector("th")!.className).not.toMatch(/\bh-11\b|\bh-12\b/);
    expect(c.firstElementChild!.className).toContain("min-w-0");
    expect(c.querySelector("table")!.parentElement!.className).toContain("overflow-x-auto");
    const anterior = [...c.querySelectorAll("button")].find((b) => b.textContent?.includes("Anterior"))!;
    expect(anterior.className).toContain("h-7");
    expect(anterior.className).toContain("text-xs");
  });
});

describe("StatCard de dos capas", () => {
  it("anatomia: tarjeta exterior card p-2, interior con borde line2, chip circular azul, etiqueta, cifra", () => {
    const c = montar(<StatCard icon={Users} label="Clientes" value="1,204" nota="este mes" />);
    const ext = c.firstElementChild as HTMLElement;
    for (const clase of ["card", "p-2", "h-full", "flex-col", "min-w-0", "bg-card", "rounded-lg", "shadow-sm"]) expect(ext.className).toContain(clase);
    const interior = ext.firstElementChild as HTMLElement;
    for (const clase of ["rounded-xl", "border", "border-line2", "bg-canvas", "px-3", "py-2"]) expect(interior.className).toContain(clase);
    const chip = interior.querySelector("svg")!.parentElement as HTMLElement;
    for (const clase of ["size-7", "rounded-full", "bg-primary", "text-primary-foreground"]) expect(chip.className).toContain(clase);
    expect(chip.querySelector("svg")!.getAttribute("class")).toContain("size-[15px]");
    expect(interior.querySelector("span")!.className).toContain("text-muted-foreground");
    const cifra = interior.querySelector("p")!;
    expect(cifra.textContent).toBe("1,204");
    expect(cifra.getAttribute("title")).toBe("1,204");
    for (const clase of ["font-display", "text-xl", "font-semibold", "tabular-nums", "truncate"]) expect(cifra.className).toContain(clase);
  });

  it("el pie va tras un divisor punteado", () => {
    const c = montar(<StatCard icon={Users} label="Clientes" value="3" nota="este mes" />);
    const pie = c.firstElementChild!.lastElementChild as HTMLElement;
    expect(pie.className).toContain("border-dashed");
    expect(pie.className).toContain("border-line2");
    expect(pie.textContent).toBe("este mes");
  });

  it("sin nota ni delta no hay pie", () => {
    const c = montar(<StatCard icon={Users} label="Clientes" value="3" />);
    expect(c.querySelector(".border-dashed")).toBeNull();
  });

  it("nota con + va en verde, con - en rojo, y neutra en gris tenue", () => {
    const c1 = montar(<StatCard icon={Users} label="a" value="1" nota="+12 vs ayer" />);
    expect(c1.querySelector(".border-dashed p")!.className).toContain("text-success");
    rendered?.unmount();
    const c2 = montar(<StatCard icon={Users} label="a" value="1" nota="-3 vs ayer" />);
    expect(c2.querySelector(".border-dashed p")!.className).toContain("text-destructive");
    rendered?.unmount();
    const c3 = montar(<StatCard icon={Users} label="a" value="1" nota="sin cambio" />);
    expect(c3.querySelector(".border-dashed p")!.className).toContain("text-faint");
  });

  it("sin dato real: guion gris, explicacion en el pie, nunca la cifra ni un 0", () => {
    const c = montar(<StatCard icon={Activity} label="MRR" value="$99" nota="no debe verse" sinDato="Falta el tipo de cambio" />);
    const cifra = c.querySelector("p")!;
    expect(cifra.textContent).toBe("—");
    expect(cifra.className).toContain("text-faint");
    expect(cifra.getAttribute("aria-label")).toBe("MRR: sin dato");
    expect(cifra.hasAttribute("title")).toBe(false);
    expect(c.textContent).toContain("Falta el tipo de cambio");
    expect(c.textContent).not.toContain("$99");
    expect(c.textContent).not.toContain("no debe verse");
  });

  it("delta: flecha, signo por bueno/malo y nota del periodo", () => {
    const sube = montar(<StatCard icon={Users} label="a" value="1" delta={{ pct: 12, bueno: true }} deltaNota="vs mes anterior" />);
    const pie = sube.querySelector(".border-dashed")!;
    expect(pie.textContent).toBe("↑ 12%vs mes anterior");
    expect(pie.querySelector("span")!.className).toContain("text-success");
    rendered?.unmount();
    const baja = montar(<StatCard icon={Users} label="a" value="1" delta={{ pct: -4.5, bueno: false }} />);
    expect(baja.querySelector(".border-dashed")!.textContent).toBe("↓ 4.5%vs periodo anterior");
    expect(baja.querySelector(".border-dashed span")!.className).toContain("text-destructive");
  });

  it("delta 0 va en gris sin flecha; delta null dice que no hay periodo comparable (nunca un 0 % inventado)", () => {
    const cero = montar(<StatCard icon={Users} label="a" value="1" delta={{ pct: 0, bueno: true }} />);
    expect(cero.querySelector(".border-dashed")!.textContent).toBe("0%sin cambio vs periodo anterior");
    expect(cero.querySelector(".border-dashed span")!.className).toContain("text-faint");
    rendered?.unmount();
    const nulo = montar(<StatCard icon={Users} label="a" value="1" delta={null} />);
    expect(nulo.querySelector(".border-dashed")!.textContent).toBe("sin periodo comparable");
  });

  it("TrendStatCard reutiliza la tarjeta de dos capas con el pie de tendencia", () => {
    const c = montar(<TrendStatCard icon={Users} label="Ingresos" value="$5" deltaPct={8.26} />);
    expect(c.firstElementChild!.className).toContain("card");
    expect(c.querySelector(".border-dashed")!.textContent).toBe("↑ 8.3%vs periodo anterior");
    rendered?.unmount();
    const sin = montar(<TrendStatCard icon={Users} label="Ingresos" value="$5" />);
    expect(sin.querySelector(".border-dashed")).toBeNull();
  });
});
