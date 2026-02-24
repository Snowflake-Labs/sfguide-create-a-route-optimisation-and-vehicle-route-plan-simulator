# City configuration for Fleet Intelligence Streamlit app
# Import this module to get city-specific constants without hardcoding values.

CITIES = {
    "San Francisco": {
        "name": "San Francisco",
        "latitude": 37.76,
        "longitude": -122.44,
        "zoom": 12,
    },
    "New York": {
        "name": "New York",
        "latitude": 40.75,
        "longitude": -73.97,
        "zoom": 10,
    },
    "London": {
        "name": "London",
        "latitude": 51.51,
        "longitude": -0.12,
        "zoom": 12,
    },
    "Paris": {
        "name": "Paris",
        "latitude": 48.86,
        "longitude": 2.35,
        "zoom": 12,
    },
    "Chicago": {
        "name": "Chicago",
        "latitude": 41.88,
        "longitude": -87.63,
        "zoom": 12,
    },
}


def get_city(name="San Francisco"):
    """Return city config dict. Falls back to San Francisco if name not found."""
    return CITIES.get(name, CITIES["San Francisco"])


def driver_color(driver_id, alpha=255):
    """Generate a distinct RGB color for a driver ID using hue rotation.

    Returns a list like [R, G, B, alpha] suitable for pydeck layers.
    Works for any number of drivers without a hardcoded lookup table.
    """
    # Extract numeric part from IDs like 'D-0042'
    try:
        n = int(driver_id.split("-")[-1])
    except (ValueError, IndexError):
        n = hash(driver_id)

    # Golden-angle hue rotation for maximum visual separation
    hue = (n * 137.508) % 360
    saturation = 0.7
    lightness = 0.5

    # HSL to RGB conversion
    c = (1 - abs(2 * lightness - 1)) * saturation
    x = c * (1 - abs((hue / 60) % 2 - 1))
    m = lightness - c / 2

    if hue < 60:
        r, g, b = c, x, 0
    elif hue < 120:
        r, g, b = x, c, 0
    elif hue < 180:
        r, g, b = 0, c, x
    elif hue < 240:
        r, g, b = 0, x, c
    elif hue < 300:
        r, g, b = x, 0, c
    else:
        r, g, b = c, 0, x

    return [int((r + m) * 255), int((g + m) * 255), int((b + m) * 255), alpha]
