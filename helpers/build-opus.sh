#!/bin/sh
# Download and build libopus as static libs for both MinGW targets, then link
# the helpers with DA_BUILD_OPUS.
#
# The plugin's zip install (MeshCentral downloads the GitHub repo archive)
# cannot carry git submodules, and vendoring 255 source files (~8 MB) into the
# repo is worse than downloading a pinned tarball at build time. The hash is
# fixed: the tag is protected in xiph/opus, and CI fails loudly if the bytes
# ever differ.
#
#   sudo apt-get install -y g++-mingw-w64-x86-64 g++-mingw-w64-i686
#   ./build-opus.sh          # builds into helpers/opus-build-<arch>/
set -e
cd "$(dirname "$0")"

OPUS_VER=1.5.2
OPUS_TARBALL_SHA256=9480e329e989f70d69886ded470c7f8cfe6c0667cc4196d4837ac9e668fb7404
OPUS_URL="https://github.com/xiph/opus/archive/refs/tags/v${OPUS_VER}.tar.gz"

# ---------- download + verify ----------
TARBALL="$(mktemp)"
trap 'rm -f "$TARBALL"' EXIT
curl -sL -o "$TARBALL" "$OPUS_URL"
echo "$OPUS_TARBALL_SHA256  $TARBALL" | sha256sum -c - >/dev/null

SRC="$(mktemp -d)"
tar xzf "$TARBALL" -C "$SRC" --strip-components=1

# ---------- build per arch ----------
build_one() {
    # $1 = prefix (x86_64-w64-mingw32 | i686-w64-mingw32)
    PREFIX="$1"
    OUT="$PWD/opus-build-$(echo "$PREFIX" | cut -d- -f1)"

    mkdir -p "$OUT"
    cd "$SRC"

    # Opus ships cmake; a plain autotools-free build via cmake keeps the file
    # set minimal (float only, no DRED/DNN deps, no intrinsics - portable).
    # -Os for size: the helper is dropped over the wire in base64.
    cmake -B "$OUT" \
        -DCMAKE_SYSTEM_NAME=Windows \
        -DCMAKE_SYSTEM_PROCESSOR="$(echo "$PREFIX" | cut -d- -f1)" \
        -DCMAKE_C_COMPILER="${PREFIX}-gcc" \
        -DCMAKE_CXX_COMPILER="${PREFIX}-g++" \
        -DCMAKE_BUILD_TYPE=Release \
        -DBUILD_SHARED_LIBS=OFF \
        -DBUILD_TESTING=OFF \
        -DOPUS_BUILD_SHARED_LIBRARY=OFF \
        -DOPUS_BUILD_PROGRAMS=OFF \
        -DOPUS_BUILD_TESTING=OFF \
        -DOPUS_INSTALL_PKG_CONFIG_MODULE=OFF \
        -DOPUS_INSTALL_CMAKE_CONFIG_MODULE=OFF \
        -DOPUS_DRED=OFF \
        -DOPUS_DEEP_PLC=OFF \
        -DOPUS_ENABLE_FLOAT_API=ON \
        -DOPUS_FIXED_POINT=OFF \
        -DOPUS_X86_MAY_HAVE_SSE=OFF \
        -DOPUS_X86_MAY_HAVE_SSE2=OFF \
        -DOPUS_X86_MAY_HAVE_SSE4_1=OFF \
        -DOPUS_X86_MAY_HAVE_AVX=OFF \
        -DOPUS_X86_MAY_HAVE_AVX2=OFF \
        -DOPUS_X86_PRESERVE_NONE=OFF \
        -DCMAKE_C_FLAGS="-Os -fno-exceptions -fno-asynchronous-unwind-tables" \
        > /dev/null
    cmake --build "$OUT" --target opus -j"$(nproc)" > /dev/null
    echo "built: $OUT"
    ls -la "$OUT/libopus.a" "$OUT/opus/include" 2>/dev/null || ls -la "$OUT"/libopus.a
    cd - > /dev/null
}

build_one x86_64-w64-mingw32
build_one i686-w64-mingw32

echo "done"
