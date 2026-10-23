# Flowa modifier hook. Listen-only WH_KEYBOARD_LL.
# Prints "ready" or "denied", then lines the Electron app understands:
#   mod-down RightAlt | mod-up RightAlt | key
# "key" means some other key went down. The characters themselves are not printed.
# Exits when stdin closes (the parent Electron process stopped the hook).
$ErrorActionPreference = 'Stop'
$code = @'
using System;
using System.Runtime.InteropServices;
using System.Threading;

public static class FlowaModifierHook {
    const int WH_KEYBOARD_LL = 13;
    const int WH_MOUSE_LL = 14;
    const uint WM_QUIT = 0x0012;
    const int WM_LBUTTONDOWN = 0x0201;
    const int WM_RBUTTONDOWN = 0x0204;
    const int WM_MBUTTONDOWN = 0x0207;
    const int WM_MOUSEWHEEL = 0x020A;
    const int WM_XBUTTONDOWN = 0x020B;

    delegate IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    struct KBDLLHOOKSTRUCT {
        public uint vkCode;
        public uint scanCode;
        public uint flags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct MSG {
        public IntPtr hwnd;
        public uint message;
        public IntPtr wParam;
        public IntPtr lParam;
        public uint time;
        public int x;
        public int y;
    }

    [DllImport("user32.dll")] static extern IntPtr SetWindowsHookEx(int idHook, HookProc lpfn, IntPtr hMod, uint dwThreadId);
    [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr hhk);
    [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] static extern int GetMessage(out MSG lpMsg, IntPtr hWnd, uint min, uint max);
    [DllImport("user32.dll")] static extern bool TranslateMessage(ref MSG lpMsg);
    [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref MSG lpMsg);
    [DllImport("user32.dll")] static extern bool PostThreadMessage(uint idThread, uint msg, IntPtr wParam, IntPtr lParam);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();

    static IntPtr hook = IntPtr.Zero;
    static IntPtr mouseHook = IntPtr.Zero;
    static HookProc proc;
    static HookProc mouseProc;
    static uint threadId;

    public static void Run() {
        var stdout = new System.IO.StreamWriter(Console.OpenStandardOutput()) { AutoFlush = true };
        Console.SetOut(stdout);
        proc = Callback;
        threadId = GetCurrentThreadId();
        hook = SetWindowsHookEx(WH_KEYBOARD_LL, proc, IntPtr.Zero, 0);
        if (hook == IntPtr.Zero) {
            Console.WriteLine("denied");
            return;
        }
        mouseProc = MouseCallback;
        mouseHook = SetWindowsHookEx(WH_MOUSE_LL, mouseProc, IntPtr.Zero, 0);
        Console.WriteLine("ready");
        var stdinThread = new Thread(WatchStdin);
        stdinThread.IsBackground = true;
        stdinThread.Start();
        MSG msg;
        while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0) {
            TranslateMessage(ref msg);
            DispatchMessage(ref msg);
        }
        UnhookWindowsHookEx(hook);
        if (mouseHook != IntPtr.Zero) UnhookWindowsHookEx(mouseHook);
    }

    static IntPtr MouseCallback(int nCode, IntPtr wParam, IntPtr lParam) {
        if (nCode >= 0) {
            int msg = wParam.ToInt32();
            if (msg == WM_LBUTTONDOWN || msg == WM_RBUTTONDOWN || msg == WM_MBUTTONDOWN || msg == WM_XBUTTONDOWN || msg == WM_MOUSEWHEEL) {
                Console.WriteLine("pointer");
            }
        }
        return CallNextHookEx(mouseHook, nCode, wParam, lParam);
    }

    static void WatchStdin() {
        try {
            var stdin = Console.OpenStandardInput();
            var buf = new byte[16];
            while (stdin.Read(buf, 0, buf.Length) > 0) {}
        } catch {}
        PostThreadMessage(threadId, WM_QUIT, IntPtr.Zero, IntPtr.Zero);
    }

    static IntPtr Callback(int nCode, IntPtr wParam, IntPtr lParam) {
        if (nCode >= 0) {
            var info = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));
            bool up = (info.flags & 0x80) != 0;
            string name = ModifierName(info.vkCode, info.flags);
            if (name != null) Console.WriteLine((up ? "mod-up " : "mod-down ") + name);
            else if (!up) Console.WriteLine("key");
        }
        return CallNextHookEx(hook, nCode, wParam, lParam);
    }

    static string ModifierName(uint vk, uint flags) {
        bool extended = (flags & 0x01) != 0;
        switch (vk) {
            case 0xA0: return "LeftShift";
            case 0xA1: return "RightShift";
            case 0xA2: return "LeftControl";
            case 0xA3: return "RightControl";
            case 0xA4: return "LeftAlt";
            case 0xA5: return "RightAlt";
            case 0x5B: return "LeftMeta";
            case 0x5C: return "RightMeta";
            case 0x10: return extended ? "RightShift" : "LeftShift";
            case 0x11: return extended ? "RightControl" : "LeftControl";
            case 0x12: return extended ? "RightAlt" : "LeftAlt";
            default: return null;
        }
    }
}
'@
Add-Type -TypeDefinition $code -Language CSharp
[FlowaModifierHook]::Run()
