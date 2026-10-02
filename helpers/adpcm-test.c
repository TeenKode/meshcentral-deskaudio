/* Byte-exactness test for the native ADPCM encoder.
 *
 * The C++ encoder in win-loopback-native.cpp must be an exact port of the
 * agent's JS adpcmEncode() (modules_meshcore/deskaudio.js): both produce
 * self-contained blocks decoded by the same browser code. This program is
 * compiled by CI (cc on the host, no Windows headers needed) and prints the
 * encoder's output for a fixed deterministic signal, hex-encoded, one line.
 * The Node test (test/native-adpcm.test.js) runs the JS encoder over the same
 * signal and compares the bytes; it parses this program's expected output
 * from the fixture below (kept in sync by the same CI job that runs it).
 *
 * To avoid duplicating the signal, this file IS the fixture generator: run it
 * with "gen" to print the hex, and the Node test compiles this same encoder
 * via a tiny shared header - see helpers/adpcm-enc.h.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>

#include "adpcm-enc.h"

/* Deterministic LCG, identical to the one in test/native-adpcm.test.js. */
static unsigned int seed = 12345;
static unsigned int lcg(void) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed; }

int main(int argc, char** argv) {
    (void)argc; (void)argv;
    const int N = 2000;   /* ~125 ms at 16 kHz: many blocks, varied dynamics */
    short in[N];
    for (int i = 0; i < N; i++) {
        double t = (double)i;
        double v = 12000.0 * sin(2.0 * 3.14159265358979 * t / 32.0)      /* tone */
                 + 4000.0 * sin(2.0 * 3.14159265358979 * t / 7.0)        /* +harmonic */
                 + (double)((int)(lcg() % 400) - 200);                    /* +noise */
        if (v > 32767.0) v = 32767.0; if (v < -32768.0) v = -32768.0;
        in[i] = (short)lrint(v);   /* Math.round in the JS fixture generator */
    }

    int block = 640;                     /* one 40 ms frame at 16 kHz */
    for (int off = 0; off + block <= N; off += block) {
        unsigned char out[4 + block / 2 + 1];
        int n = da_adpcmEncode(in + off, block, out);
        for (int i = 0; i < n; i++) printf("%02x", out[i]);
        printf("\n");
    }
    return 0;
}
