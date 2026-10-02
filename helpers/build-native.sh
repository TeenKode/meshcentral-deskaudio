#!/bin/sh
# Rebuild the prebuilt native Windows helpers from win-loopback-native.cpp.
# Cross-compiles from Linux with MinGW-w64, statically linked so the produced
# .exe files depend only on system DLLs (kernel32, msvcrt, ole32) — no .NET and
# no MinGW runtime DLLs.
#
#   sudo apt-get install -y g++-mingw-w64-x86-64 g++-mingw-w64-i686 cmake
#   ./build-opus.sh            # once: fetch+build static libopus (pinned hash)
#   ./build-native.sh
#
# Without the opus-build-* trees (no libopus), the helper still builds with
# ADPCM only: DA_BUILD_OPUS is defined just when the lib is present.
#
# The build is reproducible (--no-insert-timestamp): CI rebuilds the helpers on
# Ubuntu 24.04 and fails if the committed .exe files differ from the source.

# Compiler flags. Kept in a variable (not the script's positional parameters:
# build_one() has its own "$@") and expanded with a deliberate unquoted word
# split - the string is fixed and contains no globs.
CXXFLAGS="-O2 -static -static-libgcc -static-libstdc++ -s -Wall -Wl,--no-insert-timestamp"

# resample.c (SpeexDSP) is included directly by win-loopback-native.cpp, so the
# only compile unit is the .cpp itself.
build_one() {
    # $1 = mingw prefix, $2 = output exe, $3 = expected arch dir
    PREFIX="$1"; OUT="$2"; ARCHDIR="$3"
    OPUSLIB="opus-build-${ARCHDIR}/libopus.a"
    if [ -f "$OPUSLIB" ]; then
        # shellcheck disable=SC2086
        "$PREFIX-g++" -o "$OUT" win-loopback-native.cpp $CXXFLAGS \
            -DDA_BUILD_OPUS -I"opus-build-${ARCHDIR}/include" "$OPUSLIB" -lwinmm -lole32
    else
        echo "note: $OPUSLIB not found - building WITHOUT Opus (ADPCM only)"
        # shellcheck disable=SC2086
        "$PREFIX-g++" -o "$OUT" win-loopback-native.cpp $CXXFLAGS -lole32
    fi
}

build_one x86_64-w64-mingw32 deskaudio-x64.exe x86_64
build_one i686-w64-mingw32   deskaudio-x86.exe i686

echo "built:"
ls -la deskaudio-x64.exe deskaudio-x86.exe
