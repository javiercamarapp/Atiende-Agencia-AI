# Medicion del agente de PM en GitHub Actions

Corre la medicion R21 (42 escenarios NUCLEO) o el simulador (piloto ~108) en paralelo: una repeticion por job, cada job con su
propio runner y su propio Postgres efimero (puerto 55491, SSL autofirmado, todas las migraciones de `supabase/migrations`).
Reproduce `correr-r21.sh` / `correr-sim.sh` del arnes local. **Gasta saldo real de OpenRouter**; el workflow es solo `workflow_dispatch`.

## Lanzar

```
gh workflow run medicion-agente.yml --ref <rama> \
  -f etiqueta=m34 -f repeticiones=5 -f suite=r21 -f evidencia_alineada=false
gh run watch   # o la pestana Actions; el resultado agregado queda en el Summary del run
```

Inputs: `etiqueta`, `repeticiones` (1-5), `suite` (`r21`|`sim`), `evidencia_alineada` (EVIDENCIA_AGREGADOS=1), `modo` (on|off|default),
`max_paralelo`, `conc` (conversaciones simultaneas por job, 2 como en la Mac), `tope_job_usd` (vacio = 2 en r21 / 5 en sim),
`tope_total_usd` (corte global sobre el uso de la llave al lanzar; por omision 8).
**El workflow debe existir en la rama por defecto para poder lanzarse** (limite de GitHub para `workflow_dispatch`); `--ref` elige
la rama cuyo codigo se mide (migraciones, agente y arnes salen de ese checkout).

## Costo estimado (medido en la Mac, delta de `/api/v1/key`)

| suite | por repeticion | tiempo por rep | 5 reps |
|---|---|---|---|
| r21 | USD 0.2 a 0.56 (promedio ~0.4) | ~27 min (Mac con carga); limite del job 75 min | ~USD 2 |
| sim (piloto) | USD ~1.4 a 2.8 | 2.8 h en la Mac cargada; limite del job 180 min | ~USD 7 a 14 (subir `tope_total_usd`) |

Minutos de Actions: gratis en repo publico. Los cortes: cada job consulta `/api/v1/key` cada 15 s y se mata si el uso sube
`tope_job_usd` desde que arranco o `tope_total_usd` sobre el uso base leido al lanzar. El uso de la llave es global: con reps en
paralelo, el delta de un job incluye lo que gastan los demas (por eso el tope por job es holgado y el corte global es el real).
El job `preparar` tambien aborta si `limit_remaining` de la llave es menor que `tope_total_usd`.

## Secretos

- `OPENROUTER_API_KEY` (ya existe). Solo es env del paso que corre `correr.sh` y del paso de `preparar`.
- Suite `sim`: el corpus de escenarios es PRIVADO y no puede vivir en el repo. Requiere el secreto `CORPUS_SIM_GZ_B64` con el JSON
  gzip + base64 (limite de un secreto: 48 KB). El corpus completo (477) pesa ~84 KB en base64 y NO cabe; hay que subir el subconjunto
  del piloto (~108 ids, ~22-30 KB):
  `python3 -c "import json,gzip,base64,sys; print(base64.b64encode(gzip.compress(open(sys.argv[1],'rb').read(),9)).decode())" corpus-piloto.json | gh secret set CORPUS_SIM_GZ_B64`
  (el JSON debe conservar la forma `{"escenarios":[...]}` y el piloto se genera con la misma seleccion `QA_SIM_FILTRO=piloto` del arnes).
  Para sim, los artefactos y logs de un repo publico son publicos: `correr.sh` NO sube `log.txt` ni las conversaciones, solo un resumen sin
  texto (`convos-sim-min.json`), la telemetria y las marcas.

## Contenido

- `correr.sh` — una repeticion, parametrizada por env (ver su cabecera): suite, etiqueta, modelo, modo, `NUCLEO`, `CONC`, `EVIDENCIA_AGREGADOS`, topes.
- `pg-up.sh` — Postgres efimero (derivado de `r18-ejec/qa/pg-up.sh`: usa los binarios que trae `ubuntu-latest`, o los instala).
- `agregar.py` — agrega las reps: pasan/total, pasan sin invalidas, p95 de turno (convos y telemetria), `fetch_failed`, `error_proveedor`, escenarios fallidos.
- `arnes/` — copia del arnes local (`run`, `suites*`, `lib`, `stack`, `evidencia-juez`, `setup-orders`, `llm`, `inv-precio`, `vite-node.config`, SQL, `cargar-config.py`).
  Los `.ts` van como `*.ts.txt` para que el typecheck/lint de la raiz no los tomen (importan `../repo/...` y usan extensiones `.ts`); `correr.sh` los
  restaura y arma el layout `<tmp>/qa` + `<tmp>/repo -> checkout` que el arnes espera. Cambios respecto a la copia local: solo las rutas por omision
  con `$HOME` de `run.ts` (carpeta de resultados) y `suites.ts` (corpus), ahora relativas / sin default.
- `arnes/real-dump/` — catalogo y configuracion del negocio (menus, precios, sucursales, zonas, textos del agente) exportada de solo lectura. No contiene
  clientes finales, pedidos ni correos; si no se quiere en un repo publico, quitarla y servirla como artefacto privado.

## No cubre

`analiza-r21.py` (comparacion ON/OFF con Fisher/bootstrap) no se copio: depende de `analiza-cierre.py` y de la estructura de carpetas local. Descargar los
artefactos (`gh run download`) y usarlo localmente si hace falta.
