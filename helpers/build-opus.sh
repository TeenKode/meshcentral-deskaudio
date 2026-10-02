#!/bin/sh
# Download and build libopus as static MinGW libs for both targets, into
# helpers/opus-build-<arch>/ (picked up by build-native.sh).
#
# The plugin's zip install (MeshCentral downloads the GitHub repo archive)
# cannot carry git submodules, and vendoring ~255 source files into the repo
# is worse than downloading a pinned tarball at build time. The tarball hash
# is fixed; the tag is protected in xiph/opus, and the build fails loudly if
# the bytes ever differ.
#
#   sudo apt-get install -y g++-mingw-w64-x86-64 g++-mingw-w64-i686 cmake
#   ./build-opus.sh
set -e
HELPERS="$(cd "$(dirname "$0")" && pwd)"
cd "$HELPERS"

OPUS_VER=1.5.2
OPUS_TARBALL_SHA256=9480e329e989f70d69886ded470c7f8cfe6c0667cc4196d4837ac9e668fb7404
OPUS_URL="https://github.com/xiph/opus/archive/refs/tags/v${OPUS_VER}.tar.gz"

# ---------- download + verify ----------
# The source is unpacked under a stable subpath (the BUILDROOT temp dir itself
# is unavoidable, but see -ffile-prefix-map below): object files embed the
# compile-time directory (assert messages, __FILE__), and random temp paths
# would make libopus.a - and the final exe - differ between builds, breaking
# the byte-reproducibility check in CI.
BUILDROOT="$(mktemp -d)"
trap 'rm -rf "$BUILDROOT"' EXIT
TARBALL="$BUILDROOT/opus.tar.gz"
SRC="$BUILDROOT/opus-src"
curl -sL -o "$TARBALL" "$OPUS_URL"
echo "$OPUS_TARBALL_SHA256  $TARBALL" | sha256sum -c - >/dev/null
mkdir -p "$SRC"
tar xzf "$TARBALL" -C "$SRC" --strip-components=1

# ---------- build per arch ----------
build_one() {
    # $1 = mingw prefix, $2 = arch dir name (x86_64 | i686)
    PREFIX="$1"; ARCH="$2"
    OUT="$HELPERS/opus-build-$ARCH"

    rm -rf "$OUT"
    # Float-only, no SIMD, no DRED/DNN: smallest portable static lib.
    # -Os for size: the helper ships over the wire in base64.
    cmake -S "$SRC" -B "$OUT" \
        -DCMAKE_SYSTEM_NAME=Windows \
        -DCMAKE_SYSTEM_PROCESSOR="$ARCH" \
        -DCMAKE_C_COMPILER="${PREFIX}-gcc" \
        -DCMAKE_BUILD_TYPE=Release \
        -DBUILD_SHARED_LIBS=OFF \
        -DBUILD_TESTING=OFF \
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
        -DCMAKE_C_FLAGS="-Os -fno-exceptions -fno-asynchronous-unwind-tables -ffile-prefix-map=$BUILDROOT=." \
        > /dev/null
    cmake --build "$OUT" --target opus -j"$(nproc)" > /dev/null
    # The build tree has no staged headers; stage them ourselves where
    # build-native.sh expects them: <arch-dir>/include/opus/opus.h.
    mkdir -p "$OUT/include/opus"
    cp "$SRC"/include/*.h "$OUT/include/opus/"
    echo "built: $OUT"
    ls -la "$OUT/libopus.a"
}

build_one x86_64-w64-mingw32 x86_64
build_one i686-w64-mingw32   i686

echo "done"
