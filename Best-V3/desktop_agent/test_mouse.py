"""MYRAA Mouse Diagnostic Test v3 — Win32 SendInput with proper normalization."""
import time
import ctypes

# Set DPI awareness FIRST (same as main.py)
try:
    ctypes.windll.shcore.SetProcessDpiAwareness(2)
except Exception:
    try:
        ctypes.windll.user32.SetProcessDPIAware()
    except Exception:
        pass

u32 = ctypes.windll.user32

# Constants
MOVE       = 0x0001
LEFTDOWN   = 0x0002
LEFTUP     = 0x0004
RIGHTDOWN  = 0x0008
RIGHTUP    = 0x0010
WHEEL      = 0x0800
ABSOLUTE   = 0x8000
INPUT_MOUSE = 0

class MOUSEINPUT(ctypes.Structure):
    _fields_ = [
        ("dx", ctypes.c_long), ("dy", ctypes.c_long),
        ("mouseData", ctypes.c_ulong), ("dwFlags", ctypes.c_ulong),
        ("time", ctypes.c_ulong), ("dwExtraInfo", ctypes.POINTER(ctypes.c_ulong)),
    ]
class INPUT(ctypes.Structure):
    class _U(ctypes.Union):
        _fields_ = [("mi", MOUSEINPUT)]
    _anonymous_ = ("_u",)
    _fields_ = [("type", ctypes.c_ulong), ("_u", _U)]

def send_mouse(dx, dy, flags, data=0):
    inp = INPUT(type=INPUT_MOUSE)
    inp.mi = MOUSEINPUT(dx=dx, dy=dy, mouseData=data, dwFlags=flags, time=0,
                        dwExtraInfo=ctypes.pointer(ctypes.c_ulong(0)))
    u32.SendInput(1, ctypes.byref(inp), ctypes.sizeof(INPUT))

def pixel_to_abs(x, y):
    """Convert pixel coords to 0-65535 absolute coords."""
    vx = u32.GetSystemMetrics(76)
    vy = u32.GetSystemMetrics(77)
    vw = u32.GetSystemMetrics(78)
    vh = u32.GetSystemMetrics(79)
    px = max(vx, min(vx + vw - 1, x))
    py = max(vy, min(vy + vh - 1, y))
    ax = int((px - vx) * 65535 / max(vw - 1, 1))
    ay = int((py - vy) * 65535 / max(vh - 1, 1))
    return ax, ay

def move(x, y):
    ax, ay = pixel_to_abs(x, y)
    send_mouse(ax, ay, MOVE | ABSOLUTE)

def click():
    send_mouse(0, 0, LEFTDOWN); time.sleep(0.02); send_mouse(0, 0, LEFTUP)

def right_click():
    send_mouse(0, 0, RIGHTDOWN); time.sleep(0.02); send_mouse(0, 0, RIGHTUP)

def scroll(amount):
    send_mouse(0, 0, WHEEL, -amount * 120)

def get_pos():
    class P(ctypes.Structure):
        _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]
    p = P(); u32.GetCursorPos(ctypes.byref(p)); return p.x, p.y

w = u32.GetSystemMetrics(0)
h = u32.GetSystemMetrics(1)
print(f"Screen: {w}x{h}")
print(f"Virtual: {u32.GetSystemMetrics(78)}x{u32.GetSystemMetrics(79)}")
print(f"Virtual origin: ({u32.GetSystemMetrics(76)}, {u32.GetSystemMetrics(77)})")

cx, cy = w//2, h//2

print("\n[1] Move to center...")
move(cx, cy); time.sleep(0.3)
ax, ay = get_pos()
print(f"    Target ({cx},{cy}) -> Actual ({ax},{ay}) {'OK' if abs(ax-cx)<=5 and abs(ay-cy)<=5 else 'FAIL'}")

print("[2] Left click...")
click(); time.sleep(0.2)
ax2, ay2 = get_pos()
print(f"    After click ({ax2},{ay2}) {'OK' if abs(ax2-cx)<=10 and abs(ay2-cy)<=10 else 'FAIL'}")

print("[3] Right click...")
right_click(); time.sleep(0.5)
print("    Done (close context menu if appeared)")

print("[4] Scroll down 5 clicks...")
scroll(5); time.sleep(0.5)
print("    Done")

print("[5] Drag test (100px right)...")
sx = cx - 50
move(sx, cy); time.sleep(0.2)
send_mouse(0, 0, LEFTDOWN); time.sleep(0.05)
for i in range(1, 11):
    move(sx + i*10, cy); time.sleep(0.02)
time.sleep(0.05)
send_mouse(0, 0, LEFTUP); time.sleep(0.2)
fx, fy = get_pos()
print(f"    Start ({sx},{cy}) -> End ({fx},{fy}) {'OK' if abs(fx-sx-100)<=20 else 'FAIL'}")

print("\nDONE — if all say OK, mouse is working perfectly!")
