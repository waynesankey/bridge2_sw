import time
import uasyncio as asyncio
import network
import ubinascii
import uhashlib
import json
import machine
import socket
import gc
import os
from machine import UART, Pin

from config import (
    WIFI_MODE,
    WIFI_SSID,
    WIFI_PASSWORD,
    WIFI_AP_SSID,
    WIFI_AP_PASSWORD,
    WIFI_HOSTNAME,
    WIFI_CONFIG_FILE,
    WIFI_CONNECT_TIMEOUT_MS,
    HTTP_HOST,
    HTTP_PORT,
    UART_ID,
    UART_BAUD,
    UART_BITS,
    UART_PARITY,
    UART_STOP,
    UART_TX_PIN,
    UART_RX_PIN,
    UART_POLL_MS,
    UART_STARTUP_SYNC_DELAY_MS
)

WS_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
DNS_PORT = 53

clients = set()
last_state_line = None
last_labels_line = None
last_amp_states_line = None
tube_lines = {}
tubes_end_seen = False
ap_setup_mode = False
ap_page_ssid = ""
uart_rx_buffer = ""
uart_last_rx_ms = 0
uart_tx_queue = []
uart_tx_event = None
uart_last_get_ms = {}
sta_status = "idle"
sta_ip = ""
sta_wlan = None
sta_task = None

GET_DEDUP_MS = 350
GET_DEDUP_COMMANDS = (
    "GET STATE",
    "GET SELECTOR_LABELS",
    "GET AMP_STATES",
    "GET TUBES",
)


WLAN_STAT_IDLE = getattr(network, "STAT_IDLE", 0)
WLAN_STAT_CONNECTING = getattr(network, "STAT_CONNECTING", 1)
WLAN_STAT_WRONG_PASSWORD = getattr(network, "STAT_WRONG_PASSWORD", -3)
WLAN_STAT_NO_AP_FOUND = getattr(network, "STAT_NO_AP_FOUND", -2)
WLAN_STAT_CONNECT_FAIL = getattr(network, "STAT_CONNECT_FAIL", -1)
WLAN_STAT_GOT_IP = getattr(network, "STAT_GOT_IP", 3)
WLAN_TERMINAL_FAIL_STATUSES = (
    WLAN_STAT_WRONG_PASSWORD,
    WLAN_STAT_NO_AP_FOUND,
    WLAN_STAT_CONNECT_FAIL,
)

AP_PAGE = """<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Preamp Bridge Setup</title>
    <style>
      body { font-family: Arial, sans-serif; background:#f6f1ea; margin:0; padding:24px; color:#2b241f; }
      .card { max-width:480px; margin:0 auto; background:#fffaf2; border:1px solid #e0d6c9; border-radius:16px; padding:20px; }
      h1 { margin:0 0 12px; }
      label { display:block; margin:14px 0 6px; font-weight:600; }
      input { width:100%; padding:10px 12px; border-radius:10px; border:1px solid #d8cbbb; font-size:1rem; }
      button { margin-top:16px; padding:10px 14px; border-radius:10px; border:none; background:#1a7a6f; color:#fff; font-weight:600; }
      .note { margin-top:12px; color:#6b5f55; font-size:0.9rem; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>Wi-Fi Setup</h1>
      <form method="post" action="/save">
        <label for="ssid">SSID</label>
        <input id="ssid" name="ssid" value="__SSID__" required />
        <label for="password">Password</label>
        <input id="password" name="password" type="password" />
        <button type="submit">Update & Connect</button>
      </form>
      <form method="post" action="/retry">
        <button type="submit">Try Existing Credentials</button>
      </form>
      <form method="post" action="/clear" onsubmit="return confirm('Clear saved Wi-Fi credentials?');">
        <button type="submit">Clear Credentials</button>
      </form>
      <div id="staStatus" class="note">Waiting for Wi‑Fi credentials.</div>
      <div id="staIp" class="note"></div>
    </div>
    <script>
      async function pollStatus() {
        try {
          const res = await fetch("/status");
          const text = (await res.text()).trim();
          if (!text) return;
          const parts = text.split(" ");
          const state = parts[0];
          const ip = parts[1] || "";
          const statusEl = document.getElementById("staStatus");
          const ipEl = document.getElementById("staIp");
          if (state === "CONNECTED") {
            statusEl.textContent = "Connected to Wi‑Fi.";
            ipEl.innerHTML = 'Open <a href="http://' + ip + '">' + ip + "</a>";
          } else if (state === "CONNECTING") {
            statusEl.textContent = "Connecting to Wi‑Fi...";
          } else if (state === "FAILED") {
            statusEl.textContent = "Failed to connect. Check SSID/password.";
          } else {
            statusEl.textContent = "Waiting for Wi‑Fi credentials.";
          }
        } catch (e) {}
      }
      setInterval(pollStatus, 1000);
      pollStatus();
    </script>
  </body>
</html>
"""


def log(*args):
    print("[bridge]", *args)


def init_status_led():
    try:
        return Pin("LED", Pin.OUT)
    except Exception:
        try:
            return Pin(25, Pin.OUT)
        except Exception:
            return None


async def led_heartbeat_task(led):
    if led is None:
        return
    state = 0
    while True:
        state ^= 1
        try:
            led.value(state)
        except Exception:
            pass
        await asyncio.sleep_ms(500)


def load_wifi_config():
    try:
        with open(WIFI_CONFIG_FILE, "r") as f:
            data = json.load(f)
        ssid = data.get("ssid")
        password = data.get("password")
        if ssid and password is not None:
            return {"ssid": ssid, "password": password}
    except (OSError, ValueError):
        return None
    return None


def save_wifi_config(ssid, password):
    data = {"ssid": ssid, "password": password}
    with open(WIFI_CONFIG_FILE, "w") as f:
        json.dump(data, f)


def start_ap():
    wlan = network.WLAN(network.AP_IF)
    wlan.active(True)
    wlan.config(essid=WIFI_AP_SSID, password=WIFI_AP_PASSWORD)
    time.sleep_ms(200)
    ip = wlan.ifconfig()[0]
    log("AP mode up:", WIFI_AP_SSID, "IP:", ip)
    return wlan


def reset_wifi_radios():
    # Ensure fresh STA/AP state after soft-reload or KeyboardInterrupt.
    try:
        ap = network.WLAN(network.AP_IF)
        ap.active(False)
    except Exception:
        pass
    try:
        sta = network.WLAN(network.STA_IF)
        try:
            sta.disconnect()
        except Exception:
            pass
        sta.active(False)
    except Exception:
        pass
    time.sleep_ms(120)


def wlan_status_safe(wlan):
    try:
        return wlan.status()
    except Exception:
        return None


def wlan_status_name(status):
    names = {
        WLAN_STAT_IDLE: "IDLE",
        WLAN_STAT_CONNECTING: "CONNECTING",
        WLAN_STAT_WRONG_PASSWORD: "WRONG_PASSWORD",
        WLAN_STAT_NO_AP_FOUND: "NO_AP_FOUND",
        WLAN_STAT_CONNECT_FAIL: "CONNECT_FAIL",
        WLAN_STAT_GOT_IP: "GOT_IP",
        None: "UNKNOWN",
    }
    return names.get(status, str(status))


def wlan_connect_state(wlan):
    if wlan is None:
        return "failed", None
    if wlan.isconnected():
        return "connected", WLAN_STAT_GOT_IP
    status = wlan_status_safe(wlan)
    if status == WLAN_STAT_GOT_IP:
        return "connected", status
    if status in WLAN_TERMINAL_FAIL_STATUSES:
        return "failed", status
    return "pending", status


def is_benign_socket_close(exc):
    if not isinstance(exc, OSError):
        return False
    if not exc.args:
        return False
    code = exc.args[0]
    return code in (32, 54, 104, 128)


def is_setup_mode_active():
    if not ap_setup_mode:
        return False
    try:
        ap = network.WLAN(network.AP_IF)
        return ap.active()
    except Exception:
        return ap_setup_mode


def wifi_connect(creds, force_ap):
    if force_ap or WIFI_MODE == "ap":
        return start_ap(), "ap", False

    wlan = start_sta_connect(creds)
    if wlan:
        t0 = time.ticks_ms()
        while True:
            state, status = wlan_connect_state(wlan)
            if state == "connected":
                ip = wlan.ifconfig()[0]
                log("Connected, IP:", ip)
                return wlan, "sta", True
            if time.ticks_diff(time.ticks_ms(), t0) > WIFI_CONNECT_TIMEOUT_MS:
                log("Wi-Fi connect timeout status=%s" % wlan_status_name(status))
                break
            time.sleep_ms(250)

    log("Wi-Fi not connected; check credentials")
    return wlan, "sta", False


def start_sta_connect(creds):
    global sta_wlan, sta_status
    wlan = network.WLAN(network.STA_IF)
    wlan.active(True)
    # Avoid multi-second latency spikes from CYW43 Wi-Fi power-save.
    try:
        pm_none = getattr(network, "PM_NONE", None)
        if pm_none is None:
            pm_none = getattr(wlan, "PM_NONE", None)
        if pm_none is None:
            pm_none = 0xA11140
        wlan.config(pm=pm_none)
    except Exception:
        pass
    try:
        network.hostname(WIFI_HOSTNAME)
    except Exception:
        pass
    try:
        wlan.config(hostname=WIFI_HOSTNAME)
    except Exception:
        pass
    try:
        if not wlan.isconnected():
            ssid = creds["ssid"]
            password = creds["password"]
            log("Connecting to Wi-Fi:", ssid)
            sta_status = "connecting"
            wlan.connect(ssid, password)
    except Exception:
        pass
    sta_wlan = wlan
    return wlan


async def sta_connect_task(creds):
    global sta_status, sta_ip, sta_wlan, sta_task, ap_setup_mode
    wlan = start_sta_connect(creds)
    if wlan is None:
        sta_status = "failed"
        sta_task = None
        return
    t0 = time.ticks_ms()
    while True:
        state, status = wlan_connect_state(wlan)
        if state == "connected":
            break
        if state == "failed":
            log("Wi-Fi connect failed (background) status=%s" % wlan_status_name(status))
            sta_status = "failed"
            sta_task = None
            return
        elapsed = time.ticks_diff(time.ticks_ms(), t0)
        if elapsed > WIFI_CONNECT_TIMEOUT_MS:
            log("Wi-Fi connect timeout (background) status=%s" % wlan_status_name(status))
            sta_status = "failed"
            sta_task = None
            return
        await asyncio.sleep_ms(250)
    sta_ip = wlan.ifconfig()[0]
    sta_status = "connected"
    sta_task = None
    ap_setup_mode = False
    log("Connected, IP:", sta_ip)
    try:
        ap = network.WLAN(network.AP_IF)
        was_active = False
        try:
            was_active = ap.active()
        except Exception:
            pass
        ap.active(False)
        if was_active:
            log("AP disabled after STA connect")
    except Exception:
        pass


def uart_init():
    uart = UART(
        UART_ID,
        baudrate=UART_BAUD,
        bits=UART_BITS,
        parity=UART_PARITY,
        stop=UART_STOP,
        tx=Pin(UART_TX_PIN),
        rx=Pin(UART_RX_PIN),
    )
    return uart


def uart_send(uart, line):
    global tube_lines, tubes_end_seen, uart_tx_event, uart_last_get_ms
    cmd = line.strip().upper()
    if cmd == "GET TUBES":
        tube_lines = {}
        tubes_end_seen = False
    text = line.strip()
    if not text:
        return

    if cmd in GET_DEDUP_COMMANDS:
        for queued in uart_tx_queue:
            if queued.upper() == cmd:
                return
        now = time.ticks_ms()
        last = uart_last_get_ms.get(cmd)
        if last is not None and time.ticks_diff(now, last) < GET_DEDUP_MS:
            return
        uart_last_get_ms[cmd] = now

    uart_tx_queue.append(text)
    if uart_tx_event is not None:
        try:
            uart_tx_event.set()
        except Exception:
            pass


async def uart_writer_task(uart):
    global uart_tx_event
    uart_tx_event = asyncio.Event()
    while True:
        if not uart_tx_queue:
            uart_tx_event.clear()
            await uart_tx_event.wait()
            continue
        line = uart_tx_queue.pop(0)
        try:
            uart.write((line + "\r\n").encode("utf-8"))
            log("UART ->", line)
        except Exception as exc:
            log("UART write error:", exc)
        # Pace line writes so receiver line readers do not get overrun.
        await asyncio.sleep_ms(2)


def parse_tube_num(line):
    for part in line.split():
        if part.startswith("NUM="):
            try:
                return int(part[4:])
            except Exception:
                return None
    return None


def parse_tube_fields(line):
    fields = {}
    for part in line.split():
        if "=" not in part:
            continue
        key, value = part.split("=", 1)
        fields[key] = value
    return fields


def has_valid_tube_metrics(line):
    fields = parse_tube_fields(line)
    for key in ("NUM", "MIN", "HOUR"):
        value = fields.get(key)
        if value is None or not value.isdigit():
            return False
    return True


def render_tubes_lines():
    nums = list(tube_lines.keys())
    nums.sort()
    lines = [tube_lines[num] for num in nums]
    if tubes_end_seen and lines:
        lines.append("END TUBES")
    return "\n".join(lines)


def ws_accept_key(key):
    raw = (key + WS_MAGIC).encode("utf-8")
    digest = uhashlib.sha1(raw).digest()
    return ubinascii.b2a_base64(digest).strip().decode("utf-8")


def parse_request_line(line):
    try:
        parts = line.decode().strip().split()
        if len(parts) < 2:
            return None, None
        raw_path = parts[1]
        path = raw_path.split("?", 1)[0].split("#", 1)[0]
        return parts[0], path
    except Exception:
        return None, None


async def read_exactly(reader, n):
    data = b""
    while len(data) < n:
        chunk = await reader.read(n - len(data))
        # On some MicroPython builds/read paths, `read()` may yield None
        # transiently; treat that as "no bytes yet", not a closed socket.
        if chunk is None:
            await asyncio.sleep_ms(0)
            continue
        if chunk == b"":
            raise OSError("socket closed")
        data += chunk
    return data


class WebSocket:
    def __init__(self, reader, writer):
        self.reader = reader
        self.writer = writer
        self.closed = False

    async def recv(self):
        try:
            header = await read_exactly(self.reader, 2)
        except Exception as exc:
            if not is_benign_socket_close(exc):
                log("WS recv header error:", exc)
            return None

        b1 = header[0]
        b2 = header[1]
        fin = (b1 >> 7) & 0x01
        opcode = b1 & 0x0F
        masked = b2 & 0x80
        length = b2 & 0x7F

        if length == 126:
            ext = await read_exactly(self.reader, 2)
            length = (ext[0] << 8) | ext[1]
        elif length == 127:
            ext = await read_exactly(self.reader, 8)
            length = 0
            for b in ext:
                length = (length << 8) | b

        mask = b""
        if masked:
            mask = await read_exactly(self.reader, 4)

        payload = await read_exactly(self.reader, length) if length else b""
        if masked and payload:
            payload = bytes(payload[i] ^ mask[i % 4] for i in range(len(payload)))

        if opcode == 8:
            if len(payload) >= 2:
                code = (payload[0] << 8) | payload[1]
                log("WS close from client, code=", code, "fin=", fin)
            else:
                log("WS close from client, fin=", fin)
            return None
        if opcode == 9:
            await self._send_frame(payload, opcode=10)
            return ""
        if opcode != 1:
            log("WS non-text frame opcode=", opcode, "len=", len(payload), "fin=", fin)
            return ""

        try:
            return payload.decode("utf-8")
        except Exception:
            return ""

    async def _send_frame(self, payload, opcode=1):
        if self.closed:
            return
        header = bytearray()
        header.append(0x80 | (opcode & 0x0F))
        length = len(payload)
        if length < 126:
            header.append(length)
        elif length < 65536:
            header.append(126)
            header.extend(bytearray([(length >> 8) & 0xFF, length & 0xFF]))
        else:
            header.append(127)
            for shift in (56, 48, 40, 32, 24, 16, 8, 0):
                header.append((length >> shift) & 0xFF)

        try:
            self.writer.write(header)
            if payload:
                self.writer.write(payload)
            await self.writer.drain()
        except Exception:
            self.closed = True

    async def send_text(self, text):
        await self._send_frame(text.encode("utf-8"), opcode=1)

    async def close(self):
        if self.closed:
            return
        self.closed = True
        try:
            await self._send_frame(b"", opcode=8)
        except Exception:
            pass
        try:
            await self.writer.wait_closed()
        except Exception:
            pass


async def broadcast(line):
    if not clients:
        return
    dead = []
    for ws in clients:
        try:
            await ws.send_text(line)
        except Exception:
            dead.append(ws)
    for ws in dead:
        clients.discard(ws)


def normalize_client_command(line):
    raw = line.strip()
    if not raw:
        return None

    upper = raw.upper()
    if (
        upper.startswith("GET ")
        or upper.startswith("SET ")
        or upper.startswith("ADD ")
        or upper.startswith("DEL ")
    ):
        return raw

    parts = raw.split()
    if len(parts) == 2:
        key = parts[0].upper()
        value = parts[1]
        if key in ("VOL", "BAL", "INP", "MUTE", "BRI", "STBY"):
            return "SET %s %s" % (key, value)

    return None


def handle_uart_line(line):
    global last_state_line, last_labels_line, last_amp_states_line, tubes_end_seen

    def strip_embedded_tubes_end(raw):
        if "END TUBES" in raw:
            return raw.replace("END TUBES", "").strip(), True
        if "TUBES_END" in raw:
            return raw.replace("TUBES_END", "").strip(), True
        return raw, False

    if line.startswith("STATE "):
        last_state_line = line
        return "state", [line]
    if line.startswith("SELECTOR_LABELS"):
        last_labels_line = line
        return "labels", [line]
    if line.startswith("AMP_STATES"):
        last_amp_states_line = line
        return "amp_states", [line]
    if line.startswith("TUBE "):
        clean_line, saw_end = strip_embedded_tubes_end(line)
        num = parse_tube_num(clean_line)
        is_valid = has_valid_tube_metrics(clean_line)
        out = []
        if num is not None and clean_line and is_valid:
            tube_lines[num] = clean_line
            out.append(clean_line)
        if saw_end:
            tubes_end_seen = True
            out.append("END TUBES")
        return "tube", out
    clean_line, saw_end = strip_embedded_tubes_end(line)
    if clean_line == "TUBES_END" or clean_line == "END TUBES" or saw_end:
        tubes_end_seen = True
        return "tubes_end", ["END TUBES"]
    return "other", [line]


def _next_uart_marker_index(text, start):
    markers = (
        "STATE ",
        "SELECTOR_LABELS",
        "AMP_STATES",
        "TUBE ",
        "ACK ",
        "DONE SAVE",
        "ERR ",
        "END TUBES",
        "TUBES_END",
    )
    found = -1
    for marker in markers:
        idx = text.find(marker, start)
        if idx >= 0 and (found < 0 or idx < found):
            found = idx
    return found


def extract_uart_frames(buffer, flush_incomplete=False):
    frames = []
    text = buffer.replace("\r", "\n")

    while True:
        text = text.lstrip("\n\t ")
        if not text:
            return frames, ""

        first = _next_uart_marker_index(text, 0)
        if first < 0:
            if flush_incomplete:
                line = text.strip()
                if line:
                    frames.append(line)
                return frames, ""
            return frames, text
        if first > 0:
            text = text[first:]

        next_marker = _next_uart_marker_index(text, 1)
        newline = text.find("\n", 1)
        cut = -1
        use_newline = False
        if newline >= 0 and (next_marker < 0 or newline < next_marker):
            cut = newline
            use_newline = True
        elif next_marker >= 0:
            cut = next_marker

        if cut < 0:
            if flush_incomplete:
                line = text.strip()
                if line:
                    frames.append(line)
                return frames, ""
            return frames, text

        line = text[:cut].strip()
        if line:
            frames.append(line)
        if use_newline:
            text = text[cut + 1:]
        else:
            text = text[cut:]


async def uart_reader_task(uart):
    global uart_rx_buffer, uart_last_rx_ms
    while True:
        if uart.any():
            raw = uart.read()
            if raw:
                if isinstance(raw, str):
                    raw = raw.encode("utf-8")
                try:
                    uart_rx_buffer += bytes(raw).decode("utf-8")
                except Exception:
                    uart_rx_buffer += bytes(raw).decode("utf-8", "ignore")
                uart_last_rx_ms = time.ticks_ms()
                frames, uart_rx_buffer = extract_uart_frames(uart_rx_buffer, False)
                for line in frames:
                    kind, out_lines = handle_uart_line(line)
                    log("UART <-", line)
                    for out_line in out_lines:
                        await broadcast(out_line)

                if len(uart_rx_buffer) > 1024:
                    uart_rx_buffer = uart_rx_buffer[-256:]
        elif uart_rx_buffer:
            idle_ms = time.ticks_diff(time.ticks_ms(), uart_last_rx_ms)
            if idle_ms > max(50, UART_POLL_MS * 3):
                frames, uart_rx_buffer = extract_uart_frames(uart_rx_buffer, True)
                for line in frames:
                    kind, out_lines = handle_uart_line(line)
                    log("UART <-", line)
                    for out_line in out_lines:
                        await broadcast(out_line)
        await asyncio.sleep_ms(UART_POLL_MS)


async def uart_startup_sync(uart):
    await asyncio.sleep_ms(UART_STARTUP_SYNC_DELAY_MS)
    uart_send(uart, "GET STATE")
    uart_send(uart, "GET SELECTOR_LABELS")
    uart_send(uart, "GET AMP_STATES")
    uart_send(uart, "GET TUBES")


async def ws_session(ws, uart):
    clients.add(ws)
    log("WS client connected; clients=", len(clients))
    try:
        if last_labels_line:
            await ws.send_text(last_labels_line)
        if last_state_line:
            await ws.send_text(last_state_line)
        if last_amp_states_line:
            await ws.send_text(last_amp_states_line)
        tubes_text = render_tubes_lines()
        if tubes_text:
            for line in tubes_text.split("\n"):
                if line:
                    await ws.send_text(line)

        while True:
            msg = await ws.recv()
            if msg is None:
                break
            msg = msg.strip()
            if not msg:
                continue

            cmd = normalize_client_command(msg)
            if cmd:
                uart_send(uart, cmd)
            elif msg.upper().startswith("GET "):
                uart_send(uart, msg)
    except Exception as exc:
        log("WS session error:", exc)
    finally:
        clients.discard(ws)
        log("WS client disconnected; clients=", len(clients))
        await ws.close()


async def handle_http(reader, writer, uart):
    try:
        request_line = await reader.readline()
    except OSError as exc:
        # Mobile browsers may reset sockets while backgrounding/resuming.
        if not exc.args or exc.args[0] != 104:
            log("HTTP read request line error:", exc)
        try:
            writer.close()
        except Exception:
            pass
        try:
            await writer.wait_closed()
        except Exception:
            pass
        return
    if not request_line:
        try:
            writer.close()
        except Exception:
            pass
        try:
            await writer.wait_closed()
        except Exception:
            pass
        return

    method, path = parse_request_line(request_line)
    log("HTTP", method, path)
    headers = {}
    while True:
        try:
            line = await reader.readline()
        except OSError as exc:
            if not exc.args or exc.args[0] != 104:
                log("HTTP read header error:", exc)
            try:
                writer.close()
            except Exception:
                pass
            try:
                await writer.wait_closed()
            except Exception:
                pass
            return
        if not line or line in (b"\r\n", b"\n"):
            break
        try:
            key, value = line.decode().split(":", 1)
            headers[key.strip().lower()] = value.strip()
        except Exception:
            continue

    if headers.get("upgrade", "").lower() == "websocket":
        if is_setup_mode_active():
            await send_response(writer, 403, "text/plain", "Setup mode")
            return
        key = headers.get("sec-websocket-key")
        if not key:
            log("WS upgrade missing key")
            try:
                writer.close()
            except Exception:
                pass
            try:
                await writer.wait_closed()
            except Exception:
                pass
            return
        accept = ws_accept_key(key)
        log("WS upgrade accepted for", path)
        resp = (
            "HTTP/1.1 101 Switching Protocols\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            "Sec-WebSocket-Accept: %s\r\n\r\n"
        ) % accept
        writer.write(resp.encode("utf-8"))
        await writer.drain()
        ws = WebSocket(reader, writer)
        await ws_session(ws, uart)
        return

    if method == "POST" and path == "/save":
        length = int(headers.get("content-length", "0") or "0")
        body = b""
        if length:
            body = await read_exactly(reader, length)
        data = parse_form(body)
        ssid = data.get("ssid", "")
        password = data.get("password", "")
        if ssid:
            save_wifi_config(ssid, password)
            await send_response(writer, 200, "text/html", AP_PAGE.replace("__SSID__", ssid))
            start_sta_task({"ssid": ssid, "password": password})
            return
        await send_response(writer, 400, "text/plain", "Missing SSID")
        return
    if method == "POST" and path == "/api/cmd":
        length = int(headers.get("content-length", "0") or "0")
        body = b""
        if length:
            body = await read_exactly(reader, length)
        try:
            line = body.decode("utf-8").strip()
        except Exception:
            line = ""
        cmd = normalize_client_command(line)
        if cmd:
            uart_send(uart, cmd)
            await send_response(writer, 200, "text/plain", "OK")
            return
        await send_response(writer, 400, "text/plain", "BAD_CMD")
        return
    if method == "POST" and path == "/retry":
        await send_response(writer, 200, "text/html", AP_PAGE.replace("__SSID__", ap_page_ssid))
        stored = load_wifi_config()
        if stored:
            start_sta_task(stored)
        return
    if method == "POST" and path == "/clear":
        try:
            with open(WIFI_CONFIG_FILE, "r"):
                pass
            try:
                import os
                os.remove(WIFI_CONFIG_FILE)
            except Exception:
                pass
        except Exception:
            pass
        await send_response(
            writer,
            200,
            "text/html",
            "<html><body><h3>Cleared. Rebooting...</h3></body></html>",
        )
        await asyncio.sleep(0.2)
        machine.reset()
        return

    if method != "GET":
        await send_response(writer, 405, "text/plain", "Method Not Allowed")
        return

    if path == "/status":
        text = "IDLE"
        if sta_status == "connecting":
            text = "CONNECTING"
        elif sta_status == "connected":
            text = "CONNECTED " + sta_ip
        elif sta_status == "failed":
            text = "FAILED"
        await send_response(writer, 200, "text/plain", text)
        return

    if path == "/api/state":
        await send_response(writer, 200, "text/plain", last_state_line or "")
        return
    if path == "/api/labels":
        await send_response(writer, 200, "text/plain", last_labels_line or "")
        return
    if path == "/api/amp_states":
        await send_response(writer, 200, "text/plain", last_amp_states_line or "")
        return
    if path == "/api/tubes":
        await send_response(writer, 200, "text/plain", render_tubes_lines())
        return

    if path == "/" or path == "/index.html":
        if is_setup_mode_active():
            log("Serving setup page in AP mode")
            await send_response(writer, 200, "text/html", AP_PAGE.replace("__SSID__", ap_page_ssid))
        else:
            await send_file(writer, "web/index.html", "text/html")
        return
    if path == "/app.js":
        await send_file(writer, "web/app.js", "application/javascript")
        return
    if path == "/style.css":
        await send_file(writer, "web/style.css", "text/css")
        return

    await send_response(writer, 404, "text/plain", "Not Found")


async def send_response(writer, status_code, content_type, body):
    status_text = {
        200: "OK",
        400: "Bad Request",
        403: "Forbidden",
        404: "Not Found",
        405: "Method Not Allowed",
    }.get(status_code, "OK")

    if isinstance(body, bytes):
        data = body
    else:
        data = body.encode("utf-8")
    header = (
        "HTTP/1.1 %d %s\r\n"
        "Content-Type: %s\r\n"
        "Content-Length: %d\r\n"
        "Cache-Control: no-store, no-cache, must-revalidate, max-age=0\r\n"
        "Pragma: no-cache\r\n"
        "Expires: 0\r\n"
        "Connection: close\r\n\r\n"
    ) % (status_code, status_text, content_type, len(data))

    try:
        writer.write(header.encode("utf-8"))
        await writer.drain()
        offset = 0
        chunk_size = 1024
        total = len(data)
        while offset < total:
            writer.write(data[offset : offset + chunk_size])
            await writer.drain()
            offset += chunk_size
    except OSError as exc:
        if not is_benign_socket_close(exc):
            raise
    finally:
        await close_writer(writer)


async def send_file(writer, path, content_type):
    size = None
    try:
        size = os.stat(path)[6]
    except OSError:
        await send_response(writer, 404, "text/plain", "Not Found")
        return

    try:
        header = (
            "HTTP/1.1 200 OK\r\n"
            "Content-Type: %s\r\n"
            "Content-Length: %d\r\n"
            "Cache-Control: no-store, no-cache, must-revalidate, max-age=0\r\n"
            "Pragma: no-cache\r\n"
            "Expires: 0\r\n"
            "Connection: close\r\n\r\n"
        ) % (content_type, size)
        writer.write(header.encode("utf-8"))
        await writer.drain()
        with open(path, "rb") as f:
            while True:
                chunk = f.read(1024)
                if not chunk:
                    break
                writer.write(chunk)
                await writer.drain()
    except OSError as exc:
        if not is_benign_socket_close(exc):
            log("send_file socket error for", path, ":", exc)
    except Exception as exc:
        log("send_file error for", path, ":", exc)
    finally:
        await close_writer(writer)


async def close_writer(writer):
    try:
        writer.close()
    except Exception:
        pass
    try:
        await writer.wait_closed()
    except Exception:
        pass


def parse_form(body):
    result = {}
    if not body:
        return result
    try:
        text = body.decode("utf-8")
    except Exception:
        return result
    for part in text.split("&"):
        if "=" in part:
            key, value = part.split("=", 1)
            result[url_decode(key)] = url_decode(value)
    return result


def url_decode(value):
    value = value.replace("+", " ")
    out = ""
    i = 0
    while i < len(value):
        ch = value[i]
        if ch == "%" and i + 2 < len(value):
            try:
                out += chr(int(value[i + 1 : i + 3], 16))
                i += 3
                continue
            except Exception:
                pass
        out += ch
        i += 1
    return out


def start_sta_task(creds):
    global sta_task, sta_status, sta_ip
    sta_status = "connecting"
    sta_ip = ""
    if sta_task:
        return
    sta_task = asyncio.create_task(sta_connect_task(creds))


def decode_dns_name(data, offset):
    labels = []
    jumped = False
    jump_offset = 0
    while True:
        if offset >= len(data):
            return "", offset
        length = data[offset]
        if length == 0:
            offset += 1
            break
        if length & 0xC0:
            if offset + 1 >= len(data):
                return "", offset + 1
            pointer = ((length & 0x3F) << 8) | data[offset + 1]
            if not jumped:
                jump_offset = offset + 2
                jumped = True
            offset = pointer
            continue
        offset += 1
        if offset + length > len(data):
            return "", offset + length
        labels.append(data[offset : offset + length].decode("utf-8"))
        offset += length
    name = ".".join(labels)
    return name, (jump_offset if jumped else offset)


def build_dns_captive_response(data, ip):
    if len(data) < 12:
        return None
    qdcount = (data[4] << 8) | data[5]
    if qdcount < 1:
        return None

    qname, qend = decode_dns_name(data, 12)
    if not qname:
        return None
    if qend + 4 > len(data):
        return None
    qtype = (data[qend] << 8) | data[qend + 1]
    qclass = (data[qend + 2] << 8) | data[qend + 3]
    if qtype not in (1, 255):  # A or ANY
        return None
    if qclass not in (1, 0x8001):  # IN
        return None

    question = data[12 : qend + 4]
    ip_bytes = bytes(int(part) for part in ip.split("."))

    resp = bytearray()
    resp += data[0:2]            # ID
    resp += b"\x81\x80"          # standard query response, no error
    resp += b"\x00\x01"          # QDCOUNT
    resp += b"\x00\x01"          # ANCOUNT
    resp += b"\x00\x00"          # NSCOUNT
    resp += b"\x00\x00"          # ARCOUNT
    resp += question
    resp += b"\xC0\x0C"          # NAME pointer
    resp += b"\x00\x01"          # TYPE A
    resp += b"\x00\x01"          # CLASS IN
    resp += b"\x00\x00\x00\x3C"  # TTL 60s
    resp += b"\x00\x04"          # RDLENGTH
    resp += ip_bytes
    return resp


async def captive_dns_task(ip):
    global ap_setup_mode
    sock = None
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind(("0.0.0.0", DNS_PORT))
        sock.setblocking(False)
    except Exception as exc:
        log("Captive DNS disabled:", exc)
        return

    log("Captive DNS active on port", DNS_PORT)

    try:
        while True:
            if not ap_setup_mode:
                break
            try:
                data, addr = sock.recvfrom(512)
            except OSError:
                await asyncio.sleep_ms(50)
                continue
            if not data:
                continue
            resp = build_dns_captive_response(data, ip)
            if resp:
                try:
                    sock.sendto(resp, addr)
                except Exception:
                    pass
    finally:
        if sock is not None:
            try:
                sock.close()
            except Exception:
                pass
        log("Captive DNS stopped")


async def main():
    stored = load_wifi_config()
    if stored:
        creds = stored
        force_ap = False
    else:
        creds = {"ssid": WIFI_SSID, "password": WIFI_PASSWORD}
        force_ap = True

    global ap_setup_mode
    ap_setup_mode = force_ap
    global ap_page_ssid
    ap_page_ssid = creds.get("ssid", "")

    wlan, mode, sta_connected = wifi_connect(creds, force_ap)
    if mode == "sta" and sta_connected:
        ap_setup_mode = False
    if mode == "sta" and not sta_connected:
        ap_setup_mode = True
        wlan = start_ap()
        mode = "ap"
        if stored:
            start_sta_task(stored)
    elif mode == "sta" and sta_connected and not ap_setup_mode:
        try:
            ap = network.WLAN(network.AP_IF)
            was_active = False
            try:
                was_active = ap.active()
            except Exception:
                pass
            ap.active(False)
            if was_active:
                log("AP disabled (STA connected at boot)")
        except Exception:
            pass
    uart = uart_init()
    led = init_status_led()

    asyncio.create_task(led_heartbeat_task(led))
    asyncio.create_task(uart_writer_task(uart))
    asyncio.create_task(uart_reader_task(uart))
    asyncio.create_task(uart_startup_sync(uart))

    gc.collect()
    server = await asyncio.start_server(
        lambda r, w: handle_http(r, w, uart), HTTP_HOST, HTTP_PORT
    )
    log("HTTP server listening on", HTTP_HOST, HTTP_PORT)

    if ap_setup_mode:
        ap_ip = wlan.ifconfig()[0]
        asyncio.create_task(captive_dns_task(ap_ip))
        log("AP mode config: connect to", WIFI_AP_SSID, "and open http://", ap_ip)
        log("Save SSID/password to connect to Wi-Fi.")

    while True:
        await asyncio.sleep(5)


try:
    asyncio.run(main())
finally:
    reset_wifi_radios()
    asyncio.new_event_loop()
