// Native WASAPI loopback capture of the default render device — no .NET required.
// Writes raw s16le mono PCM at the requested rate to stdout.
//
// Depends only on system DLLs present on every Windows since Vista/7 (ole32).
// Cross-compiled from Linux with MinGW-w64, statically linked so the produced
// .exe needs no MinGW runtime DLLs:
//
//   x86_64-w64-mingw32-g++ -O2 -municode -o deskaudio-x64.exe win-loopback-native.cpp \
//       -static -static-libgcc -static-libstdc++ -lole32 -s
//   i686-w64-mingw32-g++   -O2 -municode -o deskaudio-x86.exe win-loopback-native.cpp \
//       -static -static-libgcc -static-libstdc++ -lole32 -s

#define WIN32_LEAN_AND_MEAN
#define COBJMACROS
#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <stdio.h>
#include <stdlib.h>
#include <io.h>
#include <fcntl.h>

static const int FLUSH_MS = 40;

static int fail(const char* msg, HRESULT hr) {
    if (hr) fprintf(stderr, "%s (0x%08lX)\n", msg, (unsigned long)hr);
    else fprintf(stderr, "%s\n", msg);
    return 1;
}

int main(int argc, char** argv) {
    int dstRate = (argc > 1) ? atoi(argv[1]) : 16000;
    if (dstRate != 8000 && dstRate != 16000 && dstRate != 24000) dstRate = 16000;

    // stdout must be binary, otherwise 0x0A bytes get mangled to 0x0D 0x0A.
    _setmode(_fileno(stdout), _O_BINARY);

    HRESULT hr = CoInitializeEx(NULL, COINIT_MULTITHREADED);
    if (FAILED(hr)) return fail("CoInitializeEx failed", hr);

    IMMDeviceEnumerator* pEnum = NULL;
    hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), NULL, CLSCTX_ALL,
                          __uuidof(IMMDeviceEnumerator), (void**)&pEnum);
    if (FAILED(hr)) return fail("CoCreateInstance(MMDeviceEnumerator) failed", hr);

    IMMDevice* pDevice = NULL;
    hr = pEnum->GetDefaultAudioEndpoint(eRender, eConsole, &pDevice);
    if (FAILED(hr)) return fail("GetDefaultAudioEndpoint failed", hr);

    IAudioClient* pClient = NULL;
    hr = pDevice->Activate(__uuidof(IAudioClient), CLSCTX_ALL, NULL, (void**)&pClient);
    if (FAILED(hr)) return fail("Activate(IAudioClient) failed", hr);

    WAVEFORMATEX* pwfx = NULL;
    hr = pClient->GetMixFormat(&pwfx);
    if (FAILED(hr)) return fail("GetMixFormat failed", hr);

    int ch = pwfx->nChannels;
    int srcRate = (int)pwfx->nSamplesPerSec;
    int bits = pwfx->wBitsPerSample;
    bool isFloat = (pwfx->wFormatTag == WAVE_FORMAT_IEEE_FLOAT);
    if (pwfx->wFormatTag == WAVE_FORMAT_EXTENSIBLE) {
        WAVEFORMATEXTENSIBLE* ext = (WAVEFORMATEXTENSIBLE*)pwfx;
        isFloat = (ext->SubFormat.Data1 == 3); // 3 = IEEE float, 1 = PCM
    }
    if (!((isFloat && bits == 32) || (!isFloat && bits == 16)))
        return fail("Unsupported mix format", 0);

    hr = pClient->Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK,
                             10000000 /*1 s*/, 0, pwfx, NULL);
    if (FAILED(hr)) return fail("IAudioClient::Initialize failed", hr);

    IAudioCaptureClient* pCapture = NULL;
    hr = pClient->GetService(__uuidof(IAudioCaptureClient), (void**)&pCapture);
    if (FAILED(hr)) return fail("GetService(IAudioCaptureClient) failed", hr);

    hr = pClient->Start();
    if (FAILED(hr)) return fail("IAudioClient::Start failed", hr);

    // Simple box down-mix to mono + down-sample to dstRate, emitted as s16le.
    double step = (double)srcRate / dstRate;
    double phase = 0.0, acc = 0.0;
    int n = 0;

    int flushBytes = dstRate * 2 * FLUSH_MS / 1000;
    int cap = flushBytes + 4096;
    unsigned char* out = (unsigned char*)malloc(cap);
    int outLen = 0;

    for (;;) {
        UINT32 pkt = 0;
        hr = pCapture->GetNextPacketSize(&pkt);
        if (FAILED(hr)) break;
        if (pkt == 0) {
            if (outLen > 0) { fwrite(out, 1, outLen, stdout); fflush(stdout); outLen = 0; }
            if (ferror(stdout)) break;   // the agent closed our stdout: stop
            Sleep(5);
            continue;
        }
        while (pkt > 0) {
            BYTE* data = NULL; UINT32 frames = 0; DWORD flags = 0;
            hr = pCapture->GetBuffer(&data, &frames, &flags, NULL, NULL);
            if (FAILED(hr)) { pCapture->ReleaseBuffer(0); goto done; }
            bool silent = (flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0;
            const float* f = (const float*)data;
            const short* s = (const short*)data;
            for (UINT32 i = 0; i < frames; i++) {
                double sum = 0.0;
                if (!silent) {
                    for (int c = 0; c < ch; c++)
                        sum += isFloat ? f[i * ch + c] : s[i * ch + c] / 32768.0;
                }
                acc += sum / ch; n++; phase += 1.0;
                if (phase >= step) {
                    phase -= step;
                    double v = (n > 0 ? acc / n : 0.0) * 32767.0;
                    if (v > 32767.0) v = 32767.0; else if (v < -32768.0) v = -32768.0;
                    short o16 = (short)v;
                    out[outLen++] = (unsigned char)(o16 & 0xFF);
                    out[outLen++] = (unsigned char)((o16 >> 8) & 0xFF);
                    acc = 0.0; n = 0;
                    if (outLen >= flushBytes) {
                        fwrite(out, 1, outLen, stdout); fflush(stdout); outLen = 0;
                        if (ferror(stdout)) goto done;
                    }
                }
            }
            pCapture->ReleaseBuffer(frames);
            hr = pCapture->GetNextPacketSize(&pkt);
            if (FAILED(hr)) goto done;
        }
    }
done:
    free(out);
    pClient->Stop();
    pCapture->Release();
    CoTaskMemFree(pwfx);
    pClient->Release();
    pDevice->Release();
    pEnum->Release();
    CoUninitialize();
    return 0;
}
