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
    "Stockton": {
        "name": "Stockton",
        "latitude": 37.96,
        "longitude": -121.29,
        "zoom": 12,
    },
    "Santa Barbara": {
        "name": "Santa Barbara",
        "latitude": 34.42,
        "longitude": -119.70,
        "zoom": 13,
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
    "London": {
        "name": "London",
        "latitude": 51.51,
        "longitude": -0.09,
        "zoom": 12,
    },
    "Paris": {
        "name": "Paris",
        "latitude": 48.86,
        "longitude": 2.35,
        "zoom": 12,
    },
    "Berlin": {
        "name": "Berlin",
        "latitude": 52.52,
        "longitude": 13.40,
        "zoom": 12,
    },
}

COMPANY = {
    "name": "SwiftBite",
    "tagline": "Fresh Food, Fast Delivery",
}


def get_city(name="San Francisco"):
    return CITIES.get(name, CITIES["San Francisco"])


def get_company():
    return COMPANY


def driver_color(driver_id, alpha=255):
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
