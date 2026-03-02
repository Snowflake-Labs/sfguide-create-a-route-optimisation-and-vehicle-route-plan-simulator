CITIES = {
    "San Francisco": {
        "name": "San Francisco",
        "latitude": 37.76,
        "longitude": -122.44,
        "zoom": 12,
    },
    "Los Angeles": {
        "name": "Los Angeles",
        "latitude": 34.05,
        "longitude": -118.24,
        "zoom": 11,
    },
    "San Diego": {
        "name": "San Diego",
        "latitude": 32.72,
        "longitude": -117.16,
        "zoom": 12,
    },
    "San Jose": {
        "name": "San Jose",
        "latitude": 37.34,
        "longitude": -121.89,
        "zoom": 12,
    },
    "Sacramento": {
        "name": "Sacramento",
        "latitude": 38.58,
        "longitude": -121.49,
        "zoom": 12,
    },
    "Fresno": {
        "name": "Fresno",
        "latitude": 36.74,
        "longitude": -119.77,
        "zoom": 12,
    },
    "Oakland": {
        "name": "Oakland",
        "latitude": 37.80,
        "longitude": -122.27,
        "zoom": 12,
    },
    "Long Beach": {
        "name": "Long Beach",
        "latitude": 33.77,
        "longitude": -118.19,
        "zoom": 12,
    },
    "Santa Barbara": {
        "name": "Santa Barbara",
        "latitude": 34.42,
        "longitude": -119.70,
        "zoom": 13,
    },
    "Bakersfield": {
        "name": "Bakersfield",
        "latitude": 35.37,
        "longitude": -119.02,
        "zoom": 12,
    },
    "New York": {
        "name": "New York",
        "latitude": 40.75,
        "longitude": -73.97,
        "zoom": 10,
    },
    "Chicago": {
        "name": "Chicago",
        "latitude": 41.88,
        "longitude": -87.63,
        "zoom": 12,
    },
    "Austin": {
        "name": "Austin",
        "latitude": 30.27,
        "longitude": -97.74,
        "zoom": 12,
    },
    "Seattle": {
        "name": "Seattle",
        "latitude": 47.61,
        "longitude": -122.33,
        "zoom": 12,
    },
}

CALIFORNIA_CITIES = [
    "San Francisco", "Los Angeles", "San Diego", "San Jose",
    "Sacramento", "Fresno", "Oakland", "Long Beach",
    "Santa Barbara", "Bakersfield",
]

CALIFORNIA_CENTER = {
    "name": "California",
    "latitude": 37.27,
    "longitude": -119.27,
    "zoom": 6,
}

COMPANY = {
    "name": "SwiftBite",
    "tagline": "Fresh Food, Fast Delivery",
}


def get_city(name="San Francisco"):
    """Return city config dict. Falls back to San Francisco if name not found."""
    return CITIES.get(name, CITIES["San Francisco"])


def get_california_cities():
    """Return list of California city names for sidebar selectors."""
    return CALIFORNIA_CITIES


def get_company():
    """Return company branding config."""
    return COMPANY


def driver_color(driver_id, alpha=255):
    """Generate a distinct RGB color for a driver ID using hue rotation."""
    try:
        n = int(driver_id.split("-")[-1])
    except (ValueError, IndexError):
        n = hash(driver_id)

    hue = (n * 137.508) % 360
    saturation = 0.7
    lightness = 0.5

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
