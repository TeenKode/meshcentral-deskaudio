// Test input for the browser checks: encode a continuous two-tone signal into
// 20 ms Opus packets (as the helper does), written as
// [dur:2 LE][len:2 LE][packet] records (dur in 48 kHz samples).
//   opus-packets [seconds=4] [second tone Hz=660]
// The default (4 s, 440 + 660 Hz at 8000/4000) is what e2e/opus-playback.js
// expects; e2e/multi-listener.js uses 440 + 1000 Hz at equal level, like the
// Windows capture check (e2e/tone.js).
#include <opus/opus.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
int main(int argc, char** argv) {
    double seconds = (argc > 1) ? atof(argv[1]) : 4.0;
    double f2 = (argc > 2) ? atof(argv[2]) : 660.0;
    double a1 = (argc > 2) ? 9830 : 8000, a2 = (argc > 2) ? 9830 : 4000;   // 0.3 + 0.3 for the tone checks
    int frames = (int)(seconds * 50);
    int err; OpusEncoder* e = opus_encoder_create(48000, 1, OPUS_APPLICATION_AUDIO, &err);
    opus_encoder_ctl(e, OPUS_SET_BITRATE(32000));
    short pcm[960]; unsigned char pkt[4000];
    for (int f = 0; f < frames; f++) {
        for (int i = 0; i < 960; i++) {
            double t = (f * 960 + i) / 48000.0;
            pcm[i] = (short)(a1 * sin(2 * M_PI * 440 * t) + a2 * sin(2 * M_PI * f2 * t));
        }
        int n = opus_encode(e, pcm, 960, pkt, sizeof pkt);
        unsigned char h[4] = { 960 & 255, 960 >> 8, (unsigned char)(n & 255), (unsigned char)(n >> 8) };
        fwrite(h, 1, 4, stdout); fwrite(pkt, 1, n, stdout);
    }
    return 0;
}
