// Test input for e2e/opus-playback.js: encode 4 s of a continuous two-tone
// signal into 20 ms Opus packets (as the helper does), written as
// [dur:2 LE][len:2 LE][packet] records (dur in 48 kHz samples).
#include <opus/opus.h>
#include <math.h>
#include <stdio.h>
int main(void) {
    int err; OpusEncoder* e = opus_encoder_create(48000, 1, OPUS_APPLICATION_AUDIO, &err);
    opus_encoder_ctl(e, OPUS_SET_BITRATE(32000));
    short pcm[960]; unsigned char pkt[4000];
    for (int f = 0; f < 200; f++) {
        for (int i = 0; i < 960; i++) {
            double t = (f * 960 + i) / 48000.0;
            pcm[i] = (short)(8000 * (sin(2 * M_PI * 440 * t) + 0.5 * sin(2 * M_PI * 660 * t)));
        }
        int n = opus_encode(e, pcm, 960, pkt, sizeof pkt);
        unsigned char h[4] = { 960 & 255, 960 >> 8, (unsigned char)(n & 255), (unsigned char)(n >> 8) };
        fwrite(h, 1, 4, stdout); fwrite(pkt, 1, n, stdout);
    }
    return 0;
}
