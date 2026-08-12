use std::ffi::c_void;
use windows::core::{PCSTR, PCWSTR};
use windows::Win32::Foundation::CloseHandle;
use windows::Win32::System::Diagnostics::Debug::WriteProcessMemory;
use windows::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress};
use windows::Win32::System::Memory::{
    VirtualAllocEx, VirtualFreeEx, MEM_COMMIT, MEM_RELEASE, MEM_RESERVE, PAGE_READWRITE,
};
use windows::Win32::System::Threading::{
    CreateRemoteThread, OpenProcess, WaitForSingleObject, INFINITE, LPTHREAD_START_ROUTINE,
    PROCESS_ALL_ACCESS,
};

/// Injects a DLL into a running process via the classic LoadLibraryW + CreateRemoteThread
/// technique — the same approach used by the original C# Injector. LoadLibraryW's own
/// signature (`extern "system" fn(*mut c_void) -> u32` once resolved) already matches
/// LPTHREAD_START_ROUTINE, so no double-transmute through an intermediate integer type
/// is needed — a single transmute of the resolved FARPROC is enough.
pub fn inject(process_id: u32, dll_path: &str) -> Result<(), String> {
    if !std::path::Path::new(dll_path).exists() {
        return Err(format!("DLL not found: {dll_path}"));
    }

    unsafe {
        let kernel32_name: Vec<u16> = "kernel32.dll\0".encode_utf16().collect();
        let kernel32 = GetModuleHandleW(PCWSTR(kernel32_name.as_ptr()))
            .map_err(|e| format!("Failed to get kernel32.dll handle: {e}"))?;

        let load_library_addr = GetProcAddress(kernel32, PCSTR(b"LoadLibraryW\0".as_ptr()))
            .ok_or_else(|| "Could not resolve LoadLibraryW.".to_string())?;

        let start_routine: LPTHREAD_START_ROUTINE = std::mem::transmute(load_library_addr);

        let process = OpenProcess(PROCESS_ALL_ACCESS, false, process_id).map_err(|_| {
            "Failed to open the Minecraft process. Try running Ender Client as Administrator."
                .to_string()
        })?;

        let path_bytes: Vec<u16> = dll_path.encode_utf16().chain(std::iter::once(0)).collect();
        let size = path_bytes.len() * std::mem::size_of::<u16>();

        let remote_buffer = VirtualAllocEx(process, None, size, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);

        if remote_buffer.is_null() {
            let _ = CloseHandle(process);
            return Err("Failed to allocate memory in the target process.".to_string());
        }

        let write_result = WriteProcessMemory(
            process,
            remote_buffer,
            path_bytes.as_ptr() as *const c_void,
            size,
            None,
        );

        if write_result.is_err() {
            let _ = VirtualFreeEx(process, remote_buffer, 0, MEM_RELEASE);
            let _ = CloseHandle(process);
            return Err("Failed to write the DLL path into the target process.".to_string());
        }

        let thread = CreateRemoteThread(
            process,
            None,
            0,
            start_routine,
            Some(remote_buffer as *const c_void),
            0,
            None,
        );

        let thread = match thread {
            Ok(h) => h,
            Err(_) => {
                let _ = VirtualFreeEx(process, remote_buffer, 0, MEM_RELEASE);
                let _ = CloseHandle(process);
                return Err("Failed to create the remote thread for injection.".to_string());
            }
        };

        WaitForSingleObject(thread, INFINITE);

        let _ = CloseHandle(thread);
        let _ = VirtualFreeEx(process, remote_buffer, 0, MEM_RELEASE);
        let _ = CloseHandle(process);
    }

    Ok(())
}
