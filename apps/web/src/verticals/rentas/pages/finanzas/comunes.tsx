// Piezas compartidas de las secciones de Finanzas (Rn-15): roles, etiquetas, el renglón monetario y el diálogo de
// formulario (FormDialog + error de servidor) que usan los tres formularios de escritura.
import type { ReactNode } from "react";
import { EstadoError, FormDialog } from "@atiende/ui";
import { dineroDeCentavos } from "../../lib/pricing-client.ts";

export interface SectionProps {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  readonly puedeEscribir: boolean;
}

export const FINANZAS_LECTURA_ROLES = new Set(["admin_gestora", "contador"]);
export const FINANZAS_ESCRITURA_ROLES = new Set(["admin_gestora"]);

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

/** Renglón "etiqueta ... monto" de los resúmenes (movimiento y totales de statement). Dinero con el formateador único. */
export function Linea({ label, valorCentavos, moneda, fuerte }: { label: string; valorCentavos: number; moneda: string; fuerte?: boolean }) {
  const signo = valorCentavos < 0 ? "-" : "";
  return (
    <div className={fuerte ? "flex justify-between font-semibold text-foreground" : "flex justify-between text-foreground"}>
      <span>{label}</span>
      <span className="tabular-nums">
        {signo}
        {dineroDeCentavos(Math.abs(valorCentavos), moneda)}
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

/** Monto escrito por una persona -> número; vacío o ilegible = NaN (nunca 0 silencioso). */
export function aNumero(texto: string): number {
  return texto.trim() === "" ? Number.NaN : Number(texto);
}

/**
 * Diálogo de alta de las secciones de escritura: FormDialog con el error (local o del servidor) arriba del formulario.
 * No cierra mientras se guarda (`bloquearCierre`); el padre decide cuándo desmontarlo.
 */
export function DialogoFinanzas({
  titulo,
  subtitulo,
  textoGuardar,
  guardando,
  error,
  onCerrar,
  onEnviar,
  children,
}: {
  titulo: string;
  subtitulo?: string;
  textoGuardar: string;
  guardando: boolean;
  error: string | null;
  onCerrar: () => void;
  onEnviar: () => void;
  children: ReactNode;
}) {
  return (
    <FormDialog
      open
      onOpenChange={(abierto) => {
        if (!abierto && !guardando) onCerrar();
      }}
      titulo={titulo}
      subtitulo={subtitulo}
      anchoClase="max-w-2xl"
      onGuardar={onEnviar}
      guardando={guardando}
      textoBotonGuardar={textoGuardar}
      bloquearCierre={guardando}
    >
      <div className="flex flex-col gap-3">
        {error && <EstadoError compacto titulo="No se pudo guardar" mensaje={error} />}
        {children}
      </div>
    </FormDialog>
  );
}
