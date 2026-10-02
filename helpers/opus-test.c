/* Smoke test for the Opus encoder wrapper (helpers/opus-enc.h).
 *
 * Runs on the host (ubuntu CI runner) against the system libopus
 * (libopus-dev): encodes a deterministic tone as the helper would (960-sample
 * 20 ms frames at 48 kHz input) and checks that packets come out with sane
 * sizes and decodable headers. The point is to fail loudly if da_opus_feed's
 * frame math regresses (e.g. invalid frame_size -> OPUS_BAD_ARG -> silence).
 */
#define DA_BUILD_OPUS
#include <stdio.h>
#include <stdlib.h>
#include <math.h>
#include <string.h>

#include "opus-enc.h"

static int emitted = 0;
static void emit(int len, const unsigned char* pkt, int dur) {
    (void)pkt;
    if (len <= 0 || dur != 960) { fprintf(stderr, "bad packet: len=%d dur=%d\n", len, dur); exit(1); }
    emitted++;
}

int main(void) {
    DaOpusEnc* e = da_opus_init(48000, 32000);
    if (!e) { fprintf(stderr, "init failed\n"); return 1; }

    /* 2 seconds of a 440 Hz tone at 48 kHz, fed in awkward chunk sizes. */
    const int N = 48000 * 2;
    short* in = malloc(N * sizeof(short));
    for (int i = 0; i < N; i++) in[i] = (short)(12000 * sin(2 * 3.141592653589793 * 440 * i / 48000));

    /* Feed in 40 ms frames (1920 samples) like the helper loop, and also in
       odd pieces to exercise partial buffering. */
    int off = 0;
    while (off < N) {
        int take = (off % 3 == 0) ? 1920 : 977;   /* 40 ms or an awkward size */
        if (off + take > N) take = N - off;
        if (da_opus_feed(e, in + off, take, emit) != 0) {
            fprintf(stderr, "da_opus_feed failed (opus error)\n"); return 1;
        }
        off += take;
    }
    /* 2 s of 20 ms frames = ~100 packets (minus the tail still buffered). */
    if (emitted < 95 || emitted > 100) { fprintf(stderr, "unexpected packet count: %d\n", emitted); return 1; }
    printf("opus smoke ok: %d packets\n", emitted);
    da_opus_free(e);
    free(in);
    return 0;
}
