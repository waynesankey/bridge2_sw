# Bridge configuration for Pico 2W (MicroPython)

# Wi-Fi mode: "sta" (connect to existing Wi-Fi) or "ap" (create access point)
WIFI_MODE = "sta"

# Station mode credentials
WIFI_SSID = "YOUR_SSID"
WIFI_PASSWORD = "YOUR_PASSWORD"

# Access point mode settings (password must be at least 8 chars)
WIFI_AP_SSID = "preamp-bridge"
WIFI_AP_PASSWORD = "preamp123"

# Optional hostname (may not be supported on all builds)
WIFI_HOSTNAME = "preamp"

# Wi-Fi onboarding
WIFI_CONFIG_FILE = "wifi.json"
WIFI_CONNECT_TIMEOUT_MS = 10_000

# HTTP server
HTTP_HOST = "0.0.0.0"
HTTP_PORT = 80

# UART configuration (bridge -> preamp controller)
UART_ID = 0
UART_BAUD = 115200
UART_BITS = 8
UART_PARITY = None
UART_STOP = 1
UART_TX_PIN = 16
UART_RX_PIN = 17

# Preamp limits for UI hints
MAX_VOLUME = 64
MAX_BALANCE = 6
SELECT_MIN = 1
SELECT_MAX = 4
BRI_MIN = 1
BRI_MAX = 8

# Behavior
UART_POLL_MS = 10
UART_STARTUP_SYNC_DELAY_MS = 500
WS_PING_INTERVAL_S = 25
