# Plan de rollback (PL-12)

Cómo volver atrás cuando un despliegue a Producción sale mal. **Todo es manual y lo hace Javier**: ningún
workflow ejecuta un rollback, y no hay secretos en el repo (el CLI de Vercel usa tu sesión local de
`vercel login`).

## Qué es y qué NO es un rollback

- `main` despliega a Producción en Vercel al fusionarse. Un rollback con `vercel rollback` **solo cambia a qué
  despliegue ya construido apunta el dominio de Producción**; no recompila ni toca la base.
- **No revierte la base de datos.** Las migraciones de Supabase son hacia adelante; nadie las aplica al fusionar.
  Por la regla dura de compatibilidad del repo, el código nuevo debe funcionar contra la base vieja, así que
  volver a un despliegue anterior contra una base que ya recibió migraciones sigue siendo seguro **mientras las
  migraciones sean aditivas**. Si una migración fue destructiva (renombrar/borrar columnas), un rollback de código
  puede romperse contra el esquema nuevo: en ese caso arreglar hacia adelante.
- No revierte variables de entorno ni la configuración de Vercel: un cambio de variable requiere un nuevo
  despliegue para aplicar y, al hacer rollback, las variables siguen siendo las actuales.
- Según la documentación de Vercel a la fecha, los planes gratuitos pueden tener restringido el rollback a ciertos
  despliegues recientes: confirma en https://vercel.com/docs/deployments/rollback antes de depender de ello.

## Árbol de decisión

1. **¿La caída empezó con el último despliegue?** Compara la hora del primer fallo (el sondeo de
   `prod-health.yml`, Sentry o el correo de alertas) con la hora del despliegue.
2. **Sí → rollback de código** (este documento, abajo).
3. **No / la base o un proveedor falla →** no hagas rollback: revisa el estado de Supabase y de los proveedores.
4. **El rollback no basta o el código bueno ya no existe como despliegue →** `git revert` del merge en `main`
   (un commit nuevo, sin reescribir historia ni force-push) y dejar que Vercel despliegue el revert.

## Checklist

Antes:
- [ ] Anota hora, síntoma y último merge a `main` (`git log -3 --merges origin/main`).
- [ ] `vercel login` hecho en tu máquina; `vercel --version` responde.
- [ ] Identifica el último despliegue sano: `scripts/rollback/rollback.sh listar` (despliegues de Producción).
- [ ] Revisa si el último merge incluía migraciones (`supabase/migrations/`) y si ya se aplicaron a la base real.

Ejecutar:
- [ ] Simulación: `scripts/rollback/rollback.sh a <id-dpl_...-o-hostname.vercel.app>` (solo imprime el comando).
- [ ] Real: el mismo comando con `--ejecutar`; pide escribir `ROLLBACK`. Equivale a `vercel rollback <destino>`.
- [ ] Estado: `scripts/rollback/rollback.sh estado`.

Después:
- [ ] `npm run smoke:post-deploy -- https://<tu-dominio>` (health, cabeceras, login 401, guarda de Origin, SPA).
- [ ] `node --experimental-strip-types scripts/health-check/check.ts https://<tu-dominio>` en verde.
- [ ] Vigila el siguiente ciclo de crons (latidos en `/health` con el secreto interno) y las alertas.
- [ ] Abre un PR con el revert o el arreglo en `main`; mientras tanto el siguiente merge volvería a desplegar el
  código malo (el rollback de Vercel no bloquea despliegues futuros: considera pausar merges).
- [ ] Anota en el wiki qué falló, qué se revirtió y qué falta.

## Script

`scripts/rollback/rollback.sh` es un envoltorio fino de `vercel rollback`:

| Comando | Qué hace |
|---|---|
| `listar` | `vercel ls --prod` |
| `a <destino>` | Valida el destino (`dpl_…` o `*.vercel.app`) e imprime el comando; no ejecuta |
| `a <destino> --ejecutar` | Pide escribir `ROLLBACK` y ejecuta `vercel rollback <destino>` |
| `estado` | `vercel rollback status` |

Se niega a correr si `CI` o `GITHUB_ACTIONS` están definidos. `ROLLBACK_SCOPE=<equipo>` (opcional, no es
secreto) se pasa como `--scope`. Pruebas: `packages/db/tests/ci-pl12-guards.spec.ts` (con un `vercel` falso;
el rollback real nunca se ejecuta en pruebas).

## Aviso de caída

- `prod-health.yml` sondea `/health` cada 15 min (ver `.github/workflows/README.md`).
- El despachador de alertas de la app (`ALERTAS_*`, `SENTRY_DSN`; ver `docs/CREDENCIALES.md`) se configura en
  Vercel; el CI nunca lo usa ni envía alertas.
