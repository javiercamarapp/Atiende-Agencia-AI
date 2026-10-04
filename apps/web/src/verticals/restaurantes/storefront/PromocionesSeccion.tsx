// R-38: promociones vigentes que el motor aplica SOLAS a un pedido para recoger. Lo que se lista sale de la base (autoApply, activa,
// dentro de fechas, con usos disponibles y valida en recoger); las condiciones de dia, hora, minimo y sucursal se muestran tal cual
// las evalua el motor al cotizar, asi que nunca se promete algo que no se aplique. Sin promociones, la seccion no aparece.
import { Card, StatusBadge } from "@atiende/ui";
import { formatoPesos } from "./carrito.ts";
import type { PromocionPublica, SucursalPublica } from "./storefront-client.ts";

const DIAS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"] as const;

export function textoDias(dias: readonly number[] | null): string | null {
  if (!dias || dias.length === 0 || dias.length === 7) return null;
  const nombres = dias.filter((d) => d >= 0 && d <= 6).map((d) => DIAS[d]!);
  if (nombres.length === 0) return null;
  return nombres.length === 1 ? `Solo el ${nombres[0]}` : `${nombres.slice(0, -1).join(", ")} y ${nombres.at(-1)}`;
}

function fechaCorta(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d}/${m}/${y}`;
}

/** Condiciones de la promocion en frases cortas, en el orden en que importan al cliente. */
export function condicionesDe(p: PromocionPublica, sucursales: readonly SucursalPublica[]): string[] {
  const out = ["Solo al recoger en la sucursal"];
  const dias = textoDias(p.dias);
  if (dias) out.push(dias);
  if (p.horaInicio || p.horaFin) out.push(`de ${p.horaInicio?.slice(0, 5) ?? "00:00"} a ${p.horaFin?.slice(0, 5) ?? "23:59"}`);
  if (p.pedidoMinimo !== null) out.push(`pedido mínimo ${formatoPesos(p.pedidoMinimo)}`);
  if (p.vigenteHasta) out.push(`hasta el ${fechaCorta(p.vigenteHasta)}`);
  if (p.sucursales) {
    const nombres = p.sucursales.map((slug) => sucursales.find((s) => s.slug === slug)?.name ?? slug);
    out.push(`en ${nombres.join(", ")}`);
  }
  return out;
}

export function PromocionesSeccion({ promociones, sucursales }: { promociones: readonly PromocionPublica[] | undefined; sucursales: readonly SucursalPublica[] }) {
  if (!promociones || promociones.length === 0) return null;
  return (
    <section aria-labelledby="promociones-titulo" className="mt-4">
      <h2 id="promociones-titulo" className="text-sm font-medium">
        Promociones
      </h2>
      <ul className="mt-2 grid gap-3 sm:grid-cols-2">
        {promociones.map((p) => (
          <li key={p.id}>
            <Card className="flex flex-col gap-1.5 p-4">
              <StatusBadge tone="success" className="self-start">
                {p.beneficio}
              </StatusBadge>
              <h3 className="text-sm font-medium">{p.nombre}</h3>
              {p.descripcion && <p className="text-sm text-muted-foreground">{p.descripcion}</p>}
              <p className="text-xs text-muted-foreground">{condicionesDe(p, sucursales).join(" · ")}</p>
            </Card>
          </li>
        ))}
      </ul>
    </section>
  );
}
