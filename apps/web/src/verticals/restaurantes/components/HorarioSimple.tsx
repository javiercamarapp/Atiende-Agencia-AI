// Modo SIMPLE del horario de la sucursal (portado del editor por dia del repo suelto): una fila por dia con abierto/cerrado, abre y
// cierra, y «Aplicar a todos los dias». Edita los MISMOS turnos que el modo Avanzado de ReglasSucursal (modelo 023) con las funciones
// puras de lib/horario-simple.ts; quien guarda sigue siendo ReglasSucursal. Si el horario no cabe en simple (doble turno el mismo dia o
// «ultimo pedido» propio) el modo Simple se deshabilita con el motivo, para no perder nada. Va en un chunk aparte (carga perezosa).
import { useMemo } from "react";
import { Button, Checkbox, Input, Label, Tabs, TabsList, TabsTrigger, useT } from "@atiende/ui";
import { horarioSimple } from "@atiende/ui/i18n/horarioSimple";
import { aHorarioSimple, conDia, copiarATodos, cruzaMedianoche, desdeHorarioSimple, diasInvalidos, ORDEN_DIAS_SIMPLE } from "../lib/horario-simple.ts";
import type { TurnoHorario } from "../lib/modelo-pm-client.ts";

export type ModoHorario = "simple" | "avanzado";

export interface HorarioSimpleProps {
  readonly modo: ModoHorario;
  readonly onModo: (modo: ModoHorario) => void;
  readonly turnos: readonly TurnoHorario[];
  readonly onTurnos: (turnos: TurnoHorario[]) => void;
  /** Prefijo de ids (una pagina puede tener varias sucursales abiertas). */
  readonly idBase: string;
}

const CLAVE_DIA = ["horarioSimple.dia.0", "horarioSimple.dia.1", "horarioSimple.dia.2", "horarioSimple.dia.3", "horarioSimple.dia.4", "horarioSimple.dia.5", "horarioSimple.dia.6"] as const;

export function HorarioSimple({ modo, onModo, turnos, onTurnos, idBase }: HorarioSimpleProps) {
  const t = useT(horarioSimple);
  const lectura = useMemo(() => aHorarioSimple(turnos), [turnos]);
  const enSimple = modo === "simple" && lectura.ok;
  const invalidos = useMemo(() => new Set(lectura.ok ? diasInvalidos(lectura.horario) : []), [lectura]);

  return (
    <div className="flex flex-col gap-2" data-testid="horario-simple">
      <Tabs value={enSimple ? "simple" : "avanzado"} onValueChange={(v) => onModo(v === "simple" ? "simple" : "avanzado")}>
        <TabsList aria-label={t("horarioSimple.modo")}>
          <TabsTrigger value="simple" disabled={!lectura.ok}>
            {t("horarioSimple.modo.simple")}
          </TabsTrigger>
          <TabsTrigger value="avanzado">{t("horarioSimple.modo.avanzado")}</TabsTrigger>
        </TabsList>
      </Tabs>
      {!lectura.ok ? (
        <p role="note" data-testid="horario-simple-no-cabe" className="m-0 text-xs text-muted-foreground">
          {lectura.motivo === "ultimoPedido" ? t("horarioSimple.noCabe.ultimoPedido") : t("horarioSimple.noCabe.variosTurnosPorDia")}
        </p>
      ) : null}
      {enSimple && lectura.ok ? (
        <>
          <p className="m-0 text-xs text-muted-foreground">{t("horarioSimple.ayuda")}</p>
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
            {ORDEN_DIAS_SIMPLE.map((d, fila) => {
              const dia = lectura.horario[d]!;
              const nombre = t(CLAVE_DIA[d]!);
              const cambiar = (cambio: Parameters<typeof conDia>[2]) => onTurnos(desdeHorarioSimple(conDia(lectura.horario, d, cambio)));
              return (
                <li key={d} data-dia={d} className="flex flex-wrap items-center gap-2 rounded-md border border-border px-2 py-1.5">
                  <div className="w-32">
                    <Checkbox label={nombre} wrapperClassName="text-xs" checked={dia.abierto} onChange={(e) => cambiar({ abierto: e.target.checked })} />
                  </div>
                  {dia.abierto ? (
                    <>
                      <Label htmlFor={`${idBase}-simple-abre-${d}`} className="sr-only">
                        {t("horarioSimple.abre", { dia: nombre })}
                      </Label>
                      <Input id={`${idBase}-simple-abre-${d}`} type="time" value={dia.abre} onChange={(e) => cambiar({ abre: e.target.value })} className="w-[120px]" aria-invalid={invalidos.has(d)} />
                      <span aria-hidden="true" className="text-xs text-muted-foreground">
                        –
                      </span>
                      <Label htmlFor={`${idBase}-simple-cierra-${d}`} className="sr-only">
                        {t("horarioSimple.cierra", { dia: nombre })}
                      </Label>
                      <Input id={`${idBase}-simple-cierra-${d}`} type="time" value={dia.cierra} onChange={(e) => cambiar({ cierra: e.target.value })} className="w-[120px]" aria-invalid={invalidos.has(d)} />
                      {invalidos.has(d) ? (
                        <span className="text-xs text-destructive">{t("horarioSimple.invalido")}</span>
                      ) : cruzaMedianoche(dia) ? (
                        <span className="text-xs text-muted-foreground">{t("horarioSimple.cruzaMedianoche")}</span>
                      ) : null}
                    </>
                  ) : (
                    <span className="text-xs text-muted-foreground">{t("horarioSimple.cerrado")}</span>
                  )}
                  {fila === 0 ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      className="ml-auto"
                      aria-label={t("horarioSimple.copiarATodos.etiqueta", { dia: nombre })}
                      onClick={() => onTurnos(desdeHorarioSimple(copiarATodos(lectura.horario, d)))}
                    >
                      {t("horarioSimple.copiarATodos")}
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
    </div>
  );
}
