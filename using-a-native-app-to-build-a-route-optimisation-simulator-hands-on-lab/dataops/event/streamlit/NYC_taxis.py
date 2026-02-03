# Import python packages
import streamlit as st
import pandas as pd
import pydeck as pdk
import altair as alt
from datetime import time   
from datetime import datetime


from snowflake.snowpark.functions import *
from snowflake.snowpark.types import *
from snowflake.snowpark.window import Window

# We can also use Snowpark for our analyses!
from snowflake.snowpark.context import get_active_session
session = get_active_session()
st.set_page_config(layout="wide")
# Load custom CSS
with open('extra.css') as f:
    st.markdown(f"<style>{f.read()}</style>", unsafe_allow_html=True)

# Set sidebar logo
st.logo('logo.svg')

# Create the bar chart

session.sql('''DROP WAREHOUSE IF EXISTS NYTAXI_PROCESS_DATA_WH ''').collect()
session.sql('''USE WAREHOUSE DEFAULT_WH''').collect()

def bar_creation(dataframe, measure, attribute):
    # before any charts are defined or rendered.

    # Ensure the input is a pandas DataFrame, as Altair works with pandas DataFrames
    # If dataframe is already a pandas DataFrame, .to_pandas() is redundant but harmless.
    # If it's a Snowpark DataFrame, this correctly converts it.
    df = dataframe.to_pandas()

    # Create the bars
    bars = alt.Chart(df).mark_bar().encode(
        y=alt.Y(attribute, sort=None, axis=None), # Hide the y-axis labels
        x=alt.X(measure, axis=None),              # Hide the x-axis labels
        color=alt.value("#29B5E8"),               # Set a fixed color for the bars
        
        tooltip=[                                 # <--- MODIFIED HERE to add titles
            alt.Tooltip(attribute, title=attribute.replace('_', ' ').title()), # Title from attribute name
            alt.Tooltip(measure, title=measure.replace('_', ' ').title())    # Title from measure name
        ]              # Add tooltip for interactivity
    ).properties(height=300) # Set a fixed height for the bars chart

    # Create the text layer for point values
    # Properties like align, baseline, dx, color, and fontSize are part of mark_text()
    text = bars.mark_text(
        align='right',    # Align text to the right side of its x-position (end of the bar)
        baseline='middle',
        dx=-10,            # Nudge text to the left (inside the bar) for better visibility
         # Set text color to white
        fontSize=20       # Set the font size for the text labels
    ).encode(
        color=alt.value("#FFFFFF"),
        # These are the encoding channels that map data to visual properties
        x=alt.X(measure), # X-position of the text (at the end of the bar)
        y=alt.Y(attribute, sort=None), # Y-position of the text (aligned with the bar)
        text=alt.Text(measure, format=",.0f") # The actual text to display (formatted measure value)
    )

    # Combine the bar chart and the text layer
    # Note: The height property on the combined chart will override the individual chart heights
    final_chart = (bars + text).properties(height=200)



    return final_chart
    




vehicle_plans_poi = session.table('FLEET_INTELLIGENCE.ANALYTICS.TRIPS_ASSIGNED_TO_DRIVERS')
vehicle_plans_poi = vehicle_plans_poi.with_column('DISTANCE',call_function('ST_LENGTH',col('GEOMETRY')))
vehicle_plans = vehicle_plans_poi
route_names = session.table('FLEET_INTELLIGENCE.ANALYTICS.ROUTE_NAMES')
routes = vehicle_plans_poi.select('GEOMETRY','TRIP_ID','DISTANCE','DRIVER_ID')
trip_summary = session.table('FLEET_INTELLIGENCE.ANALYTICS.TRIP_SUMMARY').join(vehicle_plans_poi,'TRIP_ID')
    
all_driver_locations =  session.table('FLEET_INTELLIGENCE.ANALYTICS.DRIVER_LOCATIONS')
all_driver_locations = all_driver_locations.with_column('LON',call_function('ST_X',col('POINT_GEOM')))
all_driver_locations = all_driver_locations.with_column('LAT',call_function('ST_Y',col('POINT_GEOM')))
all_driver_locations = all_driver_locations.with_column('POINT_TIME',col('CURR_TIME').astype(StringType()))
all_driver_locations = all_driver_locations.join(route_names,'TRIP_ID')
all_driver_locations = all_driver_locations.join(routes,'TRIP_ID')
all_driver_locations = all_driver_locations.join(trip_summary,'TRIP_ID',lsuffix='l')




vehicle_plans_poi = vehicle_plans_poi.join(route_names,'TRIP_ID')



driver_ids = vehicle_plans_poi


longest_trips = vehicle_plans_poi.order_by(col('DISTANCE').desc())
shortest_trips = vehicle_plans_poi.order_by(col('DISTANCE').asc())






@st.cache_data
def drivers():
    return driver_ids.select('DRIVER_ID').distinct().to_pandas()



with st.sidebar:
    driver = st.selectbox('Choose Driver:',drivers())




def trips(driver):
    return driver_ids.filter(col('DRIVER_ID')== driver)\
        .group_by('TRIP_ID','TRIP_NAME').agg(min('DISTANCE').alias('DISTANCE')).sort(col('DISTANCE').desc()).to_pandas()


driver_day = vehicle_plans_poi.filter(col('DRIVER_ID')==driver)

top_pickup = driver_day.select('ORIGIN_ADDRESS').distinct().to_pandas()
top_dropoff = driver_day.select('DESTINATION_ADDRESS').distinct().to_pandas()


trip_summaryd = trip_summary.filter(col('DRIVER_ID')==driver)


st.markdown(f'''
<h0black>New York Taxi |</h0black><h0blue>Control Center</h0blue><BR>
<h1black>Viewing The Taxi Journey for DRIVER {driver}</h1black>
''', unsafe_allow_html=True)




time_by_hour = all_driver_locations.filter(col('DRIVER_ID')==driver)\
    .with_column('HOUR',hour(to_timestamp('CURR_TIME')))\
    .group_by('HOUR','TRIP_NAME').agg(max('DISTANCE').alias('DISTANCE'))

time_by_hour = time_by_hour.group_by('HOUR').agg(count('*').alias('TRIPS'),sum('DISTANCE').alias('DISTANCE'))
perhour_stats = time_by_hour.agg(avg('TRIPS').alias('TRIPS'),avg('DISTANCE').alias('DISTANCE')).to_pandas()

# --- Chart 1: Heatmap based on TRIPS ---

df = time_by_hour.to_pandas()
chart_trips = alt.Chart(df).mark_rect().encode(
    x=alt.X('HOUR:O', title='', axis=alt.Axis(values=list(range(24)))),
    y=alt.Y('Null:O', title='', axis=None), # Dummy Y-axis for a single row
    color=alt.Color('TRIPS:Q', title='Number of Trips', scale=alt.Scale(range=['#c6e5f1', '#96d5ef', '#63c6eb','#29B5E8']),
                   legend=None),
    tooltip=[
        alt.Tooltip('HOUR:O', title='Hour'),
        alt.Tooltip('TRIPS:Q', title='Trips')
    ]
).properties(
    title='Number of Trips per Hour' # Title for the Altair chart itself
)



# --- Chart 2: Heatmap based on DISTANCE ---
st.markdown(f'<h1grey>TIME ANALYSIS FOR {driver} TODAY</h1grey>',unsafe_allow_html=True)
df = time_by_hour.to_pandas()
chart_distance = alt.Chart(df).mark_rect().encode(
    x=alt.X('HOUR:O', title='', axis=alt.Axis(values=list(range(24)))),
    y=alt.Y('Null:O', title='', axis=None), # Dummy Y-axis for a single row
    color=alt.Color('DISTANCE:Q', title='Total Distance', scale=alt.Scale(range=['#c6e5f1', '#96d5ef', '#63c6eb','#29B5E8']),
                   legend=None),
    tooltip=[
        alt.Tooltip('HOUR:O', title='Hour'),
        alt.Tooltip('DISTANCE:Q', title='Distance', format='.2f')
    ]
).properties(
    title='Total Distance per Hour' # Title for the Altair chart itself
)

#### run two barcharts

col1,col2 = st.columns(2)
with col1:
    st.altair_chart(chart_trips, use_container_width=True)
with col2:
    st.altair_chart(chart_distance, use_container_width=True)


with st.sidebar:
    ##### stats for driver
    speed_stats = trip_summaryd.agg(avg('AVERAGE_KMH').alias('AVG_KMH'),max('MAX_KMH').alias('MAX_KMH')).to_pandas()
    driver_stats = driver_day.agg(count('*').alias('A'),sum('DISTANCE').alias('B')).to_pandas()
    st.markdown(f'<h1grey style="font-size: 0.9em;">TRIPS MADE TODAY <BR> </h1grey><h1blue> {driver_stats.A.iloc[0]}</h1blue>',unsafe_allow_html=True)
    st.markdown(f'<h1grey style="font-size: 0.9em;">TOTAL DISTANCE DRIVEN (KM) <BR> </h1grey><h1blue> {(driver_stats.B.iloc[0]/1000).round(2)}</h1blue>',unsafe_allow_html=True)
    st.markdown(f'<h1grey style="font-size: 0.9em;">AVG TRIPS PER HOUR <BR> </h1grey><h1blue> {int(perhour_stats.TRIPS.iloc[0])}</h1blue>',unsafe_allow_html=True)
    st.markdown(f'<h1grey style="font-size: 0.9em;">AVG DISTANCE PER HOUR (KM) <BR> </h1grey><h1blue> {(perhour_stats.DISTANCE.iloc[0]/1000).round(2)}</h1blue>',unsafe_allow_html=True)
    st.markdown(f'<h1grey style="font-size: 0.9em;">AVG SPEED (KPH) <BR> </h1grey><h1blue> {(speed_stats.AVG_KMH.iloc[0]).round(2)}</h1blue>',unsafe_allow_html=True)
    st.markdown(f'<h1grey style="font-size: 0.9em;">MAX SPEED (KPH) <BR> </h1grey><h1blue> {(speed_stats.MAX_KMH.iloc[0]).round(2)}</h1blue>',unsafe_allow_html=True)
    
    


with st.container():
    st.markdown(f'<h1grey>ROUTE DISTANCES FOR {driver} TODAY</h1grey>',unsafe_allow_html=True)
    cola,colb = st.columns(2)
    with cola:
        st.markdown('<h1sub>Shortest Routes</h1sub>',unsafe_allow_html=True)
    
        shortest_trips_f = shortest_trips.filter(col('DRIVER_ID')==driver).sort(col('DISTANCE').asc()).limit(5)
        event1 = st.altair_chart(bar_creation(shortest_trips_f,'DISTANCE','TRIP_NAME'))
            

    with colb:
        st.markdown('<h1sub>Longest Routes</h1sub>',unsafe_allow_html=True)
            
        longest_trips_f = longest_trips.filter(col('DRIVER_ID')==driver).sort(col('DISTANCE').desc()).limit(5)
        event2 = st.altair_chart(bar_creation(longest_trips_f,'DISTANCE','TRIP_NAME'))



st.divider()

st.markdown('<h1black> Viewing Details of individual Routes </h1black>',unsafe_allow_html=True)


selected_route = st.selectbox('Choose Trip (Sorted longest to shortest): ', trips(driver).TRIP_NAME)
    
trip_id = trips(driver).query(f'''TRIP_NAME == "{selected_route}" ''').TRIP_ID.iloc[0]








driver_locations = all_driver_locations.filter(col('TRIP_ID')==trip_id)
st.session_state['TRIP_ID'] = trip_id
driver_locations = driver_locations.with_column('POINT_TIME',col('POINT_TIME'))



selected_trip = trip_summary.filter(col('TRIP_ID')==trip_id)

selected_trip = selected_trip.with_column('LONP',call_function('ST_X',col('ORIGIN')))
selected_trip = selected_trip.with_column('LATP',call_function('ST_Y',col('ORIGIN')))

selected_trip = selected_trip.with_column('LOND',call_function('ST_X',col('DESTINATION')))
selected_trip = selected_trip.with_column('LATD',call_function('ST_Y',col('DESTINATION')))
selected_trip = selected_trip.with_column('DISTANCE',div0(call_function('ST_LENGTH',col('GEOMETRY')),1000))







           


times = driver_locations.select(col('POINT_TIME').astype(StringType()).alias('POINT_TIME')).to_pandas()
times['POINT_TIME'] = pd.to_datetime(times['POINT_TIME'],errors='coerce')
times['POINT_TIME'] = times['POINT_TIME'].dt.strftime('%Y-%m-%d %H:%M:%S')

Choose_Time = st.select_slider("Choose Timestamp:", times )






driver_locations = driver_locations.filter(to_timestamp('POINT_TIME')==to_timestamp(lit(Choose_Time)))

driver_locations = driver_locations.with_column('DIRECTIONS',
                                                    call_function('OPEN_ROUTE_SERVICE_NEW_YORK.CORE.DIRECTIONS',
                                                                  'driving-car',call_function('ST_ASGEOJSON',col('ORIGIN'))['coordinates'],
                                                                                              call_function('ST_ASGEOJSON',col('POINT_GEOM'))['coordinates']))

    
    
 
driver_locations = driver_locations.with_column('DURATION',col('directions')['features'][0]['properties']['summary']['duration'].astype(FloatType()))
driver_locations = driver_locations.with_column('DISTANCE',col('directions')['features'][0]['properties']['summary']['distance'].astype(FloatType()))
driver_locations = driver_locations.with_column('DISTANCE',round(div0('DISTANCE',1000),2))
driver_locations = driver_locations.with_column('DURATION',div0('DURATION',60))
driver_locations = driver_locations.with_column('TOTAL_DISTANCE',round(div0(call_function('ST_LENGTH',col('GEOMETRY')),1000),2))
driver_locations = driver_locations.with_column('ROUTE_SO_FAR',col('directions')['features'][0]['geometry'])
    

stats = driver_locations.to_pandas()

main_container = st.container(height=1000)
with main_container:

    

    
   

    st.markdown(f'''
        <h1sub>DISTANCE IN KILOMETERS:</h1sub> <h1grey>{stats.TOTAL_DISTANCE.iloc[0].round(2)} | </h1grey>
        <h1sub>DISTANCE LEFT:</h1sub> <h1grey>{stats.DISTANCE.iloc[0].round(2)} | </h1grey>
        <h1sub>TIME LEFT IN MINUTES:</h1sub> <h1grey>{stats.DURATION.iloc[0].round(2)}</h1grey>
        <h1sub>AVERAGE SPEED KPH:</h1sub> <h1grey>{stats.AVERAGE_KMH.iloc[0].round(2)}</h1grey>
        <h1sub>MAX SPEED Kph:</h1sub> <h1grey>{stats.MAX_KMH.iloc[0].round(2)}</h1grey>
        ''', unsafe_allow_html=True)
    
 
    
    

    

   

#### field for pickup tooltip
pickup = selected_trip.select(concat(lit('Pickup Location: '),
                                               col('ORIGIN_ADDRESS'),
                                               lit('<br>Pickup Time: '),
                                                concat(hour(col('PICKUP_TIME')),
                                                       lit(':'),
                                                      minute(col('PICKUP_TIME')),
                                                       lit(':'),
                                                      second(col('PICKUP_TIME')))).alias('TOOLTIP'),
                                                'TRIP_ID','LONP','LATP')

#### field for dropoff tooltip
dropoff = selected_trip.select(concat(lit('Dropoff Location: '),
                                               col('DESTINATION_ADDRESS'),
                                               lit('<br>Dropoff Time: '),
                                                concat(hour(col('ACTUAL_DROPOFF_TIME')),
                                                       lit(':'),
                                                      minute(col('ACTUAL_DROPOFF_TIME')),
                                                       lit(':'),
                                                      second(col('ACTUAL_DROPOFF_TIME')))).alias('TOOLTIP'),
                                                'TRIP_ID','LOND','LATD')




driver_locations = driver_locations.drop('PICKUP_LOCATION','PICKUP_TIME','DROPOFF_TIME')


driver_locations = driver_locations.select(concat(lit('Duration: '),
                                               round(coalesce('DURATION',lit(0)),2),
                                               lit('<br> Current Time: '),
                                                concat(hour(to_timestamp('POINT_TIME')),
                                                       lit(':'),
                                                      minute(to_timestamp('POINT_TIME')),
                                                       lit(':'),
                                                      second(to_timestamp('POINT_TIME'))),lit('<BR>Speed in kph: '),round('KMH',2)).alias('TOOLTIP'),
                                                'TRIP_ID','LON','LAT','POINT_TIME','DURATION','ROUTE_SO_FAR')



### construct an obect in the selected trip data to pass to AI_COMPLETE
selected_trip = selected_trip.with_column('AI_COMPLETE',object_construct(lit("Driver ID"),"DRIVER_ID", 
                                                                    lit('Average Speed in KpH'),"AVERAGE_KMH",
                                                                     lit("Trip ID"),"TRIP_ID", 
                                                                     lit("DISTANCE_IN_METERS"),call_function('ST_LENGTH',col('GEOMETRY')),
                                                                     lit("Pickup Time"),"PICKUP_TIME", 
                                                                     lit("Pickup Location"),call_function('ST_ASGEOJSON',
                                                                                                          col("ORIGIN")), 
                                                                     lit("Dropoff Location"),call_function('ST_ASGEOJSON',
                                                                                                           col("DESTINATION")), 
                                                                     lit("Dropoff Time"),"ACTUAL_DROPOFF_TIME", 
                                                                     lit("Dropoff Place"),"DESTINATION_ADDRESS", 
                                                                     lit("Destination -Nearest Point of Interest"),"DESTINATION_NEAREST_POI",
                                                                    
                                                                    lit("Origin -Nearest Point of Interest"),"ORIGIN_NEAREST_POI",
                                                                    lit("Pickup Place"),col("ORIGIN_ADDRESS"),
                                                                    lit('JOURNEY INSTRUCTIONS'),col('ROUTE')['features'][0]['properties']['segments'][0]['steps']
                                                                   ).astype(StringType())
                                                                   )

### pandas dataframes for pydeck scatter layers
driver_locationspd = driver_locations.drop('ROUTE').to_pandas()
pickuppd = pickup.to_pandas()
dropoffpd = dropoff.to_pandas()

###### create pickup location data tooltip

routes = selected_trip.with_column('TOOLTIP',
                                  concat(lit('Pickup Location'), col('ORIGIN_ADDRESS')))


### format the full preprocessed route path for pydeck
routespd = routes.to_pandas()
routespd["coordinates"] = routespd["GEOMETRY"].apply(lambda row: json.loads(row)["coordinates"])



##### format the route so far path for pydeck
driver_locations = driver_locations.with_column('TOOLTIP',concat(lit('Current Time'),col('POINT_TIME')))
routespd2 = driver_locations.to_pandas()
routespd2["coordinates"] = routespd2["ROUTE_SO_FAR"].apply(lambda row: json.loads(row)["coordinates"])


###center the map
center = selected_trip.with_column('CENTER',call_function('ST_CENTROID',call_function('ST_ENVELOPE',(call_function('st_collect',col('ORIGIN'),col('DESTINATION'))))))
center = center.select('CENTER')
center = center.with_column('LON',call_function('ST_X',col('CENTER')))
center = center.with_column('LAT',call_function('ST_Y',col('CENTER'))).to_pandas()
LAT = center.LAT.iloc[0]
LON = center.LON.iloc[0]



##tooltip template
tooltip = {
   "html": """
   {TOOLTIP}""",
   "style": {
       "width":"50%",
        "backgroundColor": "#24323D",
        "color": "white",
       "text-wrap": "balance"
   }
}


# Create scatter layer for pickup location
sroutes = pdk.Layer(
        'ScatterplotLayer',
        data=pickuppd,
        get_position=['LONP','LATP'],
        get_radius=20,
        radius_min_pixels=5,
        radius_max_pixels=10,
        radius_scale=1,
        get_color=[41,181,232],
        pickable=True
    )
# Create scatter layer for current location
current_location = pdk.Layer(
        'ScatterplotLayer',
        data=driver_locationspd,
        get_position=['LON','LAT'],
        get_radius=30,
        radius_min_pixels=10,
        radius_max_pixels=20,
        radius_scale=1,
        get_color=[0,53,69],
        pickable=True
    )


 # Create scatter layer for drop off location
slayer = pdk.Layer(
        'ScatterplotLayer',
        data=dropoffpd,
        get_position=['LOND', 'LATD'],
        get_radius=20,
        radius_min_pixels=5,
        radius_max_pixels=10,
        radius_scale=1,
        get_color=[41, 181, 232],
        pickable=True
    )

#### path layer for whole route
vehicle_1_path = pdk.Layer(
type="PathLayer",
data=routespd,
pickable=False,
get_color=[253, 180, 107],
width_scale=20,
width_min_pixels=4,
width_max_pixels=7,
get_path="coordinates",
get_width=5)


### path layer for route so far - data generated by ORS on the fly
vehicle_1_path2 = pdk.Layer(
type="PathLayer",
data=routespd2,
pickable=False,
get_color=[0, 0, 0],
width_scale=20,
width_min_pixels=4,
width_max_pixels=7,
get_path="coordinates",
get_width=5)


routes = selected_trip



    

view_state = pdk.ViewState(latitude=LAT, longitude=LON, zoom=11)



#### function to run ai_complete on the data which will run after the map is loaded
@st.cache_data
def ai_complete(trip_id):
    return selected_trip.agg(call_function('AI_COMPLETE','claude-4-sonnet',concat(col('AI_COMPLETE'),lit(
                                           '''summarize the provided a descriptive vehicle trip,
                                            clearly using markdown with HTML styling.  Use the follwing template: 
                                            <h1sub>Trip Details using Snowflake's **AI_COMPLETE** </h1sub><br>
                                            - <h1grey>Pickup Location</h1grey></br>
                                            - <h1grey>Time of Journey</h1grey><br>
                                            **Pickup** The time in hh:mm:ss</br>
                                            **Dropoff** the time in hh:mm:ss</br>
                                            Comments around journey time and how this relates
                                            to the pickup and dropoff destination.<br>
                
                                            - <h1grey>ROUTE INFORMATION</h1grey><br>
                                            Information about the route plan. make the names of places in bold and this color #29B5E8
.
                                            - <h1grey>Location Dropoff</h1grey></br>
                                            Information about the location<h1grey><br>
                                            - <h1grey>Hypothosis on what the trip might be about<h1grey><br>
                                            This is a taxi trip - so please describe what the trip
                                            might be for.  If cooridinates are mentioned, please round to
                                            5 decimal places. 
                                            A style sheet will be used to translate the provided html tags'''))).astype(StringType())).collect()[0][0]


#### present both map and ai complete results
with main_container:
    col1,col2 = st.columns([0.4,0.6])
    
    with col2:
        st.markdown('<h1sub> map containing routing analysis</h1sub>',
                   unsafe_allow_html=True)
        st.pydeck_chart(pdk.Deck(tooltip=tooltip,layers=[vehicle_1_path,vehicle_1_path2,slayer,sroutes,current_location],map_style=None,initial_view_state=view_state),height=800)
    with col1:
        st.markdown('''<h1black>AI generated insights</h1black>''',unsafe_allow_html=True)
        with st.spinner('Please wait for **AISQL** to analyse the currently selected route'):
            with st.container(height=800):
                st.markdown(ai_complete(trip_id), unsafe_allow_html=True)