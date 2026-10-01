// WASAPI loopback capture of the default render device.
// Writes raw s16le mono PCM at the requested rate to stdout.
// Plain C# 5 so the csc.exe that ships with .NET Framework 4 can build it:
//   csc /nologo /optimize+ /out:deskaudio.exe win-loopback.cs
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
class MMDeviceEnumeratorCom { }

[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator
{
    int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
    int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
}

[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice
{
    int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
}

[ComImport, Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioClient
{
    int Initialize(int shareMode, int streamFlags, long hnsBufferDuration, long hnsPeriodicity, IntPtr format, ref Guid sessionGuid);
    int GetBufferSize(out uint frames);
    int GetStreamLatency(out long latency);
    int GetCurrentPadding(out uint padding);
    int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closest);
    int GetMixFormat(out IntPtr format);
    int GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);
    int Start();
    int Stop();
    int Reset();
    int SetEventHandle(IntPtr eventHandle);
    int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
}

[ComImport, Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioCaptureClient
{
    int GetBuffer(out IntPtr data, out uint frames, out uint flags, out ulong devicePosition, out ulong qpcPosition);
    int ReleaseBuffer(uint frames);
    int GetNextPacketSize(out uint frames);
}

static class Program
{
    static void Check(int hr)
    {
        if (hr != 0) throw new Exception("WASAPI HRESULT 0x" + hr.ToString("X8"));
    }

    static int Main(string[] args)
    {
        try
        {
            int dstRate = args.Length > 0 ? int.Parse(args[0]) : 16000;
            Run(dstRate);
            return 0;
        }
        catch (IOException) { return 0; } // stdout closed: the agent stopped us
        catch (Exception ex)
        {
            Console.Error.WriteLine(ex.Message);
            return 1;
        }
    }

    static void Run(int dstRate)
    {
        IMMDeviceEnumerator en = (IMMDeviceEnumerator)new MMDeviceEnumeratorCom();
        IMMDevice dev;
        Check(en.GetDefaultAudioEndpoint(0 /*eRender*/, 0 /*eConsole*/, out dev));

        Guid iidClient = new Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2");
        object o;
        Check(dev.Activate(ref iidClient, 23 /*CLSCTX_ALL*/, IntPtr.Zero, out o));
        IAudioClient ac = (IAudioClient)o;

        IntPtr pf;
        Check(ac.GetMixFormat(out pf));
        int tag = Marshal.ReadInt16(pf, 0) & 0xFFFF;
        int ch = Marshal.ReadInt16(pf, 2);
        int srcRate = Marshal.ReadInt32(pf, 4);
        int bits = Marshal.ReadInt16(pf, 14);
        bool isFloat = (tag == 3);
        if (tag == 0xFFFE) isFloat = (Marshal.ReadInt32(pf, 24) == 3); // SubFormat.Data1: 3 = IEEE float, 1 = PCM
        if (!((isFloat && bits == 32) || (!isFloat && bits == 16)))
            throw new Exception("Unsupported mix format: tag=" + tag + " bits=" + bits);

        Guid session = Guid.Empty;
        Check(ac.Initialize(0 /*shared*/, 0x00020000 /*LOOPBACK*/, 10000000 /*1 s*/, 0, pf, ref session));
        Guid iidCap = new Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317");
        Check(ac.GetService(ref iidCap, out o));
        IAudioCaptureClient cap = (IAudioCaptureClient)o;
        Check(ac.Start());

        Stream so = Console.OpenStandardOutput();
        MemoryStream outBuf = new MemoryStream();
        int flushBytes = dstRate * 2 * 40 / 1000; // ~40 ms per message
        double step = (double)srcRate / dstRate;
        double phase = 0, acc = 0;
        int n = 0;

        while (true)
        {
            uint pkt;
            Check(cap.GetNextPacketSize(out pkt));
            if (pkt == 0)
            {
                if (outBuf.Length > 0) { so.Write(outBuf.GetBuffer(), 0, (int)outBuf.Length); so.Flush(); outBuf.SetLength(0); }
                Thread.Sleep(5);
                continue;
            }
            while (pkt > 0)
            {
                IntPtr data; uint frames, flags; ulong dp, qp;
                Check(cap.GetBuffer(out data, out frames, out flags, out dp, out qp));
                int count = (int)frames * ch;
                float[] f = null; short[] s = null;
                bool silent = (flags & 2) != 0;
                if (!silent)
                {
                    if (isFloat) { f = new float[count]; Marshal.Copy(data, f, 0, count); }
                    else { s = new short[count]; Marshal.Copy(data, s, 0, count); }
                }
                for (int i = 0; i < (int)frames; i++)
                {
                    double sum = 0;
                    if (!silent)
                    {
                        for (int c = 0; c < ch; c++)
                            sum += isFloat ? f[i * ch + c] : s[i * ch + c] / 32768.0;
                    }
                    acc += sum / ch; n++; phase += 1.0;
                    if (phase >= step)
                    {
                        phase -= step;
                        double v = acc / n * 32767.0;
                        if (v > 32767.0) v = 32767.0; else if (v < -32768.0) v = -32768.0;
                        short o16 = (short)v;
                        outBuf.WriteByte((byte)(o16 & 0xFF));
                        outBuf.WriteByte((byte)((o16 >> 8) & 0xFF));
                        acc = 0; n = 0;
                    }
                }
                Check(cap.ReleaseBuffer(frames));
                if (outBuf.Length >= flushBytes) { so.Write(outBuf.GetBuffer(), 0, (int)outBuf.Length); so.Flush(); outBuf.SetLength(0); }
                Check(cap.GetNextPacketSize(out pkt));
            }
        }
    }
}
