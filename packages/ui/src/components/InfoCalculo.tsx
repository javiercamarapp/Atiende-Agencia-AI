// (i) «Cómo se calculó» de Rovaq para KPI y graficas clave (PARIDAD-ATIENDE-ROVAQ #9): boton de 32 px que abre el Drawer sm de
// @atiende/ui con como se calcula, de donde sale, periodo, alcance y «Qué no sabemos». Es "tonto": solo pinta lo que la pagina le pasa,
// y la pagina solo pasa lo que su endpoint ya devuelve o lo que el codigo del calculo hace de verdad; una seccion sin dato no se pinta
// (nunca un valor de relleno). Solo existe bajo la bandera ds3 (`hidden` + `ds3-solo`).
import { useState, type ReactNode } from "react";
import { Info } from "lucide-react";
import { cn } from "../lib/utils";
import { Drawer } from "./ui/drawer";
import { TEXTOS_DS3_INFO } from "./ds3-contenido-textos";

export type ClaseDato = "observado" | "estimado" | "inferido";

export interface InfoCalculoDatos {
  /** Nombre de la metrica o grafica (titulo del Drawer). */
  readonly titulo: string;
  /** Como se calcula, en una o dos frases. */
  readonly como?: string;
  /** De donde sale el dato. */
  readonly fuente?: string;
  readonly periodo?: string;
  /** Alcance / cobertura (sucursales, canales...). */
  readonly alcance?: string;
  /** Limites conocidos del dato. */
  readonly queNoSabemos?: readonly string[];
  readonly clase?: ClaseDato;
}

const CLASE: Record<ClaseDato, string> = { observado: "Observado", estimado: "Estimado", inferido: "Inferido" };

function Par({ etiqueta, valor }: { readonly etiqueta: string; readonly valor: string | undefined }) {
  if (!valor) return null;
  return (
    <>
      <dt>{etiqueta}</dt>
      <dd>{valor}</dd>
    </>
  );
}

export function InfoCalculo({ datos, className }: { readonly datos: InfoCalculoDatos; readonly className?: string }) {
  const [abierto, setAbierto] = useState(false);
  const t = TEXTOS_DS3_INFO;
  const sello = datos.clase ? (
    <span className="ds3-sello" data-clase={datos.clase}>
      {CLASE[datos.clase]}
    </span>
  ) : undefined;
  const hayPares = Boolean(datos.fuente || datos.periodo || datos.alcance);
  return (
    <>
      <button
        type="button"
        hidden
        aria-label={`${t.comoSeCalculo}: ${datos.titulo}`}
        title={t.comoSeCalculo}
        data-testid="info-calculo"
        onClick={() => setAbierto(true)}
        className={cn("ds3-solo ds3-info-calculo", className)}
      >
        <Info aria-hidden="true" strokeWidth={1.75} />
      </button>
      <Drawer
        open={abierto}
        onOpenChange={setAbierto}
        tamano="sm"
        titulo={`${t.comoSeCalculo}: ${datos.titulo}`}
        notaPie={sello ? (
          <>
            {t.claseDeDato}: {sello}
          </>
        ) : undefined}
      >
        <div data-testid="info-calculo-panel" className="contents">
          {datos.como ? (
            <Caja titulo={t.comoSeCalcula}>
              <p>{datos.como}</p>
            </Caja>
          ) : null}
          {hayPares ? (
            <dl className="ds3-copiloto-calculo-dl">
              <div className="ds3-copiloto-calculo-fuente">
                <Par etiqueta={t.deDondeSale} valor={datos.fuente} />
                <Par etiqueta={t.periodo} valor={datos.periodo} />
                <Par etiqueta={t.alcance} valor={datos.alcance} />
              </div>
            </dl>
          ) : null}
          {datos.queNoSabemos && datos.queNoSabemos.length > 0 ? (
            <Caja titulo={t.queNoSabemos}>
              <ul>
                {datos.queNoSabemos.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            </Caja>
          ) : null}
        </div>
      </Drawer>
    </>
  );
}

function Caja({ titulo, children }: { readonly titulo: string; readonly children: ReactNode }) {
  return (
    <section className="ds3-copiloto-calculo-caja" aria-label={titulo}>
      <p className="ds3-copiloto-calculo-caja-titulo">{titulo}</p>
      {children}
    </section>
  );
}

/**
 * Celda de KPI con su (i): envuelve la tarjeta (StatCard/KpiTile) sin cambiarla y pone el boton arriba a la derecha bajo ds3. Sin la
 * bandera es un div `relative` que no cambia nada (la tarjeta conserva su `h-full`).
 */
export function ConInfoCalculo({ datos, children }: { readonly datos: InfoCalculoDatos; readonly children: ReactNode }) {
  return (
    <div className="ds3-con-info relative min-w-0">
      {children}
      <InfoCalculo datos={datos} className="ds3-info-flotante" />
    </div>
  );
}
