// R-21: turnos de personal por sucursal (PM trabaja 12 pm-1 am con doble turno) y quien esta de guardia ahora.
// Todo el personal con acceso lo VE; solo owner/admin lo edita (el servidor re-valida: STAFF_INVITE_ROLES).
// Quien cubre cada turno sale del staff de la organizacion (`fetchOrgMembers`, owner/admin) con acceso a esta sucursal.
import { useEffect, useState } from "react";
import { Clock } from "lucide-react";
import { Button, Card, CardContent, CardHeader, CardTitle, Checkbox, EstadoCargando, EstadoError, EstadoVacio, Input, PageContainer, traductorActivo, useT } from "@atiende/ui";
import { restaurantesTurnos } from "@atiende/ui/i18n/restaurantes/turnos";
import { fetchOrgMembers } from "../lib/staff-client.ts";
import type { OrgMember } from "../lib/staff-client.ts";
import { fetchTurnos, guardarTurnos } from "../lib/conversaciones-client.ts";
import type { CoberturaWire, TurnoWire } from "../lib/conversaciones-client.ts";
import type { RestaurantesShellContext } from "../RestaurantesShell.tsx";

const EDITAN = new Set(["owner", "admin"]);
const DIAS = [0, 1, 2, 3, 4, 5, 6] as const;
const trTurnos = traductorActivo(restaurantesTurnos);

/** Doble turno de PM por omision: 12:00-18:00 y 18:00-01:00 todos los dias. El nombre es un dato del negocio que se guarda: no se traduce. */
const TURNOS_SUGERIDOS: readonly TurnoWire[] = [
  { nombre: "Turno 1", dias: [0, 1, 2, 3, 4, 5, 6], inicia: "12:00", termina: "18:00", miembros: [] }, // i18n-ignorar
  { nombre: "Turno 2", dias: [0, 1, 2, 3, 4, 5, 6], inicia: "18:00", termina: "01:00", miembros: [] }, // i18n-ignorar
];

function mensaje(err: unknown, porDefecto: string): string {
  return err instanceof Error ? err.message : porDefecto;
}

/** Primer "Turno N" libre (N desde `turnos.length + 1`): un nombre repetido lo rechaza el servidor (QA-restaurantes-R1-botones-08). */
export function nombreTurnoLibre(turnos: readonly Pick<TurnoWire, "nombre">[]): string {
  const usados = new Set(turnos.map((t) => t.nombre.trim().toLowerCase()));
  let n = turnos.length + 1;
  while (usados.has(`turno ${n}`)) n += 1;
  return `Turno ${n}`; // i18n-ignorar (dato del negocio que se guarda)
}

/** Mismas reglas que `validarTurnos` del servidor, para avisar en el cliente sin mandar un guardado que se sabe invalido
 * (QA-restaurantes-R1-botones-05). `null` = valido. */
export function validarTurnosLocal(turnos: readonly TurnoWire[]): string | null {
  const nombres = new Set<string>();
  for (const [i, t] of turnos.entries()) {
    const n = i + 1;
    const nombre = t.nombre.trim();
    if (nombre.length < 1 || nombre.length > 60) return trTurnos("restaurantes.turnos.error.nombre", { n: String(n) });
    if (nombres.has(nombre.toLowerCase())) return trTurnos("restaurantes.turnos.error.repetido", { nombre });
    nombres.add(nombre.toLowerCase());
    if (t.dias.length < 1) return trTurnos("restaurantes.turnos.error.dias", { nombre });
    if (!t.inicia || !t.termina) return trTurnos("restaurantes.turnos.error.horas", { nombre });
    if (t.inicia === t.termina) return trTurnos("restaurantes.turnos.error.iguales", { nombre });
  }
  return null;
}

export function TurnosPage({ apiBaseUrl, token, propertyId, role }: RestaurantesShellContext) {
  const t = useT(restaurantesTurnos);
  const puedeEditar = EDITAN.has(role);
  const [turnos, setTurnos] = useState<readonly TurnoWire[] | null>(null);
  const [cobertura, setCobertura] = useState<CoberturaWire | null>(null);
  const [disponible, setDisponible] = useState(true);
  const [personal, setPersonal] = useState<readonly OrgMember[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<{ readonly tipo: "ok" | "error"; readonly texto: string } | null>(null);
  const [guardando, setGuardando] = useState(false);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let cancelado = false;
    (async () => {
      try {
        const r = await fetchTurnos(fetch, apiBaseUrl, token, propertyId);
        if (cancelado) return;
        setTurnos(r.turnos);
        setCobertura(r.cobertura);
        setDisponible(r.disponible);
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
        if (!cancelado) setError(mensaje(err, t("restaurantes.turnos.error.cargar")));
      }
    })();
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId, puedeEditar, version]);

  function cambiar(i: number, parche: Partial<TurnoWire>) {
    setTurnos((actual) => (actual ?? []).map((tu, j) => (j === i ? { ...tu, ...parche } : tu)));
  }

  function alternarMiembro(i: number, userId: string) {
    const tu = turnos?.[i];
    if (!tu) return;
    const ya = tu.miembros.some((m) => m.userId === userId);
    const miembros = ya ? tu.miembros.filter((m) => m.userId !== userId) : [...tu.miembros, { userId, orden: tu.miembros.length + 1 }];
    cambiar(i, { miembros: miembros.map((m, k) => ({ ...m, orden: k + 1 })) });
  }

  async function guardar() {
    if (!turnos) return;
    const invalido = validarTurnosLocal(turnos);
    if (invalido) {
      setAviso({ tipo: "error", texto: invalido });
      return;
    }
    setGuardando(true);
    setAviso(null);
    try {
      await guardarTurnos(fetch, apiBaseUrl, token, propertyId, turnos);
      setAviso({ tipo: "ok", texto: t("restaurantes.turnos.guardados") });
      setVersion((n) => n + 1);
    } catch (err) {
      setAviso({ tipo: "error", texto: mensaje(err, t("restaurantes.turnos.error.guardar")) });
    } finally {
      setGuardando(false);
    }
  }

  return (
    <PageContainer padding="none">
      <header>
        <h1 className="sr-only">{t("restaurantes.turnos.titulo")}</h1>
        <p className="m-0 text-ui text-muted-foreground">{t("restaurantes.turnos.descripcion")}</p>
      </header>

      {error && <EstadoError mensaje={error} onReintentar={() => setVersion((n) => n + 1)} />}
      {!error && turnos === null && <EstadoCargando lineas={3} />}
      {!error && turnos && !disponible && <EstadoVacio icon={Clock} titulo={t("restaurantes.turnos.noDisponible.titulo")} mensaje={t("restaurantes.turnos.noDisponible.mensaje")} />}

      {!error && turnos && disponible && (
        <>
          {cobertura && (
            <Card>
              <CardHeader>
                <CardTitle>{t("restaurantes.turnos.guardia.titulo")}</CardTitle>
              </CardHeader>
              <CardContent className="text-sm">
                {cobertura.sinCobertura ? (
                  <p className="m-0 text-destructive">{t("restaurantes.turnos.guardia.nadie")}</p>
                ) : (
                  <ul className="m-0 pl-4">
                    {cobertura.guardia.map((g) => (
                      <li key={g.userId}>
                        {g.nombre ?? t("restaurantes.turnos.sinNombre")} — {g.turno} ({g.orden === 1 ? t("restaurantes.turnos.guardia.principal") : t("restaurantes.turnos.guardia.respaldo", { n: String(g.orden - 1) })})
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          )}

          {turnos.length === 0 && (
            <EstadoVacio icon={Clock} titulo={t("restaurantes.turnos.vacio.titulo")} mensaje={puedeEditar ? t("restaurantes.turnos.vacio.editar") : t("restaurantes.turnos.vacio.leer")} />
          )}

          {turnos.map((tu, i) => (
            <Card key={tu.id ?? `nuevo-${i}`}>
              <CardContent className="flex flex-col gap-3 pt-4 text-sm">
                <div className="flex flex-wrap gap-3 items-end">
                  <label className="flex flex-col gap-1">
                    {t("restaurantes.turnos.campo.nombre")}
                    <Input aria-label={t("restaurantes.turnos.aria.nombre", { n: String(i + 1) })} value={tu.nombre} disabled={!puedeEditar} maxLength={60} onChange={(e) => cambiar(i, { nombre: e.target.value })} className="w-auto" />
                  </label>
                  <label className="flex flex-col gap-1">
                    {t("restaurantes.turnos.campo.inicia")}
                    <Input type="time" aria-label={t("restaurantes.turnos.aria.inicio", { n: String(i + 1) })} value={tu.inicia} disabled={!puedeEditar} onChange={(e) => cambiar(i, { inicia: e.target.value })} className="w-auto" />
                  </label>
                  <label className="flex flex-col gap-1">
                    {t("restaurantes.turnos.campo.termina")}
                    <Input type="time" aria-label={t("restaurantes.turnos.aria.fin", { n: String(i + 1) })} value={tu.termina} disabled={!puedeEditar} onChange={(e) => cambiar(i, { termina: e.target.value })} className="w-auto" />
                  </label>
                  {puedeEditar && (
                    <Button variant="outline" onClick={() => setTurnos((a) => (a ?? []).filter((_, j) => j !== i))}>
                      {t("restaurantes.turnos.quitar")}
                    </Button>
                  )}
                </div>
                <div className="flex flex-wrap gap-2" role="group" aria-label={t("restaurantes.turnos.aria.dias", { n: String(i + 1) })}>
                  {DIAS.map((n) => (
                    <Checkbox
                      key={n}
                      label={t(`restaurantes.turnos.dia.${n}` as const)}
                      disabled={!puedeEditar}
                      checked={tu.dias.includes(n)}
                      onChange={() => cambiar(i, { dias: tu.dias.includes(n) ? tu.dias.filter((x) => x !== n) : [...tu.dias, n].sort((a, b) => a - b) })}
                    />
                  ))}
                </div>
                <div>
                  <p className="m-0 mb-1 font-medium">{t("restaurantes.turnos.personal.titulo")}</p>
                  {puedeEditar ? (
                    personal.length === 0 ? (
                      <p className="m-0 text-muted-foreground">{t("restaurantes.turnos.personal.vacio")}</p>
                    ) : (
                      <div className="flex flex-col gap-1">
                        {personal.map((p) => (
                          <Checkbox
                            key={p.id}
                            checked={tu.miembros.some((m) => m.userId === p.id)}
                            onChange={() => alternarMiembro(i, p.id)}
                            label={
                              <>
                                {p.fullName || p.email}
                                {tu.miembros.find((m) => m.userId === p.id) && <span className="ml-1 text-muted-foreground">#{tu.miembros.find((m) => m.userId === p.id)!.orden}</span>}
                              </>
                            }
                          />
                        ))}
                      </div>
                    )
                  ) : (
                    <p className="m-0">{tu.miembros.length === 0 ? t("restaurantes.turnos.personal.sinAsignar") : tu.miembros.map((m) => m.nombre ?? t("restaurantes.turnos.sinNombre")).join(", ")}</p>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}

          {puedeEditar && (
            <div className="flex flex-wrap gap-2">
              {turnos.length < 4 && (
                <Button variant="outline" onClick={() => setTurnos((a) => [...(a ?? []), turnos.length === 0 ? TURNOS_SUGERIDOS[0]! : { nombre: nombreTurnoLibre(turnos), dias: [0, 1, 2, 3, 4, 5, 6], inicia: "12:00", termina: "18:00", miembros: [] }])}>
                  {t("restaurantes.turnos.agregar")}
                </Button>
              )}
              {turnos.length === 0 && (
                <Button variant="outline" onClick={() => setTurnos(TURNOS_SUGERIDOS)}>
                  {t("restaurantes.turnos.usarDoble")}
                </Button>
              )}
              <Button disabled={guardando} onClick={guardar}>
                {t("restaurantes.turnos.guardar")}
              </Button>
            </div>
          )}
          {aviso && (
            <p role={aviso.tipo === "error" ? "alert" : "status"} className={aviso.tipo === "error" ? "m-0 text-sm text-destructive" : "m-0 text-sm text-foreground"}>
              {aviso.texto}
            </p>
          )}
        </>
      )}
    </PageContainer>
  );
}
