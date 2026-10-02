// R-21: turnos de personal por sucursal (PM trabaja 12 pm-1 am con doble turno) y quien esta de guardia ahora.
// Todo el personal con acceso lo VE; solo owner/admin lo edita (el servidor re-valida: STAFF_INVITE_ROLES).
// Quien cubre cada turno sale del staff de la organizacion (`fetchOrgMembers`, owner/admin) con acceso a esta sucursal.
import { useEffect, useState } from "react";
import { Clock } from "lucide-react";
import { Button, Card, CardContent, CardHeader, CardTitle, Checkbox, EstadoCargando, EstadoError, EstadoVacio, Input, PageContainer } from "@atiende/ui";
import { fetchOrgMembers } from "../lib/staff-client.ts";
import type { OrgMember } from "../lib/staff-client.ts";
import { fetchTurnos, guardarTurnos } from "../lib/conversaciones-client.ts";
import type { CoberturaWire, TurnoWire } from "../lib/conversaciones-client.ts";
import type { RestaurantesShellContext } from "../RestaurantesShell.tsx";

const EDITAN = new Set(["owner", "admin"]);
const DIAS = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"] as const;

/** Doble turno de PM por omision: 12:00-18:00 y 18:00-01:00 todos los dias. */
const TURNOS_SUGERIDOS: readonly TurnoWire[] = [
  { nombre: "Turno 1", dias: [0, 1, 2, 3, 4, 5, 6], inicia: "12:00", termina: "18:00", miembros: [] },
  { nombre: "Turno 2", dias: [0, 1, 2, 3, 4, 5, 6], inicia: "18:00", termina: "01:00", miembros: [] },
];

function mensaje(err: unknown, porDefecto: string): string {
  return err instanceof Error ? err.message : porDefecto;
}

export function TurnosPage({ apiBaseUrl, token, propertyId, role }: RestaurantesShellContext) {
  const puedeEditar = EDITAN.has(role);
  const [turnos, setTurnos] = useState<readonly TurnoWire[] | null>(null);
  const [cobertura, setCobertura] = useState<CoberturaWire | null>(null);
  const [disponible, setDisponible] = useState(true);
  const [personal, setPersonal] = useState<readonly OrgMember[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let cancelado = false;
    (async () => {
      try {
        const t = await fetchTurnos(fetch, apiBaseUrl, token, propertyId);
        if (cancelado) return;
        setTurnos(t.turnos);
        setCobertura(t.cobertura);
        setDisponible(t.disponible);
        setError(null);
        if (puedeEditar) {
          try {
            const m = await fetchOrgMembers(fetch, apiBaseUrl, token, propertyId);
            if (!cancelado) setPersonal(m.filter((x) => x.verticalRole !== "repartidor" && (x.propertyIds === null || x.propertyIds.includes(propertyId))));
          } catch {
            if (!cancelado) setPersonal([]);
          }
        }
      } catch (err) {
        if (!cancelado) setError(mensaje(err, "No se pudieron cargar los turnos."));
      }
    })();
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId, puedeEditar, version]);

  function cambiar(i: number, parche: Partial<TurnoWire>) {
    setTurnos((actual) => (actual ?? []).map((t, j) => (j === i ? { ...t, ...parche } : t)));
  }

  function alternarMiembro(i: number, userId: string) {
    const t = turnos?.[i];
    if (!t) return;
    const ya = t.miembros.some((m) => m.userId === userId);
    const miembros = ya ? t.miembros.filter((m) => m.userId !== userId) : [...t.miembros, { userId, orden: t.miembros.length + 1 }];
    cambiar(i, { miembros: miembros.map((m, k) => ({ ...m, orden: k + 1 })) });
  }

  async function guardar() {
    if (!turnos) return;
    setGuardando(true);
    setAviso(null);
    try {
      await guardarTurnos(fetch, apiBaseUrl, token, propertyId, turnos);
      setAviso("Turnos guardados.");
      setVersion((n) => n + 1);
    } catch (err) {
      setAviso(mensaje(err, "No se pudieron guardar los turnos."));
    } finally {
      setGuardando(false);
    }
  }

  return (
    <PageContainer padding="none">
      <header>
        <h1 className="sr-only">Turnos</h1>
        <p className="m-0 text-ui text-muted-foreground">Quién atiende las conversaciones en cada turno de esta sucursal. El primero de cada turno es el principal; los siguientes son respaldo y reciben el aviso si nadie contesta.</p>
      </header>

      {error && <EstadoError mensaje={error} onReintentar={() => setVersion((n) => n + 1)} />}
      {!error && turnos === null && <EstadoCargando lineas={3} />}
      {!error && turnos && !disponible && <EstadoVacio icon={Clock} titulo="Turnos no disponibles aún" mensaje="Los turnos de personal todavía no están habilitados en esta base de datos." />}

      {!error && turnos && disponible && (
        <>
          {cobertura && (
            <Card>
              <CardHeader>
                <CardTitle>De guardia ahora</CardTitle>
              </CardHeader>
              <CardContent className="text-sm">
                {cobertura.sinCobertura ? (
                  <p className="m-0 text-destructive">Nadie está de guardia en este momento.</p>
                ) : (
                  <ul className="m-0 pl-4">
                    {cobertura.guardia.map((g) => (
                      <li key={g.userId}>
                        {g.nombre ?? "Sin nombre"} — {g.turno} ({g.orden === 1 ? "principal" : `respaldo ${g.orden - 1}`})
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          )}

          {turnos.length === 0 && (
            <EstadoVacio icon={Clock} titulo="Sin turnos" mensaje={puedeEditar ? "Define los turnos de esta sucursal (por ejemplo el doble turno de 12 pm a 1 am)." : "Todavía no se han definido turnos para esta sucursal."} />
          )}

          {turnos.map((t, i) => (
            <Card key={t.id ?? `nuevo-${i}`}>
              <CardContent className="flex flex-col gap-3 pt-4 text-sm">
                <div className="flex flex-wrap gap-3 items-end">
                  <label className="flex flex-col gap-1">
                    Nombre
                    <Input aria-label={`Nombre del turno ${i + 1}`} value={t.nombre} disabled={!puedeEditar} maxLength={60} onChange={(e) => cambiar(i, { nombre: e.target.value })} className="w-auto" />
                  </label>
                  <label className="flex flex-col gap-1">
                    Inicia
                    <Input type="time" aria-label={`Inicio del turno ${i + 1}`} value={t.inicia} disabled={!puedeEditar} onChange={(e) => cambiar(i, { inicia: e.target.value })} className="w-auto" />
                  </label>
                  <label className="flex flex-col gap-1">
                    Termina (si es menor, cruza la medianoche)
                    <Input type="time" aria-label={`Fin del turno ${i + 1}`} value={t.termina} disabled={!puedeEditar} onChange={(e) => cambiar(i, { termina: e.target.value })} className="w-auto" />
                  </label>
                  {puedeEditar && (
                    <Button variant="outline" onClick={() => setTurnos((a) => (a ?? []).filter((_, j) => j !== i))}>
                      Quitar turno
                    </Button>
                  )}
                </div>
                <div className="flex flex-wrap gap-2" role="group" aria-label={`Días del turno ${i + 1}`}>
                  {DIAS.map((d, n) => (
                    <Checkbox
                      key={d}
                      label={d}
                      disabled={!puedeEditar}
                      checked={t.dias.includes(n)}
                      onChange={() => cambiar(i, { dias: t.dias.includes(n) ? t.dias.filter((x) => x !== n) : [...t.dias, n].sort((a, b) => a - b) })}
                    />
                  ))}
                </div>
                <div>
                  <p className="m-0 mb-1 font-medium">Personal (en orden: principal y respaldos)</p>
                  {puedeEditar ? (
                    personal.length === 0 ? (
                      <p className="m-0 text-muted-foreground">No hay personal con acceso a esta sucursal para asignar.</p>
                    ) : (
                      <div className="flex flex-col gap-1">
                        {personal.map((p) => (
                          <Checkbox
                            key={p.id}
                            checked={t.miembros.some((m) => m.userId === p.id)}
                            onChange={() => alternarMiembro(i, p.id)}
                            label={
                              <>
                                {p.fullName || p.email}
                                {t.miembros.find((m) => m.userId === p.id) && <span className="ml-1 text-muted-foreground">#{t.miembros.find((m) => m.userId === p.id)!.orden}</span>}
                              </>
                            }
                          />
                        ))}
                      </div>
                    )
                  ) : (
                    <p className="m-0">{t.miembros.length === 0 ? "Sin personal asignado." : t.miembros.map((m) => m.nombre ?? "Sin nombre").join(", ")}</p>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}

          {puedeEditar && (
            <div className="flex flex-wrap gap-2">
              {turnos.length < 4 && (
                <Button variant="outline" onClick={() => setTurnos((a) => [...(a ?? []), turnos.length === 0 ? TURNOS_SUGERIDOS[0]! : { nombre: `Turno ${turnos.length + 1}`, dias: [0, 1, 2, 3, 4, 5, 6], inicia: "12:00", termina: "18:00", miembros: [] }])}>
                  Agregar turno
                </Button>
              )}
              {turnos.length === 0 && (
                <Button variant="outline" onClick={() => setTurnos(TURNOS_SUGERIDOS)}>
                  Usar el doble turno 12 pm - 1 am
                </Button>
              )}
              <Button disabled={guardando} onClick={guardar}>
                Guardar turnos
              </Button>
            </div>
          )}
          {aviso && <p role="status" className="m-0 text-sm text-foreground">{aviso}</p>}
        </>
      )}
    </PageContainer>
  );
}
