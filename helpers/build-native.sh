#!/bin/sh
# Rebuild the prebuilt native Windows helpers from win-loopback-native.cpp.
# Cross-compiles from Linux with MinGW-w64, statically linked so the produced
# .exe files depend only on system DLLs (kernel32, msvcrt, ole32) — no .NET and
# no MinGW runtime DLLs.
#
#   sudo apt-get install -y g++-mingw-w64-x86-64 g++-mingw-w64-i686
#   ./build-native.sh
#
# The build is reproducible (--no-insert-timestamp): CI rebuilds the helpers on
# Ubuntu 24.04 and fails if the committed .exe files differ from the source.
set -e
cd "$(dirname "$0")"

FLAGS="-O2 -static -static-libgcc -static-libstdc++ -s -Wl,--no-insert-timestamp"
LIBS="-lole32"

x86_64-w64-mingw32-g++ -o deskaudio-x64.exe win-loopback-native.cpp $FLAGS $LIBS
i686-w64-mingw32-g++   -o deskaudio-x86.exe win-loopback-native.cpp $FLAGS $LIBS

echo "built:"
ls -la deskaudio-x64.exe deskaudio-x86.exe
