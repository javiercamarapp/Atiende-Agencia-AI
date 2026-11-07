import { useState } from "react";
import { Info } from "lucide-react";
import { Drawer } from "../ui/drawer";
import { useIdiomaCopiloto } from "./idioma";
import type { CopilotoBloque, CopilotoFuente } from "./tipos";

/**
 * «Cómo se calculó» (diseno ds3): boton bajo una respuesta con cifras que abre el `Drawer` sm de @atiende/ui con la evidencia que
 * el SERVIDOR mando con esa respuesta -- de donde sale cada cifra (fuente), periodo, alcance, las consultas del catalogo que corrieron
 * (etiqueta legible, nunca parametros crudos) y lo que no sabemos (tablas recortadas). No pide nada a la red ni deduce nada: si la
 * respuesta no trae fuentes ni bloques, el boton no se pinta. Quien lo monta lo envuelve en `hidden` + `ds3-solo`: sin la bandera no existe.
 */
export function CopilotoComoSeCalculo({
  bloques,
  fuentes,
  etiquetasHerramienta,
}: {
  bloques: readonly CopilotoBloque[];
  fuentes: readonly CopilotoFuente[];
  etiquetasHerramienta?: Readonly<Record<string, string>> | undefined;
}) {
  const { t } = useIdiomaCopiloto();
  const [abierto, setAbierto] = useState(false);
  if (bloques.length === 0 && fuentes.length === 0) return null;

  const titulo = bloques[0]?.title ?? fuentes[0]?.source ?? "";
  const herramientas = [...new Set([...bloques.map((b) => b.tool), ...fuentes.map((f) => f.tool)])];
  const recortados = bloques.filter((b) => b.truncated);
  const etiqueta = (tool: string) => etiquetasHerramienta?.[tool] ?? tool;

  return (
    <>
      <button type="button" className="ds3-copiloto-ctl ds3-copiloto-calculo" onClick={() => setAbierto(true)}>
        <Info aria-hidden="true" />
        <span>{t("verComoLoCalcule")}</span>
      </button>
      <Drawer open={abierto} onOpenChange={setAbierto} tamano="sm" titulo={titulo ? t("comoSeCalculoDe", { t: titulo }) : t("comoSeCalculo")} notaPie={t("notaCalculo")}>
        <dl className="ds3-copiloto-calculo-dl" data-testid="copiloto-como-se-calculo">
          {fuentes.length > 0 ? (
            fuentes.map((f, i) => (
              <div key={`${f.tool}-${i}`} className="ds3-copiloto-calculo-fuente">
                <dt>{t("deDondeSale")}</dt>
                <dd>{f.source}</dd>
                {f.periodLabel ? (
                  <>
                    <dt>{t("periodo")}</dt>
                    <dd>{f.periodLabel}</dd>
                  </>
                ) : null}
                <dt>{t("alcance")}</dt>
                <dd>{f.scopeLabel}</dd>
              </div>
            ))
          ) : (
            <div className="ds3-copiloto-calculo-fuente">
              <dt>{t("deDondeSale")}</dt>
              <dd>{t("sinFuente")}</dd>
            </div>
          )}
        </dl>
        <section className="ds3-copiloto-calculo-caja" aria-label={t("consultas")}>
          <p className="ds3-copiloto-calculo-caja-titulo">{t("consultas")}</p>
          <ul>
            {herramientas.map((tool) => {
              const filas = bloques.filter((b) => b.tool === tool).reduce((n, b) => n + b.rows.length, 0);
              return (
                <li key={tool}>
                  {etiqueta(tool)}
                  {bloques.some((b) => b.tool === tool) ? <span className="ds3-copiloto-calculo-meta"> · {t("filas", { n: filas })}</span> : null}
                </li>
              );
            })}
          </ul>
        </section>
        {recortados.length > 0 ? (
          <section className="ds3-copiloto-calculo-caja" aria-label={t("queNoSabemos")}>
            <p className="ds3-copiloto-calculo-caja-titulo">{t("queNoSabemos")}</p>
            <ul>
              {recortados.map((b, i) => (
                <li key={`${b.tool}-${i}`}>
                  {b.title}: {t("recortado")}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </Drawer>
    </>
  );
}
