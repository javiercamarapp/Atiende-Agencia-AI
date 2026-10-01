import * as React from "react";

import { ConfirmDialog, type ConfirmCampo, type ConfirmTono } from "./ConfirmDialog";

export interface OpcionesConfirmar {
  readonly titulo: string;
  readonly descripcion?: React.ReactNode;
  readonly tono?: ConfirmTono;
  readonly confirmar?: string;
  readonly cancelar?: string;
}

export interface OpcionesPedirTexto extends OpcionesConfirmar {
  readonly campo: ConfirmCampo;
}

type Pendiente =
  | { readonly tipo: "confirmar"; readonly opciones: OpcionesConfirmar; readonly resolver: (r: boolean) => void }
  | { readonly tipo: "texto"; readonly opciones: OpcionesPedirTexto; readonly resolver: (r: string | null) => void };

export interface UseConfirm {
  /** Pide confirmacion. Resuelve `true` al confirmar y `false` al cancelar, cerrar o pulsar Escape. */
  readonly confirmar: (opciones: OpcionesConfirmar) => Promise<boolean>;
  /**
   * Pide un texto validado (motivo, nota). Resuelve el texto recortado al confirmar
   * o `null` al cancelar. Sustituye a `window.prompt`.
   */
  readonly pedirTexto: (opciones: OpcionesPedirTexto) => Promise<string | null>;
  /** Elemento a montar UNA vez en el componente que usa el hook (p. ej. al final del JSX). */
  readonly dialogo: React.ReactElement;
}

/**
 * Reemplazo de `window.confirm` / `window.prompt` con promesa:
 *
 *   const { confirmar, dialogo } = useConfirm();
 *   if (await confirmar({ titulo: "Cancelar la reserva 123", tono: "danger" })) { ... }
 *   return <>{...}{dialogo}</>;
 *
 * Una nueva peticion mientras otra sigue abierta cancela la anterior (resuelve false/null).
 * Si el componente se desmonta con una peticion abierta, esta se resuelve como cancelada.
 */
export function useConfirm(): UseConfirm {
  const [pendiente, setPendiente] = React.useState<Pendiente | null>(null);
  const actual = React.useRef<Pendiente | null>(null);

  const cancelar = React.useCallback((p: Pendiente | null) => {
    if (!p) return;
    if (p.tipo === "confirmar") p.resolver(false);
    else p.resolver(null);
  }, []);

  const abrir = React.useCallback(
    (p: Pendiente) => {
      cancelar(actual.current);
      actual.current = p;
      setPendiente(p);
    },
    [cancelar],
  );

  React.useEffect(() => {
    return () => {
      cancelar(actual.current);
      actual.current = null;
    };
  }, [cancelar]);

  const confirmar = React.useCallback(
    (opciones: OpcionesConfirmar) => new Promise<boolean>((resolver) => abrir({ tipo: "confirmar", opciones, resolver })),
    [abrir],
  );
  const pedirTexto = React.useCallback(
    (opciones: OpcionesPedirTexto) => new Promise<string | null>((resolver) => abrir({ tipo: "texto", opciones, resolver })),
    [abrir],
  );

  // Se conserva el ultimo contenido mientras el dialogo anima su salida.
  const ultimo = React.useRef<Pendiente | null>(null);
  if (pendiente) ultimo.current = pendiente;

  const cerrarCon = (confirmado: boolean, valor?: string) => {
    const p = actual.current;
    if (!p) return;
    actual.current = null;
    setPendiente(null);
    if (p.tipo === "confirmar") p.resolver(confirmado);
    else p.resolver(confirmado ? (valor ?? "") : null);
  };

  const mostrado = pendiente ?? ultimo.current;
  const dialogo = (
    <ConfirmDialog
      open={pendiente !== null}
      onOpenChange={(abierto) => {
        if (!abierto) cerrarCon(false);
      }}
      titulo={mostrado?.opciones.titulo ?? ""}
      descripcion={mostrado?.opciones.descripcion}
      tono={mostrado?.opciones.tono}
      confirmar={mostrado?.opciones.confirmar}
      cancelar={mostrado?.opciones.cancelar}
      campo={mostrado?.tipo === "texto" ? mostrado.opciones.campo : undefined}
      onConfirm={(valor) => cerrarCon(true, valor)}
    />
  );

  return { confirmar, pedirTexto, dialogo };
}
