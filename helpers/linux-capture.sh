#!/bin/sh
# Captures the default output's monitor (what plays on the speakers) as raw
# s16le mono PCM on stdout. Works with PulseAudio, and with PipeWire either
# through pipewire-pulse (parec) or natively (pw-record).
#
# Usage: sh linux-capture.sh <rate>
# The agent runs this as root (inline, via sh -c); the capture itself runs as
# the logged-in desktop user, whose audio server owns the output.
RATE="${1:-16000}"
log() { echo "$*" >&2; }

has_audio() {   # $1 = runtime dir: does it hold a PulseAudio or PipeWire socket?
  [ -S "$1/pulse/native" ] || [ -S "$1/pipewire-0" ]
}

# 1) The user of the active local session (loginctl): the person in front of
#    the screen, even when several users are logged in.
U=""
if command -v loginctl >/dev/null 2>&1; then
  for s in $(loginctl list-sessions --no-legend 2>/dev/null | awk '{print $1}'); do
    [ "$(loginctl show-session "$s" -p Active --value 2>/dev/null)" = "yes" ] || continue
    uid=$(loginctl show-session "$s" -p User --value 2>/dev/null)
    if [ -n "$uid" ] && [ "$uid" != "0" ] && has_audio "/run/user/$uid"; then U="$uid"; break; fi
  done
fi
# 2) Otherwise the first user with an audio server socket.
if [ -z "$U" ]; then
  for d in /run/user/*; do
    [ -d "$d" ] || continue
    id=$(basename "$d")
    [ "$id" = "0" ] && continue
    if has_audio "$d"; then U="$id"; break; fi
  done
fi

if [ -n "$U" ]; then
  NAME=$(getent passwd "$U" | cut -d: -f1)
  RUNDIR="/run/user/$U"
elif [ "$(id -u)" != "0" ] && [ -n "$XDG_RUNTIME_DIR" ] && has_audio "$XDG_RUNTIME_DIR"; then
  # Not root (an agent installed per user): capture our own session.
  NAME=""
  RUNDIR="$XDG_RUNTIME_DIR"
else
  log "no audio session found (nobody logged in, or no PulseAudio/PipeWire)"
  exit 2
fi

# Run a command as the desktop user (when we are root), in their audio session.
as_user() {
  if [ "$(id -u)" = "0" ] && [ -n "$NAME" ]; then
    exec runuser -u "$NAME" -- env XDG_RUNTIME_DIR="$RUNDIR" PULSE_SERVER="unix:$RUNDIR/pulse/native" "$@"
  fi
  XDG_RUNTIME_DIR="$RUNDIR" PULSE_SERVER="unix:$RUNDIR/pulse/native" exec "$@"
}
as_user_out() {   # same, but returns the output (no exec)
  if [ "$(id -u)" = "0" ] && [ -n "$NAME" ]; then
    runuser -u "$NAME" -- env XDG_RUNTIME_DIR="$RUNDIR" PULSE_SERVER="unix:$RUNDIR/pulse/native" "$@"
  else
    XDG_RUNTIME_DIR="$RUNDIR" PULSE_SERVER="unix:$RUNDIR/pulse/native" "$@"
  fi
}

# "deskaudio-capture" marks the process so the agent can find it to stop it.
if [ -S "$RUNDIR/pulse/native" ] && command -v parec >/dev/null 2>&1; then
  SINK=$(as_user_out pactl get-default-sink 2>/dev/null)
  if [ -z "$SINK" ]; then log "cannot determine the default output (pactl get-default-sink)"; exit 4; fi
  log "capture: parec, user ${NAME:-$(id -un)}, ${SINK}.monitor, $RATE Hz"
  as_user parec --client-name=deskaudio-capture -d "${SINK}.monitor" --raw \
    --format=s16le --rate="$RATE" --channels=1 --latency-msec=40
fi

if [ -S "$RUNDIR/pipewire-0" ] && command -v pw-record >/dev/null 2>&1; then
  # stream.capture.sink records the default output's monitor; "-" writes raw
  # samples to stdout (no file header).
  log "capture: pw-record, user ${NAME:-$(id -un)}, default output monitor, $RATE Hz"
  as_user pw-record -P '{ stream.capture.sink = true, application.name = deskaudio-capture }' \
    --rate "$RATE" --channels 1 --format s16 --latency 40ms -
fi

log "no capture tool: install pulseaudio-utils (parec) or pipewire-bin (pw-record)"
exit 3
