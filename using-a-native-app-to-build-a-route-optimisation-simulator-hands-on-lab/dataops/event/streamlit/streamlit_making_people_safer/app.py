# Import python packages
import streamlit as st
from snowflake.snowpark.context import get_active_session
from snowflake.snowpark.functions import *
from snowflake.snowpark.types import *
import pydeck as pdk
import json
import pandas as pd
import plotly.express as px

# Get the current credentials
session = get_active_session()
st.set_page_config(layout="wide")

def format_ai_analysis(response):
    """Enhanced formatting function for AI analysis response with consistent heading hierarchy"""
    lines = response.split('\n')
    formatted_lines = []
    
    for line in lines:
        original_line = line
        line = line.strip()
        if not line:
            formatted_lines.append('<br>')
            continue
        
        # Remove hash symbols from headers and clean up
        clean_line = line.lstrip('#').strip()
        if not clean_line:
            continue
        
        # Detect main numbered headings (## 1. Executive Summary, ## 2. Customer Risk, etc.)
        import re
        main_heading_pattern = r'^(\d+)\.\s*(.+)$'
        main_heading_match = re.match(main_heading_pattern, clean_line)
        
        if main_heading_match:
            # This is a main numbered heading - use h1black
            number = main_heading_match.group(1)
            title = main_heading_match.group(2).strip()
            
            # Add proper icons for main headings
            if any(x in title.upper() for x in ['EXECUTIVE', 'SUMMARY']):
                formatted_lines.append(f'<h1black>📊 {number}. {title.upper()}</h1black>')
            elif any(x in title.upper() for x in ['CUSTOMER', 'RISK']):
                formatted_lines.append(f'<h1black>👥 {number}. {title.upper()}</h1black>')
            elif any(x in title.upper() for x in ['INFRASTRUCTURE', 'TOWER']):
                formatted_lines.append(f'<h1black>📡 {number}. {title.upper()}</h1black>')
            elif any(x in title.upper() for x in ['WILDFIRE', 'THREAT', 'FIRE']):
                formatted_lines.append(f'<h1black>🔥 {number}. {title.upper()}</h1black>')
            elif any(x in title.upper() for x in ['RECOMMENDATION', 'STRATEGIC']):
                formatted_lines.append(f'<h1black>💡 {number}. {title.upper()}</h1black>')
            else:
                formatted_lines.append(f'<h1black>📋 {number}. {title.upper()}</h1black>')
            
            # Add carriage return after main headings
            formatted_lines.append('<br>')
            continue
        
        # Detect sub-headings (all caps lines, lines ending with :, or specific patterns)
        elif (clean_line.isupper() and len(clean_line) > 3) or clean_line.endswith(':') or \
             any(x in clean_line.upper() for x in ['KEY RISK INDICATORS', 'THREAT LEVELS', 'GEOGRAPHIC DISTRIBUTION', 
                                                  'TEMPORAL PATTERN', 'AGENCY DISTRIBUTION', 'IMMEDIATE ACTIONS', 
                                                  'CUSTOMER SERVICE', 'NETWORK RESILIENCE', 'LONG-TERM STRATEGIES',
                                                  'HISTORICAL FIRE DATA', 'CELL TOWER STATUS', 'RECENT SIGNIFICANT FIRES']):
            
            # This is a sub-heading - use h1sub
            header_text = clean_line.replace(':', '').strip()
            
            # Add appropriate icons for sub-headings
            if any(x in header_text.upper() for x in ['KEY RISK', 'INDICATORS']):
                formatted_lines.append(f'<h1sub>🎯 {header_text.upper()}</h1sub>')
            elif any(x in header_text.upper() for x in ['THREAT LEVELS', 'HIGH RISK']):
                formatted_lines.append(f'<h1sub>⚠️ {header_text.upper()}</h1sub>')
            elif any(x in header_text.upper() for x in ['GEOGRAPHIC', 'DISTRIBUTION', 'LOCATION']):
                formatted_lines.append(f'<h1sub>🗺️ {header_text.upper()}</h1sub>')
            elif any(x in header_text.upper() for x in ['TEMPORAL', 'PATTERN', 'TIME', 'HISTORICAL']):
                formatted_lines.append(f'<h1sub>📅 {header_text.upper()}</h1sub>')
            elif any(x in header_text.upper() for x in ['FIRE', 'WILDFIRE']):
                formatted_lines.append(f'<h1sub>🔥 {header_text.upper()}</h1sub>')
            elif any(x in header_text.upper() for x in ['CELL TOWER', 'TOWER', 'INFRASTRUCTURE']):
                formatted_lines.append(f'<h1sub>📡 {header_text.upper()}</h1sub>')
            elif any(x in header_text.upper() for x in ['IMMEDIATE', 'ACTIONS', 'RECOMMENDATIONS']):
                formatted_lines.append(f'<h1sub>⚡ {header_text.upper()}</h1sub>')
            elif any(x in header_text.upper() for x in ['CUSTOMER', 'SERVICE']):
                formatted_lines.append(f'<h1sub>👥 {header_text.upper()}</h1sub>')
            elif any(x in header_text.upper() for x in ['NETWORK', 'RESILIENCE']):
                formatted_lines.append(f'<h1sub>🔗 {header_text.upper()}</h1sub>')
            elif any(x in header_text.upper() for x in ['STRATEGIC', 'LONG-TERM']):
                formatted_lines.append(f'<h1sub>🎯 {header_text.upper()}</h1sub>')
            else:
                formatted_lines.append(f'<h1sub>📌 {header_text.upper()}</h1sub>')
            
            # Add carriage return after sub-headings
            formatted_lines.append('<br>')
            continue
        
        # Format bullet points with enhanced styling
        elif line.startswith('•') or line.startswith('-') or line.startswith('*'):
            bullet_content = line[1:].strip()
            if 'high risk' in bullet_content.lower() or 'critical' in bullet_content.lower():
                formatted_lines.append(f'<div style="margin-left: 20px; margin-bottom: 8px;"><span style="color: #E63946; font-weight: bold;">🔴</span> <span style="color: #24323D; font-weight: 500;">{bullet_content}</span></div>')
            elif 'medium risk' in bullet_content.lower() or 'moderate' in bullet_content.lower():
                formatted_lines.append(f'<div style="margin-left: 20px; margin-bottom: 8px;"><span style="color: #FF9F36; font-weight: bold;">🟠</span> <span style="color: #24323D; font-weight: 500;">{bullet_content}</span></div>')
            elif 'low risk' in bullet_content.lower() or 'safe' in bullet_content.lower():
                formatted_lines.append(f'<div style="margin-left: 20px; margin-bottom: 8px;"><span style="color: #29B5E8; font-weight: bold;">🔵</span> <span style="color: #24323D; font-weight: 500;">{bullet_content}</span></div>')
            else:
                formatted_lines.append(f'<div style="margin-left: 20px; margin-bottom: 8px;"><span style="color: #29B5E8; font-weight: bold;">▸</span> <span style="color: #24323D; font-weight: 500;">{bullet_content}</span></div>')
        
        # Format numbered lists
        elif line and line[0].isdigit() and '.' in line[:3]:
            formatted_lines.append(f'<div style="margin-left: 15px; margin-bottom: 8px; color: #24323D; font-weight: 500;"><span style="color: #29B5E8; font-weight: bold;">{line[:2]}</span>{line[2:]}</div>')
        
        # Format special data sections with better styling
        elif any(pattern in line.upper() for pattern in ['CDF:', 'CCO:', 'USF:', 'TOTAL AT-RISK', 'UNIQUE TOWER', 'LATITUDE RANGE', 'LONGITUDE RANGE', 'CLUSTERING PATTERN']):
            formatted_lines.append(f'<div style="margin-left: 15px; margin-bottom: 6px; color: #24323D; font-weight: 500; background-color: #F8F9FA; padding: 8px; border-left: 3px solid #29B5E8; border-radius: 4px;">{line}</div>')
        
        # Format fire names and years with special highlighting
        elif any(pattern in line.upper() for pattern in ['2020 BLUE RIDGE', '2017 CANYON', '2008 FREEWAY', 'CONSISTENT FIRE ACTIVITY', 'PEAK INCIDENTS']):
            formatted_lines.append(f'<div style="margin-left: 15px; margin-bottom: 6px; color: #E63946; font-weight: 600; background-color: #FFF5F5; padding: 6px; border-radius: 4px;">🔥 {line}</div>')
        
        # Regular paragraphs with improved spacing
        else:
            formatted_lines.append(f'<div style="margin-bottom: 12px; color: #24323D; line-height: 1.6; font-weight: 400;">{line}</div>')
    
    return '\n'.join(formatted_lines)

### ADD THEMING
logo = 'logo.svg'
esri = 'esri.png'
with open('extra.css') as ab:
    st.markdown(f"<style>{ab.read()}</style>", unsafe_allow_html=True)

st.logo(logo)

customers = session.table('WILDFIRES_DB.PUBLIC.CUSTOMER_LOYALTY_DETAILS')
towers = session.table('WILDFIRES_DB.PUBLIC.CELL_TOWERS_WITH_COMPLETED_RISK_SCORE')
fires = session.table('WILDFIRES_DB.PUBLIC.CALIFORNIA_FIRE_PERIMITER')


st.markdown('<h0black>VIEWING OUR CUSTOMERS AND ARE THEY | </h0black><h0blue>AT RISK??</h0blue>',unsafe_allow_html=True)
st.markdown('''This **Streamlit application** shows an art of the possible when you combine **Snowflake** Data with the **Living Atlas**. The dataset below shows the fire perimeters to indicate at risk customers and cell towers.

Combining this with AI insights allows quick text based analysis - offering a complete picture of the situation. **Living Atlas** is just one of many possibilities, which can also include outputs from trained models seamlessly transformed by interoperability.

To view information, select a county and street. It will only offer streets that were close to a fire - select the time range and you will see the number of distinct fire names. Use the layer toggles to control map visibility, then click the AI Analysis button for detailed insights.''')

# Quality Metrics Display (will be populated after sidebar selections)
metrics_placeholder = st.empty()

# Cached function for processing map data
@st.cache_data
def process_map_data(chosen_county, chosen_street, meters, year_range):
    """Process and cache map visualization data"""
    try:
        # Get filtered customer data
        county_data = customers.filter(col('GEOMETRY').is_not_null()).filter(col('COUNTY')==chosen_county)
        
        # Get street point and filter by distance
        try:
            street_point = county_data.filter(col('"street"')==chosen_street).select('"Centroid"').limit(1)
            if street_point.count() > 0:
                # Get the street centroid value to avoid column ambiguity
                street_centroid = street_point.select('"Centroid"').collect()[0]['Centroid']
                # Filter customers within distance of the street point
                filtered_customers = county_data.filter(
                    call_function('ST_DWITHIN',
                                call_function('TO_GEOGRAPHY', county_data['"Centroid"']),
                                call_function('TO_GEOGRAPHY', street_centroid), 
                                meters)==True)
            else:
                filtered_customers = county_data.limit(0)
        except Exception as geo_error:
            # Fallback: use all customers in the county if spatial filtering fails
            filtered_customers = county_data
        
        # Get filtered fires
        filtered_fires = fires.filter(col('YEAR_').between(year_range[0], year_range[1]))
        
        # Process customer data for mapping
        try:
            data_for_map = filtered_customers.group_by('FIRST_NAME',
                                'LAST_NAME',
                                'EMAIL',
                                'GENDER',
                                'STATUS',
                                'PHONE_NUMBER',
                                'POINTS').agg(any_value(col('GEOMETRY')).alias('GEOMETRY'))
            
            # Add colors to customer data
            data_for_map = data_for_map.with_column(
                'COLOR',
                when(col('STATUS') == 'Gold', [259, 159, 54])
                .when(col('STATUS') == 'Silver', [160, 153, 158])
                .when(col('STATUS') == 'Bronze', [61,0,69])
                .otherwise([262, 255, 255])
            )
            data_for_map = data_for_map.with_column('R',col('COLOR')[0])
            data_for_map = data_for_map.with_column('G',col('COLOR')[1])
            data_for_map = data_for_map.with_column('B',col('COLOR')[2])
            data_for_map = data_for_map.drop('COLOR')  # No limit - spatial filtering provides natural bounds
            
            # Convert to pandas
            datapd = data_for_map.to_pandas()
            
            if not datapd.empty and 'GEOMETRY' in datapd.columns:
                datapd["coordinates"] = datapd['GEOMETRY'].apply(lambda row: json.loads(row)["coordinates"] if row else [])
            else:
                datapd["coordinates"] = [[0, 0] for _ in range(len(datapd))]
                
            # Add tooltip for customer layer
            if not datapd.empty:
                datapd["TOOLTIP"] = datapd.apply(lambda row: f"""
<b>🏠 CUSTOMER</b><br>
<b>Name:</b> {row.get('FIRST_NAME', 'N/A')} {row.get('LAST_NAME', 'N/A')}<br>
<b>Email:</b> {row.get('EMAIL', 'N/A')}<br>
<b>Status:</b> {row.get('STATUS', 'N/A')}<br>
<b>Points:</b> {row.get('POINTS', 'N/A')}<br>
<b>Phone:</b> {row.get('PHONE_NUMBER', 'N/A')}
                """.strip(), axis=1)
        except Exception:
            datapd = pd.DataFrame(columns=['FIRST_NAME', 'LAST_NAME', 'coordinates', 'R', 'G', 'B', 'TOOLTIP'])
        
        # Process fire polygon data (use the spatially filtered fires)
        try:
            # Make sure we're using the spatially filtered fires, not the original year-filtered ones
            spatially_filtered_fires = filtered_fires
            
            # Apply the same spatial filtering as in the metrics calculation
            if filtered_customers.count() > 0:
                envelope = filtered_customers.select('"Centroid"')
                envelope = envelope.select(call_function('ST_ENVELOPE',(call_function('ST_COLLECT',col('"Centroid"')))).alias('ENVELOPE'))
                envelope_geom = envelope.collect()[0]['ENVELOPE']
                spatially_filtered_fires = filtered_fires.filter(call_function('ST_DWITHIN', 
                                                                               call_function('TO_GEOGRAPHY', envelope_geom), 
                                                                               call_function('TO_GEOGRAPHY', filtered_fires['GEOM']), 1500))
            
            fire_polygon = spatially_filtered_fires.to_pandas()  # Use the properly filtered fires
            if not fire_polygon.empty and 'GEOM' in fire_polygon.columns:
                fire_polygon["GEOM"] = fire_polygon["GEOM"].apply(lambda row: json.loads(row)["coordinates"] if row else [])
                fire_polygon["TOOLTIP"] = fire_polygon.apply(lambda row: f"""
<b>🔥 WILDFIRE</b><br>
<b>Fire Name:</b> {row.get('FIRE_NAME', 'N/A')}<br>
<b>Agency:</b> {row.get('AGENCY', 'N/A')}<br>
<b>Year:</b> {row.get('YEAR_', 'N/A')}<br>
<b>Acres:</b> {row.get('GIS_ACRES', 'N/A')}<br>
<b>Cause:</b> {row.get('CAUSE', 'N/A')}<br>
<b>Status:</b> Fire Perimeter
                """.strip(), axis=1)
            else:
                fire_polygon = pd.DataFrame(columns=['FIRE_NAME', 'AGENCY', 'YEAR_', 'GEOM', 'TOOLTIP'])
        except Exception:
            fire_polygon = pd.DataFrame(columns=['FIRE_NAME', 'AGENCY', 'YEAR_', 'GEOM', 'TOOLTIP'])
        
        # Process tower data (use the spatially filtered fires)
        try:
            towers_filtered = towers.join(spatially_filtered_fires, call_function('ST_DWITHIN',
                                                                       call_function('TO_GEOGRAPHY', towers['"geo"']),
                                                                       call_function('TO_GEOGRAPHY', spatially_filtered_fires['GEOM']),
                                                                       4000))
            towers_filtered = towers_filtered.withColumn(
                'COLOR',
                when(col('AT_RISK') == 0, [0, 53, 69]).otherwise([255, 191, 0])
            )
            towers_filtered = towers_filtered.with_column('R',col('COLOR')[0])
            towers_filtered = towers_filtered.with_column('G',col('COLOR')[1])
            towers_filtered = towers_filtered.with_column('B',col('COLOR')[2])
            
            towerpd = towers_filtered.select('"CELL_ID"','"LATITUDE"','"LONGITUDE"','"RANGE"','"AT_RISK"','R','G','B').to_pandas()  # No limit - spatial filtering provides natural bounds
            
            if not towerpd.empty:
                towerpd["TOOLTIP"] = towerpd.apply(lambda row: f"""
<b>📡 CELL TOWER</b><br>
<b>Tower ID:</b> {row.get('CELL_ID', 'N/A')}<br>
<b>Location:</b> {float(row.get('LATITUDE', 0)):.4f}, {float(row.get('LONGITUDE', 0)):.4f}<br>
<b>Range:</b> {int(row.get('RANGE', 0))} meters<br>
<b>At Risk:</b> {'Yes' if int(row.get('AT_RISK', 0)) == 1 else 'No'}<br>
<b>Status:</b> {'⚠️ High Risk' if int(row.get('AT_RISK', 0)) == 1 else '✅ Safe'}
                """.strip(), axis=1)
        except Exception as tower_error:
            towerpd = pd.DataFrame(columns=['"CELL_ID"','"LATITUDE"','"LONGITUDE"','"RANGE"','"AT_RISK"','R','G','B','TOOLTIP'])
        
        # Calculate center point
        try:
            latlon = filtered_customers.agg(avg('LAT').alias('LAT'), avg('LON').alias('LON')).to_pandas()
            if latlon.empty:
                latlon = pd.DataFrame({'LAT': [34.0522], 'LON': [-118.2437]})
        except Exception:
            latlon = pd.DataFrame({'LAT': [34.0522], 'LON': [-118.2437]})
        
        return {
            'customer_data': datapd,
            'fire_data': fire_polygon,
            'tower_data': towerpd,
            'center': latlon
        }
        
    except Exception as e:
        # Return empty data on error
        return {
            'customer_data': pd.DataFrame(columns=['coordinates', 'R', 'G', 'B', 'TOOLTIP']),
            'fire_data': pd.DataFrame(columns=['GEOM', 'TOOLTIP']),
            'tower_data': pd.DataFrame(columns=['"LATITUDE"','"LONGITUDE"','R','G','B','TOOLTIP']),
            'center': pd.DataFrame({'LAT': [34.0522], 'LON': [-118.2437]})
        }

# Cached function for calculating quality metrics
@st.cache_data
def calculate_metrics(chosen_county, chosen_street, meters, year_range):
    """Calculate quality metrics for the current selection"""
    try:
        # Get filtered customer data
        county_data = customers.filter(col('GEOMETRY').is_not_null()).filter(col('COUNTY')==chosen_county)
        
        # Get street point and filter by distance
        try:
            street_point = county_data.filter(col('"street"')==chosen_street).select('"Centroid"').limit(1)
            if street_point.count() > 0:
                filtered_customers = county_data.join(street_point, 
                                                    call_function('ST_DWITHIN',
                                                                call_function('TO_GEOGRAPHY', county_data['"Centroid"']),
                                                                call_function('TO_GEOGRAPHY', street_point['"Centroid"']), 
                                                                meters)==True, rsuffix='_street')
            else:
                filtered_customers = county_data.limit(0)  # Empty result
        except Exception:
            # Fallback: use all customers in the county
            filtered_customers = county_data
        
        # Get filtered fires by year range
        filtered_fires = fires.filter(col('YEAR_').between(year_range[0], year_range[1]))
        
        # Further filter fires by proximity to the selected street/area (using envelope like in sidebar)
        try:
            if filtered_customers.count() > 0:
                envelope = filtered_customers.select('"Centroid"')
                envelope = envelope.select(call_function('ST_ENVELOPE',(call_function('ST_COLLECT',col('"Centroid"')))).alias('ENVELOPE'))
                envelope_geom = envelope.collect()[0]['ENVELOPE']
                filtered_fires = filtered_fires.filter(call_function('ST_DWITHIN', 
                                                                   call_function('TO_GEOGRAPHY', envelope_geom), 
                                                                   call_function('TO_GEOGRAPHY', filtered_fires['GEOM']), 1500))
        except Exception as spatial_error:
            # Use all fires if envelope filtering fails
            pass
        
        # Get towers near the filtered fires
        try:
            filtered_towers = towers.join(filtered_fires, 
                                        call_function('ST_DWITHIN',
                                                    call_function('TO_GEOGRAPHY', towers['"geo"']), 
                                                    call_function('TO_GEOGRAPHY', filtered_fires['GEOM']), 4000))
        except Exception:
            filtered_towers = towers.limit(0)  # No towers if join fails
        
        # Calculate metrics based on filtered data
        num_customers = filtered_customers.count()
        num_fires = filtered_fires.select('FIRE_NAME').distinct().count()
        
        # At-risk customers (those near the filtered fires)
        try:
            at_risk_customers = filtered_customers.join(filtered_fires,
                                                      call_function('ST_DWITHIN',
                                                                  call_function('TO_GEOGRAPHY', filtered_customers['"Centroid"']),
                                                                  call_function('TO_GEOGRAPHY', filtered_fires['GEOM']), 1000)).count()
        except:
            at_risk_customers = 0
            
        # At-risk towers (from the filtered towers)
        try:
            at_risk_towers = filtered_towers.filter(col('"AT_RISK"')==1).count()
        except:
            at_risk_towers = 0
            
        return {
            'customers': num_customers,
            'fires': num_fires,
            'at_risk_customers': at_risk_customers,
            'at_risk_towers': at_risk_towers
        }
    except Exception as e:
        return {
            'customers': 0,
            'fires': 0,
            'at_risk_customers': 0,
            'at_risk_towers': 0
        }

with st.sidebar:
    try:
        data = customers.filter(col('GEOMETRY').is_not_null())
        
        # AT_RISK toggle
        at_risk_only = st.toggle('AT_RISK Only', value=False, help='Show only counties with at-risk locations')

        @st.cache_data
        def countiesf(at_risk_filter=False):
            try:
                # Get counties with fire counts for sorting
                county_points = data.group_by('COUNTY').agg(
                    avg('LAT').alias('LAT'),
                    avg('LON').alias('LON'),
                    count('*').alias('CUSTOMER_COUNT')
                )
                county_points = county_points.select('COUNTY', 'CUSTOMER_COUNT',
                                               call_function('ST_MAKEPOINT',col('LON'),
                                                           col('LAT')).alias('COUNTY_POINT'))
                
                # Join with fires to count nearby fires per county
                try:
                    county_fires = county_points.join(fires, call_function('ST_DWITHIN',
                                                                                call_function('TO_GEOGRAPHY', county_points['COUNTY_POINT']),
                                                                                call_function('TO_GEOGRAPHY', fires['GEOM']), 50000))  # 50km buffer for county-level
                    county_fire_counts = county_fires.group_by('COUNTY', 'CUSTOMER_COUNT').agg(
                        countDistinct('FIRE_NAME').alias('FIRE_COUNT')
                    )
                    
                    # Filter for at-risk counties if toggle is on
                    if at_risk_filter:
                        county_fire_counts = county_fire_counts.filter(col('FIRE_COUNT') > 0)
                    
                    # Sort by fire count descending, then by customer count descending
                    counties_sorted = county_fire_counts.sort([col('FIRE_COUNT').desc(), col('CUSTOMER_COUNT').desc()])
                    return counties_sorted.select('COUNTY', 'FIRE_COUNT').to_pandas()
                except Exception as fire_join_error:
                    # Fallback: sort by customer count only
                    counties_sorted = county_points.sort(col('CUSTOMER_COUNT').desc())
                    return counties_sorted.select('COUNTY').to_pandas()
                    
            except Exception as e:
                st.error(f"Error loading counties: {str(e)}")
                return pd.DataFrame({'COUNTY': ['Los Angeles', 'Orange', 'Riverside']})

        
        with st.container():
            counties_df = countiesf(at_risk_only)
            if not counties_df.empty:
                chosen_county = st.selectbox('Choose County:', counties_df['COUNTY'].tolist())
            else:
                chosen_county = 'Los Angeles'

        data = data.filter(col('COUNTY')==chosen_county)

        try:
            latlon = data.agg(avg('LAT').alias('LAT'), avg('LON').alias('LON'))
            streets = data.group_by('"street"').agg(avg('LAT').alias('LAT'),avg('LON').alias('LON'))

            streets = streets.select('"street"',
            call_function('ST_MAKEPOINT',col('LON'),
            col('LAT')).alias('POINTD'))

            # Get streets with fire counts for sorting
            try:
                streets_with_fires = streets.join(fires, call_function('ST_DWITHIN',
                                               call_function('TO_GEOGRAPHY', streets['POINTD']),
                                               call_function('TO_GEOGRAPHY', fires['GEOM']), 10000))  # 10km buffer
                # Count fires per street and keep the point data
                streets = streets_with_fires.group_by('"street"').agg(
                        any_value('POINTD').alias('POINTD'),
                        countDistinct('FIRE_NAME').alias('FIRE_COUNT')
                    )
            except Exception as join_error:
                st.warning(f"Using all streets due to join issue: {str(join_error)}")
                # Fallback: use all streets with zero fire count
                streets = streets.with_column('FIRE_COUNT', lit(0))

            latlon = latlon.select(call_function('ST_MAKEPOINT',col('LON'),
            col('LAT')).alias('POINTO'))

            streets = streets.join(latlon)
    
        except Exception as e:
            st.error(f"Error processing street data: {str(e)}")
            # Create fallback data
            streets = session.create_dataframe([
                ('Main Street',), ('Oak Avenue',), ('Pine Street',)
            ], schema=['"street"'])

        @st.cache_data
        def f_street(chosen_county, distance_meters=500):
            try:
                # Filter streets by fires within the specified distance range
                # Re-calculate fire counts based on the distance parameter
                try:
                    # Get street points for the chosen county
                    county_streets = data.group_by('"street"').agg(avg('LAT').alias('LAT'),avg('LON').alias('LON'))
                    county_streets = county_streets.select('"street"',
                                               call_function('ST_MAKEPOINT',col('LON'),
                                                             col('LAT')).alias('POINTD'))
                    
                    # Join with fires using the specified distance
                    streets_with_fires = county_streets.join(fires, call_function('ST_DWITHIN',
                                                                                      call_function('TO_GEOGRAPHY', county_streets['POINTD']),
                                                                                      call_function('TO_GEOGRAPHY', fires['GEOM']), distance_meters))
                    # Count fires per street within the distance
                    streets_fire_counts = streets_with_fires.group_by('"street"').agg(
                        any_value('POINTD').alias('POINTD'),
                        countDistinct('FIRE_NAME').alias('FIRE_COUNT')
                    )
                    
                    # Sort by fire count descending, then alphabetically by street name
                    streets_sorted = streets_fire_counts.sort([col('FIRE_COUNT').desc(), col('"street"')]).filter(col('"street"')!='')
                    return streets_sorted.select(col('"street"').alias('street'), 'FIRE_COUNT').to_pandas()
                except Exception as distance_error:
                    # Fallback to original streets data
                    streets_sorted = streets.sort([col('FIRE_COUNT').desc(), col('"street"')]).filter(col('"street"')!='')
                    return streets_sorted.select(col('"street"').alias('street'), 'FIRE_COUNT').to_pandas()
            except Exception as e:
                st.error(f"Error loading streets: {str(e)}")
                return pd.DataFrame({'street': ['Main Street', 'Oak Avenue', 'Pine Street'], 'FIRE_COUNT': [0, 0, 0]})
                
    except Exception as e:
        st.error(f"Error in sidebar setup: {str(e)}")
        # Create minimal fallback interface
        chosen_county = st.selectbox('Choose County:', ['Los Angeles', 'Orange', 'Riverside'])

        @st.cache_data
        def f_street(chosen_county, distance_meters=500):
            return pd.DataFrame({'street': ['Main Street', 'Oak Avenue', 'Pine Street'], 'FIRE_COUNT': [0, 0, 0]})

    with st.container():
        meters = st.number_input('Within:',1,2000,500)
        st.write('Meters from')
        
        # Get street data with fire counts based on distance
        street_data = f_street(chosen_county, meters)
        if not street_data.empty and 'FIRE_COUNT' in street_data.columns:
            # Get the street column name (check various possible formats)
            street_col = None
            if 'STREET' in street_data.columns:
                street_col = 'STREET'
            elif 'street' in street_data.columns:
                street_col = 'street'
            elif '"street"' in street_data.columns:
                street_col = '"street"'
            elif '"STREET"' in street_data.columns:
                street_col = '"STREET"'
            else:
                # Fallback: use the first column that's not FIRE_COUNT
                for col_name in street_data.columns:
                    if col_name != 'FIRE_COUNT':
                        street_col = col_name
                        break
            
            # Create display options showing street name and fire count
            street_options = []
            for _, row in street_data.iterrows():
                street_name = row[street_col] if street_col else 'Unknown Street'
                fire_count = int(row['FIRE_COUNT'])
                if fire_count > 0:
                    street_options.append(f"{street_name} ({fire_count} fires)")
                else:
                    street_options.append(f"{street_name} (no fires)")
            street_names = street_data[street_col].tolist() if street_col else ['Main Street']
            
            selected_option = st.selectbox('Choose Street (sorted by fire count):', street_options)
            # Extract the actual street name from the selected option
            selected_index = street_options.index(selected_option)
            chosen_streets = street_names[selected_index]
        else:
            # Fallback for simple street list
            if not street_data.empty:
                # Get the street column name dynamically
                street_col = None
                if 'STREET' in street_data.columns:
                    street_col = 'STREET'
                elif 'street' in street_data.columns:
                    street_col = 'street'
                elif '"street"' in street_data.columns:
                    street_col = '"street"'
                elif '"STREET"' in street_data.columns:
                    street_col = '"STREET"'
                else:
                    street_col = street_data.columns[0]  # Use first column
                chosen_streets = st.selectbox('Choose Street:', street_data[street_col].tolist())
            else:
                chosen_streets = st.selectbox('Choose Street:', ['Main Street'])
        street_point = data.filter(col('"street"')==chosen_streets).select('"Centroid"').limit(1)
    
        data = data.join(street_point,call_function('ST_DWITHIN',
                                                           call_function('TO_GEOGRAPHY', data['"Centroid"']),
                                                           call_function('TO_GEOGRAPHY', street_point['"Centroid"']),meters)==True,rsuffix='R').drop('"CentroidR"')

        # Year bar chart - filtered by chosen street
        try:
            # Get street point for filtering fires
            street_point_for_chart = data.filter(col('"street"')==chosen_streets).select('"Centroid"').limit(1)
            
            # Filter fires by proximity to chosen street
            try:
                fires_near_street = fires.join(street_point_for_chart, 
                                              call_function('ST_DWITHIN',
                                                          call_function('TO_GEOGRAPHY', street_point_for_chart['"Centroid"']),
                                                          call_function('TO_GEOGRAPHY', fires['GEOM']), meters))
                year_counts = fires_near_street.group_by('YEAR_').agg(count('*').alias('FIRE_COUNT')).sort('YEAR_')
            except Exception:
                # Fallback to all fires if spatial join fails
                year_counts = fires.group_by('YEAR_').agg(count('*').alias('FIRE_COUNT')).sort('YEAR_')
            
            year_data = year_counts.to_pandas()
            
            if not year_data.empty:
                st.markdown("**Number of Fires**")
                # Create a simple bar chart without axis labels
                fig = px.bar(year_data, x='YEAR_', y='FIRE_COUNT', 
                           hover_data={'YEAR_': True, 'FIRE_COUNT': True})
                fig.update_layout(
                    height=100,
                    margin=dict(l=0, r=0, t=0, b=0),
                    showlegend=False,
                    xaxis=dict(showticklabels=False, showgrid=False, zeroline=False, title=''),
                    yaxis=dict(showticklabels=False, showgrid=False, zeroline=False, title=''),
                    plot_bgcolor='rgba(0,0,0,0)',
                    paper_bgcolor='rgba(0,0,0,0)'
                )
                fig.update_traces(
                    hovertemplate='<b>Year:</b> %{x}<br><b>Fires:</b> %{y}<extra></extra>',
                    marker_color='#29B5E8'
                )
                st.plotly_chart(fig, use_container_width=True, config={'displayModeBar': False})
        except Exception as chart_error:
            st.markdown("**Number of Fires**")
            st.write("📊 Fire history chart unavailable")

        choose_year = st.slider('Choose Year:', 1878,2025,(1898,2025))
        st.write(choose_year)

        try:
            envelope = data.select('"Centroid"')
            envelope = envelope.select(call_function('ST_ENVELOPE',(call_function('ST_COLLECT',col('"Centroid"')))).alias('ENVELOPE'))
        
            filtered_fires = fires.filter(col('YEAR_').between(choose_year[0],choose_year[1]))
            
            # Try the spatial join, with fallback
            try:
                envelope_geom = envelope.collect()[0]['ENVELOPE']
                filtered_fires = filtered_fires.filter(call_function('ST_DWITHIN', 
                    call_function('TO_GEOGRAPHY', envelope_geom), 
                    call_function('TO_GEOGRAPHY', filtered_fires['GEOM']), 1500))
            except Exception as spatial_error:
                st.warning(f"Spatial filtering not available, showing all fires: {str(spatial_error)}")
                # Use all fires as fallback
                pass
                
            fire_count = filtered_fires.select('FIRE_NAME').distinct().count()
            st.metric('Number of Fires:', fire_count)
                
            # Try to join customer data with fires
            try:
                data = data.join(filtered_fires,call_function('ST_DWITHIN',
                    call_function('TO_GEOGRAPHY', data['"Centroid"']),
                    call_function('TO_GEOGRAPHY', filtered_fires['GEOM']),1000))
            except Exception as join_error:
                st.warning(f"Customer-fire spatial join failed, using all data: {str(join_error)}")
                # Keep original data without fire join
                pass
                
            # Process fire polygon data for mapping
            try:
                fire_polygon = filtered_fires.to_pandas()
                if not fire_polygon.empty and 'GEOM' in fire_polygon.columns:
                        fire_polygon["GEOM"] = fire_polygon["GEOM"].apply(lambda row: json.loads(row)["coordinates"] if row else [])
                        # Add tooltip for fire layer
                        fire_polygon["TOOLTIP"] = fire_polygon.apply(lambda row: f"""
                        <b>🔥 WILDFIRE</b><br>
                        <b>Fire Name:</b> {row.get('FIRE_NAME', 'N/A')}<br>
                        <b>Agency:</b> {row.get('AGENCY', 'N/A')}<br>
                        <b>Year:</b> {row.get('YEAR_', 'N/A')}<br>
                        <b>Acres:</b> {row.get('GIS_ACRES', 'N/A')}<br>
                        <b>Cause:</b> {row.get('CAUSE', 'N/A')}<br>
                        <b>Status:</b> Fire Perimeter
                        """.strip(), axis=1)
                else:
                        # Create empty fire polygon data
                        fire_polygon = pd.DataFrame(columns=['FIRE_NAME', 'AGENCY', 'YEAR_', 'GEOM', 'TOOLTIP'])
            except Exception as polygon_error:
                st.warning(f"Fire polygon processing failed: {str(polygon_error)}")
                fire_polygon = pd.DataFrame(columns=['FIRE_NAME', 'AGENCY', 'YEAR_', 'GEOM', 'TOOLTIP'])
                
        except Exception as e:
            st.error(f"Error in data processing: {str(e)}")
            # Create fallback data
            fire_polygon = pd.DataFrame(columns=['FIRE_NAME', 'AGENCY', 'YEAR_', 'GEOM', 'TOOLTIP'])
            filtered_fires = fires.limit(3)  # Use sample data
    
    latlon = data.agg(avg('LAT').alias('LAT'),
                  avg('LON').alias('LON')).to_pandas()

# Process data automatically using cached functions
# Calculate and display quality metrics
metrics = calculate_metrics(chosen_county, chosen_streets, meters, choose_year)
with metrics_placeholder.container():
    col1, col2, col3, col4 = st.columns(4)
    with col1:
        st.metric("🔥 Fires", metrics['fires'])
    with col2:
        st.metric("🏠 Customers", metrics['customers']) 
    with col3:
        st.metric("⚠️ At-Risk Customers", metrics['at_risk_customers'])
    with col4:
        st.metric("📡 At-Risk Towers", metrics['at_risk_towers'])

# Get cached map data
map_data = process_map_data(chosen_county, chosen_streets, meters, choose_year)
datapd = map_data['customer_data']
fire_polygon = map_data['fire_data'] 
towerpd = map_data['tower_data']
latlon = map_data['center']

# Prepare simplified data for expanders (use much smaller limits to avoid size issues)
try:
    # Use the same filtering as in cached function but with small limits
    filtered_fires = fires.filter(col('YEAR_').between(choose_year[0], choose_year[1]))
    
    # Filter fires by area like in the cached function
    county_data = customers.filter(col('GEOMETRY').is_not_null()).filter(col('COUNTY')==chosen_county)
    street_point = county_data.filter(col('"street"')==chosen_streets).select('"Centroid"').limit(1)
    if street_point.count() > 0:
        # Get customers within distance of the street
        filtered_customers = county_data.filter(
            call_function('ST_DWITHIN',
                        call_function('TO_GEOGRAPHY', county_data['"Centroid"']),
                        call_function('TO_GEOGRAPHY', street_point.select('"Centroid"').collect()[0]['Centroid']), 
                        meters)==True)
        
        # Apply envelope filtering to fires like in cached function
        if filtered_customers.count() > 0:
            envelope = filtered_customers.select('"Centroid"')
            envelope = envelope.select(call_function('ST_ENVELOPE',(call_function('ST_COLLECT',col('"Centroid"')))).alias('ENVELOPE'))
            envelope_geom = envelope.collect()[0]['ENVELOPE']
            filtered_fires = filtered_fires.filter(call_function('ST_DWITHIN', 
                                                               call_function('TO_GEOGRAPHY', envelope_geom), 
                                                               call_function('TO_GEOGRAPHY', filtered_fires['GEOM']), 1500))
    else:
        filtered_customers = county_data.limit(0)
    
    # Get data for expanders (no limits - spatial filtering provides natural bounds)
    fire_info = filtered_fires.select('FIRE_NAME', 'AGENCY', 'YEAR_')  # No limit
    cust_info = filtered_customers.select('ID','FIRST_NAME','LAST_NAME','EMAIL','GENDER','STATUS','PHONE_NUMBER','POINTS')  # No limit
    
    # Get tower info
    towers_filtered = towers.join(filtered_fires, call_function('ST_DWITHIN',
                                                                 call_function('TO_GEOGRAPHY', towers['"geo"']),
                                                                 call_function('TO_GEOGRAPHY', filtered_fires['GEOM']),4000))
    tower_info = towers_filtered.select('"CELL_ID"', '"LATITUDE"', '"LONGITUDE"', '"AT_RISK"')  # No limit
    
except Exception as data_prep_error:
    st.error(f"Error preparing data: {str(data_prep_error)}")
    fire_info = fires.select('FIRE_NAME', 'AGENCY', 'YEAR_').limit(5)
    tower_info = towers.select('"CELL_ID"', '"LATITUDE"', '"LONGITUDE"', '"AT_RISK"').limit(5)
    cust_info = customers.select('ID','FIRST_NAME','LAST_NAME','EMAIL','GENDER','STATUS','PHONE_NUMBER','POINTS').limit(5)
    
# Map visualization using cached data

# Display data tables with enhanced formatting
try:
    with st.expander('🔥 View Fire Information'):
        try:
            fire_df = fire_info.limit(50).to_pandas()
            if not fire_df.empty:
                # Format fire data
                fire_df.columns = [col.replace('_', ' ').title() for col in fire_df.columns]
                st.dataframe(
                    fire_df,
                    use_container_width=True,
                    column_config={
                        "Fire Name": st.column_config.TextColumn(
                            "🔥 Fire Name",
                            help="Name of the wildfire",
                            width="medium"
                        ),
                        "Agency": st.column_config.TextColumn(
                            "🏛️ Agency",
                            help="Responsible agency",
                            width="small"
                        ),
                        "Year": st.column_config.NumberColumn(
                            "📅 Year",
                            help="Year the fire occurred",
                            format="%d"
                        )
                    }
                )
            else:
                st.info("No fire data available for this selection")
        except Exception as fire_error:
            st.error(f"Error displaying fire data: {str(fire_error)}")
        
        with st.expander('🏠 Affected Customers'):
            try:
                cust_df = cust_info.limit(50).to_pandas()
                if not cust_df.empty:
                    # Format customer data
                    cust_df.columns = [col.replace('_', ' ').title() for col in cust_df.columns]
                    
                    # Add status styling
                    def highlight_status(val):
                        if val == 'Gold':
                            return 'background-color: #FFD700; color: black'
                        elif val == 'Silver':
                            return 'background-color: #C0C0C0; color: black'
                        elif val == 'Bronze':
                            return 'background-color: #CD7F32; color: white'
                        return ''
                    
                    st.dataframe(
                        cust_df,
                        use_container_width=True,
                        column_config={
                            "Id": st.column_config.NumberColumn(
                                "🆔 ID",
                                help="Customer ID",
                                format="%d"
                            ),
                            "First Name": st.column_config.TextColumn(
                                "👤 First Name",
                                help="Customer first name",
                                width="small"
                            ),
                            "Last Name": st.column_config.TextColumn(
                                "👤 Last Name", 
                                help="Customer last name",
                                width="small"
                            ),
                            "Email": st.column_config.TextColumn(
                                "📧 Email",
                                help="Customer email address",
                                width="medium"
                            ),
                            "Gender": st.column_config.TextColumn(
                                "⚧️ Gender",
                                help="Customer gender",
                                width="small"
                            ),
                            "Status": st.column_config.TextColumn(
                                "⭐ Status",
                                help="Customer loyalty status",
                                width="small"
                            ),
                            "Phone Number": st.column_config.TextColumn(
                                "📱 Phone",
                                help="Customer phone number",
                                width="medium"
                            ),
                            "Points": st.column_config.NumberColumn(
                                "🎯 Points",
                                help="Loyalty points",
                                format="%d"
                            )
                        }
                    )
                else:
                    st.info("No customer data available for this selection")
            except Exception as cust_error:
                st.error(f"Error displaying customer data: {str(cust_error)}")
        
        with st.expander('📡 Affected Cell Towers'):
            try:
                tower_df = towers_filtered.select('CELL_ID','LATITUDE','LONGITUDE','RANGE','AT_RISK').limit(100).to_pandas()
                if not tower_df.empty:
                    # Format tower data
                    tower_df.columns = [col.replace('_', ' ').title() for col in tower_df.columns]
                    
                    # Convert AT_RISK to readable format
                    if 'At Risk' in tower_df.columns:
                        tower_df['At Risk'] = tower_df['At Risk'].map({1: '⚠️ Yes', 0: '✅ No'})
                    
                    st.dataframe(
                        tower_df,
                        use_container_width=True,
                        column_config={
                            "Cell Id": st.column_config.TextColumn(
                                "📡 Tower ID",
                                help="Cell tower identifier",
                                width="small"
                            ),
                            "Latitude": st.column_config.NumberColumn(
                                "🌐 Latitude",
                                help="Tower latitude coordinate",
                                format="%.6f"
                            ),
                            "Longitude": st.column_config.NumberColumn(
                                "🌐 Longitude", 
                                help="Tower longitude coordinate",
                                format="%.6f"
                            ),
                            "Range": st.column_config.NumberColumn(
                                "📶 Range (m)",
                                help="Tower coverage range in meters",
                                format="%d"
                            ),
                            "At Risk": st.column_config.TextColumn(
                                "⚠️ Risk Status",
                                help="Whether tower is at risk from fires",
                                width="small"
                            )
                        }
                    )
                else:
                    st.info("No tower data available for this selection")
            except Exception as tower_error:
                st.error(f"Error displaying tower data: {str(tower_error)}")
except Exception as display_error:
    st.warning(f"Error displaying data tables: {str(display_error)}")

# Process customer data for mapping
try:
    # Check if fire join was successful by looking for FIRE_NAME column
    try:
        data_for_map = data.group_by('FIRE_NAME',
                   'FIRST_NAME',
                   'LAST_NAME',
                   'EMAIL',
                   'GENDER',
                   'STATUS',
                   'PHONE_NUMBER',
                   'POINTS').agg(any_value(col('GEOMETRY')).alias('GEOMETRY'))
    except Exception:
        # Fallback if FIRE_NAME doesn't exist (fire join failed)
        data_for_map = cust_info.group_by('FIRST_NAME',
                               'LAST_NAME',
                               'EMAIL',
                               'GENDER',
                               'STATUS',
                               'PHONE_NUMBER',
                               'POINTS').agg(any_value(col('ID')).alias('ID'))

        # Add colors to customer data
        data_for_map = data_for_map.with_column(
        'COLOR',
        when(col('STATUS') == 'Gold', [255, 159, 54])
        .when(col('STATUS') == 'Silver', [138, 153, 158])
       .when(col('STATUS') == 'Bronze', [60,0,69])
        .otherwise([255, 255, 255])
       )
        data_for_map = data_for_map.with_column('R',col('COLOR')[0])
        data_for_map = data_for_map.with_column('G',col('COLOR')[1])
        data_for_map = data_for_map.with_column('B',col('COLOR')[2])
        data_for_map = data_for_map.drop('COLOR').limit(500)
    except Exception as mapping_error:
        st.warning(f"Error processing customer mapping data: {str(mapping_error)}")
        # Create minimal fallback data
        data_for_map = customers.select('FIRST_NAME', 'LAST_NAME', 'STATUS').limit(3)

    # Convert to pandas for mapping
    try:
        datapd = data_for_map.to_pandas()
        
        if not datapd.empty and 'GEOMETRY' in datapd.columns:
            datapd["coordinates"] = datapd['GEOMETRY'].apply(lambda row: json.loads(row)["coordinates"] if row else [])
        else:
            # Create empty coordinates if no geometry data
            datapd["coordinates"] = [[0, 0] for _ in range(len(datapd))]
            
        # Add scatter point coordinates for customer centroids
        if not datapd.empty:
            # Use LAT/LON if available, otherwise calculate centroid from geometry
            if 'LAT' in datapd.columns and 'LON' in datapd.columns:
                datapd["scatter_position"] = datapd.apply(lambda row: [row.get('LON', 0), row.get('LAT', 0)], axis=1)
            else:
                # Calculate centroid from geometry coordinates
                def calc_centroid(coords):
                    if coords and coords[0] and len(coords[0]) > 0:
                        x_sum = 0
                        y_sum = 0
                        count = len(coords[0])
                        for point in coords[0]:
                            x_sum += point[0]
                            y_sum += point[1]
                        return [x_sum / count, y_sum / count]
                    return [0, 0]
                datapd["scatter_position"] = datapd["coordinates"].apply(calc_centroid)
            
        # Change building color to Snowflake blue and add tooltip for customer layer
        if not datapd.empty:
            # Set Snowflake blue color for buildings (RGB: 41, 181, 232)
            datapd["R"] = 41
            datapd["G"] = 181
            datapd["B"] = 232
            
            datapd["TOOLTIP"] = datapd.apply(lambda row: f"""
<b>🏠 CUSTOMER</b><br>
<b>Name:</b> {row.get('FIRST_NAME', 'N/A')} {row.get('LAST_NAME', 'N/A')}<br>
<b>Email:</b> {row.get('EMAIL', 'N/A')}<br>
<b>Status:</b> {row.get('STATUS', 'N/A')}<br>
<b>Points:</b> {row.get('POINTS', 'N/A')}<br>
<b>Phone:</b> {row.get('PHONE_NUMBER', 'N/A')}<br>
<b>Fire:</b> {row.get('FIRE_NAME', 'No nearby fire')}
            """.strip(), axis=1)
        
    except Exception as pandas_error:
        st.warning(f"Error converting to pandas: {str(pandas_error)}")
        datapd = pd.DataFrame(columns=['FIRST_NAME', 'LAST_NAME', 'coordinates', 'scatter_position', 'R', 'G', 'B', 'TOOLTIP'])

    tooltip = {
     "html": "{TOOLTIP}",
    "style": {
       "width":"50%",
        "backgroundColor": "#29B5E8",
        "color": "white",
       "text-wrap": "balance"
        }
        }

except Exception as mapping_error:
    st.warning(f"Error processing customer mapping data: {str(mapping_error)}")
    # Create minimal fallback data
    datapd = pd.DataFrame(columns=['FIRST_NAME', 'LAST_NAME', 'coordinates', 'scatter_position', 'R', 'G', 'B', 'TOOLTIP'])
    fire_polygon = pd.DataFrame(columns=['FIRE_NAME', 'AGENCY', 'YEAR_', 'GEOM', 'TOOLTIP'])
    latlon = pd.DataFrame({'LAT': [34.0522], 'LON': [-118.2437]})

    tooltip = {
     "html": "{TOOLTIP}",
    "style": {
       "width":"50%",
        "backgroundColor": "#29B5E8",
        "color": "white",
       "text-wrap": "balance"
        }
        }

# Layer visibility toggles
st.markdown("### 🗺️ Map Layer Controls")
col1, col2, col3 = st.columns(3)

with col1:
    show_customers = st.toggle('🏠 Customer Buildings', value=True, help='Show customer building polygons and scatter points')
with col2:
    show_fires = st.toggle('🔥 Fire Perimeters', value=True, help='Show wildfire perimeter areas')
with col3:
    show_towers = st.toggle('📡 Cell Towers', value=True, help='Show cell tower locations')

# Get map center
LAT = latlon['LAT'].iloc[0] if not latlon.empty else 34.0522
LON = latlon['LON'].iloc[0] if not latlon.empty else -118.2437

# Create layers based on toggle states
layers = []


    # Fire perimeters layer
if show_fires:
        fire_layer = pdk.Layer(
        "PolygonLayer",
        fire_polygon,
        opacity=0.3,
        get_polygon='GEOM', 
        filled=True,
        get_fill_color=[255,0,0],
        get_line_color=[0, 0, 0],
        get_line_width=0.1,
        auto_highlight=True,
        pickable=True,
        )
        layers.append(fire_layer)






# Customer layers (Snowflake blue) - scatter first, then buildings on top
if show_customers and not datapd.empty:
    # Customer scatter layer for better visibility and performance (added first - appears behind)
    customer_scatter_layer = pdk.Layer(
        'ScatterplotLayer',
        data=datapd,
        get_position='scatter_position',
        get_color=[41, 181, 232],  # Snowflake blue
        radius_scale=10,
        opacity=0.02,         # Match telco tower light opacity
        radius_min_pixels=1,  # Minimum 1 pixel when zoomed in
        radius_max_pixels=60, # Match telco tower max size
        get_radius=30,        # Match telco tower base radius
        pickable=True)
    layers.append(customer_scatter_layer)
    
    # Customer building layer (added second - appears on top)
    data_layer = pdk.Layer(
        "PolygonLayer",
        datapd,
        opacity=0.8,
        get_polygon="coordinates", 
        filled=True,
        get_fill_color=["R","G","B"],  # Now Snowflake blue (41, 181, 232)
        get_line_color=[0, 0, 0],
        get_line_width=0.1,
        auto_highlight=True,
        pickable=True,
        )
    layers.append(data_layer)



    # Cell tower layers use cached data (towerpd already processed with colors and tooltips)
    if show_towers and not towerpd.empty:
        towers_layer = pdk.Layer(
            'ScatterplotLayer',
            data=towerpd,
            get_position='[LONGITUDE, LATITUDE]',
            get_color=["R","G","B"],
            radius_scale=1,
            opacity=0.02,
            radius_min_pixels=30,
            radius_max_pixels=60,
            get_radius=30,
            pickable=True)
        layers.append(towers_layer)

        towers2_layer = pdk.Layer(
            'ScatterplotLayer',
            data=towerpd,
            get_position='[LONGITUDE, LATITUDE]',
            get_color=["R","G","B"],
            radius_scale=1,
            opacity=0.2,
            radius_min_pixels=5,
            radius_max_pixels=10,
            get_radius=10,
            pickable=True)
        layers.append(towers2_layer)

    # Create map view
    try:
        view_state = pdk.ViewState(
            longitude=latlon['LON'].iloc[0] if not latlon.empty else -118.2437,
            latitude=latlon['LAT'].iloc[0] if not latlon.empty else 34.0522,
            zoom=12,  # Adjust zoom if needed
            pitch=0,
        )

        # Render the map with selected layers and tooltip
        r = pdk.Deck(
            layers=layers,
            initial_view_state=view_state,
            map_style=None,
            tooltip=tooltip)
      
        with st.expander('Load map of selected data points', expanded=True):
            st.markdown('<h1sub>WHERE CUSTOMERS ARE - AND IF THEY ARE CLOSE TO A WILD FIRE</h1sub>',unsafe_allow_html=True)
            st.pydeck_chart(r, use_container_width=True, height=700)
    except Exception as map_error:
        st.error(f"Error creating map: {str(map_error)}")
        st.info("Map visualization is not available due to data processing issues.")

# AI Analysis Section
st.markdown("---")
st.markdown('<h0black>🤖 AI-POWERED INSIGHTS & </h0black><h0blue>RISK ANALYSIS</h0blue>', unsafe_allow_html=True)

if st.button("🚀 Generate Intelligent Analysis", type="primary", help="Run AI analysis on the selected data", use_container_width=True):
    st.markdown('<h1blue>🎯 AI GENERATED INSIGHTS</h1blue>', unsafe_allow_html=True)
    
    try:
        # Prepare data for AI analysis
        tower_obj = tower_info.filter(col('AT_RISK')==1).select(array_agg(object_construct('*')).alias('Cell Tower Info'))
        fire_obj = fire_info.limit(200).select(array_agg(object_construct('*')).alias('Wild Fire Info'))
        cust_obj = cust_info.limit(200).select(array_agg(object_construct('*')).alias('Telco Customer Info'))
        
        all_data = tower_obj.join(cust_obj).join(fire_obj).select(object_construct('*').alias('ALL'))
        prompt = '''We are a telco company and have customers that live near cell towers and 
                    also might be affected by wild fires. Please provide a detailed analysis with:
                    1. Executive Summary with key risk indicators
                    2. Customer Risk Assessment broken down by threat level
                    3. Infrastructure Impact Analysis for cell towers
                    4. Wildfire Threat Analysis with specific fire data
                    5. Strategic Recommendations for risk mitigation
                    
                    Format your response with clear headers, bullet points, and actionable insights. '''
        
        with st.spinner("🧠 Analyzing data with AI... This may take a moment"):
            try:
                complete = all_data.select(call_function('AI_COMPLETE','claude-3-5-sonnet',concat(lit(prompt),col('ALL').astype(StringType()))))
                result = complete.collect()
                
                if result and len(result) > 0:
                    # Remove surrounding quotes from AI response to enable markdown rendering
                    ai_response = str(result[0][0])
                    if ai_response.startswith('"') and ai_response.endswith('"'):
                        ai_response = ai_response[1:-1]
                    elif ai_response.startswith("'") and ai_response.endswith("'"):
                        ai_response = ai_response[1:-1]
                    
                    # Convert escaped newlines to actual line breaks for proper markdown rendering
                    ai_response = ai_response.replace('\\n', '\n')
                    
                    # Enhanced formatting for better visual appeal
                    formatted_response = format_ai_analysis(ai_response)
                    
                    # Display with enhanced formatting
                    st.markdown(formatted_response, unsafe_allow_html=True)
                    
                    # Add download option
                    st.download_button(
                        label="📥 Download Analysis Report",
                        data=ai_response,
                        file_name=f"wildfire_risk_analysis_{pd.Timestamp.now().strftime('%Y%m%d_%H%M')}.txt",
                        mime="text/plain",
                        help="Download the complete AI analysis as a text file"
                    )
                else:
                    st.info("⚠️ No analysis results available. Please ensure data is loaded and try again.")
                        
            except Exception as ai_error:
                st.error(f"❌ AI analysis failed: {str(ai_error)}")
                
    except Exception as ai_prep_error:
        st.error(f"❌ Error preparing AI analysis data: {str(ai_prep_error)}")

