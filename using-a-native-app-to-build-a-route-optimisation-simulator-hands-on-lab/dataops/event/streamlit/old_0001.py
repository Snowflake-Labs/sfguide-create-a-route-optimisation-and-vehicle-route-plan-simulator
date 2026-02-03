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
    

st.markdown('''
<h0black>New York Taxi |</h0black><h0blue>Control Center</h0blue><BR>
<h1black>Viewing The Taxi Journey for One Driver</h1black>
''', unsafe_allow_html=True)


vehicle_plans = session.table('VEHICLE_ROUTING_SIMULATOR.DATA.NY_TAXI_ROUTE_PLANS')
vehicle_plans = vehicle_plans.with_column('DISTANCE',call_function('ST_LENGTH',col('ROUTE')))


places_in_newyork = session.table('VEHICLE_ROUTING_SIMULATOR.DATA.PLACES')

places_in_newyork_P = places_in_newyork.with_column_renamed('GEOMETRY','GEOMETRY_P')
places_in_newyork_P = places_in_newyork_P.with_column_renamed('NAME','PICKUP PLACE')
places_in_newyork_P = places_in_newyork_P.select('GEOMETRY_P','PICKUP PLACE')
places_in_newyork_D = places_in_newyork.with_column_renamed('GEOMETRY','GEOMETRY_D')
places_in_newyork_D = places_in_newyork_D.with_column_renamed('NAME','DROPOFF PLACE')
places_in_newyork_D = places_in_newyork_D.select('GEOMETRY_D','DROPOFF PLACE')



    
all_driver_locations =  session.table('VEHICLE_ROUTING_SIMULATOR.DATA.DRIVER_LOCATIONS')
all_driver_locations = all_driver_locations.with_column('LON',call_function('ST_X',col('POINT_GEOM')))
all_driver_locations = all_driver_locations.with_column('LAT',call_function('ST_Y',col('POINT_GEOM')))
all_driver_locations = all_driver_locations.with_column('POINT_TIME',col('POINT_TIME').astype(StringType()))

all_driver_locations = all_driver_locations.with_column('DISTANCE',call_function('ST_LENGTH',col('ROUTE')))



#### this section takes a minute to initiall load as it caches the points of interest results to a temporary table

##### join to overture maps to find destination place if applicable

window_spec_pickup = Window.partition_by(col('TRIP_ID')).order_by(col('ORDER_PICKUP'))
window_spec_dropoff = Window.partition_by(col('TRIP_ID')).order_by(col('ORDER_DROPOFF'))



with st.sidebar:
    refresh = st.toggle('refresh  data')

try:
    session.table('CURATED_VEHICLE_PLANS').limit(1)
    refresh = 0

except:
    refresh = 1

if refresh == 1:
    r = 'overwrite'

if refresh == 1:

    with st.spinner('**1/4** - Creating additional Compute'):
    
        session.sql('''CREATE OR REPLACE WAREHOUSE NYTAXI_PROCESS_DATA_WH WITH WAREHOUSE_SIZE='X-Large' ''').collect()
        session.sql('''USE WAREHOUSE NYTAXI_PROCESS_DATA_WH''').collect()

    with st.spinner(''' **2/4**  Currently Calculating nearest neighbours for all Dropoffs:- 
                        Snowflake is using an extract from **Carto Overture Maps** to find the nearest point of 
                        interest for each dropoff point'''
                , show_time=True):

        vehicle_plans_poi = vehicle_plans.join(places_in_newyork_D,call_function('ST_DWITHIN',vehicle_plans['DROPOFF_LOCATION'],places_in_newyork_D['GEOMETRY_D'],100),"left_outer")
    
        vehicle_plans_poi = vehicle_plans_poi.with_column('ORDER_DROPOFF',call_function('ST_DISTANCE',col('DROPOFF_LOCATION'),col('GEOMETRY_D')))
        vehicle_plans_poi = vehicle_plans_poi.with_column(
        "RN",
        row_number().over(window_spec_dropoff)
        )
        vehicle_plans_poi = vehicle_plans_poi.filter(col("RN") == 1).drop("RN",'GEOMETRY_D').write.mode(r).save_as_table('curated_vehicle_plans_1')

    with st.spinner('**3/4** Currently Calculating Nearest Neighbours for Pickups',show_time=True):
        vehicle_plans_poi = session.table('curated_vehicle_plans_1')
    

        vehicle_plans_poi = vehicle_plans_poi.join(places_in_newyork_P,call_function('ST_DWITHIN',vehicle_plans_poi['PICKUP_LOCATION'],places_in_newyork_P['GEOMETRY_P'],100),"left_outer")
        vehicle_plans_poi = vehicle_plans_poi.with_column('ORDER_PICKUP',call_function('ST_DISTANCE',col('PICKUP_LOCATION'),col('PICKUP_LOCATION'))).drop('GEOMETRY_P')

        vehicle_plans_poi = vehicle_plans_poi.with_column(
        "RN",
        row_number().over(window_spec_pickup)
        )
        vehicle_plans_poi = vehicle_plans_poi.filter(col("RN") == 1).drop("RN")

        vehicle_plans_poi = vehicle_plans_poi.with_column('ROUTE_DESCRIPTION',concat(col('PICKUP PLACE'),lit(' - '),col('DROPOFF PLACE')))


    
        vehicle_plans_poi.write.mode(r).save_as_table('curated_vehicle_plans')

    with st.spinner('**4/4** Applying all Routes to Trip History',show_time=True):

        all_vehicle_curated = session.table('curated_vehicle_plans').select('PICKUP PLACE','DROPOFF PLACE','TRIP_ID','ROUTE_DESCRIPTION')
        all_driver_locations = all_driver_locations.join(all_vehicle_curated,'TRIP_ID')#.order_by('POINT_TIME')
        all_driver_locations.write.mode(r).save_as_table('all_driver_locations')
      
    

if refresh == 1:
    r = 'overwrite'
    session.sql('''DROP WAREHOUSE IF EXISTS NYTAXI_PROCESS_DATA_WH ''').collect()
    session.sql(''' USE WAREHOUSE DEFAULT_WH''').collect()


success = st.markdown(f'''
  <h1grey style= 
    'background-color: rgb(113,221,220);
     opacity: 1;
     color: white;
     font-size:24px;
     padding-right: 30px;
     padding-left: 30px;
     font-family: Source Sans Pro;'>
     Data is now ready to view</style>
  ''', unsafe_allow_html=True)

refresh = 0
r = 'ignore'

vehicle_plans_poi = session.table('CURATED_VEHICLE_PLANS')
all_driver_locations = session.table('all_driver_locations')

driver_ids = vehicle_plans_poi


longest_trips = vehicle_plans_poi.order_by(col('DISTANCE').desc())
shortest_trips = vehicle_plans_poi.order_by(col('DISTANCE').asc())






#@st.cache_data
def drivers():
    return driver_ids.select('DRIVER_ID').distinct().to_pandas()



with st.sidebar:
    driver = st.selectbox('Choose Driver:',drivers())




def trips(driver):
    return driver_ids.filter(col('DRIVER_ID')== driver)\
        .group_by('TRIP_ID','ROUTE_DESCRIPTION').agg(min('DISTANCE').alias('DISTANCE')).sort(col('DISTANCE').desc()).to_pandas()


driver_day = vehicle_plans_poi.filter(col('DRIVER_ID')==driver)

top_pickup = driver_day.select('PICKUP PLACE').distinct().to_pandas()
top_dropoff = driver_day.select('DROPOFF PLACE').distinct().to_pandas()



vehicle_plans = session.table('CURATED_VEHICLE_PLANS')



time_by_hour = all_driver_locations.filter(col('DRIVER_ID')==driver)\
    .with_column('HOUR',hour(to_timestamp('POINT_TIME')))\
    .group_by('HOUR','ROUTE_DESCRIPTION').agg(max('DISTANCE').alias('DISTANCE'))

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



col1,col2 = st.columns(2)
with col1:
    st.altair_chart(chart_trips, use_container_width=True)
with col2:
    st.altair_chart(chart_distance, use_container_width=True)


with st.sidebar:

    driver_stats = driver_day.agg(count('*').alias('A'),sum('DISTANCE').alias('B')).to_pandas()
    st.markdown(f'<h1grey>TRIPS MADE TODAY <BR> </h1grey><h0blue> {driver_stats.A.iloc[0]}</h0blue>',unsafe_allow_html=True)
    st.markdown(f'<h1grey>TOTAL DISTANCE DRIVEN (KM) <BR> </h1grey><h0blue> {(driver_stats.B.iloc[0]/1000).round(2)}</h0blue>',unsafe_allow_html=True)
    st.markdown(f'<h1grey>AVG TRIPS PER HOUR <BR> </h1grey><h0blue> {int(perhour_stats.TRIPS.iloc[0])}</h0blue>',unsafe_allow_html=True)
    st.markdown(f'<h1grey>AVG DISTANCE PER HOUR (KM) <BR> </h1grey><h0blue> {(perhour_stats.DISTANCE.iloc[0]/1000).round(2)}</h0blue>',unsafe_allow_html=True)
    


with st.container():
    st.markdown(f'<h1grey>ROUTE DISTANCES FOR {driver} TODAY</h1grey>',unsafe_allow_html=True)
    cola,colb = st.columns(2)
    with cola:
        st.markdown('<h1sub>Shortest Routes</h1sub>',unsafe_allow_html=True)
    
        shortest_trips_f = shortest_trips.filter(col('DRIVER_ID')==driver).sort(col('DISTANCE').asc()).limit(5)
        event1 = st.altair_chart(bar_creation(shortest_trips_f,'DISTANCE','ROUTE_DESCRIPTION'))
            

    with colb:
        st.markdown('<h1sub>Longest Routes</h1sub>',unsafe_allow_html=True)
            
        longest_trips_f = longest_trips.filter(col('DRIVER_ID')==driver).sort(col('DISTANCE').desc()).limit(5)
        event2 = st.altair_chart(bar_creation(longest_trips_f,'DISTANCE','ROUTE_DESCRIPTION'))



st.divider()

st.markdown('<h1black> Viewing Details of individual Routes </h1black>',unsafe_allow_html=True)

col1,col2 = st.columns(2)
with col1:
    selected_route = st.selectbox('Choose Trip (Sorted longest to shortest): ', trips(driver).ROUTE_DESCRIPTION)
    
trip_id = trips(driver).query(f'''ROUTE_DESCRIPTION == "{selected_route}" ''').TRIP_ID.iloc[0]








driver_locations = all_driver_locations.filter(col('TRIP_ID')==trip_id)
driver_locations = driver_locations.with_column('POINT_TIME',col('POINT_TIME'))



selected_trip = vehicle_plans.filter(col('TRIP_ID')==trip_id)

selected_trip = selected_trip.with_column('LONP',call_function('ST_X',col('PICKUP_LOCATION')))
selected_trip = selected_trip.with_column('LATP',call_function('ST_Y',col('PICKUP_LOCATION')))

selected_trip = selected_trip.with_column('LOND',call_function('ST_X',col('DROPOFF_LOCATION')))
selected_trip = selected_trip.with_column('LATD',call_function('ST_Y',col('DROPOFF_LOCATION')))
selected_trip = selected_trip.with_column('DISTANCE',div0(call_function('ST_LENGTH',col('ROUTE')),1000))







           


times = driver_locations.select(col('POINT_TIME').astype(StringType()).alias('POINT_TIME')).to_pandas()
times['POINT_TIME'] = pd.to_datetime(times['POINT_TIME'],errors='coerce')
times['POINT_TIME'] = times['POINT_TIME'].dt.strftime('%Y-%m-%d %H:%M:%S')
with col2:
    Choose_Time = st.select_slider("Choose Timestamp:", times )






driver_locations = driver_locations.filter(to_timestamp('POINT_TIME')==to_timestamp(lit(Choose_Time)))



main_container = st.container(height=1000)
with main_container:

    

    driver_locations = driver_locations.with_column('DIRECTIONS',
                                                    call_function('OPEN_ROUTE_SERVICE_NEW_YORK.CORE.DIRECTIONS',
                                                                  'driving-car',call_function('ST_ASGEOJSON',col('POINT_GEOM'))['coordinates'],
                                                                                              call_function('ST_ASGEOJSON',col('DROPOFF_LOCATION'))['coordinates']))

    driver_locations = driver_locations.with_column('DURATION',col('directions')['features'][0]['properties']['summary']['duration'].astype(FloatType()))
    driver_locations = driver_locations.with_column('DISTANCE',col('directions')['features'][0]['properties']['summary']['distance'].astype(FloatType()))
    driver_locations = driver_locations.with_column('DISTANCE',round(div0('DISTANCE',1000),2))
    driver_locations = driver_locations.with_column('DURATION',div0('DURATION',60))
    driver_locations = driver_locations.with_column('TOTAL_DISTANCE',round(div0(call_function('ST_LENGTH',col('ROUTE')),1000),2))
    driver_locations = driver_locations.with_column('ROUTE',col('directions')['features'][0]['geometry'])
    
   

    st.markdown(f'''
        <h1sub>DISTANCE IN KILOMETERS:</h1sub> <h1grey>{driver_locations.to_pandas().TOTAL_DISTANCE.iloc[0].round(2)} | </h1grey>
        <h1sub>DISTANCE LEFT:</h1sub> <h1grey>{driver_locations.to_pandas().DISTANCE.iloc[0].round(2)} | </h1grey>
        <h1sub>TIME LEFT IN MINUTES:</h1sub> <h1grey>{driver_locations.to_pandas().DURATION.iloc[0].round(2)}</h1grey>
        ''', unsafe_allow_html=True)
    
 
    
    

    

   
    
    
    
   
    
    



pickup = selected_trip.select(concat(lit('Pickup Location: '),
                                               col('PICKUP PLACE'),
                                               lit('<br>Pickup Time: '),
                                                concat(hour(col('PICKUP_TIME')),
                                                       lit(':'),
                                                      minute(col('PICKUP_TIME')),
                                                       lit(':'),
                                                      second(col('PICKUP_TIME')))).alias('TOOLTIP'),
                                                'TRIP_ID','LONP','LATP')


dropoff = selected_trip.select(concat(lit('Dropoff Location: '),
                                               col('DROPOFF PLACE'),
                                               lit('<br>Dropoff Time: '),
                                                concat(hour(col('DROPOFF_TIME')),
                                                       lit(':'),
                                                      minute(col('DROPOFF_TIME')),
                                                       lit(':'),
                                                      second(col('DROPOFF_TIME')))).alias('TOOLTIP'),
                                                'TRIP_ID','LOND','LATD')




driver_locations = driver_locations.drop('PICKUP_LOCATION','PICKUP_TIME','DROPOFF_TIME')
driver_locations = driver_locations.select(concat(lit('Duration: '),
                                               round('DURATION',2),
                                               lit('<br> Current Time: '),
                                                concat(hour(to_timestamp('POINT_TIME')),
                                                       lit(':'),
                                                      minute(to_timestamp('POINT_TIME')),
                                                       lit(':'),
                                                      second(to_timestamp('POINT_TIME')))).alias('TOOLTIP'),
                                                'TRIP_ID','LON','LAT','POINT_TIME','DURATION','ROUTE')

driver_locationspd = driver_locations.drop('ROUTE').to_pandas()

pickuppd = pickup.to_pandas()
dropoffpd = dropoff.to_pandas()
selected_trip = selected_trip.with_column('AI_AGG',object_construct(lit("Driver ID"),"DRIVER_ID", 
                                                                     lit("Trip ID"),"TRIP_ID", 
                                                                     lit("DISTANCE_IN_METERS"),call_function('ST_LENGTH',col('ROUTE')),
                                                                     lit("Pickup Time"),"PICKUP_TIME", 
                                                                     lit("Pickup Location"),call_function('ST_ASGEOJSON',
                                                                                                          col("PICKUP_LOCATION")), 
                                                                     lit("Dropoff Location"),call_function('ST_ASGEOJSON',
                                                                                                           col("DROPOFF_LOCATION")), 
                                                                     lit("Dropoff Time"),"DROPOFF_TIME", 
                                                                     lit("Dropoff Place"),"DROPOFF PLACE", 
                                                                     lit("Order Dropoff"),"ORDER_DROPOFF", 
                                                                     lit("Pickup Place"),"PICKUP PLACE").astype(StringType()))


@st.cache_data
def ai_summarize(trip_id):
    return selected_trip.agg(call_function('AI_AGG',col('AI_AGG'),
                                           '''summarize the provided a descriptive vehicle trip,
                                            clearly using markdown with HTML styling.  Use the follwing template: 
                                            <h1sub>Trip Details using Snowflake's **AI_AGG** </h1sub><br>
                                            - <h1grey>Pickup Location</h1grey></br>
                                            - <h1grey>Time of Journey</h1grey><br>
                                            **Pickup** The time in hh:mm:ss</br>
                                            **Dropoff** the time in hh:mm:ss</br>
                                            Comments around journey time and how this relates
                                            to the pickup and dropoff destination.<br>
                
                                            Information about the location<br>
                                            - <h1grey>Location Dropoff</h1grey></br>
                                            Information about the location<h1grey><br>
                                            - <h1grey>Hypothosis on what the trip might be about<h1grey><br>
                                            This is a taxi trip - so please describe what the trip
                                            might be for.  If cooridinates are mentioned, please round to
                                            5 decimal places.
                
                                            
                                            
                                            A style sheet will be used for this''').astype(StringType())).collect()[0][0]


routes = selected_trip.with_column('TOOLTIP',
                                  concat(lit('Pickup Location'), col('PICKUP PLACE')))

routespd = routes.to_pandas()
routespd["coordinates"] = routespd["ROUTE"].apply(lambda row: json.loads(row)["coordinates"])


driver_locations = driver_locations.with_column('TOOLTIP',concat(lit('Current Time'),col('POINT_TIME')))
routespd2 = driver_locations.to_pandas()
routespd2["coordinates"] = routespd2["ROUTE"].apply(lambda row: json.loads(row)["coordinates"])

center = selected_trip.with_column('CENTER',call_function('ST_CENTROID',call_function('ST_ENVELOPE',(call_function('st_collect',col('PICKUP_LOCATION'),col('DROPOFF_LOCATION'))))))
center = center.select('CENTER')
center = center.with_column('LON',call_function('ST_X',col('CENTER')))
center = center.with_column('LAT',call_function('ST_Y',col('CENTER'))).to_pandas()
LAT = center.LAT.iloc[0]
LON = center.LON.iloc[0]

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


 # Create scatter layer for restaurants
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

vehicle_1_path = pdk.Layer(
type="PathLayer",
data=routespd,
pickable=False,
get_color=[0, 0, 0],
width_scale=20,
width_min_pixels=4,
width_max_pixels=7,
get_path="coordinates",
get_width=5)

vehicle_1_path2 = pdk.Layer(
type="PathLayer",
data=routespd2,
pickable=False,
get_color=[253, 180, 107],
width_scale=20,
width_min_pixels=4,
width_max_pixels=7,
get_path="coordinates",
get_width=5)


routes = selected_trip



    

view_state = pdk.ViewState(latitude=LAT, longitude=LON, zoom=11)

with main_container:
    col1,col2 = st.columns([0.4,0.6])
    with col1:
        st.markdown(ai_summarize(trip_id), unsafe_allow_html=True)
    with col2:
        st.markdown('<h1sub> map containing routing analysis the **Open Route Service** native app</h1sub>',
                   unsafe_allow_html=True)
        st.pydeck_chart(pdk.Deck(tooltip=tooltip,layers=[vehicle_1_path,vehicle_1_path2,slayer,sroutes,current_location],map_style=None,initial_view_state=view_state),height=800)