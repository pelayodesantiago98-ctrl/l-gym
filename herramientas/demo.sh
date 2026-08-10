#!/bin/bash
# Levanta una copia de l-gym en /tmp con sesión falsa y datos de ejemplo, la
# fotografía y la borra. No toca la instalación real ni su base de datos.
set -eu

# En /var/tmp, que está en disco. /tmp aquí es un tmpfs de 921 MB sobre 1,8 GB
# de RAM y no le caben ni las dependencias.
DEMO=/var/tmp/gym-demo
PUERTO=3099

rm -rf "$DEMO"
cp -a /var/www/l-gym "$DEMO"
rm -rf "$DEMO/datos" "$DEMO/public/imagenes"
mkdir -p "$DEMO/datos" "$DEMO/public/imagenes"

# Sesión falsa solo en la copia: así no hace falta firmar cookies ni meterle
# credenciales a chromium.
python3 - "$DEMO/servidor.js" <<'EOP'
import sys
ruta = sys.argv[1]
texto = open(ruta, encoding='utf-8').read()
viejo = "app.use(sso.exigirSesion());"
nuevo = ("app.use((req, res, next) => { req.sesion = { id: 'demo', nombre: 'Demo' }; next(); });"
         "  // SOLO EN LA DEMO")
assert viejo in texto, 'no encuentro el middleware del sso'
open(ruta, 'w', encoding='utf-8').write(texto.replace(viejo, nuevo, 1))
print('sesion falsa puesta')
EOP

PUERTO=$PUERTO node "$DEMO/servidor.js" > /var/tmp/gym-demo.log 2>&1 &
PID=$!
sleep 3
echo "demo en $PUERTO (pid $PID)"

B=http://127.0.0.1:$PUERTO
J='Content-Type: application/json'

api() { curl -s -X "$1" "$B$2" -H "$J" -d "${3:-}"; }

# --- rutina de ejemplo ---
G=$(api POST /api/grupos '{"nombre":"Pecho y tríceps"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
api POST /api/grupos '{"nombre":"Espalda y bíceps"}' > /dev/null
api POST /api/grupos '{"nombre":"Pierna"}' > /dev/null

for c in "Bici suave 5 min" "Movilidad de hombro" "Rotaciones con banda"; do
  api POST /api/ejercicios "{\"grupo_id\":$G,\"tipo\":\"calentamiento\",\"nombre\":\"$c\"}" > /dev/null
done

crear_ej() {
  api POST /api/ejercicios "{\"grupo_id\":$G,\"tipo\":\"ejercicio\",\"nombre\":\"$1\",\"series\":$2,\"notas\":\"$3\"}" \
    | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])'
}
E1=$(crear_ej "Press banca" 4 "Escápulas retraídas, pies clavados")
E2=$(crear_ej "Press inclinado con mancuernas" 3 "")
E3=$(crear_ej "Fondos en paralelas" 3 "")
E4=$(crear_ej "Extensión de tríceps en polea" 3 "")

# --- histórico: ocho semanas subiendo peso ---
sesion() { curl -s "$B/api/sesion?fecha=$1&grupo=$G" | python3 -c 'import sys,json;print(json.load(sys.stdin)["sesion"]["id"])'; }

for k in 8 7 6 5 4 3 2 1; do
  F=$(date -d "-$((k * 7)) days" +%F)
  S=$(sesion "$F")
  BASE_PESO=$((52 + (7 - k) * 3))
  for n in 1 2 3 4; do
    P=$((BASE_PESO + (n - 1) * 2))
    api POST "/api/sesion/$S/serie" \
      "{\"ejercicio_id\":$E1,\"numero\":$n,\"peso\":$P,\"repeticiones\":8,\"hecho\":1}" > /dev/null
  done
  for n in 1 2 3; do
    api POST "/api/sesion/$S/serie" \
      "{\"ejercicio_id\":$E2,\"numero\":$n,\"peso\":$((18 + (7 - k))),\"repeticiones\":10,\"hecho\":1}" > /dev/null
  done
  api POST "/api/sesion/$S/marca" "{\"ejercicio_id\":$E3,\"hecho\":true}" > /dev/null
done

# El día de hoy a medias, que es como se ve en el gimnasio.
HOY=$(date +%F)
S=$(sesion "$HOY")
api POST "/api/sesion/$S/notas" '{"notas":"Buen día. El press subió sin ayuda en la última."}' > /dev/null
for e in $(curl -s "$B/api/sesion?fecha=$HOY&grupo=$G" | python3 -c '
import sys, json
d = json.load(sys.stdin)
print(" ".join(str(e["id"]) for e in d["ejercicios"] if e["tipo"] == "calentamiento"))'); do
  api POST "/api/sesion/$S/marca" "{\"ejercicio_id\":$e,\"hecho\":true}" > /dev/null
done
api POST "/api/sesion/$S/serie" "{\"ejercicio_id\":$E4,\"numero\":1,\"peso\":25,\"repeticiones\":12,\"hecho\":1}" > /dev/null

echo 'datos de ejemplo cargados'

# --- capturas ---
C="--headless --disable-gpu --no-sandbox --hide-scrollbars --virtual-time-budget=8000 --run-all-compositor-stages-before-draw"
chromium $C --window-size=1100,1500 --screenshot=/var/tmp/g-entreno.png  "$B/"           2>/dev/null
chromium $C --window-size=420,1750  --screenshot=/var/tmp/g-movil.png    "$B/"           2>/dev/null
chromium $C --window-size=1100,1700 --screenshot=/var/tmp/g-progreso.png "$B/#progreso"  2>/dev/null
chromium $C --window-size=1100,1400 --screenshot=/var/tmp/g-rutinas.png  "$B/#rutinas"   2>/dev/null

echo 'capturas hechas'
kill $PID 2>/dev/null || true
sleep 1
rm -rf "$DEMO"
ls -l /var/tmp/g-*.png | awk '{print $5, $9}'

