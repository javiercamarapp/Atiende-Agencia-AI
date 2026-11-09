# Relevo — estado actual (9-nov-2026)

Documento para quien retome el trabajo (persona o agente). Sustituye a los relevos que vivían fuera del repo (`RELEVO-8OCT.md`, `PROMPT-RELEVO-14OCT.md`,
`cola-maestra.md` del 7-oct en `~/atiende-loop`, que no es repo git). Sin secretos: solo nombres de variables.

Documentos hermanos: [`cola-maestra.md`](cola-maestra.md) (backlog por olas) · [`prs-y-ramas.md`](prs-y-ramas.md) (PRs en vuelo y su clase) ·
[`bloqueantes.md`](bloqueantes.md) (lo que no depende del código) · [`../ROADMAP.md`](../ROADMAP.md) · [`../evals/agente-pm/README.md`](../evals/agente-pm/README.md).

## Foto

- `main` = **`cd4eeadc3`** (Merge #778, 8-nov 22:35). Producción sana: `/health` 200 con JSON después de cada merge del 8-nov (Vercel `success`).
- **GitHub Actions bloqueado por facturación desde el 8-nov 15:43 UTC**: ningún job arranca, `main` no tiene CI desde entonces y **no se fusiona nada** hasta destrabarlo.
  Además, el `typecheck` de `main` fallaba por falta de memoria del runner antes del bloqueo; el arreglo está en #815.
- **95 PRs abiertos** al corte del inventario (8-nov 23:02; #177 se cerró el 9-nov). Clases y orden: `prs-y-ramas.md`.
- **Mediciones de pago detenidas** por orden de Javier (8-nov): ni WhatsApp ni voz gastan LLM/voz hasta nueva confirmación.
- Plan vigente: **5 olas** aprobadas el 9-nov (ver `cola-maestra.md`). Paso 3 de Javier (este PR): GitHub como única fuente de verdad de evals, voz y relevo.

## Base de datos real

- Migraciones aplicadas por el loop en octubre-noviembre: 103, 104, 105, 106, 0071, 0072, 0076.
- **En `main` pero sin aplicar** (la confirmación de `apply_migration` expiró): 0075, `mcp_cfdi` 002 (deja `folio_stamp_reservation` sin RLS, como antes), 0077, 0085, 0090.
  El código funciona sin ellas (cae a «no disponible aún»), pero las funciones nuevas no se encienden. Opción acordada: el dueño las corre en el editor SQL de Supabase
  desde el archivo que preparó el loop (`MIGRACIONES-PENDIENTES.sql`, fuera del repo).
- Máximo prefijo en `main`: 000800. Varios PRs traen migraciones con prefijo menor (cobro 000700-705, #796, R23/R24, PRs de octubre): hay que **renumerar** antes de fusionar.

## Agente de PM

- WhatsApp: C4 ciego **86.8 %** en #718 (`5107d110d`) contra 88.8 % del suelto; tres defectos del servidor arreglados en `fa304de9f` **sin medir**; falta decidir el
  umbral del pedido grande en efectivo sin historial (> $2,500 en el servidor contra > $4,000 en el banco).
- Voz: 75 % limpio / 83 % restaurante (n=12) en #813 `c7ec4f03b`; cabeza final `7a590666c` sin E2E; latencia 7-10 s p50 contra meta de 4 s; sin infraestructura.
- Detalle y cómo reproducir: `docs/evals/agente-pm/`.

## Dónde vive cada cosa fuera del repo (solo en la Mac del loop)

| Qué | Ruta |
|---|---|
| Clones y worktrees (147, ~57 GB) | `~/atiende-loop/work/` (`wt-*`, `ola1/`, `ola2-*`, `ola4/`) |
| Crudos completos de evals (con texto) | `~/atiende-loop/work/pm-cuenta-real/medicion-c3/`, `medicion-suelto/`, `nube-resultados/`; `~/atiende-loop/work/qa/pm-agente-loop/ronda-N/` |
| Grabaciones de voz (~1 GB) | `~/atiende-loop/work/wt-voz-r*/.voz-qa/` |
| Bitácora del loop | `~/atiende-loop/logs/estado-noche.md` |
| Inventario del Paso 1 | `~/atiende-loop/work/pm-cuenta-real/INVENTARIO-PASO1-9NOV.md` |
| Respaldo del repo suelto | rama `respaldo/suelto-vigente-20261107` en `javiercamarapp/atiende-restaurantes` (privado) |

Procesos vivos al inventario: un Postgres de medición (`wt-medir-elevenlabs`), dos `caffeinate` y una shell colgada. No hay crontab ni launchd del loop; la única rutina es
la de paridad Rovaq cada 3 h (solo revisa PRs).

## Reglas para retomar

- Lee `CLAUDE.md` del repo. Merge commit normal; **sin squash, sin force-push, sin commits vacíos**. Nunca valores de secretos.
- **No fusionar** sin OK de Javier: fusionar a `main` despliega a producción al instante. No aplicar SQL a la base real sin OK.
- No gastar en LLM ni voz sin confirmación; solo modelos de la lista barata.
- Esta Mac tiene poca RAM: tests con `--maxWorkers=2`, un proceso pesado a la vez.
- Antes de cada push: `git diff` + búsqueda de llaves, tokens, teléfonos y correos de clientes.
