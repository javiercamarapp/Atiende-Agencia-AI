// Piezas compartidas de las secciones de Finanzas (Rn-15): constantes de presentación y el renglón monetario.
import { centavosAPesos } from "../../lib/finanzas-client.ts";

export interface SectionProps {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  readonly puedeEscribir: boolean;
}

export const FINANZAS_LECTURA_ROLES = new Set(["admin_gestora", "contador"]);
export const FINANZAS_ESCRITURA_ROLES = new Set(["admin_gestora"]);

export const LABEL_CLASES = "flex flex-col gap-1.5 text-sm text-foreground";
export const NOTA_CLASES = "m-0 rounded-lg border border-border bg-muted px-2.5 py-1.5 text-xs text-foreground";

export const TIPO_LINEA_LABELS: Record<string, string> = {
  ingreso: "Ingreso",
  comision_canal: "Comisión de canal",
  comision_gestor: "Comisión de gestor",
  gasto: "Gasto",
  impuesto: "Impuesto",
};

export const ESTADO_CONCILIACION_LABELS: Record<string, string> = {
  conciliado: "Conciliado",
  pendiente: "Pendiente",
  discrepancia: "Discrepancia",
};


export function Linea({ label, valorCentavos, moneda, fuerte }: { label: string; valorCentavos: number; moneda: string; fuerte?: boolean }) {
  const signo = valorCentavos < 0 ? "-" : "";
  return (
    <div className={fuerte ? "flex justify-between font-bold text-foreground" : "flex justify-between text-foreground"}>
      <span>{label}</span>
      <span className="tabular-nums">
        {signo}
        {centavosAPesos(Math.abs(valorCentavos))} {moneda}
      </span>
    </div>
  );
}

export interface GastoRow {
  readonly key: string;
  tipo: string;
  descripcion: string;
  monto: string;
}

export interface ImpuestoRow {
  readonly key: string;
  tipo: string;
  monto: string;
}

let filaSeq = 0;
export function nuevaKey(): string {
  filaSeq += 1;
  return `fila-${filaSeq}`;
}
