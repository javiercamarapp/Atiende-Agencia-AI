// Confirmacion de «Entregado» en un paso (PLAN-PANEL-OPERADOR §5.2): «¿Entregaste el pedido #145?». Si el pedido es en efectivo (o sin forma de pago
// registrada) trae el campo «Monto cobrado» ya lleno con el total (la opcion «Cobrado $X»): se deja tal cual, se corrige si cobro otra cantidad o se
// vacia si no cobro. Con tarjeta no hay efectivo que registrar. El `ConfirmDialog` mantiene el boton en carga mientras la promesa de `onConfirmar`
// no termina, asi un segundo toque no dispara otra entrega.
import { ConfirmDialog, formatMoney, useT } from "@atiende/ui";
import { restaurantesChofer } from "@atiende/ui/i18n/restaurantes/chofer";
import { restaurantesComun } from "@atiende/ui/i18n/restaurantes/comun";
import type { EntregaChofer } from "@atiende/domain-restaurantes/operacion";

export const COBRADO_MAXIMO = 100_000;

/** Monto cobrado a enviar: `null` si el campo va vacio (no cobro); `undefined` si el texto no es un monto valido. Acepta coma decimal. */
export function interpretarMonto(texto: string): number | null | undefined {
  const limpio = texto.trim().replace(",", ".");
  if (limpio === "") return null;
  if (!/^\d+(\.\d{1,2})?$/.test(limpio)) return undefined;
  const n = Number(limpio);
  return n >= 0 && n <= COBRADO_MAXIMO ? n : undefined;
}

export interface ConfirmarEntregaProps {
  readonly entrega: EntregaChofer | null;
  readonly onCerrar: () => void;
  /** `cobradoMonto` es `null` si no registro cobro. Debe resolver cuando termine (el dialogo espera). */
  readonly onConfirmar: (entrega: EntregaChofer, cobradoMonto: number | null) => Promise<void>;
}

export function ConfirmarEntrega({ entrega, onCerrar, onConfirmar }: ConfirmarEntregaProps) {
  const t = useT(restaurantesComun, restaurantesChofer);
  const ofreceCobro = entrega !== null && entrega.pago.forma !== "tarjeta";
  return (
    <ConfirmDialog
      // La llave reinicia el campo con el total de CADA pedido (el dialogo conserva su estado entre usos).
      key={entrega?.id ?? "sin-entrega"}
      open={entrega !== null}
      onOpenChange={(abierto) => {
        if (!abierto) onCerrar();
      }}
      titulo={entrega ? t("restaurantes.chofer.confirmar.titulo", { numero: String(entrega.numero) }) : t("restaurantes.chofer.confirmar.tituloVacio")}
      descripcion={
        entrega
          ? `${t("restaurantes.chofer.confirmar.descripcion", { cliente: entrega.clienteNombre, total: formatMoney(entrega.total) })}${ofreceCobro ? t("restaurantes.chofer.confirmar.cobro") : ""}`
          : undefined
      }
      botonesGrandes
      confirmar={t("restaurantes.chofer.confirmar.si")}
      cancelar={t("restaurantes.volver")}
      {...(ofreceCobro && entrega
        ? {
            campo: {
              etiqueta: t("restaurantes.chofer.confirmar.monto"),
              valorInicial: String(entrega.total),
              requerido: false,
              maxLength: 12,
              validar: (valor: string) => (interpretarMonto(valor) === undefined ? t("restaurantes.chofer.confirmar.montoInvalido") : null),
            },
          }
        : {})}
      onConfirm={async (valor) => {
        if (!entrega) return;
        const cobrado = ofreceCobro ? interpretarMonto(valor ?? "") : null;
        if (cobrado === undefined) throw new Error("monto_invalido");
        await onConfirmar(entrega, cobrado);
      }}
    />
  );
}
