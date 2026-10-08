// "Mis datos" (H-30): el titular consulta sus datos con un enlace firmado de vida corta que el hotel emite al resolver su solicitud
// de ACCESO. El token viaja en el FRAGMENTO de la URL (nunca llega a los registros del servidor al abrirla) y se manda por POST. Solo se
// muestran perfil, estancias, consentimientos y el estado de la identidad: jamas el documento ni las notas internas del hotel.
import { useEffect, useMemo, useState } from "react";
import { UserRound } from "lucide-react";
import { Callout, Card, CardContent, EstadoCargando, EstadoError } from "@atiende/ui";
import { useMetaPublica } from "../../../lib/meta-publica.ts";
import { PrivacidadPublicaError, crearClientePrivacidadPublica, type MisDatos } from "./cliente.ts";

export function tokenDeFragmento(hash: string): string {
  const m = hash.replace(/^#/, "").match(/(?:^|&)token=([^&]+)/);
  return m ? decodeURIComponent(m[1]!) : "";
}

function Fila({ etiqueta, valor }: { etiqueta: string; valor: unknown }) {
  if (valor === null || valor === undefined || valor === "") return null;
  return (
    <p className="text-sm text-foreground">
      <span className="text-muted-foreground">{etiqueta}: </span>
      {typeof valor === "object" ? JSON.stringify(valor) : String(valor)}
    </p>
  );
}

export function MisDatosPage({ apiBaseUrl, orgSlug }: { apiBaseUrl: string; orgSlug: string }) {
  useMetaPublica({ titulo: "Mis datos personales", descripcion: "Consulta de tus datos personales.", indexable: false });
  const cliente = useMemo(() => crearClientePrivacidadPublica(fetch, apiBaseUrl, orgSlug), [apiBaseUrl, orgSlug]);
  const [estado, setEstado] = useState<MisDatos | "cargando" | "no_encontrado" | { error: string }>("cargando");

  useEffect(() => {
    let cancelado = false;
    const token = tokenDeFragmento(window.location.hash);
    if (!token) {
      setEstado("no_encontrado");
      return;
    }
    cliente
      .misDatos(token)
      .then((d) => !cancelado && setEstado(d))
      .catch((e: unknown) => {
        if (cancelado) return;
        if (e instanceof PrivacidadPublicaError && e.status === 404) setEstado("no_encontrado");
        else setEstado({ error: e instanceof Error ? e.message : "No pudimos cargar tus datos." });
      });
    return () => {
      cancelado = true;
    };
  }, [cliente]);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-5xl items-center gap-2 px-4 py-3 sm:px-6">
          <UserRound className="size-5 text-muted-foreground" strokeWidth={1.75} />
          <h1 className="text-xl font-display font-semibold text-foreground">Mis datos personales</h1>
        </div>
      </header>
      <main className="mx-auto flex max-w-5xl flex-col gap-4 px-4 py-4 sm:px-6" aria-live="polite">
        {estado === "cargando" && <EstadoCargando etiqueta="Cargando tus datos…" />}
        {estado === "no_encontrado" && (
          <Callout tone="warning" titulo="No encontramos tus datos">
            El enlace no es válido o ya venció. Si necesitas uno nuevo, pídeselo al hotel.
          </Callout>
        )}
        {typeof estado === "object" && "error" in estado && <EstadoError titulo="Ocurrió un problema" mensaje={estado.error} onReintentar={() => window.location.reload()} />}
        {typeof estado === "object" && "perfil" in estado && (
          <div className="grid gap-3 lg:grid-cols-2">
            <Card>
              <CardContent className="p-4 flex flex-col gap-1">
                <h2 className="text-sm font-semibold text-foreground">Perfil</h2>
                <Fila etiqueta="Nombre" valor={estado.perfil.nombre} />
                <Fila etiqueta="Correo" valor={estado.perfil.correo} />
                <Fila etiqueta="Teléfono" valor={estado.perfil.telefono} />
                {estado.folio && <p className="pt-1 text-xs text-muted-foreground">Solicitud {estado.folio}</p>}
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4 flex flex-col gap-2">
                <h2 className="text-sm font-semibold text-foreground">Estancias</h2>
                {estado.estancias.length === 0 && <p className="text-sm text-muted-foreground">Sin estancias registradas.</p>}
                {estado.estancias.map((s, i) => (
                  <div key={String(s.reservaId ?? i)} className="border-b border-border pb-2 last:border-b-0 last:pb-0">
                    <Fila etiqueta="Entrada" valor={s.entrada} />
                    <Fila etiqueta="Salida" valor={s.salida} />
                    <Fila etiqueta="Habitación" valor={s.tipoHabitacion} />
                    <Fila etiqueta="Estado" valor={s.estado} />
                  </div>
                ))}
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4 flex flex-col gap-2">
                <h2 className="text-sm font-semibold text-foreground">Consentimientos</h2>
                {estado.consentimientos.length === 0 && <p className="text-sm text-muted-foreground">Sin consentimientos registrados.</p>}
                {estado.consentimientos.map((c, i) => (
                  <div key={String(c.id ?? i)}>
                    <Fila etiqueta="Versión del aviso" valor={c.versionAviso} />
                    <Fila etiqueta="Canal" valor={c.canal} />
                    <Fila etiqueta="Fecha" valor={c.consentidoEn} />
                    <Fila etiqueta="Revocado" valor={c.revocadoEn} />
                  </div>
                ))}
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4 flex flex-col gap-2">
                <h2 className="text-sm font-semibold text-foreground">Identidad registrada</h2>
                <p className="text-xs text-muted-foreground">Por seguridad, el documento de identidad nunca se muestra aquí: solo si el hotel lo tiene resguardado.</p>
                {estado.identidad.length === 0 && <p className="text-sm text-muted-foreground">El hotel no tiene un documento tuyo resguardado.</p>}
                {estado.identidad.map((d, i) => (
                  <div key={String(d.id ?? i)}>
                    <Fila etiqueta="Tipo de documento" valor={d.tipoDocumento} />
                    <Fila etiqueta="Estado" valor={d.estado} />
                    <Fila etiqueta="Conservar hasta" valor={d.conservarHasta} />
                  </div>
                ))}
              </CardContent>
            </Card>
          </div>
        )}
      </main>
    </div>
  );
}
