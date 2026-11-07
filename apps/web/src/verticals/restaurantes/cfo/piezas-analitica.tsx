// Analítica del dueño (F7) · piezas compartidas por sus pestañas: selector de sucursal (o «Todas») y aviso con las reglas de lectura honesta.
import { RadioSegmentado } from "@atiende/ui";

export const TODAS = "todas";

export function SelectorSucursalAnalitica({ nombre, sucursales, valor, onChange, hayTotal }: {
  readonly nombre: string;
  readonly sucursales: readonly { readonly propertyId: string; readonly nombre: string }[];
  readonly valor: string;
  readonly onChange: (v: string) => void;
  /** true = la vista trae también la fila del conjunto («Todas»). */
  readonly hayTotal: boolean;
}) {
  if (sucursales.length <= 1) return null;
  const opciones = [...(hayTotal ? [{ id: TODAS, rotulo: "Todas" }] : []), ...sucursales.map((s) => ({ id: s.propertyId, rotulo: s.nombre }))];
  return <RadioSegmentado<string> name={nombre} label="Sucursal" opciones={opciones} value={valor} onChange={onChange} className="gap-1" />;
}

export const nombreDe = (sucursales: readonly { readonly propertyId: string; readonly nombre: string }[]): ReadonlyMap<string, string> => new Map(sucursales.map((s) => [s.propertyId, s.nombre]));
