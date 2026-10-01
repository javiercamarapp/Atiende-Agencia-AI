// Calendario de dias inhabiles (L-22): los feriados oficiales de plataforma (descanso obligatorio, art. 74 LFT,
// 2026-2027), los dias que suelen depender de cada dependencia (Jueves y Viernes Santo, "validar con
// fiscalista/abogado") y los que DECLARA la organizacion para todas sus convocatorias o para una en particular.
// Con ellos se cuentan el plazo de pago (art. 73 LAASSP), el de inconformidad (art. 95 LAASSP), los recordatorios
// y los dias habiles de la sala de guerra y la junta.
//
// Honestidad: lo dudoso NO se aplica solo; cuenta unicamente cuando la organizacion lo declara. Con la base sin la
// migracion 032 la pantalla lo dice: los oficiales siguen aplicando y lo declarado no se puede editar. El servidor
// es la unica barrera (rol, validacion); aqui los roles solo ocultan lo que el servidor rechazaria.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { Button, Callout, Card, CardContent, CardDescription, CardHeader, CardTitle, EstadoCargando, EstadoError, EstadoVacio, Input, Label, NativeSelect, PageContainer, StatusBadge, useConfirm } from "@atiende/ui";
import { formatFechaSolo } from "../../../lib/formato-fecha.ts";
import { declararDiaInhabil, fetchDiasInhabiles, quitarDiaInhabil } from "../lib/dias-inhabiles-client.ts";
import type { DiaInhabilDeclarado, DiasInhabilesResumen } from "../lib/dias-inhabiles-client.ts";
import { fetchTenders } from "../lib/tenders-client.ts";
import type { TenderSummary } from "../lib/tenders-client.ts";
import type { LicitacionesShellContext } from "../LicitacionesShell.tsx";

function porAnio<T extends { readonly fecha: string }>(filas: readonly T[]): [string, T[]][] {
  const grupos = new Map<string, T[]>();
  for (const f of filas) {
    const anio = f.fecha.slice(0, 4);
    grupos.set(anio, [...(grupos.get(anio) ?? []), f]);
  }
  return [...grupos.entries()].sort(([a], [b]) => a.localeCompare(b));
}

export function DiasInhabilesPage({ apiBaseUrl, token, propertyId }: LicitacionesShellContext) {
  const [resumen, setResumen] = useState<DiasInhabilesResumen | null>(null);
  const [convocatorias, setConvocatorias] = useState<readonly TenderSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const [fecha, setFecha] = useState("");
  const [nombre, setNombre] = useState("");
  const [publicadoPor, setPublicadoPor] = useState("");
  const [fuente, setFuente] = useState("");
  const [tenderId, setTenderId] = useState("");
  const { confirmar, dialogo } = useConfirm();

  const cargar = useCallback(async () => {
    setResumen(await fetchDiasInhabiles(fetch, apiBaseUrl, token, propertyId));
  }, [apiBaseUrl, token, propertyId]);

  useEffect(() => {
    let vivo = true;
    cargar().catch((err: unknown) => {
      if (vivo) setError(err instanceof Error ? err.message : "No se pudo cargar el calendario de días inhábiles.");
    });
    // La lista de convocatorias solo sirve para declarar un dia de UNA convocatoria; si falla, ese selector se oculta.
    fetchTenders(fetch, apiBaseUrl, token, propertyId)
      .then((t) => {
        if (vivo) setConvocatorias(t);
      })
      .catch(() => {
        if (vivo) setConvocatorias([]);
      });
    return () => {
      vivo = false;
    };
  }, [cargar, apiBaseUrl, token, propertyId]);

  async function ejecutar(fn: () => Promise<void>) {
    setOcupado(true);
    setError(null);
    setAviso(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo completar la acción.");
    } finally {
      setOcupado(false);
    }
  }

  const tituloConvocatoria = useMemo(() => new Map(convocatorias.map((t) => [t.id, t.title])), [convocatorias]);

  function enviar(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void ejecutar(async () => {
      await declararDiaInhabil(fetch, apiBaseUrl, token, propertyId, {
        fecha,
        nombre: nombre.trim(),
        tenderId: tenderId || null,
        publicadoPor: publicadoPor.trim() || null,
        fuente: fuente.trim() || null,
      });
      setFecha("");
      setNombre("");
      setPublicadoPor("");
      setFuente("");
      setTenderId("");
      await cargar();
      setAviso("Día inhábil declarado. Los plazos nuevos ya lo toman en cuenta.");
    });
  }

  function declararSugerido(f: { fecha: string; nombre: string }) {
    void ejecutar(async () => {
      await declararDiaInhabil(fetch, apiBaseUrl, token, propertyId, { fecha: f.fecha, nombre: f.nombre, fuente: "Sugerido por la plataforma (validar con fiscalista/abogado)" });
      await cargar();
      setAviso(`${f.nombre} (${formatFechaSolo(f.fecha)}) declarado para tu organización.`);
    });
  }

  async function quitar(d: DiaInhabilDeclarado) {
    const ok = await confirmar({
      titulo: "Quitar día inhábil",
      descripcion: `Se quitará ${d.nombre} (${formatFechaSolo(d.fecha)}). Los plazos que se calculen desde ahora ya no lo excluirán; los ya calculados no cambian. Queda registro de quién lo declaró y quién lo quitó.`,
      tono: "danger",
      confirmar: "Quitar",
    });
    if (!ok) return;
    await ejecutar(async () => {
      await quitarDiaInhabil(fetch, apiBaseUrl, token, propertyId, d.id);
      await cargar();
      setAviso("Día inhábil quitado.");
    });
  }

  if (!resumen && !error) return <EstadoCargando />;
  if (!resumen) return <EstadoError mensaje={error ?? "No se pudo cargar."} />;

  const puedeEditar = resumen.puedeEditar && resumen.available;
  const yaDeclarado = (f: string) => resumen.declarados.some((d) => d.fecha === f && d.tenderId === null);

  return (
    <PageContainer padding="none" size="md" className="gap-4 [&>*]:min-w-0">
      <div>
        <h1 className="font-display text-xl font-semibold text-foreground">Días inhábiles</h1>
        <p className="text-sm text-muted-foreground">
          Con este calendario se cuentan los plazos en días hábiles: pago al proveedor (art. 73 de la LAASSP), inconformidad (art. 95), recordatorios y la sala de guerra. Fechas en la zona horaria de la Ciudad de México.
        </p>
      </div>

      <Callout tone="info" titulo="Validar con fiscalista/abogado">
        {resumen.nota} Cubre {resumen.coberturaOficial.join(" y ")}: para otro año, declara tú los días inhábiles; mientras tanto el plazo solo excluye sábados y domingos y la pantalla de cada plazo lo avisa.
      </Callout>

      {!resumen.available ? (
        <Callout tone="warning" titulo="Días declarados: aún no disponibles">
          Declarar días por organización o convocatoria requiere la migración 032 de licitaciones, que todavía no está aplicada en este ambiente. Mientras tanto los plazos usan solo los días oficiales de plataforma.
        </Callout>
      ) : null}
      {error ? <EstadoError mensaje={error} /> : null}
      {aviso ? <Callout tone="success" titulo="Listo">{aviso}</Callout> : null}

      <Card>
        <CardHeader>
          <CardTitle>Oficiales de plataforma</CardTitle>
          <CardDescription>Descanso obligatorio federal (art. 74 de la Ley Federal del Trabajo). Se aplican siempre a todos los plazos.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {porAnio(resumen.oficiales).map(([anio, filas]) => (
            <div key={anio}>
              <h2 className="mb-1 text-sm font-semibold">{anio}</h2>
              <ul className="divide-y rounded-md border">
                {filas.map((d) => (
                  <li key={d.fecha} className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
                    <span>
                      <span className="font-medium">{formatFechaSolo(d.fecha, "larga")}</span> · {d.nombre}
                    </span>
                    <StatusBadge tone="success">Verificado</StatusBadge>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Sugeridos: validar antes de aplicar</CardTitle>
          <CardDescription>Dependen del acuerdo que publique cada dependencia o entidad. No cuentan en ningún plazo hasta que tu organización los declare.</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="divide-y rounded-md border">
            {resumen.sugeridos.map((s) => (
              <li key={s.fecha} className="flex flex-wrap items-center justify-between gap-2 p-3">
                <div className="min-w-0 space-y-0.5">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    {formatFechaSolo(s.fecha, "larga")} · {s.nombre}
                    <StatusBadge tone="warning">Validar con fiscalista/abogado</StatusBadge>
                  </p>
                  <p className="text-xs text-muted-foreground">{s.motivo}</p>
                </div>
                {yaDeclarado(s.fecha) ? (
                  <StatusBadge tone="info">Declarado por tu organización</StatusBadge>
                ) : puedeEditar ? (
                  <Button type="button" size="sm" variant="outline" disabled={ocupado} onClick={() => declararSugerido(s)}>
                    Declarar para mi organización
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      {resumen.available ? (
        <Card>
          <CardHeader>
            <CardTitle>Declarados por tu organización</CardTitle>
            <CardDescription>Aplican a todas tus convocatorias, o solo a la que indiques (los días que publica la convocante para una contratación).</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {resumen.declarados.length === 0 ? (
              <EstadoVacio titulo="Sin días declarados" mensaje="Declara aquí los días inhábiles que publique la dependencia o entidad convocante; hasta entonces solo cuentan los oficiales." compacto />
            ) : (
              <ul className="divide-y rounded-md border">
                {resumen.declarados.map((d) => (
                  <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 p-3">
                    <div className="min-w-0 space-y-0.5">
                      <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                        {formatFechaSolo(d.fecha, "larga")} · {d.nombre}
                        <StatusBadge tone={d.verificacion === "verificada" ? "success" : "warning"}>{d.verificacion === "verificada" ? "Verificado" : "Por validar"}</StatusBadge>
                        <StatusBadge tone="neutral">{d.tenderId ? `Convocatoria: ${tituloConvocatoria.get(d.tenderId) ?? d.tenderId}` : "Toda la organización"}</StatusBadge>
                      </p>
                      {d.publicadoPor || d.fuente ? <p className="text-xs text-muted-foreground">{[d.publicadoPor ? `Publicado por ${d.publicadoPor}` : null, d.fuente].filter(Boolean).join(" · ")}</p> : null}
                    </div>
                    {puedeEditar ? (
                      <Button type="button" size="sm" variant="outline" disabled={ocupado} onClick={() => void quitar(d)}>
                        Quitar
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}

            {puedeEditar ? (
              <form className="flex flex-wrap items-end gap-2 border-t pt-4" onSubmit={enviar}>
                <div className="space-y-1">
                  <Label htmlFor="dia-fecha">Fecha</Label>
                  <Input id="dia-fecha" type="date" aria-label="Fecha del día inhábil" value={fecha} onChange={(e) => setFecha(e.target.value)} required />
                </div>
                <div className="min-w-40 flex-1 space-y-1">
                  <Label htmlFor="dia-nombre">Nombre</Label>
                  <Input id="dia-nombre" aria-label="Nombre del día inhábil" value={nombre} onChange={(e) => setNombre(e.target.value)} minLength={3} maxLength={200} required />
                </div>
                <div className="min-w-40 flex-1 space-y-1">
                  <Label htmlFor="dia-publicado">Publicado por (opcional)</Label>
                  <Input id="dia-publicado" aria-label="Dependencia o entidad que lo publica" value={publicadoPor} onChange={(e) => setPublicadoPor(e.target.value)} maxLength={200} />
                </div>
                <div className="min-w-40 flex-1 space-y-1">
                  <Label htmlFor="dia-fuente">Fuente (opcional)</Label>
                  <Input id="dia-fuente" aria-label="Fuente del día inhábil" value={fuente} onChange={(e) => setFuente(e.target.value)} maxLength={300} />
                </div>
                {convocatorias.length > 0 ? (
                  <div className="space-y-1">
                    <Label htmlFor="dia-convocatoria">Aplica a</Label>
                    <NativeSelect id="dia-convocatoria" aria-label="Alcance del día inhábil" value={tenderId} onChange={(e) => setTenderId(e.target.value)}>
                      <option value="">Toda la organización</option>
                      {convocatorias.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.title}
                        </option>
                      ))}
                    </NativeSelect>
                  </div>
                ) : null}
                <Button type="submit" disabled={ocupado || fecha.length === 0 || nombre.trim().length < 3}>
                  Declarar día inhábil
                </Button>
              </form>
            ) : (
              <p className="border-t pt-4 text-sm text-muted-foreground">Tu rol puede ver el calendario, pero solo owner, admin y analista pueden declarar o quitar días.</p>
            )}
          </CardContent>
        </Card>
      ) : null}
      {dialogo}
    </PageContainer>
  );
}
