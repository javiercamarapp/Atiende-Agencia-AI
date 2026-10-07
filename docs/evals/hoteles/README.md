# Evals de hoteles

Reportes de las corridas de evals de los agentes de hoteles. Cada corrida deja un `.json` (para maquinas) y un `.md` (para personas) con fecha, modelo, guiones corridos y omitidos, aprobacion global y por grader, costo estimado y latencia p50/p95 por guion.

## Voz (disponible)

21 guiones es-MX (`packages/domain-hoteles/src/voz/simulador/guiones-es-mx.ts`: 13 originales y 8 de la paridad3: toallas, alergia en room service, factura, estacionamiento/wifi, tuteo, emergencia, reserva no pagada, ingles), juzgados por graders deterministas (`graders-voz.ts`).

- Proveedor falso (sin credenciales ni costo; prueba que el arnes y los graders estan sanos, NO mide al modelo):
  `npm run evals:hoteles:voz:falso -w @atiende/domain-hoteles`
- Real, contra Gemini Live (manual; nunca corre en CI ni en `npm test`; cuesta dinero):
  `VOZ_EVALS_REAL=1 GEMINI_API_KEY=... VOZ_EVALS_MAX_USD=1 npm run evals:hoteles:voz:real -w @atiende/domain-hoteles`
  - `VOZ_EVALS_MAX_USD`: tope de gasto estimado (por omision 1, techo duro 5). Se corta al alcanzarlo y lista lo que no corrio.
  - `VOZ_EVALS_USD_POR_MIN`: estimacion por minuto de pared (0.04). `GEMINI_LIVE_MODEL`: modelo. `VOZ_EVALS_GUIONES=H01,H14`: solo esos (por prefijo de id). `--dir=<ruta>` (argumento del CLI): carpeta del reporte.

## Pendiente de conectar

- WhatsApp en modo real: depende del agente general de hoteles (HOT-A, `HOTELES_EVALS_REAL`), que aun no esta en main. Su runner debe escribir aqui con la misma forma (`ReporteEvals` en `reporte.ts`) y el script raiz `evals:hoteles:real` encadenara WhatsApp y voz respetando los dos topes.
- Registro en EvalOps (`core.eval_run` / `eval_result`, SA-L-11): aun no existe en main; cuando exista, el runner escribira ahi con `EVALS_REGISTRAR=1`.
