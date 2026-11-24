#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Claude Island: janela sempre no topo que mostra o estado do Claude Code.
//! Os hooks do Claude Code mandam eventos por POST para 127.0.0.1:47821/event.
//! PermissionRequest fica esperando o clique na ilha (até PERM_WAIT); sem
//! resposta, devolve vazio e o Claude Code mostra o pedido normal.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, LogicalSize, Manager, Monitor, PhysicalPosition, WebviewWindow};
use tiny_http::{Header, Method, Response, Server};

const PORT: u16 = 47821;
const PERM_WAIT: Duration = Duration::from_secs(30);
/// Maior corpo aceito (1 MB); eventos reais têm poucos KB.
const MAX_BODY: usize = 1 << 20;
/// Tamanho lógico da janela (igual ao tauri.conf.json) e margem da ilha até a borda.
const WIN_W: f64 = 480.0;
const WIN_H: f64 = 230.0;
const PAD: f64 = 8.0;
/// Cantos possíveis: linha (t topo, m meio, b baixo) + coluna (l esquerda, c centro, r direita).
/// O meio só existe nas laterais (ml, mr).
const ANCHORS: [&str; 8] = ["tl", "tc", "tr", "ml", "mr", "bl", "bc", "br"];

#[derive(Default)]
struct Shared {
    pending: Mutex<HashMap<u64, mpsc::Sender<bool>>>,
    next_id: Mutex<u64>,
    /// Retângulo clicável da ilha, em px lógicos relativos à janela.
    hit: Mutex<(f64, f64, f64, f64)>,
    /// Arraste em curso: (cursor inicial x, y, janela inicial x, y), em px físicos.
    drag: Mutex<Option<(f64, f64, i32, i32)>>,
    anchor: Mutex<String>,
    /// Muda a cada arraste ou encaixe novo; a animação antiga para quando vê outro valor.
    move_gen: AtomicU64,
    /// Em reunião (microfone em uso): a ilha some e não pega o mouse.
    hidden: AtomicBool,
    /// Configurações (config.json): ocultar, não perturbe, aparência, uso.
    cfg: Mutex<Value>,
    /// Último uso do plano recebido da statusline (rate_limits do Claude Code).
    usage: Mutex<Value>,
}

/// Escala da ilha (aparência > tamanho), entre 0,8 e 1,4.
fn scale_of(cfg: &Value) -> f64 {
    cfg["aparencia"]["escala"].as_f64().unwrap_or(1.0).clamp(0.8, 1.4)
}

/// Tamanho lógico da janela na escala atual.
fn win_dims(shared: &Shared) -> (f64, f64) {
    let sc = scale_of(&shared.cfg.lock().unwrap());
    (WIN_W * sc, WIN_H * sc)
}

#[tauri::command]
fn decide(state: tauri::State<Arc<Shared>>, id: u64, allow: bool) {
    if let Some(tx) = state.pending.lock().unwrap().remove(&id) {
        let _ = tx.send(allow);
    }
}

#[tauri::command]
fn log(msg: String) {
    write_log(&format!("[ui] {msg}"));
}

/// Log em %TEMP%claude-island.log (zerado a cada abertura) para diagnosticar sem console.
fn write_log(line: &str) {
    use std::io::Write;
    eprintln!("{line}");
    let path = std::env::temp_dir().join("claude-island.log");
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{line}");
    }
}

#[tauri::command]
fn set_hit_rect(state: tauri::State<Arc<Shared>>, x: f64, y: f64, w: f64, h: f64) {
    *state.hit.lock().unwrap() = (x, y, w, h);
}

/// Padrões de config.json. O que faltar no arquivo vem daqui.
fn default_cfg() -> Value {
    let ocultar: serde_json::Map<String, Value> =
        GROUPS.iter().map(|(k, _, _, def)| (k.to_string(), Value::Bool(*def))).collect();
    json!({
        "ocultar": ocultar,
        "dnd": { "ligado": false, "inicio": "22:00", "fim": "08:00", "dias": [0, 1, 2, 3, 4, 5, 6] },
        "aparencia": { "opacidade": 1.0, "escala": 1.0, "compacto": false },
        "uso": { "mostrar": true }
    })
}

/// Copia os valores de "over" por cima de "base", só nas chaves que "base" conhece.
fn merge(base: &mut Value, over: &Value) {
    match (base, over) {
        (Value::Object(b), Value::Object(o)) => {
            for (k, v) in b.iter_mut() {
                if let Some(ov) = o.get(k) {
                    merge(v, ov);
                }
            }
        }
        (b, o) if std::mem::discriminant(b) == std::mem::discriminant(o) || (b.is_number() && o.is_number()) => {
            *b = o.clone()
        }
        _ => {}
    }
}

fn load_cfg(app: &AppHandle) -> Value {
    let mut cfg = default_cfg();
    let path = config_path(app, "config.json");
    if let Some(v) = std::fs::read_to_string(&path).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) {
        merge(&mut cfg, &v);
    } else {
        // versão 0.6: ocultar.json só com as marcas
        let old = config_path(app, "ocultar.json");
        if let Some(v) = std::fs::read_to_string(&old).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) {
            merge(&mut cfg, &json!({ "ocultar": v }));
        }
        save_cfg(app, &cfg);
        let _ = std::fs::remove_file(old);
    }
    cfg
}

fn save_cfg(app: &AppHandle, cfg: &Value) {
    let path = config_path(app, "config.json");
    if let Some(d) = path.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    let _ = std::fs::write(path, serde_json::to_string_pretty(cfg).unwrap_or_default());
}

/// Tudo que a janela de configurações precisa: valores, rótulos dos grupos e último uso.
#[tauri::command]
fn get_config(state: tauri::State<Arc<Shared>>) -> Value {
    let grupos: Vec<Value> = GROUPS.iter().map(|(k, label, _, _)| json!({ "chave": k, "rotulo": label })).collect();
    json!({
        "cfg": state.cfg.lock().unwrap().clone(),
        "grupos": grupos,
        "uso": state.usage.lock().unwrap().clone(),
    })
}

/// Grava a config nova e aplica: tamanho da janela, aviso para a ilha.
#[tauri::command]
fn set_config(app: AppHandle, state: tauri::State<Arc<Shared>>, cfg: Value) {
    let shared = state.inner().clone();
    let mut full = default_cfg();
    merge(&mut full, &cfg);
    let old_scale = scale_of(&shared.cfg.lock().unwrap());
    *shared.cfg.lock().unwrap() = full.clone();
    save_cfg(&app, &full);
    let _ = app.emit("island-config", full.clone());
    let new_scale = scale_of(&full);
    if (new_scale - old_scale).abs() > 0.001 {
        if let Some(win) = app.get_webview_window("main") {
            let _ = win.set_size(LogicalSize::new(WIN_W * new_scale, WIN_H * new_scale));
            let anchor = shared.anchor.lock().unwrap().clone();
            if let Ok(Some(m)) = win.current_monitor() {
                apply_anchor(&win, &shared, &m, &anchor, false);
            }
        }
    }
    write_log("[config] salva");
}

#[tauri::command]
fn open_extras(app: AppHandle) {
    let path = config_path(&app, "apps-extras.txt");
    extra_apps(&path); // cria o modelo se faltar
    let _ = std::process::Command::new("notepad.exe").arg(&path).spawn();
}

fn open_settings(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("settings") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let app = app.clone();
    thread::spawn(move || {
        let r = tauri::WebviewWindowBuilder::new(&app, "settings", tauri::WebviewUrl::App("settings.html".into()))
            .title("Claude Island")
            .inner_size(480.0, 680.0)
            .min_inner_size(400.0, 480.0)
            .center()
            .build();
        if let Err(e) = r {
            write_log(&format!("[config] janela falhou: {e}"));
        }
    });
}

#[tauri::command]
fn get_anchor(state: tauri::State<Arc<Shared>>) -> String {
    state.anchor.lock().unwrap().clone()
}

#[tauri::command]
fn drag_start(win: WebviewWindow, state: tauri::State<Arc<Shared>>) {
    state.move_gen.fetch_add(1, Ordering::SeqCst);
    write_log("[drag] start");
    if let (Ok(c), Ok(p)) = (win.cursor_position(), win.outer_position()) {
        *state.drag.lock().unwrap() = Some((c.x, c.y, p.x, p.y));
    }
}

/// Soltou: escolhe o canto mais perto do centro da ilha, no monitor onde ela está.
#[tauri::command]
fn drag_end(win: WebviewWindow, state: tauri::State<Arc<Shared>>) {
    if state.drag.lock().unwrap().take().is_none() {
        return;
    }
    let shared = state.inner().clone();
    let (Ok(p), Ok(s)) = (win.outer_position(), win.scale_factor()) else { return };
    let (x, y, w, h) = *shared.hit.lock().unwrap();
    let cx = p.x as f64 + (x + w / 2.0) * s;
    let cy = p.y as f64 + (y + h / 2.0) * s;
    let Some(mon) = monitor_at(&win, cx, cy) else { return };
    let wa = mon.work_area();
    let (ax, aw) = (wa.position.x as f64, wa.size.width as f64);
    let (ay, ah) = (wa.position.y as f64, wa.size.height as f64);
    let col = if cx < ax + aw / 3.0 { 'l' } else if cx > ax + aw * 2.0 / 3.0 { 'r' } else { 'c' };
    // nas laterais, o terço do meio da altura encaixa no meio da borda
    let row = if col != 'c' && cy >= ay + ah / 3.0 && cy <= ay + ah * 2.0 / 3.0 {
        'm'
    } else if cy > ay + ah / 2.0 {
        'b'
    } else {
        't'
    };
    write_log(&format!("[drag] fim, canto {row}{col}"));
    apply_anchor(&win, &shared, &mon, &format!("{row}{col}"), true);
}

/// Posição da ilha dentro da janela para um canto (px lógicos). Mesma conta do island.js.
fn island_offset(anchor: &str, w: f64, h: f64, dims: (f64, f64)) -> (f64, f64) {
    let (ww, wh) = dims;
    let pad = PAD * ww / WIN_W;
    let x = match anchor.as_bytes().get(1) {
        Some(b'l') => pad,
        Some(b'r') => ww - w - pad,
        _ => (ww - w) / 2.0,
    };
    let y = match anchor.as_bytes().first() {
        Some(b'b') => wh - h - pad,
        Some(b'm') => (wh - h) / 2.0,
        _ => pad,
    };
    (x, y)
}

fn target_pos(mon: &Monitor, anchor: &str, dims: (f64, f64)) -> PhysicalPosition<i32> {
    let wa = mon.work_area();
    let s = mon.scale_factor();
    let (ww, wh) = ((dims.0 * s).round() as i32, (dims.1 * s).round() as i32);
    let (ax, ay) = (wa.position.x, wa.position.y);
    let (aw, ah) = (wa.size.width as i32, wa.size.height as i32);
    let x = match anchor.as_bytes().get(1) {
        Some(b'l') => ax,
        Some(b'r') => ax + aw - ww,
        _ => ax + (aw - ww) / 2,
    };
    let y = match anchor.as_bytes().first() {
        Some(b'b') => ay + ah - wh,
        Some(b'm') => ay + (ah - wh) / 2,
        _ => ay,
    };
    PhysicalPosition::new(x, y)
}

fn monitor_at(win: &WebviewWindow, x: f64, y: f64) -> Option<Monitor> {
    let mons = win.available_monitors().ok()?;
    mons.into_iter()
        .find(|m| {
            let (p, s) = (m.position(), m.size());
            x >= p.x as f64
                && x < (p.x + s.width as i32) as f64
                && y >= p.y as f64
                && y < (p.y + s.height as i32) as f64
        })
        .or_else(|| win.primary_monitor().ok().flatten())
}

/// Troca o canto. Primeiro compensa a janela para a ilha não pular quando o
/// alinhamento interno muda; depois desliza até o canto (ease-out, 260 ms).
fn apply_anchor(win: &WebviewWindow, shared: &Arc<Shared>, mon: &Monitor, anchor: &str, animate: bool) {
    let (x, y, w, h) = *shared.hit.lock().unwrap();
    let dims = win_dims(shared);
    let (ox, oy) = island_offset(anchor, w, h, dims);
    *shared.hit.lock().unwrap() = (ox, oy, w, h);
    *shared.anchor.lock().unwrap() = anchor.to_string();
    let _ = win.emit("island-anchor", anchor);
    save_anchor(win.app_handle(), anchor, mon);

    let to = target_pos(mon, anchor, dims);
    let gen = shared.move_gen.fetch_add(1, Ordering::SeqCst) + 1;
    let (Ok(p), Ok(s), true) = (win.outer_position(), win.scale_factor(), animate) else {
        let _ = win.set_position(to);
        return;
    };
    let from = (p.x as f64 + (x - ox) * s, p.y as f64 + (y - oy) * s);
    let _ = win.set_position(PhysicalPosition::new(from.0.round() as i32, from.1.round() as i32));
    let (win, shared) = (win.clone(), shared.clone());
    thread::spawn(move || {
        let t0 = Instant::now();
        loop {
            if shared.move_gen.load(Ordering::SeqCst) != gen {
                return;
            }
            let t = (t0.elapsed().as_secs_f64() * 1000.0 / 260.0).min(1.0);
            let e = 1.0 - (1.0 - t).powi(3);
            let nx = from.0 + (to.x as f64 - from.0) * e;
            let ny = from.1 + (to.y as f64 - from.1) * e;
            let _ = win.set_position(PhysicalPosition::new(nx.round() as i32, ny.round() as i32));
            if t >= 1.0 {
                return;
            }
            thread::sleep(Duration::from_millis(8));
        }
    });
}

fn anchor_file(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("posicao.txt"))
}

fn save_anchor(app: &AppHandle, anchor: &str, mon: &Monitor) {
    if let Some(f) = anchor_file(app) {
        let _ = std::fs::create_dir_all(f.parent().unwrap());
        let name = mon.name().cloned().unwrap_or_default();
        let _ = std::fs::write(f, format!("{anchor}\n{name}\n"));
    }
}

/// Canto e nome do monitor salvos; sem arquivo, topo central.
fn load_anchor(app: &AppHandle) -> (String, String) {
    let txt = anchor_file(app).and_then(|f| std::fs::read_to_string(f).ok()).unwrap_or_default();
    let mut lines = txt.lines();
    let a = lines.next().unwrap_or("").trim().to_string();
    let m = lines.next().unwrap_or("").trim().to_string();
    if ANCHORS.contains(&a.as_str()) { (a, m) } else { ("tc".into(), m) }
}

fn serve(app: tauri::AppHandle, shared: Arc<Shared>, server: Server) {
    for mut req in server.incoming_requests() {
        let app = app.clone();
        let shared = shared.clone();
        thread::spawn(move || {
            // Só os scripts locais (hook e statusline) falam com a ilha. Navegador manda
            // Origin em todo POST: recusa, para um site não conseguir mostrar pedidos falsos.
            // Exigir JSON também força o preflight CORS, que este servidor não responde.
            let header = |name: &'static str| {
                req.headers().iter().find(|h| h.field.equiv(name)).map(|h| h.value.as_str().to_string())
            };
            let json_body = header("Content-Type").map(|v| v.starts_with("application/json")).unwrap_or(false);
            if header("Origin").is_some() || !json_body {
                let _ = req.respond(Response::empty(403));
                return;
            }
            if req.body_length().unwrap_or(0) > MAX_BODY {
                let _ = req.respond(Response::empty(413));
                return;
            }
            if req.method() == &Method::Post && req.url() == "/status" {
                let mut body = String::new();
                let _ = req.as_reader().read_to_string(&mut body);
                if let Ok(v) = serde_json::from_str::<Value>(&body) {
                    let usage = json!({ "rate_limits": v["rate_limits"].clone(), "model": v["model"]["display_name"].clone() });
                    *shared.usage.lock().unwrap() = usage.clone();
                    let _ = app.emit("island-usage", usage);
                }
                let _ = req.respond(Response::empty(204));
                return;
            }
            if req.method() != &Method::Post || req.url() != "/event" {
                let _ = req.respond(Response::empty(404));
                return;
            }
            let mut body = String::new();
            if req.as_reader().read_to_string(&mut body).is_err() {
                let _ = req.respond(Response::empty(400));
                return;
            }
            let mut v: serde_json::Value = match serde_json::from_str(&body) {
                Ok(v) => v,
                Err(_) => {
                    let _ = req.respond(Response::empty(400));
                    return;
                }
            };

            let event = v["hook_event_name"].as_str().unwrap_or("");
            let tool = v["tool_name"].as_str().unwrap_or("");
            // AskUserQuestion e ExitPlanMode precisam de resposta própria: só mostra.
            let wait = event == "PermissionRequest" && tool != "AskUserQuestion" && tool != "ExitPlanMode";
            if !wait {
                let _ = app.emit("island-event", v);
                let _ = req.respond(Response::empty(204));
                return;
            }

            let id = {
                let mut n = shared.next_id.lock().unwrap();
                *n += 1;
                *n
            };
            let (tx, rx) = mpsc::channel();
            shared.pending.lock().unwrap().insert(id, tx);
            v["island_id"] = id.into();
            let _ = app.emit("island-event", v);

            let answer = rx.recv_timeout(PERM_WAIT);
            shared.pending.lock().unwrap().remove(&id);
            match answer {
                Ok(allow) => {
                    let decision = if allow {
                        json!({ "behavior": "allow" })
                    } else {
                        json!({ "behavior": "deny", "message": "O usuário negou pela Claude Island." })
                    };
                    let out = json!({
                        "hookSpecificOutput": { "hookEventName": "PermissionRequest", "decision": decision }
                    });
                    let header: Header = "Content-Type: application/json".parse().unwrap();
                    let _ = req.respond(Response::from_string(out.to_string()).with_header(header));
                }
                Err(_) => {
                    let _ = app.emit("island-expire", id);
                    let _ = req.respond(Response::empty(204));
                }
            }
        });
    }
}

/// A janela é maior que a ilha. Fora da ilha, os cliques passam para o que está atrás.
fn hit_loop(win: WebviewWindow, shared: Arc<Shared>) {
    let mut ignoring: Option<bool> = None;
    loop {
        let drag = *shared.drag.lock().unwrap();
        thread::sleep(Duration::from_millis(if drag.is_some() { 8 } else { 40 }));
        let (Ok(c), Ok(p), Ok(s)) = (win.cursor_position(), win.inner_position(), win.scale_factor()) else {
            continue;
        };
        // arrastando: a janela segue o cursor e continua recebendo o mouse
        if let Some((cx, cy, wx, wy)) = drag {
            let nx = wx + (c.x - cx).round() as i32;
            let ny = wy + (c.y - cy).round() as i32;
            let _ = win.set_position(PhysicalPosition::new(nx, ny));
            if ignoring != Some(false) {
                let _ = win.set_ignore_cursor_events(false);
                ignoring = Some(false);
            }
            continue;
        }
        let (x, y, w, h) = *shared.hit.lock().unwrap();
        let lx = (c.x - p.x as f64) / s;
        let ly = (c.y - p.y as f64) / s;
        let inside = !shared.hidden.load(Ordering::SeqCst)
            && w > 0.0 && lx >= x && lx <= x + w && ly >= y && ly <= y + h;
        let ignore = !inside;
        if ignoring != Some(ignore) {
            #[cfg(debug_assertions)]
            eprintln!("[hit] cursor=({lx:.0},{ly:.0}) rect=({x:.0},{y:.0},{w:.0},{h:.0}) inside={inside}");
            let _ = win.set_ignore_cursor_events(ignore);
            let _ = win.emit("island-hover", inside);
            ignoring = Some(ignore);
        }
    }
}

/// O que esconde a ilha: (chave, rótulo no menu, .exe que contam, ligado por padrão).
/// "telacheia" e "extras" não têm .exe fixo: tela cheia é detectada à parte, e a lista
/// extra vem de apps-extras.txt.
const GROUPS: &[(&str, &str, &[&str], bool)] = &[
    ("navegador", "Reunião no navegador (Meet etc.)", &["chrome.exe", "msedge.exe", "firefox.exe", "brave.exe", "opera.exe", "vivaldi.exe", "arc.exe"], true),
    ("teams", "Microsoft Teams", &["ms-teams.exe", "teams.exe"], true),
    ("zoom", "Zoom", &["zoom.exe"], true),
    ("whatsapp", "WhatsApp", &["whatsapp.exe", "whatsapp.root.exe"], true),
    ("slack", "Slack", &["slack.exe"], true),
    ("webex", "Webex e Skype", &["webex.exe", "ciscocollabhost.exe", "skype.exe"], true),
    ("granola", "Granola", &["granola.exe"], true),
    ("telegram", "Telegram", &["telegram.exe"], false),
    ("discord", "Discord (chamada de voz)", &["discord.exe", "discordptb.exe", "discordcanary.exe"], false),
    ("telacheia", "Jogo ou app em tela cheia", &[], false),
    ("extras", "Apps da lista extra", &[], true),
];

const EXTRA_APPS: &str = "# Lista extra: a ilha some quando um destes .exe usa o microfone.
# Um nome por linha (ex.: steam.exe). Linhas com # são ignoradas.
# Vale ao salvar. Liga/desliga no menu da bandeja, \"Apps da lista extra\".
# O nome de um app que usou o microfone aparece no log: %TEMP%\\claude-island.log
";

fn config_path(app: &AppHandle, name: &str) -> std::path::PathBuf {
    app.path().app_config_dir().unwrap_or_else(|_| std::env::temp_dir()).join(name)
}

/// Lê apps-extras.txt (cria o modelo se não existir). Nomes em minúsculo.
fn extra_apps(path: &std::path::Path) -> Vec<String> {
    if !path.exists() {
        if let Some(d) = path.parent() {
            let _ = std::fs::create_dir_all(d);
        }
        let _ = std::fs::write(path, EXTRA_APPS);
    }
    std::fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .map(|l| l.trim().to_lowercase())
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .collect()
}

/// A janela da frente ocupa o monitor inteiro (jogo, vídeo em tela cheia, apresentação)?
/// Janela maximizada não conta. Devolve o .exe dela.
fn fullscreen_app(own: isize) -> Option<String> {
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

/// Nome do .exe de um processo, em minúsculo.
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
        let full = String::from_utf16_lossy(&buf[..len as usize]);
        full.rsplit('\\').next().map(|n| n.to_lowercase())
    }
}

/// Quais apps estão captando o microfone agora? Pergunta ao áudio do Windows (WASAPI):
/// em cada microfone ativo, pega as sessões de captura "ativas" e o processo de cada uma.
/// (O registro ConsentStore parou de ser atualizado no Windows 11 recente.)
fn mic_users() -> Vec<String> {
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

/// "22:30" -> minutos desde a meia-noite.
fn hhmm(v: &Value) -> Option<u32> {
    let (h, m) = v.as_str()?.split_once(':')?;
    let (h, m): (u32, u32) = (h.trim().parse().ok()?, m.trim().parse().ok()?);
    (h < 24 && m < 60).then_some(h * 60 + m)
}

/// Horário de não perturbe agora? Dias: 0 = domingo. Faixa que passa da meia-noite
/// (22:00 às 08:00) conta para o dia em que começou.
fn dnd_active(dnd: &Value) -> bool {
    if !dnd["ligado"].as_bool().unwrap_or(false) {
        return false;
    }
    let (Some(a), Some(b)) = (hhmm(&dnd["inicio"]), hhmm(&dnd["fim"])) else { return false };
    let t = unsafe { windows::Win32::System::SystemInformation::GetLocalTime() };
    let now = t.wHour as u32 * 60 + t.wMinute as u32;
    let today = t.wDayOfWeek as u64;
    let days: Vec<u64> = dnd["dias"].as_array().map(|d| d.iter().filter_map(|x| x.as_u64()).collect()).unwrap_or_default();
    let (inside, day) = if a == b {
        (false, today)
    } else if a < b {
        (now >= a && now < b, today)
    } else if now >= a {
        (true, today)
    } else {
        (now < b, (today + 6) % 7)
    };
    inside && days.contains(&day)
}

/// Some quando algo marcado no menu acontece (app da lista no microfone ou tela cheia);
/// volta 3 s depois que passa. As opções vêm de Shared.hide_opts.
fn meeting_loop(win: WebviewWindow, shared: Arc<Shared>) {
    let extra_path = config_path(win.app_handle(), "apps-extras.txt");
    let own = win.hwnd().map(|h| h.0 as isize).unwrap_or(0);
    let mut free_since: Option<Instant> = None;
    let mut last_users: Vec<String> = Vec::new();
    loop {
        thread::sleep(Duration::from_millis(1500));
        let cfg = shared.cfg.lock().unwrap().clone();
        let on = |k: &str| cfg["ocultar"][k].as_bool().unwrap_or(false);
        let mut wanted: Vec<String> = GROUPS
            .iter()
            .filter(|g| on(g.0))
            .flat_map(|g| g.2.iter().map(|x| x.to_string()))
            .collect();
        if on("extras") {
            wanted.extend(extra_apps(&extra_path));
        }
        let users = if wanted.is_empty() { Vec::new() } else { mic_users() };
        if users != last_users {
            if !users.is_empty() {
                let desc: Vec<String> = users
                    .iter()
                    .map(|u| if wanted.contains(u) { u.clone() } else { format!("{u} (fora da lista)") })
                    .collect();
                write_log(&format!("[ocultar] no microfone: {}", desc.join(", ")));
            }
            last_users = users.clone();
        }
        let mut reason = dnd_active(&cfg["dnd"]).then(|| "não perturbe".to_string());
        if reason.is_none() {
            reason = users.iter().find(|u| wanted.contains(u)).map(|u| format!("{u} no microfone"));
        }
        if reason.is_none() && on("telacheia") {
            reason = fullscreen_app(own).map(|a| format!("{a} em tela cheia"));
        }
        let hidden = shared.hidden.load(Ordering::SeqCst);
        let next = if reason.is_some() {
            free_since = None;
            true
        } else if hidden {
            let t = *free_since.get_or_insert_with(Instant::now);
            t.elapsed() < Duration::from_secs(3)
        } else {
            false
        };
        if next != hidden {
            shared.hidden.store(next, Ordering::SeqCst);
            match &reason {
                Some(r) if next => write_log(&format!("[ocultar] escondendo: {r}")),
                _ => write_log("[ocultar] livre, mostrando"),
            }
            let _ = win.emit("island-meeting", next);
        }
    }
}

fn main() {
    // Instância única: quem consegue a porta é a ilha. Se outra já roda
    // (aberta pelo Agendador ou à mão), esta sai sem abrir janela.
    let server = match Server::http(("127.0.0.1", PORT)) {
        Ok(s) => s,
        Err(_) => return,
    };
    let shared = Arc::new(Shared::default());
    let _ = std::fs::remove_file(std::env::temp_dir().join("claude-island.log"));

    tauri::Builder::default()
        .manage(shared.clone())
        .invoke_handler(tauri::generate_handler![decide, set_hit_rect, log, get_anchor, drag_start, drag_end, get_config, set_config, open_extras])
        .setup(move |app| {
            let win = app.get_webview_window("main").expect("janela main");

            // configurações e escala antes de posicionar
            let cfg = load_cfg(app.handle());
            let sc = scale_of(&cfg);
            *shared.cfg.lock().unwrap() = cfg;
            let _ = win.set_size(LogicalSize::new(WIN_W * sc, WIN_H * sc));

            // último canto salvo (padrão: topo central do monitor principal)
            let (anchor, mon_name) = load_anchor(app.handle());
            let mon = win
                .available_monitors()
                .ok()
                .and_then(|ms| ms.into_iter().find(|m| m.name().map(|n| n == &mon_name).unwrap_or(false)))
                .or_else(|| win.primary_monitor().ok().flatten());
            if let Some(m) = mon {
                let _ = win.set_position(target_pos(&m, &anchor, win_dims(&shared)));
            }
            *shared.anchor.lock().unwrap() = anchor;
            let _ = win.set_ignore_cursor_events(true);

            let home = MenuItem::with_id(app, "home", "Voltar ao topo", true, None::<&str>)?;
            let settings = MenuItem::with_id(app, "settings", "Configurações…", true, None::<&str>)?;
            let sep = PredefinedMenuItem::separator(app)?;
            let quit = MenuItem::with_id(app, "quit", "Sair", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&settings, &home, &sep, &quit])?;
            let (win_t, sh_t) = (win.clone(), shared.clone());
            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Claude Island")
                .show_menu_on_left_click(false)
                .on_tray_icon_event(|tray, e| {
                    if let tauri::tray::TrayIconEvent::Click {
                        button: tauri::tray::MouseButton::Left,
                        button_state: tauri::tray::MouseButtonState::Up,
                        ..
                    } = e
                    {
                        open_settings(tray.app_handle());
                    }
                })
                .menu(&menu)
                .on_menu_event(move |app, e| match e.id().as_ref() {
                    "quit" => app.exit(0),
                    "settings" => open_settings(app),
                    "home" => {
                        if let Ok(Some(m)) = win_t.primary_monitor() {
                            apply_anchor(&win_t, &sh_t, &m, "tc", true);
                        }
                    }
                    _ => {}
                })
                .build(app)?;

            let handle = app.handle().clone();
            let s1 = shared.clone();
            thread::spawn(move || serve(handle, s1, server));
            let (s3, w3) = (shared.clone(), win.clone());
            thread::spawn(move || meeting_loop(w3, s3));
            let s2 = shared.clone();
            thread::spawn(move || hit_loop(win, s2));
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("erro ao iniciar a Claude Island");
}
