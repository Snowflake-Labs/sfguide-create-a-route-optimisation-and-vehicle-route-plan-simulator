# Import python packages
import streamlit as st
from snowflake.snowpark.context import get_active_session

# Write directly to the app
st.title(f"Openrouteservice Control App")

# Get the current credentials
session = get_active_session()

st.header('Suspending the service')
st.write("The service function is configured to auto-suspend after 4 hours to prevent cost overruns. Since auto-resume is not supported for service-to-service communication yet (on the roadmap), **manual resumption is necessary after suspension**. If you have only routing-gateway container running, you will get an error if the other services are suspended. ")
st.code('''
        alter service CORE.ORS_SERVICE RESUME;
        alter service CORE.ROUTING_GATEWAY_SERVICE RESUME;
        alter service CORE.DOWNLOADER RESUME;
        alter service CORE.VROOM_SERVICE RESUME;
        ''')

st.header('Example Usage')
st.subheader('Directions API')
st.write('What is the optimal driving route from Moscone Center in San Francisco (latitude: 37.7763, longitude: -122.4099)) to Golden Gate Bridge? (latitude: 37.8199, longitude: -122.4783)')
st.code('''
    select CORE.directions('driving-car',[-122.4099, 37.7763],[-122.4783, 37.8199]);
''', language='sql')

st.write('What is the optimal driving route from Moscone Center in San Francisco (latitude: 37.7763, longitude: -122.4099)) to Golden Gate Bridge? (latitude: 37.8199, longitude: -122.4783) via Union Square? (latidue: 37.788, longitude: -122.4075)')
st.code('''
    SELECT CORE.DIRECTIONS('driving-car',OBJECT_CONSTRUCT('coordinates',[
        [-122.4099, 37.7763],
        [-122.4075, 37.788],
        [-122.4783, 37.8199]
    ]));
''', language='sql')

st.subheader('Isochrones API')
st.write('What areas are reachable within twenty minutes by car from the Moscone Center in San Francisco?')

st.code('''
    select CORE.isochrones('driving-car',-122.4099, 37.7763,20);
''', language='sql')

st.subheader('Optimization API')
st.code('''
    select CORE.OPTIMIZATION(
        PARSE_JSON('[{
            "id":0,
            "location":[-122.4099, 37.7763]
        }]'), 
        PARSE_JSON('[{
            "id":0,
            "profile":"driving-car",
            "start":[-122.408294, 37.787700],
            "end":[-122.403923, 37.789791]
        }]');
    )
''')

