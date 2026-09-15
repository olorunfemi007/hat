"""DHT11 temperature/humidity driver.

Needs adafruit-circuitpython-dht + adafruit-blinka, real pip dependencies --
run sensors.py under its own dedicated venv with those installed. Device-agent's
core (heartbeat/sync/capture/sensors) stays standard-library-only; this driver
is the deliberate, isolated exception, the same pattern voice-trigger already
uses for PocketSphinx. Nothing else in sensors.py depends on this module
existing: if its imports fail (venv not set up), sensors.py logs that once at
startup and continues running whatever other drivers are available.
"""
from heartbeat import ConfigError
from sensors import register_driver

_pins = {}


def _resolve_pin(name):
    if not _pins:
        import board
        for attr in dir(board):
            if attr.startswith("D") and attr[1:].isdigit():
                _pins[attr] = getattr(board, attr)
    if name not in _pins:
        raise ConfigError(f"unknown DHT11 pin {name!r}; expected a board.Dn name such as 'D4'")
    return _pins[name]


class DHT11Driver:
    def __init__(self, pin_name):
        import adafruit_dht
        self._sensor = adafruit_dht.DHT11(_resolve_pin(pin_name))

    def read(self):
        # adafruit_dht raises RuntimeError on a failed read (checksum/timing --
        # DHT11 misses a real fraction of reads even correctly wired). The
        # caller (sensors.run_sensor) turns any exception into an explicit
        # status="error" reading; it must never become a missing or zero value.
        temperature_c = self._sensor.temperature
        humidity_pct = self._sensor.humidity
        if temperature_c is None or humidity_pct is None:
            raise RuntimeError("DHT11 returned no reading")
        return {
            "values": {"temperature_c": float(temperature_c), "humidity_pct": float(humidity_pct)},
            "units": {"temperature_c": "celsius", "humidity_pct": "percent"},
        }

    def close(self):
        self._sensor.exit()


@register_driver("dht11")
def _build(entry):
    pin = entry.get("pin")
    if not isinstance(pin, str) or not pin:
        raise ConfigError("dht11 sensor entries need a 'pin' (e.g. 'D4')")
    return DHT11Driver(pin)
