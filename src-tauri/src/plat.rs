//! O que muda de um sistema para outro: quem usa o microfone, qual janela está em
//! tela cheia e como abrir um arquivo de texto. Nomes de app saem sempre em minúsculo
//! e sem ".exe", para a mesma lista servir no Windows, no Mac e no Linux.

/// "Chrome.exe" -> "chrome"; "/Applications/zoom.us.app/.../zoom.us" -> "zoom.us".
pub fn norm(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name).trim().to_lowercase();
    base.strip_suffix(".exe").map(str::to_string).unwrap_or(base)
}

/// Abre um arquivo no editor de texto padrão do sistema.
pub fn open_text(path: &std::path::Path) {
    #[cfg(windows)]
    let r = std::process::Command::new("notepad.exe").arg(path).spawn();
    #[cfg(target_os = "macos")]
    let r = std::process::Command::new("open").arg("-t").arg(path).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let r = std::process::Command::new("xdg-open").arg(path).spawn();
    if let Err(e) = r {
        crate::write_log(&format!("[sistema] não abriu {}: {e}", path.display()));
    }
}

pub use imp::{fullscreen_app, mic_users};

/* ============================== Windows ============================== */
#[cfg(windows)]
mod imp {
    use super::norm;

    /// Nome do .exe de um processo.
    fn exe_name(pid: u32) -> Option<String> {
        use windows::core::PWSTR;
        use windows::Win32::Foundation::CloseHandle;
        use windows::Win32::System::Threading::{
            OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
        };
        unsafe {
            let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
            let mut buf = [0u16; 1024];
            let mut len = buf.len() as u32;
            let r = QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len);
            let _ = CloseHandle(h);
            r.ok()?;
            Some(norm(&String::from_utf16_lossy(&buf[..len as usize])))
        }
    }

    /// Quais apps estão captando o microfone agora? Pergunta ao áudio do Windows (WASAPI):
    /// em cada microfone ativo, pega as sessões de captura "ativas" e o processo de cada uma.
    /// (O registro ConsentStore parou de ser atualizado no Windows 11 recente.)
    pub fn mic_users(_wanted: &[String]) -> Vec<String> {
        use windows::core::Interface;
        use windows::Win32::Media::Audio::{
            eCapture, AudioSessionStateActive, IAudioSessionControl2, IAudioSessionManager2,
            IMMDeviceEnumerator, MMDeviceEnumerator, DEVICE_STATE_ACTIVE,
        };
        use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED};
        let mut out = Vec::new();
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            let Ok(en) = CoCreateInstance::<_, IMMDeviceEnumerator>(&MMDeviceEnumerator, None, CLSCTX_ALL) else {
                return out;
            };
            let Ok(devs) = en.EnumAudioEndpoints(eCapture, DEVICE_STATE_ACTIVE) else { return out };
            for i in 0..devs.GetCount().unwrap_or(0) {
                let Ok(dev) = devs.Item(i) else { continue };
                let Ok(mgr) = dev.Activate::<IAudioSessionManager2>(CLSCTX_ALL, None) else { continue };
                let Ok(list) = mgr.GetSessionEnumerator() else { continue };
                for j in 0..list.GetCount().unwrap_or(0) {
                    let Ok(sess) = list.GetSession(j) else { continue };
                    if !sess.GetState().map(|st| st == AudioSessionStateActive).unwrap_or(false) {
                        continue;
                    }
                    let Ok(c2) = sess.cast::<IAudioSessionControl2>() else { continue };
                    let pid = c2.GetProcessId().unwrap_or(0);
                    if let Some(n) = (pid != 0).then(|| exe_name(pid)).flatten() {
                        if !out.contains(&n) {
                            out.push(n);
                        }
                    }
                }
            }
        }
        out.sort();
        out
    }

    /// A janela da frente ocupa o monitor inteiro (jogo, vídeo, apresentação)?
    /// Janela maximizada não conta. Devolve o app dela.
    pub fn fullscreen_app(own: isize) -> Option<String> {
        use windows::Win32::Foundation::RECT;
        use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST};
        use windows::Win32::UI::WindowsAndMessaging::{
            GetClassNameW, GetDesktopWindow, GetForegroundWindow, GetShellWindow, GetWindowRect,
            GetWindowThreadProcessId, IsZoomed,
        };
        unsafe {
            let h = GetForegroundWindow();
            if h.0.is_null() || h == GetShellWindow() || h == GetDesktopWindow() || h.0 as isize == own {
                return None;
            }
            let mut cls = [0u16; 64];
            let n = GetClassNameW(h, &mut cls);
            let class = String::from_utf16_lossy(&cls[..n.max(0) as usize]);
            if matches!(class.as_str(), "Progman" | "WorkerW" | "Shell_TrayWnd") || IsZoomed(h).as_bool() {
                return None;
            }
            let mut r = RECT::default();
            GetWindowRect(h, &mut r).ok()?;
            let mut mi = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
            if !GetMonitorInfoW(MonitorFromWindow(h, MONITOR_DEFAULTTONEAREST), &mut mi).as_bool() {
                return None;
            }
            let m = mi.rcMonitor;
            if r.left <= m.left && r.top <= m.top && r.right >= m.right && r.bottom >= m.bottom {
                let mut pid = 0u32;
                GetWindowThreadProcessId(h, Some(&mut pid));
                Some(exe_name(pid).unwrap_or_else(|| "?".into()))
            } else {
                None
            }
        }
    }
}

/* ============================== Mac ============================== */
#[cfg(target_os = "macos")]
mod imp {
    use super::norm;
    use std::ffi::c_void;

    #[repr(C)]
    struct Addr {
        selector: u32,
        scope: u32,
        element: u32,
    }

    #[link(name = "CoreAudio", kind = "framework")]
    extern "C" {
        fn AudioObjectGetPropertyData(
            id: u32,
            addr: *const Addr,
            qualifier_size: u32,
            qualifier: *const c_void,
            size: *mut u32,
            data: *mut c_void,
        ) -> i32;
    }

    const SYSTEM_OBJECT: u32 = 1;
    const fn fourcc(s: &[u8; 4]) -> u32 {
        (s[0] as u32) << 24 | (s[1] as u32) << 16 | (s[2] as u32) << 8 | s[3] as u32
    }

    fn get_u32(id: u32, selector: u32) -> Option<u32> {
        let addr = Addr { selector, scope: fourcc(b"glob"), element: 0 };
        let mut v: u32 = 0;
        let mut size = std::mem::size_of::<u32>() as u32;
        let st = unsafe {
            AudioObjectGetPropertyData(id, &addr, 0, std::ptr::null(), &mut size, &mut v as *mut u32 as *mut c_void)
        };
        (st == 0).then_some(v)
    }

    /// O microfone padrão está em uso por algum app?
    fn mic_running() -> bool {
        let Some(dev) = get_u32(SYSTEM_OBJECT, fourcc(b"dIn ")).filter(|d| *d != 0) else { return false };
        get_u32(dev, fourcc(b"gone")).unwrap_or(0) != 0
    }

    /// O macOS não diz qual app usa o microfone. Com o microfone em uso, devolve os apps
    /// da lista que estão abertos; se nenhum estiver, avisa só que o microfone está em uso.
    pub fn mic_users(wanted: &[String]) -> Vec<String> {
        if !mic_running() {
            return Vec::new();
        }
        let out = std::process::Command::new("ps").args(["-axo", "comm="]).output();
        let mut found: Vec<String> = out
            .map(|o| String::from_utf8_lossy(&o.stdout).lines().map(norm).filter(|n| wanted.contains(n)).collect())
            .unwrap_or_default();
        found.sort();
        found.dedup();
        if found.is_empty() {
            found.push("(app desconhecido)".into());
        }
        found
    }

    /// Tela cheia no Mac não é detectada nesta versão.
    pub fn fullscreen_app(_own: isize) -> Option<String> {
        None
    }
}

/* ============================== Linux ============================== */
#[cfg(all(unix, not(target_os = "macos")))]
mod imp {
    use super::norm;
    use std::process::Command;

    fn run(cmd: &str, args: &[&str]) -> Option<String> {
        let o = Command::new(cmd).args(args).output().ok()?;
        o.status.success().then(|| String::from_utf8_lossy(&o.stdout).into_owned())
    }

    /// Apps gravando do microfone, pelo PulseAudio/PipeWire (`pactl list source-outputs`).
    pub fn mic_users(_wanted: &[String]) -> Vec<String> {
        let Some(txt) = run("pactl", &["list", "source-outputs"]) else { return Vec::new() };
        let mut out: Vec<String> = txt
            .lines()
            .filter_map(|l| {
                let l = l.trim();
                let v = l.strip_prefix("application.process.binary = ")?;
                Some(norm(v.trim_matches('"')))
            })
            .collect();
        out.sort();
        out.dedup();
        out
    }

    /// Janela ativa em tela cheia, pelo X11 (`xprop`). No Wayland puro não há como saber.
    pub fn fullscreen_app(_own: isize) -> Option<String> {
        let root = run("xprop", &["-root", "_NET_ACTIVE_WINDOW"])?;
        let id = root.split_whitespace().last()?.to_string();
        if id == "0x0" {
            return None;
        }
        let st = run("xprop", &["-id", &id, "_NET_WM_STATE", "_NET_WM_PID", "WM_CLASS"])?;
        if !st.contains("_NET_WM_STATE_FULLSCREEN") {
            return None;
        }
        let pid = st.lines().find(|l| l.starts_with("_NET_WM_PID")).and_then(|l| l.split_whitespace().last()?.parse::<u32>().ok());
        if pid == Some(std::process::id()) {
            return None;
        }
        let class = st
            .lines()
            .find(|l| l.starts_with("WM_CLASS"))
            .and_then(|l| l.split('"').nth(3).map(norm))
            .unwrap_or_else(|| "?".into());
        Some(class)
    }
}
