// Credenciales de Meta por organizacion (migracion 0090): apps de Meta propias de una organizacion y con cual sale y se verifica cada
// numero. Backend real: apps/api/src/routes/superadmin-whatsapp-meta.ts (step-up MFA en cada escritura; secretos de SOLO escritura:
// esta pantalla nunca los recibe del servidor y limpia los campos al cerrar). Sin llave o con la base sin migrar: aviso honesto y sin
// controles. Ver docs/WHATSAPP-CREDENCIALES-POR-ORGANIZACION.md.
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useParams } from "react-router-dom";
import { KeyRound, MessageCircle } from "lucide-react";
import { Button, Callout, Card, CardContent, CardHeader, CardTitle, EstadoCargando, EstadoError, EstadoVacio, FormDialog, FormField, Input, NativeSelect, PageContainer, PageHeader, StatusBadge, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, useT } from "@atiende/ui";
import { useFormatos } from "@atiende/ui/i18n/formato";
import { waMeta } from "@atiende/ui/i18n/waMeta";
import { fetchJson } from "../lib/fetch-json.ts";

interface Credencial {
  readonly id: string;
  readonly etiqueta: string;
  readonly appId: string;
  readonly wabaId: string;
  readonly tieneVerifyToken: boolean;
  readonly activa: boolean;
  readonly tokenRotadoEnMs: number | null;
  readonly numeros: number;
}

interface Numero {
  readonly propertyId: string | null;
  readonly propertyNombre: string | null;
  readonly phoneNumberId: string | null;
  readonly credencialId: string | null;
}

interface Respuesta {
  readonly disponible: boolean;
  readonly motivo?: "sin_llave" | "no_migrada";
  readonly credenciales: readonly Credencial[];
  readonly numeros: readonly Numero[];
}

type Dialogo =
  | { readonly tipo: "registrar" }
  | { readonly tipo: "rotar"; readonly credencial: Credencial }
  | { readonly tipo: "revocar"; readonly credencial: Credencial }
  | { readonly tipo: "asignar"; readonly numero: Numero };

const CAMPOS_VACIOS = { etiqueta: "", appId: "", wabaId: "", appSecret: "", accessToken: "", verifyToken: "", motivo: "", phoneNumberId: "", credencialId: "" };

export function SuperAdminWhatsappMetaPage({ apiBaseUrl, token }: { readonly apiBaseUrl: string; readonly token: string }) {
  const t = useT(waMeta);
  const { fechaHora } = useFormatos();
  const { id = "" } = useParams<{ id: string }>();
  const base = `/superadmin/organizaciones/${encodeURIComponent(id)}/whatsapp-meta`;
  const [datos, setDatos] = useState<Respuesta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [dialogo, setDialogo] = useState<Dialogo | null>(null);
  const [campos, setCampos] = useState(CAMPOS_VACIOS);
  const [formError, setFormError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);

  const cargar = useCallback(async () => {
    setError(null);
    try {
      setDatos(await fetchJson<Respuesta>(apiBaseUrl, token, base));
    } catch {
      setError(t("waMeta.errorCarga"));
    }
  }, [apiBaseUrl, token, base, t]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  function abrir(d: Dialogo) {
    setCampos(d.tipo === "asignar" ? { ...CAMPOS_VACIOS, phoneNumberId: d.numero.phoneNumberId ?? "", credencialId: d.numero.credencialId ?? "" } : CAMPOS_VACIOS);
    setFormError(null);
    setDialogo(d);
  }

  function cerrar() {
    // Los secretos escritos no se quedan en memoria del componente al cerrar.
    setCampos(CAMPOS_VACIOS);
    setDialogo(null);
  }

  const campo = (k: keyof typeof CAMPOS_VACIOS) => ({ value: campos[k], onChange: (e: { target: { value: string } }) => setCampos((c) => ({ ...c, [k]: e.target.value })) });

  async function enviar(e: FormEvent) {
    e.preventDefault();
    if (!dialogo) return;
    let path = "";
    let method = "POST";
    let body: Record<string, unknown> = {};
    if (dialogo.tipo === "registrar") {
      if (!campos.etiqueta.trim() || !campos.appId.trim() || !campos.wabaId.trim() || !campos.appSecret.trim() || !campos.accessToken.trim()) {
        setFormError(t("waMeta.error.requeridos"));
        return;
      }
      path = `${base}/credenciales`;
      body = { etiqueta: campos.etiqueta, appId: campos.appId, wabaId: campos.wabaId, appSecret: campos.appSecret, accessToken: campos.accessToken, ...(campos.verifyToken.trim() ? { verifyToken: campos.verifyToken } : {}) };
    } else if (dialogo.tipo === "rotar") {
      path = `${base}/credenciales/${encodeURIComponent(dialogo.credencial.id)}`;
      method = "PUT";
      body = Object.fromEntries((["etiqueta", "appSecret", "accessToken", "verifyToken"] as const).filter((k) => campos[k].trim()).map((k) => [k, campos[k]]));
    } else if (dialogo.tipo === "revocar") {
      path = `${base}/credenciales/${encodeURIComponent(dialogo.credencial.id)}/revocar`;
      body = { motivo: campos.motivo };
    } else {
      if (!campos.phoneNumberId.trim()) {
        setFormError(t("waMeta.error.requeridos"));
        return;
      }
      path = `${base}/numeros`;
      method = "PUT";
      body = { phoneNumberId: campos.phoneNumberId, credencialId: campos.credencialId || null, propertyId: dialogo.numero.propertyId };
    }
    setGuardando(true);
    setFormError(null);
    try {
      const r = await fetchJson<{ numerosLiberados?: number }>(apiBaseUrl, token, path, { method, body: JSON.stringify(body) });
      const tipo = dialogo.tipo;
      cerrar();
      setAviso(tipo === "registrar" ? t("waMeta.ok.registrada") : tipo === "rotar" ? t("waMeta.ok.rotada") : tipo === "revocar" ? t("waMeta.ok.revocada", { count: r.numerosLiberados ?? 0 }) : t("waMeta.ok.asignado"));
      await cargar();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : t("waMeta.error.guardar"));
    } finally {
      setGuardando(false);
    }
  }

  if (error && !datos) return <EstadoError mensaje={error} onReintentar={() => void cargar()} />;
  if (!datos) return <EstadoCargando etiqueta={t("waMeta.cargando")} />;

  const activas = datos.credenciales.filter((c) => c.activa);
  const nombreApp = (credencialId: string | null) => (credencialId ? (datos.credenciales.find((c) => c.id === credencialId)?.etiqueta ?? credencialId) : t("waMeta.appPlataforma"));

  return (
    <PageContainer>
      <PageHeader
        titulo={t("waMeta.titulo")}
        descripcion={t("waMeta.descripcion")}
        atras={{ to: `/superadmin/organizaciones/${encodeURIComponent(id)}`, etiqueta: t("waMeta.volver") }}
        acciones={
          datos.disponible ? (
            <Button className="rounded-full gap-1.5" onClick={() => abrir({ tipo: "registrar" })}>
              <KeyRound className="w-4 h-4" strokeWidth={1.75} />
              {t("waMeta.apps.registrar")}
            </Button>
          ) : undefined
        }
      />

      {!datos.disponible && (
        <Callout tone="warning" titulo={datos.motivo === "no_migrada" ? t("waMeta.noMigrada.titulo") : t("waMeta.sinLlave.titulo")}>
          {datos.motivo === "no_migrada" ? t("waMeta.noMigrada.texto") : t("waMeta.sinLlave.texto")}
        </Callout>
      )}
      {aviso && (
        <Callout tone="success" titulo={t("waMeta.listo")} onDismiss={() => setAviso(null)}>
          {aviso}
        </Callout>
      )}

      {datos.disponible && (
        <>
          <Callout tone="info">{t("waMeta.soloEscritura")}</Callout>
          <Card>
            <CardHeader>
              <CardTitle>{t("waMeta.apps.titulo")}</CardTitle>
            </CardHeader>
            <CardContent>
              {datos.credenciales.length === 0 ? (
                <EstadoVacio mensaje={t("waMeta.apps.vacio")} />
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t("waMeta.col.etiqueta")}</TableHead>
                        <TableHead>{t("waMeta.col.appId")}</TableHead>
                        <TableHead>{t("waMeta.col.waba")}</TableHead>
                        <TableHead>{t("waMeta.col.verifyToken")}</TableHead>
                        <TableHead className="text-right">{t("waMeta.col.numeros")}</TableHead>
                        <TableHead>{t("waMeta.col.rotado")}</TableHead>
                        <TableHead>{t("waMeta.col.estado")}</TableHead>
                        <TableHead className="text-right">{t("waMeta.col.acciones")}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {datos.credenciales.map((c) => (
                        <TableRow key={c.id}>
                          <TableCell>{c.etiqueta}</TableCell>
                          <TableCell className="font-mono text-xs">{c.appId}</TableCell>
                          <TableCell className="font-mono text-xs">{c.wabaId}</TableCell>
                          <TableCell>{c.tieneVerifyToken ? t("waMeta.verifyPropio") : t("waMeta.verifyPlataforma")}</TableCell>
                          <TableCell className="text-right">{c.numeros}</TableCell>
                          <TableCell>{c.tokenRotadoEnMs === null ? "—" : fechaHora(c.tokenRotadoEnMs)}</TableCell>
                          <TableCell>
                            <StatusBadge tone={c.activa ? "success" : "neutral"}>{c.activa ? t("waMeta.estado.activa") : t("waMeta.estado.revocada")}</StatusBadge>
                          </TableCell>
                          <TableCell className="text-right">
                            {c.activa && (
                              <div className="flex justify-end gap-1.5">
                                <Button size="sm" variant="outline" onClick={() => abrir({ tipo: "rotar", credencial: c })}>
                                  {t("waMeta.rotar")}
                                </Button>
                                <Button size="sm" variant="outline" onClick={() => abrir({ tipo: "revocar", credencial: c })}>
                                  {t("waMeta.revocar")}
                                </Button>
                              </div>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t("waMeta.numeros.titulo")}</CardTitle>
            </CardHeader>
            <CardContent>
              {datos.numeros.length === 0 ? (
                <EstadoVacio mensaje={t("waMeta.numeros.vacio")} />
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t("waMeta.col.sucursal")}</TableHead>
                        <TableHead>{t("waMeta.col.phoneNumberId")}</TableHead>
                        <TableHead>{t("waMeta.col.app")}</TableHead>
                        <TableHead className="text-right">{t("waMeta.col.acciones")}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {datos.numeros.map((n) => (
                        <TableRow key={`${n.propertyId ?? "org"}:${n.phoneNumberId ?? "sin"}`}>
                          <TableCell>{n.propertyNombre ?? t("waMeta.sinSucursal")}</TableCell>
                          <TableCell className="font-mono text-xs">{n.phoneNumberId ?? t("waMeta.sinNumero")}</TableCell>
                          <TableCell>{nombreApp(n.credencialId)}</TableCell>
                          <TableCell className="text-right">
                            <Button size="sm" variant="outline" className="gap-1.5" onClick={() => abrir({ tipo: "asignar", numero: n })}>
                              <MessageCircle className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
                              {t("waMeta.asignar")}
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}

      <FormDialog
        open={dialogo !== null}
        onOpenChange={(open) => !open && cerrar()}
        titulo={dialogo ? t(`waMeta.dlg.${dialogo.tipo}.titulo`) : ""}
        subtitulo={dialogo ? t(`waMeta.dlg.${dialogo.tipo}.subtitulo`) : undefined}
        anchoClase="max-w-lg"
        footer={
          <>
            <Button type="button" variant="outline" className="rounded-full px-6" onClick={cerrar} disabled={guardando}>
              {t("waMeta.cancelar")}
            </Button>
            <Button type="submit" form="form-whatsapp-meta" className="rounded-full px-6" disabled={guardando}>
              {guardando ? t("waMeta.guardando") : dialogo?.tipo === "revocar" ? t("waMeta.revocar") : t("waMeta.guardar")}
            </Button>
          </>
        }
      >
        <form id="form-whatsapp-meta" onSubmit={enviar} className="flex flex-col gap-3" autoComplete="off">
          {dialogo?.tipo === "registrar" && (
            <>
              <FormField label={t("waMeta.campo.etiqueta")} hint={t("waMeta.campo.etiquetaAyuda")} required>
                <Input id="wa-meta-etiqueta" maxLength={80} {...campo("etiqueta")} />
              </FormField>
              <FormField label={t("waMeta.campo.appId")} hint={t("waMeta.campo.appIdAyuda")} required>
                <Input id="wa-meta-app-id" inputMode="numeric" {...campo("appId")} />
              </FormField>
              <FormField label={t("waMeta.campo.wabaId")} required>
                <Input id="wa-meta-waba-id" inputMode="numeric" {...campo("wabaId")} />
              </FormField>
              <Secretos t={t} campo={campo} ayudaExtra={null} requeridos />
            </>
          )}
          {dialogo?.tipo === "rotar" && (
            <>
              <FormField label={t("waMeta.campo.etiqueta")} hint={t("waMeta.campo.dejarIgual")}>
                <Input id="wa-meta-etiqueta" maxLength={80} placeholder={dialogo.credencial.etiqueta} {...campo("etiqueta")} />
              </FormField>
              <Secretos t={t} campo={campo} ayudaExtra={t("waMeta.campo.dejarIgual")} requeridos={false} />
            </>
          )}
          {dialogo?.tipo === "revocar" && (
            <FormField label={t("waMeta.campo.motivo")} hint={t("waMeta.campo.motivoAyuda")} required>
              <Input id="wa-meta-motivo" maxLength={500} {...campo("motivo")} />
            </FormField>
          )}
          {dialogo?.tipo === "asignar" && (
            <>
              <FormField label={t("waMeta.campo.phoneNumberId")} hint={t("waMeta.campo.phoneNumberIdAyuda")} required>
                <Input id="wa-meta-phone-number-id" inputMode="numeric" {...campo("phoneNumberId")} />
              </FormField>
              <FormField label={t("waMeta.campo.app")}>
                <NativeSelect id="wa-meta-credencial" {...campo("credencialId")}>
                  <option value="">{t("waMeta.appPlataforma")}</option>
                  {activas.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.etiqueta}
                    </option>
                  ))}
                </NativeSelect>
              </FormField>
            </>
          )}
          {formError && (
            <p role="alert" className="text-sm text-destructive">
              {formError}
            </p>
          )}
        </form>
      </FormDialog>
    </PageContainer>
  );
}

/** Campos de secretos (solo escritura): tipo password, sin autocompletar ni corrector. */
function Secretos({
  t,
  campo,
  ayudaExtra,
  requeridos,
}: {
  readonly t: ReturnType<typeof useT>;
  readonly campo: (k: "appSecret" | "accessToken" | "verifyToken") => { value: string; onChange: (e: { target: { value: string } }) => void };
  readonly ayudaExtra: string | null;
  readonly requeridos: boolean;
}): ReactNode {
  const ayuda = (clave: "waMeta.campo.appSecretAyuda" | "waMeta.campo.accessTokenAyuda" | "waMeta.campo.verifyTokenAyuda") => (ayudaExtra ? `${t(clave)} ${ayudaExtra}` : t(clave));
  const secreto = { type: "password", autoComplete: "new-password", spellCheck: false } as const;
  return (
    <>
      <FormField label={t("waMeta.campo.appSecret")} hint={ayuda("waMeta.campo.appSecretAyuda")} required={requeridos}>
        <Input id="wa-meta-app-secret" {...secreto} {...campo("appSecret")} />
      </FormField>
      <FormField label={t("waMeta.campo.accessToken")} hint={ayuda("waMeta.campo.accessTokenAyuda")} required={requeridos}>
        <Input id="wa-meta-access-token" {...secreto} {...campo("accessToken")} />
      </FormField>
      <FormField label={t("waMeta.campo.verifyToken")} hint={ayuda("waMeta.campo.verifyTokenAyuda")}>
        <Input id="wa-meta-verify-token" {...secreto} {...campo("verifyToken")} />
      </FormField>
    </>
  );
}
