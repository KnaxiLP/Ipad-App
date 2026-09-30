"""
Fokus-Modus für das Surface (Windows)
=====================================
Läuft unsichtbar im Hintergrund und schließt jedes Fenster, das nicht zu einem
erlaubten Programm gehört. Erlaubt sind nur Chrome (darin läuft die Test-App), Teams
und die Teile von Windows, die man zum Bedienen braucht (Taskleiste, Bildschirmtastatur …).

Beenden:  Strg + Alt + Umschalt + Q   (oder im Task-Manager "pythonw" beenden)
Protokoll: fokus-log.txt im selben Ordner

Das ist eine Notlösung, keine echte Sperre: Abmelden, Task-Manager oder ein anderes
Benutzerkonto umgehen sie. Nur Python-Bordmittel, keine Zusatzpakete nötig.
"""

import os
import subprocess
import sys
import time

# ---------------------------------------------------------------------------
# Einstellungen
# ---------------------------------------------------------------------------

# Programme, die offen bleiben dürfen (Dateiname der .exe, klein geschrieben)
ALLOWED = {
    "chrome.exe",          # Google Chrome – darin läuft auch die installierte Test-App
    "ms-teams.exe",        # neues Microsoft Teams
    "msteams.exe",         # neues Teams (andere Version)
    "teams.exe",           # altes ("klassisches") Teams
    "msedgewebview2.exe",  # Anzeige-Teil, den Teams für Fenster benutzt
    "python.exe",          # dieses Programm selbst
    "pythonw.exe",
    "py.exe",
}

# Teile von Windows, die nie angefasst werden (sonst lässt sich das Gerät nicht bedienen)
SYSTEM = {
    "explorer.exe",                  # Taskleiste und Desktop (Datei-Explorer-Fenster siehe unten)
    "textinputhost.exe",             # Bildschirmtastatur / Stift-Eingabe
    "tabtip.exe",                    # ältere Bildschirmtastatur
    "shellexperiencehost.exe",       # Info-Center, Uhr, Akku-Anzeige
    "startmenuexperiencehost.exe",   # Startmenü
    "searchhost.exe", "searchapp.exe",
    "lockapp.exe",                   # Sperrbildschirm
    "dwm.exe", "sihost.exe", "ctfmon.exe",
    "logonui.exe", "consent.exe",    # Anmeldung, Admin-Abfrage
    "systemsettingsbroker.exe",
    "shellhost.exe",                 # Schnelleinstellungen (WLAN, Lautstärke) unter Windows 11
    "widgets.exe",
}

# Datei-Explorer-Fenster (explorer.exe) trotzdem schließen?
CLOSE_FILE_EXPLORER = True

# Diese Prozesse werden höchstens gebeten zu schließen, aber nie hart beendet
# (explorer.exe ist auch die Taskleiste!)
NEVER_KILL = SYSTEM | {"explorer.exe"}

# Programme, die sich nicht schließen lassen, nach so vielen Sekunden hart beenden (0 = nie)
KILL_AFTER_SECONDS = 5

# Beim Start öffnen (leer lassen = nichts öffnen)
START_URLS = ["https://knaxilp.github.io/Ipad-App/"]

CHECK_EVERY_SECONDS = 0.7

LOG_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fokus-log.txt")


# ---------------------------------------------------------------------------
# Entscheidung: Fenster schließen oder nicht? (ohne Windows testbar)
# ---------------------------------------------------------------------------

def should_close(exe_name, window_class):
    """True, wenn ein Fenster dieses Programms geschlossen werden soll."""
    exe = (exe_name or "").lower()
    if not exe:
        return False                      # unbekannt (z. B. geschützter Systemprozess) → nicht anfassen
    if exe in ALLOWED:
        return False
    if exe == "explorer.exe":
        # Taskleiste/Desktop bleiben, nur echte Datei-Explorer-Fenster werden geschlossen
        return CLOSE_FILE_EXPLORER and window_class == "CabinetWClass"
    if exe in SYSTEM:
        return False
    return True


def log(text):
    line = time.strftime("%Y-%m-%d %H:%M:%S ") + text
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError:
        pass


# ---------------------------------------------------------------------------
# Windows-Teil
# ---------------------------------------------------------------------------

def run():
    import ctypes
    from ctypes import wintypes as wt

    user32 = ctypes.WinDLL("user32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

    WM_CLOSE = 0x0010
    WM_HOTKEY = 0x0312
    PM_REMOVE = 0x0001
    GWL_EXSTYLE = -20
    WS_EX_TOOLWINDOW = 0x00000080
    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    PROCESS_TERMINATE = 0x0001
    MOD_ALT, MOD_CONTROL, MOD_SHIFT, MOD_NOREPEAT = 0x1, 0x2, 0x4, 0x4000
    VK_Q = 0x51
    HOTKEY_ID = 1

    EnumWindowsProc = ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)
    user32.EnumWindows.argtypes = [EnumWindowsProc, wt.LPARAM]
    user32.IsWindowVisible.argtypes = [wt.HWND]
    user32.GetWindowTextLengthW.argtypes = [wt.HWND]
    user32.GetWindowTextW.argtypes = [wt.HWND, wt.LPWSTR, ctypes.c_int]
    user32.GetClassNameW.argtypes = [wt.HWND, wt.LPWSTR, ctypes.c_int]
    user32.GetWindowThreadProcessId.argtypes = [wt.HWND, ctypes.POINTER(wt.DWORD)]
    user32.GetWindowLongW.argtypes = [wt.HWND, ctypes.c_int]
    user32.PostMessageW.argtypes = [wt.HWND, wt.UINT, wt.WPARAM, wt.LPARAM]
    user32.IsWindow.argtypes = [wt.HWND]
    user32.RegisterHotKey.argtypes = [wt.HWND, ctypes.c_int, wt.UINT, wt.UINT]
    user32.PeekMessageW.argtypes = [ctypes.POINTER(wt.MSG), wt.HWND, wt.UINT, wt.UINT, wt.UINT]
    kernel32.OpenProcess.argtypes = [wt.DWORD, wt.BOOL, wt.DWORD]
    kernel32.OpenProcess.restype = wt.HANDLE
    kernel32.QueryFullProcessImageNameW.argtypes = [wt.HANDLE, wt.DWORD, wt.LPWSTR, ctypes.POINTER(wt.DWORD)]
    kernel32.TerminateProcess.argtypes = [wt.HANDLE, wt.UINT]
    kernel32.CloseHandle.argtypes = [wt.HANDLE]

    my_pid = os.getpid()

    def exe_of(pid):
        h = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if not h:
            return ""
        try:
            buf = ctypes.create_unicode_buffer(1024)
            size = wt.DWORD(len(buf))
            if kernel32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size)):
                return os.path.basename(buf.value)
            return ""
        finally:
            kernel32.CloseHandle(h)

    def kill(pid):
        h = kernel32.OpenProcess(PROCESS_TERMINATE, False, pid)
        if h:
            kernel32.TerminateProcess(h, 1)
            kernel32.CloseHandle(h)

    def windows():
        found = []

        def callback(hwnd, _):
            if not user32.IsWindowVisible(hwnd):
                return True
            if user32.GetWindowLongW(hwnd, GWL_EXSTYLE) & WS_EX_TOOLWINDOW:
                return True
            length = user32.GetWindowTextLengthW(hwnd)
            if length == 0:
                return True
            title = ctypes.create_unicode_buffer(length + 1)
            user32.GetWindowTextW(hwnd, title, length + 1)
            cls = ctypes.create_unicode_buffer(256)
            user32.GetClassNameW(hwnd, cls, 256)
            pid = wt.DWORD()
            user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
            found.append((hwnd, pid.value, title.value, cls.value))
            return True

        user32.EnumWindows(EnumWindowsProc(callback), 0)
        return found

    # Tastenkürzel zum Beenden
    if not user32.RegisterHotKey(None, HOTKEY_ID, MOD_CONTROL | MOD_ALT | MOD_SHIFT | MOD_NOREPEAT, VK_Q):
        log("Warnung: Tastenkürzel Strg+Alt+Umschalt+Q konnte nicht registriert werden")

    log("Fokus-Modus gestartet")
    for url in START_URLS:
        # "start chrome <url>" findet Chrome auch ohne festen Pfad
        subprocess.Popen(["cmd", "/c", "start", "", "chrome", url], shell=False, creationflags=0x08000000)  # ohne Konsolenfenster

    closing = {}   # hwnd -> (Zeitpunkt des ersten Schließversuchs, pid)
    msg = wt.MSG()
    while True:
        while user32.PeekMessageW(ctypes.byref(msg), None, 0, 0, PM_REMOVE):
            if msg.message == WM_HOTKEY and msg.wParam == HOTKEY_ID:
                log("Fokus-Modus beendet (Tastenkürzel)")
                return

        now = time.time()
        seen = set()
        for hwnd, pid, title, cls in windows():
            if pid == my_pid:
                continue
            exe = exe_of(pid)
            if not should_close(exe, cls):
                continue
            seen.add(hwnd)
            if hwnd not in closing:
                closing[hwnd] = (now, pid)
                user32.PostMessageW(hwnd, WM_CLOSE, 0, 0)
                log(f"geschlossen: {exe} – {title!r}")
            elif KILL_AFTER_SECONDS and now - closing[hwnd][0] > KILL_AFTER_SECONDS and exe.lower() not in NEVER_KILL:
                kill(pid)
                log(f"hart beendet: {exe} – {title!r}")
                closing[hwnd] = (now, pid)

        # vergessen, was inzwischen zu ist
        for hwnd in list(closing):
            if hwnd not in seen or not user32.IsWindow(hwnd):
                del closing[hwnd]

        time.sleep(CHECK_EVERY_SECONDS)


if __name__ == "__main__":
    if sys.platform != "win32":
        print("Dieses Programm läuft nur unter Windows.")
        sys.exit(1)
    try:
        run()
    except Exception as e:  # nie still abstürzen – Fehler ins Protokoll
        log(f"Fehler: {e!r}")
        raise
