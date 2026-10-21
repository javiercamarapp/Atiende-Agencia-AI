// Buscador de productos y lineas del pedido (cantidad, tortilla, nota) para la captura rapida. Presentacional: el catalogo lo trae la pagina.
import { Button, Input, formatMoney } from "@atiende/ui";
import { Minus, Plus, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import type { LineaCaptura } from "../../lib/captura-pedido.ts";
import type { Product } from "../../lib/catalog-client.ts";

export function precioDe(p: Product): number {
  return p.branch?.price ?? p.price;
}

export function disponible(p: Product): boolean {
  return p.isAvailable && p.branch?.isAvailable !== false;
}

function normalizar(t: string): string {
  return t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

export function buscarProductos(productos: readonly Product[], consulta: string, max = 8): readonly Product[] {
  const q = normalizar(consulta.trim());
  const base = productos.filter(disponible);
  if (!q) return [...base].sort((a, b) => Number(b.isPopular) - Number(a.isPopular) || a.displayOrder - b.displayOrder).slice(0, max);
  return base.filter((p) => normalizar(`${p.name} ${p.searchKeywords.join(" ")}`).includes(q)).slice(0, max);
}

export function SelectorProductos({
  productos,
  lineas,
  alCambiar,
}: {
  readonly productos: readonly Product[];
  readonly lineas: readonly LineaCaptura[];
  readonly alCambiar: (lineas: readonly LineaCaptura[]) => void;
}) {
  const [consulta, setConsulta] = useState("");
  const resultados = useMemo(() => buscarProductos(productos, consulta), [productos, consulta]);
  const precios = useMemo(() => new Map(productos.map((p) => [p.id, precioDe(p)])), [productos]);

  const agregar = (p: Product) => {
    const i = lineas.findIndex((l) => l.productId === p.id && l.tortilla === null && l.nota === "");
    if (i >= 0) alCambiar(lineas.map((l, j) => (j === i ? { ...l, cantidad: Math.min(99, l.cantidad + 1) } : l)));
    else alCambiar([...lineas, { productId: p.id, nombre: p.name, cantidad: 1, tortilla: null, nota: "" }]);
  };
  const cambiar = (i: number, parche: Partial<LineaCaptura>) => alCambiar(lineas.map((l, j) => (j === i ? { ...l, ...parche } : l)));
  const quitar = (i: number) => alCambiar(lineas.filter((_, j) => j !== i));

  return (
    <div className="space-y-3">
      <Input type="search" inputMode="search" aria-label="Buscar producto" placeholder="Buscar producto…" value={consulta} onChange={(e) => setConsulta(e.target.value)} className="h-12 text-base" />
      <ul className="space-y-2" aria-label="Resultados de productos">
        {resultados.map((p) => (
          <li key={p.id}>
            <Button type="button" variant="outline" className="h-12 w-full justify-between text-base" onClick={() => agregar(p)} aria-label={`Agregar ${p.name}`}>
              <span className="truncate text-left">{p.name}</span>
              <span className="shrink-0">{formatMoney(precioDe(p))}</span>
            </Button>
          </li>
        ))}
        {resultados.length === 0 && <li className="text-base text-muted-foreground">Ningún producto disponible coincide.</li>}
      </ul>
      {lineas.length > 0 && (
        <ul className="space-y-3" aria-label="Productos del pedido">
          {lineas.map((l, i) => (
            <li key={`${l.productId}-${i}`} className="space-y-2 rounded-lg border border-border bg-card p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-base font-medium text-foreground">{l.nombre}</p>
                <p className="text-base text-muted-foreground">{formatMoney((precios.get(l.productId) ?? 0) * l.cantidad)}</p>
              </div>
              <div className="flex items-center gap-2">
                <Button type="button" variant="outline" className="size-12" aria-label={`Quitar una ${l.nombre}`} disabled={l.cantidad <= 1} onClick={() => cambiar(i, { cantidad: l.cantidad - 1 })}>
                  <Minus className="size-5" aria-hidden="true" />
                </Button>
                <span className="min-w-8 text-center text-lg font-bold" aria-live="polite" data-testid={`cantidad-${i}`}>
                  {l.cantidad}
                </span>
                <Button type="button" variant="outline" className="size-12" aria-label={`Agregar una ${l.nombre}`} disabled={l.cantidad >= 99} onClick={() => cambiar(i, { cantidad: l.cantidad + 1 })}>
                  <Plus className="size-5" aria-hidden="true" />
                </Button>
                <Button type="button" variant="outline" className="ml-auto h-12" aria-label={`Quitar ${l.nombre} del pedido`} onClick={() => quitar(i)}>
                  <Trash2 className="size-5" aria-hidden="true" />
                </Button>
              </div>
              <div role="group" aria-label={`Tortilla de ${l.nombre}`} className="flex gap-2">
                {(["maiz", "harina"] as const).map((t) => (
                  <Button key={t} type="button" className="h-11 flex-1" variant={l.tortilla === t ? "default" : "outline"} aria-pressed={l.tortilla === t} onClick={() => cambiar(i, { tortilla: l.tortilla === t ? null : t })}>
                    {t === "maiz" ? "Tortilla de maíz" : "Tortilla de harina"}
                  </Button>
                ))}
              </div>
              <Input aria-label={`Nota de ${l.nombre}`} placeholder="Nota (sin cebolla, extra salsa…)" maxLength={240} value={l.nota} onChange={(e) => cambiar(i, { nota: e.target.value })} className="h-11 text-base" />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
