#!/bin/bash
# Re-corre los guiones de RECOGER con el reloj congelado (lunes 18:30) para los modelos baratos. Tope duro (prefijo r1). Uso: OPENROUTER_API_KEY=... bash scripts/voz-bench/lote-reloj.sh
D=${VOZ_BENCH_OUT:-$HOME/atiende-loop/work/voz-bench-resultados}
REC=V02,V24,V25,V27,V28,V29,V30,V31,V32
R="npx vite-node scripts/voz-bench/run.ts --motor cascada --lote r1-voz --cap ${1:-0.6} --conc 2 --reps 5 --guiones $REC"
$R --out $D/r1-voz-luna-low-reloj.jsonl --modelo openai/gpt-6-luna --razon low --etiqueta low
$R --out $D/r1-voz-luna-none-reloj.jsonl --modelo openai/gpt-6-luna --razon none --etiqueta none
$R --out $D/r1-voz-haiku-none-cache-reloj.jsonl --modelo anthropic/claude-haiku-5.5 --razon none --cache --etiqueta none-cache
