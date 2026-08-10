using System.Text;
using EnderClient.Core.Exceptions;
using EnderClient.Core.Native;

namespace EnderClient.Core.Game;

/// <summary>
/// Injects a DLL into a running process via the classic LoadLibraryW + CreateRemoteThread technique.
/// </summary>
public static class Injector
{
    public static void Inject(int processId, string dllPath)
    {
        if (!File.Exists(dllPath))
            throw new InjectionFailedException($"DLL not found: {dllPath}");

        var kernel32 = NativeMethods.GetModuleHandle("kernel32.dll");
        var loadLibraryAddr = NativeMethods.GetProcAddress(kernel32, "LoadLibraryW");
        if (loadLibraryAddr == IntPtr.Zero)
            throw new InjectionFailedException("Could not resolve LoadLibraryW.");

        var hProcess = NativeMethods.OpenProcess(NativeMethods.PROCESS_ALL_ACCESS, false, (uint)processId);
        if (hProcess == IntPtr.Zero)
            throw new InjectionFailedException("Failed to open the Minecraft process. Try running Ender Client as Administrator.");

        var pathBytes = Encoding.Unicode.GetBytes(dllPath + '\0');
        var remoteBuffer = IntPtr.Zero;
        var hThread = IntPtr.Zero;

        try
        {
            remoteBuffer = NativeMethods.VirtualAllocEx(hProcess, IntPtr.Zero, (nuint)pathBytes.Length,
                NativeMethods.MEM_COMMIT | NativeMethods.MEM_RESERVE, NativeMethods.PAGE_READWRITE);

            if (remoteBuffer == IntPtr.Zero)
                throw new InjectionFailedException("Failed to allocate memory in the target process.");

            if (!NativeMethods.WriteProcessMemory(hProcess, remoteBuffer, pathBytes, (nuint)pathBytes.Length, out _))
                throw new InjectionFailedException("Failed to write the DLL path into the target process.");

            hThread = NativeMethods.CreateRemoteThread(hProcess, IntPtr.Zero, 0, loadLibraryAddr, remoteBuffer, 0, out _);
            if (hThread == IntPtr.Zero)
                throw new InjectionFailedException("Failed to create the remote thread for injection.");

            NativeMethods.WaitForSingleObject(hThread, NativeMethods.INFINITE);
        }
        finally
        {
            if (hThread != IntPtr.Zero) NativeMethods.CloseHandle(hThread);
            if (remoteBuffer != IntPtr.Zero) NativeMethods.VirtualFreeEx(hProcess, remoteBuffer, 0, NativeMethods.MEM_RELEASE);
            NativeMethods.CloseHandle(hProcess);
        }
    }
}
