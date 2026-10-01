#!/bin/sh
# Captures the default output's monitor (what plays on the speakers) as raw
# s16le mono PCM on stdout. Works with PulseAudio and PipeWire (pipewire-pulse).
RATE="${1:-16000}"

# Find a logged-in user that has a PulseAudio/PipeWire socket.
U=""
for d in /run/user/*; do
  [ -d "$d" ] || continue
  id=$(basename "$d")
  [ "$id" = "0" ] && continue
  if [ -S "$d/pulse/native" ]; then U="$id"; break; fi
done
if [ -z "$U" ]; then echo "no audio session found in /run/user (nobody logged in?)" >&2; exit 2; fi

NAME=$(getent passwd "$U" | cut -d: -f1)
export XDG_RUNTIME_DIR="/run/user/$U"
export PULSE_SERVER="unix:$XDG_RUNTIME_DIR/pulse/native"

RUN=""
if [ "$(id -u)" = "0" ]; then RUN="runuser -u $NAME --"; fi

command -v parec >/dev/null 2>&1 || { echo "parec not installed (apt install pulseaudio-utils)" >&2; exit 3; }

SINK=$($RUN pactl get-default-sink 2>/dev/null)
if [ -z "$SINK" ]; then echo "cannot determine default sink" >&2; exit 4; fi

exec $RUN parec --client-name=deskaudio -d "${SINK}.monitor" --raw \
  --format=s16le --rate="$RATE" --channels=1 --latency-msec=40
